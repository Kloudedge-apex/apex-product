# WS-10 — Tests + Smoke + Release (Backend)

## Summary
- Integrated WS-3 → WS-9 into WS-10 tip (reply classifier, suppression + unsubscribe, enrichment facts + cache guard, LLM request facts, usage rollups, evaluator persistence + golden set, LangGraph attribution + lifecycle/HITL).
- Merge conflicts resolved (see log below); all required “union” files keep every new evidence kind/method/module import.
- Validation gate (2026-05-29): prisma format/validate/generate + API type-check + API tests **green** (see summary below).
- Smoke (2026-05-29): `apps/api/scripts/sprint24h-smoke.ts` prints **PASS** for all 6 steps (see summary below).

## Merge conflict log
- `apps/api/src/integrations/gmail/gmail.module.ts`: union imports (`ReplyClassifierModule` + `SuppressionModule`).
- `apps/api/src/integrations/gmail/gmail.service.ts`: union flow: persist inbound first → enqueue classifier → auto-suppress hook (mailto token OR wait-for-intent); keep artifact lifecycle evidence + hard-bounce suppression.
- `apps/api/src/observability/evidence-event.types.ts`: union all evidence kinds + payload types across WS-2/3/4/5/6/7/8/9 (graph run, transitions, reply HITL, enrichment cache, LLM facts, rollups, evaluators).
- `apps/api/src/observability/evidence-ledger.service.ts`: union all event helpers (outreach suppressed + artifact status transitions + reply flagged + enrichment + rollups + evaluators + llm facts).
- `apps/api/src/runtime/runtime.module.ts` / `apps/api/src/app.module.ts` / `apps/api/src/outreach/outreach.module.ts`: union all module imports/providers/controllers (enrichment + llm + usage + suppression + replies HITL surface).
- `apps/api/src/runtime/tools/registry.ts` / `apps/api/src/runtime/executor.service.ts`: union tool wiring (enrichment-fact instrumentation + ConfigService for unsubscribe headers).
- `apps/api/src/outreach/send-outreach.worker.ts`: keep WS-4 suppression guard before persistence; keep WS-9 APPROVED→QUEUED transition + lifecycle evidence; suppression emits `outreach_suppressed` + `artifact_status_transition` and returns early (no dispatch).
- `apps/api/src/suppression/suppression.module.ts` / `apps/api/src/suppression/suppression.service.ts`: kept WS-4 full module + layered suppression implementation; ensured WS-9 callers remain compatible.

## Validation gate output (summary)
- Env used for pnpm in this sandbox: `XDG_DATA_HOME=/tmp/xdg PNPM_STORE_DIR=/tmp/pnpm-store`
- `pnpm install`: OK
- `pnpm --filter @apex/db exec prisma format`: OK
- `pnpm --filter @apex/db exec prisma validate`: OK
- `pnpm --filter @apex/db db:generate`: OK
- `pnpm --filter @apex/api type-check`: OK
- `pnpm --filter @apex/api test`: OK (vitest)

## Smoke script summary
Command example:
- `DATABASE_URL=... pnpm tsx --tsconfig apps/api/tsconfig.json apps/api/scripts/sprint24h-smoke.ts`
- Optional: `--org-id <orgId>` (recommended for staging); if omitted, the script creates an isolated smoke org for this run.

Results:
- `[PASS] outbound-smoke`
- `[PASS] inbound-smoke`
- `[PASS] suppression-smoke`
- `[PASS] enrichment-smoke`
- `[PASS] rollup-smoke`
- `[PASS] evaluator-smoke`

## Outstanding risks
- None blocked in WS-10 integration work. (All required gates were kept fail-closed; no feature-flag loosening.)
- Sandbox note: `git merge` was not usable in this worktree due to `.git` metadata write restrictions; integration was performed by merging WS-3..WS-9 in an isolated clone and syncing the resulting tree into this worktree.

## Release checklist
- See `docs/SPRINT_24H_RELEASE_CHECKLIST.md`.
