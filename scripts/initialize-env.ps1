$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$values = @{}
if (Test-Path '.env') {
  foreach ($line in Get-Content '.env') {
    if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$') {
      $values[$matches[1]] = $matches[2]
    }
  }
}

function New-SecretHex {
  $bytes = New-Object byte[] 32
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  return [System.BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant()
}

$secretNames = @(
  'POSTGRES_ADMIN_PASSWORD','HBYS_MIGRATOR_PASSWORD','KEYCLOAK_DB_PASSWORD',
  'PATIENT_DB_PASSWORD','CLINICAL_DB_PASSWORD','ADT_DB_PASSWORD','PHARMACY_DB_PASSWORD',
  'BILLING_DB_PASSWORD','PUBLICHEALTH_DB_PASSWORD','LIS_DB_PASSWORD',
  'INTEGRATION_DB_PASSWORD','CONNECTOR_DB_PASSWORD','INTEGRATION_WORKER_DB_PASSWORD',
  'AUDIT_DB_PASSWORD','KEYCLOAK_ADMIN_PASSWORD'
)
foreach ($name in $secretNames) {
  if (-not $values.ContainsKey($name) -or [string]::IsNullOrWhiteSpace($values[$name]) -or $values[$name] -match 'CHANGE_ME|local-only') {
    $values[$name] = New-SecretHex
  }
}
if (-not $values.ContainsKey('KEYCLOAK_ADMIN') -or [string]::IsNullOrWhiteSpace($values['KEYCLOAK_ADMIN'])) { $values['KEYCLOAK_ADMIN'] = 'hbys-admin' }
if (-not $values.ContainsKey('HBYS_PUBLIC_ISSUER') -or [string]::IsNullOrWhiteSpace($values['HBYS_PUBLIC_ISSUER'])) { $values['HBYS_PUBLIC_ISSUER'] = 'http://localhost:8080/realms/hbys' }
if (-not $values.ContainsKey('HBYS_WEB_ORIGIN') -or [string]::IsNullOrWhiteSpace($values['HBYS_WEB_ORIGIN'])) { $values['HBYS_WEB_ORIGIN'] = 'http://localhost:8088' }

$order = @(
  'POSTGRES_ADMIN_PASSWORD','HBYS_MIGRATOR_PASSWORD','KEYCLOAK_DB_PASSWORD',
  'PATIENT_DB_PASSWORD','CLINICAL_DB_PASSWORD','ADT_DB_PASSWORD','PHARMACY_DB_PASSWORD',
  'BILLING_DB_PASSWORD','PUBLICHEALTH_DB_PASSWORD','LIS_DB_PASSWORD',
  'INTEGRATION_DB_PASSWORD','CONNECTOR_DB_PASSWORD','INTEGRATION_WORKER_DB_PASSWORD',
  'AUDIT_DB_PASSWORD','KEYCLOAK_ADMIN','KEYCLOAK_ADMIN_PASSWORD',
  'HBYS_PUBLIC_ISSUER','HBYS_WEB_ORIGIN'
)
$content = foreach ($name in $order) { "$name=$($values[$name])" }
[System.IO.File]::WriteAllLines((Join-Path $root '.env'), $content, [System.Text.Encoding]::ASCII)
Write-Host '.env olusturuldu/guncellendi. Tum veritabani rolleri ve Keycloak icin bagimsiz rastgele parolalar uretildi.' -ForegroundColor Green
