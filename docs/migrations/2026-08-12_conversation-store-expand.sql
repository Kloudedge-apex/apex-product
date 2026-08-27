-- Migration: durable conversation/message/follow-up store (expand only)
-- Date drafted: 2026-08-12
-- Status: PENDING APPROVAL - review and apply before deploying code that writes
--         Conversation, ConversationMessage, or FollowUpTask.
--
-- Scope:
--   1. Adds the conversation/intelligence/follow-up/purpose enums.
--   2. Adds Conversation, ConversationMessage, and FollowUpTask.
--   3. Adds nullable conversation provenance to OutreachArtifact and
--      MeetingLedger. Tenant-owned thread/message/artifact/meeting links carry
--      orgId in their FK. Person is a legacy indirect-ownership model, so its
--      optional link is re-checked through Person.Company.orgId by the store.
--   4. Preserves legacy MANUAL/gmail_reply suppression rows as compatibility
--      state until their sequence-stop meaning can be backfilled safely.
--
-- Safety:
--   - Schema changes are expand-only. Existing OutreachArtifact rows backfill
--     automatically to purpose=OUTBOUND; every other existing-table column is
--     nullable.
--   - A known, empty pre-release Conversation table may be present in the
--     production catalog. Its exact column/index/constraint/enum signature is
--     verified below and it is preserved as LegacyConversation before the
--     canonical Conversation table is created. Any rows or signature drift
--     fail the migration before a rename occurs.
--   - Exact, compatible additive columns already present on OutreachArtifact
--     or MeetingLedger are accepted by the catalog preflight and preserved by
--     ADD COLUMN IF NOT EXISTS. A same-name column with a different catalog
--     definition remains a hard hold before this file is invoked.
--   - No existing send/approval status or allowlist gate is changed.
--   - Run the preflight SELECTs and retain their output with the change
--     record. Apply production separately through the normal operator gate.
--   - No suppression row is deleted or rewritten here. Legacy rows do not
--     contain enough provider-thread data to backfill sequenceStoppedAt, so
--     deleting them would lose historical stop state.
--   - Application compatibility must be deployed with this schema: an exact
--     reason=MANUAL/source=gmail_reply row may allow only a reviewed REPLY
--     artifact through. It must continue to block OUTBOUND and FOLLOW_UP, and
--     a later unsubscribe, bounce, complaint, or real manual suppression must
--     replace its legacy meaning and block every purpose.

-- Preflight A: both queries must return zero rows before apply.
-- SELECT "id", "orgId"
-- FROM "Integration"
-- GROUP BY "id", "orgId"
-- HAVING COUNT(*) > 1;
--
-- SELECT "id", "orgId"
-- FROM "OutreachArtifact"
-- GROUP BY "id", "orgId"
-- HAVING COUNT(*) > 1;

-- Preflight B: inventory compatibility rows; this migration retains them.
-- SELECT COUNT(*) AS legacy_gmail_reply_sequence_stops_retained
-- FROM "OutreachSuppression"
-- WHERE "source" = 'gmail_reply'
--   AND "reason" = 'MANUAL';
--
-- Preflight C: Conversation must be absent, or the known legacy table must be
-- empty. The transaction below repeats this check and validates its full
-- catalog signature before preserving it as LegacyConversation.
-- SELECT COUNT(*) AS legacy_conversation_rows FROM "Conversation";

BEGIN;

