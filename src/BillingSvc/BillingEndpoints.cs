using System.Globalization;
using System.Security.Claims;
using Hbys.BuildingBlocks.Audit;
using Hbys.BuildingBlocks.Database;
using Hbys.BuildingBlocks.Domain;
using Hbys.BuildingBlocks.Messaging;
using Npgsql;

public static class BillingEndpoints
{
    public static void Map(WebApplication app)
    {
        var api = app.MapGroup("/api").RequireAuthorization();

        api.MapGet("/invoices", async (NpgsqlDataSource db, CancellationToken ct) =>
        {
            var rows = await Db.QueryCamelAsync(db, """
                SELECT i.id,i.encounter_id,i.invoice_no,i.payer,i.status,i.total,i.total AS total_amount,
                       i.created_at,i.paid_at,p.mrn,p.given_name,p.family_name,
                       (p.given_name || ' ' || p.family_name) AS patient_name
                FROM billing.invoices i
                JOIN patient.encounters e ON e.id=i.encounter_id
                JOIN patient.patients p ON p.id=e.patient_id
                ORDER BY i.id DESC LIMIT 100
                """, ct);

            if (rows.Count > 0)
            {
                var lineRows = await Db.QueryCamelAsync(db, """
                    SELECT l.id,l.invoice_id,l.code,l.description,l.quantity,l.quantity AS qty,l.unit_price,l.line_total
                    FROM billing.invoice_lines l
                    JOIN (SELECT id FROM billing.invoices ORDER BY id DESC LIMIT 100) inv ON inv.id=l.invoice_id
                    ORDER BY l.id ASC
                    """, ct);
                var linesByInvoice = lineRows
                    .GroupBy(x => Convert.ToInt64(x["invoiceId"], CultureInfo.InvariantCulture))
                    .ToDictionary(g => g.Key, g => g.ToList());

                foreach (var inv in rows)
                {
                    var invId = Convert.ToInt64(inv["id"], CultureInfo.InvariantCulture);
                    var lines = linesByInvoice.TryGetValue(invId, out var list) ? list : new List<Dictionary<string, object?>>();
                    inv["lines"] = lines;
                    inv["lineCount"] = lines.Count;
                }
            }

            return Results.Ok(rows);
        }).RequireAuthorization(p => p.RequireRole("admin", "billing", "registrar"));

        api.MapGet("/encounters/{id:long}/charge-preview", async (long id, NpgsqlDataSource db, CancellationToken ct) =>
        {
            if (id <= 0) throw new ArgumentException("Geçersiz başvuru numarası.");
            var encounterCount = await Db.ScalarLongAsync(db, "SELECT count(*) FROM patient.encounters WHERE id=@p0", ct, id);
            if (encounterCount == 0) throw new KeyNotFoundException("Başvuru bulunamadı.");

            var lines = new List<object>();
            decimal total = 0m;

            void AddLine(string code, string description, decimal qty, decimal unitPrice)
            {
                var q = decimal.Round(qty, 2, MidpointRounding.AwayFromZero);
                var p = decimal.Round(unitPrice, 2, MidpointRounding.AwayFromZero);
                var lineTotal = MoneyRules.LineTotal(q, p);
                total = decimal.Round(total + lineTotal, 2, MidpointRounding.AwayFromZero);
                lines.Add(new { code, description, qty = q, unitPrice = p, lineTotal });
            }

            AddLine("520.030", "Poliklinik / Acil Muayene Hizmeti", 1m, 350.00m);

            var orders = await Db.QueryAsync(db, """
                SELECT code,order_type,description
                FROM clinical.orders
                WHERE encounter_id=@p0 AND status <> 'Cancelled'
                ORDER BY id
                """, ct, id);
            foreach (var ord in orders)
            {
                var orderType = Convert.ToString(ord["order_type"], CultureInfo.InvariantCulture) ?? "";
                var unitPrice = orderType switch
                {
                    "LAB" => 125.00m,
                    "RAD" => 420.00m,
                    "PROCEDURE" => 310.00m,
                    "CONSULT" => 280.00m,
                    _ => 150.00m
                };
                AddLine(
                    Convert.ToString(ord["code"], CultureInfo.InvariantCulture) ?? "SUT-ORD",
                    Convert.ToString(ord["description"], CultureInfo.InvariantCulture) ?? "Klinik İstem Hizmeti",
                    1m,
                    unitPrice);
            }

            var rxItems = await Db.QueryAsync(db, """
                SELECT d.code,d.name,pi.quantity,d.unit_price
                FROM pharmacy.prescriptions rx
                JOIN pharmacy.prescription_items pi ON pi.prescription_id=rx.id
                JOIN pharmacy.drugs d ON d.id=pi.drug_id
                WHERE rx.encounter_id=@p0 AND rx.status <> 'Cancelled'
                ORDER BY pi.id
                """, ct, id);
            foreach (var item in rxItems)
            {
                var unitPrice = Convert.ToDecimal(item["unit_price"] ?? 0m, CultureInfo.InvariantCulture);
                if (unitPrice <= 0m) continue;
                var qty = Convert.ToDecimal(item["quantity"] ?? 1, CultureInfo.InvariantCulture);
                AddLine(
                    Convert.ToString(item["code"], CultureInfo.InvariantCulture) ?? "DRG",
                    Convert.ToString(item["name"], CultureInfo.InvariantCulture) ?? "İlaç",
                    qty,
                    unitPrice);
            }

            var admissions = await Db.QueryAsync(db, """
                SELECT admitted_at,discharged_at
                FROM adt.admissions
                WHERE encounter_id=@p0
                ORDER BY id
                """, ct, id);
            foreach (var adm in admissions)
            {
                var admittedAt = Convert.ToDateTime(adm["admitted_at"], CultureInfo.InvariantCulture);
                var endAt = adm["discharged_at"] is null
                    ? DateTime.UtcNow
                    : Convert.ToDateTime(adm["discharged_at"], CultureInfo.InvariantCulture);
                var days = Math.Max(1, (int)Math.Ceiling((endAt - admittedAt).TotalDays));
                AddLine("510.010", "Yataklı Servis Günlük Bakım Bedeli", days, 950.00m);
            }

            return Results.Ok(new
            {
                encounterId = id,
                lines,
                totalAmount = total,
                currency = "TRY"
            });
        }).RequireAuthorization(p => p.RequireRole("admin", "billing", "registrar"));

        api.MapPost("/invoices", async (InvoiceCreateRequest request, NpgsqlDataSource db, ClaimsPrincipal user, CancellationToken ct) =>
        {
            if (request.EncounterId <= 0) throw new ArgumentException("Başvuru zorunludur.");
            var payer = string.IsNullOrWhiteSpace(request.Payer) ? "SGK" : Required(request.Payer, "Ödeyen", 40);

            var lineInputs = new List<InvoiceLineInput>();
            if (request.Lines is { Count: > 0 })
            {
                if (request.Lines.Count > 50) throw new ArgumentException("En fazla 50 fatura kalemi girilebilir.");
                foreach (var item in request.Lines)
                {
                    var code = Required(string.IsNullOrWhiteSpace(item.Code) ? item.SutCode : item.Code, "Hizmet kodu", 40);
                    var description = Required(item.Description, "Açıklama", 200);
                    var qty = item.Qty ?? item.Quantity ?? 0m;
                    var unitPrice = item.UnitPrice ?? 0m;
                    lineInputs.Add(new InvoiceLineInput(code, description, qty, unitPrice));
                }
            }
            else if (request.Amount.HasValue)
            {
                lineInputs.Add(new InvoiceLineInput("520.030", "Poliklinik Hizmet Bedeli", 1m, request.Amount.Value));
            }
            else
            {
                var code = Required(request.Code, "Hizmet kodu", 40);
                var description = Required(request.Description, "Açıklama", 200);
                var qty = request.Quantity ?? 0m;
                var unitPrice = request.UnitPrice ?? 0m;
                lineInputs.Add(new InvoiceLineInput(code, description, qty, unitPrice));
            }

            var calc = MoneyRules.CalculateInvoiceLines(lineInputs);
            var invoiceNo = $"HB-{DateTime.UtcNow:yyyyMMdd}-{Guid.NewGuid().ToString("N")[..6].ToUpperInvariant()}";

            await using var connection = await db.OpenConnectionAsync(ct);
            await using var tx = await connection.BeginTransactionAsync(ct);
            var encounter = await Db.ScalarLongAsync(connection, tx, "SELECT count(*) FROM patient.encounters WHERE id=@p0", ct, request.EncounterId);
            if (encounter == 0) throw new KeyNotFoundException("Başvuru bulunamadı.");

            var id = await Db.ScalarLongAsync(connection, tx, """
                INSERT INTO billing.invoices(encounter_id,invoice_no,payer,status,total,created_at)
                VALUES(@p0,@p1,@p2,'Issued',@p3,now()) RETURNING id
                """, ct, request.EncounterId, invoiceNo, payer, calc.TotalAmount);

            var responseLines = new List<object>(lineInputs.Count);
            for (var i = 0; i < lineInputs.Count; i++)
            {
                var line = lineInputs[i];
                var lineTotal = calc.LineTotals[i];
                await Db.ExecuteAsync(connection, tx, """
                    INSERT INTO billing.invoice_lines(invoice_id,code,description,quantity,unit_price,line_total)
                    VALUES(@p0,@p1,@p2,@p3,@p4,@p5)
                    """, ct, id, line.Code, line.Description, line.Quantity, line.UnitPrice, lineTotal);
                responseLines.Add(new
                {
                    code = line.Code,
                    description = line.Description,
                    qty = line.Quantity,
                    unitPrice = line.UnitPrice,
                    lineTotal
                });
            }

            await AuditWriter.AppendAsync(connection, tx, user, "INVOICE_ISSUED", "invoice", id.ToString(CultureInfo.InvariantCulture),
                new { invoice_no = invoiceNo, line_count = lineInputs.Count, total = calc.TotalAmount, payer }, ct);
            await OutboxWriter.EnqueueAsync(connection, tx, "MEDULA", "InvoiceIssued", "invoice", id.ToString(CultureInfo.InvariantCulture),
                new { invoice_id = id, invoice_no = invoiceNo, total = calc.TotalAmount, payer }, ct);
            await tx.CommitAsync(ct);

            return Results.Created($"/api/invoices/{id}", new
            {
                id,
                encounterId = request.EncounterId,
                invoiceNo,
                payer,
                status = "Issued",
                total = calc.TotalAmount,
                totalAmount = calc.TotalAmount,
                currency = "TRY",
                lines = responseLines
            });
        }).RequireAuthorization(p => p.RequireRole("admin", "billing"));

        api.MapPost("/invoices/{id:long}/pay", async (long id, NpgsqlDataSource db, ClaimsPrincipal user, CancellationToken ct) =>
        {
            if (id <= 0) throw new ArgumentException("Geçersiz fatura numarası.");
            await using var connection = await db.OpenConnectionAsync(ct);
            await using var tx = await connection.BeginTransactionAsync(ct);
            var rows = await Db.QueryAsync(connection, tx, "SELECT status,total FROM billing.invoices WHERE id=@p0 FOR UPDATE", ct, id);
            if (rows.Count == 0) throw new KeyNotFoundException("Fatura bulunamadı.");
            if (!string.Equals(Convert.ToString(rows[0]["status"], CultureInfo.InvariantCulture), "Issued", StringComparison.Ordinal))
                throw new InvalidOperationException("Yalnızca düzenlenmiş fatura tahsil edilebilir.");
            var total = rows[0]["total"];

            await Db.ExecuteAsync(connection, tx, "UPDATE billing.invoices SET status='Paid',paid_at=now() WHERE id=@p0", ct, id);
            await AuditWriter.AppendAsync(connection, tx, user, "INVOICE_PAID", "invoice", id.ToString(CultureInfo.InvariantCulture), new { total }, ct);
            await OutboxWriter.EnqueueAsync(connection, tx, "INTERNAL", "InvoicePaid", "invoice", id.ToString(CultureInfo.InvariantCulture),
                new { invoice_id = id, total }, ct);
            await tx.CommitAsync(ct);
            return Results.Ok(new { ok = true, id, status = "Paid" });
        }).RequireAuthorization(p => p.RequireRole("admin", "billing"));
    }

    private static string Required(string? value, string name, int max)
    {
        var text = value?.Trim() ?? "";
        if (text.Length == 0 || text.Length > max) throw new ArgumentException($"{name} zorunludur (en fazla {max} karakter).");
        return text;
    }
}

public sealed record InvoiceLineRequest(string? Code = null, string? SutCode = null, string? Description = null, decimal? Qty = null, decimal? Quantity = null, decimal? UnitPrice = null);

public sealed record InvoiceCreateRequest(
    long EncounterId,
    string? Payer = null,
    string? Code = null,
    string? Description = null,
    decimal? Quantity = null,
    decimal? UnitPrice = null,
    decimal? Amount = null,
    List<InvoiceLineRequest>? Lines = null);
