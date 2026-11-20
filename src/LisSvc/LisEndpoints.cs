using System.Globalization;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Hbys.BuildingBlocks.Audit;
using Hbys.BuildingBlocks.Database;
using Hbys.BuildingBlocks.Domain;
using Hbys.BuildingBlocks.Hl7;
using Hbys.BuildingBlocks.Messaging;
using Npgsql;

public static class LisEndpoints
{
    public static void Map(WebApplication app)
    {
        var api = app.MapGroup("/api").RequireAuthorization();

        api.MapGet("/lis/inbox", async (NpgsqlDataSource db, CancellationToken ct) =>
        {
            var rows = await Db.QueryCamelAsync(db, """
                SELECT id,message_control_id,source_system,status,received_at,processed_at,last_error
                FROM lis.inbox_messages ORDER BY id DESC LIMIT 200
                """, ct);
            return Results.Ok(rows);
        }).RequireAuthorization(p => p.RequireRole("admin", "lab", "integration"));

        api.MapPost("/hl7/oru", async (HttpRequest httpRequest, NpgsqlDataSource db, ClaimsPrincipal user, CancellationToken ct) =>
        {
            var (rawMessage, sourceSystemInput) = await ReadHl7BodyAsync(httpRequest, ct);
            var message = Hl7OruParser.Parse(rawMessage);
            var sourceSystem = Optional(sourceSystemInput, 80)
                               ?? (string.IsNullOrWhiteSpace(message.SendingApplication)
                                   ? "HL7"
                                   : message.SendingApplication[..Math.Min(80, message.SendingApplication.Length)]);

            await using var connection = await db.OpenConnectionAsync(ct);
            await using var tx = await connection.BeginTransactionAsync(ct);
            var inbox = await Db.QueryAsync(connection, tx, """
                INSERT INTO lis.inbox_messages(message_control_id,source_system,payload,status,received_at)
                VALUES(@p0,@p1,@p2,'Received',now())
                ON CONFLICT (source_system, message_control_id) DO NOTHING
                RETURNING id
                """, ct, message.MessageControlId, sourceSystem, rawMessage);

            if (inbox.Count == 0)
            {
                var existing = await Db.QueryAsync(connection, tx, """
                    SELECT status,last_error,payload FROM lis.inbox_messages
                    WHERE source_system=@p0 AND message_control_id=@p1
                    """, ct, sourceSystem, message.MessageControlId);
                if (existing.Count == 0) throw new InvalidOperationException("Yinelenen HL7 kaydı bulunamadı.");

                var priorPayload = Convert.ToString(existing[0]["payload"], CultureInfo.InvariantCulture) ?? "";
                var sameContent = CryptographicOperations.FixedTimeEquals(
                    SHA256.HashData(Encoding.UTF8.GetBytes(priorPayload)),
                    SHA256.HashData(Encoding.UTF8.GetBytes(rawMessage)));
                var priorStatus = Convert.ToString(existing[0]["status"], CultureInfo.InvariantCulture) ?? "Received";
                var priorError = Convert.ToString(existing[0]["last_error"], CultureInfo.InvariantCulture);

                if (!sameContent)
                {
                    const string conflict = "MSH-10 daha önce farklı içerikle kullanılmış; ileti kimliği tekrar kullanılamaz.";
                    await AuditWriter.AppendAsync(connection, tx, user, "HL7_MESSAGE_ID_REUSE_REJECTED", "hl7-message",
                        message.MessageControlId, new { source_system = sourceSystem }, ct);
                    await tx.CommitAsync(ct);
                    return Results.Conflict(new
                    {
                        deduplicated = false,
                        duplicate = true,
                        controlId = message.MessageControlId,
                        status = "Conflict",
                        ack = Hl7OruParser.BuildAck(message.MessageControlId, "AE", conflict),
                        error = conflict
                    });
                }

                await tx.CommitAsync(ct);
                var duplicateAck = priorStatus == "Processed" ? "AA" : "AE";
                var duplicateError = priorStatus == "Processed" ? null : priorError ?? "Önceki ileti henüz başarıyla işlenmedi.";
                return Results.Ok(new
                {
                    deduplicated = true,
                    duplicate = true,
                    controlId = message.MessageControlId,
                    status = "DuplicateIgnored",
                    priorStatus,
                    ack = Hl7OruParser.BuildAck(message.MessageControlId, duplicateAck, duplicateError),
                    error = duplicateError
                });
            }

            var inboxId = Convert.ToInt64(inbox[0]["id"], CultureInfo.InvariantCulture);
            if (!long.TryParse(message.OrderIdentifier, NumberStyles.None, CultureInfo.InvariantCulture, out var orderId) || orderId <= 0)
            {
                const string error = "OBR-3 alanı mevcut klinik istem numarası (sayısal ID) olmalıdır.";
                await Db.ExecuteAsync(connection, tx, "UPDATE lis.inbox_messages SET status='Failed',last_error=@p0,processed_at=now() WHERE id=@p1", ct, error, inboxId);
                await AuditWriter.AppendAsync(connection, tx, user, "HL7_ORU_REJECTED", "hl7-message", message.MessageControlId, new { error }, ct);
                await tx.CommitAsync(ct);
                return Results.Ok(new
                {
                    deduplicated = false,
                    duplicate = false,
                    controlId = message.MessageControlId,
                    status = "Failed",
                    ack = Hl7OruParser.BuildAck(message.MessageControlId, "AE", error),
                    error
                });
            }

            var order = await Db.QueryAsync(connection, tx, """
                SELECT o.id,o.status,o.order_type,o.code,p.mrn
                FROM clinical.orders o
                JOIN patient.encounters e ON e.id=o.encounter_id
                JOIN patient.patients p ON p.id=e.patient_id
                WHERE o.id=@p0 FOR UPDATE OF o
                """, ct, orderId);
            if (order.Count == 0 || !string.Equals(Convert.ToString(order.FirstOrDefault()?.GetValueOrDefault("mrn"), CultureInfo.InvariantCulture), message.PatientIdentifier, StringComparison.Ordinal))
            {
                const string error = "OBR-3 klinik istemi veya PID-3 hasta numarası eşleşmedi.";
                await Db.ExecuteAsync(connection, tx, "UPDATE lis.inbox_messages SET status='Failed',last_error=@p0,processed_at=now() WHERE id=@p1", ct, error, inboxId);
                await AuditWriter.AppendAsync(connection, tx, user, "HL7_ORU_REJECTED", "hl7-message", message.MessageControlId, new { error, order_id = orderId }, ct);
                await tx.CommitAsync(ct);
                return Results.Ok(new
                {
                    deduplicated = false,
                    duplicate = false,
                    controlId = message.MessageControlId,
                    status = "Failed",
                    ack = Hl7OruParser.BuildAck(message.MessageControlId, "AE", error),
                    error
                });
            }

            if (!string.Equals(Convert.ToString(order[0]["code"], CultureInfo.InvariantCulture), message.TestCode, StringComparison.Ordinal))
            {
                const string error = "OBR-4 tetkik kodu klinik istem koduyla eşleşmedi.";
                await Db.ExecuteAsync(connection, tx, "UPDATE lis.inbox_messages SET status='Failed',last_error=@p0,processed_at=now() WHERE id=@p1", ct, error, inboxId);
                await AuditWriter.AppendAsync(connection, tx, user, "HL7_ORU_REJECTED", "hl7-message", message.MessageControlId, new { error, order_id = orderId }, ct);
                await tx.CommitAsync(ct);
                return Results.Ok(new
                {
                    deduplicated = false,
                    duplicate = false,
                    controlId = message.MessageControlId,
                    status = "Failed",
                    ack = Hl7OruParser.BuildAck(message.MessageControlId, "AE", error),
                    error
                });
            }

            if (!string.Equals(Convert.ToString(order[0]["order_type"], CultureInfo.InvariantCulture), "LAB", StringComparison.Ordinal)
                || !string.Equals(Convert.ToString(order[0]["status"], CultureInfo.InvariantCulture), "InProgress", StringComparison.Ordinal))
            {
                const string error = "HL7 sonuçları yalnızca işlemdeki laboratuvar istemlerine eklenebilir.";
                await Db.ExecuteAsync(connection, tx, "UPDATE lis.inbox_messages SET status='Failed',last_error=@p0,processed_at=now() WHERE id=@p1", ct, error, inboxId);
                await AuditWriter.AppendAsync(connection, tx, user, "HL7_ORU_REJECTED", "hl7-message", message.MessageControlId, new { error, order_id = orderId }, ct);
                await tx.CommitAsync(ct);
                return Results.Ok(new
                {
                    deduplicated = false,
                    duplicate = false,
                    controlId = message.MessageControlId,
                    status = "Failed",
                    ack = Hl7OruParser.BuildAck(message.MessageControlId, "AE", error),
                    error
                });
            }

            foreach (var observation in message.Observations)
            {
                var reference = observation.ReferenceRange is null
                    ? null
                    : observation.ReferenceRange.Length <= 60 ? observation.ReferenceRange : observation.ReferenceRange[..60];
                var isCritical = CriticalLabEvaluator.IsCritical(
                    observation.Code, observation.Display, observation.Value, observation.Flag, observation.Critical);

                await Db.ExecuteAsync(connection, tx, """
                    INSERT INTO clinical.lab_results(order_id,analyte_code,display,value,unit,reference_range,flag,critical,critical_flag,resulted_at)
                    VALUES(@p0,@p1,@p2,@p3,@p4,@p5,@p6,@p7,@p7,now())
                    """, ct,
                    orderId,
                    observation.Code,
                    observation.Display.Length > 120 ? observation.Display[..120] : observation.Display,
                    observation.Value.Length > 120 ? observation.Value[..120] : observation.Value,
                    Db.TextOrDbNull(observation.Unit is { Length: > 30 } unit ? unit[..30] : observation.Unit),
                    Db.TextOrDbNull(reference),
                    observation.Flag,
                    isCritical);
            }

            await Db.ExecuteAsync(connection, tx, "UPDATE clinical.orders SET status='Resulted',updated_at=now() WHERE id=@p0", ct, orderId);
            await Db.ExecuteAsync(connection, tx, "UPDATE lis.inbox_messages SET status='Processed',processed_at=now(),last_error=NULL WHERE id=@p0", ct, inboxId);
            await AuditWriter.AppendAsync(connection, tx, user, "HL7_ORU_PROCESSED", "hl7-message", message.MessageControlId,
                new { order_id = orderId, observation_count = message.Observations.Count }, ct);
            await OutboxWriter.EnqueueAsync(connection, tx, "INTERNAL", "Hl7LabResultsReceived", "order", orderId.ToString(CultureInfo.InvariantCulture),
                new { message_control_id = message.MessageControlId, order_id = orderId, observation_count = message.Observations.Count }, ct);
            await tx.CommitAsync(ct);

            return Results.Ok(new
            {
                deduplicated = false,
                duplicate = false,
                controlId = message.MessageControlId,
                status = "Processed",
                orderId,
                observationCount = message.Observations.Count,
                sendingApplication = message.SendingApplication,
                messageTimestamp = message.MessageTimestamp,
                ack = Hl7OruParser.BuildAck(message.MessageControlId, "AA")
            });
        }).RequireAuthorization(p => p.RequireRole("admin", "lab", "integration"));
    }

