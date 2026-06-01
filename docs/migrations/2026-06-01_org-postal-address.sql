-- Migration: Org CAN-SPAM postal-address fields
-- Ticket: P0 #2 go-live-audit-2026-06-01
-- Date drafted: 2026-06-01
-- Status: PENDING APPROVAL (do not apply without operator sign-off)
--
-- Adds three nullable columns to the Org table so the send worker can
-- append a CAN-SPAM §7704(a)(5)-compliant footer to outbound email and so
-- the operator UI can let admins configure their organisation's mailing
-- identity.
--
-- Safety:
--   • Wholly additive: three NULLABLE columns. No constraint changes, no
--     backfill required for deploy.
--   • The application code treats a null physicalAddress as "address not
--     configured" and (in a follow-up commit) blocks APPROVED → SENT until
--     it is set.
--
-- Recommended apply on apex-prod-db:
--   psql "$DATABASE_URL" -f docs/migrations/2026-06-01_org-postal-address.sql

BEGIN;

ALTER TABLE "Org"
  ADD COLUMN "physicalAddress" TEXT,
  ADD COLUMN "country"         TEXT,
  ADD COLUMN "senderName"      TEXT;

COMMIT;

-- ─── Rollback (in case of urgent revert) ─────────────────
-- BEGIN;
-- ALTER TABLE "Org" DROP COLUMN IF EXISTS "senderName";
-- ALTER TABLE "Org" DROP COLUMN IF EXISTS "country";
-- ALTER TABLE "Org" DROP COLUMN IF EXISTS "physicalAddress";
-- COMMIT;
