-- 012_outreach_suppression_reason.sql
-- Store the reason the suppression guard blocked an approved artifact.

ALTER TABLE "OutreachArtifact"
ADD COLUMN "suppressionReason" TEXT;

