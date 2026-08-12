-- Migration: durable GraphRun dispatch lifecycle and org single-flight
-- Date drafted: 2026-08-12
-- Status: PENDING APPROVAL - this file was not applied by Codex.
--
-- Prerequisite:
--   Apply 2026-08-12_graph-run-activity-expand.sql first. The application
--   version that uses these columns must not deploy before both migrations.
--
-- This is an operator-run psql migration. CREATE INDEX CONCURRENTLY must not
-- run in a transaction-wrapping migration runner.
--
-- REQUIRED INVOCATION (after approval; do not add -1/--single-transaction):
--   psql --no-psqlrc --set=ON_ERROR_STOP=1 "$DATABASE_URL" \
--     --file=docs/migrations/2026-08-12_graph-run-lifecycle-expand.sql
--
-- REQUIRED ORDER:
--   1. Pause graph-start API traffic, graph schedulers, and graph workers.
--      Existing active rows may remain; do not delete run history.
--   2. Run the duplicate preflight below. A zero count is the pass state.
--      Reconcile any duplicate active runs explicitly before continuing.
--   3. Run this file with the exact non-transactional psql invocation above.
--   4. Retain the final receipt. It must show one valid/ready/live matching
--      unique index and all four lifecycle columns.
--   5. Resume traffic only after application/schema compatibility checks pass.
--
-- STANDALONE DUPLICATE PREFLIGHT (read-only; must return zero):
--   SELECT COUNT(*) AS duplicate_active_org_count
--   FROM (
--     SELECT 1
--     FROM "GraphRun"
--     WHERE "status" IN ('RUNNING', 'AWAITING_APPROVAL')
--     GROUP BY "orgId"
--     HAVING COUNT(*) > 1
--   ) AS duplicate_active_orgs;
--
-- Safety and retry behavior:
--   * The short ALTER transaction is expand-only. Existing rows receive an
--     empty startIcpProfileIds value because a historical queue-only seed
--     cannot be reconstructed safely.
--   * The online partial unique-index build is outside BEGIN/COMMIT. It avoids
--     an ACCESS EXCLUSIVE table lock, but can scan the table and wait on old
--     transactions; schedule and observe it as an online schema change.
--   * A killed concurrent build can leave a fixed-name INVALID index. This
--     script drops only that unusable index concurrently before rebuilding.
--     A valid but incompatible same-name index aborts for operator review.
--   * The partial index is the durable backstop to the application's
--     org-scoped pg_advisory_xact_lock transaction.

\set ON_ERROR_STOP on
\set AUTOCOMMIT on

BEGIN;

ALTER TABLE "GraphRun"
  ADD COLUMN IF NOT EXISTS "startIcpProfileIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS "pendingResumeApproved" BOOLEAN,
  ADD COLUMN IF NOT EXISTS "pendingResumeApprovedBy" TEXT,
  ADD COLUMN IF NOT EXISTS "dispatchGeneration" INTEGER NOT NULL DEFAULT 0;

COMMIT;

-- Fail closed on duplicate active rows after writers have been paused.
DO $preflight$
DECLARE
  duplicate_active_org_count BIGINT;
BEGIN
  SELECT COUNT(*)
  INTO duplicate_active_org_count
  FROM (
    SELECT 1
    FROM "GraphRun"
    WHERE "status" IN (
      'RUNNING'::"GraphRunStatus",
      'AWAITING_APPROVAL'::"GraphRunStatus"
    )
    GROUP BY "orgId"
    HAVING COUNT(*) > 1
  ) AS duplicate_active_orgs;

  IF duplicate_active_org_count > 0 THEN
    RAISE EXCEPTION
      'GraphRun single-flight preflight failed: % org(s) have duplicate active runs; reconcile manually before retrying',
      duplicate_active_org_count;
  END IF;
END
$preflight$;

