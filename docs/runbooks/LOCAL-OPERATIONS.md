# Yerel Ortam Operasyonları (Stage 4)

## Sağlık Kontrolleri

- Gateway: `http://localhost:8088/health`
- Runtime keşif uç noktası: `http://localhost:8088/api/config`
- Servis readiness uç noktaları:
  - `/health/patient`, `/health/clinical`, `/health/adt`, `/health/pharmacy`
  - `/health/billing`, `/health/publichealth`, `/health/lis`
  - `/health/integration`, `/health/audit`, `/health/connector`, `/health/worker`
- Keycloak OIDC discovery: `http://localhost:8080/realms/hbys/.well-known/openid-configuration`

## Log Toplama

```bash
docker compose ps
docker compose logs --tail 200 postgres db-migrate
docker compose logs --tail 200 keycloak
docker compose logs --tail 200 patient-svc clinical-svc adt-svc pharmacy-svc billing-svc publichealth-svc lis-svc integration-svc audit-svc connector-svc integration-worker
```

## Sorun Giderme

| Belirti | Muhtemel neden | Kontrol |
|---|---|---|
| `8088` açılmıyor | Gateway başlamadı veya port dolu | `docker compose ps`, `docker compose logs web-gateway` |
| Keycloak ekranı gelmiyor | Realm import veya DB bağlantı hatası | `docker compose logs keycloak db-migrate` |
| Login sonrası `401` | Issuer/origin uyumsuzluğu | `.env` `HBYS_PUBLIC_ISSUER` ve `HBYS_WEB_ORIGIN` değerleri, API logları |
| API `502` | İlgili mikroservis derlenemedi/çöktü | `docker compose logs <servis-adi>` |
| Migration hatası | Eski/bozuk DB volume veya sıra hatası | `docker compose logs db-migrate`; yalnızca test ortamında `reset-demo.bat` veya `docker compose down -v` |
| HL7 AE ACK | Hasta MRN veya LAB istem/tür uyumsuzluğu | `GET /api/lis/inbox`, klinik istem listesi |
| Outbox birikmesi | Worker beklemede veya hedef kapalı | `docker compose logs integration-worker`, `GET /api/integrations` |

## Yedekleme (Test / Demo Veri Koruma)

```bash
docker compose exec -T postgres sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > hbys-demo.dump
```

Yedekten dönüş prosedürünü test ortamında doğrulamadan üretim veritabanına uygulamayın.

## Stage 4 Veritabanı Güvenlik Kontrolleri

```bash
# Servis rollerinin yetkilerini ve V001..V016 izolasyonunu doğrula
bash scripts/check-db-security.sh

# Uygulanan migration sürümlerini görüntüle
docker compose exec postgres psql -U postgres -d hbys -c "SELECT version, applied_at FROM public.schema_migrations ORDER BY version;"

# Yalnızca test ortamında sıfırlama
docker compose down -v
```

`.env` dosyasını paylaşmayın ve Git deposuna yüklemeyin. Detaylı kurulum adımları için [TEKNISYEN-KURULUM-REHBERI.md](TEKNISYEN-KURULUM-REHBERI.md) belgesine bakın.
