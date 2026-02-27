# Forge — Sprint 0 Task: Apex Product Foundation

## Context
We are building **Apex AI Workforce Platform** — a multi-tenant SaaS where businesses sign up, configure AI agents (Sales/Marketing/Ops), connect their tools, and deploy autonomous agent teams. Self-serve. $49/mo Starter, $149/mo Growth, custom Enterprise.

Read the full spec: `/home/clawd/clawd/apex-product/PRODUCT-SPEC.md`
Read the sprint plan: `/home/clawd/clawd/apex-product/SPRINT-PLAN.md`

## Your Task: Sprint 0 (Foundation)

Set up the monorepo, database schema, auth shell, base UI, and CI/CD.

### 1. Initialize Monorepo

Create the project at `/home/clawd/clawd/apex-product/`

Structure:
```
apex-product/
├── apps/
│   ├── web/          # Next.js 14 frontend (App Router)
│   └── api/          # NestJS backend
├── packages/
│   └── db/           # Prisma schema + client
├── docker-compose.yml  # Local dev (Postgres + Redis)
├── turbo.json        # Turborepo config
├── package.json      # Root workspace
└── .github/
    └── workflows/
        └── ci.yml    # GitHub Actions CI/CD
```

Use **pnpm workspaces** + **Turborepo** for the monorepo.

### 2. Frontend Shell (apps/web)

- Next.js 14 with App Router
- Tailwind CSS + shadcn/ui components
- Dark theme (Salesforce-inspired: deep navy `#001639`, indigo accent `#6366f1`)
- Layout: sidebar nav + main content area
- Pages (shell only, no logic yet):
  - `/` — Landing page (marketing)
  - `/dashboard` — Main dashboard (protected)
  - `/onboarding` — Multi-step wizard (protected)
  - `/agents` — Agent list (protected)
  - `/agents/[id]` — Agent detail (protected)
  - `/settings` — Org settings + billing (protected)
  - `/login` and `/signup` — Auth pages

### 3. Backend Shell (apps/api)

- NestJS with TypeScript
- Modules: auth, orgs, agents, integrations, billing, runs
- Each module: controller + service + module file (empty implementations OK)
- Health check endpoint: `GET /api/health`
- CORS configured for frontend origin
- Environment config: `.env.example` with all required vars

### 4. Database Schema (packages/db)

Prisma schema with these models:

```prisma
model Org {
  id            String   @id @default(cuid())
  name          String
  slug          String   @unique
  plan          Plan     @default(TRIAL)
  trialEndsAt   DateTime?
  billingId     String?  // Razorpay subscription ID
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  users         User[]
  agents        Agent[]
  integrations  Integration[]
}

enum Plan {
  TRIAL
  STARTER
  GROWTH
  ENTERPRISE
}

model User {
  id        String   @id @default(cuid())
  orgId     String
  org       Org      @relation(fields: [orgId], references: [id])
  email     String   @unique
  name      String?
  role      UserRole @default(MEMBER)
  clerkId   String   @unique
  createdAt DateTime @default(now())
}

enum UserRole {
  OWNER
  ADMIN
  MEMBER
}

model AgentTemplate {
  id                    String   @id @default(cuid())
  domain                Domain
  name                  String
  description           String
  defaultConfig         Json
  requiredIntegrations  String[] // e.g. ["email", "crm"]
  agents                Agent[]
}

enum Domain {
  SALES
  MARKETING
  OPS
}

model Agent {
  id          String        @id @default(cuid())
  orgId       String
  org         Org           @relation(fields: [orgId], references: [id])
  templateId  String
  template    AgentTemplate @relation(fields: [templateId], references: [id])
  name        String
  domain      Domain
  config      Json
  schedule    String?       // Cron expression
  status      AgentStatus   @default(PAUSED)
  createdAt   DateTime      @default(now())
  updatedAt   DateTime      @updatedAt
  runs        AgentRun[]
}

enum AgentStatus {
  ACTIVE
  PAUSED
  ERROR
  DEPLOYING
}

model Integration {
  id          String            @id @default(cuid())
  orgId       String
  org         Org               @relation(fields: [orgId], references: [id])
  provider    String            // gmail, outlook, hubspot, linkedin, etc
  credentials Json              // Encrypted
  status      IntegrationStatus @default(PENDING)
  createdAt   DateTime          @default(now())
}

enum IntegrationStatus {
  PENDING
  CONNECTED
  ERROR
  REVOKED
}

model AgentRun {
  id          String    @id @default(cuid())
  agentId     String
  agent       Agent     @relation(fields: [agentId], references: [id])
  orgId       String
  startedAt   DateTime  @default(now())
  completedAt DateTime?
  status      RunStatus @default(RUNNING)
  result      Json?
  tokensUsed  Int       @default(0)
  cost        Float     @default(0)
  logs        AgentLog[]
}

enum RunStatus {
  QUEUED
  RUNNING
  COMPLETED
  FAILED
  CANCELLED
}

model AgentLog {
  id        String   @id @default(cuid())
  runId     String
  run       AgentRun @relation(fields: [runId], references: [id])
  level     LogLevel
  message   String
  metadata  Json?
  createdAt DateTime @default(now())
}

enum LogLevel {
  DEBUG
  INFO
  WARN
  ERROR
}
```

Run `prisma generate` and `prisma db push` to set up the dev database.

### 5. Docker Compose (Local Dev)

```yaml
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_DB: apex
      POSTGRES_USER: apex
      POSTGRES_PASSWORD: apex_dev_password
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
  
  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"

volumes:
  pgdata:
```

### 6. CI/CD (.github/workflows/ci.yml)

Basic pipeline:
- On push to `main`: lint, type-check, build
- On PR: lint, type-check, build
- Deploy step (placeholder for Azure Container Apps)

## Tech Constraints
- Node.js 20+ (use the version on this machine)
- pnpm (install if needed)
- TypeScript strict mode everywhere
- ESLint + Prettier
- All env vars in `.env.example` (never commit real secrets)

## Definition of Done
- [ ] `pnpm install` works from root
- [ ] `pnpm dev` starts both frontend (port 3000) and backend (port 4000)
- [ ] Frontend shows the shell UI with sidebar + pages
- [ ] Backend health check returns 200
- [ ] Prisma schema compiles and generates client
- [ ] Docker compose starts Postgres + Redis
- [ ] All TypeScript compiles without errors

## DO NOT
- Do not implement actual business logic yet (Sprint 1+)
- Do not set up real Clerk/Razorpay integrations yet (just stubs)
- Do not deploy to production yet
- Do not spend time on pixel-perfect design (functional > pretty for now)

## Output
When done, update this file with completion status and write a summary to:
`/home/clawd/clawd/apex-product/SPRINT0-REPORT.md`
