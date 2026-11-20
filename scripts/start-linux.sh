#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "============================================================"
echo "  NOVA HBYS — STAGE 4 KURUMSAL KURULUM (LINUX / PARDUS)"
echo "============================================================"

if ! command -v docker >/dev/null 2>&1; then
  echo "[HATA] Docker kurulu degil. Once Docker Engine / Compose V2 kurun."
  echo "Alternatif olarak hizli demonstrasyon icin Node.js 22+ ile: node server.js"
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "[HATA] 'docker compose' (Compose V2) bulunamadi."
  exit 1
fi

bash scripts/init-env.sh

echo "[1/4] PostgreSQL 18 baslatiliyor..."
docker compose up -d postgres

echo "[2/4] Veritabani migration dosyalari (V001..V016) uygulaniyor..."
docker compose run --rm db-migrate

echo "[3/4] Tum .NET 10 mikroservisleri, Keycloak ve Nginx derlenip baslatiliyor..."
docker compose up -d --build

echo "[4/4] Servislerin ve Keycloak OIDC sunucusunun hazir olmasi bekleniyor..."
CHECKS=(
  "http://127.0.0.1:8088/health"
  "http://127.0.0.1:8088/api/config"
  "http://127.0.0.1:8088/health/patient"
  "http://127.0.0.1:8088/health/clinical"
  "http://127.0.0.1:8088/health/adt"
  "http://127.0.0.1:8088/health/pharmacy"
  "http://127.0.0.1:8088/health/billing"
  "http://127.0.0.1:8088/health/publichealth"
  "http://127.0.0.1:8088/health/lis"
  "http://127.0.0.1:8088/health/integration"
  "http://127.0.0.1:8088/health/audit"
  "http://127.0.0.1:8088/health/connector"
  "http://127.0.0.1:8088/health/worker"
  "http://127.0.0.1:8080/realms/hbys/.well-known/openid-configuration"
)

DEADLINE=$((SECONDS + 240))
while (( SECONDS < DEADLINE )); do
  ALL_OK=true
  for url in "${CHECKS[@]}"; do
    if ! curl -fsS --max-time 4 "$url" >/dev/null 2>&1; then
      ALL_OK=false
      break
    fi
  done
  if [[ "$ALL_OK" == true ]]; then
    echo ""
    echo "[BASARILI] NOVA HBYS Kurumsal Ortam Hazir!"
    echo "  Web Arayuzu  : http://localhost:8088"
    echo "  Keycloak OIDC: http://localhost:8080"
    echo "  Guvenlik Test: bash scripts/check-db-security.sh"
    exit 0
  fi
  sleep 4
done

echo "[UYARI] Bazi servisler 4 dakika icinde hazir olmadi. Durum kontrolu:"
docker compose ps
exit 1
