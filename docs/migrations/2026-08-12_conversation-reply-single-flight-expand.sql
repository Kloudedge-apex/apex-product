-- Migration: one deliverable reply per conversation inbound source (expand)
-- Date drafted: 2026-08-12
-- Status: PENDING APPROVAL - REVIEW ONLY; NOT APPLIED BY CODEX.
--
-- Prerequisites:
--   1. 2026-08-12_conversation-store-expand.sql has added purpose,
--      conversationId, replyToMessageId, Conversation, and ConversationMessage.
--   2. 2026-08-12_outreach-delivery-unknown-expand.sql has added the
--      DELIVERY_UNKNOWN enum value.
--   3. 2026-08-13_outreach-artifact-failed-expand.sql has added the FAILED
--      terminal non-send value.
--
-- Contract:
--   1. For one (orgId, conversationId, replyToMessageId), at most one REPLY
--      may be draft/reviewable, approved, in flight, confirmed sent, or
--      delivery-ambiguous.
--   2. Per (orgId, conversationId), at most one REPLY may remain open or
--      delivery-ambiguous across inbound turns. Creating a draft for a newer
--      inbound message suppresses older not-yet-dispatched drafts first.
--      Confirmed SENT history does not consume this conversation-wide slot,
--      but still permanently consumes its source-specific slot.
--   REJECTED, FAILED, SUPPRESSED, and SIMULATED are terminal non-send states and
--   intentionally release both slots for a separately reviewed replacement.
--
-- Legacy rows with null conversationId or replyToMessageId cannot be safely
-- guessed into a source slot. The application dispatch boundary serializes
-- those rows at tenant/thread scope and treats a null source as conflicting
-- with every source-aware reply in that thread. Inventory and reconcile them
-- manually; this migration does not rewrite historical delivery truth.
--
-- IMPORTANT: CREATE INDEX CONCURRENTLY must run outside BEGIN/COMMIT. Run the
-- preflight inventory first and retain its output with the change record.
-- Execute this file with psql in non-transactional mode and error-stop on,
-- for example:
--   psql --set=ON_ERROR_STOP=1 --file=<this-file> <operator-managed-connection>
-- Do not use a migration runner that wraps the file in a transaction.
-- In particular, do not add `-1`/`--single-transaction` to the psql command.
-- MANDATORY: pause every writer that can create or transition REPLY artifacts
-- before Preflight A, keep writers paused through the postcondition, and
-- resume only after both indexes are verified valid/ready/live/unique. The
-- concurrent builds keep ordinary table reads available; they do not replace
-- this bounded writer pause between duplicate preflight and index validity.

\set ON_ERROR_STOP on
\set AUTOCOMMIT on

-- Preflight A: source-aware duplicates must not exist. Do not auto-delete or
-- rewrite a SENT/DELIVERY_UNKNOWN row. Reconcile provider truth and retain
-- evidence. This executable guard aborts before either index build.
DO $reply_source_preflight$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "OutreachArtifact"
    WHERE "purpose" = 'REPLY'::"OutreachArtifactPurpose"
      AND "conversationId" IS NOT NULL
      AND "replyToMessageId" IS NOT NULL
      AND "status" IN (
        'DRAFT'::"OutreachArtifactStatus",
        'PENDING_REVIEW'::"OutreachArtifactStatus",
        'APPROVED'::"OutreachArtifactStatus",
        'SENDING'::"OutreachArtifactStatus",
        'SENT'::"OutreachArtifactStatus",
        'DELIVERY_UNKNOWN'::"OutreachArtifactStatus"
      )
    GROUP BY "orgId", "conversationId", "replyToMessageId"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'reply single-flight preflight failed: duplicate active/delivered source slots require manual reconciliation';
  END IF;
END
$reply_source_preflight$;