    private static async Task<(string RawMessage, string? SourceSystem)> ReadHl7BodyAsync(HttpRequest request, CancellationToken ct)
    {
        using var reader = new StreamReader(request.Body, Encoding.UTF8, detectEncodingFromByteOrderMarks: false, leaveOpen: true);
        var body = await reader.ReadToEndAsync(ct);
        var trimmed = body.TrimStart();
        var contentType = request.ContentType ?? "";
        var headerSource = request.Headers["X-Source-System"].FirstOrDefault();

        if (contentType.Contains("json", StringComparison.OrdinalIgnoreCase) || trimmed.StartsWith('{'))
        {
            try
            {
                using var doc = JsonDocument.Parse(body);
                if (doc.RootElement.ValueKind != JsonValueKind.Object)
                    throw new ArgumentException("Geçersiz JSON HL7 yükü.");
                string? raw = null;
                string? source = headerSource;
                foreach (var prop in doc.RootElement.EnumerateObject())
                {
                    if (string.Equals(prop.Name, "rawMessage", StringComparison.OrdinalIgnoreCase)
                        || string.Equals(prop.Name, "raw_message", StringComparison.OrdinalIgnoreCase))
                    {
                        raw = prop.Value.ValueKind == JsonValueKind.String ? prop.Value.GetString() : null;
                    }
                    else if (string.Equals(prop.Name, "sourceSystem", StringComparison.OrdinalIgnoreCase)
                             || string.Equals(prop.Name, "source_system", StringComparison.OrdinalIgnoreCase))
                    {
                        source = prop.Value.ValueKind == JsonValueKind.String ? prop.Value.GetString() : source;
                    }
                }
                return (raw ?? "", source);
            }
            catch (JsonException)
            {
                throw new ArgumentException("Geçersiz JSON HL7 mesaj biçimi.");
            }
        }

        return (body, headerSource);
    }

    private static string? Optional(string? value, int max)
    {
        var text = value?.Trim() ?? "";
        if (text.Length > max) throw new ArgumentException($"Kaynak sistem adı en fazla {max} karakter olabilir.");
        return text.Length == 0 ? null : text;
    }
}
