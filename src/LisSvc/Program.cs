using Hbys.BuildingBlocks;

var app = ServiceDefaults.Create(args, "lis-svc");
LisEndpoints.Map(app);
app.Run();
