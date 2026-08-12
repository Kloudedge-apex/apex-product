-- Migration: OutreachArtifact idempotency partial unique index
-- Ticket: P0 #9 go-live-audit-2026-06-01
-- Date drafted: 2026-06-01
-- Status: PENDING APPROVAL (do not apply without operator sign-off)
--
-- Enforces hard idempotency on outreach artifact creation by uniquing on
-- (orgId, graphRunId, toolName, recipientRef). The application-level
-- findFirst guard in OutreachArtifactsService.recordDryRun handles ordinary
-- retries. This index closes the concurrent-insert race between workers.
--
-- This is an operator-run psql migration under docs/migrations. The repository
-- has no runner for this directory: `pnpm --filter @apex/db db:migrate` invokes
-- `prisma migrate dev`, which only discovers packages/db/prisma/migrations.
-- Do not move this SQL into a transaction-wrapping runner.
--
-- REQUIRED INVOCATION (after approval; do not add `-1`/`--single-transaction`):
--   psql --no-psqlrc --set=ON_ERROR_STOP=1 "$DATABASE_URL" \
--     --file=docs/migrations/2026-06-01_outreach-artifact-unique.sql
--
-- REQUIRED ORDER:
--   1. Pause every API/worker path that can call recordDryRun. This prevents a
--      new duplicate from racing the preflight while the concurrent build runs.
--   2. Run the duplicate preflight below. If it returns a non-zero count, stop
--      and reconcile those rows manually; this migration never deletes data.
--   3. Run this file with the exact non-transactional psql invocation above.
--   4. Confirm the final verification query returns one valid/ready index,
--      then resume artifact writers and deploy code that relies on the index.
--
-- STANDALONE DUPLICATE PREFLIGHT (read-only; a zero count is the pass state):
--   SELECT COUNT(*) AS duplicate_group_count
--   FROM (
--     SELECT 1
--     FROM "OutreachArtifact"
--     WHERE "graphRunId" IS NOT NULL AND "recipientRef" IS NOT NULL
--     GROUP BY "orgId", "graphRunId", "toolName", "recipientRef"
--     HAVING COUNT(*) > 1
--   ) AS duplicate_groups;
--
-- Safety and retry behavior:
--   * CREATE INDEX CONCURRENTLY is intentionally outside BEGIN/COMMIT. psql
--     autocommit is required; `psql -1`, an already-open transaction, or a
--     transaction-wrapping migration runner will fail.
--   * The partial predicate intentionally permits multiple rows whose
--     graphRunId or recipientRef is NULL.
--   * A failed concurrent build can leave an INVALID index. On retry, this
--     script drops only that unusable fixed-name index, using CONCURRENTLY,
--     before rebuilding it. A valid but incompatible same-name index aborts
--     for operator review instead of being silently accepted or replaced.
--   * CREATE INDEX CONCURRENTLY avoids an ACCESS EXCLUSIVE table lock, but it
--     performs multiple scans and can wait on old transactions. Schedule and
--     observe it as an online schema change.

\set ON_ERROR_STOP on
\set AUTOCOMMIT on

-- Fail closed if the target table is absent or duplicate keys already exist.
-- This DO statement has its own short implicit transaction, which finishes
-- before the non-transactional concurrent index statements below.
DO $preflight$
DECLARE
  duplicate_group_count BIGINT;
BEGIN
  IF to_regclass(format('%I.%I', current_schema(), 'OutreachArtifact')) IS NULL THEN
    RAISE EXCEPTION
      'OutreachArtifact table was not found in current schema %',
      current_schema();
  END IF;

  SELECT COUNT(*)
  INTO duplicate_group_count
  FROM (
    SELECT 1
    FROM "OutreachArtifact"
    WHERE "graphRunId" IS NOT NULL AND "recipientRef" IS NOT NULL
    GROUP BY "orgId", "graphRunId", "toolName", "recipientRef"
    HAVING COUNT(*) > 1
  ) AS duplicate_groups;

  IF duplicate_group_count > 0 THEN
    RAISE EXCEPTION
      'OutreachArtifact idempotency preflight failed: % duplicate key group(s); reconcile them manually before retrying',
      duplicate_group_count;
  END IF;
END
$preflight$;

