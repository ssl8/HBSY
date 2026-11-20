using Hbys.BuildingBlocks;

var app = ServiceDefaults.Create(args, "patient-svc");
PatientEndpoints.Map(app);
app.Run();
