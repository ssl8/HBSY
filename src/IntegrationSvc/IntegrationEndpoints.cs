using System.Globalization;
using System.Security.Claims;
using Hbys.BuildingBlocks.Audit;
using Hbys.BuildingBlocks.Database;
using Npgsql;

public static class IntegrationEndpoints
{
    public static void Map(WebApplication app)
    {
        var api = app.MapGroup("/api").RequireAuthorization();

        // Never select payload here to preserve V013 column isolation on integration.outbox.
        api.MapGet("/integrations", async (NpgsqlDataSource db, CancellationToken ct) =>
        {
            var rows = await Db.QueryCamelAsync(db, """
                SELECT id,target,event_type,aggregate_type,aggregate_id,status,attempts,
                       created_at,next_attempt_at,sent_at,last_error
                FROM integration.outbox
                ORDER BY id DESC LIMIT 200
                """, ct);
            return Results.Ok(rows);
        }).RequireAuthorization(p => p.RequireRole("admin", "integration"));

        api.MapPost("/integrations/{id:long}/retry", async (long id, NpgsqlDataSource db, ClaimsPrincipal user, CancellationToken ct) =>
        {
            if (id <= 0) throw new ArgumentException("Geçersiz entegrasyon kaydı.");
            await using var connection = await db.OpenConnectionAsync(ct);
            await using var tx = await connection.BeginTransactionAsync(ct);
            var rows = await Db.QueryAsync(connection, tx, "SELECT id,status FROM integration.outbox WHERE id=@p0 FOR UPDATE", ct, id);
            if (rows.Count == 0) throw new KeyNotFoundException("Entegrasyon olayı bulunamadı.");
            if (string.Equals(Convert.ToString(rows[0]["status"], CultureInfo.InvariantCulture), "Sent", StringComparison.Ordinal))
                throw new InvalidOperationException("Gönderilmiş olay tekrar kuyruğa alınamaz.");

            await Db.ExecuteAsync(connection, tx, """
                UPDATE integration.outbox SET status='Pending',last_error=NULL,next_attempt_at=now()
                WHERE id=@p0
                """, ct, id);
            await AuditWriter.AppendAsync(connection, tx, user, "INTEGRATION_REQUEUED", "outbox", id.ToString(CultureInfo.InvariantCulture),
                new { previous_status = rows[0]["status"] }, ct);
            await tx.CommitAsync(ct);
            return Results.Ok(new
            {
                id,
                status = "Pending",
                note = "Olay arka plan kuyruğu için yeniden sıraya alındı."
            });
        }).RequireAuthorization(p => p.RequireRole("admin", "integration"));
    }
}