-- Production once received a pre-release Conversation model whose shape is
-- unrelated to the canonical provider-thread store below. It is currently
-- unused by the reviewed baseline and cannot be converted without inventing
-- integration/contact data. Preserve only the exact, empty known shape. This
-- is intentionally not a generic IF EXISTS shim: an unexpected relation,
-- populated legacy table, or catalog drift aborts the whole transaction.
DO $legacy_conversation_compatibility$
DECLARE
  existing_kind "char";
  existing_row_count BIGINT;
  actual_columns TEXT[];
  actual_indexes TEXT[];
  actual_constraints TEXT[];
  actual_status_labels TEXT[];
  expected_columns CONSTANT TEXT[] := ARRAY[
    'id:text:NO:<none>',
    'orgId:text:NO:<none>',
    'provider:text:NO:<none>',
    'providerThreadId:text:YES:<none>',
    'subject:text:YES:<none>',
    'personId:text:YES:<none>',
    'companyId:text:YES:<none>',
    'status:ConversationStatus:NO:''ACTIVE''::"ConversationStatus"',
    'messageCount:int4:NO:0',
    'replyCount:int4:NO:0',
    'lastActivityAt:timestamp:NO:CURRENT_TIMESTAMP',
    'createdAt:timestamp:NO:CURRENT_TIMESTAMP',
    'updatedAt:timestamp:NO:<none>'
  ];
  expected_indexes CONSTANT TEXT[] := ARRAY[
    'Conversation_orgId_idx:f:orgId',
    'Conversation_orgId_lastActivityAt_idx:f:orgId,lastActivityAt',
    'Conversation_orgId_provider_providerThreadId_idx:f:orgId,provider,providerThreadId',
    'Conversation_orgId_provider_providerThreadId_key:t:orgId,provider,providerThreadId',
    'Conversation_orgId_status_idx:f:orgId,status',
    'Conversation_pkey:t:id'
  ];
  expected_constraints CONSTANT TEXT[] := ARRAY[
    'Conversation_orgId_fkey',
    'Conversation_pkey'
  ];
