using System.Globalization;
using System.Security.Claims;
using Hbys.BuildingBlocks.Audit;
using Hbys.BuildingBlocks.Database;
using Hbys.BuildingBlocks.Messaging;
using Hbys.BuildingBlocks.Security;
using Npgsql;

public static class AdtEndpoints
{
    public static void Map(WebApplication app)
    {
        var api = app.MapGroup("/api").RequireAuthorization();

        api.MapGet("/beds", async (NpgsqlDataSource db, CancellationToken ct) =>
        {
            var rows = await Db.QueryCamelAsync(db, """
                SELECT b.id,b.ward,b.room,b.bed_no,b.status,b.current_encounter_id,
                       p.mrn,p.given_name,p.family_name,
                       CASE WHEN p.id IS NOT NULL THEN (p.given_name || ' ' || p.family_name) END AS patient_name
                FROM adt.beds b
                LEFT JOIN patient.encounters e ON e.id=b.current_encounter_id
                LEFT JOIN patient.patients p ON p.id=e.patient_id
                ORDER BY b.ward,b.room,b.bed_no
                """, ct);
            return Results.Ok(rows);
        }).RequireAuthorization(p => p.RequireRole("admin", "doctor", "nurse", "registrar"));

        api.MapGet("/admissions", async (NpgsqlDataSource db, CancellationToken ct) =>
        {
            var rows = await Db.QueryCamelAsync(db, """
                SELECT a.id,a.encounter_id,a.bed_id,a.admitted_at,a.discharged_at,a.status,
                       b.ward,b.room,b.bed_no,p.mrn,p.given_name,p.family_name,
                       (p.given_name || ' ' || p.family_name) AS patient_name,e.id AS encounter_ref
                FROM adt.admissions a
                JOIN adt.beds b ON b.id=a.bed_id
                JOIN patient.encounters e ON e.id=a.encounter_id
                JOIN patient.patients p ON p.id=e.patient_id
                ORDER BY a.id DESC LIMIT 100
                """, ct);
            return Results.Ok(rows);
        }).RequireAuthorization(p => p.RequireRole("admin", "doctor", "nurse", "registrar"));

        api.MapGet("/admissions/{id:long}/transfers", async (long id, NpgsqlDataSource db, CancellationToken ct) =>
        {
            if (id <= 0) throw new ArgumentException("Geçersiz yatış numarası.");
            var exists = await Db.ScalarLongAsync(db, "SELECT count(*) FROM adt.admissions WHERE id=@p0", ct, id);
            if (exists == 0) throw new KeyNotFoundException("Yatış kaydı bulunamadı.");

            var rows = await Db.QueryCamelAsync(db, """
                SELECT t.id,t.admission_id,t.from_bed_id,fb.bed_no AS from_bed_no,fb.ward AS from_ward,
                       t.to_bed_id,tb.bed_no AS to_bed_no,tb.ward AS to_ward,
                       t.transferred_by,t.reason,t.transferred_at
                FROM adt.bed_transfers t
                JOIN adt.beds fb ON fb.id=t.from_bed_id
                JOIN adt.beds tb ON tb.id=t.to_bed_id
                WHERE t.admission_id=@p0
                ORDER BY t.id DESC
                """, ct, id);
            return Results.Ok(rows);
        }).RequireAuthorization(p => p.RequireRole("admin", "doctor", "nurse", "registrar"));

        api.MapPost("/admissions", async (AdmissionCreateRequest request, NpgsqlDataSource db, ClaimsPrincipal user, CancellationToken ct) =>
        {
            if (request.EncounterId <= 0 || request.BedId <= 0) throw new ArgumentException("Aktif başvuru ve yatak seçilmelidir.");
            await using var connection = await db.OpenConnectionAsync(ct);
            await using var tx = await connection.BeginTransactionAsync(ct);
            var encounter = await Db.QueryAsync(connection, tx, "SELECT status FROM patient.encounters WHERE id=@p0 FOR UPDATE", ct, request.EncounterId);
            if (encounter.Count == 0) throw new KeyNotFoundException("Başvuru bulunamadı.");
            if (!string.Equals(Convert.ToString(encounter[0]["status"], CultureInfo.InvariantCulture), "Open", StringComparison.Ordinal))
                throw new InvalidOperationException("Yalnızca açık başvuru yatışa alınabilir.");
            var activeAdmission = await Db.ScalarLongAsync(connection, tx,
                "SELECT count(*) FROM adt.admissions WHERE encounter_id=@p0 AND status='Admitted'", ct, request.EncounterId);
            if (activeAdmission > 0) throw new InvalidOperationException("Bu başvuru için zaten aktif yatış kaydı var.");
            var bed = await Db.QueryAsync(connection, tx, "SELECT status FROM adt.beds WHERE id=@p0 FOR UPDATE", ct, request.BedId);
            if (bed.Count == 0) throw new KeyNotFoundException("Yatak bulunamadı.");
            if (!string.Equals(Convert.ToString(bed[0]["status"], CultureInfo.InvariantCulture), "Available", StringComparison.Ordinal))
                throw new InvalidOperationException("Seçilen yatak uygun değil.");

            var id = await Db.ScalarLongAsync(connection, tx, """
                INSERT INTO adt.admissions(encounter_id,bed_id,admitted_at,status)
                VALUES(@p0,@p1,now(),'Admitted') RETURNING id
                """, ct, request.EncounterId, request.BedId);
            await Db.ExecuteAsync(connection, tx, "UPDATE adt.beds SET status='Occupied',current_encounter_id=@p0 WHERE id=@p1", ct, request.EncounterId, request.BedId);
            await Db.ExecuteAsync(connection, tx, "UPDATE patient.encounters SET status='Admitted' WHERE id=@p0", ct, request.EncounterId);
            await AuditWriter.AppendAsync(connection, tx, user, "PATIENT_ADMITTED", "admission", id.ToString(CultureInfo.InvariantCulture),
                new { encounter_id = request.EncounterId, bed_id = request.BedId }, ct);
            await OutboxWriter.EnqueueAsync(connection, tx, "INTERNAL", "PatientAdmitted", "admission", id.ToString(CultureInfo.InvariantCulture),
                new { admission_id = id, encounter_id = request.EncounterId, bed_id = request.BedId }, ct);
            await tx.CommitAsync(ct);
            return Results.Created($"/api/admissions/{id}", new { id, encounterId = request.EncounterId, bedId = request.BedId, status = "Admitted" });
        }).RequireAuthorization(p => p.RequireRole("admin", "doctor", "nurse", "registrar"));

        api.MapPost("/admissions/{id:long}/transfer", async (long id, BedTransferRequest request, NpgsqlDataSource db, ClaimsPrincipal user, CancellationToken ct) =>
        {
            var targetBedId = request.NewBedId ?? request.ToBedId ?? 0;
            if (id <= 0 || targetBedId <= 0) throw new ArgumentException("Geçerli yatış ve yeni yatak seçilmelidir.");
            var reason = string.IsNullOrWhiteSpace(request.Reason) ? "Servis içi yatak transferi" : request.Reason.Trim();
            if (reason.Length > 500) throw new ArgumentException("Transfer açıklaması en fazla 500 karakter olabilir.");
            var actorUsername = RoleClaims.Username(user);

            await using var connection = await db.OpenConnectionAsync(ct);
            await using var tx = await connection.BeginTransactionAsync(ct);
            var admission = await Db.QueryAsync(connection, tx,
                "SELECT id,encounter_id,bed_id,status FROM adt.admissions WHERE id=@p0 FOR UPDATE", ct, id);
            if (admission.Count == 0) throw new KeyNotFoundException("Yatış kaydı bulunamadı.");
            if (!string.Equals(Convert.ToString(admission[0]["status"], CultureInfo.InvariantCulture), "Admitted", StringComparison.Ordinal))
                throw new InvalidOperationException("Yalnızca aktif yatış başka yatağa aktarılabilir.");
            var encounterId = Convert.ToInt64(admission[0]["encounter_id"], CultureInfo.InvariantCulture);
            var oldBedId = Convert.ToInt64(admission[0]["bed_id"], CultureInfo.InvariantCulture);
            if (oldBedId == targetBedId) throw new ArgumentException("Yeni yatak mevcut yataktan farklı olmalıdır.");

            // Lock both beds in ascending ID order to avoid transfer deadlocks.
            var beds = await Db.QueryAsync(connection, tx, """
                SELECT id,status,current_encounter_id FROM adt.beds
                WHERE id IN (@p0,@p1) ORDER BY id FOR UPDATE
                """, ct, oldBedId, targetBedId);
            if (beds.Count != 2) throw new KeyNotFoundException("Mevcut veya hedef yatak bulunamadı.");
            var oldBed = beds.First(x => Convert.ToInt64(x["id"], CultureInfo.InvariantCulture) == oldBedId);
            var newBed = beds.First(x => Convert.ToInt64(x["id"], CultureInfo.InvariantCulture) == targetBedId);
            if (!string.Equals(Convert.ToString(oldBed["status"], CultureInfo.InvariantCulture), "Occupied", StringComparison.Ordinal) ||
                Convert.ToInt64(oldBed["current_encounter_id"], CultureInfo.InvariantCulture) != encounterId)
                throw new InvalidOperationException("Mevcut yatak ile aktif yatış tutarlı değil.");
            if (!string.Equals(Convert.ToString(newBed["status"], CultureInfo.InvariantCulture), "Available", StringComparison.Ordinal))
                throw new InvalidOperationException("Hedef yatak uygun değil.");

            await Db.ExecuteAsync(connection, tx,
                "UPDATE adt.beds SET status='Cleaning',current_encounter_id=NULL WHERE id=@p0", ct, oldBedId);
            await Db.ExecuteAsync(connection, tx,
                "UPDATE adt.beds SET status='Occupied',current_encounter_id=@p0 WHERE id=@p1", ct, encounterId, targetBedId);
            await Db.ExecuteAsync(connection, tx, "UPDATE adt.admissions SET bed_id=@p0 WHERE id=@p1", ct, targetBedId, id);
            var transferId = await Db.ScalarLongAsync(connection, tx, """
                INSERT INTO adt.bed_transfers(admission_id,from_bed_id,to_bed_id,transferred_at,transferred_by,reason)
                VALUES(@p0,@p1,@p2,now(),@p3,@p4) RETURNING id
                """, ct, id, oldBedId, targetBedId, actorUsername, reason);

            await AuditWriter.AppendAsync(connection, tx, user, "PATIENT_BED_TRANSFERRED", "admission", id.ToString(CultureInfo.InvariantCulture),
                new { transfer_id = transferId, encounter_id = encounterId, from_bed_id = oldBedId, to_bed_id = targetBedId, reason }, ct);
            await OutboxWriter.EnqueueAsync(connection, tx, "INTERNAL", "PatientBedTransferred", "admission", id.ToString(CultureInfo.InvariantCulture),
                new { admission_id = id, transfer_id = transferId, encounter_id = encounterId, from_bed_id = oldBedId, to_bed_id = targetBedId }, ct,
                $"PatientBedTransferred:transfer:{transferId}");
            await tx.CommitAsync(ct);

            return Results.Ok(new
            {
                id,
                transferId,
                fromBedId = oldBedId,
                toBedId = targetBedId,
                oldBedStatus = "Cleaning"
            });
        }).RequireAuthorization(p => p.RequireRole("admin", "doctor", "nurse", "registrar"));

        api.MapPost("/beds/{id:long}/cleaning-complete", async (long id, NpgsqlDataSource db, ClaimsPrincipal user, CancellationToken ct) =>
        {
            if (id <= 0) throw new ArgumentException("Geçersiz yatak numarası.");
            await using var connection = await db.OpenConnectionAsync(ct);
            await using var tx = await connection.BeginTransactionAsync(ct);
            var rows = await Db.QueryAsync(connection, tx, "SELECT status FROM adt.beds WHERE id=@p0 FOR UPDATE", ct, id);
            if (rows.Count == 0) throw new KeyNotFoundException("Yatak bulunamadı.");
            if (!string.Equals(Convert.ToString(rows[0]["status"], CultureInfo.InvariantCulture), "Cleaning", StringComparison.Ordinal))
                throw new InvalidOperationException("Yalnızca temizlik durumundaki yatak tekrar kullanıma açılabilir.");

            await Db.ExecuteAsync(connection, tx, "UPDATE adt.beds SET status='Available',current_encounter_id=NULL WHERE id=@p0", ct, id);
            var cleaningOperationId = Guid.NewGuid();
            await AuditWriter.AppendAsync(connection, tx, user, "BED_CLEANING_COMPLETED", "bed", id.ToString(CultureInfo.InvariantCulture),
                new { bed_id = id, cleaning_operation_id = cleaningOperationId }, ct);
            await OutboxWriter.EnqueueAsync(connection, tx, "INTERNAL", "BedAvailable", "bed", id.ToString(CultureInfo.InvariantCulture),
                new { bed_id = id, cleaning_operation_id = cleaningOperationId }, ct,
                $"BedAvailable:bed:{id}:cleaning:{cleaningOperationId:N}");
            await tx.CommitAsync(ct);
            return Results.Ok(new { id, status = "Available" });
        }).RequireAuthorization(p => p.RequireRole("admin", "nurse"));

        api.MapPost("/admissions/{id:long}/discharge", async (long id, NpgsqlDataSource db, ClaimsPrincipal user, CancellationToken ct) =>
        {
            if (id <= 0) throw new ArgumentException("Geçersiz yatış numarası.");
            await using var connection = await db.OpenConnectionAsync(ct);
            await using var tx = await connection.BeginTransactionAsync(ct);
            var rows = await Db.QueryAsync(connection, tx, "SELECT id,encounter_id,bed_id,status FROM adt.admissions WHERE id=@p0 FOR UPDATE", ct, id);
            if (rows.Count == 0) throw new KeyNotFoundException("Yatış kaydı bulunamadı.");
            if (!string.Equals(Convert.ToString(rows[0]["status"], CultureInfo.InvariantCulture), "Admitted", StringComparison.Ordinal))
                throw new InvalidOperationException("Yalnızca aktif yatış taburcu edilebilir.");
            var encounterId = Convert.ToInt64(rows[0]["encounter_id"], CultureInfo.InvariantCulture);
            var bedId = Convert.ToInt64(rows[0]["bed_id"], CultureInfo.InvariantCulture);

            await Db.ExecuteAsync(connection, tx, "UPDATE adt.admissions SET status='Discharged',discharged_at=now() WHERE id=@p0", ct, id);
            var released = await Db.ExecuteAsync(connection, tx,
                "UPDATE adt.beds SET status='Cleaning',current_encounter_id=NULL WHERE id=@p0 AND current_encounter_id=@p1 AND status='Occupied'", ct, bedId, encounterId);
            if (released != 1) throw new InvalidOperationException("Yatak ve yatış kaydı tutarlı değil; taburcu işlemi durduruldu.");
            await Db.ExecuteAsync(connection, tx, "UPDATE patient.encounters SET status='Discharged',closed_at=now() WHERE id=@p0", ct, encounterId);
            await AuditWriter.AppendAsync(connection, tx, user, "PATIENT_DISCHARGED", "admission", id.ToString(CultureInfo.InvariantCulture),
                new { encounter_id = encounterId, bed_id = bedId }, ct);
            await OutboxWriter.EnqueueAsync(connection, tx, "INTERNAL", "PatientDischarged", "admission", id.ToString(CultureInfo.InvariantCulture),
                new { admission_id = id, encounter_id = encounterId, bed_id = bedId }, ct);
            await tx.CommitAsync(ct);
            return Results.Ok(new { id, status = "Discharged", bedStatus = "Cleaning" });
        }).RequireAuthorization(p => p.RequireRole("admin", "doctor", "nurse", "registrar"));
    }
}

public sealed record AdmissionCreateRequest(long EncounterId, long BedId);
public sealed record BedTransferRequest(long? NewBedId = null, long? ToBedId = null, string? Reason = null);
