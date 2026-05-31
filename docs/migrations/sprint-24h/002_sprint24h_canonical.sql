-- 002_sprint24h_canonical.sql
-- Generated via: prisma migrate diff --from-url apex-prod-db --to-schema-datamodel schema.prisma --script
-- Source schema.prisma: WS-10 integration tip (1272 lines)
-- Probe date: 2026-05-31
-- Diff is purely additive: 12 enums, 1 enum extension, 12 tables, 1 ALTER TABLE, 57 indexes, 24 FKs.
-- No DROP statements. Safe to apply as a single batch inside a transaction.

-- CreateEnum
CREATE TYPE "ConversationStatus" AS ENUM ('ACTIVE', 'REPLIED', 'BOUNCED', 'CLOSED');

-- CreateEnum
CREATE TYPE "EmailEventKind" AS ENUM ('SENT', 'DELIVERED', 'BOUNCED', 'DEFERRED', 'OPENED', 'CLICKED', 'REPLIED', 'COMPLAINED', 'UNSUBSCRIBED', 'SUPPRESSED');

-- CreateEnum
CREATE TYPE "EmailDirection" AS ENUM ('OUTBOUND', 'INBOUND');

-- CreateEnum
CREATE TYPE "EmailIngestSource" AS ENUM ('APP_SEND', 'GMAIL_WATCH', 'BACKFILL', 'MANUAL');

-- CreateEnum
CREATE TYPE "ReplyIntent10" AS ENUM ('positive_interest', 'question_or_objection', 'referral', 'not_now', 'wrong_person', 'unsubscribe', 'negative_not_interested', 'auto_reply_ooo', 'bounce_or_ndr', 'spam_or_legal_threat');

-- CreateEnum
CREATE TYPE "SuppressionScope" AS ENUM ('GLOBAL', 'ORG', 'SENDER', 'THREAD');

-- CreateEnum
CREATE TYPE "SuppressionKind" AS ENUM ('UNSUBSCRIBE', 'COMPLAINT', 'HARD_BOUNCE', 'SPAM_TRAP', 'LEGAL', 'CRM_INACTIVE', 'MANUAL', 'THREAD_HUMAN_REPLY', 'OOO_COOLDOWN');

-- CreateEnum
CREATE TYPE "EnrichmentLicenseScope" AS ENUM ('INTERNAL_ONLY', 'RESEARCH_OK', 'SHAREABLE_AGGREGATE');

-- CreateEnum
CREATE TYPE "EvaluatorTargetType" AS ENUM ('ARTIFACT', 'REPLY', 'CLASSIFICATION', 'ENRICHMENT');

-- CreateEnum
CREATE TYPE "LlmRequestStatus" AS ENUM ('OK', 'ERROR', 'TIMEOUT', 'CANCELLED');