-- Classify a fixed-name index as absent, valid+matching, invalid/unusable, or
-- valid+incompatible. The OR predicate is intentional: pg_get_expr has a
-- stable normalized representation for this exact definition.
SELECT
  EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS index_class
    JOIN pg_catalog.pg_namespace AS index_namespace
      ON index_namespace.oid = index_class.relnamespace
    WHERE index_namespace.nspname = current_schema()
      AND index_class.relname = 'GraphRun_one_active_per_org_key'
      AND index_class.relkind = 'i'
  ) AS existing_index,
  COALESCE((
    SELECT index_state.indisvalid
      AND index_state.indisready
      AND index_state.indislive
    FROM pg_catalog.pg_class AS index_class
    JOIN pg_catalog.pg_namespace AS index_namespace
      ON index_namespace.oid = index_class.relnamespace
    JOIN pg_catalog.pg_index AS index_state
      ON index_state.indexrelid = index_class.oid
    WHERE index_namespace.nspname = current_schema()
      AND index_class.relname = 'GraphRun_one_active_per_org_key'
      AND index_class.relkind = 'i'
  ), false) AS existing_index_usable,
  COALESCE((
    SELECT index_state.indisunique
      AND index_state.indisvalid
      AND index_state.indisready
      AND index_state.indislive
      AND index_state.indnkeyatts = 1
      AND index_state.indnatts = 1
      AND index_state.indrelid = to_regclass(
        format('%I.%I', current_schema(), 'GraphRun')
      )
      AND ARRAY(
        SELECT table_column.attname
        FROM unnest(index_state.indkey::SMALLINT[]) WITH ORDINALITY
          AS index_column(attnum, position)
        JOIN pg_catalog.pg_attribute AS table_column
          ON table_column.attrelid = index_state.indrelid
         AND table_column.attnum = index_column.attnum
        WHERE index_column.position <= index_state.indnkeyatts
        ORDER BY index_column.position
      ) = ARRAY['orgId']::NAME[]
      AND regexp_replace(
        pg_get_expr(index_state.indpred, index_state.indrelid),
        '[[:space:]()"]',
        '',
        'g'
      ) = 'status=''RUNNING''::GraphRunStatusORstatus=''AWAITING_APPROVAL''::GraphRunStatus'
    FROM pg_catalog.pg_class AS index_class
    JOIN pg_catalog.pg_namespace AS index_namespace
      ON index_namespace.oid = index_class.relnamespace
    JOIN pg_catalog.pg_index AS index_state
      ON index_state.indexrelid = index_class.oid
    WHERE index_namespace.nspname = current_schema()
      AND index_class.relname = 'GraphRun_one_active_per_org_key'
      AND index_class.relkind = 'i'
  ), false) AS existing_index_matches
\gset

\if :existing_index
  \if :existing_index_usable
    \if :existing_index_matches
      \echo 'GraphRun_one_active_per_org_key is already valid and matches; no build required.'
    \else
      DO $incompatible_index$
      BEGIN
        RAISE EXCEPTION
          'valid index GraphRun_one_active_per_org_key exists with an incompatible definition; operator review required';
      END
      $incompatible_index$;
    \endif
  \else
    \echo 'Dropping unusable GraphRun_one_active_per_org_key from an interrupted concurrent build.'
    DROP INDEX CONCURRENTLY IF EXISTS "GraphRun_one_active_per_org_key";

    CREATE UNIQUE INDEX CONCURRENTLY "GraphRun_one_active_per_org_key"
      ON "GraphRun" ("orgId")
      WHERE "status" = 'RUNNING'::"GraphRunStatus"
         OR "status" = 'AWAITING_APPROVAL'::"GraphRunStatus";
  \endif
\else
  CREATE UNIQUE INDEX CONCURRENTLY "GraphRun_one_active_per_org_key"
    ON "GraphRun" ("orgId")
    WHERE "status" = 'RUNNING'::"GraphRunStatus"
       OR "status" = 'AWAITING_APPROVAL'::"GraphRunStatus";
\endif

DO $verify_columns$
DECLARE
  verified_column_count INTEGER;
BEGIN
  SELECT COUNT(*)
  INTO verified_column_count
  FROM information_schema.columns
  WHERE table_schema = current_schema()
    AND table_name = 'GraphRun'
    AND (
      (
        column_name = 'startIcpProfileIds'
        AND data_type = 'ARRAY'
        AND udt_name = '_text'
        AND is_nullable = 'NO'
        AND column_default IS NOT NULL
      )
      OR (
        column_name = 'pendingResumeApproved'
        AND data_type = 'boolean'
        AND is_nullable = 'YES'
      )
      OR (
        column_name = 'pendingResumeApprovedBy'
        AND data_type = 'text'
        AND is_nullable = 'YES'
      )
      OR (
        column_name = 'dispatchGeneration'
        AND data_type = 'integer'
        AND is_nullable = 'NO'
        AND column_default IS NOT NULL
      )
    );

  IF verified_column_count <> 4 THEN
    RAISE EXCEPTION
      'GraphRun lifecycle column verification failed: expected 4 compatible columns, found %',
      verified_column_count;
  END IF;