-- Inspect a fixed-name index before deciding whether this is a no-op, a safe
-- retry after an interrupted build, or an incompatible-object failure.
SELECT
  EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS index_class
    JOIN pg_catalog.pg_namespace AS index_namespace
      ON index_namespace.oid = index_class.relnamespace
    WHERE index_namespace.nspname = current_schema()
      AND index_class.relname = 'OutreachArtifact_idempotency_uniq'
      AND index_class.relkind = 'i'
  ) AS existing_index,
  COALESCE((
    SELECT index_state.indisvalid AND index_state.indisready
    FROM pg_catalog.pg_class AS index_class
    JOIN pg_catalog.pg_namespace AS index_namespace
      ON index_namespace.oid = index_class.relnamespace
    JOIN pg_catalog.pg_index AS index_state
      ON index_state.indexrelid = index_class.oid
    WHERE index_namespace.nspname = current_schema()
      AND index_class.relname = 'OutreachArtifact_idempotency_uniq'
      AND index_class.relkind = 'i'
  ), false) AS existing_index_usable,
  COALESCE((
    SELECT
      index_state.indisunique
      AND index_state.indisvalid
      AND index_state.indisready
      AND index_state.indnkeyatts = 4
      AND index_state.indnatts = 4
      AND index_state.indrelid = to_regclass(
        format('%I.%I', current_schema(), 'OutreachArtifact')
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
      ) = ARRAY['orgId', 'graphRunId', 'toolName', 'recipientRef']::NAME[]
      AND regexp_replace(
        pg_get_expr(index_state.indpred, index_state.indrelid),
        '[[:space:]()"]',
        '',
        'g'
      ) = 'graphRunIdISNOTNULLANDrecipientRefISNOTNULL'
    FROM pg_catalog.pg_class AS index_class
    JOIN pg_catalog.pg_namespace AS index_namespace
      ON index_namespace.oid = index_class.relnamespace
    JOIN pg_catalog.pg_index AS index_state
      ON index_state.indexrelid = index_class.oid
    WHERE index_namespace.nspname = current_schema()
      AND index_class.relname = 'OutreachArtifact_idempotency_uniq'
      AND index_class.relkind = 'i'
  ), false) AS existing_index_matches
\gset

\if :existing_index
  \if :existing_index_usable
    \if :existing_index_matches
      \echo 'OutreachArtifact_idempotency_uniq is already valid and matches; no build required.'
    \else
      DO $incompatible_index$
      BEGIN
        RAISE EXCEPTION
          'valid index OutreachArtifact_idempotency_uniq exists with an incompatible definition; operator review required';
      END
      $incompatible_index$;
    \endif
  \else
    \echo 'Dropping unusable OutreachArtifact_idempotency_uniq from an interrupted concurrent build.'
    DROP INDEX CONCURRENTLY IF EXISTS "OutreachArtifact_idempotency_uniq";

    CREATE UNIQUE INDEX CONCURRENTLY "OutreachArtifact_idempotency_uniq"
      ON "OutreachArtifact" ("orgId", "graphRunId", "toolName", "recipientRef")
      WHERE "graphRunId" IS NOT NULL AND "recipientRef" IS NOT NULL;
  \endif
\else
  CREATE UNIQUE INDEX CONCURRENTLY "OutreachArtifact_idempotency_uniq"
    ON "OutreachArtifact" ("orgId", "graphRunId", "toolName", "recipientRef")
    WHERE "graphRunId" IS NOT NULL AND "recipientRef" IS NOT NULL;
\endif

-- Final fail-closed verification. A successful run must return exactly one
-- matching, unique, valid, ready partial index.
DO $verify$
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
    AND index_class.relname = 'OutreachArtifact_idempotency_uniq'
    AND index_class.relkind = 'i'
    AND index_state.indisunique
    AND index_state.indisvalid
    AND index_state.indisready
    AND index_state.indnkeyatts = 4
    AND index_state.indnatts = 4
    AND index_state.indrelid = to_regclass(
      format('%I.%I', current_schema(), 'OutreachArtifact')
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
    ) = ARRAY['orgId', 'graphRunId', 'toolName', 'recipientRef']::NAME[]
    AND regexp_replace(
      pg_get_expr(index_state.indpred, index_state.indrelid),
      '[[:space:]()"]',
      '',
      'g'
    ) = 'graphRunIdISNOTNULLANDrecipientRefISNOTNULL';

  IF verified_index_count <> 1 THEN
    RAISE EXCEPTION
      'OutreachArtifact_idempotency_uniq verification failed: expected 1 matching valid index, found %',
      verified_index_count;
  END IF;
END
$verify$;

-- Rollback, only with separate operator approval and never inside a transaction:
--   DROP INDEX CONCURRENTLY IF EXISTS "OutreachArtifact_idempotency_uniq";
