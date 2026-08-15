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

BEGIN;

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
  ADD COLUMN "purpose" "OutreachArtifactPurpose" NOT NULL DEFAULT 'OUTBOUND',
  ADD COLUMN "conversationId" TEXT,
  ADD COLUMN "providerThreadId" TEXT,
  ADD COLUMN "replyToMessageId" TEXT;

ALTER TABLE "MeetingLedger"
  ADD COLUMN "conversationId" TEXT,
  ADD COLUMN "sourceMessageId" TEXT;

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
