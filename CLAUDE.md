# CLAUDE.md — Apex AI Workforce Platform

## Project
Multi-tenant SaaS for deploying autonomous AI agent teams.
Domains: Sales, Marketing, Operations.

## Stack
- Frontend: Next.js 14 + Tailwind + shadcn/ui (`apps/web/`)
- Backend: NestJS REST API (`apps/api/`)
- Database: PostgreSQL + Prisma ORM (`packages/db/`)
- Auth: Clerk
- Billing: Razorpay
- Queue: BullMQ + Redis
- Monorepo: pnpm + Turborepo

## Commands
```bash
pnpm install          # install deps
pnpm dev              # run frontend + API
pnpm build            # production build
pnpm lint             # eslint
pnpm type-check       # typescript strict
pnpm db:generate      # prisma generate
pnpm db:push          # push schema to db
```

## Architecture
- `apps/web/` — Next.js 14 app router, pages in `src/app/`
- `apps/api/` — NestJS, modules in `src/` (agents, auth, billing, integrations, orgs, runs, runtime)
- `packages/db/` — Prisma schema + client

## Key Priorities (Hackathon Week)
1. Agent Runtime Engine — core orchestration loop (tool selection, LLM calls, state)
2. Integration connectors — Gmail, HubSpot, LinkedIn OAuth flows
3. Agent templates — pre-built configs for SDR, Content Writer, etc.
4. Dashboard analytics — charts, metrics, real-time status
5. Multi-tenant isolation — org-scoped queries
6. E2E tests — Playwright

## Superpowers
This project uses the Superpowers workflow. Skills are in `.superpowers/skills/`.
Follow the brainstorming → writing-plans → subagent-driven-development flow.

## Rules
- TypeScript strict mode
- No `any` types
- All new features need tests
- Follow existing patterns in each module
- Keep PRs focused (one feature per PR)
