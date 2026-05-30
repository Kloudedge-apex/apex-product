-- 011_suppression_partial_indexes.sql
-- NOTE: CONCURRENTLY cannot run inside a transaction.

-- GLOBAL scan helpers (where orgId IS NULL).
CREATE INDEX CONCURRENTLY IF NOT EXISTS
  idx_suppression_global_email
  ON "SuppressionEntry" ("subjectEmail")
  WHERE "orgId" IS NULL AND "scope" = 'GLOBAL';

CREATE INDEX CONCURRENTLY IF NOT EXISTS
  idx_suppression_global_domain
  ON "SuppressionEntry" ("subjectDomain")
  WHERE "orgId" IS NULL AND "scope" = 'GLOBAL';

-- Partial unique indexes to prevent duplicate suppressions per shape.
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
