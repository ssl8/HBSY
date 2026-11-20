using System.Globalization;
using System.Security.Claims;
using System.Text.Json;
using Hbys.BuildingBlocks.Audit;
using Hbys.BuildingBlocks.Database;
using Hbys.BuildingBlocks.Messaging;
using Hbys.BuildingBlocks.Security;
using Npgsql;

public static class ConnectorEndpoints
{
    public static void Map(WebApplication app)
    {
        var api = app.MapGroup("/api/connectors").RequireAuthorization();

        api.MapGet("/overview", async (IConfiguration config, NpgsqlDataSource db, CancellationToken ct) =>
            await GetOverviewAsync(config, db, ct))
            .RequireAuthorization(p => p.RequireRole("admin", "doctor", "nurse", "pharmacist", "billing", "registrar", "integration"));

        api.MapGet("/status", async (IConfiguration config, NpgsqlDataSource db, CancellationToken ct) =>
            await GetOverviewAsync(config, db, ct))
            .RequireAuthorization(p => p.RequireRole("admin", "doctor", "nurse", "pharmacist", "billing", "registrar", "integration"));

        // --- MHRS (Merkezi Hekim Randevu Sistemi) ---
        api.MapGet("/mhrs/appointments", async (NpgsqlDataSource db, CancellationToken ct) =>
        {
            var rows = await Db.QueryCamelAsync(db, """
                SELECT id,patient_id,patient_ref,patient_name,polyclinic,doctor,
                       appointment_time,appointment_time AS slot_time,appointment_date,
                       status,encounter_id,medula_takip_no,note,created_at
                FROM integration.mhrs_appointments
                ORDER BY created_at DESC, id DESC LIMIT 100
                """, ct);
            return Results.Ok(rows);
        }).RequireAuthorization(p => p.RequireRole("admin", "doctor", "registrar", "integration"));

        api.MapPost("/mhrs/sync", async (NpgsqlDataSource db, ClaimsPrincipal user, CancellationToken ct) =>
        {
            await using var connection = await db.OpenConnectionAsync(ct);
            await using var tx = await connection.BeginTransactionAsync(ct);

            // Seed a fresh slot if fewer than 2 Booked slots remain so interactive admission demos stay ready.
            var bookedCount = await Db.ScalarLongAsync(connection, tx,
                "SELECT count(*) FROM integration.mhrs_appointments WHERE status='Booked'", ct);
            if (bookedCount == 0)
            {
                var patRows = await Db.QueryAsync(connection, tx,
                    "SELECT id,mrn,given_name,family_name FROM patient.patients WHERE active ORDER BY id LIMIT 1", ct);
                if (patRows.Count > 0)
                {
                    var pid = Convert.ToInt64(patRows[0]["id"], CultureInfo.InvariantCulture);
                    var mrn = Convert.ToString(patRows[0]["mrn"], CultureInfo.InvariantCulture) ?? "HB-000101";
                    var fullName = $"{patRows[0]["given_name"]} {patRows[0]["family_name"]}".Trim();
                    var slotId = $"MHRS-{DateTime.UtcNow:yyyy}-{Guid.NewGuid().ToString("N")[..5].ToUpperInvariant()}";
                    var slotTime = DateTime.UtcNow.AddMinutes(15).ToString("HH:mm", CultureInfo.InvariantCulture);
                    await Db.ExecuteAsync(connection, tx, """
                        INSERT INTO integration.mhrs_appointments(id,patient_id,patient_ref,patient_name,polyclinic,doctor,appointment_time,appointment_date,status,note,created_at)
                        VALUES(@p0,@p1,@p2,@p3,'İç Hastalıkları (Dahiliye)','Uzm. Dr. Mehmet Kaya',@p4,CURRENT_DATE,'Booked','MHRS senkronizasyon randevusu',now())
                        ON CONFLICT (id) DO NOTHING
                        """, ct, slotId, pid, $"TR-REF-{mrn}", fullName, slotTime);
                }
            }

            var rows = await Db.QueryCamelAsync(connection, tx, """
                SELECT id,patient_id,patient_ref,patient_name,polyclinic,doctor,
                       appointment_time,appointment_time AS slot_time,appointment_date,
                       status,encounter_id,medula_takip_no,note,created_at
                FROM integration.mhrs_appointments
                ORDER BY created_at DESC, id DESC LIMIT 100
                """, ct);

            await AuditWriter.AppendAsync(connection, tx, user, "MHRS_SYNC_EXECUTED", "mhrs-sync", null,
                new { count = rows.Count }, ct);
            await tx.CommitAsync(ct);

            return Results.Ok(new
            {
                ok = true,
                synced = true,
                count = rows.Count,
                appointments = rows
            });
        }).RequireAuthorization(p => p.RequireRole("admin", "doctor", "registrar", "integration"));

        api.MapPost("/mhrs/appointments", async (MhrsBookRequest request, NpgsqlDataSource db, ClaimsPrincipal user, CancellationToken ct) =>
        {
            var polyclinic = Required(request.Polyclinic, "Poliklinik", 120);
            var doctor = Required(request.Doctor, "Hekim", 120);
            var rawTime = string.IsNullOrWhiteSpace(request.AppointmentTime) ? request.SlotTime : request.AppointmentTime;
            var appointmentTime = string.IsNullOrWhiteSpace(rawTime)
                ? DateTime.UtcNow.ToString("HH:mm", CultureInfo.InvariantCulture)
                : Required(rawTime, "Randevu saati", 10);
            var note = Optional(request.Note, 500);
            DateOnly? appointmentDate = null;
            if (!string.IsNullOrWhiteSpace(request.AppointmentDate))
            {
                if (!DateOnly.TryParseExact(request.AppointmentDate.Trim(), "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var parsedDate))
                    throw new ArgumentException("Randevu tarihi yyyy-MM-dd biçiminde olmalıdır.");
                appointmentDate = parsedDate;
            }

            await using var connection = await db.OpenConnectionAsync(ct);
            await using var tx = await connection.BeginTransactionAsync(ct);

            string? resolvedName = Optional(request.PatientName, 120);
            string? mrnRef = null;
            if (request.PatientId is > 0)
            {
                var pRows = await Db.QueryAsync(connection, tx,
                    "SELECT id,mrn,given_name,family_name FROM patient.patients WHERE id=@p0 AND active", ct, request.PatientId.Value);
                if (pRows.Count == 0) throw new KeyNotFoundException("Hasta bulunamadı.");
                mrnRef = Convert.ToString(pRows[0]["mrn"], CultureInfo.InvariantCulture);
                resolvedName ??= $"{pRows[0]["given_name"]} {pRows[0]["family_name"]}".Trim();
            }

            if (string.IsNullOrWhiteSpace(resolvedName))
                throw new ArgumentException("Hasta adı veya hasta kaydı zorunludur.");

            var patientRef = TokenizePatientRef(request.PatientRef, mrnRef, request.PatientId);
            var id = $"MHRS-{DateTime.UtcNow:yyyy}-{Random.Shared.Next(1000, 9999)}";
            var existing = await Db.ScalarLongAsync(connection, tx, "SELECT count(*) FROM integration.mhrs_appointments WHERE id=@p0", ct, id);
            if (existing > 0)
                id = $"MHRS-{DateTime.UtcNow:yyyy}-{Guid.NewGuid().ToString("N")[..6].ToUpperInvariant()}";

            var effectiveDate = appointmentDate ?? DateOnly.FromDateTime(DateTime.UtcNow);
            await Db.ExecuteAsync(connection, tx, """
                INSERT INTO integration.mhrs_appointments(id,patient_id,patient_ref,patient_name,polyclinic,doctor,appointment_time,appointment_date,status,note,created_at)
                VALUES(@p0,@p1,@p2,@p3,@p4,@p5,@p6,@p7,'Booked',@p8,now())
                """, ct, id, Db.BigintOrDbNull(request.PatientId), patientRef, resolvedName, polyclinic, doctor,
                appointmentTime, effectiveDate, Db.TextOrDbNull(note));

            await AuditWriter.AppendAsync(connection, tx, user, "MHRS_APPOINTMENT_BOOKED", "mhrs-appointment", id,
                new { patient_ref = patientRef, polyclinic, doctor, appointment_time = appointmentTime }, ct);
            await OutboxWriter.EnqueueAsync(connection, tx, "MHRS", "MhrsAppointmentBooked", "mhrs", id,
                new { appointment_id = id, patient_ref = patientRef, polyclinic, doctor, status = "Booked" }, ct);

            var created = await Db.QueryCamelAsync(connection, tx, """
                SELECT id,patient_id,patient_ref,patient_name,polyclinic,doctor,
                       appointment_time,appointment_time AS slot_time,appointment_date,
                       status,encounter_id,medula_takip_no,note,created_at
                FROM integration.mhrs_appointments WHERE id=@p0
                """, ct, id);
            await tx.CommitAsync(ct);
            return Results.Created($"/api/connectors/mhrs/appointments/{id}", created[0]);
        }).RequireAuthorization(p => p.RequireRole("admin", "doctor", "registrar", "integration"));

        api.MapPost("/mhrs/admit", async (MhrsAdmitRequest request, NpgsqlDataSource db, ClaimsPrincipal user, CancellationToken ct) =>
            await AdmitMhrsAsync(request.AppointmentId ?? request.Id ?? "", request.PatientId, db, user, ct))
            .RequireAuthorization(p => p.RequireRole("admin", "doctor", "registrar", "integration"));

        api.MapPost("/mhrs/appointments/{id}/admit", async (string id, MhrsAdmitRequest? request, NpgsqlDataSource db, ClaimsPrincipal user, CancellationToken ct) =>
            await AdmitMhrsAsync(id, request?.PatientId, db, user, ct))
            .RequireAuthorization(p => p.RequireRole("admin", "doctor", "registrar", "integration"));

        // --- ULAK 112 (Acil Sağlık Hizmetleri) ---
        api.MapGet("/ulak/cases", async (NpgsqlDataSource db, CancellationToken ct) =>
        {
            var rows = await Db.QueryCamelAsync(db, """
                SELECT id,patient_id,patient_name,patient_ref,team_code,ambulance_plate,
                       triage_level,triage_level AS priority,triage_level AS triage_code,
                       triage_title,incident_summary,incident_summary AS location,
                       vitals::text AS vitals_json,
                       eta_minutes,eta_minutes AS etr_minutes,status,encounter_id,bed_assigned,created_at,arrived_at
                FROM integration.ulak_cases
                ORDER BY created_at DESC, id DESC LIMIT 100
                """, ct);
            foreach (var row in rows)
                row["vitals"] = ParseJsonOrEmpty(row.GetValueOrDefault("vitalsJson")?.ToString());
            return Results.Ok(rows);
        }).RequireAuthorization(p => p.RequireRole("admin", "doctor", "nurse", "integration"));

        api.MapPost("/ulak/cases", async (UlakCreateRequest request, NpgsqlDataSource db, ClaimsPrincipal user, CancellationToken ct) =>
            await DispatchUlakAsync(request, db, user, ct))
            .RequireAuthorization(p => p.RequireRole("admin", "doctor", "nurse", "integration"));

        api.MapPost("/ulak/dispatch", async (UlakCreateRequest request, NpgsqlDataSource db, ClaimsPrincipal user, CancellationToken ct) =>
            await DispatchUlakAsync(request, db, user, ct))
            .RequireAuthorization(p => p.RequireRole("admin", "doctor", "nurse", "integration"));

        api.MapPost("/ulak/admit", async (UlakAdmitRequest request, NpgsqlDataSource db, ClaimsPrincipal user, CancellationToken ct) =>
            await AdmitUlakAsync(request.CaseId ?? request.Id ?? "", request.PatientId, db, user, ct))
            .RequireAuthorization(p => p.RequireRole("admin", "doctor", "nurse", "integration"));

        api.MapPost("/ulak/cases/{id}/admit", async (string id, UlakAdmitRequest? request, NpgsqlDataSource db, ClaimsPrincipal user, CancellationToken ct) =>
            await AdmitUlakAsync(id, request?.PatientId, db, user, ct))
            .RequireAuthorization(p => p.RequireRole("admin", "doctor", "nurse", "integration"));

        // --- SGK MEDULA ---
        api.MapGet("/medula/provisions", async (NpgsqlDataSource db, CancellationToken ct) =>
        {
            var rows = await Db.QueryCamelAsync(db, """
                SELECT takip_no,patient_id,encounter_id,patient_ref,sigortali_turu,brans_kodu,
                       provizyon_tipi,katilim_payi,sonuc_kodu,sonuc_mesaji,created_at,created_at AS sorgulama_zamani
                FROM integration.medula_provisions
                ORDER BY created_at DESC LIMIT 100
                """, ct);
            return Results.Ok(rows);
        }).RequireAuthorization(p => p.RequireRole("admin", "billing", "registrar", "integration"));

        api.MapPost("/medula/provision", async (MedulaProvisionRequest request, NpgsqlDataSource db, ClaimsPrincipal user, CancellationToken ct) =>
        {
            var sigortaliTuru = Optional(request.SigortaliTuru, 80) ?? "4A (SSK Aktif Çalışan)";
            var bransKodu = Optional(request.BransKodu, 20) ?? "1000";
            var provizyonTipi = Optional(request.ProvizyonTipi, 40) ?? "Normal";
            var katilimPayi = provizyonTipi.Contains("Acil", StringComparison.OrdinalIgnoreCase) ? 0.00m : 15.00m;

            await using var connection = await db.OpenConnectionAsync(ct);
            await using var tx = await connection.BeginTransactionAsync(ct);

            long? patientId = request.PatientId;
            string? mrnRef = null;
            if (request.EncounterId is > 0)
            {
                var enc = await Db.QueryAsync(connection, tx,
                    "SELECT id,patient_id FROM patient.encounters WHERE id=@p0", ct, request.EncounterId.Value);
                if (enc.Count == 0) throw new KeyNotFoundException("Başvuru bulunamadı.");
                patientId ??= Convert.ToInt64(enc[0]["patient_id"], CultureInfo.InvariantCulture);
            }

            if (patientId is > 0)
            {
                var pat = await Db.QueryAsync(connection, tx,
                    "SELECT id,mrn FROM patient.patients WHERE id=@p0 AND active", ct, patientId.Value);
                if (pat.Count == 0) throw new KeyNotFoundException("Hasta bulunamadı.");
                mrnRef = Convert.ToString(pat[0]["mrn"], CultureInfo.InvariantCulture);
            }

            var rawRefInput = string.IsNullOrWhiteSpace(request.PatientRef) ? request.Tckn : request.PatientRef;
            var patientRef = TokenizePatientRef(rawRefInput, mrnRef, patientId);
            var takipNo = $"{DateTime.UtcNow:yyMMdd}{Random.Shared.Next(100000, 999999)}";
            var exists = await Db.ScalarLongAsync(connection, tx,
                "SELECT count(*) FROM integration.medula_provisions WHERE takip_no=@p0", ct, takipNo);
            if (exists > 0)
                takipNo = $"MD{Guid.NewGuid().ToString("N")[..10].ToUpperInvariant()}";

            await Db.ExecuteAsync(connection, tx, """
                INSERT INTO integration.medula_provisions(takip_no,patient_id,encounter_id,patient_ref,sigortali_turu,brans_kodu,provizyon_tipi,katilim_payi,sonuc_kodu,sonuc_mesaji,created_at)
                VALUES(@p0,@p1,@p2,@p3,@p4,@p5,@p6,@p7,'0000','Hak sahipliği doğrulandı.',now())
                """, ct, takipNo, Db.BigintOrDbNull(patientId), Db.BigintOrDbNull(request.EncounterId), patientRef,
                sigortaliTuru, bransKodu, provizyonTipi, katilimPayi);

            await AuditWriter.AppendAsync(connection, tx, user, "MEDULA_PROVISION_ISSUED", "medula-provision", takipNo,
                new { encounter_id = request.EncounterId, patient_ref = patientRef, brans_kodu = bransKodu, provizyon_tipi = provizyonTipi }, ct);
            await OutboxWriter.EnqueueAsync(connection, tx, "MEDULA", "MedulaProvisionIssued", "medula", takipNo,
                new { takip_no = takipNo, encounter_id = request.EncounterId, patient_ref = patientRef, sonuc_kodu = "0000" }, ct);

            var created = await Db.QueryCamelAsync(connection, tx, """
                SELECT takip_no,patient_id,encounter_id,patient_ref,sigortali_turu,brans_kodu,
                       provizyon_tipi,katilim_payi,sonuc_kodu,sonuc_mesaji,created_at,created_at AS sorgulama_zamani
                FROM integration.medula_provisions WHERE takip_no=@p0
                """, ct, takipNo);
            await tx.CommitAsync(ct);
            created[0]["gssTesisKodu"] = "11340001";
            return Results.Created($"/api/connectors/medula/provisions/{takipNo}", created[0]);
        }).RequireAuthorization(p => p.RequireRole("admin", "billing", "registrar", "integration"));

        // --- e-Nabız / USS ---
        api.MapGet("/enabiz/packages", async (NpgsqlDataSource db, CancellationToken ct) =>
        {
            var rows = await Db.QueryCamelAsync(db, """
                SELECT id,patient_id,encounter_id,patient_ref,paket_tipi,package_type,sys_takip_no,
                       status,response_code,response_msg,response_msg AS response_message,
                       created_at,created_at AS sent_at
                FROM integration.enabiz_packages
                ORDER BY id DESC LIMIT 100
                """, ct);
            foreach (var row in rows)
            {
                var paketTipi = Convert.ToInt32(row["paketTipi"] ?? 101, CultureInfo.InvariantCulture);
                var pkgType = Convert.ToString(row.GetValueOrDefault("packageType"), CultureInfo.InvariantCulture);
                row["packageType"] = string.IsNullOrWhiteSpace(pkgType) ? FormatEnabizPackageType(paketTipi) : pkgType;
            }
            return Results.Ok(rows);
        }).RequireAuthorization(p => p.RequireRole("admin", "doctor", "integration"));

        api.MapPost("/enabiz/send", async (EnabizSendRequest request, NpgsqlDataSource db, ClaimsPrincipal user, CancellationToken ct) =>
            await SendEnabizPackageAsync(request, db, user, ct))
            .RequireAuthorization(p => p.RequireRole("admin", "doctor", "integration"));

        api.MapPost("/uss/send", async (EnabizSendRequest request, NpgsqlDataSource db, ClaimsPrincipal user, CancellationToken ct) =>
            await SendEnabizPackageAsync(request, db, user, ct))
            .RequireAuthorization(p => p.RequireRole("admin", "doctor", "integration"));

        // --- İTS / ÜTS Karekod Doğrulama ---
        api.MapGet("/its/verifications", async (NpgsqlDataSource db, CancellationToken ct) =>
        {
            var rows = await Db.QueryCamelAsync(db, """
                SELECT v.id,v.barcode,v.drug_id,v.gtin,v.lot_no,v.serial_no,v.status,v.verified_by,v.verified_at,
                       d.name AS drug_name,d.name AS product_name,d.generic_name,d.code AS drug_code,d.uts_code,d.uts_code AS its_code
                FROM integration.its_verifications v
                LEFT JOIN pharmacy.drugs d ON d.id=v.drug_id
                ORDER BY v.id DESC LIMIT 100
                """, ct);
            return Results.Ok(rows);
        }).RequireAuthorization(p => p.RequireRole("admin", "pharmacist", "integration"));

        api.MapPost("/its/verify", async (ItsVerifyRequest request, NpgsqlDataSource db, ClaimsPrincipal user, CancellationToken ct) =>
            await VerifyItsAsync(request, db, user, ct))
            .RequireAuthorization(p => p.RequireRole("admin", "pharmacist", "integration"));

        api.MapPost("/uts/verify", async (ItsVerifyRequest request, NpgsqlDataSource db, ClaimsPrincipal user, CancellationToken ct) =>
            await VerifyItsAsync(request, db, user, ct))
            .RequireAuthorization(p => p.RequireRole("admin", "pharmacist", "integration"));
    }

    private static async Task<IResult> GetOverviewAsync(IConfiguration config, NpgsqlDataSource db, CancellationToken ct)
    {
        var counts = await Db.QueryAsync(db, """
            SELECT
              (SELECT count(*) FROM integration.mhrs_appointments) AS mhrs_total,
              (SELECT count(*) FROM integration.mhrs_appointments WHERE status='Booked') AS mhrs_booked,
              (SELECT count(*) FROM integration.ulak_cases) AS ulak_total,
              (SELECT count(*) FROM integration.ulak_cases WHERE status='EnRoute') AS ulak_enroute,
              (SELECT count(*) FROM integration.medula_provisions) AS medula_total,
              (SELECT count(*) FROM integration.enabiz_packages) AS enabiz_total,
              (SELECT count(*) FROM integration.its_verifications) AS its_total,
              (SELECT count(*) FROM integration.outbox WHERE status IN ('Pending','Processing')) AS outbox_pending,
              (SELECT count(*) FROM integration.outbox WHERE status='Sent') AS outbox_sent,
              (SELECT count(*) FROM integration.outbox WHERE status IN ('Failed','DeadLetter')) AS outbox_failed
            """, ct);

        var row = counts[0];
        var mhrsTotal = Convert.ToInt64(row["mhrs_total"] ?? 0, CultureInfo.InvariantCulture);
        var ulakTotal = Convert.ToInt64(row["ulak_total"] ?? 0, CultureInfo.InvariantCulture);
        var medulaTotal = Convert.ToInt64(row["medula_total"] ?? 0, CultureInfo.InvariantCulture);
        var enabizTotal = Convert.ToInt64(row["enabiz_total"] ?? 0, CultureInfo.InvariantCulture);
        var itsTotal = Convert.ToInt64(row["its_total"] ?? 0, CultureInfo.InvariantCulture);
        var pendingOutbox = Convert.ToInt64(row["outbox_pending"] ?? 0, CultureInfo.InvariantCulture);
        var sentOutbox = Convert.ToInt64(row["outbox_sent"] ?? 0, CultureInfo.InvariantCulture);
        var failedOutbox = Convert.ToInt64(row["outbox_failed"] ?? 0, CultureInfo.InvariantCulture);

        var mode = config["HBYS_CONNECTOR_MODE"] ?? config["HBYS_MODE"] ?? "sandbox";
        var gateways = new object[]
        {
            new
            {
                key = "mhrs",
                name = "MHRS Randevu Gateway",
                protocol = "REST / JSON",
                endpoint = "mhrs.saglik.gov.tr/api/v3",
                status = "Online",
                latencyMs = 38,
                totalCount = mhrsTotal,
                pendingCount = row["mhrs_booked"]
            },
            new
            {
                key = "ulak",
                name = "ULAK 112 Acil Vaka Ağı",
                protocol = "REST / HL7",
                endpoint = "112komuta.saglik.gov.tr/ulak",
                status = "Online",
                latencyMs = 29,
                totalCount = ulakTotal,
                pendingCount = row["ulak_enroute"]
            },
            new
            {
                key = "medula",
                name = "SGK MEDULA GSS",
                protocol = "SOAP / XML",
                endpoint = "medula.sgk.gov.tr/medula/hastane",
                status = "Online",
                latencyMs = 64,
                totalCount = medulaTotal,
                pendingCount = 0
            },
            new
            {
                key = "enabiz",
                name = "USS / e-Nabız Sağlık Bakanlığı",
                protocol = "REST / JSON",
                endpoint = "sys.saglik.gov.tr/enabiz",
                status = "Online",
                latencyMs = 52,
                totalCount = enabizTotal,
                pendingCount = 0
            },
            new
            {
                key = "its",
                name = "İTS / ÜTS Karekod Doğrulama",
                protocol = "REST / JSON",
                endpoint = "its.saglik.gov.tr/pts/verify",
                status = "Online",
                latencyMs = 41,
                totalCount = itsTotal,
                pendingCount = 0
            }
        };

        return Results.Ok(new
        {
            mode,
            gateways,
            counts = new
            {
                totalGateways = gateways.Length,
                totalTrafficToday = mhrsTotal + ulakTotal + medulaTotal + enabizTotal + itsTotal,
                pendingOutbox,
                failedOutbox
            },
            connectors = gateways,
            summary = new
            {
                mhrsTotal,
                mhrsBooked = row["mhrs_booked"],
                ulakTotal,
                ulakEnRoute = row["ulak_enroute"],
                medulaTotal,
                enabizTotal,
                itsTotal
            },
            outbox = new
            {
                pending = pendingOutbox,
                sent = sentOutbox,
                failed = failedOutbox
            }
        });
    }

    private static async Task<IResult> DispatchUlakAsync(UlakCreateRequest request, NpgsqlDataSource db, ClaimsPrincipal user, CancellationToken ct)
    {
        var location = Optional(string.IsNullOrWhiteSpace(request.Location) ? request.IncidentLocation : request.Location, 200);
        var teamCode = Optional(request.TeamCode, 30) ?? "34-KMT-112";
        var ambulancePlate = Optional(request.AmbulancePlate, 30) ?? "34 AS 1120";

        var rawPriority = !string.IsNullOrWhiteSpace(request.Priority)
            ? request.Priority
            : !string.IsNullOrWhiteSpace(request.EmergencyLevel)
                ? request.EmergencyLevel
                : !string.IsNullOrWhiteSpace(request.TriageCode)
                    ? request.TriageCode
                    : request.TriageLevel;
        var triageLevel = (rawPriority ?? "RED").Trim().ToUpperInvariant();
        if (triageLevel is not ("RED" or "YELLOW" or "GREEN"))
            throw new ArgumentException("Triaj seviyesi RED, YELLOW veya GREEN olmalıdır.");

        var triageTitle = Optional(request.TriageTitle, 120) ?? triageLevel switch
        {
            "RED" => "KIRMIZI ALAN (Resüsitasyon)",
            "YELLOW" => "SARI ALAN (Acil Gözlem)",
            _ => "YEŞİL ALAN (Ayaktan Acil)"
        };
        var rawSummary = !string.IsNullOrWhiteSpace(request.IncidentSummary)
            ? request.IncidentSummary
            : request.ChiefComplaint;
        var incidentSummary = Optional(rawSummary, 1000)
                              ?? (location is not null ? $"{location} — 112 Acil Sevk Bildirimi" : "112 Acil Vaka Sevki");
        var etaMinutes = Math.Clamp(request.EtrMinutes ?? request.EtaMinutes ?? 5, 0, 240);
        var vitalsJson = JsonSerializer.Serialize(new
        {
            bp = Optional(request.Bp, 24) ?? "120/80 mmHg",
            pulse = request.Pulse ?? 88,
            spo2 = request.Spo2 ?? 96,
            gcs = request.Gcs ?? 15
        });

        await using var connection = await db.OpenConnectionAsync(ct);
        await using var tx = await connection.BeginTransactionAsync(ct);

        string? mrnRef = null;
        string? patientName = Optional(request.PatientName, 120);
        if (request.PatientId is > 0)
        {
            var pRows = await Db.QueryAsync(connection, tx,
                "SELECT mrn,given_name,family_name FROM patient.patients WHERE id=@p0 AND active", ct, request.PatientId.Value);
            if (pRows.Count == 0) throw new KeyNotFoundException("Hasta bulunamadı.");
            mrnRef = Convert.ToString(pRows[0]["mrn"], CultureInfo.InvariantCulture);
            patientName ??= $"{pRows[0]["given_name"]} {pRows[0]["family_name"]}".Trim();
        }
        patientName = Required(patientName, "Hasta / vaka adı", 120);

        var patientRef = TokenizePatientRef(request.PatientRef, mrnRef, request.PatientId);
        var id = $"ULAK-112-{Random.Shared.Next(100, 999)}-{Guid.NewGuid().ToString("N")[..3].ToUpperInvariant()}";

        await Db.ExecuteAsync(connection, tx, """
            INSERT INTO integration.ulak_cases(id,patient_id,patient_name,patient_ref,team_code,ambulance_plate,triage_level,triage_title,incident_summary,vitals,eta_minutes,status,created_at)
            VALUES(@p0,@p1,@p2,@p3,@p4,@p5,@p6,@p7,@p8,@p9::jsonb,@p10,'EnRoute',now())
            """, ct, id, Db.BigintOrDbNull(request.PatientId), patientName, patientRef, teamCode, ambulancePlate,
            triageLevel, triageTitle, incidentSummary, vitalsJson, etaMinutes);

        await AuditWriter.AppendAsync(connection, tx, user, "ULAK_CASE_REGISTERED", "ulak-case", id,
            new { patient_ref = patientRef, team_code = teamCode, triage_level = triageLevel }, ct);
        await OutboxWriter.EnqueueAsync(connection, tx, "ULAK112", "UlakCaseRegistered", "emergency", id,
            new { case_id = id, patient_ref = patientRef, team_code = teamCode, triage_level = triageLevel }, ct);

        var created = await Db.QueryCamelAsync(connection, tx, """
            SELECT id,patient_id,patient_name,patient_ref,team_code,ambulance_plate,
                   triage_level,triage_level AS priority,triage_level AS triage_code,
                   triage_title,incident_summary,incident_summary AS location,
                   vitals::text AS vitals_json,
                   eta_minutes,eta_minutes AS etr_minutes,status,encounter_id,bed_assigned,created_at,arrived_at
            FROM integration.ulak_cases WHERE id=@p0
            """, ct, id);
        await tx.CommitAsync(ct);
        created[0]["vitals"] = ParseJsonOrEmpty(created[0].GetValueOrDefault("vitalsJson")?.ToString());
        return Results.Created($"/api/connectors/ulak/cases/{id}", created[0]);
    }

    private static async Task<IResult> AdmitMhrsAsync(string rawId, long? overridePatientId, NpgsqlDataSource db, ClaimsPrincipal user, CancellationToken ct)
    {
        var id = Required(rawId, "MHRS randevu numarası", 40);
        await using var connection = await db.OpenConnectionAsync(ct);
        await using var tx = await connection.BeginTransactionAsync(ct);

        var rows = await Db.QueryAsync(connection, tx, """
            SELECT id,patient_id,patient_ref,polyclinic,status,note
            FROM integration.mhrs_appointments WHERE id=@p0 FOR UPDATE
            """, ct, id);
        if (rows.Count == 0) throw new KeyNotFoundException("MHRS randevusu bulunamadı.");
        if (string.Equals(Convert.ToString(rows[0]["status"], CultureInfo.InvariantCulture), "Admitted", StringComparison.Ordinal))
            throw new InvalidOperationException("Bu MHRS randevusu zaten hasta kabulüne dönüştürüldü.");

        var patientId = overridePatientId
                        ?? (rows[0]["patient_id"] is null ? null : Convert.ToInt64(rows[0]["patient_id"], CultureInfo.InvariantCulture));
        if (patientId is null or <= 0)
            throw new ArgumentException("MHRS kabulü için eşleştirilmiş hasta ID gereklidir.");

        var pat = await Db.QueryAsync(connection, tx, "SELECT id,mrn FROM patient.patients WHERE id=@p0 AND active", ct, patientId.Value);
        if (pat.Count == 0) throw new KeyNotFoundException("Eşleştirilen hasta bulunamadı.");

        var polyclinic = Convert.ToString(rows[0]["polyclinic"], CultureInfo.InvariantCulture) ?? "Poliklinik";
        var note = Convert.ToString(rows[0]["note"], CultureInfo.InvariantCulture);
        var complaint = string.IsNullOrWhiteSpace(note) ? $"MHRS Randevulu Muayene ({polyclinic})" : $"{note} (MHRS {id})";
        if (complaint.Length > 500) complaint = complaint[..500];
        var extRef = $"MHRS-ADM-{id}";

        var encounterId = await Db.ScalarLongAsync(connection, tx, """
            INSERT INTO patient.encounters(patient_id,encounter_type,status,chief_complaint,opened_at,external_ref)
            VALUES(@p0,'Outpatient','Open',@p1,now(),@p2) RETURNING id
            """, ct, patientId.Value, complaint, extRef);

        var takipNo = $"{DateTime.UtcNow:yyMMdd}{Random.Shared.Next(100000, 999999)}";
        var patientRef = Convert.ToString(rows[0]["patient_ref"], CultureInfo.InvariantCulture)
                         ?? TokenizePatientRef(null, Convert.ToString(pat[0]["mrn"], CultureInfo.InvariantCulture), patientId);

        await Db.ExecuteAsync(connection, tx, """
            INSERT INTO integration.medula_provisions(takip_no,patient_id,encounter_id,patient_ref,sigortali_turu,brans_kodu,provizyon_tipi,katilim_payi,sonuc_kodu,sonuc_mesaji,created_at)
            VALUES(@p0,@p1,@p2,@p3,'4A (SSK Aktif Çalışan)','1000','Normal Muayene',15.00,'0000','MHRS kabul provizyonu onaylandı.',now())
            ON CONFLICT (takip_no) DO NOTHING
            """, ct, takipNo, patientId.Value, encounterId, patientRef);

        await Db.ExecuteAsync(connection, tx, """
            UPDATE integration.mhrs_appointments
            SET status='Admitted', patient_id=@p0, encounter_id=@p1, medula_takip_no=@p2
            WHERE id=@p3
            """, ct, patientId.Value, encounterId, takipNo, id);

        var updatedAppt = await Db.QueryCamelAsync(connection, tx, """
            SELECT id,patient_id,patient_ref,patient_name,polyclinic,doctor,
                   appointment_time,appointment_time AS slot_time,appointment_date,
                   status,encounter_id,medula_takip_no,note,created_at
            FROM integration.mhrs_appointments WHERE id=@p0
            """, ct, id);

        await AuditWriter.AppendAsync(connection, tx, user, "MHRS_APPOINTMENT_ADMITTED", "mhrs-appointment", id,
            new { patient_id = patientId.Value, encounter_id = encounterId, medula_takip_no = takipNo }, ct);
        await OutboxWriter.EnqueueAsync(connection, tx, "MHRS", "MhrsPatientAdmitted", "mhrs", id,
            new { appointment_id = id, encounter_id = encounterId, medula_takip_no = takipNo }, ct);
        await tx.CommitAsync(ct);

        return Results.Ok(new
        {
            ok = true,
            appointmentId = id,
            status = "Admitted",
            patientId = patientId.Value,
            encounterId,
            encounter = new { id = encounterId, patientId = patientId.Value, encounterType = "Outpatient", status = "Open" },
            appointment = updatedAppt.FirstOrDefault(),
            medulaTakipNo = takipNo
        });
    }

    private static async Task<IResult> AdmitUlakAsync(string rawCaseId, long? overridePatientId, NpgsqlDataSource db, ClaimsPrincipal user, CancellationToken ct)
    {
        var id = Required(rawCaseId, "ULAK vaka numarası", 40);
        await using var connection = await db.OpenConnectionAsync(ct);
        await using var tx = await connection.BeginTransactionAsync(ct);

        var rows = await Db.QueryAsync(connection, tx, """
            SELECT id,patient_id,patient_ref,triage_level,incident_summary,status
            FROM integration.ulak_cases WHERE id=@p0 FOR UPDATE
            """, ct, id);
        if (rows.Count == 0) throw new KeyNotFoundException("ULAK 112 vakası bulunamadı.");
        if (string.Equals(Convert.ToString(rows[0]["status"], CultureInfo.InvariantCulture), "InHospital", StringComparison.Ordinal))
            throw new InvalidOperationException("Bu ULAK 112 vakası zaten acil servise kabul edildi.");

        var patientId = overridePatientId
                        ?? (rows[0]["patient_id"] is null ? null : Convert.ToInt64(rows[0]["patient_id"], CultureInfo.InvariantCulture));
        if (patientId is null or <= 0)
            throw new ArgumentException("Acil kabul için eşleştirilmiş hasta ID gereklidir.");

        var pat = await Db.QueryAsync(connection, tx, "SELECT id FROM patient.patients WHERE id=@p0 AND active", ct, patientId.Value);
        if (pat.Count == 0) throw new KeyNotFoundException("Eşleştirilen hasta bulunamadı.");

        var triageLevel = Convert.ToString(rows[0]["triage_level"], CultureInfo.InvariantCulture) ?? "RED";
        var summary = Convert.ToString(rows[0]["incident_summary"], CultureInfo.InvariantCulture) ?? "ULAK 112 acil sevki";
        var complaint = $"{summary} (ULAK 112 {triageLevel})";
        if (complaint.Length > 500) complaint = complaint[..500];

        var encounterId = await Db.ScalarLongAsync(connection, tx, """
            INSERT INTO patient.encounters(patient_id,encounter_type,status,chief_complaint,opened_at,external_ref)
            VALUES(@p0,'Emergency','Open',@p1,now(),@p2) RETURNING id
            """, ct, patientId.Value, complaint, $"ULAK-ADM-{id}");

        var bedRows = await Db.QueryAsync(connection, tx, """
            SELECT bed_no FROM adt.beds
            WHERE status='Available' AND ward IN ('Acil Gözlem','Yoğun Bakım')
            ORDER BY CASE WHEN @p0='RED' AND ward='Acil Gözlem' AND bed_no LIKE 'KIRMIZI%' THEN 0 ELSE 1 END, id
            LIMIT 1
            """, ct, triageLevel);
        var suggestedBed = bedRows.Count > 0 ? Convert.ToString(bedRows[0]["bed_no"], CultureInfo.InvariantCulture) : null;

        await Db.ExecuteAsync(connection, tx, """
            UPDATE integration.ulak_cases
            SET status='InHospital', patient_id=@p0, encounter_id=@p1, eta_minutes=0, arrived_at=now(), bed_assigned=@p2
            WHERE id=@p3
            """, ct, patientId.Value, encounterId, Db.TextOrDbNull(suggestedBed), id);

        var updatedCase = await Db.QueryCamelAsync(connection, tx, """
            SELECT id,patient_id,patient_name,patient_ref,team_code,ambulance_plate,
                   triage_level,triage_level AS priority,triage_level AS triage_code,
                   triage_title,incident_summary,incident_summary AS location,
                   eta_minutes,eta_minutes AS etr_minutes,status,encounter_id,bed_assigned,created_at,arrived_at
            FROM integration.ulak_cases WHERE id=@p0
            """, ct, id);

        await AuditWriter.AppendAsync(connection, tx, user, "ULAK_CASE_ADMITTED", "ulak-case", id,
            new { patient_id = patientId.Value, encounter_id = encounterId, bed_assigned = suggestedBed }, ct);
        await OutboxWriter.EnqueueAsync(connection, tx, "ULAK112", "UlakPatientAdmitted", "emergency", id,
            new { case_id = id, encounter_id = encounterId, bed_assigned = suggestedBed }, ct);
        await tx.CommitAsync(ct);

        return Results.Ok(new
        {
            ok = true,
            caseId = id,
            status = "InHospital",
            patientId = patientId.Value,
            encounterId,
            encounter = new { id = encounterId, patientId = patientId.Value, encounterType = "Emergency", status = "Open" },
            @case = updatedCase.FirstOrDefault(),
            bedAssigned = suggestedBed
        });
    }

    private static async Task<IResult> SendEnabizPackageAsync(EnabizSendRequest request, NpgsqlDataSource db, ClaimsPrincipal user, CancellationToken ct)
    {
        var paketTipi = ParseEnabizPaketTipi(request.PackageType, request.PaketTipi);
        var packageTypeLabel = string.IsNullOrWhiteSpace(request.PackageType)
            ? FormatEnabizPackageType(paketTipi)
            : Optional(request.PackageType, 80) ?? FormatEnabizPackageType(paketTipi);

        await using var connection = await db.OpenConnectionAsync(ct);
        await using var tx = await connection.BeginTransactionAsync(ct);

        long? patientId = request.PatientId;
        string? mrnRef = null;
        if (request.EncounterId is > 0)
        {
            var enc = await Db.QueryAsync(connection, tx, "SELECT patient_id FROM patient.encounters WHERE id=@p0", ct, request.EncounterId.Value);
            if (enc.Count == 0) throw new KeyNotFoundException("Başvuru bulunamadı.");
            patientId ??= Convert.ToInt64(enc[0]["patient_id"], CultureInfo.InvariantCulture);
        }

        if (patientId is > 0)
        {
            var pat = await Db.QueryAsync(connection, tx, "SELECT mrn FROM patient.patients WHERE id=@p0 AND active", ct, patientId.Value);
            if (pat.Count == 0) throw new KeyNotFoundException("Hasta bulunamadı.");
            mrnRef = Convert.ToString(pat[0]["mrn"], CultureInfo.InvariantCulture);
        }

        var patientRef = TokenizePatientRef(request.PatientRef, mrnRef, patientId);
        var sysTakipNo = $"SYS-{DateTime.UtcNow:yyyy}-TR-{Guid.NewGuid().ToString("N")[..6].ToUpperInvariant()}";

        var id = await Db.ScalarLongAsync(connection, tx, """
            INSERT INTO integration.enabiz_packages(patient_id,encounter_id,patient_ref,paket_tipi,package_type,sys_takip_no,status,response_code,response_msg,created_at)
            VALUES(@p0,@p1,@p2,@p3,@p4,@p5,'Sent','SYS_0000','Paket e-Nabız / USS sunucusuna iletildi.',now()) RETURNING id
            """, ct, Db.BigintOrDbNull(patientId), Db.BigintOrDbNull(request.EncounterId), patientRef, paketTipi, packageTypeLabel, sysTakipNo);

        await AuditWriter.AppendAsync(connection, tx, user, "ENABIZ_PACKAGE_SENT", "enabiz-package", sysTakipNo,
            new { paket_tipi = paketTipi, package_type = packageTypeLabel, encounter_id = request.EncounterId, patient_ref = patientRef }, ct);
        await OutboxWriter.EnqueueAsync(connection, tx, "ENABIZ", "EnabizPackageSent", "enabiz", sysTakipNo,
            new { id, sys_takip_no = sysTakipNo, paket_tipi = paketTipi, package_type = packageTypeLabel, patient_ref = patientRef, encounter_id = request.EncounterId }, ct);

        var created = await Db.QueryCamelAsync(connection, tx, """
            SELECT id,patient_id,encounter_id,patient_ref,paket_tipi,package_type,sys_takip_no,
                   status,response_code,response_msg,response_msg AS response_message,
                   created_at,created_at AS sent_at
            FROM integration.enabiz_packages WHERE id=@p0
            """, ct, id);
        await tx.CommitAsync(ct);
        return Results.Created($"/api/connectors/enabiz/packages/{id}", created[0]);
    }

    private static async Task<IResult> VerifyItsAsync(ItsVerifyRequest request, NpgsqlDataSource db, ClaimsPrincipal user, CancellationToken ct)
    {
        var rawCode = Optional(string.IsNullOrWhiteSpace(request.Barcode) ? request.Gtin : request.Barcode, 64);
        if (rawCode is null && request.DrugId is null or <= 0)
            throw new ArgumentException("Barkod / GTIN veya ilaç seçimi zorunludur.");

        await using var connection = await db.OpenConnectionAsync(ct);
        await using var tx = await connection.BeginTransactionAsync(ct);

        long? drugId = request.DrugId;
        string? drugName = null;
        string? genericName = null;
        string? utsCode = null;
        int? stockQty = null;
        if (drugId is > 0)
        {
            var drugRows = await Db.QueryAsync(connection, tx,
                "SELECT id,name,generic_name,stock,barcode,uts_code FROM pharmacy.drugs WHERE id=@p0 AND active", ct, drugId.Value);
            if (drugRows.Count == 0) throw new KeyNotFoundException("İlaç bulunamadı.");
            drugName = Convert.ToString(drugRows[0]["name"], CultureInfo.InvariantCulture);
            genericName = Convert.ToString(drugRows[0]["generic_name"], CultureInfo.InvariantCulture);
            stockQty = drugRows[0]["stock"] is null ? null : Convert.ToInt32(drugRows[0]["stock"], CultureInfo.InvariantCulture);
            utsCode = Convert.ToString(drugRows[0]["uts_code"], CultureInfo.InvariantCulture);
            rawCode ??= Convert.ToString(drugRows[0]["barcode"], CultureInfo.InvariantCulture) ?? utsCode ?? $"DRUG-{drugId.Value}";
        }
        else if (rawCode is not null)
        {
            var drugRows = await Db.QueryAsync(connection, tx,
                "SELECT id,name,generic_name,stock,uts_code FROM pharmacy.drugs WHERE (barcode=@p0 OR uts_code=@p0 OR code=@p0) AND active LIMIT 1", ct, rawCode);
            if (drugRows.Count > 0)
            {
                drugId = Convert.ToInt64(drugRows[0]["id"], CultureInfo.InvariantCulture);
                drugName = Convert.ToString(drugRows[0]["name"], CultureInfo.InvariantCulture);
                genericName = Convert.ToString(drugRows[0]["generic_name"], CultureInfo.InvariantCulture);
                stockQty = drugRows[0]["stock"] is null ? null : Convert.ToInt32(drugRows[0]["stock"], CultureInfo.InvariantCulture);
                utsCode = Convert.ToString(drugRows[0]["uts_code"], CultureInfo.InvariantCulture);
            }
        }

        var barcode = Required(rawCode, "Barkod / GTIN", 64);
        if (barcode.Length < 4) throw new ArgumentException("Barkod en az 4 karakter olmalıdır.");
        var gtin = Optional(request.Gtin, 32) ?? (barcode.All(char.IsDigit) && barcode.Length >= 8 ? barcode : null);
        var lotNo = Optional(request.LotNo, 60) ?? $"LOT-{DateTime.UtcNow:yyMM}";
        var serialNo = Optional(request.SerialNo, 64) ?? $"SN-{Guid.NewGuid().ToString("N")[..8].ToUpperInvariant()}";
        var status = drugId.HasValue ? "Valid" : "VerifiedExternal";
        var actor = RoleClaims.Username(user);
        var productName = drugName ?? $"İTS Kayıtlı Ürün ({barcode})";
        var itsCode = utsCode ?? $"ITS-{barcode}";
        var expiryDate = DateTime.UtcNow.AddYears(2).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

        var id = await Db.ScalarLongAsync(connection, tx, """
            INSERT INTO integration.its_verifications(barcode,drug_id,gtin,lot_no,serial_no,status,verified_by,verified_at)
            VALUES(@p0,@p1,@p2,@p3,@p4,@p5,@p6,now()) RETURNING id
            """, ct, barcode, Db.BigintOrDbNull(drugId), Db.TextOrDbNull(gtin), lotNo, serialNo, status, actor);

        await AuditWriter.AppendAsync(connection, tx, user, "ITS_BARCODE_VERIFIED", "its-verification", id.ToString(CultureInfo.InvariantCulture),
            new { barcode, drug_id = drugId, status, lot_no = lotNo, serial_no = serialNo }, ct);
        await OutboxWriter.EnqueueAsync(connection, tx, "ITS", "ItsBarcodeVerified", "its", id.ToString(CultureInfo.InvariantCulture),
            new { id, barcode, drug_id = drugId, status }, ct);

        await tx.CommitAsync(ct);
        return Results.Ok(new
        {
            id,
            verified = true,
            valid = true,
            barcode,
            drugId,
            drugName,
            productName,
            genericName = genericName ?? "-",
            stockQty,
            utsCode,
            itsCode,
            gtin,
            lotNo,
            serialNo,
            serialNumber = serialNo,
            expiryDate,
            status,
            verifiedBy = actor,
            verifiedAt = DateTimeOffset.UtcNow
        });
    }

    private static int ParseEnabizPaketTipi(string? packageType, int? explicitTipi)
    {
        if (explicitTipi is > 0 and <= 9999 && string.IsNullOrWhiteSpace(packageType))
            return explicitTipi.Value;

        if (!string.IsNullOrWhiteSpace(packageType))
        {
            var digits = new string(packageType.Where(char.IsDigit).ToArray());
            if (int.TryParse(digits, NumberStyles.None, CultureInfo.InvariantCulture, out var parsed) && parsed is > 0 and <= 9999)
                return parsed;
            if (packageType.Contains("Muayene", StringComparison.OrdinalIgnoreCase)) return 103;
            if (packageType.Contains("Tetkik", StringComparison.OrdinalIgnoreCase) || packageType.Contains("Lab", StringComparison.OrdinalIgnoreCase)) return 105;
            if (packageType.Contains("Yatis", StringComparison.OrdinalIgnoreCase) || packageType.Contains("Yatış", StringComparison.OrdinalIgnoreCase)) return 201;
            if (packageType.Contains("Asi", StringComparison.OrdinalIgnoreCase) || packageType.Contains("Aşı", StringComparison.OrdinalIgnoreCase)) return 207;
            if (packageType.Contains("Hasta", StringComparison.OrdinalIgnoreCase)) return 101;
        }

        if (explicitTipi is > 0 and <= 9999)
            return explicitTipi.Value;
        throw new ArgumentException("Geçersiz e-Nabız paket tipi.");
    }

    private static string FormatEnabizPackageType(int paketTipi) => paketTipi switch
    {
        101 => "Paket101_HastaKayit",
        103 => "Paket103_MuayeneBilgisi",
        105 => "Paket105_TetkikSonuc",
        201 => "Paket201_YatisBilgisi",
        207 => "Paket207_AsiBildirim",
        _ => $"Paket{paketTipi}_USS"
    };

    private static string TokenizePatientRef(string? candidate, string? mrn, long? patientId)
    {
        var clean = Optional(candidate, 40);
        if (clean is not null)
        {
            // Never store raw 11-digit TCKN in integration operational tables.
            var digitsOnly = clean.All(char.IsDigit);
            if (digitsOnly && clean.Length == 11)
                return $"TCKN-***{clean[^4..]}";
            return clean;
        }
        if (!string.IsNullOrWhiteSpace(mrn))
            return $"TR-REF-{mrn.Trim()}";
        if (patientId is > 0)
            return $"TR-REF-P{patientId.Value}";
        return $"TR-REF-ANON-{Guid.NewGuid().ToString("N")[..6].ToUpperInvariant()}";
    }

    private static object ParseJsonOrEmpty(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return new { };
        try { return JsonSerializer.Deserialize<JsonElement>(json); }
        catch (JsonException) { return new { }; }
    }

    private static string Required(string? value, string name, int max)
    {
        var text = value?.Trim() ?? "";
        if (text.Length == 0 || text.Length > max) throw new ArgumentException($"{name} zorunludur (en fazla {max} karakter).");
        return text;
    }

    private static string? Optional(string? value, int max)
    {
        var text = value?.Trim() ?? "";
        if (text.Length > max) throw new ArgumentException($"Alan en fazla {max} karakter olabilir.");
        return text.Length == 0 ? null : text;
    }
}

public sealed record MhrsBookRequest(
    long? PatientId = null,
    string? PatientRef = null,
    string? PatientName = null,
    string? Polyclinic = null,
    string? Doctor = null,
    string? AppointmentTime = null,
    string? SlotTime = null,
    string? AppointmentDate = null,
    string? Note = null);

public sealed record MhrsAdmitRequest(string? AppointmentId = null, string? Id = null, long? PatientId = null);

public sealed record UlakCreateRequest(
    long? PatientId = null,
    string? PatientName = null,
    string? PatientRef = null,
    string? TeamCode = null,
    string? AmbulancePlate = null,
    string? TriageLevel = null,
    string? Priority = null,
    string? EmergencyLevel = null,
    string? TriageCode = null,
    string? TriageTitle = null,
    string? IncidentSummary = null,
    string? ChiefComplaint = null,
    string? Location = null,
    string? IncidentLocation = null,
    string? Bp = null,
    int? Pulse = null,
    int? Spo2 = null,
    int? Gcs = null,
    int? EtaMinutes = null,
    int? EtrMinutes = null);

public sealed record UlakAdmitRequest(string? CaseId = null, string? Id = null, long? PatientId = null);

public sealed record MedulaProvisionRequest(
    long? PatientId = null,
    long? EncounterId = null,
    string? PatientRef = null,
    string? Tckn = null,
    string? SigortaliTuru = null,
    string? BransKodu = null,
    string? ProvizyonTipi = null);

public sealed record EnabizSendRequest(
    long? PatientId = null,
    long? EncounterId = null,
    string? PatientRef = null,
    int? PaketTipi = null,
    string? PackageType = null);

public sealed record ItsVerifyRequest(
    string? Barcode = null,
    string? Gtin = null,
    string? LotNo = null,
    string? SerialNo = null,
    long? DrugId = null);
