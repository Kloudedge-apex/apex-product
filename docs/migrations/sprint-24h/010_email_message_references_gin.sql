-- 010_email_message_references_gin.sql
-- Hot path: inbound correlator walks references[] reverse to find the
-- originating outbound message. btree on String[] is useless; GIN gives
-- O(log n) array-contains lookups during inbound correlation.
--
-- NOTE: CONCURRENTLY cannot run inside a transaction.
CREATE INDEX CONCURRENTLY IF NOT EXISTS
  idx_email_message_org_references_gin
  ON "EmailMessage"
  USING GIN ("references")
  WHERE "references" IS NOT NULL AND array_length("references", 1) > 0;
