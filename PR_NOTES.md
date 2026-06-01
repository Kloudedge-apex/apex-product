# P0 #19 — E2E launch-flow spec

This PR adds `tests/e2e/launch-flow.spec.ts`, a Playwright API spec that
exercises the full canonical happy-path:

```
seed Org (Prisma)
  → POST /api/leads/icp
  → POST /api/agents          (SDR, exclusions in two shapes)
  → POST /api/pipeline/run
  → poll  GET  /api/graph/runs/:id        until AWAITING_APPROVAL  (≤90s)
  → POST /api/graph/runs/:id/approve
  → poll GET  /api/graph/runs/:id/outreach-artifacts until ≥1 row (≤60s)
```

Two test cases run the same flow, parameterised on the recent
`exclusions: string | string[]` type-union fix:

1. `exclusions` as `string[]` — `["blocked1.com","blocked2.com"]`
2. `exclusions` as newline-delimited `string` — `"blocked1.com\nblocked2.com"`

Each scenario gets its own seeded Org so the spec is safe under
`playwright.config.ts > fullyParallel: true` (the pipeline service is
single-flight per org and rejects with `ConflictException` if a run is
already `RUNNING`/`AWAITING_APPROVAL`).

## Files

- `tests/e2e/launch-flow.spec.ts` — the spec.
- `tests/e2e/fixtures/clerk-dev-fixture.ts` — `getDevApiContext({orgId})`
  helper that returns a Playwright `APIRequestContext` pre-loaded with the
  `x-org-id` header.

## Divergence from the brief

- **Org creation is NOT done via `POST /api/orgs`.** That controller is
  decorated `@SkipOrgGuard()` and always requires a verified Clerk Bearer
  token via inline `verifyAuth(req)`. The `ALLOW_DEV_ORG_HEADER` fallback in
  `OrgScopeGuard` does not apply there. With `@clerk/testing` not installed
  on this branch the spec seeds the `Org` row directly via the `@apex/db`
  PrismaClient export. Every subsequent protected route uses the
  `x-org-id` header.
- The same `beforeAll` step pre-creates the SDR `AgentTemplate` row so the
  spec doesn't rely on the lazy template seed that lives behind
  `GET /api/agents/templates`.

## Runtime requirements

The spec talks only to the API; the Next.js frontend is not driven (the
canonical launch FE is `workhorse-os` and login is Clerk-only — no test
harness on this branch).

Required environment for the **API process** under test:

| Variable                  | Value                                                             |
| ------------------------- | ----------------------------------------------------------------- |
| `NODE_ENV`                | anything ≠ `production`                                           |
| `ALLOW_DEV_ORG_HEADER`    | `true`                                                            |
| `CLERK_DOMAIN`            | **unset** (otherwise the JWT path engages and rejects the header) |
| `CLERK_JWKS_URL`          | **unset** (same reason)                                           |
| `DATABASE_URL`            | postgres reachable by spec, api, and worker                       |
| `REDIS_URL`               | redis reachable by api + worker (BullMQ graph queue)              |
| `LANGGRAPH_DRY_RUN`/etc.  | dry-run defaults are fine — outreach lands in `PENDING_REVIEW`    |

Required for the **spec process**:

| Variable             | Default                  | Notes                              |
| -------------------- | ------------------------ | ---------------------------------- |
| `E2E_API_BASE_URL`   | `http://localhost:4000`  | NestJS port from `apps/api/src/main.ts` |
| `E2E_BASE_URL`       | `http://localhost:3000`  | Playwright `use.baseURL`; unused by this spec but referenced in config |
| `DATABASE_URL`       | (same as API)            | spec seeds + tears down Org rows   |

## docker-compose

There is no `docker-compose.yml` at the workspace root on this branch (the
prod stack is Azure Container Apps; local dev expects engineers to run their
own Postgres + Redis). Two options for local E2E:

```bash
# minimal local stack (run in a separate terminal):
docker run --rm -p 5432:5432 -e POSTGRES_PASSWORD=apex -e POSTGRES_DB=apex \
  --name apex-e2e-pg postgres:16
docker run --rm -p 6379:6379 --name apex-e2e-redis redis:7

# then in the repo:
export DATABASE_URL=postgresql://postgres:apex@localhost:5432/apex
export REDIS_URL=redis://localhost:6379
pnpm db:push
```

Then start the api + worker (`pnpm dev` covers both via Turbo) with the env
variables above, and finally run:

## Manual run command

```bash
pnpm exec playwright test tests/e2e/launch-flow.spec.ts
```

Or, using the existing root script:

```bash
pnpm test:e2e -- tests/e2e/launch-flow.spec.ts
```

The default `playwright.config.ts > webServer` block launches `pnpm dev` for
you, but only when `CI` is unset. In CI both the api and the worker need to
be started separately (Bitbucket Pipelines presently does NOT run
Playwright — see TODO below).

## CI integration TODO (NOT part of this commit)

`bitbucket-pipelines.yml` currently runs vitest only. Wiring this spec into
CI requires:

1. A docker-compose service block for postgres + redis (the agent images on
   Bitbucket Cloud don't ship either).
2. A step that runs `pnpm db:push`, boots the api + worker as background
   processes (with the env above), and waits for `:4000/api/health`.
3. `pnpm exec playwright install --with-deps chromium` followed by
   `pnpm test:e2e`.

That work is tracked separately; this PR ships the spec only.
