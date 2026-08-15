-- Migration: Week-1 hardening expand (send-claim enum values + Gmail watermark)
-- Ticket: B6/B2 week1-hardening audit 2026-06-12
-- Date drafted: 2026-06-12
-- Status: PENDING APPROVAL (do not apply without operator sign-off)
--
-- 1) Extends OutreachArtifactStatus with the two values backing the send
--    worker's CAS claim protocol (audit B6 — non-atomic dispatch→markSent):
--      • SENDING   — claim state. A worker CAS'd APPROVED → SENDING before
--        dispatch so concurrent workers cannot double-send. Transient:
--        released back to APPROVED on failure / by the reconcile sweep.
--      • SIMULATED — terminal state for forced-mock sends (org not in
--        OUTREACH_LIVE_FOR_ORGS). Keeps the mock_ receipt for the audit
--        trail without letting dashboards count simulated traffic as SENT.
-- 2) Adds Integration."lastHistoryId" (audit B2) so the Gmail push history
--    watermark survives process restarts — replaces the in-memory
--    HISTORY_WATERMARK map in integrations/gmail/gmail.service.ts.
--
-- Safety:
--   • Wholly additive (expand-only): two enum values + one NULLABLE column.
--     No existing row references the new values at apply time; no backfill.
--   • IMPORTANT: ALTER TYPE ... ADD VALUE must NOT run inside a transaction
--     block. The two enum statements below are intentionally OUTSIDE any
--     BEGIN/COMMIT — apply with autocommit (psql -f runs each statement in
--     its own implicit transaction, which is exactly what we want). Even on
--     PG 12+, where the statement is allowed in a transaction, the new value
--     is unusable until commit, so autocommit is the only safe mode.
--   • Old images are forward-compatible: rows only enter SENDING/SIMULATED
--     once the new worker image rolls, so the migration can apply before the
--     deploy (expand-first ordering).
--
-- Recommended apply on apex-prod-db:
--   psql "$DATABASE_URL" -f docs/migrations/2026-06-12_week1-hardening-expand.sql

-- ─── 1) OutreachArtifactStatus: claim + simulated values ─
-- Must run outside a transaction block (see Safety above). New values are
-- appended at the enum's end — schema.prisma mirrors this order.
ALTER TYPE "OutreachArtifactStatus" ADD VALUE IF NOT EXISTS 'SENDING';
ALTER TYPE "OutreachArtifactStatus" ADD VALUE IF NOT EXISTS 'SIMULATED';

-- ─── 2) Integration: Gmail push history watermark ────────
BEGIN;

ALTER TABLE "Integration"
  ADD COLUMN IF NOT EXISTS "lastHistoryId" TEXT;

COMMIT;

-- ─── Rollback (in case of urgent revert) ─────────────────
-- Postgres has no ALTER TYPE ... DROP VALUE. Stranded enum values are
-- harmless while no row references them; force-reverting would mean
-- rebuilding the type, which is not worth it for an expand-only change.
-- The column rollback is safe:
-- BEGIN;
-- ALTER TABLE "Integration" DROP COLUMN IF EXISTS "lastHistoryId";
-- COMMIT;
