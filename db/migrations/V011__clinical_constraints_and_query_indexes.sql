-- Cross-field constraints that protect clinical/operational state beyond individual columns.
ALTER TABLE adt.beds
    DROP CONSTRAINT IF EXISTS ck_beds_encounter_status_consistent;
ALTER TABLE adt.beds
    ADD CONSTRAINT ck_beds_encounter_status_consistent
    CHECK ((status = 'Occupied' AND current_encounter_id IS NOT NULL)
        OR (status <> 'Occupied' AND current_encounter_id IS NULL)) NOT VALID;
ALTER TABLE adt.beds VALIDATE CONSTRAINT ck_beds_encounter_status_consistent;

ALTER TABLE adt.admissions
    DROP CONSTRAINT IF EXISTS ck_admissions_discharge_timestamp;
ALTER TABLE adt.admissions
    ADD CONSTRAINT ck_admissions_discharge_timestamp
    CHECK ((status = 'Admitted' AND discharged_at IS NULL)
        OR (status = 'Discharged' AND discharged_at IS NOT NULL)) NOT VALID;
ALTER TABLE adt.admissions VALIDATE CONSTRAINT ck_admissions_discharge_timestamp;

ALTER TABLE pharmacy.prescriptions
    DROP CONSTRAINT IF EXISTS ck_prescriptions_dispense_timestamp;
ALTER TABLE pharmacy.prescriptions
    ADD CONSTRAINT ck_prescriptions_dispense_timestamp
    CHECK ((status = 'Pending' AND dispensed_at IS NULL)
        OR (status = 'Dispensed' AND dispensed_at IS NOT NULL)
        OR status = 'Cancelled') NOT VALID;
ALTER TABLE pharmacy.prescriptions VALIDATE CONSTRAINT ck_prescriptions_dispense_timestamp;

ALTER TABLE billing.invoices
    DROP CONSTRAINT IF EXISTS ck_invoices_paid_timestamp;
ALTER TABLE billing.invoices
    ADD CONSTRAINT ck_invoices_paid_timestamp
    CHECK ((status = 'Paid' AND paid_at IS NOT NULL)
        OR (status <> 'Paid' AND paid_at IS NULL)) NOT VALID;
ALTER TABLE billing.invoices VALIDATE CONSTRAINT ck_invoices_paid_timestamp;

ALTER TABLE pharmacy.stock_movements
    DROP CONSTRAINT IF EXISTS ck_stock_movement_sign;
ALTER TABLE pharmacy.stock_movements
    ADD CONSTRAINT ck_stock_movement_sign
    CHECK ((movement_type = 'Receipt' AND quantity > 0)
        OR (movement_type = 'Dispense' AND quantity < 0)) NOT VALID;
ALTER TABLE pharmacy.stock_movements VALIDATE CONSTRAINT ck_stock_movement_sign;

CREATE INDEX IF NOT EXISTS ix_beds_status_location
    ON adt.beds(status, ward, room, bed_no);
CREATE INDEX IF NOT EXISTS ix_orders_type_status_created
    ON clinical.orders(order_type, status, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_encounters_patient_status_opened
    ON patient.encounters(patient_id, status, opened_at DESC);
CREATE INDEX IF NOT EXISTS ix_stock_movements_drug_created
    ON pharmacy.stock_movements(drug_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS ix_lis_inbox_source_received
    ON lis.inbox_messages(source_system, received_at DESC);
