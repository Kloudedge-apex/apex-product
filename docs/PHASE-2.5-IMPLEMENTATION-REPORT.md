# Phase 2.5 — Production-Safe Tenant-Zero Pipeline

**Goal:** Apex runs one complete tenant-zero outbound pipeline end to end
(ICP → account research → scored leads → human approval → reviewable
outreach artifacts) with **zero unauthorized external side effects**.

**Branch:** `phase-2.5-tenant-zero`
**Status:** All 10 stages complete (commits `4df7834` → `a04...stage10`).
**Date completed:** 2026-05-22

---

## Stages & commits

| Stage | Commit | Title |
| :---: | :----- | :---- |
| 1 | `4df7834` | Gate `WorkerService` startup on `WORKER_ENABLED` env flag |
| 2 | `43d6c74` | Fail-fast startup env validation |
| 3 | `241940e` | `SideEffectPolicyGuard` at tool-call layer |
| 4a | `30d714a` | `OutreachArtifact` Prisma model + status/channel enums |
| 4b | `b34c38a` | Dry-run outreach path persists `OutreachArtifact`s |
| 5 | `c1fb9f3` | SDR outreach subgraph replaces autonomous `triggerRun` |
| 6a | `a5404c0` | `WorkflowTemplate` + `WorkflowRun` Prisma models |
| 6b | `6428e30` | Workflows NestJS module + controller |
| 6c | `08bc7ac` | Seed `tenant_zero_sdr_outreach_artifact_v1` template |
| 7a | `61ca06a` | `MeetingLedger` Prisma model |
| 7b | `141c367` | Meetings NestJS module + CRUD endpoints |
| 8 | `3fb1ad7` | End-to-end dry-run smoke harness |
| 9 | `666dc3f` | Policy + quality regression tests |

---

## Safety contract (what Phase 2.5 actually guarantees)

The pipeline can be invoked from API routes today and is guaranteed to
**not** produce any external side effect without explicit human approval:

1. **Worker process is gated** by `WORKER_ENABLED=true`. Anywhere this
   var is unset, BullMQ workers never start — even if a job is enqueued
   it just sits.
2. **Production env validation fails fast** at boot when required keys
   (`DATABASE_URL`, `REDIS_URL`, `CLERK_SECRET_KEY`,
   `WORKER_ENABLED`, `OPENAI_API_KEY` or Azure equivalents,
   `ENCRYPTION_KEY`) are missing or shaped wrong.
3. **`SideEffectPolicy` is fail-closed.** Every tool call must resolve
   to an entry in `TOOL_POLICY_METADATA`; unknown tools default to
   `EXTERNAL_WRITE + requiresApproval=true + allowedDryRun=false`. The
   guard runs at the executor layer, so subagent code paths cannot
   bypass it.
4. **Outreach is dry-run by default.** When `send_email` / `hubspot`
   is called without an approval envelope, the executor produces an
   `OutreachArtifact` in `PENDING_REVIEW` status. The artifact carries
   the verbatim tool args (`payload` Json) and the extracted
   subject/body/recipient for the reviewer UI.
5. **SDR outreach is a graph subgraph** (`buildSdrOutreachSubgraph`)
   not a tool call. It builds a research brief, drafts a message,
   QA-checks it (placeholder leaks, length bounds), redrafts once on
   failure, and **always** ends at `recordDryRun` — never at a real
   send. `MAX_DRAFT_ATTEMPTS=2`.
6. **Workflows are template-driven.** `WorkflowTemplate` declares
   inputs (typed), defaults, and a graph name. `WorkflowRun` rows
   project graph status onto a per-org auditable ledger.
   `tenant_zero_sdr_outreach_artifact_v1` is seeded in prod.
7. **Meetings never touch external calendars.** Agents that want to
   "schedule" a meeting create a `MeetingLedger` row with
   `status=PROPOSED`, `source=AGENT_PROPOSED`. A human reviews and
   CONFIRMs; their real calendar mirrors the booking by hand. The
   state machine (PROPOSED → {CONFIRMED, CANCELLED}; CONFIRMED →
   {COMPLETED, CANCELLED}) is enforced at the service layer and cross-
   org FKs (`outreachArtifactId`, `personId`) are rejected.

---

## Test coverage

**New tests in this phase:** 96 unit tests across 7 spec files
(workflow-templates, workflow-runs, meetings, side-effect-policy,
sdr-outreach-subgraph, plus Stage 9's policy-regression and
sdr-qa-regression).

