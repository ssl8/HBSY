using Hbys.BuildingBlocks;

var app = ServiceDefaults.Create(args, "billing-svc");
BillingEndpoints.Map(app);
app.Run();
