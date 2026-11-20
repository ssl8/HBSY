using System.Globalization;
using System.Security.Claims;
using System.Text;
using Hbys.BuildingBlocks.Audit;
using Hbys.BuildingBlocks.Database;
using Npgsql;

public sealed class OutboxDispatcherService(
    NpgsqlDataSource db,
    IConfiguration configuration,
    ILogger<OutboxDispatcherService> logger) : BackgroundService
{
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(5) };

    private static readonly ClaimsPrincipal WorkerPrincipal = new(
        new ClaimsIdentity(
            new[]
            {
                new Claim("preferred_username", "integration-worker"),
                new Claim("name", "Outbox Dağıtım İşçisi"),
                new Claim("roles", "integration")
            },
            "worker"));

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var pollSeconds = Math.Clamp(configuration.GetValue("HBYS_OUTBOX_POLL_SECONDS", 5), 1, 120);
        var maxRetries = Math.Clamp(configuration.GetValue("HBYS_OUTBOX_MAX_RETRIES", 5), 1, 20);
        var mode = (configuration["HBYS_OUTBOX_MODE"] ?? "sandbox").Trim().ToLowerInvariant();
        var defaultWebhookUrl = configuration["HBYS_OUTBOX_WEBHOOK_URL"]?.Trim();

        logger.LogInformation("IntegrationWorker started in {Mode} mode (poll={PollSeconds}s, maxRetries={MaxRetries})",
            mode, pollSeconds, maxRetries);

        // Process once on startup after a brief pause, then follow PeriodicTimer cadence.
        await Task.Delay(TimeSpan.FromSeconds(2), stoppingToken);
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(pollSeconds));

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await ProcessBatchAsync(mode, defaultWebhookUrl, maxRetries, stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "IntegrationWorker outbox poll iteration failed; retrying on next tick");
            }

            if (!await timer.WaitForNextTickAsync(stoppingToken))
                break;
        }
    }

    private async Task ProcessBatchAsync(string mode, string? defaultWebhookUrl, int maxRetries, CancellationToken ct)
    {
        var claimed = await ClaimPendingAsync(ct);
        if (claimed.Count == 0) return;

        foreach (var item in claimed)
        {
            var id = Convert.ToInt64(item["id"], CultureInfo.InvariantCulture);
            var target = Convert.ToString(item["target"], CultureInfo.InvariantCulture) ?? "INTERNAL";
            var eventType = Convert.ToString(item["event_type"], CultureInfo.InvariantCulture) ?? "";
            var aggregateType = Convert.ToString(item["aggregate_type"], CultureInfo.InvariantCulture) ?? "";
            var aggregateId = Convert.ToString(item["aggregate_id"], CultureInfo.InvariantCulture) ?? "";
            var attempts = Convert.ToInt32(item["attempts"] ?? 0, CultureInfo.InvariantCulture);
            var payload = Convert.ToString(item["payload"], CultureInfo.InvariantCulture) ?? "{}";
            var idempotencyKey = Convert.ToString(item["idempotency_key"], CultureInfo.InvariantCulture);

            var dispatchResult = await DispatchAsync(mode, defaultWebhookUrl, id, target, eventType, aggregateType, aggregateId, payload, idempotencyKey, ct);
            if (dispatchResult.Success)
            {
                await MarkSentAsync(id, target, eventType, attempts + 1, ct);
            }
            else
            {
                await MarkFailedWithBackoffAsync(id, target, eventType, attempts + 1, maxRetries, dispatchResult.Error ?? "İletim hatası", ct);
            }
        }
    }

    private async Task<List<Dictionary<string, object?>>> ClaimPendingAsync(CancellationToken ct)
    {
        await using var connection = await db.OpenConnectionAsync(ct);
        await using var tx = await connection.BeginTransactionAsync(ct);
        var rows = await Db.QueryAsync(connection, tx, """
            WITH candidate AS (
                SELECT id
                FROM integration.outbox
                WHERE status IN ('Pending', 'Failed')
                  AND next_attempt_at <= now()
                ORDER BY next_attempt_at ASC, id ASC
                LIMIT 10
                FOR UPDATE SKIP LOCKED
            )
            UPDATE integration.outbox o
            SET status = 'Processing'
            FROM candidate c
            WHERE o.id = c.id
            RETURNING o.id, o.target, o.event_type, o.aggregate_type, o.aggregate_id,
                      o.attempts, o.payload::text AS payload, o.idempotency_key
            """, ct);
        await tx.CommitAsync(ct);
        return rows;
    }

    private async Task<(bool Success, string? Error)> DispatchAsync(
        string mode,
        string? defaultWebhookUrl,
        long id,
        string target,
        string eventType,
        string aggregateType,
        string aggregateId,
        string payload,
        string? idempotencyKey,
        CancellationToken ct)
    {
        if (target.StartsWith("FAIL_TEST", StringComparison.OrdinalIgnoreCase))
            return (false, "Simüle edilen hedef servis zaman aşımı.");

        var webhookUrl = ResolveWebhookUrl(target, defaultWebhookUrl);
        if (mode == "webhook" && !string.IsNullOrWhiteSpace(webhookUrl))
        {
            try
            {
                using var request = new HttpRequestMessage(HttpMethod.Post, webhookUrl)
                {
                    Content = new StringContent(payload, Encoding.UTF8, "application/json")
                };
                request.Headers.Add("X-Outbox-Id", id.ToString(CultureInfo.InvariantCulture));
                request.Headers.Add("X-Outbox-Target", target);
                request.Headers.Add("X-Outbox-Event-Type", eventType);
                request.Headers.Add("X-Aggregate-Type", aggregateType);
                request.Headers.Add("X-Aggregate-Id", aggregateId);
                if (!string.IsNullOrWhiteSpace(idempotencyKey))
                    request.Headers.Add("X-Idempotency-Key", idempotencyKey);

                using var response = await Http.SendAsync(request, ct);
                if (!response.IsSuccessStatusCode)
                    return (false, $"Webhook HTTP {(int)response.StatusCode} yanıtı döndü.");
                return (true, null);
            }
            catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
            {
                return (false, ex.Message);
            }
        }

        // Sandbox / local simulation dispatch succeeds deterministically without external network calls.
        logger.LogDebug("Simulated outbox dispatch #{Id} -> {Target} ({EventType})", id, target, eventType);
        return (true, null);
    }

    private string? ResolveWebhookUrl(string target, string? defaultWebhookUrl)
    {
        var normalized = new string(target.ToUpperInvariant().Where(char.IsAsciiLetterOrDigit).ToArray());
        var specific = configuration[$"HBYS_WEBHOOK_{normalized}"]?.Trim();
        return !string.IsNullOrWhiteSpace(specific) ? specific : defaultWebhookUrl;
    }

    private async Task MarkSentAsync(long id, string target, string eventType, int attempts, CancellationToken ct)
    {
        await using var connection = await db.OpenConnectionAsync(ct);
        await using var tx = await connection.BeginTransactionAsync(ct);
        await Db.ExecuteAsync(connection, tx, """
            UPDATE integration.outbox
            SET status = 'Sent', attempts = @p0, sent_at = now(), last_error = NULL
            WHERE id = @p1
            """, ct, attempts, id);
        await AuditWriter.AppendAsync(connection, tx, WorkerPrincipal, "OUTBOX_EVENT_SENT", "outbox",
            id.ToString(CultureInfo.InvariantCulture), new { target, event_type = eventType, attempts }, ct);
        await tx.CommitAsync(ct);
    }

    private async Task MarkFailedWithBackoffAsync(long id, string target, string eventType, int attempts, int maxRetries, string error, CancellationToken ct)
    {
        var truncatedError = error.Length > 500 ? error[..500] : error;
        var deadLetter = attempts >= maxRetries;
        var nextStatus = deadLetter ? "DeadLetter" : "Failed";
        var backoffSeconds = deadLetter ? 0 : Math.Min(3600, (int)Math.Pow(2, Math.Min(attempts, 10)) * 5);

        await using var connection = await db.OpenConnectionAsync(ct);
        await using var tx = await connection.BeginTransactionAsync(ct);
        await Db.ExecuteAsync(connection, tx, """
            UPDATE integration.outbox
            SET status = @p0,
                attempts = @p1,
                next_attempt_at = now() + make_interval(secs => @p2),
                last_error = @p3
            WHERE id = @p4
            """, ct, nextStatus, attempts, backoffSeconds, truncatedError, id);
        await AuditWriter.AppendAsync(connection, tx, WorkerPrincipal,
            deadLetter ? "OUTBOX_EVENT_DEAD_LETTER" : "OUTBOX_EVENT_FAILED",
            "outbox", id.ToString(CultureInfo.InvariantCulture),
            new { target, event_type = eventType, attempts, next_status = nextStatus, backoff_seconds = backoffSeconds, error = truncatedError }, ct);
        await tx.CommitAsync(ct);
    }
}
