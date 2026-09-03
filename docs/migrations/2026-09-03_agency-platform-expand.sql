-- Migration: WorkforceOS agency-mode expansion
-- Date drafted: 2026-09-03
-- Status: REVIEWED CANDIDATE; production apply still requires signed approval.
-- Execute without an outer transaction because PostgreSQL enum additions
-- must commit before matching application code may write the new value.
--   psql --no-psqlrc --set=ON_ERROR_STOP=1 "$DATABASE_URL" \
--     --file=docs/migrations/2026-09-03_agency-platform-expand.sql
-- Existing nullable Company rows must be reconciled explicitly; aborting is
-- safer than assigning a tenant and risking cross-org disclosure.

\set ON_ERROR_STOP on
\set AUTOCOMMIT on

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Company" WHERE "orgId" IS NULL) THEN
    RAISE EXCEPTION 'Company.orgId contains NULL rows; reconcile them before this migration';
  END IF;
END $$;

ALTER TYPE "EmailSource" ADD VALUE IF NOT EXISTS 'VERIFIED_PATTERN';

BEGIN;

ALTER TABLE "Org"
  ADD COLUMN IF NOT EXISTS "designPartner" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Org" ALTER COLUMN "designPartner" SET DEFAULT true;
ALTER TABLE "Org" ALTER COLUMN "plan" SET DEFAULT 'ENTERPRISE';

ALTER TABLE "Company"
  ADD COLUMN IF NOT EXISTS "serpDescription" TEXT,
  ADD COLUMN IF NOT EXISTS "serpSourceUrl" TEXT;

ALTER TABLE "PatternStore" ADD COLUMN IF NOT EXISTS "orgId" TEXT;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "PatternStore" AS p
    WHERE p."orgId" IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM "Company" AS c
        WHERE c."domain" = p."domain" AND c."orgId" IS NOT NULL
      )
  ) THEN
    RAISE EXCEPTION 'PatternStore has rows with no tenant-scoped Company match';
  END IF;
END $$;
DROP INDEX IF EXISTS "PatternStore_domain_key";
WITH ranked_matches AS (
  SELECT
    p."id" AS pattern_id,
    c."orgId",
    row_number() OVER (PARTITION BY p."id" ORDER BY c."orgId") AS position
  FROM "PatternStore" AS p
  JOIN (
    SELECT DISTINCT "domain", "orgId"
    FROM "Company"
    WHERE "orgId" IS NOT NULL
  ) AS c ON c."domain" = p."domain"
  WHERE p."orgId" IS NULL
)
UPDATE "PatternStore" AS p
SET "orgId" = ranked_matches."orgId"
FROM ranked_matches
WHERE p."id" = ranked_matches.pattern_id
  AND ranked_matches.position = 1;
CREATE UNIQUE INDEX IF NOT EXISTS "PatternStore_orgId_domain_key"
  ON "PatternStore"("orgId", "domain");
INSERT INTO "PatternStore" (
  "id", "orgId", "domain", "patterns", "sampleSize", "lastUpdated"
)
SELECT
  p."id" || ':' || c."orgId",
  c."orgId",
  p."domain",
  p."patterns",
  p."sampleSize",
  p."lastUpdated"
FROM "PatternStore" AS p
JOIN (
  SELECT DISTINCT "domain", "orgId"
  FROM "Company"
  WHERE "orgId" IS NOT NULL
) AS c ON c."domain" = p."domain"
WHERE p."orgId" IS DISTINCT FROM c."orgId"
ON CONFLICT ("orgId", "domain") DO NOTHING;
ALTER TABLE "PatternStore" ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "PatternStore"
  ADD CONSTRAINT "PatternStore_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Org"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX IF NOT EXISTS "PatternStore_orgId_idx" ON "PatternStore"("orgId");

ALTER TABLE "Company" DROP CONSTRAINT IF EXISTS "Company_orgId_fkey";
ALTER TABLE "Company" ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "Company"
  ADD CONSTRAINT "Company_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Org"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
