-- Tighten the integration API identity to metadata-only access.
-- This migration is intentionally additive so databases that already recorded V008
-- receive the security correction without rewriting migration history.
REVOKE ALL PRIVILEGES ON TABLE integration.outbox FROM integration_svc, patient_svc;
ALTER DEFAULT PRIVILEGES FOR ROLE hbys_owner IN SCHEMA integration
  REVOKE SELECT, UPDATE ON TABLES FROM integration_svc;

GRANT USAGE ON SCHEMA integration TO integration_svc, patient_svc;
GRANT INSERT ON integration.outbox TO patient_svc;
GRANT SELECT (status) ON integration.outbox TO patient_svc;
GRANT SELECT (id, target, event_type, aggregate_type, aggregate_id, status,
              attempts, created_at, next_attempt_at, last_error)
  ON integration.outbox TO integration_svc;
GRANT UPDATE (status, last_error, next_attempt_at)
  ON integration.outbox TO integration_svc;


-- Every outbox producer needs only the generated ID and idempotency key for
-- INSERT ... RETURNING and the conflict fallback; no producer receives payload access.
GRANT SELECT (id, idempotency_key) ON integration.outbox TO patient_svc, clinical_svc,
  adt_svc, pharmacy_svc, billing_svc, publichealth_svc, lis_svc;
