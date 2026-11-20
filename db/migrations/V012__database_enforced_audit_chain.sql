-- Enforce audit hash-chain integrity at the database boundary, not only in application code.
-- SECURITY DEFINER is used so runtime roles need access only to the audit cursor columns.
CREATE OR REPLACE FUNCTION audit.validate_event_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, audit, public
AS $$
DECLARE
    last_id bigint;
    last_hash text;
    payload jsonb;
    expected_hash text;
BEGIN
    -- All writers serialize on this transaction-scoped lock, including direct SQL inserts.
    PERFORM pg_catalog.pg_advisory_xact_lock(71420531);

    SELECT e.id, e.event_hash
      INTO last_id, last_hash
      FROM audit.events AS e
     ORDER BY e.id DESC
     LIMIT 1;

    -- Sequence values are allocated before BEFORE INSERT triggers run.
    -- Reject a writer that acquired the chain lock after a higher id was committed.
    IF last_id IS NOT NULL AND NEW.id <= last_id THEN
        RAISE EXCEPTION 'audit event id is out of chain order' USING ERRCODE = '23514';
    END IF;
    last_hash := COALESCE(last_hash, repeat('0', 64));
    IF NEW.previous_hash IS DISTINCT FROM last_hash THEN
        RAISE EXCEPTION 'audit chain previous_hash mismatch' USING ERRCODE = '23514';
    END IF;

    BEGIN
        payload := NEW.canonical_payload::jsonb;
    EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'audit canonical_payload is not valid JSON' USING ERRCODE = '23514';
    END;

    expected_hash := encode(public.digest(NEW.canonical_payload, 'sha256'), 'hex');
    IF lower(NEW.event_hash) IS DISTINCT FROM expected_hash THEN
        RAISE EXCEPTION 'audit event_hash does not match canonical_payload' USING ERRCODE = '23514';
    END IF;

    IF payload ->> 'previous_hash' IS DISTINCT FROM NEW.previous_hash
       OR payload ->> 'username' IS DISTINCT FROM NEW.username
       OR payload ->> 'role' IS DISTINCT FROM NEW.role
       OR payload ->> 'action' IS DISTINCT FROM NEW.action
       OR payload ->> 'entity_type' IS DISTINCT FROM NEW.entity_type
       OR payload ->> 'entity_id' IS DISTINCT FROM NEW.entity_id
       OR payload -> 'details' IS DISTINCT FROM NEW.details_json
       OR date_trunc('microseconds', (payload ->> 'occurred_at')::timestamptz)
            IS DISTINCT FROM date_trunc('microseconds', NEW.occurred_at) THEN
        RAISE EXCEPTION 'audit canonical_payload does not match event columns' USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

ALTER FUNCTION audit.validate_event_insert() OWNER TO hbys_owner;
REVOKE ALL ON FUNCTION audit.validate_event_insert() FROM PUBLIC;
DROP TRIGGER IF EXISTS audit_events_validate_insert ON audit.events;
CREATE TRIGGER audit_events_validate_insert
BEFORE INSERT ON audit.events
FOR EACH ROW EXECUTE FUNCTION audit.validate_event_insert();
