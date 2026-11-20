$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host '[1/6] Docker Compose yapisi (opsiyonel)' -ForegroundColor Cyan
if (Get-Command docker -ErrorAction SilentlyContinue) {
  docker compose config --quiet
  if ($LASTEXITCODE -ne 0) { throw 'Docker Compose yapilandirma dogrulamasi basarisiz.' }
} else {
  Write-Warning 'Docker bulunamadi; Docker Compose kontrolu atlandi.'
}

Write-Host '[2/6] Node.js & Frontend ES Modulleri sozdizimi' -ForegroundColor Cyan
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'Node.js 22+ kurulu olmalidir.'
}
$jsFiles = @(
  (Get-Item 'server.js'),
  (Get-Item 'web/app.js'),
  (Get-Item 'tests/test-server.js'),
  (Get-Item 'tests/test-tour.js')
) + (Get-ChildItem -Recurse -Filter '*.js' 'web/js')
foreach ($f in $jsFiles) {
  node --check $f.FullName
  if ($LASTEXITCODE -ne 0) { throw "JS sozdizimi hatasi: $($f.FullName)" }
}
Write-Host "  $($jsFiles.Count) JavaScript dosyasi dogrulandi." -ForegroundColor Green

Write-Host '[3/6] Node.js API & 12 Adimlik Simulasyon Testleri' -ForegroundColor Cyan
npm run test:api
if ($LASTEXITCODE -ne 0) { throw 'npm run test:api basarisiz.' }
npm run test:tour
if ($LASTEXITCODE -ne 0) { throw 'npm run test:tour basarisiz.' }

Write-Host '[4/6] .NET 10 derleme ve DomainTests (opsiyonel)' -ForegroundColor Cyan
if (Get-Command dotnet -ErrorAction SilentlyContinue) {
  dotnet restore NOVA.HBYS.sln
  if ($LASTEXITCODE -ne 0) { throw 'dotnet restore basarisiz.' }
  dotnet build NOVA.HBYS.sln -c Release --no-restore
  if ($LASTEXITCODE -ne 0) { throw 'dotnet build basarisiz.' }
  dotnet test tests/DomainTests/DomainTests.csproj -c Release --no-build
  if ($LASTEXITCODE -ne 0) { throw 'DomainTests basarisiz.' }
} else {
  Write-Warning '.NET 10 SDK bulunamadi; .NET derleme/test atlandi.'
}

Write-Host '[5/6] PostgreSQL guvenlik kontrolleri (calisan Docker ortami gerektirir)' -ForegroundColor Cyan
if ((Get-Command docker -ErrorAction SilentlyContinue) -and (Get-Command bash -ErrorAction SilentlyContinue)) {
  bash scripts/check-db-security.sh
  if ($LASTEXITCODE -ne 0) { throw 'Veritabani guvenlik kontrolleri basarisiz.' }
} else {
  Write-Warning 'Docker veya bash yok; check-db-security.sh atlandi.'
}

Write-Host '[6/6] Playwright E2E testleri (calisan Docker ortami gerektirir)' -ForegroundColor Cyan
if (Test-Path 'node_modules/.bin/playwright.cmd') {
  npm run e2e
  if ($LASTEXITCODE -ne 0) { throw 'Playwright E2E testleri basarisiz.' }
} else {
  Write-Warning 'Playwright yuklu degil. E2E icin: npm install && npx playwright install chromium && npm run e2e'
}
Write-Host 'Tum uygun dogrulama adimlari tamamlandi.' -ForegroundColor Green
