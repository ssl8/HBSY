using System.Text.Json;
using Hbys.BuildingBlocks.Audit;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.IdentityModel.Tokens;
using Npgsql;

namespace Hbys.BuildingBlocks;

public static class ServiceDefaults
{
    public static WebApplication Create(string[] args, string serviceName)
    {
        var builder = WebApplication.CreateBuilder(args);
        builder.Services.ConfigureHttpJsonOptions(options =>
        {
            options.SerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
            options.SerializerOptions.DictionaryKeyPolicy = JsonNamingPolicy.CamelCase;
            options.SerializerOptions.PropertyNameCaseInsensitive = true;
        });

        var rawOrigins = builder.Configuration["HBYS_WEB_ORIGIN"] ?? "http://localhost:8088";
        var allowedOrigins = rawOrigins
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(o => o.TrimEnd('/'))
            .Where(o => o.Length > 0)
            .ToArray();
        if (allowedOrigins.Length == 0)
            allowedOrigins = ["http://localhost:8088"];

        builder.Services.AddCors(options =>
        {
            options.AddDefaultPolicy(policy =>
                policy.WithOrigins(allowedOrigins)
                      .AllowAnyHeader()
                      .AllowAnyMethod());
        });

        var connectionString = builder.Configuration.GetConnectionString("Default")
            ?? throw new InvalidOperationException("ConnectionStrings:Default tanımlanmalıdır.");
        // Register through a factory so the host owns and disposes the pooled data source.
        builder.Services.AddSingleton<NpgsqlDataSource>(_ => NpgsqlDataSource.Create(connectionString));

        var metadataAddress = builder.Configuration["Keycloak:MetadataAddress"]
            ?? "http://keycloak:8080/realms/hbys/.well-known/openid-configuration";
        var validIssuer = builder.Configuration["Keycloak:ValidIssuer"]
            ?? "http://localhost:8080/realms/hbys";
        var audience = builder.Configuration["Keycloak:Audience"] ?? "hbys-api";

        builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
            .AddJwtBearer(options =>
            {
                options.MetadataAddress = metadataAddress;
                options.RequireHttpsMetadata = !metadataAddress.StartsWith("http://", StringComparison.OrdinalIgnoreCase);
                options.MapInboundClaims = false;
                options.TokenValidationParameters = new TokenValidationParameters
                {
                    ValidateIssuer = true,
                    ValidIssuer = validIssuer,
                    ValidateAudience = true,
                    ValidAudience = audience,
                    ValidateLifetime = true,
                    ValidateIssuerSigningKey = true,
                    RequireSignedTokens = true,
                    ValidAlgorithms = new[] { SecurityAlgorithms.RsaSha256 },
                    ClockSkew = TimeSpan.FromSeconds(60),
                    RoleClaimType = "roles",
                    NameClaimType = "preferred_username"
                };
            });
        builder.Services.AddAuthorization();
        builder.Services.AddRateLimiter(options =>
        {
            options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
            options.GlobalLimiter = System.Threading.RateLimiting.PartitionedRateLimiter.Create<HttpContext, string>(context =>
                System.Threading.RateLimiting.RateLimitPartition.GetFixedWindowLimiter(
                    context.User.FindFirst("sub")?.Value ?? context.Connection.RemoteIpAddress?.ToString() ?? "unknown",
                    _ => new System.Threading.RateLimiting.FixedWindowRateLimiterOptions
                    {
                        PermitLimit = 300,
                        Window = TimeSpan.FromMinutes(1),
                        QueueLimit = 0,
                        AutoReplenishment = true
                    }));
        });

        var app = builder.Build();
        app.Use(async (context, next) =>
        {
            var correlationId = context.Request.Headers["X-Correlation-ID"].FirstOrDefault();
            if (string.IsNullOrWhiteSpace(correlationId) || correlationId.Length > 64 ||
                correlationId.Any(c => !(char.IsAsciiLetterOrDigit(c) || c is '-' or '_' or '.')))
                correlationId = Guid.NewGuid().ToString("N");
            context.Response.Headers["X-Correlation-ID"] = correlationId;
            context.Response.Headers["Cache-Control"] = "no-store";
            using (app.Logger.BeginScope(new Dictionary<string, object> { ["CorrelationId"] = correlationId, ["Service"] = serviceName }))
            {
                try { await next(); }
                catch (OperationCanceledException) when (context.RequestAborted.IsCancellationRequested)
                {
                    throw;
                }
                catch (PostgresException ex) when (ex.SqlState is PostgresErrorCodes.UniqueViolation
                    or PostgresErrorCodes.ForeignKeyViolation or PostgresErrorCodes.CheckViolation
                    or PostgresErrorCodes.NotNullViolation)
                {
                    app.Logger.LogWarning(ex, "Database constraint rejected a request in {Service}", serviceName);
                    var conflict = ex.SqlState is PostgresErrorCodes.UniqueViolation or PostgresErrorCodes.ForeignKeyViolation;
                    if (context.Response.HasStarted) throw;
                    context.Response.StatusCode = conflict ? StatusCodes.Status409Conflict : StatusCodes.Status400BadRequest;
                    await context.Response.WriteAsJsonAsync(new
                    {
                        error = conflict ? "Kayıt mevcut durumla çakışıyor." : "İstek verileri veri kurallarını karşılamıyor.",
                        correlationId
                    });
                }
                catch (ArgumentException ex)
                {
                    app.Logger.LogWarning(ex, "Validation failure in {Service}", serviceName);
                    if (context.Response.HasStarted) throw;
                    context.Response.StatusCode = StatusCodes.Status400BadRequest;
                    await context.Response.WriteAsJsonAsync(new { error = ex.Message, correlationId });
                }
                catch (KeyNotFoundException ex)
                {
                    if (context.Response.HasStarted) throw;
                    context.Response.StatusCode = StatusCodes.Status404NotFound;
                    await context.Response.WriteAsJsonAsync(new { error = ex.Message, correlationId });
                }
                catch (InvalidOperationException ex)
                {
                    app.Logger.LogWarning(ex, "Business rule rejected in {Service}", serviceName);
                    if (context.Response.HasStarted) throw;
                    context.Response.StatusCode = StatusCodes.Status409Conflict;
                    await context.Response.WriteAsJsonAsync(new { error = ex.Message, correlationId });
                }
                catch (Exception ex)
                {
                    app.Logger.LogError(ex, "Unhandled error in {Service}; correlation {CorrelationId}", serviceName, correlationId);
                    if (context.Response.HasStarted) throw;
                    context.Response.StatusCode = StatusCodes.Status500InternalServerError;
                    await context.Response.WriteAsJsonAsync(new { error = "Beklenmeyen sunucu hatası.", correlationId });
                }
            }
        });

        app.UseCors();
        // Authenticate before rate limiting so each authenticated user receives an independent quota.
        app.UseAuthentication();
        app.UseRateLimiter();
        app.UseAuthorization();

        // Record authenticated API reads before a protected response can disclose patient or clinical data.
        app.Use(async (context, next) =>
        {
            if (HttpMethods.IsGet(context.Request.Method) &&
                context.Request.Path.StartsWithSegments("/api") &&
                context.User.Identity?.IsAuthenticated == true)
            {
                try
                {
                    await using var connection = await app.Services.GetRequiredService<NpgsqlDataSource>().OpenConnectionAsync(context.RequestAborted);
                    await using var transaction = await connection.BeginTransactionAsync(context.RequestAborted);
                    var path = context.Request.Path.Value ?? "/api";
                    var entityType = path.Split('/', StringSplitOptions.RemoveEmptyEntries).Skip(1).FirstOrDefault() ?? "api";
                    await AuditWriter.AppendAsync(connection, transaction, context.User, "API_READ", entityType,
                        null, new { request_path = path, correlation_id = context.Response.Headers["X-Correlation-ID"].ToString() },
                        context.RequestAborted);
                    await transaction.CommitAsync(context.RequestAborted);
                }
                catch (OperationCanceledException) when (context.RequestAborted.IsCancellationRequested)
                {
                    throw;
                }
                catch (Exception ex)
                {
                    app.Logger.LogError(ex, "Read-audit write failed; request blocked for {Path}", context.Request.Path);
                    if (!context.Response.HasStarted)
                    {
                        context.Response.StatusCode = StatusCodes.Status503ServiceUnavailable;
                        await context.Response.WriteAsJsonAsync(new
                        {
                            error = "Denetim kaydı oluşturulamadığı için veri erişimi durduruldu.",
                            correlationId = context.Response.Headers["X-Correlation-ID"].ToString()
                        }, context.RequestAborted);
                    }
                    return;
                }
            }
            await next();
        });

        app.MapGet("/health/live", () => Results.Ok(new { status = "ok", service = serviceName }));
        app.MapGet("/health/ready", async (NpgsqlDataSource source, CancellationToken ct) =>
        {
            var requiredRelation = serviceName switch
            {
                "patient-svc" => "patient.patients",
                "clinical-svc" => "clinical.orders",
                "adt-svc" => "adt.beds",
                "pharmacy-svc" => "pharmacy.drugs",
                "billing-svc" => "billing.invoices",
                "publichealth-svc" => "publichealth.vaccinations",
                "lis-svc" => "lis.inbox_messages",
                "integration-svc" => "integration.outbox",
                "connector-svc" => "integration.mhrs_appointments",
                "integration-worker" => "integration.outbox",
                "audit-svc" => "audit.events",
                _ => throw new InvalidOperationException($"Readiness relation tanımlanmamış: {serviceName}")
            };
            await using var connection = await source.OpenConnectionAsync(ct);
            await using var command = new NpgsqlCommand("SELECT to_regclass(@relation)::text", connection);
            command.Parameters.AddWithValue("relation", requiredRelation);
            var relation = await command.ExecuteScalarAsync(ct);
            if (relation is null or DBNull)
                return Results.Problem(title: "Veritabanı şeması hazır değil.", detail: requiredRelation, statusCode: StatusCodes.Status503ServiceUnavailable);
            return Results.Ok(new { status = "ready", service = serviceName, database = "connected", schema = "ready" });
        });
        app.MapGet("/", () => Results.Ok(new { name = serviceName, version = "4.0.0", framework = ".NET 10 LTS" }));
        return app;
    }
}
