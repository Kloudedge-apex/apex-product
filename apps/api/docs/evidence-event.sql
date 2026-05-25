-- EvidenceEvent DDL (append-only)
--
-- Generated via:
--   pnpm --filter @apex/db exec prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script
--
-- Trimmed to EvidenceEvent only. Human-applied after review.

CREATE TABLE "evidence_event" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "runId" TEXT,
    "traceId" TEXT,
    "kind" TEXT NOT NULL,
    "refType" TEXT NOT NULL,
    "refId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evidence_event_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "evidence_event" ADD CONSTRAINT "evidence_event_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "evidence_event_orgId_createdAt_idx" ON "evidence_event"("orgId", "createdAt");
CREATE INDEX "evidence_event_orgId_kind_idx" ON "evidence_event"("orgId", "kind");
CREATE INDEX "evidence_event_runId_idx" ON "evidence_event"("runId");

REVOKE UPDATE, DELETE, TRUNCATE ON evidence_event FROM "<app-role>";

CREATE OR REPLACE FUNCTION evidence_event_block_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'evidence_event is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER evidence_event_no_update_delete
  BEFORE UPDATE OR DELETE ON evidence_event
  FOR EACH ROW EXECUTE FUNCTION evidence_event_block_mutation();