BEGIN
  SELECT c.relkind
  INTO existing_kind
  FROM pg_class AS c
  JOIN pg_namespace AS n ON n.oid = c.relnamespace
  WHERE n.nspname = current_schema()
    AND c.relname = 'Conversation';

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF existing_kind <> 'r' THEN
    RAISE EXCEPTION
      'legacy Conversation compatibility failed: expected an ordinary table, found relkind %',
      existing_kind;
  END IF;

  IF to_regclass(format('%I.%I', current_schema(), 'LegacyConversation')) IS NOT NULL THEN
    RAISE EXCEPTION
      'legacy Conversation compatibility failed: LegacyConversation already exists';
  END IF;

  SELECT array_agg(
    format(
      '%s:%s:%s:%s',
      column_name,
      udt_name,
      is_nullable,
      COALESCE(column_default, '<none>')
    )
    ORDER BY ordinal_position
  )
  INTO actual_columns
  FROM information_schema.columns
  WHERE table_schema = current_schema()
    AND table_name = 'Conversation';

  IF actual_columns IS DISTINCT FROM expected_columns THEN
    RAISE EXCEPTION
      'legacy Conversation compatibility failed: column signature does not match the reviewed empty legacy table';
  END IF;

  SELECT array_agg(
    format(
      '%s:%s:%s',
      idx.relname,
      i.indisunique,
      array_to_string(
        ARRAY(
          SELECT a.attname
          FROM unnest(i.indkey::SMALLINT[]) WITH ORDINALITY AS k(attnum, position)
          JOIN pg_attribute AS a
            ON a.attrelid = i.indrelid AND a.attnum = k.attnum
          WHERE k.position <= i.indnkeyatts
          ORDER BY k.position
        ),
        ','
      )
    )
    ORDER BY idx.relname
  )
  INTO actual_indexes
  FROM pg_class AS idx
  JOIN pg_index AS i ON i.indexrelid = idx.oid
  JOIN pg_class AS rel ON rel.oid = i.indrelid
  JOIN pg_namespace AS n ON n.oid = rel.relnamespace
  WHERE n.nspname = current_schema()
    AND rel.relname = 'Conversation';

  IF actual_indexes IS DISTINCT FROM expected_indexes THEN
    RAISE EXCEPTION
      'legacy Conversation compatibility failed: index signature does not match the reviewed empty legacy table';
  END IF;

  SELECT array_agg(con.conname ORDER BY con.conname)
  INTO actual_constraints
  FROM pg_constraint AS con
  JOIN pg_class AS rel ON rel.oid = con.conrelid
  JOIN pg_namespace AS n ON n.oid = rel.relnamespace
  WHERE n.nspname = current_schema()
    AND rel.relname = 'Conversation';

  IF actual_constraints IS DISTINCT FROM expected_constraints THEN
    RAISE EXCEPTION
      'legacy Conversation compatibility failed: constraint signature does not match the reviewed empty legacy table';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint AS con
    JOIN pg_class AS rel ON rel.oid = con.conrelid
    JOIN pg_namespace AS n ON n.oid = rel.relnamespace
    WHERE n.nspname = current_schema()
      AND rel.relname = 'Conversation'
      AND con.conname = 'Conversation_pkey'
      AND con.contype = 'p'
      AND ARRAY(
        SELECT a.attname
        FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, position)
        JOIN pg_attribute AS a
          ON a.attrelid = con.conrelid AND a.attnum = k.attnum
        ORDER BY k.position
      ) = ARRAY['id']::NAME[]
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_constraint AS con
    JOIN pg_class AS rel ON rel.oid = con.conrelid
    JOIN pg_namespace AS n ON n.oid = rel.relnamespace
    JOIN pg_class AS parent ON parent.oid = con.confrelid
    JOIN pg_namespace AS parent_n ON parent_n.oid = parent.relnamespace
    WHERE n.nspname = current_schema()
      AND parent_n.nspname = current_schema()
      AND rel.relname = 'Conversation'
      AND parent.relname = 'Org'
      AND con.conname = 'Conversation_orgId_fkey'
      AND con.contype = 'f'
      AND con.confupdtype = 'c'
      AND con.confdeltype = 'c'
      AND ARRAY(
        SELECT a.attname
        FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, position)
        JOIN pg_attribute AS a
          ON a.attrelid = con.conrelid AND a.attnum = k.attnum
        ORDER BY k.position
      ) = ARRAY['orgId']::NAME[]
      AND ARRAY(
        SELECT a.attname
        FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, position)
        JOIN pg_attribute AS a
          ON a.attrelid = con.confrelid AND a.attnum = k.attnum
        ORDER BY k.position
      ) = ARRAY['id']::NAME[]
  ) THEN
    RAISE EXCEPTION
      'legacy Conversation compatibility failed: constraint definition changed';
  END IF;

  SELECT array_agg(e.enumlabel ORDER BY e.enumsortorder)
  INTO actual_status_labels
  FROM pg_type AS t
  JOIN pg_enum AS e ON e.enumtypid = t.oid
  JOIN pg_namespace AS n ON n.oid = t.typnamespace
  WHERE n.nspname = current_schema()
    AND t.typname = 'ConversationStatus';

  IF actual_status_labels IS DISTINCT FROM ARRAY[
    'ACTIVE', 'REPLIED', 'BOUNCED', 'CLOSED'
  ]::TEXT[] THEN
    RAISE EXCEPTION
      'legacy Conversation compatibility failed: ConversationStatus enum signature changed';
  END IF;

  EXECUTE format(
    'SELECT COUNT(*) FROM %I.%I', current_schema(), 'Conversation'
  ) INTO existing_row_count;

  IF existing_row_count <> 0 THEN
    RAISE EXCEPTION
      'legacy Conversation compatibility failed: expected zero rows, found %',
      existing_row_count;
  END IF;

  ALTER TABLE "Conversation" RENAME TO "LegacyConversation";
  ALTER TABLE "LegacyConversation"
    RENAME CONSTRAINT "Conversation_pkey" TO "LegacyConversation_pkey";
  ALTER TABLE "LegacyConversation"
    RENAME CONSTRAINT "Conversation_orgId_fkey"
      TO "LegacyConversation_orgId_fkey";
  ALTER INDEX "Conversation_orgId_idx"
    RENAME TO "LegacyConversation_orgId_idx";
  ALTER INDEX "Conversation_orgId_lastActivityAt_idx"
    RENAME TO "LegacyConversation_orgId_lastActivityAt_idx";
  ALTER INDEX "Conversation_orgId_provider_providerThreadId_idx"
    RENAME TO "LegacyConversation_orgId_provider_providerThreadId_idx";
  ALTER INDEX "Conversation_orgId_provider_providerThreadId_key"
    RENAME TO "LegacyConversation_orgId_provider_providerThreadId_key";
  ALTER INDEX "Conversation_orgId_status_idx"
    RENAME TO "LegacyConversation_orgId_status_idx";

  COMMENT ON TABLE "LegacyConversation" IS
    'Preserved empty pre-release table; not used by the canonical conversation store';
