# PR Notes — GTM Observability (Backend)

## Summary

This change adds optional LangSmith tracing, OpenTelemetry tracing bootstrap, an append-only EvidenceEvent ledger, and KPI read endpoints. All new telemetry is best-effort: failures are swallowed and never break the pipeline.

## New files

- `apps/api/docs/evidence-event.sql` — human-reviewed DDL for append-only `evidence_event` table (+ revoke + deny trigger).
- `apps/api/src/observability/evidence-event.types.ts` — discriminated-union payload definitions for evidence events.
- `apps/api/src/observability/evidence-ledger.service.ts` — append-only EvidenceEvent writer with one method per kind.
- `apps/api/src/observability/langsmith.config.ts` — typed `LANGSMITH_*` env reader (all optional; max chars defaults to 4000).
- `apps/api/src/observability/langsmith.service.ts` — `LangSmithService.wrapLlm(...)` wrapper with redaction + capture gating + dynamic import.
- `apps/api/src/observability/langsmith.service.spec.ts` — proves no-key path makes zero `import("langsmith")` calls and zero `fetch` calls.
- `apps/api/src/observability/tracing.ts` — OTel `NodeSDK` bootstrap (HTTP + Nest + Prisma) with attribute scrubbing.
- `apps/api/src/observability/graph-tracing.ts` — `withNodeSpan(...)` helper with typed `NodeSpanAttrs`.
- `apps/api/src/observability/graph-tracing.spec.ts` — asserts node attributes + forbidden-attr scrubbing with `InMemorySpanExporter`.
- `apps/api/src/observability/observability.module.ts` — Nest module exporting `LangSmithService` + `EvidenceLedgerService` (global).
- `apps/api/src/kpis/dto/window.dto.ts` — `windowDays` DTO (default 7, min 1, max 90).
- `apps/api/src/kpis/queries.ts` — org-scoped query helpers (each requires `orgId`).
- `apps/api/src/kpis/kpi-calculator.service.ts` — KPI calculator service (operational/quality/commercial/guaranteeDefense/experimentation).
- `apps/api/src/kpis/kpis.controller.ts` — `GET /api/kpis*` endpoints (family routes + aggregator).
- `apps/api/src/kpis/kpis.module.ts` — Nest module wiring KPI controller + service.
- `apps/api/src/kpis/__tests__/kpi-calculator.service.spec.ts` — cross-org isolation test (org A KPIs only see org A rows).
- `apps/api/PR_NOTES.md` — this document.

## Modified files

- `apps/api/package.json` — adds LangSmith + OTel + Prisma instrumentation deps.
- `apps/api/src/app.module.ts` — imports `ObservabilityModule` and `KpisModule`.
- `apps/api/src/main.ts` — imports `./observability/tracing` first (OTel patching order).
- `apps/api/src/runtime/runtime.module.ts` — imports `ObservabilityModule` for `LangSmithService` DI.
- `apps/api/src/runtime/llm.service.ts` — injects `LangSmithService` and wraps Azure/OpenAI/Anthropic `chat` calls; adds `ChatOptions.parentRunId?`.
- `apps/api/src/graph/graph.module.ts` — imports `ObservabilityModule`.
- `apps/api/src/graph/graph.service.ts` — emits approval evidence events on interrupt/resume path.
- `apps/api/src/graph/pipeline-graph.ts` — wraps nodes in `withNodeSpan` and emits sourcing/scoring evidence events.
- `apps/api/src/graph/nodes/sdr-outreach-subgraph.ts` — wraps nodes in `withNodeSpan` and emits drafted/QA evidence events.
- `apps/api/src/graph/__tests__/pipeline-graph.spec.ts` — updates deps to include `evidenceLedger` stub.
- `apps/api/src/graph/__tests__/sdr-outreach-subgraph.spec.ts` — updates deps to include `evidenceLedger` stub.
- `apps/api/src/graph/__tests__/sdr-qa-regression.spec.ts` — updates deps to include `evidenceLedger` stub.
- `apps/api/src/outreach/outreach-artifacts.service.ts` — emits `artifact.persisted` evidence event (optional DI for tests).
- `packages/db/prisma/schema.prisma` — maps `EvidenceEvent` to table `evidence_event` via `@@map("evidence_event")`.

