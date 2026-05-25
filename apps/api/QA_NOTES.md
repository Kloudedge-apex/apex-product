# QA Notes — GTM Observability + KPIs (Backend)

Date: 2026-05-23 (UTC)

## Acceptance gates

Note: in this sandbox, `pnpm` fails with `unable to open database file` unless XDG dirs are redirected to a writable path (e.g. `/tmp`). All commands below were run with:

`XDG_DATA_HOME=/tmp/xdg-data XDG_CACHE_HOME=/tmp/xdg-cache`

1. `pnpm install`
   - First attempt (`pnpm install`) failed: `unable to open database file`.
   - Succeeded via `pnpm install --store-dir /tmp/pnpm-store`.
2. `pnpm --filter @apex/api type-check`
   - Initially failed because Prisma Client types were not generated (many missing `@prisma/client` exports).
   - Fixed by running `pnpm --filter @apex/db db:generate` (Prisma generate only; no migrate/push).
   - Then `pnpm --filter @apex/api type-check` passed (exit 0).
3. `pnpm --filter @apex/api lint`
   - Passed (exit 0) with existing warnings (no errors).
4. `pnpm --filter @apex/api test`
   - Passed (exit 0).
   - Before adding QA regression tests: `233 passed (233)`.
   - After adding QA regression tests in this worktree: `242 passed (242)`.

## Security must-do verification (11 items)

1. **No-key LangSmith path is zero-import + zero-fetch**
   - **VERIFIED**: `apps/api/src/observability/langsmith.service.spec.ts` — `no-ops without LANGSMITH_API_KEY (no dynamic import, no fetch)`
2. **Redactor drops `tool_call_id`**
   - **GAP CLOSED**: `apps/api/src/observability/langsmith.service.spec.ts` — `drops tool_call_id from captured inputs/outputs`
3. **Redactor drops raw tool args (`arguments` / `tool_args`)**
   - **GAP CLOSED**: `apps/api/src/observability/langsmith.service.spec.ts` — `drops raw tool args (arguments/tool_args) from captured inputs/outputs`
4. **Redactor drops embeddings input (`input` / `texts` on embedding-like objects)**
   - **GAP CLOSED**: `apps/api/src/observability/langsmith.service.spec.ts` — `drops embedding-like inputs (input/texts) from captured payloads`
5. **Redactor hashes email addresses (SHA-256)**
   - **GAP CLOSED**: `apps/api/src/observability/langsmith.service.spec.ts` — `hashes email addresses in captured strings (sha256)`
6. **Redactor truncates strings to `LANGSMITH_MAX_CONTENT_CHARS` (default 4000)**
   - **GAP CLOSED**: `apps/api/src/observability/langsmith.service.spec.ts` — `truncates captured strings to LANGSMITH_MAX_CONTENT_CHARS (default 4000)`
7. **Capture only when `LANGSMITH_CAPTURE_PROMPTS === "true"`**
   - **GAP CLOSED**: `apps/api/src/observability/langsmith.service.spec.ts` — `captures prompts only when LANGSMITH_CAPTURE_PROMPTS === "true"`
8. **OTel forbidden-attribute scrubber works**
   - **VERIFIED**: `apps/api/src/observability/graph-tracing.spec.ts` — `scrubs forbidden attributes from spans (defense-in-depth)`
9. **`withNodeSpan` typed allow-list (compile-time)**
   - **GAP CLOSED**: `apps/api/src/observability/graph-tracing.spec.ts` — `enforces a typed allow-list for NodeSpanAttrs (compile-time)`
10. **EvidenceLedger writer gated on `EVIDENCE_LEDGER_ENABLED !== "false"`**
   - **GAP CLOSED**: `apps/api/src/runtime/__tests__/evidence-ledger.service.spec.ts` — `is gated on EVIDENCE_LEDGER_ENABLED !== "false"`
11. **KPI cross-org isolation**
   - **VERIFIED**: `apps/api/src/kpis/__tests__/kpi-calculator.service.spec.ts` — `isolates orgId across KPI queries (commercial + guaranteeDefense)`

## PR_NOTES vs reality (contradictions / deltas)

- `apps/api/src/observability/langsmith.service.spec.ts` existed but only covered the no-key path. The PR’s “Security must-do checklist” claims for redaction, hashing, truncation, and capture gating were not actually exercised by tests until the additional unit tests were added in this QA pass.
- The acceptance-gate sequence as written (`pnpm install` → `type-check`) fails in a clean environment unless Prisma Client is generated. Running `pnpm --filter @apex/db db:generate` is required before `pnpm --filter @apex/api type-check` will pass.

## Go / no-go

GO for merge from a test/verification standpoint **if** CI runs Prisma generate before API type-check (or has an equivalent step).

## Open questions

1. Should repo/CI explicitly add a step for `pnpm --filter @apex/db db:generate` before API type-check to match developer/QA expectations?

