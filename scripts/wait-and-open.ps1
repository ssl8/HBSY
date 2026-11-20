$ErrorActionPreference = 'Stop'
$base = 'http://localhost:8088'
$keycloak = 'http://localhost:8080/realms/hbys/.well-known/openid-configuration'
$checks = @(
  "$base/health",
  "$base/api/config",
  "$base/health/patient",
  "$base/health/clinical",
  "$base/health/adt",
  "$base/health/pharmacy",
  "$base/health/billing",
  "$base/health/publichealth",
  "$base/health/lis",
  "$base/health/integration",
  "$base/health/audit",
  "$base/health/connector",
  "$base/health/worker",
  $keycloak
)
$deadline = (Get-Date).AddMinutes(4)
do {
  $failed = @()
  foreach ($url in $checks) {
    try {
      $response = Invoke-WebRequest -Uri $url -Method Get -TimeoutSec 5 -UseBasicParsing
      if ($response.StatusCode -ne 200) { $failed += $url }
    } catch { $failed += $url }
  }
  if ($failed.Count -eq 0) {
    Write-Host 'NOVA HBYS tum servisleri ve Keycloak OIDC sunucusu hazir.' -ForegroundColor Green
    Start-Process $base
    exit 0
  }
  Start-Sleep -Seconds 4
} while ((Get-Date) -lt $deadline)
Write-Host 'Hazirlik zaman asimina ugradi. Basarisiz kontroller:' -ForegroundColor Red
$failed | ForEach-Object { Write-Host " - $_" }
Write-Host 'Tanilama: docker compose ps; docker compose logs --tail 200' -ForegroundColor Yellow
exit 1
