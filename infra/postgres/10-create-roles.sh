#!/usr/bin/env bash
set -euo pipefail

: "${HBYS_MIGRATOR_PASSWORD:?HBYS_MIGRATOR_PASSWORD is required}"
: "${KEYCLOAK_DB_PASSWORD:?KEYCLOAK_DB_PASSWORD is required}"
: "${PATIENT_DB_PASSWORD:?PATIENT_DB_PASSWORD is required}"
: "${CLINICAL_DB_PASSWORD:?CLINICAL_DB_PASSWORD is required}"
: "${ADT_DB_PASSWORD:?ADT_DB_PASSWORD is required}"
: "${PHARMACY_DB_PASSWORD:?PHARMACY_DB_PASSWORD is required}"
: "${BILLING_DB_PASSWORD:?BILLING_DB_PASSWORD is required}"
: "${PUBLICHEALTH_DB_PASSWORD:?PUBLICHEALTH_DB_PASSWORD is required}"
: "${LIS_DB_PASSWORD:?LIS_DB_PASSWORD is required}"
: "${INTEGRATION_DB_PASSWORD:?INTEGRATION_DB_PASSWORD is required}"
: "${AUDIT_DB_PASSWORD:?AUDIT_DB_PASSWORD is required}"

CONNECTOR_DB_PASSWORD="${CONNECTOR_DB_PASSWORD:-$INTEGRATION_DB_PASSWORD}"
INTEGRATION_WORKER_DB_PASSWORD="${INTEGRATION_WORKER_DB_PASSWORD:-$INTEGRATION_DB_PASSWORD}"

# Passwords are supplied as psql variables and quoted by psql, never interpolated into SQL.
psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v migrator_password="$HBYS_MIGRATOR_PASSWORD" \
  -v keycloak_password="$KEYCLOAK_DB_PASSWORD" \
  -v patient_password="$PATIENT_DB_PASSWORD" \
  -v clinical_password="$CLINICAL_DB_PASSWORD" \
  -v adt_password="$ADT_DB_PASSWORD" \
  -v pharmacy_password="$PHARMACY_DB_PASSWORD" \
  -v billing_password="$BILLING_DB_PASSWORD" \
  -v publichealth_password="$PUBLICHEALTH_DB_PASSWORD" \
  -v lis_password="$LIS_DB_PASSWORD" \
  -v integration_password="$INTEGRATION_DB_PASSWORD" \
  -v connector_password="$CONNECTOR_DB_PASSWORD" \
  -v integration_worker_password="$INTEGRATION_WORKER_DB_PASSWORD" \
  -v audit_password="$AUDIT_DB_PASSWORD" <<'SQL'
CREATE ROLE hbys_owner NOLOGIN;
CREATE ROLE hbys_migrator LOGIN NOINHERIT PASSWORD :'migrator_password';
CREATE ROLE keycloak_app LOGIN PASSWORD :'keycloak_password';
CREATE ROLE patient_svc LOGIN NOINHERIT PASSWORD :'patient_password';
CREATE ROLE clinical_svc LOGIN NOINHERIT PASSWORD :'clinical_password';
CREATE ROLE adt_svc LOGIN NOINHERIT PASSWORD :'adt_password';
CREATE ROLE pharmacy_svc LOGIN NOINHERIT PASSWORD :'pharmacy_password';
CREATE ROLE billing_svc LOGIN NOINHERIT PASSWORD :'billing_password';
CREATE ROLE publichealth_svc LOGIN NOINHERIT PASSWORD :'publichealth_password';
CREATE ROLE lis_svc LOGIN NOINHERIT PASSWORD :'lis_password';
CREATE ROLE integration_svc LOGIN NOINHERIT PASSWORD :'integration_password';
CREATE ROLE connector_svc LOGIN NOINHERIT PASSWORD :'connector_password';
CREATE ROLE integration_worker LOGIN NOINHERIT PASSWORD :'integration_worker_password';
CREATE ROLE audit_svc LOGIN NOINHERIT PASSWORD :'audit_password';

GRANT hbys_owner TO hbys_migrator;
ALTER DATABASE hbys OWNER TO hbys_owner;
REVOKE CONNECT ON DATABASE hbys FROM PUBLIC;
GRANT CONNECT ON DATABASE hbys TO hbys_owner, hbys_migrator, keycloak_app,
  patient_svc, clinical_svc, adt_svc, pharmacy_svc, billing_svc,
  publichealth_svc, lis_svc, integration_svc, connector_svc, integration_worker, audit_svc;

-- The migration owner creates all application objects; runtime roles cannot own or alter them.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO hbys_owner;
CREATE SCHEMA keycloak AUTHORIZATION keycloak_app;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
SQL
