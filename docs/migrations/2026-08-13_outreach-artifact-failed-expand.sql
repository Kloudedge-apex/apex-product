-- Migration: first-class terminal outreach failure (expand)
-- Date drafted: 2026-08-13
-- Status: PENDING APPROVAL - REVIEW ONLY; NOT APPLIED BY CODEX.
--
-- Contract:
--   1. FAILED means dispatch retries were exhausted only when provider
--      acceptance is known to be impossible. It is not a human rejection.
--   2. failureReason/failedAt retain operational evidence without overwriting
--      the original human approval identity or timestamp.
--   3. This file is expand-only and performs no data backfill. Compatibility
--      writers attach failedAt/failureReason to the reserved `auto-failed:`
--      form; readers recognize only those provenance-bearing rows. Historical
--      and old-worker marker rows remain unclassified until a later,
--      separately approved backfill after old workers are drained and an
--      ambiguity inventory is reviewed.
--
-- Apply before deploying the enum-aware compatibility release. That release
-- must keep OUTREACH_FAILED_STATUS_WRITES_ENABLED=false while the console BFF,
-- API, workers, and any other status readers are upgraded and old revisions
-- drained. Only then may an operator enable first-class FAILED writes with the
-- exact reader-drain/inventory attestation described in the runbook. Old
-- Prisma readers are not assumed to deserialize an unknown enum value. No
-- writer pause is required for this schema-only expand step.
--
-- Execute with psql in non-transactional mode so the enum addition commits
-- before later statements use the new value:
--   psql --set=ON_ERROR_STOP=1 --file=<this-file> <operator-managed-connection>
-- Do not wrap this file in one outer transaction.

\set ON_ERROR_STOP on
\set AUTOCOMMIT on

DO $failed_expand_preflight$
BEGIN
  IF to_regclass(format('%I.%I', current_schema(), 'OutreachArtifact')) IS NULL THEN
    RAISE EXCEPTION 'OutreachArtifact table was not found in current schema %', current_schema();
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_type AS t
    JOIN pg_namespace AS n ON n.oid = t.typnamespace
    WHERE n.nspname = current_schema()
      AND t.typname = 'OutreachArtifactStatus'
      AND t.typtype = 'e'
  ) THEN
    RAISE EXCEPTION 'OutreachArtifactStatus enum was not found in current schema %', current_schema();
  END IF;
END
$failed_expand_preflight$;

-- Retain this compatibility inventory with the change record. It is not
-- mutated by this expand migration. The prefix was reserved by the legacy
-- worker, but user-entered notes were not historically prevented from using
-- it, so any future backfill requires explicit review.
-- SELECT "id", "orgId", "reviewedBy", "reviewedAt", "reviewerNote", "updatedAt"
-- FROM "OutreachArtifact"
-- WHERE "status" = 'REJECTED'::"OutreachArtifactStatus"
--   AND "reviewerNote" LIKE 'auto-failed:%'
-- ORDER BY "updatedAt", "id";

ALTER TYPE "OutreachArtifactStatus"
  ADD VALUE IF NOT EXISTS 'FAILED';

BEGIN;

ALTER TABLE "OutreachArtifact"
  ADD COLUMN IF NOT EXISTS "failureReason" TEXT,
  ADD COLUMN IF NOT EXISTS "failedAt" TIMESTAMP(3);

DO $failed_expand_postcondition$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_enum AS e
    JOIN pg_type AS t ON t.oid = e.enumtypid
    JOIN pg_namespace AS n ON n.oid = t.typnamespace
    WHERE n.nspname = current_schema()
      AND t.typname = 'OutreachArtifactStatus'
      AND e.enumlabel = 'FAILED'
  ) THEN
    RAISE EXCEPTION 'FAILED enum postcondition failed';
  END IF;

  IF (
    SELECT COUNT(*)
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'OutreachArtifact'
      AND (
        (column_name = 'failureReason' AND data_type = 'text' AND is_nullable = 'YES')
        OR (column_name = 'failedAt'
          AND data_type = 'timestamp without time zone'
          AND datetime_precision = 3
          AND is_nullable = 'YES')
      )
  ) <> 2 THEN
    RAISE EXCEPTION 'OutreachArtifact FAILED evidence columns have an incompatible definition';
  END IF;
END
$failed_expand_postcondition$;

COMMIT;

-- Readable post-apply receipt. It must return FAILED plus exactly the two
-- nullable evidence columns with the definitions checked above.
-- SELECT e.enumlabel
-- FROM pg_enum AS e
-- JOIN pg_type AS t ON t.oid = e.enumtypid
-- JOIN pg_namespace AS n ON n.oid = t.typnamespace
-- WHERE n.nspname = current_schema()
--   AND t.typname = 'OutreachArtifactStatus'
--   AND e.enumlabel = 'FAILED';
-- SELECT column_name, data_type, datetime_precision, is_nullable
-- FROM information_schema.columns
-- WHERE table_schema = current_schema()
--   AND table_name = 'OutreachArtifact'
--   AND column_name IN ('failureReason', 'failedAt')
-- ORDER BY column_name;
