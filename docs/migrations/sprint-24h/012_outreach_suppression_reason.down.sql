-- 012_outreach_suppression_reason.down.sql

ALTER TABLE "OutreachArtifact"
DROP COLUMN IF EXISTS "suppressionReason";

