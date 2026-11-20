using Hbys.BuildingBlocks;

var app = ServiceDefaults.Create(args, "pharmacy-svc");
PharmacyEndpoints.Map(app);
app.Run();
