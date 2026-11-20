using System.Globalization;
using System.Security.Claims;
using System.Security.Cryptography;
using Hbys.BuildingBlocks.Audit;
using Hbys.BuildingBlocks.Database;
using Hbys.BuildingBlocks.Domain;
using Hbys.BuildingBlocks.Messaging;
using Hbys.BuildingBlocks.Security;
using Npgsql;

public static class PatientEndpoints
{
    public static void Map(WebApplication app)
    {
        // Anonymous bootstrap configuration discovery per UNIFIED-CONTRACT §1
        app.MapGet("/api/config", (IConfiguration config) =>
        {
            var mode = (config["HBYS_MODE"] ?? "enterprise").Trim().ToLowerInvariant();
            var auth = (config["HBYS_AUTH"] ?? (mode == "demo" ? "demo" : "oidc")).Trim().ToLowerInvariant();
            var issuer = config["OIDC_ISSUER"]
                ?? config["Keycloak:ValidIssuer"]
                ?? "http://localhost:8080/realms/hbys";
            var clientId = config["OIDC_CLIENT_ID"] ?? "hbys-web";
            var simulation = string.Equals(config["HBYS_ENABLE_SIMULATION"], "true", StringComparison.OrdinalIgnoreCase);

            return Results.Ok(new
            {
                mode,
                auth,
                oidc = auth == "oidc"
                    ? new { issuer, clientId, redirectUri = "/" }
                    : null,
                features = new
                {
                    connectors = true,
                    simulation,
                    patient360 = true,
                    cdsAllergy = true,
                    criticalAck = true,
                    vitalsNews2 = true,
                    dicomViewer = true,
                    hl7Sandbox = true
                }
            });
        }).AllowAnonymous();

        var api = app.MapGroup("/api").RequireAuthorization();

        api.MapGet("/me", (ClaimsPrincipal user) =>
        {
            var role = RoleClaims.PrimaryRole(user);
            return Results.Ok(new
            {
                user = new
                {
                    id = user.FindFirst("sub")?.Value ?? "",
                    username = RoleClaims.Username(user),
                    displayName = RoleClaims.DisplayName(user),
                    role,
                    roles = user.FindAll("roles").Select(x => x.Value).OrderBy(x => x).ToArray()
                },
                roleLabel = RoleClaims.TurkishLabel(role)
            });
        });

        api.MapGet("/dashboard", async (NpgsqlDataSource db, ClaimsPrincipal user, CancellationToken ct) =>
        {
            var counts = await Db.QueryAsync(db, """
                SELECT
                  (SELECT count(*) FROM patient.patients WHERE active) AS patients,
                  (SELECT count(*) FROM patient.encounters WHERE status IN ('Open','Admitted')) AS open_encounters,
                  (SELECT count(*) FROM clinical.orders WHERE created_at::date = CURRENT_DATE) AS orders_today,
                  (SELECT count(*) FROM clinical.lab_results WHERE (critical OR critical_flag) AND resulted_at::date = CURRENT_DATE) AS critical_results,
                  (SELECT count(*) FROM adt.beds WHERE status='Occupied') AS occupied_beds,
                  (SELECT count(*) FROM adt.beds WHERE status='Available') AS available_beds,
                  (SELECT count(*) FROM pharmacy.prescriptions WHERE status='Pending') AS pending_prescriptions,
                  (SELECT count(*) FROM integration.outbox WHERE status IN ('Pending','Failed')) AS pending_integrations
                """, ct);
            var role = RoleClaims.PrimaryRole(user);
            var recent = role is "admin" or "doctor" or "nurse" or "registrar"
                ? await Db.QueryCamelAsync(db, """
                    SELECT e.id,e.patient_id,e.encounter_type,e.status,e.chief_complaint,e.opened_at,
                           p.mrn,p.given_name,p.family_name,(p.given_name || ' ' || p.family_name) AS patient_name
                    FROM patient.encounters e JOIN patient.patients p ON p.id=e.patient_id
                    ORDER BY e.id DESC LIMIT 6
                    """, ct)
                : new List<Dictionary<string, object?>>();
            return Results.Ok(new
            {
                patients = counts[0]["patients"],
                openEncounters = counts[0]["open_encounters"],
                ordersToday = counts[0]["orders_today"],
                criticalResults = counts[0]["critical_results"],
                occupiedBeds = counts[0]["occupied_beds"],
                availableBeds = counts[0]["available_beds"],
                pendingPrescriptions = counts[0]["pending_prescriptions"],
                pendingIntegrations = counts[0]["pending_integrations"],
                recentEncounters = recent
            });
        });

        api.MapGet("/search", async (NpgsqlDataSource db, ClaimsPrincipal user, string? q, CancellationToken ct) =>
        {
            var query = (q ?? "").Trim();
            if (query.Length > 100) throw new ArgumentException("Arama metni en fazla 100 karakter olabilir.");
            if (query.Length == 0) return Results.Ok(new { query = "", items = Array.Empty<object>() });

            var role = RoleClaims.PrimaryRole(user);
            var pattern = $"%{query}%";
            var items = new List<object>();

            if (role is "admin" or "doctor" or "nurse" or "registrar")
            {
                var patients = await Db.QueryAsync(db, """
                    SELECT id,mrn,given_name,family_name,blood_type
                    FROM patient.patients
                    WHERE active AND (mrn ILIKE @p0 OR given_name ILIKE @p0 OR family_name ILIKE @p0)
                    ORDER BY family_name,given_name LIMIT 6
                    """, ct, pattern);
                foreach (var p in patients)
                {
                    items.Add(new
                    {
                        type = "patient",
                        id = p["id"],
                        title = $"{p["given_name"]} {p["family_name"]}",
                        subtitle = $"MRN: {p["mrn"]} · Kan: {p["blood_type"] ?? "—"}",
                        page = "patients",
                        patientId = p["id"],
                        encounterId = (long?)null
                    });
                }
            }

            if (role is "admin" or "doctor" or "nurse" or "registrar" or "billing")
            {
                var encounters = await Db.QueryAsync(db, """
                    SELECT e.id,e.patient_id,e.encounter_type,e.status,p.mrn,p.given_name,p.family_name
                    FROM patient.encounters e JOIN patient.patients p ON p.id=e.patient_id
                    WHERE p.mrn ILIKE @p0 OR p.given_name ILIKE @p0 OR p.family_name ILIKE @p0 OR e.chief_complaint ILIKE @p0
                    ORDER BY e.id DESC LIMIT 6
                    """, ct, pattern);
                foreach (var e in encounters)
                {
                    items.Add(new
                    {
                        type = "encounter",
                        id = e["id"],
                        title = $"Başvuru #{e["id"]} · {e["given_name"]} {e["family_name"]}",
                        subtitle = $"{e["mrn"]} · {e["encounter_type"]} ({e["status"]})",
                        page = role == "billing" ? "billing" : "patients",
                        patientId = e["patient_id"],
                        encounterId = e["id"]
                    });
                }
            }

            if (role is "admin" or "doctor" or "lab" or "radiology")
            {
                var orders = await Db.QueryAsync(db, """
                    SELECT o.id,o.encounter_id,o.order_type,o.code,o.description,o.status,e.patient_id
                    FROM clinical.orders o
                    JOIN patient.encounters e ON e.id=o.encounter_id
                    WHERE (o.code ILIKE @p0 OR o.description ILIKE @p0)
                      AND (@p1 IN ('admin','doctor') OR (@p1='lab' AND o.order_type='LAB') OR (@p1='radiology' AND o.order_type='RAD'))
                    ORDER BY o.id DESC LIMIT 6
                    """, ct, pattern, role);
                foreach (var o in orders)
                {
                    items.Add(new
                    {
                        type = "order",
                        id = o["id"],
                        title = $"[{o["order_type"]}] {o["description"]}",
                        subtitle = $"Kod: {o["code"]} · Durum: {o["status"]}",
                        page = "clinical",
                        patientId = o["patient_id"],
                        encounterId = o["encounter_id"]
                    });
                }
            }

            if (role is "admin" or "doctor" or "nurse" or "pharmacist")
            {
                var drugs = await Db.QueryAsync(db, """
                    SELECT id,code,name,form,stock
                    FROM pharmacy.drugs
                    WHERE active AND (code ILIKE @p0 OR name ILIKE @p0 OR COALESCE(generic_name,'') ILIKE @p0)
                    ORDER BY name LIMIT 6
                    """, ct, pattern);
                foreach (var d in drugs)
                {
                    items.Add(new
                    {
                        type = "drug",
                        id = d["id"],
                        title = Convert.ToString(d["name"], CultureInfo.InvariantCulture) ?? "",
                        subtitle = $"{d["code"]} · {d["form"]} · Stok: {d["stock"]}",
                        page = "pharmacy",
                        patientId = (long?)null,
                        encounterId = (long?)null
                    });
                }
            }

            if (role is "admin" or "doctor" or "nurse" or "registrar")
            {
                var beds = await Db.QueryAsync(db, """
                    SELECT id,ward,room,bed_no,status,current_encounter_id
                    FROM adt.beds
                    WHERE ward ILIKE @p0 OR room ILIKE @p0 OR bed_no ILIKE @p0
                    ORDER BY ward,bed_no LIMIT 6
                    """, ct, pattern);
                foreach (var b in beds)
                {
                    items.Add(new
                    {
                        type = "bed",
                        id = b["id"],
                        title = $"Yatak {b["bed_no"]} ({b["ward"]})",
                        subtitle = $"Oda {b["room"]} · Durum: {b["status"]}",
                        page = "beds",
                        patientId = (long?)null,
                        encounterId = b["current_encounter_id"]
                    });
                }
            }

            return Results.Ok(new { query, items });
        });

        api.MapGet("/patients", async (NpgsqlDataSource db, string? q, CancellationToken ct) =>
        {
            var search = (q ?? "").Trim();
            if (search.Length > 100) throw new ArgumentException("Arama metni en fazla 100 karakter olabilir.");
            var rows = await Db.QueryCamelAsync(db, """
                SELECT id,mrn,given_name,family_name,(given_name || ' ' || family_name) AS patient_name,
                       birth_date,sex,phone,blood_type,allergies,chronic_conditions,active,created_at
                FROM patient.patients
                WHERE active AND (@p0='' OR mrn ILIKE @p1 OR given_name ILIKE @p1 OR family_name ILIKE @p1)
                ORDER BY family_name,given_name LIMIT 200
                """, ct, search, $"%{search}%");
            return Results.Ok(rows);
        }).RequireAuthorization(p => p.RequireRole("admin", "doctor", "nurse", "registrar"));

        api.MapGet("/patients/{id:long}/chart", async (long id, NpgsqlDataSource db, CancellationToken ct) =>
        {
            if (id <= 0) throw new ArgumentException("Geçersiz hasta numarası.");

            var patients = await Db.QueryCamelAsync(db, """
                SELECT id,mrn,given_name,family_name,(given_name || ' ' || family_name) AS patient_name,
                       birth_date,sex,phone,blood_type,allergies,chronic_conditions,active,created_at
                FROM patient.patients WHERE id=@p0 AND active
                """, ct, id);
            if (patients.Count == 0) throw new KeyNotFoundException("Hasta bulunamadı.");

            var patient = patients[0];
            var encounters = await Db.QueryCamelAsync(db, """
                SELECT id,patient_id,encounter_type,status,chief_complaint,opened_at,closed_at,external_ref
                FROM patient.encounters WHERE patient_id=@p0 ORDER BY id DESC LIMIT 50
                """, ct, id);

            var vitals = await Db.QueryCamelAsync(db, """
                SELECT v.id,v.encounter_id,v.systolic_bp,v.diastolic_bp,v.heart_rate,v.resp_rate,
                       v.temp_c,v.spo2,v.consciousness,v.news2_score,v.news2_risk,v.recorded_by,v.recorded_at
                FROM clinical.vitals v
                JOIN patient.encounters e ON e.id=v.encounter_id
                WHERE e.patient_id=@p0
                ORDER BY v.recorded_at DESC, v.id DESC LIMIT 50
                """, ct, id);

            var clinicalNotes = await Db.QueryCamelAsync(db, """
                SELECT n.id,n.encounter_id,n.author,n.note_type,n.subjective,n.objective,n.assessment,n.plan,n.created_at
                FROM clinical.clinical_notes n
                JOIN patient.encounters e ON e.id=n.encounter_id
                WHERE e.patient_id=@p0
                ORDER BY n.created_at DESC, n.id DESC LIMIT 50
                """, ct, id);

            var orders = await Db.QueryCamelAsync(db, """
                SELECT o.id,o.encounter_id,o.order_type,o.code_system,o.code,o.description,o.ordered_by,
                       o.status,o.priority,o.clinical_note,o.created_at,o.updated_at
                FROM clinical.orders o
                JOIN patient.encounters e ON e.id=o.encounter_id
                WHERE e.patient_id=@p0
                ORDER BY o.id DESC LIMIT 100
                """, ct, id);

            var labResults = await Db.QueryCamelAsync(db, """
                SELECT lr.id,lr.order_id,o.encounter_id,lr.analyte_code,lr.display,lr.value,lr.unit,
                       lr.reference_range,lr.flag,lr.critical,lr.critical_flag,lr.critical_ack_by,
                       lr.critical_ack_at,lr.critical_ack_note,lr.resulted_at
                FROM clinical.lab_results lr
                JOIN clinical.orders o ON o.id=lr.order_id
                JOIN patient.encounters e ON e.id=o.encounter_id
                WHERE e.patient_id=@p0
                ORDER BY lr.id DESC LIMIT 100
                """, ct, id);

            var radiologyReports = await Db.QueryCamelAsync(db, """
                SELECT rr.id,rr.order_id,o.encounter_id,o.code,o.description,rr.modality,
                       rr.report_text,rr.impression,rr.reported_by,rr.reported_at,rr.dicom_series_uid
                FROM clinical.radiology_reports rr
                JOIN clinical.orders o ON o.id=rr.order_id
                JOIN patient.encounters e ON e.id=o.encounter_id
                WHERE e.patient_id=@p0
                ORDER BY rr.id DESC LIMIT 50
                """, ct, id);

            var prescriptions = await Db.QueryCamelAsync(db, """
                SELECT rx.id,rx.encounter_id,rx.prescribed_by,rx.status,rx.allergy_overridden,
                       rx.override_reason,rx.created_at,rx.dispensed_at
                FROM pharmacy.prescriptions rx
                JOIN patient.encounters e ON e.id=rx.encounter_id
                WHERE e.patient_id=@p0
                ORDER BY rx.id DESC LIMIT 50
                """, ct, id);

            var rxItems = await Db.QueryCamelAsync(db, """
                SELECT i.id,i.prescription_id,i.drug_id,d.code AS drug_code,d.name AS drug_name,
                       d.generic_name,d.allergy_group,i.dosage,i.frequency,i.duration_days,i.quantity,i.dispensed_qty,i.usage_instruction
                FROM pharmacy.prescription_items i
                JOIN pharmacy.prescriptions rx ON rx.id=i.prescription_id
                JOIN patient.encounters e ON e.id=rx.encounter_id
                JOIN pharmacy.drugs d ON d.id=i.drug_id
                WHERE e.patient_id=@p0
                ORDER BY i.id ASC
                """, ct, id);

            var itemsByRx = rxItems.GroupBy(x => Convert.ToInt64(x["prescriptionId"], CultureInfo.InvariantCulture))
                .ToDictionary(g => g.Key, g => g.ToList());
            foreach (var rx in prescriptions)
            {
                var rxId = Convert.ToInt64(rx["id"], CultureInfo.InvariantCulture);
                rx["items"] = itemsByRx.TryGetValue(rxId, out var list) ? list : new List<Dictionary<string, object?>>();
            }

            var activeAdmissions = await Db.QueryCamelAsync(db, """
                SELECT a.id,a.encounter_id,a.bed_id,a.admitted_at,a.status,b.ward,b.room,b.bed_no
                FROM adt.admissions a
                JOIN adt.beds b ON b.id=a.bed_id
                JOIN patient.encounters e ON e.id=a.encounter_id
                WHERE e.patient_id=@p0 AND a.status='Admitted'
                ORDER BY a.id DESC LIMIT 1
                """, ct, id);

            return Results.Ok(new
            {
                patient,
                allergies = patient["allergies"] ?? "Yok",
                encounters,
                vitals,
                clinicalNotes,
                orders,
                labResults,
                radiologyReports,
                prescriptions,
                activeAdmission = activeAdmissions.FirstOrDefault()
            });
        }).RequireAuthorization(p => p.RequireRole("admin", "doctor", "nurse", "registrar"));

        api.MapPost("/patients", async (PatientCreateRequest request, NpgsqlDataSource db, ClaimsPrincipal user, CancellationToken ct) =>
        {
            var given = Required(request.GivenName, "Ad", 100);
            var family = Required(request.FamilyName, "Soyad", 100);
            if (!DateOnly.TryParseExact(request.BirthDate, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var birth)
                || birth.Year < 1900 || birth > DateOnly.FromDateTime(DateTime.UtcNow))
                throw new ArgumentException("Doğum tarihi 1900 ile bugün arasında YYYY-AA-GG biçiminde olmalıdır.");
            if (request.Sex is not ("F" or "M" or "U")) throw new ArgumentException("Cinsiyet F, M veya U olmalıdır.");
            var phone = Optional(request.Phone, "Telefon", 40);
            var blood = Optional(request.BloodType, "Kan grubu", 3);
            if (blood is not null && blood is not ("A+" or "A-" or "B+" or "B-" or "AB+" or "AB-" or "0+" or "0-"))
                throw new ArgumentException("Geçersiz kan grubu.");
            var allergies = Optional(request.Allergies, "Alerjiler", 500);
            var chronic = Optional(request.ChronicConditions, "Kronik hastalıklar", 500);

            var mrn = "HB-" + Convert.ToHexString(RandomNumberGenerator.GetBytes(8));
            await using var connection = await db.OpenConnectionAsync(ct);
            await using var tx = await connection.BeginTransactionAsync(ct);
            var id = await Db.ScalarLongAsync(connection, tx, """
                INSERT INTO patient.patients(mrn,given_name,family_name,birth_date,sex,phone,blood_type,allergies,chronic_conditions,active,created_at)
                VALUES(@p0,@p1,@p2,@p3,@p4,@p5,@p6,@p7,@p8,true,now()) RETURNING id
                """, ct, mrn, given, family, birth, request.Sex, Db.TextOrDbNull(phone), Db.TextOrDbNull(blood),
                Db.TextOrDbNull(allergies), Db.TextOrDbNull(chronic));
            await AuditWriter.AppendAsync(connection, tx, user, "PATIENT_REGISTERED", "patient", id.ToString(CultureInfo.InvariantCulture), new { mrn }, ct);
            await OutboxWriter.EnqueueAsync(connection, tx, "USS / e-Nabız", "PatientRegistered", "patient", id.ToString(CultureInfo.InvariantCulture), new { id, mrn }, ct);
            await tx.CommitAsync(ct);
            return Results.Created($"/api/patients/{id}", new { id, mrn });
        }).RequireAuthorization(p => p.RequireRole("admin", "doctor", "registrar"));

        api.MapGet("/encounters", async (NpgsqlDataSource db, long? patientId, long? patient_id, CancellationToken ct) =>
        {
            var filterPatientId = patientId ?? patient_id;
            var rows = await Db.QueryCamelAsync(db, """
                SELECT e.id,e.patient_id,e.encounter_type,e.status,e.chief_complaint,e.opened_at,
                       p.mrn,p.given_name,p.family_name,(p.given_name || ' ' || p.family_name) AS patient_name
                FROM patient.encounters e JOIN patient.patients p ON p.id=e.patient_id
                WHERE (@p0::bigint IS NULL OR e.patient_id=@p0)
                ORDER BY e.id DESC LIMIT 200
                """, ct, Db.BigintOrDbNull(filterPatientId));
            return Results.Ok(rows);
        }).RequireAuthorization(p => p.RequireRole("admin", "doctor", "nurse", "billing", "registrar"));

        api.MapPost("/encounters", async (EncounterCreateRequest request, NpgsqlDataSource db, ClaimsPrincipal user, CancellationToken ct) =>
        {
            if (request.PatientId <= 0) throw new ArgumentException("Geçerli hasta seçilmelidir.");
            if (request.EncounterType is not ("Outpatient" or "Emergency" or "Inpatient"))
                throw new ArgumentException("Geçersiz başvuru türü.");
            var complaint = Optional(request.ChiefComplaint, "Başvuru nedeni", 500);
            await using var connection = await db.OpenConnectionAsync(ct);
            await using var tx = await connection.BeginTransactionAsync(ct);
            var exists = await Db.ScalarLongAsync(connection, tx,
                "SELECT count(*) FROM patient.patients WHERE id=@p0 AND active", ct, request.PatientId);
            if (exists == 0) throw new KeyNotFoundException("Hasta bulunamadı.");
            var id = await Db.ScalarLongAsync(connection, tx, """
                INSERT INTO patient.encounters(patient_id,encounter_type,status,chief_complaint,opened_at)
                VALUES(@p0,@p1,'Open',@p2,now()) RETURNING id
                """, ct, request.PatientId, request.EncounterType, Db.TextOrDbNull(complaint));
            await AuditWriter.AppendAsync(connection, tx, user, "ENCOUNTER_OPENED", "encounter", id.ToString(CultureInfo.InvariantCulture),
                new { patient_id = request.PatientId, request.EncounterType }, ct);
            await OutboxWriter.EnqueueAsync(connection, tx, "USS / e-Nabız", "EncounterOpened", "encounter", id.ToString(CultureInfo.InvariantCulture),
                new { encounter_id = id, patient_id = request.PatientId, request.EncounterType }, ct);
            await tx.CommitAsync(ct);
            return Results.Created($"/api/encounters/{id}", new { id, status = "Open" });
        }).RequireAuthorization(p => p.RequireRole("admin", "doctor", "nurse", "registrar"));

        api.MapGet("/encounters/{id:long}/vitals", async (long id, NpgsqlDataSource db, CancellationToken ct) =>
        {
            if (id <= 0) throw new ArgumentException("Geçersiz başvuru numarası.");
            await using var conn = await db.OpenConnectionAsync(ct);
            var exists = await Db.ScalarLongAsync(conn, null, "SELECT count(*) FROM patient.encounters WHERE id=@p0", ct, id);
            if (exists == 0) throw new KeyNotFoundException("Başvuru bulunamadı.");

            var rows = await Db.QueryCamelAsync(conn, null, """
                SELECT id,encounter_id,systolic_bp,diastolic_bp,heart_rate,resp_rate,temp_c,spo2,
                       consciousness,news2_score,news2_risk,recorded_by,recorded_at
                FROM clinical.vitals
                WHERE encounter_id=@p0
                ORDER BY recorded_at DESC, id DESC LIMIT 100
                """, ct, id);
            return Results.Ok(rows);
        }).RequireAuthorization(p => p.RequireRole("admin", "doctor", "nurse"));

        api.MapPost("/encounters/{id:long}/vitals", async (long id, VitalsCreateRequest request, NpgsqlDataSource db, ClaimsPrincipal user, CancellationToken ct) =>
        {
            if (id <= 0) throw new ArgumentException("Geçersiz başvuru numarası.");
            var avpuStr = (request.Consciousness ?? "A").Trim();
            if (avpuStr.Length != 1) throw new ArgumentException("Bilinç durumu (consciousness) A, V, P veya U olmalıdır.");
            var avpu = char.ToUpperInvariant(avpuStr[0]);

            var news2 = News2Calculator.Calculate(
                request.SystolicBp,
                request.DiastolicBp,
                request.HeartRate,
                request.RespRate,
                request.TempC,
                request.Spo2,
                avpu);

            var recordedBy = RoleClaims.DisplayName(user);
            await using var connection = await db.OpenConnectionAsync(ct);
            await using var tx = await connection.BeginTransactionAsync(ct);
            var exists = await Db.ScalarLongAsync(connection, tx, "SELECT count(*) FROM patient.encounters WHERE id=@p0", ct, id);
            if (exists == 0) throw new KeyNotFoundException("Başvuru bulunamadı.");

            var inserted = await Db.QueryCamelAsync(connection, tx, """
                INSERT INTO clinical.vitals(
                    encounter_id,systolic_bp,diastolic_bp,heart_rate,resp_rate,temp_c,spo2,
                    consciousness,news2_score,news2_risk,recorded_by,recorded_at)
                VALUES(@p0,@p1,@p2,@p3,@p4,@p5,@p6,@p7,@p8,@p9,@p10,now())
                RETURNING id,encounter_id,systolic_bp,diastolic_bp,heart_rate,resp_rate,temp_c,spo2,
                          consciousness,news2_score,news2_risk,recorded_by,recorded_at
                """, ct, id, request.SystolicBp, request.DiastolicBp, request.HeartRate, request.RespRate,
                decimal.Round(request.TempC, 1, MidpointRounding.AwayFromZero), request.Spo2,
                avpu.ToString(), news2.Score, news2.Risk, recordedBy);

            var vitalId = Convert.ToInt64(inserted[0]["id"], CultureInfo.InvariantCulture);
            await AuditWriter.AppendAsync(connection, tx, user, "VITALS_RECORDED", "vital", vitalId.ToString(CultureInfo.InvariantCulture),
                new { encounter_id = id, news2_score = news2.Score, news2_risk = news2.Risk }, ct);
            await tx.CommitAsync(ct);

            return Results.Created($"/api/encounters/{id}/vitals/{vitalId}", inserted[0]);
        }).RequireAuthorization(p => p.RequireRole("admin", "doctor", "nurse"));

        api.MapGet("/encounters/{id:long}/notes", async (long id, NpgsqlDataSource db, CancellationToken ct) =>
        {
            if (id <= 0) throw new ArgumentException("Geçersiz başvuru numarası.");
            await using var conn = await db.OpenConnectionAsync(ct);
            var exists = await Db.ScalarLongAsync(conn, null, "SELECT count(*) FROM patient.encounters WHERE id=@p0", ct, id);
            if (exists == 0) throw new KeyNotFoundException("Başvuru bulunamadı.");

            var rows = await Db.QueryCamelAsync(conn, null, """
                SELECT id,encounter_id,author,note_type,subjective,objective,assessment,plan,created_at
                FROM clinical.clinical_notes
                WHERE encounter_id=@p0
                ORDER BY created_at DESC, id DESC LIMIT 100
                """, ct, id);
            return Results.Ok(rows);
        }).RequireAuthorization(p => p.RequireRole("admin", "doctor", "nurse"));

        api.MapPost("/encounters/{id:long}/notes", async (long id, ClinicalNoteCreateRequest request, NpgsqlDataSource db, ClaimsPrincipal user, CancellationToken ct) =>
        {
            if (id <= 0) throw new ArgumentException("Geçersiz başvuru numarası.");
            var noteType = (request.NoteType ?? "SOAP").Trim().ToUpperInvariant();
            if (noteType is not ("SOAP" or "PROGRESS" or "DISCHARGE" or "TRIAGE" or "CONSULT"))
                throw new ArgumentException("Geçersiz klinik not türü.");

            var subjective = Optional(request.Subjective, "Subjektif (S)", 4000) ?? "";
            var objective = Optional(request.Objective, "Objektif (O)", 4000) ?? "";
            var assessment = Optional(request.Assessment, "Değerlendirme (A)", 4000) ?? "";
            var plan = Optional(request.Plan, "Plan (P)", 4000) ?? "";
            if (subjective.Length == 0 && objective.Length == 0 && assessment.Length == 0 && plan.Length == 0)
                throw new ArgumentException("SOAP notu için en az bir alan doldurulmalıdır.");

            var author = RoleClaims.DisplayName(user);
            await using var connection = await db.OpenConnectionAsync(ct);
            await using var tx = await connection.BeginTransactionAsync(ct);
            var exists = await Db.ScalarLongAsync(connection, tx, "SELECT count(*) FROM patient.encounters WHERE id=@p0", ct, id);
            if (exists == 0) throw new KeyNotFoundException("Başvuru bulunamadı.");

            var inserted = await Db.QueryCamelAsync(connection, tx, """
                INSERT INTO clinical.clinical_notes(encounter_id,author,note_type,subjective,objective,assessment,plan,created_at)
                VALUES(@p0,@p1,@p2,@p3,@p4,@p5,@p6,now())
                RETURNING id,encounter_id,author,note_type,subjective,objective,assessment,plan,created_at
                """, ct, id, author, noteType, subjective, objective, assessment, plan);

            var noteId = Convert.ToInt64(inserted[0]["id"], CultureInfo.InvariantCulture);
            await AuditWriter.AppendAsync(connection, tx, user, "CLINICAL_NOTE_RECORDED", "clinical-note", noteId.ToString(CultureInfo.InvariantCulture),
                new { encounter_id = id, note_type = noteType }, ct);
            await tx.CommitAsync(ct);

            return Results.Created($"/api/encounters/{id}/notes/{noteId}", inserted[0]);
        }).RequireAuthorization(p => p.RequireRole("admin", "doctor", "nurse"));
    }

    private static string Required(string? value, string label, int max)
    {
        var text = value?.Trim() ?? "";
        if (text.Length == 0 || text.Length > max) throw new ArgumentException($"{label} zorunludur ve en fazla {max} karakter olabilir.");
        return text;
    }

    private static string? Optional(string? value, string label, int max)
    {
        var text = value?.Trim() ?? "";
        if (text.Length > max) throw new ArgumentException($"{label} en fazla {max} karakter olabilir.");
        return text.Length == 0 ? null : text;
    }
}

public sealed record PatientCreateRequest(
    string GivenName,
    string FamilyName,
    string BirthDate,
    string Sex,
    string? Phone = null,
    string? BloodType = null,
    string? Allergies = null,
    string? ChronicConditions = null);

public sealed record EncounterCreateRequest(long PatientId, string EncounterType, string? ChiefComplaint = null);

public sealed record VitalsCreateRequest(
    int SystolicBp,
    int DiastolicBp,
    int HeartRate,
    int RespRate,
    decimal TempC,
    int Spo2,
    string Consciousness = "A");

public sealed record ClinicalNoteCreateRequest(
    string? NoteType = "SOAP",
    string? Subjective = null,
    string? Objective = null,
    string? Assessment = null,
    string? Plan = null);
