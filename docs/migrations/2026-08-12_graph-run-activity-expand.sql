-- Migration: immutable GraphRun start time and separate activity clock
-- Date drafted: 2026-08-12
-- Status: PENDING APPROVAL - review and apply before deploying code that reads
--         or writes GraphRun.lastActivityAt.
--
-- GraphRun.startedAt is the immutable business start time used by run dates
-- and duration calculations. Older application code also reused it as an
-- orphan-recovery lease, overwriting it on HITL resume and crash recovery.
-- This additive column gives workers a dedicated activity/heartbeat clock.
--
-- Safety:
--   - Expand-only column and index; no existing column is rewritten.
--   - Existing rows are backfilled from startedAt. A currently RUNNING row
--     that was already stale therefore remains eligible for recovery.
--   - Apply before the application version that references lastActivityAt.
--   - This file is pending operator approval and must not be applied by an
--     automated coding session.

BEGIN;

ALTER TABLE "GraphRun"
  ADD COLUMN IF NOT EXISTS "lastActivityAt" TIMESTAMP(3);

UPDATE "GraphRun"
SET "lastActivityAt" = "startedAt"
WHERE "lastActivityAt" IS NULL;

ALTER TABLE "GraphRun"
  ALTER COLUMN "lastActivityAt" SET DEFAULT CURRENT_TIMESTAMP,
  ALTER COLUMN "lastActivityAt" SET NOT NULL;

CREATE INDEX IF NOT EXISTS "GraphRun_status_lastActivityAt_idx"
  ON "GraphRun" ("status", "lastActivityAt");

COMMIT;

-- Rollback (only after reverting every application reference):
-- BEGIN;
-- DROP INDEX IF EXISTS "GraphRun_status_lastActivityAt_idx";
-- ALTER TABLE "GraphRun" DROP COLUMN IF EXISTS "lastActivityAt";
-- COMMIT;
