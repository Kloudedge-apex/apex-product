# CLAUDE CODE TASK: Wire Apex Product for Demo

## Context
This is a SaaS product: Apex AI Workforce Platform. Monorepo with:
- `apps/web` — Next.js 14 + Tailwind (frontend)
- `apps/api` — NestJS (backend API on port 4000)
- `packages/db` — Prisma schema + Azure Postgres

DB is live: `postgresql://apexadmin:Apex2026!SecureDB@apex-prod-db.postgres.database.azure.com:5432/apex?sslmode=require`

Auth: Clerk (keys in `apps/web/.env.local`)

## What's Built
- All pages exist as static/mock UI
- All API modules exist (orgs, agents, billing, integrations, runs, health)
- 6 agent templates seeded in DB
- Clerk auth wired (middleware, providers, sign-in/sign-up)
- API client exists at `apps/web/src/lib/api.ts`
- Both apps build clean

## YOUR TASK: Wire frontend to backend + make it demoable

### Priority 1: API Wiring (CRITICAL)
1. **Dashboard page** (`apps/web/src/app/(dashboard)/dashboard/page.tsx`): Fetch real stats from API (total agents, active runs, integrations count). Replace all hardcoded numbers.
2. **Agents page** (`apps/web/src/app/(dashboard)/agents/page.tsx`): Fetch agent templates from `GET /api/agents/templates` and list them. Show real data from DB.
3. **Agent detail page** (`apps/web/src/app/(dashboard)/agents/[id]/page.tsx`): Fetch single agent config + run history from API.
4. **Onboarding wizard** (`apps/web/src/app/(dashboard)/onboarding/page.tsx`): Make the 6-step wizard actually POST to API: create org → select templates → configure → deploy.

### Priority 2: API Endpoints (if missing)
Check each endpoint exists and returns real data:
- `GET /api/health` — exists, works
- `GET /api/agents/templates` — exists, returns 6 templates
- `POST /api/orgs` — create org (needs clerkUserId)
- `GET /api/orgs/:id/stats` — dashboard stats
- `POST /api/agents` — create agent from template for an org
- `GET /api/agents?orgId=X` — list agents for org
- `GET /api/agents/:id` — agent detail
- `POST /api/agents/:id/runs` — trigger a run
- `GET /api/agents/:id/runs` — run history

### Priority 3: Make It Feel Alive
- Add loading states and error handling on all pages
- Make the sidebar highlight the current page
- Activity page should show recent agent runs (even if simulated)
- Settings page should show org info from Clerk

### DO NOT:
- Change the DB schema
- Set up Redis/BullMQ (skip agent runtime for now)
- Change Clerk config
- Touch deployment/CI/CD
- Add new dependencies unless absolutely necessary

### Build & Test
```bash
cd /home/clawd/clawd/apex-product
pnpm build  # must pass
# API: cd apps/api && node dist/main.js (port 4000)
# Web: cd apps/web && pnpm dev (port 3000)
```

### Key Files
- API client: `apps/web/src/lib/api.ts`
- Prisma schema: `packages/db/prisma/schema.prisma`
- API main: `apps/api/src/main.ts`
- Web env: `apps/web/.env.local`

Get it to a state where someone can: sign up → see dashboard → browse agent templates → click into an agent → see the onboarding wizard work. That's demoable.
