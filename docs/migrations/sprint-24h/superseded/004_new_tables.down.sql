-- DropForeignKey
ALTER TABLE "SuppressionEntry" DROP CONSTRAINT "SuppressionEntry_orgId_fkey";

-- DropForeignKey
ALTER TABLE "EnrichmentFact" DROP CONSTRAINT "EnrichmentFact_orgId_fkey";

-- DropForeignKey
ALTER TABLE "LlmRequestFact" DROP CONSTRAINT "LlmRequestFact_orgId_fkey";

-- DropForeignKey
ALTER TABLE "LlmRequestFact" DROP CONSTRAINT "LlmRequestFact_graphRunId_fkey";

-- DropForeignKey
ALTER TABLE "OrgHourlyUsage" DROP CONSTRAINT "OrgHourlyUsage_orgId_fkey";

-- DropForeignKey
ALTER TABLE "OrgDailyUsage" DROP CONSTRAINT "OrgDailyUsage_orgId_fkey";

-- DropForeignKey
ALTER TABLE "EvaluatorRun" DROP CONSTRAINT "EvaluatorRun_orgId_fkey";

-- DropForeignKey
ALTER TABLE "GoldenSetExample" DROP CONSTRAINT "GoldenSetExample_orgId_fkey";

-- DropTable
DROP TABLE "SuppressionEntry";

-- DropTable
DROP TABLE "EnrichmentFact";

-- DropTable
DROP TABLE "LlmRequestFact";

-- DropTable
DROP TABLE "OrgHourlyUsage";

-- DropTable
DROP TABLE "OrgDailyUsage";

-- DropTable
DROP TABLE "EvaluatorRun";

-- DropTable
DROP TABLE "GoldenSetExample";

