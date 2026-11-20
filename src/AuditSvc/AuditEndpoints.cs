using System.Security.Cryptography;
using System.Text;
using Hbys.BuildingBlocks.Audit;
using Npgsql;

public static class AuditEndpoints
{
    public static void Map(WebApplication app)
    {
        var api = app.MapGroup("/api").RequireAuthorization();

        api.MapGet("/audit", async (NpgsqlDataSource db, CancellationToken ct) =>
        {
            const string sql = """
                SELECT id,occurred_at,username,role,action,entity_type,entity_id,
                       details_json::text AS details_json,previous_hash,event_hash,canonical_payload
                FROM audit.events ORDER BY id ASC
                """;
            var events = new Queue<Dictionary<string, object?>>();
            var previous = new string('0', 64);
            var valid = true;
            long verifiedCount = 0;
            long? brokenEventId = null;

            await using var connection = await db.OpenConnectionAsync(ct);
            await using var command = new NpgsqlCommand(sql, connection);
            await using var reader = await command.ExecuteReaderAsync(ct);
            while (await reader.ReadAsync(ct))
            {
                var id = reader.GetInt64(0);
                var occurredAt = reader.GetFieldValue<DateTime>(1);
                var username = reader.GetString(2);
                var role = reader.GetString(3);
                var action = reader.GetString(4);
                var entityType = reader.GetString(5);
                var entityId = await reader.IsDBNullAsync(6, ct) ? null : reader.GetString(6);
                var detailsJson = reader.GetString(7);
                var currentPrevious = reader.GetString(8).TrimEnd();
                var actual = reader.GetString(9).TrimEnd();
                var canonical = reader.GetString(10);
                var expected = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(canonical))).ToLowerInvariant();
                var previousMatches = FixedEquals(previous, currentPrevious);
                var hashMatches = FixedEquals(expected, actual);
                var columnsMatch = AuditPayloadVerifier.MatchesColumns(canonical, occurredAt,
                    username, role, action, entityType, entityId, detailsJson);
                if (valid && (!previousMatches || !hashMatches || !columnsMatch))
                {
                    valid = false;
                    brokenEventId = id;
                }
                previous = actual;
                verifiedCount++;

                var row = new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["id"] = id,
                    ["occurredAt"] = occurredAt,
                    ["username"] = username,
                    ["role"] = role,
                    ["action"] = action,
                    ["entityType"] = entityType,
                    ["entityId"] = entityId,
                    ["detailsJson"] = detailsJson,
                    ["previousHash"] = currentPrevious,
                    ["eventHash"] = actual
                };
                if (events.Count == 150) events.Dequeue();
                events.Enqueue(row);
            }

            return Results.Ok(new
            {
                chainValid = valid,
                verifiedCount,
                brokenEventId,
                events = events.Reverse().ToArray()
            });
        }).RequireAuthorization(p => p.RequireRole("admin"));
    }

    private static bool FixedEquals(string left, string right)
    {
        if (left.Length != right.Length) return false;
        return CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(left), Encoding.ASCII.GetBytes(right));
    }
}