END
$verify_columns$;

-- Executable postcondition. ON_ERROR_STOP makes the operator run fail unless
-- the fixed-name index is unique, live, valid, ready, on exactly orgId, and
-- has exactly the intended active-status predicate.
DO $verify_index$
DECLARE
  verified_index_count INTEGER;
BEGIN
  SELECT COUNT(*)
  INTO verified_index_count
  FROM pg_catalog.pg_class AS index_class
  JOIN pg_catalog.pg_namespace AS index_namespace
    ON index_namespace.oid = index_class.relnamespace
  JOIN pg_catalog.pg_index AS index_state
    ON index_state.indexrelid = index_class.oid
  WHERE index_namespace.nspname = current_schema()
    AND index_class.relname = 'GraphRun_one_active_per_org_key'
    AND index_class.relkind = 'i'
    AND index_state.indisunique
    AND index_state.indisvalid
    AND index_state.indisready
    AND index_state.indislive
    AND index_state.indnkeyatts = 1
    AND index_state.indnatts = 1
    AND index_state.indrelid = to_regclass(
      format('%I.%I', current_schema(), 'GraphRun')
    )
    AND ARRAY(
      SELECT table_column.attname
      FROM unnest(index_state.indkey::SMALLINT[]) WITH ORDINALITY
        AS index_column(attnum, position)
      JOIN pg_catalog.pg_attribute AS table_column
        ON table_column.attrelid = index_state.indrelid
       AND table_column.attnum = index_column.attnum
      WHERE index_column.position <= index_state.indnkeyatts
      ORDER BY index_column.position
    ) = ARRAY['orgId']::NAME[]
    AND regexp_replace(
      pg_get_expr(index_state.indpred, index_state.indrelid),
      '[[:space:]()"]',
      '',
      'g'
    ) = 'status=''RUNNING''::GraphRunStatusORstatus=''AWAITING_APPROVAL''::GraphRunStatus';

  IF verified_index_count <> 1 THEN
    RAISE EXCEPTION
      'GraphRun_one_active_per_org_key verification failed: expected 1 matching valid index, found %',
      verified_index_count;
  END IF;
END
$verify_index$;

-- Readable post-apply receipt. Retain this output with the change record.
SELECT
  index_class.relname AS index_name,
  index_state.indisunique,
  index_state.indisvalid,
  index_state.indisready,
  index_state.indislive,
  pg_get_indexdef(index_class.oid) AS index_definition
FROM pg_catalog.pg_class AS index_class
JOIN pg_catalog.pg_namespace AS index_namespace
  ON index_namespace.oid = index_class.relnamespace
JOIN pg_catalog.pg_index AS index_state
  ON index_state.indexrelid = index_class.oid
WHERE index_namespace.nspname = current_schema()
  AND index_class.relname = 'GraphRun_one_active_per_org_key';

SELECT
  column_name,
  data_type,
  is_nullable,
  column_default
FROM information_schema.columns
WHERE table_schema = current_schema()
  AND table_name = 'GraphRun'
  AND column_name IN (
    'startIcpProfileIds',
    'pendingResumeApproved',
    'pendingResumeApprovedBy',
    'dispatchGeneration'
  )
ORDER BY column_name;

-- Legacy active rows with startIcpProfileIds={} remain recoverable only when a
-- GraphCheckpoint exists. A legacy active row with no checkpoint requires
-- manual reconciliation; never fabricate or guess its original seed.
--
-- Rollback (separate operator approval; concurrent drop outside transaction):
--   DROP INDEX CONCURRENTLY IF EXISTS "GraphRun_one_active_per_org_key";
--   BEGIN;
--   ALTER TABLE "GraphRun"
--     DROP COLUMN IF EXISTS "dispatchGeneration",
--     DROP COLUMN IF EXISTS "pendingResumeApprovedBy",
--     DROP COLUMN IF EXISTS "pendingResumeApproved",
--     DROP COLUMN IF EXISTS "startIcpProfileIds";
--   COMMIT;
