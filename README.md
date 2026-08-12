# Apex AI Workforce Platform

Multi-tenant SaaS for deploying autonomous AI agent teams across Sales, Marketing, and Operations. Customers configure an ICP, connect integrations, and ship outbound — Apex researches accounts, scores leads, drafts outreach, and routes everything through human-approved gates.

**Status:** Phase 2.5 (Production-Safe Tenant-Zero Pipeline) complete on `master` + `phase-2.5-tenant-zero`. Backend running on Azure Container Apps (`apex-gtm-api`, `apex-gtm-worker`). Frontend on Cloudflare Workers (`workforceos.xyz`).

---

## Architecture at a glance

```
                      Clerk auth
                          │
┌─────────────────────────▼────────────────────────────┐
│  Frontend — Next.js 14 (workforceos.xyz)             │
│  Dashboard · Onboarding · Review Queue · Settings    │
└─────────────────────────┬────────────────────────────┘
                          │ REST + Bearer JWT
┌─────────────────────────▼────────────────────────────┐
│  API — NestJS (apex-gtm-api)                         │
│  ┌──────────────┐ ┌────────────────────────────────┐ │
│  │ HTTP modules │ │ LangGraph orchestration        │ │
│  │ agents/auth  │ │ supervisor → research → score  │ │
│  │ orgs/leads   │ │     → human_approval → SDR     │ │
│  │ pipeline     │ │     outreach subgraph          │ │
│  │ outreach     │ │                                │ │
│  │ workflows    │ │ PrismaCheckpointSaver (HITL    │ │
│  │ meetings     │ │ resume via interrupt())        │ │
│  └──────────────┘ └────────────────────────────────┘ │
└──────┬──────────────────┬──────────────────┬─────────┘
       │                  │                  │
       │           ┌──────▼──────┐    ┌──────▼────────┐
       │           │ BullMQ jobs │    │  Side-effect  │
       │           │ worker      │◄───┤  policy guard │
       │           │ (apex-gtm-  │    │  (fail-closed)│
       │           │  worker)    │    └───────────────┘
       │           └──────┬──────┘
       │                  │
┌──────▼──────────┐ ┌─────▼──────┐
│ Postgres        │ │ Redis      │
│ (Azure Flex)    │ │ (BullMQ +  │
│ apex-prod-db    │ │  cache)    │
└─────────────────┘ └────────────┘
```

---

## Tech stack

| Layer            | Technology                                          |
| ---------------- | --------------------------------------------------- |
| Frontend         | Next.js 14, Tailwind, shadcn/ui                     |
| Backend API      | NestJS 11, TypeScript strict                        |
| Orchestration    | LangGraph.js (StateGraph + `interrupt()` HITL)      |
| Database         | PostgreSQL (Azure Flexible Server) + Prisma 6       |
| Queue            | BullMQ + Redis                                      |
| Auth             | Clerk (Bearer JWT, org-scoped)                      |
| LLM              | Azure OpenAI (chat + reasoning models)              |
| Integrations     | Gmail, HubSpot, LinkedIn, Apollo, Serper, Instantly |
| Infrastructure   | Azure Container Apps (API + worker), Azure ACR      |
| Frontend hosting | Cloudflare Workers Build (git push → deploy)        |
| Tests            | Vitest, Playwright                                  |
| Monorepo         | pnpm workspaces + Turborepo                         |

---

## Repository layout

```
apex-product/
├── apps/
│   ├── web/                       Next.js 14 app router frontend
│   └── api/                       NestJS backend (apex-gtm-api)
│       └── src/
│           ├── agents/            Agent CRUD + runtime config
│           ├── auth/              Clerk integration
│           ├── billing/           Razorpay
│           ├── common/            OrgScopeGuard, env validation,
│           │                      rate-limit, decorators
│           ├── graph/             LangGraph supervisor + nodes,
│           │                      PrismaCheckpointSaver, controller
│           ├── health/            Liveness / readiness
│           ├── integrations/      Gmail, HubSpot, LinkedIn,
│           │                      Apollo, Serper, Instantly
│           ├── leads/             ICP scoring, lead persistence
│           ├── meetings/          MeetingLedger (no calendar writes)
│           ├── orgs/              Multi-tenant org provisioning
│           ├── outreach/          OutreachArtifact (PENDING_REVIEW)
│           ├── pipeline/          /pipeline/run entry point
│           ├── prisma/            PrismaService
│           ├── runs/              Agent execution logs
│           ├── runtime/           Tool registry, side-effect policy
│           └── workflows/         WorkflowTemplate + WorkflowRun
├── packages/
│   └── db/                        Prisma schema + generated client
├── docs/
│   ├── PHASE-2.5-IMPLEMENTATION-REPORT.md
│   └── CLIENT-ONBOARDING-CHECKLIST.md
├── workhorse-os/                  Frontend (workforceos.xyz)
├── docker-compose.yml             Local Postgres + Redis
└── turbo.json
```