-- CreateEnum
CREATE TYPE "GoldenSetSource" AS ENUM ('PROMOTED_SENT', 'HUMAN_AUTHORED', 'ADVERSARIAL', 'REGRESSION_SEED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "OutreachArtifactStatus" ADD VALUE 'QUEUED';
ALTER TYPE "OutreachArtifactStatus" ADD VALUE 'REPLIED';
ALTER TYPE "OutreachArtifactStatus" ADD VALUE 'BOUNCED';
ALTER TYPE "OutreachArtifactStatus" ADD VALUE 'SUPPRESSED';

-- AlterTable
ALTER TABLE "OutreachArtifact" ADD COLUMN     "conversationId" TEXT,
ADD COLUMN     "suppressionReason" TEXT;

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerThreadId" TEXT,
    "subject" TEXT,
    "personId" TEXT,
    "companyId" TEXT,
    "status" "ConversationStatus" NOT NULL DEFAULT 'ACTIVE',
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "replyCount" INTEGER NOT NULL DEFAULT 0,
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailMessage" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "conversationId" TEXT,
    "artifactId" TEXT,
    "direction" "EmailDirection" NOT NULL,
    "ingestSource" "EmailIngestSource" NOT NULL,
    "provider" TEXT NOT NULL,
    "providerMessageId" TEXT NOT NULL,
    "providerThreadId" TEXT,
    "rfcMessageId" TEXT,
    "inReplyTo" TEXT,
    "references" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "subject" TEXT,
    "bodyText" TEXT,
    "bodyHtml" TEXT,
    "headers" JSONB,
    "fromEmail" CITEXT NOT NULL,
    "fromName" TEXT,
    "toEmails" CITEXT[],
    "cc" CITEXT[] DEFAULT ARRAY[]::CITEXT[],
    "bcc" CITEXT[] DEFAULT ARRAY[]::CITEXT[],
    "senderMailboxId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_event" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "emailMessageId" TEXT,
    "artifactId" TEXT,
    "conversationId" TEXT,
    "replyId" TEXT,
    "kind" "EmailEventKind" NOT NULL,
    "provider" TEXT NOT NULL,
    "providerMessageId" TEXT,
    "providerEventId" TEXT,
    "meta" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Reply" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "emailMessageId" TEXT NOT NULL,
    "artifactId" TEXT,
    "conversationId" TEXT NOT NULL,
    "isOrphan" BOOLEAN NOT NULL DEFAULT false,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Reply_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReplyClassification" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "replyId" TEXT NOT NULL,
    "classifierName" TEXT NOT NULL,
    "classifierVersion" TEXT NOT NULL,
    "intent" "ReplyIntent10" NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "rawOutput" JSONB NOT NULL,
    "evidenceSpans" JSONB,
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    "modelName" TEXT,
    "requiresHitl" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReplyClassification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SuppressionEntry" (
    "id" TEXT NOT NULL,
    "orgId" TEXT,
    "scope" "SuppressionScope" NOT NULL,
    "kind" "SuppressionKind" NOT NULL,
    "subjectEmail" CITEXT,
    "subjectDomain" TEXT,
    "subjectThreadId" TEXT,
    "senderMailboxId" TEXT,
    "expiresAt" TIMESTAMP(3),
    "source" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SuppressionEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EnrichmentFact" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "lookupKey" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ttlExpiresAt" TIMESTAMP(3),
    "confidence" DOUBLE PRECISION,
    "costCredits" INTEGER,
    "costUsd" DECIMAL(10,4),
    "licenseScope" "EnrichmentLicenseScope" NOT NULL,
    "graphRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EnrichmentFact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LlmRequestFact" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "campaignId" TEXT,
    "leadId" TEXT,
    "artifactId" TEXT,
    "graphRunId" TEXT,
    "nodeName" TEXT,
    "promptVersion" TEXT,
    "evalBundleVersion" TEXT,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cachedInputTokens" INTEGER NOT NULL DEFAULT 0,
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DECIMAL(10,6) NOT NULL,
    "langsmithRunId" TEXT,
    "status" "LlmRequestStatus" NOT NULL DEFAULT 'OK',
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LlmRequestFact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrgHourlyUsage" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "bucketStart" TIMESTAMP(3) NOT NULL,
    "requests" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" BIGINT NOT NULL DEFAULT 0,
    "outputTokens" BIGINT NOT NULL DEFAULT 0,
    "cachedInputTokens" BIGINT NOT NULL DEFAULT 0,
    "totalCostUsd" DECIMAL(14,6) NOT NULL DEFAULT 0,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "p50LatencyMs" INTEGER NOT NULL DEFAULT 0,
    "p95LatencyMs" INTEGER NOT NULL DEFAULT 0,
    "p99LatencyMs" INTEGER NOT NULL DEFAULT 0,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrgHourlyUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrgDailyUsage" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "bucketStart" TIMESTAMP(3) NOT NULL,
    "requests" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" BIGINT NOT NULL DEFAULT 0,
    "outputTokens" BIGINT NOT NULL DEFAULT 0,
    "cachedInputTokens" BIGINT NOT NULL DEFAULT 0,
    "totalCostUsd" DECIMAL(14,6) NOT NULL DEFAULT 0,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "p50LatencyMs" INTEGER NOT NULL DEFAULT 0,
    "p95LatencyMs" INTEGER NOT NULL DEFAULT 0,
    "p99LatencyMs" INTEGER NOT NULL DEFAULT 0,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrgDailyUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvaluatorRun" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "targetType" "EvaluatorTargetType" NOT NULL,
    "targetId" TEXT NOT NULL,
    "evaluatorName" TEXT NOT NULL,
    "evaluatorVersion" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "reason" TEXT,
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    "evidence" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvaluatorRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoldenSetExample" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "scenarioKey" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "source" "GoldenSetSource" NOT NULL,
    "input" JSONB NOT NULL,
    "expectedOutput" JSONB NOT NULL,
    "evaluatorBaselines" JSONB NOT NULL,
    "sourceRefId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GoldenSetExample_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Conversation_orgId_idx" ON "Conversation"("orgId");

-- CreateIndex
CREATE INDEX "Conversation_orgId_status_idx" ON "Conversation"("orgId", "status");

-- CreateIndex
CREATE INDEX "Conversation_orgId_lastActivityAt_idx" ON "Conversation"("orgId", "lastActivityAt");

-- CreateIndex
CREATE INDEX "Conversation_orgId_provider_providerThreadId_idx" ON "Conversation"("orgId", "provider", "providerThreadId");

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_orgId_provider_providerThreadId_key" ON "Conversation"("orgId", "provider", "providerThreadId");

-- CreateIndex
CREATE INDEX "EmailMessage_orgId_idx" ON "EmailMessage"("orgId");

-- CreateIndex
CREATE INDEX "EmailMessage_orgId_direction_occurredAt_idx" ON "EmailMessage"("orgId", "direction", "occurredAt");

-- CreateIndex
CREATE INDEX "EmailMessage_conversationId_occurredAt_idx" ON "EmailMessage"("conversationId", "occurredAt");

-- CreateIndex
CREATE INDEX "EmailMessage_artifactId_idx" ON "EmailMessage"("artifactId");

-- CreateIndex
CREATE INDEX "EmailMessage_orgId_provider_providerThreadId_idx" ON "EmailMessage"("orgId", "provider", "providerThreadId");

-- CreateIndex
CREATE INDEX "EmailMessage_orgId_fromEmail_idx" ON "EmailMessage"("orgId", "fromEmail");

-- CreateIndex
CREATE UNIQUE INDEX "EmailMessage_orgId_provider_providerMessageId_key" ON "EmailMessage"("orgId", "provider", "providerMessageId");

-- CreateIndex
CREATE INDEX "email_event_orgId_occurredAt_idx" ON "email_event"("orgId", "occurredAt");

-- CreateIndex
CREATE INDEX "email_event_orgId_kind_occurredAt_idx" ON "email_event"("orgId", "kind", "occurredAt");

-- CreateIndex
CREATE INDEX "email_event_emailMessageId_idx" ON "email_event"("emailMessageId");

-- CreateIndex
CREATE INDEX "email_event_artifactId_idx" ON "email_event"("artifactId");

-- CreateIndex
CREATE INDEX "email_event_conversationId_idx" ON "email_event"("conversationId");

-- CreateIndex
CREATE INDEX "email_event_orgId_provider_providerEventId_idx" ON "email_event"("orgId", "provider", "providerEventId");

-- CreateIndex
CREATE UNIQUE INDEX "Reply_emailMessageId_key" ON "Reply"("emailMessageId");

-- CreateIndex
CREATE INDEX "Reply_orgId_idx" ON "Reply"("orgId");

-- CreateIndex
CREATE INDEX "Reply_orgId_receivedAt_idx" ON "Reply"("orgId", "receivedAt");

-- CreateIndex
CREATE INDEX "Reply_conversationId_receivedAt_idx" ON "Reply"("conversationId", "receivedAt");

-- CreateIndex
CREATE INDEX "Reply_artifactId_idx" ON "Reply"("artifactId");

-- CreateIndex
CREATE INDEX "Reply_orgId_isOrphan_idx" ON "Reply"("orgId", "isOrphan");

-- CreateIndex
CREATE INDEX "ReplyClassification_orgId_intent_createdAt_idx" ON "ReplyClassification"("orgId", "intent", "createdAt");

-- CreateIndex
CREATE INDEX "ReplyClassification_orgId_requiresHitl_idx" ON "ReplyClassification"("orgId", "requiresHitl");

-- CreateIndex
CREATE INDEX "ReplyClassification_replyId_idx" ON "ReplyClassification"("replyId");

-- CreateIndex
CREATE UNIQUE INDEX "ReplyClassification_replyId_classifierName_classifierVersio_key" ON "ReplyClassification"("replyId", "classifierName", "classifierVersion");

-- CreateIndex
CREATE INDEX "SuppressionEntry_orgId_subjectEmail_idx" ON "SuppressionEntry"("orgId", "subjectEmail");

-- CreateIndex
CREATE INDEX "SuppressionEntry_orgId_subjectDomain_idx" ON "SuppressionEntry"("orgId", "subjectDomain");

-- CreateIndex
CREATE INDEX "SuppressionEntry_orgId_subjectThreadId_idx" ON "SuppressionEntry"("orgId", "subjectThreadId");

-- CreateIndex
CREATE INDEX "SuppressionEntry_scope_kind_subjectEmail_idx" ON "SuppressionEntry"("scope", "kind", "subjectEmail");

-- CreateIndex
CREATE INDEX "SuppressionEntry_orgId_scope_kind_idx" ON "SuppressionEntry"("orgId", "scope", "kind");

-- CreateIndex
CREATE INDEX "SuppressionEntry_expiresAt_idx" ON "SuppressionEntry"("expiresAt");

-- CreateIndex
CREATE INDEX "EnrichmentFact_orgId_provider_fetchedAt_idx" ON "EnrichmentFact"("orgId", "provider", "fetchedAt");

-- CreateIndex
CREATE INDEX "EnrichmentFact_orgId_provider_lookupKey_idx" ON "EnrichmentFact"("orgId", "provider", "lookupKey");

-- CreateIndex
CREATE INDEX "EnrichmentFact_ttlExpiresAt_idx" ON "EnrichmentFact"("ttlExpiresAt");

-- CreateIndex
CREATE INDEX "EnrichmentFact_orgId_licenseScope_idx" ON "EnrichmentFact"("orgId", "licenseScope");

-- CreateIndex
CREATE UNIQUE INDEX "EnrichmentFact_orgId_provider_lookupKey_field_key" ON "EnrichmentFact"("orgId", "provider", "lookupKey", "field");

-- CreateIndex
CREATE INDEX "LlmRequestFact_orgId_createdAt_idx" ON "LlmRequestFact"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "LlmRequestFact_orgId_model_createdAt_idx" ON "LlmRequestFact"("orgId", "model", "createdAt");

-- CreateIndex
CREATE INDEX "LlmRequestFact_orgId_nodeName_createdAt_idx" ON "LlmRequestFact"("orgId", "nodeName", "createdAt");

-- CreateIndex
CREATE INDEX "LlmRequestFact_graphRunId_idx" ON "LlmRequestFact"("graphRunId");

-- CreateIndex
CREATE INDEX "LlmRequestFact_artifactId_idx" ON "LlmRequestFact"("artifactId");

-- CreateIndex
CREATE INDEX "LlmRequestFact_langsmithRunId_idx" ON "LlmRequestFact"("langsmithRunId");

-- CreateIndex
CREATE INDEX "OrgHourlyUsage_bucketStart_idx" ON "OrgHourlyUsage"("bucketStart");

-- CreateIndex
CREATE UNIQUE INDEX "OrgHourlyUsage_orgId_bucketStart_key" ON "OrgHourlyUsage"("orgId", "bucketStart");

-- CreateIndex
CREATE INDEX "OrgDailyUsage_bucketStart_idx" ON "OrgDailyUsage"("bucketStart");

-- CreateIndex
CREATE UNIQUE INDEX "OrgDailyUsage_orgId_bucketStart_key" ON "OrgDailyUsage"("orgId", "bucketStart");

-- CreateIndex
CREATE INDEX "EvaluatorRun_orgId_evaluatorName_createdAt_idx" ON "EvaluatorRun"("orgId", "evaluatorName", "createdAt");

-- CreateIndex
CREATE INDEX "EvaluatorRun_orgId_passed_createdAt_idx" ON "EvaluatorRun"("orgId", "passed", "createdAt");

-- CreateIndex
CREATE INDEX "EvaluatorRun_targetType_targetId_idx" ON "EvaluatorRun"("targetType", "targetId");

-- CreateIndex
CREATE UNIQUE INDEX "EvaluatorRun_targetType_targetId_evaluatorName_evaluatorVer_key" ON "EvaluatorRun"("targetType", "targetId", "evaluatorName", "evaluatorVersion");

-- CreateIndex
CREATE INDEX "GoldenSetExample_orgId_source_idx" ON "GoldenSetExample"("orgId", "source");

-- CreateIndex
CREATE INDEX "GoldenSetExample_orgId_isActive_idx" ON "GoldenSetExample"("orgId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "GoldenSetExample_orgId_scenarioKey_version_key" ON "GoldenSetExample"("orgId", "scenarioKey", "version");

-- CreateIndex
CREATE INDEX "OutreachArtifact_conversationId_idx" ON "OutreachArtifact"("conversationId");

-- AddForeignKey
ALTER TABLE "OutreachArtifact" ADD CONSTRAINT "OutreachArtifact_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailMessage" ADD CONSTRAINT "EmailMessage_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailMessage" ADD CONSTRAINT "EmailMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailMessage" ADD CONSTRAINT "EmailMessage_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "OutreachArtifact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_event" ADD CONSTRAINT "email_event_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_event" ADD CONSTRAINT "email_event_emailMessageId_fkey" FOREIGN KEY ("emailMessageId") REFERENCES "EmailMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_event" ADD CONSTRAINT "email_event_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "OutreachArtifact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_event" ADD CONSTRAINT "email_event_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reply" ADD CONSTRAINT "Reply_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reply" ADD CONSTRAINT "Reply_emailMessageId_fkey" FOREIGN KEY ("emailMessageId") REFERENCES "EmailMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reply" ADD CONSTRAINT "Reply_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "OutreachArtifact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reply" ADD CONSTRAINT "Reply_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReplyClassification" ADD CONSTRAINT "ReplyClassification_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReplyClassification" ADD CONSTRAINT "ReplyClassification_replyId_fkey" FOREIGN KEY ("replyId") REFERENCES "Reply"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SuppressionEntry" ADD CONSTRAINT "SuppressionEntry_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnrichmentFact" ADD CONSTRAINT "EnrichmentFact_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LlmRequestFact" ADD CONSTRAINT "LlmRequestFact_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LlmRequestFact" ADD CONSTRAINT "LlmRequestFact_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "OutreachArtifact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LlmRequestFact" ADD CONSTRAINT "LlmRequestFact_graphRunId_fkey" FOREIGN KEY ("graphRunId") REFERENCES "GraphRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrgHourlyUsage" ADD CONSTRAINT "OrgHourlyUsage_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrgDailyUsage" ADD CONSTRAINT "OrgDailyUsage_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvaluatorRun" ADD CONSTRAINT "EvaluatorRun_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoldenSetExample" ADD CONSTRAINT "GoldenSetExample_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

