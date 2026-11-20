using System.Globalization;
using System.Security.Claims;
using Hbys.BuildingBlocks.Audit;
using Hbys.BuildingBlocks.Database;
using Hbys.BuildingBlocks.Domain;
using Hbys.BuildingBlocks.Messaging;
using Hbys.BuildingBlocks.Security;
using Npgsql;

public static class PharmacyEndpoints
{
    public static void Map(WebApplication app)
    {
        var api = app.MapGroup("/api").RequireAuthorization();

        api.MapGet("/drugs", async (NpgsqlDataSource db, CancellationToken ct) =>
        {
            var rows = await Db.QueryCamelAsync(db, """
                SELECT id,code,name,generic_name,allergy_group,form,stock,min_stock,unit_price,barcode,uts_code,active
                FROM pharmacy.drugs WHERE active ORDER BY name
                """, ct);
            return Results.Ok(rows);
        }).RequireAuthorization(p => p.RequireRole("admin", "doctor", "nurse", "pharmacist"));

        api.MapGet("/drugs/{id:long}/movements", async (long id, NpgsqlDataSource db, CancellationToken ct) =>
        {
            if (id <= 0) throw new ArgumentException("Geçersiz ilaç numarası.");
            var exists = await Db.ScalarLongAsync(db, "SELECT count(*) FROM pharmacy.drugs WHERE id=@p0", ct, id);
            if (exists == 0) throw new KeyNotFoundException("İlaç bulunamadı.");

            var rows = await Db.QueryCamelAsync(db, """
                SELECT id,drug_id,prescription_id,movement_type,quantity AS qty_delta,reference AS reference_no,actor,created_at
                FROM pharmacy.stock_movements
                WHERE drug_id=@p0
                ORDER BY id DESC LIMIT 100
                """, ct, id);
            return Results.Ok(rows);
        }).RequireAuthorization(p => p.RequireRole("admin", "doctor", "nurse", "pharmacist"));

        api.MapPost("/drugs/{id:long}/stock-receipts", async (long id, StockReceiptRequest request, HttpContext httpContext, NpgsqlDataSource db, ClaimsPrincipal user, CancellationToken ct) =>
            await ProcessStockReceiptAsync(id, request.Quantity, request.Reference, httpContext.Request.Headers["Idempotency-Key"].FirstOrDefault(), db, user, ct))
            .RequireAuthorization(p => p.RequireRole("admin", "pharmacist"));

        api.MapPost("/drugs/stock-receipt", async (StockReceiptBodyRequest request, HttpContext httpContext, NpgsqlDataSource db, ClaimsPrincipal user, CancellationToken ct) =>
            await ProcessStockReceiptAsync(request.DrugId, request.Quantity, request.Reference, httpContext.Request.Headers["Idempotency-Key"].FirstOrDefault(), db, user, ct))
            .RequireAuthorization(p => p.RequireRole("admin", "pharmacist"));

        api.MapGet("/prescriptions", async (NpgsqlDataSource db, CancellationToken ct) =>
        {
            var rows = await Db.QueryCamelAsync(db, """
                SELECT rx.id,rx.encounter_id,rx.prescribed_by,rx.status,rx.allergy_overridden,rx.override_reason,
                       rx.created_at,rx.dispensed_at,
                       p.mrn,p.given_name,p.family_name,(p.given_name || ' ' || p.family_name) AS patient_name,p.allergies,
                       (SELECT count(*) FROM pharmacy.prescription_items i WHERE i.prescription_id=rx.id) AS item_count
                FROM pharmacy.prescriptions rx
                JOIN patient.encounters e ON e.id=rx.encounter_id
                JOIN patient.patients p ON p.id=e.patient_id
                ORDER BY rx.id DESC LIMIT 100
                """, ct);
            return Results.Ok(rows);
        }).RequireAuthorization(p => p.RequireRole("admin", "doctor", "nurse", "pharmacist"));

        api.MapPost("/prescriptions", async (PrescriptionCreateRequest request, NpgsqlDataSource db, ClaimsPrincipal user, CancellationToken ct) =>
        {
            if (request.EncounterId <= 0) throw new ArgumentException("Başvuru zorunludur.");
            if (request.Items is null || request.Items.Count == 0 || request.Items.Count > 30)
                throw new ArgumentException("1-30 arası ilaç kalemi gereklidir.");

            var normalizedItems = new List<(long DrugId, string Dosage, string Frequency, int DurationDays, int Quantity, string? Usage)>(request.Items.Count);
            foreach (var item in request.Items)
            {
                var qty = item.Quantity ?? 1;
                if (item.DrugId <= 0 || qty is <= 0 or > 100000 || item.DurationDays is <= 0 or > 365)
                    throw new ArgumentException("İlaç, miktar (1-100000) ve süre (1-365 gün) geçerli olmalıdır.");
                var dosage = Required(item.Dosage, "Doz", 80);
                var frequency = Required(item.Frequency, "Kullanım sıklığı", 80);
                var usage = string.IsNullOrWhiteSpace(item.Usage) ? null : item.Usage.Trim();
                if (usage is { Length: > 500 })
                    throw new ArgumentException("Kullanım talimatı en fazla 500 karakter olabilir.");
                normalizedItems.Add((item.DrugId, dosage, frequency, item.DurationDays, qty, usage));
            }

            await using var connection = await db.OpenConnectionAsync(ct);
            await using var tx = await connection.BeginTransactionAsync(ct);

            var encounterRows = await Db.QueryAsync(connection, tx, """
                SELECT e.id,e.patient_id,p.allergies
                FROM patient.encounters e
                JOIN patient.patients p ON p.id=e.patient_id
                WHERE e.id=@p0 AND e.status IN ('Open','Admitted')
                """, ct, request.EncounterId);
            if (encounterRows.Count == 0) throw new KeyNotFoundException("Aktif başvuru bulunamadı.");

            var resolvedPatientId = Convert.ToInt64(encounterRows[0]["patient_id"], CultureInfo.InvariantCulture);
            if (request.PatientId is > 0 && request.PatientId.Value != resolvedPatientId)
                throw new ArgumentException("Belirtilen hasta başvuruyla eşleşmiyor.");
            var patientAllergies = Convert.ToString(encounterRows[0]["allergies"], CultureInfo.InvariantCulture);

            var drugs = new List<DrugAllergyCandidate>();
            foreach (var drugId in normalizedItems.Select(x => x.DrugId).Distinct())
            {
                var drugRows = await Db.QueryAsync(connection, tx, """
                    SELECT id,name,generic_name,allergy_group
                    FROM pharmacy.drugs WHERE id=@p0 AND active
                    """, ct, drugId);
                if (drugRows.Count == 0) throw new KeyNotFoundException($"İlaç bulunamadı: {drugId}.");
                drugs.Add(new DrugAllergyCandidate(
                    Convert.ToInt64(drugRows[0]["id"], CultureInfo.InvariantCulture),
                    Convert.ToString(drugRows[0]["name"], CultureInfo.InvariantCulture) ?? "",
                    Convert.ToString(drugRows[0]["generic_name"], CultureInfo.InvariantCulture),
                    Convert.ToString(drugRows[0]["allergy_group"], CultureInfo.InvariantCulture)));
            }

            var conflict = AllergyMatcher.FindConflict(patientAllergies, drugs);
            var cleanOverrideReason = string.IsNullOrWhiteSpace(request.OverrideReason) ? null : request.OverrideReason.Trim();
            var allergyOverridden = false;
            if (conflict is not null)
            {
                if (!request.OverrideAllergy || cleanOverrideReason is null || cleanOverrideReason.Length < 5)
                {
                    await tx.RollbackAsync(ct);
                    return Results.Conflict(new
                    {
                        error = "Alerji çakışması tespit edildi",
                        code = "ALLERGY_CONFLICT",
                        allergy = conflict.MatchedAllergy,
                        drugName = conflict.DrugName,
                        requiresOverrideReason = true
                    });
                }
                if (cleanOverrideReason.Length > 500)
                    throw new ArgumentException("Alerji geçersiz kılma gerekçesi en fazla 500 karakter olabilir.");
                allergyOverridden = true;
            }

            var displayName = RoleClaims.DisplayName(user);
            var id = await Db.ScalarLongAsync(connection, tx, """
                INSERT INTO pharmacy.prescriptions(encounter_id,prescribed_by,status,allergy_overridden,override_reason,created_at)
                VALUES(@p0,@p1,'Pending',@p2,@p3,now()) RETURNING id
                """, ct, request.EncounterId, displayName, allergyOverridden, Db.TextOrDbNull(cleanOverrideReason));

            foreach (var item in normalizedItems)
            {
                await Db.ExecuteAsync(connection, tx, """
                    INSERT INTO pharmacy.prescription_items(prescription_id,drug_id,dosage,frequency,duration_days,quantity,dispensed_qty,usage_instruction)
                    VALUES(@p0,@p1,@p2,@p3,@p4,@p5,0,@p6)
                    """, ct, id, item.DrugId, item.Dosage, item.Frequency, item.DurationDays, item.Quantity, Db.TextOrDbNull(item.Usage));
            }

            await AuditWriter.AppendAsync(connection, tx, user, "PRESCRIPTION_CREATED", "prescription", id.ToString(CultureInfo.InvariantCulture),
                new { encounter_id = request.EncounterId, item_count = normalizedItems.Count, allergy_overridden = allergyOverridden }, ct);

            if (allergyOverridden && conflict is not null)
            {
                await AuditWriter.AppendAsync(connection, tx, user, "ALLERGY_OVERRIDE", "prescription", id.ToString(CultureInfo.InvariantCulture),
                    new { encounter_id = request.EncounterId, drug_id = conflict.DrugId, drug_name = conflict.DrugName, allergy = conflict.MatchedAllergy, reason = cleanOverrideReason }, ct);
            }

            await OutboxWriter.EnqueueAsync(connection, tx, "INTERNAL", "PrescriptionCreated", "prescription", id.ToString(CultureInfo.InvariantCulture),
                new { prescription_id = id, encounter_id = request.EncounterId, allergy_overridden = allergyOverridden }, ct);
            await tx.CommitAsync(ct);

            return Results.Created($"/api/prescriptions/{id}", new
            {
                id,
                encounterId = request.EncounterId,
                status = "Pending",
                allergyOverridden
            });
        }).RequireAuthorization(p => p.RequireRole("admin", "doctor"));

        api.MapPost("/prescriptions/{id:long}/dispense", async (long id, NpgsqlDataSource db, ClaimsPrincipal user, CancellationToken ct) =>
        {
            if (id <= 0) throw new ArgumentException("Geçersiz reçete numarası.");
            await using var connection = await db.OpenConnectionAsync(ct);
            await using var tx = await connection.BeginTransactionAsync(ct);

            var prescription = await Db.QueryAsync(connection, tx, "SELECT id,status FROM pharmacy.prescriptions WHERE id=@p0 FOR UPDATE", ct, id);
            if (prescription.Count == 0) throw new KeyNotFoundException("Reçete bulunamadı.");
            if (!string.Equals(Convert.ToString(prescription[0]["status"], CultureInfo.InvariantCulture), "Pending", StringComparison.Ordinal))
                throw new InvalidOperationException("Yalnızca bekleyen reçete karşılanabilir.");

            var items = await Db.QueryAsync(connection, tx, """
                SELECT id,drug_id,quantity FROM pharmacy.prescription_items
                WHERE prescription_id=@p0 ORDER BY drug_id,id FOR UPDATE
                """, ct, id);
            if (items.Count == 0) throw new InvalidOperationException("Reçetede ilaç kalemi bulunmuyor.");

            // Lock and verify total stock across all prescription lines before any stock mutation.
            var requiredByDrug = new SortedDictionary<long, int>();
            foreach (var item in items)
            {
                var drugId = Convert.ToInt64(item["drug_id"], CultureInfo.InvariantCulture);
                var qty = Convert.ToInt32(item["quantity"], CultureInfo.InvariantCulture);
                requiredByDrug[drugId] = requiredByDrug.TryGetValue(drugId, out var acc) ? acc + qty : qty;
            }

            foreach (var (drugId, totalNeeded) in requiredByDrug)
            {
                var drugRows = await Db.QueryAsync(connection, tx,
                    "SELECT id,name,stock,active FROM pharmacy.drugs WHERE id=@p0 FOR UPDATE", ct, drugId);
                if (drugRows.Count == 0 || !Convert.ToBoolean(drugRows[0]["active"] ?? false, CultureInfo.InvariantCulture))
                    throw new KeyNotFoundException($"İlaç bulunamadı: {drugId}.");
                var stock = Convert.ToInt32(drugRows[0]["stock"], CultureInfo.InvariantCulture);
                var drugName = Convert.ToString(drugRows[0]["name"], CultureInfo.InvariantCulture) ?? drugId.ToString(CultureInfo.InvariantCulture);
                if (stock < totalNeeded)
                    throw new InvalidOperationException($"Yetersiz stok: {drugName} (gerekli: {totalNeeded}, mevcut: {stock}).");
            }

            var actorUsername = RoleClaims.Username(user);
            foreach (var item in items)
            {
                var itemId = Convert.ToInt64(item["id"], CultureInfo.InvariantCulture);
                var drugId = Convert.ToInt64(item["drug_id"], CultureInfo.InvariantCulture);
                var quantity = Convert.ToInt32(item["quantity"], CultureInfo.InvariantCulture);

                await Db.ExecuteAsync(connection, tx, "UPDATE pharmacy.drugs SET stock=stock-@p0 WHERE id=@p1", ct, quantity, drugId);
                await Db.ExecuteAsync(connection, tx, "UPDATE pharmacy.prescription_items SET dispensed_qty=quantity WHERE id=@p0", ct, itemId);
                await Db.ExecuteAsync(connection, tx, """
                    INSERT INTO pharmacy.stock_movements(drug_id,prescription_id,movement_type,quantity,reference,actor,created_at)
                    VALUES(@p0,@p1,'Dispense',@p2,@p3,@p4,now())
                    """, ct, drugId, id, -quantity, $"RX-{id}", actorUsername);
            }

            await Db.ExecuteAsync(connection, tx, "UPDATE pharmacy.prescriptions SET status='Dispensed',dispensed_at=now() WHERE id=@p0", ct, id);
            await AuditWriter.AppendAsync(connection, tx, user, "PRESCRIPTION_DISPENSED", "prescription", id.ToString(CultureInfo.InvariantCulture),
                new { item_count = items.Count }, ct);
            await OutboxWriter.EnqueueAsync(connection, tx, "INTERNAL", "PrescriptionDispensed", "prescription", id.ToString(CultureInfo.InvariantCulture),
                new { prescription_id = id, item_count = items.Count }, ct);
            await tx.CommitAsync(ct);

            return Results.Ok(new { ok = true, id, status = "Dispensed" });
        }).RequireAuthorization(p => p.RequireRole("admin", "pharmacist"));
    }

