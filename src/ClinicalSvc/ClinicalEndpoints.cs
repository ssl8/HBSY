using System.Globalization;
using System.Security.Claims;
using Hbys.BuildingBlocks.Audit;
using Hbys.BuildingBlocks.Database;
using Hbys.BuildingBlocks.Domain;
using Hbys.BuildingBlocks.Messaging;
using Hbys.BuildingBlocks.Security;
using Npgsql;

public static class ClinicalEndpoints
{
    public static void Map(WebApplication app)
    {
        var api = app.MapGroup("/api").RequireAuthorization();

        api.MapGet("/orders", async (NpgsqlDataSource db, ClaimsPrincipal user, long? encounterId, long? encounter_id, CancellationToken ct) =>
        {
            var filterEncounterId = encounterId ?? encounter_id;
            var rows = await Db.QueryCamelAsync(db, """
                SELECT o.id,o.encounter_id,o.order_type,o.code_system,o.code,o.description,o.ordered_by,
                       o.status,o.priority,o.clinical_note,o.created_at,o.updated_at,
                       p.given_name,p.family_name,(p.given_name || ' ' || p.family_name) AS patient_name,p.mrn
                FROM clinical.orders o
                JOIN patient.encounters e ON e.id=o.encounter_id
                JOIN patient.patients p ON p.id=e.patient_id
                WHERE (@p0::bigint IS NULL OR o.encounter_id=@p0)
                  AND (@p1='admin' OR @p1='doctor' OR (@p1='lab' AND o.order_type='LAB') OR (@p1='radiology' AND o.order_type='RAD'))
                ORDER BY o.id DESC LIMIT 200
                """, ct, Db.BigintOrDbNull(filterEncounterId), RoleClaims.PrimaryRole(user));
            return Results.Ok(rows);
        }).RequireAuthorization(p => p.RequireRole("admin", "doctor", "lab", "radiology"));

        api.MapPost("/orders", async (OrderCreateRequest request, NpgsqlDataSource db, ClaimsPrincipal user, CancellationToken ct) =>
        {
            if (request.EncounterId <= 0) throw new ArgumentException("Başvuru zorunludur.");
            var orderType = (request.OrderType ?? "").Trim().ToUpperInvariant();
            if (orderType is not ("LAB" or "RAD" or "DRUG" or "PROCEDURE" or "CONSULT"))
                throw new ArgumentException("Geçersiz istem türü.");
            var priority = string.IsNullOrWhiteSpace(request.Priority) ? "R" : request.Priority.Trim().ToUpperInvariant();
            if (priority is not ("R" or "U" or "S"))
                throw new ArgumentException("Öncelik R, U veya S olmalıdır.");
            var codeSystem = Required(request.CodeSystem, "Kod sistemi", 30);
            var code = Required(request.Code, "Kod", 80);
            var description = Required(request.Description, "Açıklama", 250);
            var clinicalNote = Optional(request.ClinicalNote, 2000);
            var orderedBy = RoleClaims.DisplayName(user);

            await using var connection = await db.OpenConnectionAsync(ct);
            await using var tx = await connection.BeginTransactionAsync(ct);
            var exists = await Db.ScalarLongAsync(connection, tx,
                "SELECT count(*) FROM patient.encounters WHERE id=@p0 AND status IN ('Open','Admitted')", ct, request.EncounterId);
            if (exists == 0) throw new KeyNotFoundException("Aktif klinik başvuru bulunamadı.");

            var id = await Db.ScalarLongAsync(connection, tx, """
                INSERT INTO clinical.orders(encounter_id,order_type,code_system,code,description,ordered_by,status,priority,clinical_note,created_at,updated_at)
                VALUES(@p0,@p1,@p2,@p3,@p4,@p5,'Created',@p6,@p7,now(),now()) RETURNING id
                """, ct, request.EncounterId, orderType, codeSystem, code, description,
                orderedBy, priority, Db.TextOrDbNull(clinicalNote));

            await AuditWriter.AppendAsync(connection, tx, user, "ORDER_CREATED", "order", id.ToString(CultureInfo.InvariantCulture),
                new { encounter_id = request.EncounterId, order_type = orderType, code }, ct);
            await OutboxWriter.EnqueueAsync(connection, tx, "INTERNAL", "ClinicalOrderCreated", "order", id.ToString(CultureInfo.InvariantCulture),
                new { order_id = id, encounter_id = request.EncounterId, order_type = orderType, code }, ct);
            await tx.CommitAsync(ct);
            return Results.Created($"/api/orders/{id}", new
            {
                id,
                encounterId = request.EncounterId,
                orderType,
                codeSystem,
                code,
                description,
                orderedBy,
                priority,
                status = "Created"
            });
        }).RequireAuthorization(p => p.RequireRole("admin", "doctor"));

        api.MapPatch("/orders/{id:long}/status", async (long id, OrderStatusRequest request, NpgsqlDataSource db, ClaimsPrincipal user, CancellationToken ct) =>
        {
            if (id <= 0) throw new ArgumentException("Geçersiz istem numarası.");
            var targetStatus = (request.Status ?? "").Trim();
            if (targetStatus is not ("Submitted" or "InProgress" or "Resulted" or "Verified" or "Cancelled" or "Rejected"))
                throw new ArgumentException("Geçersiz hedef durum.");

            var role = RoleClaims.PrimaryRole(user);
            await using var connection = await db.OpenConnectionAsync(ct);
            await using var tx = await connection.BeginTransactionAsync(ct);
            var currentRows = await Db.QueryAsync(connection, tx,
                "SELECT status,order_type FROM clinical.orders WHERE id=@p0 FOR UPDATE", ct, id);
            if (currentRows.Count == 0) throw new KeyNotFoundException("İstem bulunamadı.");

            var current = Convert.ToString(currentRows[0]["status"], CultureInfo.InvariantCulture) ?? "";
            var orderType = Convert.ToString(currentRows[0]["order_type"], CultureInfo.InvariantCulture) ?? "";

            if (!OrderStateMachine.IsStructuralTransitionValid(current, targetStatus, orderType))
            {
                return Results.Conflict(new
                {
                    error = $"'{current}' durumundan '{targetStatus}' durumuna '{orderType}' isteminde geçiş yapılamaz."
                });
            }

            if (!OrderStateMachine.CanTransition(current, targetStatus, role, orderType))
            {
                return Results.Json(new
                {
                    error = $"'{role}' rolü '{orderType}' istemini '{targetStatus}' durumuna geçiremez."
                }, statusCode: StatusCodes.Status403Forbidden);
            }

            await Db.ExecuteAsync(connection, tx,
                "UPDATE clinical.orders SET status=@p0,updated_at=now() WHERE id=@p1", ct, targetStatus, id);
            await AuditWriter.AppendAsync(connection, tx, user, "ORDER_STATUS_CHANGED", "order", id.ToString(CultureInfo.InvariantCulture),
                new { from = current, to = targetStatus, order_type = orderType }, ct);
            await tx.CommitAsync(ct);
            return Results.Ok(new { id, status = targetStatus, orderType });
        }).RequireAuthorization(p => p.RequireRole("admin", "doctor", "lab", "radiology"));

        api.MapGet("/lab-results", async (NpgsqlDataSource db, CancellationToken ct) =>
        {
            var rows = await Db.QueryCamelAsync(db, """
                SELECT lr.id,lr.order_id,lr.analyte_code,lr.display,lr.value,lr.unit,lr.reference_range,
                       lr.flag,lr.critical,lr.critical_flag,lr.critical_ack_by,lr.critical_ack_at,lr.critical_ack_note,
                       lr.resulted_at,o.code AS order_code,o.encounter_id,
                       p.mrn,p.given_name,p.family_name,(p.given_name || ' ' || p.family_name) AS patient_name
                FROM clinical.lab_results lr
                JOIN clinical.orders o ON o.id=lr.order_id
                JOIN patient.encounters e ON e.id=o.encounter_id
                JOIN patient.patients p ON p.id=e.patient_id
                ORDER BY lr.id DESC LIMIT 100
                """, ct);
            return Results.Ok(rows);
        }).RequireAuthorization(p => p.RequireRole("admin", "doctor", "lab"));

        api.MapPost("/lab-results", async (LabResultCreateRequest request, NpgsqlDataSource db, ClaimsPrincipal user, CancellationToken ct) =>
        {
            if (request.OrderId <= 0) throw new ArgumentException("İstem numarası zorunludur.");
            var display = Required(request.Display, "Analit adı", 120);
            var value = Required(request.Value, "Sonuç", 120);
            var analyte = Required(request.AnalyteCode, "Analit kodu", 80);
            var flag = (request.Flag ?? "").Trim().ToUpperInvariant();
            if (flag is not ("N" or "H" or "L" or "HH" or "LL"))
                throw new ArgumentException("Geçersiz sonuç bayrağı.");
            var reference = Optional(request.ReferenceRange, 60);
            var unit = Optional(request.Unit, 30);
            var critical = CriticalLabEvaluator.IsCritical(analyte, display, value, flag, request.Critical);

            await using var connection = await db.OpenConnectionAsync(ct);
            await using var tx = await connection.BeginTransactionAsync(ct);
            var order = await Db.QueryAsync(connection, tx,
                "SELECT id,encounter_id,status,order_type FROM clinical.orders WHERE id=@p0 FOR UPDATE", ct, request.OrderId);
            if (order.Count == 0) throw new KeyNotFoundException("İstem bulunamadı.");
            if (!string.Equals(Convert.ToString(order[0]["order_type"], CultureInfo.InvariantCulture), "LAB", StringComparison.Ordinal))
                throw new InvalidOperationException("Yalnızca laboratuvar istemine sonuç eklenebilir.");
            if (!string.Equals(Convert.ToString(order[0]["status"], CultureInfo.InvariantCulture), "InProgress", StringComparison.Ordinal))
                throw new InvalidOperationException("Sonuç yalnızca işlemdeki isteme eklenebilir.");

            var id = await Db.ScalarLongAsync(connection, tx, """
                INSERT INTO clinical.lab_results(order_id,analyte_code,display,value,unit,reference_range,flag,critical,critical_flag,resulted_at)
                VALUES(@p0,@p1,@p2,@p3,@p4,@p5,@p6,@p7,@p7,now()) RETURNING id
                """, ct, request.OrderId, analyte, display, value, Db.TextOrDbNull(unit), Db.TextOrDbNull(reference), flag, critical);
            await Db.ExecuteAsync(connection, tx, "UPDATE clinical.orders SET status='Resulted',updated_at=now() WHERE id=@p0", ct, request.OrderId);
            await AuditWriter.AppendAsync(connection, tx, user, "LAB_RESULT_RECORDED", "lab-result", id.ToString(CultureInfo.InvariantCulture),
                new { order_id = request.OrderId, analyte, critical }, ct);
            await OutboxWriter.EnqueueAsync(connection, tx, "INTERNAL", "LabResultRecorded", "lab-result", id.ToString(CultureInfo.InvariantCulture),
                new { result_id = id, order_id = request.OrderId, critical }, ct);
            await tx.CommitAsync(ct);

            return Results.Created($"/api/lab-results/{id}", new
            {
                id,
                orderId = request.OrderId,
                analyteCode = analyte,
                display,
                value,
                unit,
                referenceRange = reference,
                flag,
                critical,
                criticalFlag = critical
            });
        }).RequireAuthorization(p => p.RequireRole("admin", "lab"));

        api.MapPost("/lab-results/{id:long}/acknowledge", async (long id, LabAcknowledgeRequest request, NpgsqlDataSource db, ClaimsPrincipal user, CancellationToken ct) =>
        {
            if (id <= 0) throw new ArgumentException("Geçersiz laboratuvar sonuç numarası.");
            var communicatedWith = Optional(request.CommunicatedWith, 120);
            var rawNote = Optional(string.IsNullOrWhiteSpace(request.AckNote) ? request.Note : request.AckNote, 400);
            var combined = (communicatedWith, rawNote) switch
            {
                ({ Length: > 0 } c, { Length: > 0 } n) => $"{c}: {n}",
                ({ Length: > 0 } c, _) => $"Geri bildirim: {c}",
                (_, { Length: > 0 } n) => n,
                _ => ""
            };
            if (combined.Length < 2)
                throw new ArgumentException("İletişim kurulan kişi veya geri bildirim notu girilmelidir.");
            if (combined.Length > 500)
                combined = combined[..500];

            var actorName = RoleClaims.DisplayName(user);
            await using var connection = await db.OpenConnectionAsync(ct);
            await using var tx = await connection.BeginTransactionAsync(ct);
            var existing = await Db.QueryAsync(connection, tx,
                "SELECT id,order_id,critical,critical_flag FROM clinical.lab_results WHERE id=@p0 FOR UPDATE", ct, id);
            if (existing.Count == 0) throw new KeyNotFoundException("Laboratuvar sonucu bulunamadı.");

            var isCritical = Convert.ToBoolean(existing[0]["critical"] ?? false, CultureInfo.InvariantCulture)
                             || Convert.ToBoolean(existing[0]["critical_flag"] ?? false, CultureInfo.InvariantCulture);
            if (!isCritical)
                throw new InvalidOperationException("Yalnızca kritik laboratuvar sonuçları için geri bildirim onayı verilebilir.");

            await Db.ExecuteAsync(connection, tx, """
                UPDATE clinical.lab_results
                SET critical_ack_by=@p0, critical_ack_at=now(), critical_ack_note=@p1
                WHERE id=@p2
                """, ct, actorName, combined, id);

            await AuditWriter.AppendAsync(connection, tx, user, "CRITICAL_LAB_ACKNOWLEDGED", "lab-result", id.ToString(CultureInfo.InvariantCulture),
                new { order_id = existing[0]["order_id"], communicated_with = communicatedWith, ack_note = combined }, ct);

            var updated = await Db.QueryCamelAsync(connection, tx, """
                SELECT lr.id,lr.order_id,lr.analyte_code,lr.display,lr.value,lr.unit,lr.reference_range,
                       lr.flag,lr.critical,lr.critical_flag,lr.critical_ack_by,lr.critical_ack_at,lr.critical_ack_note,
                       lr.resulted_at,o.code AS order_code,o.encounter_id,
                       p.mrn,p.given_name,p.family_name,(p.given_name || ' ' || p.family_name) AS patient_name
                FROM clinical.lab_results lr
                JOIN clinical.orders o ON o.id=lr.order_id
                JOIN patient.encounters e ON e.id=o.encounter_id
                JOIN patient.patients p ON p.id=e.patient_id
                WHERE lr.id=@p0
                """, ct, id);
            await tx.CommitAsync(ct);
            return Results.Ok(updated[0]);
        }).RequireAuthorization(p => p.RequireRole("admin", "doctor"));

        api.MapGet("/radiology-reports", async (NpgsqlDataSource db, CancellationToken ct) =>
        {
            var rows = await Db.QueryCamelAsync(db, """
                SELECT rr.id,rr.order_id,rr.report_text,rr.impression,rr.reported_by,rr.reported_at,
                       rr.modality,rr.dicom_series_uid,
                       o.code,o.description,o.encounter_id,p.mrn,p.given_name,p.family_name,(p.given_name || ' ' || p.family_name) AS patient_name
                FROM clinical.radiology_reports rr
                JOIN clinical.orders o ON o.id=rr.order_id
                JOIN patient.encounters e ON e.id=o.encounter_id
                JOIN patient.patients p ON p.id=e.patient_id
                ORDER BY rr.id DESC LIMIT 100
                """, ct);
            return Results.Ok(rows);
        }).RequireAuthorization(p => p.RequireRole("admin", "doctor", "lab", "radiology"));

        api.MapPost("/radiology-reports", async (RadiologyReportCreateRequest request, NpgsqlDataSource db, ClaimsPrincipal user, CancellationToken ct) =>
        {
            if (request.OrderId <= 0) throw new ArgumentException("İstem numarası zorunludur.");
            var reportText = Required(request.ReportText, "Rapor metni", 10000);
            var impression = Required(request.Impression, "Sonuç / izlenim", 2000);
            if (reportText.Length < 10 || impression.Length < 3)
                throw new ArgumentException("Rapor metni ve sonuç yeterli uzunlukta olmalıdır.");
            var modality = string.IsNullOrWhiteSpace(request.Modality) ? "CR" : request.Modality.Trim().ToUpperInvariant();
            if (modality is not ("CR" or "CT" or "MR" or "US"))
                throw new ArgumentException("Modalite CR, CT, MR veya US olmalıdır.");
            var dicomSeriesUid = Optional(request.DicomSeriesUid, 128)
                                 ?? $"1.2.840.10008.5.1.4.1.1.{(modality == "CT" ? "2" : modality == "MR" ? "4" : modality == "US" ? "6" : "1")}.{DateTime.UtcNow:yyyyMMddHHmmss}.{request.OrderId}";

            await using var connection = await db.OpenConnectionAsync(ct);
            await using var tx = await connection.BeginTransactionAsync(ct);
            var order = await Db.QueryAsync(connection, tx,
                "SELECT id,status,order_type FROM clinical.orders WHERE id=@p0 FOR UPDATE", ct, request.OrderId);
            if (order.Count == 0) throw new KeyNotFoundException("Radyoloji istemi bulunamadı.");
            if (!string.Equals(Convert.ToString(order[0]["order_type"], CultureInfo.InvariantCulture), "RAD", StringComparison.Ordinal)
                || !string.Equals(Convert.ToString(order[0]["status"], CultureInfo.InvariantCulture), "InProgress", StringComparison.Ordinal))
                throw new InvalidOperationException("Rapor yalnızca işlemdeki radyoloji istemine eklenebilir.");

            var reportedBy = RoleClaims.DisplayName(user);
            var id = await Db.ScalarLongAsync(connection, tx, """
                INSERT INTO clinical.radiology_reports(order_id,report_text,impression,reported_by,reported_at,modality,dicom_series_uid)
                VALUES(@p0,@p1,@p2,@p3,now(),@p4,@p5) RETURNING id
                """, ct, request.OrderId, reportText, impression, reportedBy, modality, dicomSeriesUid);
            await Db.ExecuteAsync(connection, tx, "UPDATE clinical.orders SET status='Resulted',updated_at=now() WHERE id=@p0", ct, request.OrderId);
            await AuditWriter.AppendAsync(connection, tx, user, "RADIOLOGY_REPORT_RECORDED", "radiology-report", id.ToString(CultureInfo.InvariantCulture),
                new { order_id = request.OrderId, modality }, ct);
            await OutboxWriter.EnqueueAsync(connection, tx, "INTERNAL", "RadiologyReportRecorded", "radiology-report", id.ToString(CultureInfo.InvariantCulture),
                new { report_id = id, order_id = request.OrderId, modality }, ct);
            await tx.CommitAsync(ct);

            return Results.Created($"/api/radiology-reports/{id}", new
            {
                id,
                orderId = request.OrderId,
                status = "Resulted",
                modality,
                dicomSeriesUid
            });
        }).RequireAuthorization(p => p.RequireRole("admin", "radiology"));
    }

    private static string Required(string? value, string label, int max)
    {
        var text = value?.Trim() ?? "";
        if (text.Length == 0 || text.Length > max)
            throw new ArgumentException($"{label} zorunludur (en fazla {max} karakter).");
        return text;
    }

    private static string? Optional(string? value, int max)
    {
        var text = value?.Trim() ?? "";
        if (text.Length > max) throw new ArgumentException($"Alan en fazla {max} karakter olabilir.");
        return text.Length == 0 ? null : text;
    }
}

public sealed record OrderCreateRequest(long EncounterId, string OrderType, string CodeSystem, string Code, string Description, string Priority = "R", string? ClinicalNote = null);
public sealed record OrderStatusRequest(string Status);
public sealed record LabResultCreateRequest(long OrderId, string AnalyteCode, string Display, string Value, string? Unit, string? ReferenceRange, string Flag, bool Critical = false);
public sealed record LabAcknowledgeRequest(string? CommunicatedWith = null, string? AckNote = null, string? Note = null);
public sealed record RadiologyReportCreateRequest(long OrderId, string ReportText, string Impression, string? Modality = null, string? DicomSeriesUid = null);
