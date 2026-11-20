using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Hbys.BuildingBlocks.Database;
using Hbys.BuildingBlocks.Security;
using Npgsql;

namespace Hbys.BuildingBlocks.Audit;

public static class AuditWriter
{
    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower };

    public static async Task AppendAsync(
        NpgsqlConnection connection, NpgsqlTransaction transaction, ClaimsPrincipal actor,
        string action, string entityType, string? entityId, object? details, CancellationToken ct)
    {
        // Transaction-scoped advisory lock serializes hash-chain writers across all services.
        await Db.ExecuteAsync(connection, transaction, "SELECT pg_advisory_xact_lock(71420531)", ct);
        var previous = await Db.ScalarStringAsync(connection, transaction,
            "SELECT event_hash FROM audit.events ORDER BY id DESC LIMIT 1", ct) ?? new string('0', 64);
        var occurredAt = DateTimeOffset.UtcNow;
        var username = actor.FindFirst("preferred_username")?.Value ?? "system";
        var role = RoleClaims.PrimaryRole(actor);
        if (role == "user") role = "system";
        var payload = JsonSerializer.Serialize(new
        {
            previous_hash = previous,
            occurred_at = occurredAt.ToString("O"),
            username,
            role,
            action,
            entity_type = entityType,
            entity_id = entityId,
            details
        }, JsonOptions);
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(payload))).ToLowerInvariant();
        await Db.ExecuteAsync(connection, transaction, """
            INSERT INTO audit.events(occurred_at, username, role, action, entity_type, entity_id,
                                    details_json, previous_hash, event_hash, canonical_payload)
            VALUES (@p0,@p1,@p2,@p3,@p4,@p5,@p6::jsonb,@p7,@p8,@p9)
            """, ct, occurredAt, username, role, action, entityType, Db.TextOrDbNull(entityId),
            JsonSerializer.Serialize(details ?? new { }, JsonOptions), previous, hash, payload);
    }
}