END
$legacy_conversation_compatibility$;

CREATE TYPE "ConversationDirection" AS ENUM ('INBOUND', 'OUTBOUND');
CREATE TYPE "ConversationSentiment" AS ENUM (
  'POSITIVE',
  'OBJECTION',
  'NEUTRAL',
  'NEGATIVE'
);
CREATE TYPE "ConversationNextActionType" AS ENUM (
  'SEND_CONTENT',
  'QUALIFY',
  'DISQUALIFY',
  'FOLLOW_UP'
);
CREATE TYPE "ConversationIntelligenceStatus" AS ENUM (
  'PENDING',
  'READY',
  'FAILED'
);
CREATE TYPE "FollowUpStatus" AS ENUM ('OPEN', 'DONE', 'CANCELLED');
CREATE TYPE "FollowUpSource" AS ENUM ('HUMAN', 'AGENT');
CREATE TYPE "OutreachArtifactPurpose" AS ENUM (
  'OUTBOUND',
  'REPLY',
  'FOLLOW_UP'
);

-- Composite ownership keys. id remains the primary key; these redundant
-- unique keys exist solely so child FKs can prove id+orgId ownership in SQL.
CREATE UNIQUE INDEX "Integration_id_orgId_key"
  ON "Integration" ("id", "orgId");
CREATE UNIQUE INDEX "OutreachArtifact_id_orgId_key"
  ON "OutreachArtifact" ("id", "orgId");

ALTER TABLE "OutreachArtifact"
  ADD COLUMN IF NOT EXISTS "purpose" "OutreachArtifactPurpose" NOT NULL DEFAULT 'OUTBOUND',
  ADD COLUMN IF NOT EXISTS "conversationId" TEXT,
  ADD COLUMN IF NOT EXISTS "providerThreadId" TEXT,
  ADD COLUMN IF NOT EXISTS "replyToMessageId" TEXT;

ALTER TABLE "MeetingLedger"
  ADD COLUMN IF NOT EXISTS "conversationId" TEXT,
  ADD COLUMN IF NOT EXISTS "sourceMessageId" TEXT;

CREATE TABLE "Conversation" (
  "id"                    TEXT NOT NULL,
  "orgId"                 TEXT NOT NULL,
  "integrationId"         TEXT NOT NULL,
  "providerThreadId"      TEXT NOT NULL,
  "personId"              TEXT,
  "contactEmail"          TEXT NOT NULL,
  "contactName"           TEXT,
  "subject"               TEXT NOT NULL DEFAULT '',
  "lastMessagePreview"    TEXT NOT NULL DEFAULT '',
  "lastMessageAt"         TIMESTAMP(3) NOT NULL,
  "lastInboundAt"         TIMESTAMP(3),
  "lastOutboundAt"        TIMESTAMP(3),
  "unreadCount"           INTEGER NOT NULL DEFAULT 0,
  "needsReply"            BOOLEAN NOT NULL DEFAULT false,
  "archivedAt"            TIMESTAMP(3),
  "sequenceStoppedAt"     TIMESTAMP(3),
  "sequenceStopReason"    TEXT,
  "sentiment"             "ConversationSentiment",
  "sentimentConfidence"   DOUBLE PRECISION,
  "nextBestAction"        TEXT,
  "nextBestActionType"    "ConversationNextActionType",
  "intelligenceStatus"    "ConversationIntelligenceStatus" NOT NULL DEFAULT 'PENDING',
  "intelligenceError"     TEXT,
  "intelligenceUpdatedAt" TIMESTAMP(3),
  "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"             TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Conversation_unreadCount_check" CHECK ("unreadCount" >= 0),
  CONSTRAINT "Conversation_sentimentConfidence_check"
    CHECK (
      "sentimentConfidence" IS NULL OR
      ("sentimentConfidence" >= 0 AND "sentimentConfidence" <= 1)
    )
);

