-- 009_email_event_append_only.sql
-- Mirrors apps/api/docs/evidence-event.sql (append-only trigger pattern).

REVOKE UPDATE, DELETE, TRUNCATE ON email_event FROM "<app-role>";

CREATE OR REPLACE FUNCTION email_event_no_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'email_event is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS email_event_no_update_delete ON email_event;
CREATE TRIGGER email_event_no_update_delete
  BEFORE UPDATE OR DELETE ON email_event
  FOR EACH ROW EXECUTE FUNCTION email_event_no_mutation();