-- Diagnostic form of Preflight A (must return zero rows) for the retained
-- change record:
-- prevent the unique index from being built. Do not auto-delete or rewrite a
-- SENT/DELIVERY_UNKNOWN row. Reconcile provider truth and retain evidence.
-- SELECT
--   "orgId",
--   "conversationId",
--   "replyToMessageId",
--   array_agg("id" ORDER BY "createdAt", "id") AS artifact_ids,
--   array_agg("status" ORDER BY "createdAt", "id") AS statuses,
--   COUNT(*) AS duplicate_count
-- FROM "OutreachArtifact"
-- WHERE "purpose" = 'REPLY'::"OutreachArtifactPurpose"
--   AND "conversationId" IS NOT NULL
--   AND "replyToMessageId" IS NOT NULL
--   AND "status" IN (
--     'DRAFT'::"OutreachArtifactStatus",
--     'PENDING_REVIEW'::"OutreachArtifactStatus",
--     'APPROVED'::"OutreachArtifactStatus",
--     'SENDING'::"OutreachArtifactStatus",
--     'SENT'::"OutreachArtifactStatus",
--     'DELIVERY_UNKNOWN'::"OutreachArtifactStatus"
--   )
-- GROUP BY 1, 2, 3
-- HAVING COUNT(*) > 1;

-- Preflight A2: conversation-wide open duplicates must not exist.
DO $reply_conversation_preflight$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "OutreachArtifact"
    WHERE "purpose" = 'REPLY'::"OutreachArtifactPurpose"
      AND "conversationId" IS NOT NULL
      AND "status" IN (
        'DRAFT'::"OutreachArtifactStatus",
        'PENDING_REVIEW'::"OutreachArtifactStatus",
        'APPROVED'::"OutreachArtifactStatus",
        'SENDING'::"OutreachArtifactStatus",
        'DELIVERY_UNKNOWN'::"OutreachArtifactStatus"
      )
    GROUP BY "orgId", "conversationId"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'reply single-flight preflight failed: multiple open conversation reply slots require manual reconciliation';
  END IF;
END
$reply_conversation_preflight$;

-- Diagnostic form of Preflight A2 (must return zero rows):
-- SELECT
--   "orgId",
--   "conversationId",
--   array_agg("id" ORDER BY "createdAt", "id") AS artifact_ids,
--   array_agg("status" ORDER BY "createdAt", "id") AS statuses,
--   COUNT(*) AS duplicate_count
-- FROM "OutreachArtifact"
-- WHERE "purpose" = 'REPLY'::"OutreachArtifactPurpose"
--   AND "conversationId" IS NOT NULL
--   AND "status" IN (
--     'DRAFT'::"OutreachArtifactStatus",
--     'PENDING_REVIEW'::"OutreachArtifactStatus",
--     'APPROVED'::"OutreachArtifactStatus",
--     'SENDING'::"OutreachArtifactStatus",
--     'DELIVERY_UNKNOWN'::"OutreachArtifactStatus"
--   )
-- GROUP BY 1, 2
-- HAVING COUNT(*) > 1;

-- Preflight B (inventory only): legacy/null-source rows remain protected by
-- the application dispatch lock, but must be manually reviewed.
-- SELECT "id", "orgId", "conversationId", "providerThreadId",
--        "replyToMessageId", "status", "createdAt"
-- FROM "OutreachArtifact"
-- WHERE "purpose" = 'REPLY'::"OutreachArtifactPurpose"
--   AND ("conversationId" IS NULL OR "replyToMessageId" IS NULL)
-- ORDER BY "orgId", "providerThreadId", "createdAt", "id";

-- This is deliberately a one-shot, fail-closed file. A killed concurrent
-- build can leave an INVALID index; a partially completed run can leave the
-- first valid index. Either case requires inspection. Never silently accept
-- a same-name object whose definition may differ from this reviewed SQL.
DO $reply_index_retry_guard$
DECLARE
  existing_index TEXT;