## Deliberate non-changes (per task constraints)

- No edits to `apps/api/src/runtime/executor.service.ts`.
- No changes to the OutreachArtifact status machine (only an additive evidence-ledger call after persist).
- No changes to `SideEffectPolicy` or any `SideEffectPolicy.check` call sites.
- No changes to `OUTREACH_EXECUTION_MODE` default behavior.
- No edits to `apps/web/**` or `apps/dashboard/**`.

## Dependency justifications

- `langsmith` — optional LLM tracing; dynamically imported only when `LANGSMITH_API_KEY` is set.
- `@opentelemetry/api` — span context access (e.g., `trace.getActiveSpan()` for `traceId` in EvidenceEvent).
- `@opentelemetry/sdk-node` — Node OTel bootstrap (`NodeSDK`) for traces.
- `@opentelemetry/exporter-trace-otlp-http` — OTLP HTTP exporter when `OTEL_EXPORTER_OTLP_ENDPOINT` is set.
- `@opentelemetry/instrumentation-http` — HTTP client/server spans (no request/response body capture).
- `@opentelemetry/instrumentation-nestjs-core` — NestJS spans (controller/middleware lifecycle).
- `@prisma/instrumentation` — Prisma tracing integration (**deviation** from architect plan’s `@opentelemetry/instrumentation-prisma`; this is the actual published package name).
- `@opentelemetry/instrumentation-bullmq` — **NOT added**: package does not exist on npm as of this run (documented below).

## Security must-do checklist (11 items from task)

1. Dynamic-load LangSmith SDK only on active path (`LANGSMITH_API_KEY` set): **done**
2. No-key path causes **zero** `import("langsmith")` calls and **zero** `fetch` calls (unit test): **done**
3. LangSmith redactor drops `tool_call_id`: **done**
4. LangSmith redactor drops raw tool args (`arguments` / `tool_args`): **done**
5. LangSmith redactor drops embeddings input (best-effort key-based): **done**
6. LangSmith redactor hashes email addresses via SHA-256: **done**
7. LangSmith truncates captured strings to `LANGSMITH_MAX_CONTENT_CHARS` (default 4000): **done**
8. LangSmith captures prompts only when `LANGSMITH_CAPTURE_PROMPTS === "true"`: **done**
9. OTel NodeSDK uses only explicit instrumentations (no auto-instrumentations): **done**
10. OTel never exports forbidden PII-bearing span attrs (`db.statement`, `db.parameters`, `job.data`, `messaging.message.payload`) via onEnd scrubber: **done**
11. BullMQ instrumentation existence check and opt-in if available: **deferred** (package not found on npm; no BullMQ spans)

## EvidenceEvent DDL (inline copy)

```sql
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
```

## Prisma safety statement

No `prisma db push`, `migrate dev`, or `migrate deploy` was invoked. DDL is emitted to `apps/api/docs/evidence-event.sql` for human review.

## Open questions for the human operator

1. What Postgres role should replace `"<app-role>"` in the `REVOKE` statement?
2. Is it acceptable that LangSmith run trees are created when `LANGSMITH_API_KEY` is set even if `LANGSMITH_CAPTURE_PROMPTS` is not `"true"` (inputs/outputs omitted in that case)?
3. Do we want to treat `LANGSMITH_TRACING !== "false"` as “enabled by default” (current behavior), or require `LANGSMITH_TRACING === "true"` to activate tracing?
4. Should commercial KPIs treat “qualified” as LeadScore `score >= 50`, or require `qualifiedAt != null`?
5. BullMQ spans: do we want a different, existing instrumentation package, or is it acceptable to ship without BullMQ tracing for now?

