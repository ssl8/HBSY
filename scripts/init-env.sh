#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"

gen_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  elif command -v python3 >/dev/null 2>&1; then
    python3 - <<'PY'
import secrets
print(secrets.token_hex(32))
PY
  else
    od -An -tx1 -N32 /dev/urandom | tr -d ' \n'
  fi
}

declare -A VALS=()
if [[ -f "$ENV_FILE" ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
    if [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
      VALS["${BASH_REMATCH[1]}"]="${BASH_REMATCH[2]}"
    fi
  done < "$ENV_FILE"
fi

SECRET_NAMES=(
  POSTGRES_ADMIN_PASSWORD
  HBYS_MIGRATOR_PASSWORD
  KEYCLOAK_DB_PASSWORD
  PATIENT_DB_PASSWORD
  CLINICAL_DB_PASSWORD
  ADT_DB_PASSWORD
  PHARMACY_DB_PASSWORD
  BILLING_DB_PASSWORD
  PUBLICHEALTH_DB_PASSWORD
  LIS_DB_PASSWORD
  INTEGRATION_DB_PASSWORD
  CONNECTOR_DB_PASSWORD
  INTEGRATION_WORKER_DB_PASSWORD
  AUDIT_DB_PASSWORD
  KEYCLOAK_ADMIN_PASSWORD
)

for key in "${SECRET_NAMES[@]}"; do
  cur="${VALS[$key]:-}"
  if [[ -z "$cur" || "$cur" == *"CHANGE_ME"* || "$cur" == *"local-only"* ]]; then
    VALS["$key"]="$(gen_secret)"
  fi
done

VALS["KEYCLOAK_ADMIN"]="${VALS[KEYCLOAK_ADMIN]:-hbys-admin}"
VALS["HBYS_PUBLIC_ISSUER"]="${VALS[HBYS_PUBLIC_ISSUER]:-http://localhost:8080/realms/hbys}"
VALS["HBYS_WEB_ORIGIN"]="${VALS[HBYS_WEB_ORIGIN]:-http://localhost:8088}"

ORDER=(
  POSTGRES_ADMIN_PASSWORD
  HBYS_MIGRATOR_PASSWORD
  KEYCLOAK_DB_PASSWORD
  PATIENT_DB_PASSWORD
  CLINICAL_DB_PASSWORD
  ADT_DB_PASSWORD
  PHARMACY_DB_PASSWORD
  BILLING_DB_PASSWORD
  PUBLICHEALTH_DB_PASSWORD
  LIS_DB_PASSWORD
  INTEGRATION_DB_PASSWORD
  CONNECTOR_DB_PASSWORD
  INTEGRATION_WORKER_DB_PASSWORD
  AUDIT_DB_PASSWORD
  KEYCLOAK_ADMIN
  KEYCLOAK_ADMIN_PASSWORD
  HBYS_PUBLIC_ISSUER
  HBYS_WEB_ORIGIN
)

umask 077
tmp_file="$(mktemp)"
for key in "${ORDER[@]}"; do
  printf '%s=%s\n' "$key" "${VALS[$key]}" >> "$tmp_file"
done
mv "$tmp_file" "$ENV_FILE"
chmod 600 "$ENV_FILE"

echo "[OK] .env dosyasi hazirlandi ($ENV_FILE). Tum servisler icin bagimsiz rastgele parolalar uretildi."
