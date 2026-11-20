ALTER TABLE pharmacy.prescription_items
    ADD COLUMN IF NOT EXISTS usage_instruction VARCHAR(500);
