using Hbys.BuildingBlocks.Database;
using Npgsql;

var builder = WebApplication.CreateBuilder(args);

var connectionString = builder.Configuration.GetConnectionString("Default")
    ?? throw new InvalidOperationException("ConnectionStrings:Default tanımlanmalıdır.");
builder.Services.AddSingleton<NpgsqlDataSource>(_ => NpgsqlDataSource.Create(connectionString));
builder.Services.AddHostedService<OutboxDispatcherService>();

var app = builder.Build();

app.MapGet("/health/ready", async (NpgsqlDataSource db, CancellationToken ct) =>
{
    await Db.ScalarLongAsync(db, "SELECT 1", ct);
    return Results.Ok(new { status = "ready", service = "integration-worker" });
});

app.Run();
