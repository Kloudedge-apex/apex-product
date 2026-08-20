-- Migration: persist tenant ICP exclusion domains
-- Date drafted: 2026-08-20
-- Status: PENDING APPROVAL - this file was not applied by Codex.
--
-- Expand-only migration. PostgreSQL 16 adds the constant empty-array default
-- without rewriting existing rows. Apply before deploying application code
-- that reads or writes IcpProfile.exclusionDomains.
--
-- REQUIRED INVOCATION (after approval):
--   psql --no-psqlrc --set=ON_ERROR_STOP=1 "$DATABASE_URL" \
--     --file=docs/migrations/2026-08-20_icp-exclusion-domains-expand.sql

\set ON_ERROR_STOP on

BEGIN;

ALTER TABLE "IcpProfile"
  ADD COLUMN IF NOT EXISTS "exclusionDomains" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

DO $verify_column$
DECLARE
  verified_column_count INTEGER;
BEGIN
  SELECT COUNT(*)
  INTO verified_column_count
  FROM information_schema.columns
  WHERE table_schema = current_schema()
    AND table_name = 'IcpProfile'
    AND column_name = 'exclusionDomains'
    AND data_type = 'ARRAY'
    AND udt_name = '_text'
    AND is_nullable = 'NO'
    AND column_default IS NOT NULL;

  IF verified_column_count <> 1 THEN
    RAISE EXCEPTION
      'IcpProfile exclusionDomains verification failed: expected one compatible column, found %',
      verified_column_count;
  END IF;
END
$verify_column$;

COMMIT;

-- Rollback (only after reverting every application reference):
-- ALTER TABLE "IcpProfile" DROP COLUMN IF EXISTS "exclusionDomains";
