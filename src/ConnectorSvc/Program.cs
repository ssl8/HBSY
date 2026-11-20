using Hbys.BuildingBlocks;

var app = ServiceDefaults.Create(args, "connector-svc");
ConnectorEndpoints.Map(app);
app.Run();
