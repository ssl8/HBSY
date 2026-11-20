-- Upgrade existing development databases created before the audit hash-column fix.
ALTER TABLE audit.events
    ALTER COLUMN previous_hash TYPE VARCHAR(64) USING rtrim(previous_hash),
    ALTER COLUMN event_hash TYPE VARCHAR(64) USING rtrim(event_hash);

CREATE OR REPLACE FUNCTION audit.reject_event_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'audit.events is append-only';
END;
$$;

DROP TRIGGER IF EXISTS audit_events_no_truncate ON audit.events;
CREATE TRIGGER audit_events_no_truncate
BEFORE TRUNCATE ON audit.events
FOR EACH STATEMENT EXECUTE FUNCTION audit.reject_event_mutation();