---

## Phase 2.5 — Production-Safe Tenant-Zero Pipeline

Apex itself is the first dogfood org. The pipeline is wired to run end-to-end (ICP → research → scored leads → human approval → reviewable outreach artifacts) with **zero unauthorized external side effects**. See `docs/PHASE-2.5-IMPLEMENTATION-REPORT.md` for the full stage-by-stage report.

### Safety contract

1. **Workers are independently fail-closed.** `WORKER_ENABLED`,
   `GRAPH_RUN_WORKER_ENABLED`, and `OUTREACH_WORKER_ENABLED` must each equal
   `true` to start their consumer. Legacy cadence scheduling is separately
   disabled unless `SCHEDULER_ENABLED=true` and remains outside the guarded-SDR
   release boundary.
2. **Fail-fast env validation** rejects missing database, Redis, encryption,
   public-URL, Clerk verification/webhook, LLM, Gmail OAuth, CORS, and admin
   configuration before a production process can serve traffic.
3. **`SideEffectPolicy` is fail-closed.** Every tool call resolves to an entry in `TOOL_POLICY_METADATA`. Unknown tools default to `EXTERNAL_WRITE + requiresApproval=true + allowedDryRun=false`. The guard runs at the executor layer, so subagent paths cannot bypass it.
4. **Outreach is dry-run by default.** `send_email` / `hubspot` without an `ApprovalEnvelope` produces a `PENDING_REVIEW` `OutreachArtifact` instead of sending.
5. **SDR outreach is a graph subgraph**, not a tool call. It builds a brief, drafts a message, QA-checks it (placeholder leaks, length bounds), redrafts once on failure, and **always** terminates at `recordDryRun`.
6. **Workflows are template-driven.** Register a `WorkflowTemplate`, run it via `POST /workflows/:slug/runs`. Tenant-zero template: `tenant_zero_sdr_outreach_artifact_v1`.
7. **Meetings never touch external calendars.** Agents create `MeetingLedger` rows with `status=PROPOSED`; humans confirm and mirror to their real calendar by hand.

### Approval flow

```
   pipeline run
       │
       ▼
  supervisor ──► research ──► scoring ──► human_approval ─( interrupt() )
                                                  │
                                            POST /graph/runs/:id/approve
                                                  │
                                                  ▼
                                       SDR outreach subgraph
                                                  │
                                                  ▼
                                    OutreachArtifact (PENDING_REVIEW)
                                                  │
                                   POST /outreach-artifacts/:id/approve
                                                  │
                                                  ▼
                                       (real send — future phase)
```

---

## Quick start (local development)

```bash
# 1. Install
pnpm install

# 2. Boot local Postgres + Redis
docker-compose up -d

# 3. Env
cp .env.example .env
# Edit .env — local dev allows x-org-id header (no Clerk required)

# 4. Schema
pnpm db:generate
pnpm db:push

# 5. Run
pnpm dev          # frontend on :3000, API on :4000
```

### Smoke test the tenant-zero pipeline

```bash
pnpm --filter @apex/api smoke:tenant-zero --org-id <orgId>
```

Runs the full pipeline against real Postgres with mocked LeadsService/RuntimeService/LLMService. Asserts: ≥1 `OutreachArtifact` created, all `PENDING_REVIEW`, no `sentAt`/`sendReceiptId`, zero `runtime.triggerRun` calls.

---

## Commands

```bash
pnpm install          # install workspace deps
pnpm dev              # frontend + API in dev mode
pnpm build            # production build (all apps)
pnpm lint             # eslint across workspace
pnpm type-check       # tsc --noEmit across workspace
pnpm test             # vitest unit suites
pnpm db:generate      # prisma generate
pnpm db:push          # push schema to current DATABASE_URL
```

---

## Production deployment

### Backend (Azure Container Apps)

API and worker run from one immutable image. Their independent worker gates are
set by deployment role; `SCHEDULER_ENABLED` stays false for the guarded-SDR
release:

