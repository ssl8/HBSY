using Hbys.BuildingBlocks;

var app = ServiceDefaults.Create(args, "clinical-svc");
ClinicalEndpoints.Map(app);
app.Run();
