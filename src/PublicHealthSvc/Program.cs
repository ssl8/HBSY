using Hbys.BuildingBlocks;

var app = ServiceDefaults.Create(args, "publichealth-svc");
PublicHealthEndpoints.Map(app);
app.Run();