CREATE TABLE "ConversationMessage" (
  "id"                 TEXT NOT NULL,
  "orgId"              TEXT NOT NULL,
  "conversationId"     TEXT NOT NULL,
  "direction"          "ConversationDirection" NOT NULL,
  "providerMessageId"  TEXT NOT NULL,
  "internetMessageId"  TEXT,
  "senderEmail"        TEXT NOT NULL,
  "senderName"         TEXT,
  "toEmails"           TEXT[] NOT NULL,
  "ccEmails"           TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "subject"            TEXT NOT NULL DEFAULT '',
  "bodyText"           TEXT,
  "bodyHtml"           TEXT,
  "sentAt"             TIMESTAMP(3) NOT NULL,
  "readAt"             TIMESTAMP(3),
  "outreachArtifactId" TEXT,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ConversationMessage_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FollowUpTask" (
  "id"                 TEXT NOT NULL,
  "orgId"              TEXT NOT NULL,
  "conversationId"     TEXT NOT NULL,
  "dueAt"              TIMESTAMP(3) NOT NULL,
  "note"               TEXT,
  "status"             "FollowUpStatus" NOT NULL DEFAULT 'OPEN',
  "source"             "FollowUpSource" NOT NULL DEFAULT 'HUMAN',
  "createdBy"          TEXT,
  "completedBy"        TEXT,
  "completedAt"        TIMESTAMP(3),
  "cancelledBy"        TEXT,
  "cancelledAt"        TIMESTAMP(3),
  "cancellationReason" TEXT,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMP(3) NOT NULL,

  CONSTRAINT "FollowUpTask_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Conversation_integrationId_providerThreadId_key"
  ON "Conversation" ("integrationId", "providerThreadId");
CREATE UNIQUE INDEX "Conversation_id_orgId_key"
  ON "Conversation" ("id", "orgId");
CREATE INDEX "Conversation_orgId_archivedAt_lastMessageAt_idx"
  ON "Conversation" ("orgId", "archivedAt", "lastMessageAt");
CREATE INDEX "Conversation_orgId_needsReply_lastMessageAt_idx"
  ON "Conversation" ("orgId", "needsReply", "lastMessageAt");
CREATE INDEX "Conversation_orgId_sentiment_lastMessageAt_idx"
  ON "Conversation" ("orgId", "sentiment", "lastMessageAt");
CREATE INDEX "Conversation_orgId_personId_idx"
  ON "Conversation" ("orgId", "personId");

CREATE UNIQUE INDEX "ConversationMessage_conversationId_providerMessageId_key"
  ON "ConversationMessage" ("conversationId", "providerMessageId");
CREATE UNIQUE INDEX "ConversationMessage_id_orgId_key"
  ON "ConversationMessage" ("id", "orgId");
CREATE UNIQUE INDEX "ConversationMessage_orgId_outreachArtifactId_key"
  ON "ConversationMessage" ("orgId", "outreachArtifactId");
CREATE INDEX "ConversationMessage_orgId_sentAt_idx"
  ON "ConversationMessage" ("orgId", "sentAt");
CREATE INDEX "ConversationMessage_conversationId_sentAt_idx"
  ON "ConversationMessage" ("conversationId", "sentAt");
CREATE INDEX "ConversationMessage_orgId_internetMessageId_idx"
  ON "ConversationMessage" ("orgId", "internetMessageId");

CREATE UNIQUE INDEX "FollowUpTask_id_orgId_key"
  ON "FollowUpTask" ("id", "orgId");
CREATE INDEX "FollowUpTask_orgId_status_dueAt_idx"
  ON "FollowUpTask" ("orgId", "status", "dueAt");
CREATE INDEX "FollowUpTask_conversationId_status_dueAt_idx"
  ON "FollowUpTask" ("conversationId", "status", "dueAt");

CREATE INDEX "OutreachArtifact_orgId_purpose_status_idx"
  ON "OutreachArtifact" ("orgId", "purpose", "status");
CREATE INDEX "OutreachArtifact_conversationId_createdAt_idx"
  ON "OutreachArtifact" ("conversationId", "createdAt");
CREATE INDEX "OutreachArtifact_orgId_providerThreadId_idx"
  ON "OutreachArtifact" ("orgId", "providerThreadId");
CREATE INDEX "MeetingLedger_conversationId_idx"
  ON "MeetingLedger" ("conversationId");
CREATE INDEX "MeetingLedger_sourceMessageId_idx"
  ON "MeetingLedger" ("sourceMessageId");

ALTER TABLE "Conversation"
  ADD CONSTRAINT "Conversation_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "Org" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "Conversation_integrationId_orgId_fkey"
    FOREIGN KEY ("integrationId", "orgId")
    REFERENCES "Integration" ("id", "orgId")
    ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "Conversation_personId_fkey"
    FOREIGN KEY ("personId") REFERENCES "Person" ("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ConversationMessage"
  ADD CONSTRAINT "ConversationMessage_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "Org" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "ConversationMessage_conversationId_orgId_fkey"
    FOREIGN KEY ("conversationId", "orgId")
    REFERENCES "Conversation" ("id", "orgId")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "ConversationMessage_outreachArtifactId_orgId_fkey"
    FOREIGN KEY ("outreachArtifactId", "orgId")
    REFERENCES "OutreachArtifact" ("id", "orgId")
    ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "FollowUpTask"
  ADD CONSTRAINT "FollowUpTask_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "Org" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "FollowUpTask_conversationId_orgId_fkey"
    FOREIGN KEY ("conversationId", "orgId")
    REFERENCES "Conversation" ("id", "orgId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OutreachArtifact"
  ADD CONSTRAINT "OutreachArtifact_conversationId_orgId_fkey"
    FOREIGN KEY ("conversationId", "orgId")
    REFERENCES "Conversation" ("id", "orgId")
    ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "OutreachArtifact_replyToMessageId_orgId_fkey"
    FOREIGN KEY ("replyToMessageId", "orgId")
    REFERENCES "ConversationMessage" ("id", "orgId")
    ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "MeetingLedger"
  ADD CONSTRAINT "MeetingLedger_conversationId_orgId_fkey"
    FOREIGN KEY ("conversationId", "orgId")
    REFERENCES "Conversation" ("id", "orgId")
    ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "MeetingLedger_sourceMessageId_orgId_fkey"
    FOREIGN KEY ("sourceMessageId", "orgId")
    REFERENCES "ConversationMessage" ("id", "orgId")
    ON DELETE NO ACTION ON UPDATE CASCADE;

-- ─── LEGACY COMPATIBILITY: intentionally no suppression DELETE ────────────
-- MANUAL/gmail_reply rows encoded historical sequence-stop state before
-- Conversation existed. Keep them until a separately reviewed backfill can
-- map each row to a provider thread without guessing. The application applies
-- the narrow REPLY-only compatibility rule described in the header.

COMMIT;

-- Post-apply verification:
-- SELECT "purpose", COUNT(*) FROM "OutreachArtifact" GROUP BY 1;
-- Existing rows should all report OUTBOUND until new reply/follow-up artifacts
-- are created by the post-migration application.

-- Rollback notes (schema only; suppression rows were not changed):
-- 1. Deploy old readers/writers first.
-- 2. Drop the MeetingLedger/OutreachArtifact FKs and nullable columns.
-- 3. Drop FollowUpTask, ConversationMessage, Conversation (in that order).
-- 4. Drop the seven new enum types and redundant composite unique indexes.
-- Legacy gmail_reply/MANUAL rows remain compatibility state; new Gmail replies
-- belong on Conversation.sequenceStoppedAt and must not create more rows.