    private static async Task<IResult> ProcessStockReceiptAsync(
        long drugId,
        int quantity,
        string? rawReference,
        string? idempotencyKey,
        NpgsqlDataSource db,
        ClaimsPrincipal user,
        CancellationToken ct)
    {
        if (drugId <= 0) throw new ArgumentException("Geçersiz ilaç numarası.");
        if (quantity is <= 0 or > 100000) throw new ArgumentException("Teslim alınan miktar 1-100000 arasında olmalıdır.");
        var reference = Required(string.IsNullOrWhiteSpace(rawReference) ? idempotencyKey : rawReference, "İrsaliye / teslim referansı", 80);

        await using var connection = await db.OpenConnectionAsync(ct);
        await using var tx = await connection.BeginTransactionAsync(ct);
        var drug = await Db.QueryAsync(connection, tx, "SELECT stock FROM pharmacy.drugs WHERE id=@p0 AND active FOR UPDATE", ct, drugId);
        if (drug.Count == 0) throw new KeyNotFoundException("Aktif ilaç bulunamadı.");
        var currentStock = Convert.ToInt32(drug[0]["stock"], CultureInfo.InvariantCulture);

        var previousReceipt = await Db.QueryAsync(connection, tx, """
            SELECT quantity FROM pharmacy.stock_movements
            WHERE drug_id=@p0 AND upper(movement_type)='RECEIPT' AND lower(reference)=lower(@p1)
            LIMIT 1
            """, ct, drugId, reference);
        if (previousReceipt.Count > 0)
        {
            var previousQuantity = Convert.ToInt32(previousReceipt[0]["quantity"], CultureInfo.InvariantCulture);
            if (previousQuantity != quantity)
                throw new InvalidOperationException("Bu irsaliye aynı ilaç için daha önce farklı miktarla kaydedilmiş.");
            await tx.CommitAsync(ct);
            return Results.Ok(new
            {
                drugId,
                receivedQuantity = previousQuantity,
                stock = currentStock,
                duplicate = true,
                deduplicated = true
            });
        }

        if (currentStock > int.MaxValue - quantity) throw new ArgumentException("Stok miktarı sistem üst sınırını aşar.");
        var nextStock = currentStock + quantity;
        await Db.ExecuteAsync(connection, tx, "UPDATE pharmacy.drugs SET stock=@p0 WHERE id=@p1", ct, nextStock, drugId);
        var actor = RoleClaims.Username(user);
        await Db.ExecuteAsync(connection, tx, """
            INSERT INTO pharmacy.stock_movements(drug_id,movement_type,quantity,reference,actor,created_at)
            VALUES(@p0,'Receipt',@p1,@p2,@p3,now())
            """, ct, drugId, quantity, reference, actor);
        await AuditWriter.AppendAsync(connection, tx, user, "DRUG_STOCK_RECEIVED", "drug", drugId.ToString(CultureInfo.InvariantCulture),
            new { quantity, reference, stock_after = nextStock }, ct);
        await OutboxWriter.EnqueueAsync(connection, tx, "INTERNAL", "DrugStockReceived", "drug", drugId.ToString(CultureInfo.InvariantCulture),
            new { drug_id = drugId, quantity, stock_after = nextStock }, ct,
            $"DrugStockReceived:drug:{drugId}:reference:{reference.ToLowerInvariant()}");
        await tx.CommitAsync(ct);

        return Results.Ok(new
        {
            drugId,
            receivedQuantity = quantity,
            stock = nextStock,
            duplicate = false,
            deduplicated = false
        });
    }

    private static string Required(string? value, string name, int max)
    {
        var text = value?.Trim() ?? "";
        if (text.Length == 0 || text.Length > max) throw new ArgumentException($"{name} zorunludur (en fazla {max} karakter).");
        return text;
    }
}

public sealed record StockReceiptRequest(int Quantity, string? Reference = null);
public sealed record StockReceiptBodyRequest(long DrugId, int Quantity, string? Reference = null);
public sealed record PrescriptionCreateRequest(
    long EncounterId,
    List<PrescriptionItemRequest> Items,
    long? PatientId = null,
    bool OverrideAllergy = false,
    string? OverrideReason = null);
public sealed record PrescriptionItemRequest(
    long DrugId,
    string Dosage,
    string Frequency,
    int DurationDays,
    int? Quantity = null,
    string? Usage = null);
