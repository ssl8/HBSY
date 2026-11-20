using Hbys.BuildingBlocks;

var app = ServiceDefaults.Create(args, "audit-svc");
AuditEndpoints.Map(app);
app.Run();
