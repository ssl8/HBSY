-- Least-privilege runtime roles. Objects are owned by hbys_owner (the migration role).
REVOKE ALL ON SCHEMA patient, clinical, adt, pharmacy, billing, publichealth, lis, integration, audit FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA patient, clinical, adt, pharmacy, billing, publichealth, lis, integration, audit FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA patient, clinical, adt, pharmacy, billing, publichealth, lis, integration, audit FROM PUBLIC;
REVOKE CONNECT ON DATABASE hbys FROM PUBLIC;

GRANT CONNECT ON DATABASE hbys TO hbys_migrator, keycloak_app,
  patient_svc, clinical_svc, adt_svc, pharmacy_svc, billing_svc,
  publichealth_svc, lis_svc, integration_svc, audit_svc;

-- Patient service: patient master, encounter intake, and dashboard read models.
GRANT USAGE ON SCHEMA patient, clinical, adt, pharmacy, integration, audit TO patient_svc;
GRANT SELECT, INSERT, UPDATE ON patient.patients, patient.encounters TO patient_svc;
GRANT SELECT ON clinical.orders, clinical.lab_results, adt.beds, pharmacy.prescriptions, integration.outbox TO patient_svc;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA patient TO patient_svc;

-- Clinical service: clinical orders, results, reports, and patient identity reads.
GRANT USAGE ON SCHEMA patient, clinical, integration, audit TO clinical_svc;
GRANT SELECT ON patient.patients, patient.encounters TO clinical_svc;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA clinical TO clinical_svc;
GRANT INSERT ON integration.outbox TO clinical_svc;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA clinical TO clinical_svc;

-- ADT service: patient encounter status changes are limited to this service.
GRANT USAGE ON SCHEMA patient, adt, integration, audit TO adt_svc;
GRANT SELECT ON patient.patients TO adt_svc;
GRANT SELECT, UPDATE ON patient.encounters TO adt_svc;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA adt TO adt_svc;
GRANT INSERT ON integration.outbox TO adt_svc;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA adt TO adt_svc;

-- Pharmacy service: inventory and prescription transaction boundary.
GRANT USAGE ON SCHEMA patient, pharmacy, integration, audit TO pharmacy_svc;
GRANT SELECT ON patient.encounters, patient.patients TO pharmacy_svc;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA pharmacy TO pharmacy_svc;
GRANT INSERT ON integration.outbox TO pharmacy_svc;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA pharmacy TO pharmacy_svc;

-- Billing service: financial records only, with patient/encounter lookup.
GRANT USAGE ON SCHEMA patient, billing, integration, audit TO billing_svc;
GRANT SELECT ON patient.encounters, patient.patients TO billing_svc;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA billing TO billing_svc;
GRANT INSERT ON integration.outbox TO billing_svc;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA billing TO billing_svc;

-- Public health service: patient lookup and vaccination records.
GRANT USAGE ON SCHEMA patient, publichealth, integration, audit TO publichealth_svc;
GRANT SELECT ON patient.patients TO publichealth_svc;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA publichealth TO publichealth_svc;
GRANT INSERT ON integration.outbox TO publichealth_svc;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA publichealth TO publichealth_svc;

-- LIS service: inbox and the limited clinical order/result tables needed for ORU processing.
GRANT USAGE ON SCHEMA patient, clinical, lis, integration, audit TO lis_svc;
GRANT SELECT ON patient.patients, patient.encounters TO lis_svc;
GRANT SELECT, INSERT, UPDATE ON clinical.orders, clinical.lab_results TO lis_svc;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA lis TO lis_svc;
GRANT INSERT ON integration.outbox TO lis_svc;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA lis TO lis_svc;
GRANT USAGE, SELECT ON SEQUENCE clinical.lab_results_id_seq TO lis_svc;

-- Integration service can inspect and requeue outbox items, but cannot edit clinical rows.
GRANT USAGE ON SCHEMA integration, audit TO integration_svc;
GRANT SELECT, UPDATE ON integration.outbox TO integration_svc;

-- Audit service is read-only for the chain, but its own authenticated GET access is logged.
GRANT USAGE ON SCHEMA audit TO audit_svc;
GRANT SELECT ON audit.events TO audit_svc;

