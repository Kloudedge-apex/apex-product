-- DropIndex
DROP INDEX "OutreachArtifact_providerMessageId_idx";

-- DropIndex
DROP INDEX "OutreachArtifact_providerThreadId_idx";

-- DropIndex
DROP INDEX "Conversation_orgId_providerThreadId_idx";

-- DropIndex
DROP INDEX "Reply_conversationId_idx";

-- DropIndex
DROP INDEX "Reply_orgId_intent_idx";

-- DropIndex
DROP INDEX "Reply_orgId_providerMessageId_key";

-- DropIndex
DROP INDEX "email_event_orgId_kind_idx";

-- DropIndex
DROP INDEX "email_event_replyId_idx";

-- AlterTable
ALTER TABLE "OutreachArtifact" DROP COLUMN "inReplyTo",
DROP COLUMN "providerMessageId",
DROP COLUMN "providerThreadId",
DROP COLUMN "references";

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "provider" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "Reply" DROP COLUMN "bodyHtml",
DROP COLUMN "bodyText",
DROP COLUMN "ccEmails",
DROP COLUMN "classifiedAt",
DROP COLUMN "fromEmail",
DROP COLUMN "fromName",
DROP COLUMN "headers",
DROP COLUMN "inReplyTo",
DROP COLUMN "intent",
DROP COLUMN "intentConfidence",
DROP COLUMN "providerMessageId",
DROP COLUMN "providerThreadId",
DROP COLUMN "references",
DROP COLUMN "snippet",
DROP COLUMN "subject",
DROP COLUMN "toEmails",
ADD COLUMN     "emailMessageId" TEXT NOT NULL,
ADD COLUMN     "isOrphan" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "email_event" ADD COLUMN     "emailMessageId" TEXT,
ADD COLUMN     "providerEventId" TEXT;

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
CREATE INDEX "Conversation_orgId_provider_providerThreadId_idx" ON "Conversation"("orgId", "provider", "providerThreadId");

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_orgId_provider_providerThreadId_key" ON "Conversation"("orgId", "provider", "providerThreadId");

-- CreateIndex
CREATE UNIQUE INDEX "Reply_emailMessageId_key" ON "Reply"("emailMessageId");

-- CreateIndex
CREATE INDEX "Reply_orgId_isOrphan_idx" ON "Reply"("orgId", "isOrphan");

-- CreateIndex
CREATE INDEX "email_event_orgId_kind_occurredAt_idx" ON "email_event"("orgId", "kind", "occurredAt");

-- CreateIndex
CREATE INDEX "email_event_emailMessageId_idx" ON "email_event"("emailMessageId");

-- CreateIndex
CREATE INDEX "email_event_orgId_provider_providerEventId_idx" ON "email_event"("orgId", "provider", "providerEventId");

-- AddForeignKey
ALTER TABLE "EmailMessage" ADD CONSTRAINT "EmailMessage_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailMessage" ADD CONSTRAINT "EmailMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reply" ADD CONSTRAINT "Reply_emailMessageId_fkey" FOREIGN KEY ("emailMessageId") REFERENCES "EmailMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_event" ADD CONSTRAINT "email_event_emailMessageId_fkey" FOREIGN KEY ("emailMessageId") REFERENCES "EmailMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

