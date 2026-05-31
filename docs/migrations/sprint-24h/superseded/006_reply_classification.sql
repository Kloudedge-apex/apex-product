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

-- CreateIndex
CREATE INDEX "ReplyClassification_orgId_intent_createdAt_idx" ON "ReplyClassification"("orgId", "intent", "createdAt");

-- CreateIndex
CREATE INDEX "ReplyClassification_orgId_requiresHitl_idx" ON "ReplyClassification"("orgId", "requiresHitl");

-- CreateIndex
CREATE INDEX "ReplyClassification_replyId_idx" ON "ReplyClassification"("replyId");

-- CreateIndex
CREATE UNIQUE INDEX "ReplyClassification_replyId_classifierName_classifierVersio_key" ON "ReplyClassification"("replyId", "classifierName", "classifierVersion");

-- AddForeignKey
ALTER TABLE "ReplyClassification" ADD CONSTRAINT "ReplyClassification_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReplyClassification" ADD CONSTRAINT "ReplyClassification_replyId_fkey" FOREIGN KEY ("replyId") REFERENCES "Reply"("id") ON DELETE CASCADE ON UPDATE CASCADE;

