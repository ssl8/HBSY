using Hbys.BuildingBlocks;

var app = ServiceDefaults.Create(args, "adt-svc");
AdtEndpoints.Map(app);
app.Run();
