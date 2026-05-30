-- 009_email_event_append_only.down.sql
DROP TRIGGER IF EXISTS email_event_no_update_delete ON email_event;
DROP FUNCTION IF EXISTS email_event_no_mutation();
