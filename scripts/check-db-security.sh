#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

docker compose exec -T postgres psql -X -U postgres -d hbys -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE
    role_name text;
    runtime_roles text[] := ARRAY[
      'patient_svc','clinical_svc','adt_svc','pharmacy_svc','billing_svc',
      'publichealth_svc','lis_svc','integration_svc','connector_svc','integration_worker','audit_svc'
    ];
    service_schemas text[] := ARRAY[
      'patient','clinical','adt','pharmacy','billing','publichealth','lis','integration','audit'
    ];
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hbys_owner' AND rolcanlogin=false) THEN
      RAISE EXCEPTION 'hbys_owner must be a NOLOGIN role';
    END IF;

    FOREACH role_name IN ARRAY (runtime_roles || ARRAY['hbys_migrator','keycloak_app']) LOOP
      IF NOT EXISTS (
        SELECT 1 FROM pg_roles
         WHERE rolname=role_name AND rolcanlogin=true AND rolsuper=false AND rolcreatedb=false
           AND rolcreaterole=false AND rolreplication=false AND rolbypassrls=false
      ) THEN
        RAISE EXCEPTION 'Role % is missing or over-privileged', role_name;
      END IF;
    END LOOP;

    FOREACH role_name IN ARRAY runtime_roles LOOP
      IF (SELECT rolinherit FROM pg_roles WHERE rolname=role_name) IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'Runtime role % must use NOINHERIT', role_name;
      END IF;
      IF has_schema_privilege(role_name, 'public', 'CREATE') THEN
        RAISE EXCEPTION 'Runtime role % can CREATE in public schema', role_name;
      END IF;
      IF EXISTS (
        SELECT 1
          FROM pg_class c
          JOIN pg_namespace n ON n.oid=c.relnamespace
          JOIN pg_roles r ON r.oid=c.relowner
         WHERE n.nspname = ANY(service_schemas)
           AND r.rolname = role_name
           AND c.relkind IN ('r','p','S','v','m')
      ) THEN
        RAISE EXCEPTION 'Runtime role % owns application database objects', role_name;
      END IF;
      IF has_table_privilege(role_name, 'audit.events', 'UPDATE')
         OR has_table_privilege(role_name, 'audit.events', 'DELETE')
         OR has_table_privilege(role_name, 'audit.events', 'TRUNCATE') THEN
        RAISE EXCEPTION 'Runtime role % can mutate or truncate audit.events', role_name;
      END IF;
    END LOOP;

    IF NOT has_table_privilege('patient_svc','patient.patients','INSERT') THEN
      RAISE EXCEPTION 'patient_svc lacks patient registration permission';
    END IF;
    IF NOT has_table_privilege('clinical_svc','clinical.orders','INSERT') THEN
      RAISE EXCEPTION 'clinical_svc lacks clinical order permission';
    END IF;
    IF NOT has_column_privilege('integration_svc','integration.outbox','status','UPDATE')
       OR NOT has_column_privilege('integration_svc','integration.outbox','id','SELECT') THEN
      RAISE EXCEPTION 'integration_svc cannot safely inspect and requeue outbox metadata';
    END IF;
    IF has_table_privilege('clinical_svc','billing.invoices','SELECT') THEN
      RAISE EXCEPTION 'clinical_svc must not read billing.invoices';
    END IF;

    -- Cross-service patient data is granted column-by-column; no service may inherit table-wide reads.
    FOREACH role_name IN ARRAY ARRAY[
      'clinical_svc','adt_svc','pharmacy_svc','billing_svc','publichealth_svc','lis_svc','connector_svc','integration_worker'
    ] LOOP
      IF has_table_privilege(role_name,'patient.patients','SELECT')
         OR has_table_privilege(role_name,'patient.encounters','SELECT') THEN
        RAISE EXCEPTION 'Service % has table-wide access to patient PHI', role_name;
      END IF;
    END LOOP;

    IF NOT has_column_privilege('clinical_svc','patient.patients','mrn','SELECT')
       OR NOT has_column_privilege('clinical_svc','patient.patients','given_name','SELECT')
       OR NOT has_column_privilege('clinical_svc','patient.patients','allergies','SELECT')
       OR has_column_privilege('clinical_svc','patient.patients','birth_date','SELECT')
       OR has_column_privilege('clinical_svc','patient.patients','phone','SELECT')
       OR NOT has_column_privilege('clinical_svc','patient.encounters','status','SELECT') THEN
      RAISE EXCEPTION 'clinical_svc patient projection grants are incorrect';
    END IF;

    IF NOT has_column_privilege('adt_svc','patient.patients','mrn','SELECT')
       OR has_column_privilege('adt_svc','patient.patients','birth_date','SELECT')
       OR has_column_privilege('adt_svc','patient.patients','phone','SELECT')
       OR NOT has_column_privilege('adt_svc','patient.encounters','status','SELECT')
       OR NOT has_column_privilege('adt_svc','patient.encounters','closed_at','UPDATE')
       OR has_column_privilege('adt_svc','patient.encounters','patient_id','UPDATE')
       OR has_table_privilege('adt_svc','patient.encounters','UPDATE') THEN
      RAISE EXCEPTION 'adt_svc patient projection/update grants are incorrect';
    END IF;

    IF NOT has_column_privilege('pharmacy_svc','patient.patients','mrn','SELECT')
       OR NOT has_column_privilege('pharmacy_svc','patient.patients','family_name','SELECT')
       OR NOT has_column_privilege('pharmacy_svc','patient.patients','allergies','SELECT')
       OR has_column_privilege('pharmacy_svc','patient.patients','birth_date','SELECT')
       OR has_column_privilege('pharmacy_svc','patient.patients','phone','SELECT')
       OR NOT has_column_privilege('pharmacy_svc','patient.encounters','status','SELECT') THEN
      RAISE EXCEPTION 'pharmacy_svc patient projection grants are incorrect';
    END IF;

    IF NOT has_column_privilege('billing_svc','patient.patients','mrn','SELECT')
       OR NOT has_column_privilege('billing_svc','patient.patients','given_name','SELECT')
       OR has_column_privilege('billing_svc','patient.patients','birth_date','SELECT')
       OR has_column_privilege('billing_svc','patient.patients','phone','SELECT')
       OR NOT has_column_privilege('billing_svc','patient.encounters','status','SELECT')
       OR has_column_privilege('billing_svc','patient.encounters','chief_complaint','SELECT')
       OR has_column_privilege('billing_svc','patient.encounters','opened_at','SELECT') THEN
      RAISE EXCEPTION 'billing_svc patient projection grants are incorrect';
    END IF;

    IF NOT has_column_privilege('publichealth_svc','patient.patients','birth_date','SELECT')
       OR NOT has_column_privilege('publichealth_svc','patient.patients','active','SELECT')
       OR has_column_privilege('publichealth_svc','patient.patients','phone','SELECT')
       OR has_column_privilege('publichealth_svc','patient.patients','blood_type','SELECT')
       OR has_column_privilege('publichealth_svc','patient.patients','active','UPDATE')
       OR has_table_privilege('publichealth_svc','patient.patients','UPDATE') THEN
      RAISE EXCEPTION 'publichealth_svc patient projection grants are incorrect';
    END IF;

    IF NOT has_column_privilege('lis_svc','patient.patients','mrn','SELECT')
       OR has_column_privilege('lis_svc','patient.patients','given_name','SELECT')
       OR has_column_privilege('lis_svc','patient.patients','birth_date','SELECT')
       OR has_column_privilege('lis_svc','patient.patients','phone','SELECT')
       OR has_column_privilege('lis_svc','patient.encounters','status','SELECT') THEN
      RAISE EXCEPTION 'lis_svc patient projection grants are incorrect';
    END IF;

    IF NOT has_column_privilege('connector_svc','patient.patients','mrn','SELECT')
       OR has_column_privilege('connector_svc','patient.patients','birth_date','SELECT')
       OR has_column_privilege('connector_svc','patient.patients','phone','SELECT')
       OR has_column_privilege('connector_svc','integration.outbox','payload','SELECT')
       OR has_table_privilege('connector_svc','integration.outbox','UPDATE') THEN
      RAISE EXCEPTION 'connector_svc least-privilege grants are incorrect';
    END IF;

    IF NOT has_column_privilege('integration_worker','integration.outbox','payload','SELECT')
       OR NOT has_column_privilege('integration_worker','integration.outbox','status','UPDATE')
       OR NOT has_column_privilege('integration_worker','integration.outbox','attempts','UPDATE')
       OR has_column_privilege('integration_worker','integration.outbox','payload','UPDATE')
       OR has_table_privilege('integration_worker','integration.outbox','DELETE')
       OR has_table_privilege('integration_worker','billing.invoices','SELECT') THEN
      RAISE EXCEPTION 'integration_worker least-privilege outbox grants are incorrect';
    END IF;

    FOREACH role_name IN ARRAY ARRAY[
      'patient_svc','clinical_svc','adt_svc','pharmacy_svc','billing_svc',
      'publichealth_svc','lis_svc','connector_svc','audit_svc'
    ] LOOP
      IF has_table_privilege(role_name,'integration.outbox','UPDATE')
         OR has_table_privilege(role_name,'integration.outbox','DELETE') THEN
        RAISE EXCEPTION 'Outbox producer/audit role % can mutate outbox state', role_name;
      END IF;
    END LOOP;

    FOREACH role_name IN ARRAY ARRAY[
      'patient_svc','clinical_svc','adt_svc','pharmacy_svc','billing_svc',
      'publichealth_svc','lis_svc','integration_svc','connector_svc','integration_worker'
    ] LOOP
      IF has_column_privilege(role_name,'audit.events','details_json','SELECT') THEN
        RAISE EXCEPTION 'Non-audit role % can read audit details', role_name;
      END IF;
    END LOOP;

    IF (SELECT r.rolname FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner WHERE c.oid='audit.events'::regclass) <> 'hbys_owner' THEN
      RAISE EXCEPTION 'audit.events must be owned by hbys_owner';
    END IF;
    IF NOT has_table_privilege('audit_svc','audit.events','SELECT') THEN
      RAISE EXCEPTION 'audit_svc must be able to read the audit chain';
    END IF;
    FOREACH role_name IN ARRAY ARRAY[
      'patient_svc','clinical_svc','adt_svc','pharmacy_svc','billing_svc','publichealth_svc','lis_svc','connector_svc'
    ] LOOP
      IF NOT has_column_privilege(role_name,'integration.outbox','id','SELECT')
         OR NOT has_column_privilege(role_name,'integration.outbox','idempotency_key','SELECT')
         OR has_column_privilege(role_name,'integration.outbox','payload','SELECT') THEN
        RAISE EXCEPTION 'Outbox producer % idempotency column grants are incorrect', role_name;
      END IF;
    END LOOP;
    IF NOT has_column_privilege('patient_svc','integration.outbox','status','SELECT')
       OR has_column_privilege('patient_svc','integration.outbox','created_at','SELECT')
       OR has_column_privilege('patient_svc','integration.outbox','payload','SELECT') THEN
      RAISE EXCEPTION 'patient_svc dashboard outbox grants expose too much or too little data';
    END IF;
    IF has_table_privilege('integration_svc','integration.outbox','DELETE')
       OR has_table_privilege('integration_svc','integration.outbox','TRUNCATE')
       OR has_table_privilege('integration_svc','integration.outbox','UPDATE')
       OR has_column_privilege('integration_svc','integration.outbox','payload','SELECT')
       OR has_column_privilege('integration_svc','integration.outbox','payload','UPDATE')
       OR has_column_privilege('integration_svc','integration.outbox','attempts','UPDATE') THEN
      RAISE EXCEPTION 'integration_svc has broader than metadata retry privileges';
    END IF;
    FOREACH role_name IN ARRAY ARRAY[
      'clinical_svc','adt_svc','pharmacy_svc','billing_svc','publichealth_svc','lis_svc'
    ] LOOP
      IF has_column_privilege(role_name,'integration.outbox','payload','SELECT')
         OR has_column_privilege(role_name,'integration.outbox','created_at','SELECT')
         OR has_column_privilege(role_name,'integration.outbox','aggregate_id','SELECT') THEN
        RAISE EXCEPTION 'Outbox producer % has broader than idempotency read access', role_name;
      END IF;
      IF role_name <> 'patient_svc'
         AND has_column_privilege(role_name,'integration.outbox','status','SELECT') THEN
        RAISE EXCEPTION 'Outbox producer % must not read queue status', role_name;
      END IF;
    END LOOP;

    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'integration' AND column_name = 'tc_kimlik'
    ) THEN
      RAISE EXCEPTION 'Raw tc_kimlik column must not exist in integration schema';
    END IF;

    IF EXISTS (
      SELECT current_encounter_id FROM adt.beds
      WHERE current_encounter_id IS NOT NULL
      GROUP BY current_encounter_id HAVING count(*) > 1
    ) THEN
      RAISE EXCEPTION 'Duplicate encounter assignment detected in adt.beds';
    END IF;

    IF (SELECT count(*) FROM public.schema_migrations WHERE version = ANY(ARRAY[
      'V001__baseline.sql','V002__synthetic_demo_seed.sql','V003__lis_hl7_inbox.sql',
      'V004__prescription_usage.sql','V005__adt_active_bed_guard.sql','V006__radiology_reports.sql',
      'V007__audit_hash_columns_and_truncate_guard.sql','V008__least_privilege_runtime_roles.sql',
      'V009__adt_bed_transfer_history.sql','V010__pharmacy_stock_receipt_idempotency.sql',
      'V011__clinical_constraints_and_query_indexes.sql','V012__database_enforced_audit_chain.sql',
      'V013__integration_payload_column_isolation.sql','V014__patient_phi_column_isolation.sql',
      'V015__connectors_and_extended_demo_seed.sql','V016__clinical_depth_and_security_hardening.sql'
    ])) <> 16 THEN
      RAISE EXCEPTION 'All 16 ordered database migrations must be recorded as applied';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='adt' AND indexname='ux_active_admission_encounter') THEN
      RAISE EXCEPTION 'Active-admission uniqueness index is missing';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='pharmacy' AND indexname='ux_stock_receipt_document_drug') THEN
      RAISE EXCEPTION 'Stock-receipt idempotency index is missing';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='ck_beds_encounter_status_consistent') THEN
      RAISE EXCEPTION 'Bed/encounter consistency constraint is missing';
    END IF;
    IF to_regclass('clinical.vitals') IS NULL
       OR to_regclass('clinical.clinical_notes') IS NULL
       OR to_regclass('integration.enabiz_packages') IS NULL
       OR to_regclass('integration.its_verifications') IS NULL THEN
      RAISE EXCEPTION 'Stage 4 V016 tables are missing';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger t
      WHERE t.tgrelid='audit.events'::regclass
        AND t.tgname='audit_events_validate_insert'
        AND t.tgenabled='O'
        AND NOT t.tgisinternal
    ) THEN
      RAISE EXCEPTION 'Database-level audit chain validation trigger is missing or disabled';
    END IF;
    IF to_regprocedure('audit.validate_event_insert()') IS NULL THEN
      RAISE EXCEPTION 'Database audit validation function is missing';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname='pgcrypto') THEN
      RAISE EXCEPTION 'pgcrypto extension is missing';
    END IF;
END $$;

-- Prove the database trigger rejects a forged event even when the caller may INSERT.
BEGIN;
SET LOCAL ROLE patient_svc;
DO $$
BEGIN
  BEGIN
    INSERT INTO audit.events(occurred_at,username,role,action,entity_type,entity_id,details_json,previous_hash,event_hash,canonical_payload)
    VALUES (now(),'security-check','patient_svc','SECURITY_CHECK','test',NULL,'{}'::jsonb,repeat('0',64),repeat('0',64),'{}');
    RAISE EXCEPTION 'Database audit-chain trigger accepted a forged event';
  EXCEPTION WHEN check_violation THEN
    NULL; -- Expected: the trigger rejected the invalid chain/hash/payload.
  END;
END $$;
ROLLBACK;
RESET ROLE;
SELECT 'database role, schema isolation, outbox grants, V015-V016 hardening, and audit-chain enforcement checks passed' AS result;
SQL
