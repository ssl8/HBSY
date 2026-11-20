using Hbys.BuildingBlocks;

var app = ServiceDefaults.Create(args, "integration-svc");
IntegrationEndpoints.Map(app);
app.Run();