**Pre-existing failures (NOT caused by Phase 2.5):**
- `runtime/__tests__/executor.service.spec.ts` — `memoryService.searchSemantic is not a function` (mock incompleteness; not exercised by Phase 2.5 graph paths).
- `runtime/__tests__/runtime-integration.spec.ts` — `prisma.$transaction is not a function` (mock incompleteness).
- `integrations/gmail/__tests__/gmail.service.spec.ts` &
  `integrations/hubspot/__tests__/hubspot.service.spec.ts` —
  `ENCRYPTION_KEY` env var unset in CI. Phase 2.5 verifies env at
  app boot, not at vitest boot; the test harness needs to inject a
  dummy value (follow-up).

These were all confirmed pre-existing on baseline `3fb1ad7` by
stashing Stage 9 work and re-running.

**Stage 9 regression tests of note:**
- `runtime/__tests__/policy-regression.spec.ts` pins the full
  `TOOL_POLICY_METADATA` snapshot. Adding a new tool now requires
  updating this test, which forces an explicit policy decision.
- `graph/__tests__/sdr-qa-regression.spec.ts` locks every
  `PLACEHOLDER_LEAKS` pattern individually and the exact length
  boundaries (`MIN_BODY_LEN=30`, `MAX_BODY_LEN=2000`,
  `MAX_SUBJECT_LEN=120`), so a future qaCheck rewrite cannot
  silently relax a rule.

---

## Smoke harness

`pnpm --filter @apex/api smoke:tenant-zero --org-id <orgId>` runs the
full pipeline against real Postgres with mocked LeadsService,
RuntimeService, and LLMService. It asserts:

- At least one `OutreachArtifact` is created.
- All artifacts are `PENDING_REVIEW`.
- No artifact has `sentAt` or `sendReceiptId` set.
- `runtime.triggerRun` was called zero times.
- A `MeetingLedger` row with `source=AGENT_PROPOSED` can be created
  attached to the first artifact.

Use `--keep` to skip cleanup if you want to poke at the artifacts in
psql afterward.

---

## Schema migrations applied to prod

All schema changes were applied via the temp-firewall pattern from
[[feedback-db-safety]]: open Azure firewall to local IP, `prisma db
push` after dry-run diff inspection, immediately delete the rule.

- **Stage 4** (`2026-05-22`): `OutreachArtifact` table,
  `OutreachArtifactStatus` enum, `OutreachChannel` enum.
- **Stage 6** (`2026-05-22`): `WorkflowTemplate`, `WorkflowRun`,
  `WorkflowRunStatus` enum. Seeded
  `tenant_zero_sdr_outreach_artifact_v1` (id
  `cmpg2ug3b0000v3b89vkc9wv2`).
- **Stage 7** (`2026-05-22`): `MeetingLedger`, `MeetingStatus`,
  `MeetingSource` enums. `outreachArtifactId` / `personId` are
  nullable + non-FK'd at the DB level (validated at the service
  layer) so agents can propose meetings for not-yet-persisted leads.

---

## Known follow-ups (out of Phase 2.5 scope)

- **PrismaCheckpointSaver FK warning** during smoke run:
  `GraphCheckpointWrite_threadId_checkpointNamespace_checkpoi_fkey`
  violated, non-fatal. The run still completes and the assertions
  still pass. Investigate as part of checkpointer hardening.
- **Pre-existing 10 executor/runtime-integration test failures**
  (memoryService / $transaction mock incompleteness). Unrelated
  to Phase 2.5 but should be cleaned up before they mask real
  regressions.
- **gmail/hubspot tests needing ENCRYPTION_KEY** — inject a dummy
  key in `vitest.config.ts` setupFiles so they pass in CI without
  changing prod behavior.
- **Secret rotation** (task #8) — still pending from the operational
  debt list.
- **Stage 9 didn't add a `pipeline-policy-contract` integration
  spec** because the existing `pipeline-graph.spec.ts` already
  asserts (a) no `runtime.trigger` calls during outreach and (b)
  artifacts are produced. If the supervisor is refactored such
  that those assertions stop covering all approval paths, add the
  integration spec then.

---

## What you can do next

The infrastructure is now in place to:

1. **Wire a frontend "review queue"** that lists
   `OutreachArtifact` rows in `PENDING_REVIEW` and calls
   `POST /outreach-artifacts/:id/{approve,reject}`.
2. **Move from dry-run to real send** by building an `ApprovalEnvelope`
   issuer endpoint. The `SideEffectPolicy.check()` already accepts
   envelopes — only the API surface to mint and store them is
   missing.
3. **Add workflow templates beyond SDR** (e.g. CSM check-in,
   marketing-segment refresh) by registering new templates via the
   workflow seeder.
4. **Schedule workflow runs** via the existing `Scheduler` service
   (gated by `WORKER_ENABLED`).
