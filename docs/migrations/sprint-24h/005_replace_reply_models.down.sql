-- DropForeignKey
ALTER TABLE "EmailMessage" DROP CONSTRAINT "EmailMessage_orgId_fkey";

-- DropForeignKey
ALTER TABLE "EmailMessage" DROP CONSTRAINT "EmailMessage_conversationId_fkey";

-- DropForeignKey
ALTER TABLE "Reply" DROP CONSTRAINT "Reply_emailMessageId_fkey";

-- DropForeignKey
ALTER TABLE "email_event" DROP CONSTRAINT "email_event_emailMessageId_fkey";

-- DropIndex
DROP INDEX "Conversation_orgId_provider_providerThreadId_idx";

-- DropIndex
DROP INDEX "Conversation_orgId_provider_providerThreadId_key";

-- DropIndex
DROP INDEX "Reply_emailMessageId_key";

-- DropIndex
DROP INDEX "Reply_orgId_isOrphan_idx";

-- DropIndex
DROP INDEX "email_event_orgId_kind_occurredAt_idx";

-- DropIndex
DROP INDEX "email_event_emailMessageId_idx";

-- DropIndex
DROP INDEX "email_event_orgId_provider_providerEventId_idx";

-- AlterTable
ALTER TABLE "OutreachArtifact" ADD COLUMN     "inReplyTo" TEXT,
ADD COLUMN     "providerMessageId" TEXT,
ADD COLUMN     "providerThreadId" TEXT,
ADD COLUMN     "references" TEXT[];

-- AlterTable
ALTER TABLE "Conversation" DROP COLUMN "provider";

-- AlterTable
ALTER TABLE "Reply" DROP COLUMN "emailMessageId",
DROP COLUMN "isOrphan",
ADD COLUMN     "bodyHtml" TEXT,
ADD COLUMN     "bodyText" TEXT,
ADD COLUMN     "ccEmails" TEXT[],
ADD COLUMN     "classifiedAt" TIMESTAMP(3),
ADD COLUMN     "fromEmail" TEXT NOT NULL,
ADD COLUMN     "fromName" TEXT,
ADD COLUMN     "headers" JSONB,
ADD COLUMN     "inReplyTo" TEXT,
ADD COLUMN     "intent" "ReplyIntent",
ADD COLUMN     "intentConfidence" DOUBLE PRECISION,
ADD COLUMN     "providerMessageId" TEXT NOT NULL,
ADD COLUMN     "providerThreadId" TEXT,
ADD COLUMN     "references" TEXT[],
ADD COLUMN     "snippet" TEXT,
ADD COLUMN     "subject" TEXT,
ADD COLUMN     "toEmails" TEXT[];

-- AlterTable
ALTER TABLE "email_event" DROP COLUMN "emailMessageId",
DROP COLUMN "providerEventId";

-- DropTable
DROP TABLE "EmailMessage";

-- CreateIndex
CREATE INDEX "OutreachArtifact_providerMessageId_idx" ON "OutreachArtifact"("providerMessageId");

-- CreateIndex
CREATE INDEX "OutreachArtifact_providerThreadId_idx" ON "OutreachArtifact"("providerThreadId");

-- CreateIndex
CREATE INDEX "Conversation_orgId_providerThreadId_idx" ON "Conversation"("orgId", "providerThreadId");

-- CreateIndex
CREATE INDEX "Reply_conversationId_idx" ON "Reply"("conversationId");

-- CreateIndex
CREATE INDEX "Reply_orgId_intent_idx" ON "Reply"("orgId", "intent");

-- CreateIndex
CREATE UNIQUE INDEX "Reply_orgId_providerMessageId_key" ON "Reply"("orgId", "providerMessageId");

-- CreateIndex
CREATE INDEX "email_event_orgId_kind_idx" ON "email_event"("orgId", "kind");

-- CreateIndex
CREATE INDEX "email_event_replyId_idx" ON "email_event"("replyId");

