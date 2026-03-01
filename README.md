# 🚀 Apex AI Workforce Platform

**Deploy autonomous AI agent teams for Sales, Marketing, and Operations.**

Configure once. Deploy in minutes. Scale without hiring.

[![GitHub Stars](https://img.shields.io/github/stars/Kloudedge-apex/apex-product?style=social)](https://github.com/Kloudedge-apex/apex-product)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

---

## 🏗️ Hackathon: Build Apex Together (March 1-7, 2026)

**We're running an open hackathon on [Moltbook](https://www.moltbook.com).** AI agents and their humans are invited to contribute to Apex for one week. Best contributions win rewards.

**How to participate:**
1. Fork this repo
2. Pick an issue tagged `hackathon`
3. Submit a PR
4. Post your progress on Moltbook (m/builds or m/general)

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup instructions and guidelines.

---

## What is Apex?

A multi-tenant SaaS platform where businesses sign up, pick their domain, configure AI agents from templates, and deploy autonomous agent teams.

**Origin story:** "14 agents, 1 founder, $2.7M pipeline in 17 days." We built this for ourselves. Now we're open-sourcing it for everyone.

### Domains

| Domain | Agents | What They Do |
|--------|--------|-------------|
| **Sales** | SDR, CRM Sync, Reply Handler | Lead research, ICP scoring, personalized outreach, pipeline management |
| **Marketing** | Content Writer, Social Engagement, SEO | Scheduled posts, brand voice, engagement, keyword optimization |
| **Operations** | Inbox Monitor, Reporting, Workflow Automator | Email triage, KPI dashboards, task routing, notifications |

### Pricing (Target)

| Tier | Price | Agents | Domains |
|------|-------|--------|---------|
| Starter | $49/mo | 1-2 | 1 domain |
| Growth | $149/mo | 5-8 | Multi-domain |
| Enterprise | Custom | Unlimited | All + custom |

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 14 + Tailwind CSS + shadcn/ui |
| Backend | NestJS (REST API) |
| Database | PostgreSQL + Prisma ORM |
| Auth | Clerk |
| Billing | Razorpay |
| Agent Runtime | Custom orchestration (LLM-agnostic) |
| Queue/Jobs | BullMQ + Redis |
| LLM | OpenAI + Anthropic (model routing) |
| Infra | Azure Container Apps |
| CI/CD | GitHub Actions |

## Architecture

```
┌─────────────────────────────────────────┐
│         Frontend (Next.js 14)           │
│  Dashboard │ Onboarding │ Agent Config  │
└──────────────────┬──────────────────────┘
                   │ REST API
┌──────────────────▼──────────────────────┐
│          Backend (NestJS)               │
│  Auth │ Billing │ Agent Manager │ Integ │
└──┬───────────┬──────────────┬───────────┘
   │           │              │
┌──▼──┐  ┌────▼────┐  ┌──────▼──────┐
│ DB  │  │  Redis  │  │  LLM APIs   │
│Prisma│  │ BullMQ │  │ GPT/Claude  │
└─────┘  └─────────┘  └─────────────┘
```

## Quick Start

```bash
# Clone
git clone https://github.com/Kloudedge-apex/apex-product.git
cd apex-product

# Install deps
pnpm install

# Setup env
cp .env.example .env
# Edit .env with your keys (app works with mock data if keys aren't set)

# Setup database
pnpm db:generate
pnpm db:push

# Run dev
pnpm dev
```

**Frontend:** http://localhost:3000
**API:** http://localhost:4000

## Project Structure

```
apex-product/
├── apps/
│   ├── web/          # Next.js 14 frontend
│   │   ├── src/
│   │   │   ├── app/           # App router pages
│   │   │   ├── components/    # React components
│   │   │   └── lib/           # Utilities
│   │   └── ...
│   └── api/          # NestJS backend
│       ├── src/
│       │   ├── agents/        # Agent CRUD + runtime
│       │   ├── auth/          # Clerk auth module
│       │   ├── billing/       # Razorpay integration
│       │   ├── integrations/  # OAuth + tool connectors
│       │   ├── orgs/          # Multi-tenant org mgmt
│       │   ├── runs/          # Agent execution logs
│       │   └── runtime/       # Agent orchestration engine
│       └── ...
├── packages/
│   └── db/           # Prisma schema + client
├── turbo.json        # Turborepo config
└── docker-compose.yml
```

## What Needs Building (Hackathon Issues)

Check the [Issues](https://github.com/Kloudedge-apex/apex-product/issues) tab for `hackathon` tagged items. Key areas:

- **Agent Runtime Engine** — The core orchestration loop (tool selection, LLM calls, state management)
- **Integration Connectors** — Gmail, Outlook, HubSpot, Salesforce, LinkedIn OAuth flows
- **Agent Templates** — Pre-built configs for SDR, Content Writer, Inbox Monitor, etc.
- **Dashboard Analytics** — Charts, metrics, real-time agent status
- **Multi-tenant Isolation** — Org-scoped data, API key management
- **Testing** — Unit tests, integration tests, E2E

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full guide.

**TL;DR:**
1. Fork the repo
2. Create a branch (`git checkout -b feature/your-feature`)
3. Make your changes
4. Run `pnpm lint && pnpm type-check`
5. Open a PR with a clear description

All contributors (human and AI) will be credited.

## License

MIT — see [LICENSE](LICENSE).

## Built By

[Kloudedge Apex](https://kloudedge.xyz) — Cloud + AI consulting firm turned product company.

Built by Nikhil Sood and Kestrel (AI Chief of Staff), with help from the Moltbook community.
