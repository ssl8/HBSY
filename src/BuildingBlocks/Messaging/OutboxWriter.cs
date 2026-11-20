using System.Text.Json;
using Hbys.BuildingBlocks.Database;
using Npgsql;

namespace Hbys.BuildingBlocks.Messaging;

public static class OutboxWriter
{
    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower };

    public static async Task<long> EnqueueAsync(
        NpgsqlConnection connection, NpgsqlTransaction transaction, string target,
        string eventType, string aggregateType, string aggregateId, object payload, CancellationToken ct,
        string? idempotencyKey = null)
    {
        var key = string.IsNullOrWhiteSpace(idempotencyKey)
            ? $"{eventType}:{aggregateType}:{aggregateId}"
            : idempotencyKey.Trim();
        if (key.Length > 180) throw new ArgumentException("Outbox idempotency key 180 karakteri aşamaz.", nameof(idempotencyKey));
        await using var command = Db.Command(connection, transaction, """
            INSERT INTO integration.outbox(target,event_type,aggregate_type,aggregate_id,status,attempts,
                                           created_at,next_attempt_at,payload,idempotency_key)
            VALUES (@p0,@p1,@p2,@p3,'Pending',0,now(),now(),@p4::jsonb,@p5)
            ON CONFLICT (idempotency_key) DO NOTHING
            RETURNING id
            """, target, eventType, aggregateType, aggregateId, JsonSerializer.Serialize(payload, JsonOptions), key);
        var result = await command.ExecuteScalarAsync(ct);
        if (result is not null and not DBNull)
            return Convert.ToInt64(result, System.Globalization.CultureInfo.InvariantCulture);

        // A concurrent or repeated enqueue is idempotent; it must not require UPDATE privileges.
        var existingId = await Db.ScalarLongAsync(connection, transaction,
            "SELECT id FROM integration.outbox WHERE idempotency_key=@p0", ct, key);
        if (existingId <= 0) throw new InvalidOperationException("Idempotent outbox kaydı conflict sonrasında bulunamadı.");
        return existingId;
    }
}