BEGIN
  SELECT c.relname
  INTO existing_index
  FROM pg_class AS c
  WHERE c.relname IN (
    'OutreachArtifact_one_reply_per_inbound_uniq',
    'OutreachArtifact_one_open_reply_per_conversation_uniq'
  )
    AND c.relnamespace = to_regnamespace(current_schema())
  LIMIT 1;

  IF existing_index IS NOT NULL THEN
    RAISE EXCEPTION
      'reply single-flight fixed-name object % already exists; inspect both reviewed definitions and validity. If this is a partial/invalid run, drop only the inspected fixed-name indexes concurrently before retry',
      existing_index;
  END IF;
END
$reply_index_retry_guard$;

CREATE UNIQUE INDEX CONCURRENTLY
  "OutreachArtifact_one_reply_per_inbound_uniq"
ON "OutreachArtifact" ("orgId", "conversationId", "replyToMessageId")
WHERE "purpose" = 'REPLY'::"OutreachArtifactPurpose"
  AND "conversationId" IS NOT NULL
  AND "replyToMessageId" IS NOT NULL
  AND "status" IN (
    'DRAFT'::"OutreachArtifactStatus",
    'PENDING_REVIEW'::"OutreachArtifactStatus",
    'APPROVED'::"OutreachArtifactStatus",
    'SENDING'::"OutreachArtifactStatus",
    'SENT'::"OutreachArtifactStatus",
    'DELIVERY_UNKNOWN'::"OutreachArtifactStatus"
  );

CREATE UNIQUE INDEX CONCURRENTLY
  "OutreachArtifact_one_open_reply_per_conversation_uniq"
ON "OutreachArtifact" ("orgId", "conversationId")
WHERE "purpose" = 'REPLY'::"OutreachArtifactPurpose"
  AND "conversationId" IS NOT NULL
  AND "status" IN (
    'DRAFT'::"OutreachArtifactStatus",
    'PENDING_REVIEW'::"OutreachArtifactStatus",
    'APPROVED'::"OutreachArtifactStatus",
    'SENDING'::"OutreachArtifactStatus",
    'DELIVERY_UNKNOWN'::"OutreachArtifactStatus"
  );

-- Executable postcondition: both fixed-name indexes must now be live unique
-- indexes. ON_ERROR_STOP makes this a failed operator run if either is not.
DO $reply_index_postcondition$
DECLARE
  valid_index_count INTEGER;
BEGIN
  SELECT COUNT(*)
  INTO valid_index_count
  FROM pg_class AS c
  JOIN pg_index AS i ON i.indexrelid = c.oid
  WHERE c.relname IN (
    'OutreachArtifact_one_reply_per_inbound_uniq',
    'OutreachArtifact_one_open_reply_per_conversation_uniq'
  )
    AND c.relnamespace = to_regnamespace(current_schema())
    AND i.indisvalid
    AND i.indisready
    AND i.indislive
    AND i.indisunique;

  IF valid_index_count <> 2 THEN
    RAISE EXCEPTION
      'reply single-flight postcondition failed: expected 2 valid/ready/live/unique indexes, found %',
      valid_index_count;
  END IF;
END
$reply_index_postcondition$;

-- Readable post-apply receipt (must return two valid, unique indexes):
-- SELECT indexrelid::regclass AS index_name, indisvalid, indisready, indislive
-- FROM pg_index
-- WHERE indexrelid IN (
--   '"OutreachArtifact_one_reply_per_inbound_uniq"'::regclass,
--   '"OutreachArtifact_one_open_reply_per_conversation_uniq"'::regclass
-- );

-- Rollback (does not alter any artifact row):
-- DROP INDEX CONCURRENTLY IF EXISTS
--   "OutreachArtifact_one_reply_per_inbound_uniq";
-- DROP INDEX CONCURRENTLY IF EXISTS
--   "OutreachArtifact_one_open_reply_per_conversation_uniq";
