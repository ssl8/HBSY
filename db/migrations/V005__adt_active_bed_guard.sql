-- Prevent concurrent or alternate-path allocation of an occupied bed.
CREATE UNIQUE INDEX IF NOT EXISTS ux_active_admission_bed
    ON adt.admissions(bed_id) WHERE status = 'Admitted';
