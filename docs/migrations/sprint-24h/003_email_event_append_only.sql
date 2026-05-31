-- 003_email_event_append_only.sql
-- Mirrors the apps/api/docs/evidence-event.sql append-only pattern.
--
-- App role on apex-prod-db is "apexadmin", which also owns the tables.
-- REVOKE on the owner is a Postgres no-op; the BEFORE UPDATE/DELETE trigger
-- below is the actual enforcement. The REVOKE is kept as documentary intent
-- so any future non-owner app role inherits the restriction automatically.
--
-- Apply order: AFTER 002_sprint24h_canonical.sql (email_event table must exist).

REVOKE UPDATE, DELETE, TRUNCATE ON email_event FROM apexadmin;

CREATE OR REPLACE FUNCTION email_event_no_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'email_event is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS email_event_no_update_delete ON email_event;
CREATE TRIGGER email_event_no_update_delete
  BEFORE UPDATE OR DELETE ON email_event
  FOR EACH ROW EXECUTE FUNCTION email_event_no_mutation();
