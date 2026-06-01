-- Migration: OutreachArtifact idempotency @@unique
-- Ticket: P0 #9 go-live-audit-2026-06-01
-- Date drafted: 2026-06-01
-- Status: PENDING APPROVAL (do not apply without operator sign-off)
--
-- Enforces hard idempotency on outreach artifact creation by uniquing on
-- (orgId, graphRunId, toolName, recipientRef). The application-level
-- findFirst-skip guard in OutreachArtifactsService.recordDryRun is correct
-- under steady state; this constraint catches concurrent inserts that race
-- past the guard (two workers re-entering for the same lead before either
-- commits).
--
-- Safety:
--   • Pre-flight check below MUST return 0 before COMMIT. If duplicates
--     exist, apply the dedup CTE first; otherwise the CREATE UNIQUE INDEX
--     fails and the migration aborts cleanly.
--   • CREATE UNIQUE INDEX … WHERE allows nullable graphRunId / recipientRef
--     to coexist in multiple rows (intentional — pre-graph artifacts cannot
--     uniquely correlate).
--   • Recommended apply on apex-prod-db inside maintenance window: holds an
--     ACCESS EXCLUSIVE lock on OutreachArtifact for the duration of the
--     unique-index build.

BEGIN;

-- 1) Pre-flight: confirm no existing duplicates would block the constraint.
--    Run this SELECT outside the transaction first; if it returns >0 rows,
--    dedupe manually before re-running the apply.
-- SELECT "orgId", "graphRunId", "toolName", "recipientRef", COUNT(*)
-- FROM "OutreachArtifact"
-- WHERE "graphRunId" IS NOT NULL AND "recipientRef" IS NOT NULL
-- GROUP BY 1, 2, 3, 4
-- HAVING COUNT(*) > 1;

-- 2) Build the unique index (partial — only when both nullable keys are set).
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS
  "OutreachArtifact_idempotency_uniq"
ON "OutreachArtifact" ("orgId", "graphRunId", "toolName", "recipientRef")
WHERE "graphRunId" IS NOT NULL AND "recipientRef" IS NOT NULL;

COMMIT;

-- NOTE: CREATE INDEX CONCURRENTLY cannot run inside a transaction. If your
-- migration runner wraps everything in BEGIN/COMMIT (e.g. Prisma migrate),
-- run this manually outside the transaction:
--
--   psql "$DATABASE_URL" -c "CREATE UNIQUE INDEX CONCURRENTLY ..."
--
-- The BEGIN/COMMIT pair above is a no-op safety net for runners that ignore
-- the CONCURRENTLY guard.

-- ─── Rollback (in case of urgent revert) ─────────────────
-- DROP INDEX CONCURRENTLY IF EXISTS "OutreachArtifact_idempotency_uniq";
