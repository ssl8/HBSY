-- Limit cross-service patient-data reads to the exact columns each workflow needs.
-- patient_svc remains the owner-facing master-data boundary; all other services use projections.
REVOKE SELECT ON TABLE patient.patients FROM clinical_svc, adt_svc, pharmacy_svc,
  billing_svc, publichealth_svc, lis_svc;
REVOKE SELECT ON TABLE patient.encounters FROM clinical_svc, adt_svc, pharmacy_svc,
  billing_svc, lis_svc;
REVOKE UPDATE ON TABLE patient.encounters FROM adt_svc;

-- Clinical, ADT, pharmacy and billing need identity/display columns, never contact or demographic data.
GRANT SELECT (id, mrn, given_name, family_name) ON patient.patients TO clinical_svc,
  adt_svc, pharmacy_svc, billing_svc;

-- Public health additionally checks date-of-birth and active status for vaccination validation.
GRANT SELECT (id, mrn, given_name, family_name, birth_date, active)
  ON patient.patients TO publichealth_svc;

-- LIS matches HL7 PID-3 only; names, birth date, phone and other fields are unnecessary.
GRANT SELECT (id, mrn) ON patient.patients TO lis_svc;

-- Encounter projections vary by service; no cross-service access to chief complaint or timestamps.
GRANT SELECT (id, patient_id, status) ON patient.encounters TO clinical_svc, adt_svc, pharmacy_svc;
-- Billing's encounter picker returns current status to prevent invoicing closed encounters.
GRANT SELECT (id, patient_id, status) ON patient.encounters TO billing_svc;
GRANT SELECT (id, patient_id) ON patient.encounters TO lis_svc;
GRANT UPDATE (status, closed_at) ON patient.encounters TO adt_svc;
