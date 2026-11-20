using System.Globalization;
using System.Security.Claims;
using Hbys.BuildingBlocks.Audit;
using Hbys.BuildingBlocks.Database;
using Hbys.BuildingBlocks.Messaging;
using Hbys.BuildingBlocks.Security;
using Npgsql;

public static class PublicHealthEndpoints
{
    public static void Map(WebApplication app)
    {
        var api = app.MapGroup("/api").RequireAuthorization();

        api.MapGet("/vaccinations", async (NpgsqlDataSource db, CancellationToken ct) =>
        {
            var rows = await Db.QueryCamelAsync(db, """
                SELECT v.id,v.patient_id,v.vaccine_code,v.vaccine_name,v.dose_no,v.lot_no,v.administered_at,v.administered_by,
                       p.mrn,p.given_name,p.family_name,(p.given_name || ' ' || p.family_name) AS patient_name
                FROM publichealth.vaccinations v
                JOIN patient.patients p ON p.id=v.patient_id
                ORDER BY v.id DESC LIMIT 100
                """, ct);
            return Results.Ok(rows);
        }).RequireAuthorization(p => p.RequireRole("admin", "doctor", "nurse", "registrar"));

        api.MapPost("/vaccinations", async (VaccinationCreateRequest request, NpgsqlDataSource db, ClaimsPrincipal user, CancellationToken ct) =>
        {
            if (request.PatientId <= 0) throw new ArgumentException("Hasta seçilmelidir.");
            if (request.DoseNo <= 0 || request.DoseNo > 20) throw new ArgumentException("Doz numarası 1-20 arasında olmalıdır.");
            var code = Required(request.VaccineCode, "Aşı kodu", 50);
            var name = Required(request.VaccineName, "Aşı adı", 120);
            var lot = Optional(request.LotNo, 60);
            DateTimeOffset administeredAt;
            DateOnly administeredDate;
            if (string.IsNullOrWhiteSpace(request.AdministeredAt))
            {
                administeredAt = DateTimeOffset.UtcNow;
                administeredDate = DateOnly.FromDateTime(administeredAt.UtcDateTime);
            }
            else
            {
                var datePart = request.AdministeredAt.Length >= 10 ? request.AdministeredAt[..10] : request.AdministeredAt;
                if (!DateOnly.TryParseExact(datePart, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out administeredDate)
                    || !DateTimeOffset.TryParse(request.AdministeredAt, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var parsed))
                    throw new ArgumentException("Uygulama tarihi ISO-8601 biçiminde olmalıdır.");
                administeredAt = parsed.ToUniversalTime();
            }
            if (administeredAt > DateTimeOffset.UtcNow.AddMinutes(5)) throw new ArgumentException("Uygulama tarihi gelecekte olamaz.");

            await using var connection = await db.OpenConnectionAsync(ct);
            await using var tx = await connection.BeginTransactionAsync(ct);
            var patient = await Db.QueryAsync(connection, tx, "SELECT id,mrn,birth_date FROM patient.patients WHERE id=@p0 AND active", ct, request.PatientId);
            if (patient.Count == 0) throw new KeyNotFoundException("Hasta bulunamadı.");
            var birthDate = (DateOnly)patient[0]["birth_date"]!;
            if (administeredDate < birthDate)
                throw new ArgumentException("Aşı uygulama tarihi hastanın doğum tarihinden önce olamaz.");

            var administeredBy = RoleClaims.DisplayName(user);
            var id = await Db.ScalarLongAsync(connection, tx, """
                INSERT INTO publichealth.vaccinations(patient_id,vaccine_code,vaccine_name,dose_no,lot_no,administered_at,administered_by)
                VALUES(@p0,@p1,@p2,@p3,@p4,@p5,@p6) RETURNING id
                """, ct, request.PatientId, code, name, request.DoseNo, Db.TextOrDbNull(lot), administeredAt, administeredBy);

            await AuditWriter.AppendAsync(connection, tx, user, "VACCINATION_RECORDED", "vaccination", id.ToString(CultureInfo.InvariantCulture),
                new { patient_id = request.PatientId, vaccine_code = code, dose_no = request.DoseNo }, ct);
            await OutboxWriter.EnqueueAsync(connection, tx, "ENABIZ", "VaccinationRecorded", "vaccination",
                id.ToString(CultureInfo.InvariantCulture),
                new { vaccination_id = id, patient_id = request.PatientId, mrn = patient[0]["mrn"], vaccine_code = code, dose_no = request.DoseNo }, ct);
            await tx.CommitAsync(ct);

            return Results.Created($"/api/vaccinations/{id}", new
            {
                id,
                patientId = request.PatientId,
                vaccineCode = code,
                vaccineName = name,
                doseNo = request.DoseNo,
                lotNo = lot,
                administeredAt,
                administeredBy
            });
        }).RequireAuthorization(p => p.RequireRole("admin", "doctor", "nurse"));
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

public sealed record VaccinationCreateRequest(long PatientId, string VaccineCode, string VaccineName, int DoseNo, string? LotNo, string? AdministeredAt = null);
