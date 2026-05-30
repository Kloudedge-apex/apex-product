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

-- AddForeignKey
ALTER TABLE "SuppressionEntry" ADD CONSTRAINT "SuppressionEntry_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnrichmentFact" ADD CONSTRAINT "EnrichmentFact_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LlmRequestFact" ADD CONSTRAINT "LlmRequestFact_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

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

