-- Migration: OutreachSuppression table + reason enum (CAN-SPAM / GDPR e-Privacy)
-- Ticket: P0 #3 go-live-audit-2026-06-01
-- Date drafted: 2026-06-01
-- Status: PENDING APPROVAL (do not apply without operator sign-off)
--
-- Backs the public unsubscribe HMAC URL stamped on every outbound email
-- (List-Unsubscribe + List-Unsubscribe-Post: One-Click). The send worker
-- queries this table before any real send and skips with a SUPPRESSED
-- status if the (orgId, recipientRef) pair is present.
--
-- Safety:
--   • Wholly additive: new enum + new table + new unique index. Does NOT
--     touch any existing row.
--   • New unique constraint applies only to rows in the new table.
--   • Apply order is independent of any other pending migration — can run
--     before or after 2026-06-01_org-postal-address.sql.
--
-- Recommended apply on apex-prod-db:
--   psql "$DATABASE_URL" -f docs/migrations/2026-06-01_outreach-suppression.sql

BEGIN;

-- Extend OutreachArtifactStatus with a SUPPRESSED terminal value so the
-- worker can mark artifacts that were skipped due to suppression-list hits.
-- Additive — no existing rows reference the new value at apply time.
ALTER TYPE "OutreachArtifactStatus" ADD VALUE IF NOT EXISTS 'SUPPRESSED';

CREATE TYPE "OutreachSuppressionReason" AS ENUM (
  'USER_UNSUBSCRIBED',
  'BOUNCED',
  'COMPLAINED',
  'MANUAL'
);

CREATE TABLE "OutreachSuppression" (
  "id"           TEXT NOT NULL PRIMARY KEY,
  "orgId"        TEXT NOT NULL,
  "recipientRef" TEXT NOT NULL,
  "reason"       "OutreachSuppressionReason" NOT NULL DEFAULT 'USER_UNSUBSCRIBED',
  "source"       TEXT,
  "metadata"     JSONB,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "OutreachSuppression_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "OutreachSuppression_orgId_recipientRef_key"
  ON "OutreachSuppression" ("orgId", "recipientRef");

CREATE INDEX "OutreachSuppression_orgId_createdAt_idx"
  ON "OutreachSuppression" ("orgId", "createdAt");

COMMIT;

-- ─── Rollback (in case of urgent revert) ─────────────────
-- BEGIN;
-- DROP TABLE IF EXISTS "OutreachSuppression";
-- DROP TYPE IF EXISTS "OutreachSuppressionReason";
-- COMMIT;
