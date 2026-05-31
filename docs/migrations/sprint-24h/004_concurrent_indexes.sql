-- 004_concurrent_indexes.sql
-- These indexes use CONCURRENTLY because the underlying tables (EmailMessage,
-- SuppressionEntry) will accumulate write traffic immediately after deploy.
--
-- APPLY: each CREATE INDEX CONCURRENTLY statement must run OUTSIDE a transaction.
--   - psql -f WILL work (psql doesn't wrap multi-statement files by default).
--   - psql -1 / -1f WILL FAIL (forces single tx).
--   - prisma migrate deploy WILL FAIL (wraps each migration in a tx).
--   - Cloud Build / az aci with `psql -c "..."` per statement is the safe path.

-- EmailMessage references[] reverse-walk index (inbound correlator hot path).
CREATE INDEX CONCURRENTLY IF NOT EXISTS
  idx_email_message_org_references_gin
  ON "EmailMessage"
  USING GIN ("references")
  WHERE "references" IS NOT NULL AND array_length("references", 1) > 0;

-- GLOBAL scope scan helpers (orgId IS NULL).
CREATE INDEX CONCURRENTLY IF NOT EXISTS
  idx_suppression_global_email
  ON "SuppressionEntry" ("subjectEmail")
  WHERE "orgId" IS NULL AND "scope" = 'GLOBAL';

CREATE INDEX CONCURRENTLY IF NOT EXISTS
  idx_suppression_global_domain
  ON "SuppressionEntry" ("subjectDomain")
  WHERE "orgId" IS NULL AND "scope" = 'GLOBAL';

-- Partial unique indexes to prevent duplicate suppressions per subject shape.
-- Idempotency: suppressionService.add() catches P2002 and treats as success.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS
  uniq_suppression_email
  ON "SuppressionEntry" ("orgId", "scope", "kind", "subjectEmail")
  WHERE "subjectEmail" IS NOT NULL;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS
  uniq_suppression_domain
  ON "SuppressionEntry" ("orgId", "scope", "kind", "subjectDomain")
  WHERE "subjectDomain" IS NOT NULL;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS
  uniq_suppression_thread
  ON "SuppressionEntry" ("orgId", "scope", "kind", "subjectThreadId")
  WHERE "subjectThreadId" IS NOT NULL;