Run `scripts/deploy-prod.sh --migration-receipt <outside-repo-receipt.json>
--migration-signature <outside-repo-receipt.json.sig> --migration-allowed-signers
<outside-repo-allowed-signers>`
from a clean, published `release/go-live-*` branch on an authenticated
workstation with `gh`, `jq`, `ssh-keygen`, Azure CLI, and Linux/amd64 Docker.
The script requires exact-commit green GitHub CI, validates the approver-signed
production migration receipt against an external trust root whose exact bytes
are SHA-256-pinned in reviewed source, verifies the
API/worker role, release-critical non-secret configuration, secret-reference
wiring, and probe matrix, builds from a fresh `git archive`, binds the digest to
the completed ACR run record, pulls the immutable digest, and runs the image
contract against that exact registry artifact. The release verifier requires
`REQUIRE_PRODUCTION_ENV=true` on both apps and rejects both the live-send
wildcard and its escape flag. Worker and API roll in stages with active-revision
health checks and automatic rollback to their previously captured digest
references. Tags, including `latest`, are never deployment identities.

All sensitive env vars are wired via `secretref`:
`database-url`, `redis-url`, `clerk-secret-key`, `encryption-key` (64 hex chars), `azure-openai-key`, `hubspot-access-token`, `apollo-api-key`, `instantly-api-key`, `serper-api-key`, `admin-api-key`, plus OAuth client secrets.
Container Apps redact each app's backing secret value, so the verifier compares
environment-to-`secretRef` names without claiming that two app-local secrets
with the same name contain the same value. The approved release evidence must
establish that shared API/worker references use the same source or rotation.

### Database schema changes

Production DB is locked down by Azure firewall. The workflow for any `prisma db push` against prod:

1. Open temporary firewall rule for your IP.
2. Dry-run with `prisma migrate diff --from-url $DATABASE_URL --to-schema-datamodel ... --script` and **show the SQL to the human running the change**.
3. Apply `prisma db push` only after explicit approval.
4. **Immediately** delete the firewall rule.

This pattern is documented in the team's DB safety memory and was used for every Phase 2.5 schema change (Stages 4, 6, 7, plus the FK fix on `GraphCheckpointWrite`).

### Frontend (Cloudflare Workers Build)

Push to `main` on the frontend repo triggers a build via the Cloudflare Workers Git integration. No manual `wrangler deploy`, no GitHub Actions.

---

## Key invariants & gotchas

- **TypeScript strict mode, no `any`.** Both apps are strict; CI enforces.
- **Multi-tenant isolation.** Every protected route uses `@OrgId()` resolved from a Clerk JWT (production) or `x-org-id` header (dev). Queries are org-scoped at the service layer; do not trust client-supplied `orgId`.
- **Side-effect policy.** Any new tool added to `runtime/tools/` must have an entry in `TOOL_POLICY_METADATA` — the policy-regression test (`policy-regression.spec.ts`) snapshots the full table and will fail until updated. This forces an explicit policy decision before shipping.
- **Outreach quality bounds** (`graph/nodes/sdr-outreach-subgraph.ts`): `MIN_BODY_LEN=30`, `MAX_BODY_LEN=2000`, `MAX_SUBJECT_LEN=120`, `MAX_DRAFT_ATTEMPTS=2`. Placeholder leaks like `{{`, `[FIRST_NAME]`, `TODO`, `<insert` block the message — pinned by `sdr-qa-regression.spec.ts`.
- **Checkpointer FK note.** `GraphCheckpointWrite` has **no** FK to `GraphCheckpoint`. LangGraph's `PregelLoop` schedules writes for upcoming checkpoints before `put()` persists them; a FK would reject those legitimate writes. Deletion is handled transactionally in `PrismaCheckpointSaver.deleteThread`.

---

## Tests

```bash
pnpm --filter @apex/api test                      # all API specs
pnpm --filter @apex/api test policy-regression    # policy table snapshot
pnpm --filter @apex/api test sdr-qa-regression    # SDR quality boundaries
pnpm --filter @apex/api test pipeline-graph       # end-to-end graph spec
pnpm --filter @apex/api smoke:tenant-zero         # real-DB smoke
```

Test coverage as of Phase 2.5: 96 net-new unit tests across 7 spec files (workflow-templates, workflow-runs, meetings, side-effect-policy, sdr-outreach-subgraph, policy-regression, sdr-qa-regression).

---

## License

Proprietary — see [LICENSE](LICENSE).

## Built by

[Kloudedge Apex](https://kloudedge.xyz). Tenant-zero is Apex itself.