-- All application services append audit events and can read only the chain cursor fields.
GRANT USAGE ON SCHEMA audit TO patient_svc, clinical_svc, adt_svc, pharmacy_svc,
  billing_svc, publichealth_svc, lis_svc, integration_svc, audit_svc;
GRANT SELECT (id, event_hash) ON audit.events TO patient_svc, clinical_svc, adt_svc,
  pharmacy_svc, billing_svc, publichealth_svc, lis_svc, integration_svc, audit_svc;
GRANT INSERT (occurred_at, username, role, action, entity_type, entity_id, details_json,
              previous_hash, event_hash, canonical_payload)
  ON audit.events TO patient_svc, clinical_svc, adt_svc, pharmacy_svc, billing_svc,
  publichealth_svc, lis_svc, integration_svc, audit_svc;
GRANT USAGE, SELECT ON SEQUENCE audit.events_id_seq TO patient_svc, clinical_svc, adt_svc,
  pharmacy_svc, billing_svc, publichealth_svc, lis_svc, integration_svc, audit_svc;

-- Producers enqueue only. The integration service owns state transitions (Pending/Retry).
GRANT USAGE ON SCHEMA integration TO patient_svc, clinical_svc, adt_svc,
  pharmacy_svc, billing_svc, publichealth_svc, lis_svc;
GRANT SELECT, INSERT ON integration.outbox TO patient_svc;
GRANT INSERT ON integration.outbox TO clinical_svc, adt_svc, pharmacy_svc,
  billing_svc, publichealth_svc, lis_svc;
GRANT USAGE, SELECT ON SEQUENCE integration.outbox_id_seq TO patient_svc,
  clinical_svc, adt_svc, pharmacy_svc, billing_svc, publichealth_svc, lis_svc;

-- Preserve least privilege as additional tables are introduced by later migrations.
ALTER DEFAULT PRIVILEGES FOR ROLE hbys_owner IN SCHEMA patient
  GRANT SELECT, INSERT, UPDATE ON TABLES TO patient_svc;
ALTER DEFAULT PRIVILEGES FOR ROLE hbys_owner IN SCHEMA adt
  GRANT SELECT, INSERT, UPDATE ON TABLES TO adt_svc;
ALTER DEFAULT PRIVILEGES FOR ROLE hbys_owner IN SCHEMA pharmacy
  GRANT SELECT, INSERT, UPDATE ON TABLES TO pharmacy_svc;
ALTER DEFAULT PRIVILEGES FOR ROLE hbys_owner IN SCHEMA billing
  GRANT SELECT, INSERT, UPDATE ON TABLES TO billing_svc;
ALTER DEFAULT PRIVILEGES FOR ROLE hbys_owner IN SCHEMA publichealth
  GRANT SELECT, INSERT, UPDATE ON TABLES TO publichealth_svc;
ALTER DEFAULT PRIVILEGES FOR ROLE hbys_owner IN SCHEMA lis
  GRANT SELECT, INSERT, UPDATE ON TABLES TO lis_svc;
ALTER DEFAULT PRIVILEGES FOR ROLE hbys_owner IN SCHEMA integration
  GRANT SELECT, UPDATE ON TABLES TO integration_svc;
ALTER DEFAULT PRIVILEGES FOR ROLE hbys_owner IN SCHEMA patient
  GRANT USAGE, SELECT ON SEQUENCES TO patient_svc;
ALTER DEFAULT PRIVILEGES FOR ROLE hbys_owner IN SCHEMA adt
  GRANT USAGE, SELECT ON SEQUENCES TO adt_svc;
ALTER DEFAULT PRIVILEGES FOR ROLE hbys_owner IN SCHEMA pharmacy
  GRANT USAGE, SELECT ON SEQUENCES TO pharmacy_svc;
ALTER DEFAULT PRIVILEGES FOR ROLE hbys_owner IN SCHEMA billing
  GRANT USAGE, SELECT ON SEQUENCES TO billing_svc;
ALTER DEFAULT PRIVILEGES FOR ROLE hbys_owner IN SCHEMA publichealth
  GRANT USAGE, SELECT ON SEQUENCES TO publichealth_svc;
ALTER DEFAULT PRIVILEGES FOR ROLE hbys_owner IN SCHEMA lis
  GRANT USAGE, SELECT ON SEQUENCES TO lis_svc;
