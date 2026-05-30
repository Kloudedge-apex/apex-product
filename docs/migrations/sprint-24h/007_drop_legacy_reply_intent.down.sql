-- 007_drop_legacy_reply_intent.down.sql
-- Recreate the legacy enum (best-effort). This is only safe if no columns
-- still depend on it.
CREATE TYPE "ReplyIntent" AS ENUM (
  'POSITIVE',
  'NEUTRAL',
  'NEGATIVE',
  'OUT_OF_OFFICE',
  'UNSUBSCRIBE',
  'AUTO_REPLY',
  'MEETING_REQUEST',
  'QUESTION',
  'UNKNOWN'
);
