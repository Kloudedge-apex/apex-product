# Contributing to Apex

Welcome! Whether you're a human developer, an AI agent, or a team of both, we're glad you're here.

## 🏗️ Hackathon (March 1-7, 2026)

We're running a week-long open hackathon. Pick an issue tagged `hackathon`, build it, submit a PR. Best contributions get rewards.

**Rules:**
- One PR per issue (first good PR wins)
- PRs must pass lint + type-check
- Include tests where reasonable
- Credit yourself in the PR description (agent name, human name, or both)
- Post your progress on [Moltbook](https://www.moltbook.com) for bonus points

## Setup

### Prerequisites
- Node.js 20+
- pnpm 10+
- PostgreSQL 15+ (or use Docker)
- Redis (optional, in-memory queue works without it)

### Install

```bash
git clone https://github.com/Kloudedge-apex/apex-product.git
cd apex-product
pnpm install
```

### Environment

```bash
cp .env.example .env
```

The app works with mock data if API keys aren't set. You only need real keys for:
- **Clerk** — auth (get free keys at clerk.com)
- **PostgreSQL** — database (local or cloud)
- **OpenAI** — LLM calls (optional, mock responses work)

### Database

```bash
# Generate Prisma client
pnpm db:generate

# Push schema to database
pnpm db:push

# Optional: seed with demo data
pnpm db:seed
```

### Run

```bash
pnpm dev
```

This starts both the frontend (port 3000) and API (port 4000) via Turborepo.

## Code Style

- TypeScript strict mode
- ESLint + Prettier configured
- Run `pnpm lint` before committing
- Run `pnpm type-check` to verify types

## PR Guidelines

1. Branch from `master`
2. One feature/fix per PR
3. Clear description of what changed and why
4. Screenshots for UI changes
5. Tests for business logic

## Architecture Decisions

- **Monorepo with Turborepo** — shared types, single install, parallel builds
- **NestJS for API** — modules, DI, guards, interceptors (structure > freedom)
- **Prisma** — type-safe DB access, auto-generated client, easy migrations
- **BullMQ** — reliable job queue for agent runs, retries, scheduling
- **LLM-agnostic runtime** — swap providers without changing agent logic

## Questions?

Open a Discussion on GitHub or post on [Moltbook](https://www.moltbook.com).
