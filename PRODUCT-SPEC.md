# Apex AI Workforce Platform — Product Specification

**Version**: 0.1.0
**Created**: 2026-02-27
**Status**: PRE-BUILD
**Domain**: apex.kloudedge.xyz

## Vision

A multi-tenant SaaS platform where businesses sign up, pick their domain (Sales, Marketing, or Operations), configure AI agents from templates, connect their tools, and deploy autonomous agent teams. Self-serve. No consulting required.

## Origin Story

"14 agents, 1 founder, $2.7M pipeline in 17 days" — we built this for ourselves. Now we're productizing it for everyone.

## Pricing

| Tier | Price | Agents | Domains | Features |
|------|-------|--------|---------|----------|
| Starter | $49/mo | 1-2 | 1 (Sales OR Marketing OR Ops) | Pre-built templates, basic integrations, community support |
| Growth | $149/mo | 5-8 | Multi-domain (Sales + Marketing + Ops) | Custom workflows, advanced integrations, priority support, analytics |
| Enterprise | Custom | Unlimited | All + custom | Full customization, dedicated infra, white-glove onboarding, SLAs, SSO |

## Core Domains

### 1. Sales
| Agent | Function | Key Integrations |
|-------|----------|-----------------|
| SDR Agent | Lead research, ICP scoring, personalized outreach, automated follow-up | LinkedIn, Email (Gmail/Outlook), HubSpot, Salesforce |
| CRM Sync Agent | Auto-log interactions, update pipeline stages, deal tracking | HubSpot, Salesforce, Pipedrive |
| Reply Handler | Detect replies, classify intent (interested/not now/unsubscribe), draft responses | Email, CRM |

### 2. Marketing
| Agent | Function | Key Integrations |
|-------|----------|-----------------|
| Content Writer | Generate posts for LinkedIn, X, blog on schedule with brand voice | Typefully, WordPress, Ghost, Buffer |
| Social Engagement | Monitor mentions, reply to comments, engage with prospects | LinkedIn, X, Reddit |
| SEO Agent | Keyword research, content briefs, meta optimization | Google Search Console, Ahrefs/SEMrush API |

### 3. Operations
| Agent | Function | Key Integrations |
|-------|----------|-----------------|
| Inbox Monitor | Email triage, categorization, auto-routing, draft replies | Gmail, Outlook |
| Reporting Agent | Daily/weekly KPI dashboards, anomaly detection, trend analysis | Google Analytics, CRM, internal data |
| Workflow Automator | Task routing, approval chains, status updates, notifications | Slack, Teams, Notion, Jira |

## Tech Stack

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| Frontend | Next.js 14 + Tailwind CSS | Known stack, fast iteration, SSR for SEO |
| Backend | NestJS (API) + Next.js (BFF) | Structured backend, dependency injection, scalable |
| Database | PostgreSQL + Prisma ORM | Relational for multi-tenancy, Prisma for type safety |
| Auth | Clerk | Managed auth, org support, SSO for enterprise |
| Billing | Razorpay | Already integrated, supports INR + USD |
| Agent Runtime | Custom orchestration layer | LLM-agnostic, queue-based, isolated per tenant |
| Queue/Jobs | BullMQ + Redis | Reliable job processing for agent tasks |
| LLM Providers | OpenAI (GPT-4o-mini for routine, GPT-4o for complex) + Claude | Cost optimization via model routing |
| Infra | Azure Container Apps | Already on this, auto-scaling, managed |
| Monitoring | Azure Monitor + custom dashboard | Uptime, agent health, cost tracking |
| CI/CD | GitHub Actions | Already configured |

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    FRONTEND (Next.js 14)                  │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────────┐ │
│  │ Dashboard │ │ Onboard  │ │ Agent    │ │ Analytics  │ │
│  │          │ │ Wizard   │ │ Config   │ │            │ │
│  └──────────┘ └──────────┘ └──────────┘ └────────────┘ │
└─────────────────────┬───────────────────────────────────┘
                      │ REST/tRPC
┌─────────────────────▼───────────────────────────────────┐
│                    BACKEND (NestJS)                       │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────────┐ │
│  │ Auth     │ │ Billing  │ │ Agent    │ │ Integration│ │
│  │ Module   │ │ Module   │ │ Manager  │ │ Hub        │ │
│  └──────────┘ └──────────┘ └──────────┘ └────────────┘ │
└──────┬──────────────┬──────────────┬────────────────────┘
       │              │              │
┌──────▼──────┐ ┌─────▼─────┐ ┌─────▼──────────────────┐
│  PostgreSQL │ │   Redis   │ │   Agent Runtime Engine  │
│  (Prisma)   │ │  (BullMQ) │ │  ┌─────┐ ┌─────┐      │
│             │ │           │ │  │Agent│ │Agent│ ...   │
│  - Users    │ │  - Jobs   │ │  │ T-1 │ │ T-2 │      │
│  - Orgs     │ │  - Cache  │ │  └─────┘ └─────┘      │
│  - Agents   │ │  - PubSub │ │  (Isolated per tenant) │
│  - Runs     │ │           │ │                        │
│  - Logs     │ │           │ │  LLM Router:           │
│  - Billing  │ │           │ │  GPT-4o-mini (routine) │
│             │ │           │ │  GPT-4o (complex)      │
│             │ │           │ │  Claude (reasoning)    │
└─────────────┘ └───────────┘ └────────────────────────┘
```

## Multi-Tenancy Model

- **Org-based isolation**: Each customer is an "org" with their own agents, integrations, and data
- **Row-level security**: All queries scoped by org_id
- **Shared infrastructure**: Single DB, shared compute, isolated agent execution contexts
- **Data encryption**: At rest (AES-256) and in transit (TLS 1.3)

## Database Schema (Core Tables)

```
orgs
  id, name, slug, plan (starter|growth|enterprise), billing_id, created_at

users
  id, org_id, email, name, role (owner|admin|member), clerk_id

agents
  id, org_id, name, template_id, domain (sales|marketing|ops), config (jsonb), status (active|paused|error), created_at

agent_templates
  id, domain, name, description, default_config (jsonb), required_integrations

integrations
  id, org_id, provider (gmail|outlook|hubspot|linkedin|etc), credentials (encrypted jsonb), status

agent_runs
  id, agent_id, org_id, started_at, completed_at, status, result (jsonb), tokens_used, cost

agent_logs
  id, agent_run_id, level, message, metadata (jsonb), created_at

billing
  id, org_id, razorpay_subscription_id, plan, status, current_period_start, current_period_end
```

## Onboarding Flow

```
1. Sign Up (email/Google)
   ↓
2. Create Organization (company name, size, industry)
   ↓
3. Select Domain (Sales / Marketing / Ops)
   ↓
4. Choose Agent Template(s)
   ↓
5. Connect Integrations (OAuth flows for Gmail, HubSpot, etc.)
   ↓
6. Configure Agent (ICP criteria, brand voice, schedule, etc.)
   ↓
7. Review & Deploy
   ↓
8. Dashboard (monitor agents, view results, iterate)
```

## Agent Runtime Design

### Execution Model
- Each agent run is a **job** in BullMQ
- Jobs are picked up by **worker processes** in Azure Container Apps
- Each job runs in an **isolated context** (org-scoped credentials, data, config)
- Jobs produce **structured outputs** (emails drafted, leads scored, posts written)
- All outputs require **human approval** by default (optional auto-approve for Growth+)

### Cost Control
- **Token budget per agent per run**: Starter (10K tokens), Growth (50K tokens)
- **Model routing**: Use GPT-4o-mini for 80% of tasks, escalate to GPT-4o/Claude for complex reasoning
- **Rate limiting**: Max runs per day per plan (Starter: 10, Growth: 50)
- **Caching**: Cache LLM responses for identical inputs within 24h window

### Agent Template Format
```json
{
  "id": "sdr-agent-v1",
  "domain": "sales",
  "name": "SDR Agent",
  "description": "Researches leads, scores against your ICP, writes personalized outreach",
  "required_integrations": ["email", "crm"],
  "optional_integrations": ["linkedin"],
  "config_schema": {
    "icp_criteria": { "type": "object", "description": "Your ideal customer profile" },
    "email_tone": { "type": "string", "enum": ["professional", "casual", "direct"] },
    "follow_up_cadence": { "type": "array", "description": "Days between follow-ups" },
    "daily_limit": { "type": "number", "description": "Max emails per day" }
  },
  "schedule": { "type": "cron", "default": "0 9 * * 1-5" },
  "system_prompt_template": "..."
}
```

## MVP Scope (Ship Everything)

### Must Have (P0)
- [ ] Landing page with pricing, demo video placeholder, signup CTA
- [ ] Auth (Clerk): signup, login, org creation
- [ ] Billing (Razorpay): subscription creation, plan management, usage tracking
- [ ] Dashboard: agent list, status, recent runs, logs
- [ ] Onboarding wizard: domain → template → integrations → config → deploy
- [ ] Agent templates: 2 per domain (6 total)
- [ ] Integration OAuth: Gmail, Outlook, HubSpot
- [ ] Agent runtime: job queue, execution, logging
- [ ] Agent config UI: form-based configuration per template
- [ ] Run history + log viewer

### Should Have (P1)
- [ ] LinkedIn OAuth integration
- [ ] Salesforce CRM integration
- [ ] Slack notifications
- [ ] Analytics dashboard (runs, tokens, costs per agent)
- [ ] Agent scheduling UI (cron builder)
- [ ] Email notifications (agent completed, error, daily digest)

### Nice to Have (P2)
- [ ] Custom agent builder (beyond templates)
- [ ] Team management (invite members, roles)
- [ ] API access for Enterprise
- [ ] Webhook support
- [ ] White-label options

## Success Metrics

| Metric | Target (90 days) |
|--------|-----------------|
| Signups | 500+ |
| Paid users | 50+ |
| MRR | $5K+ |
| Churn | <10% monthly |
| Agent runs (daily) | 1,000+ |
| NPS | 40+ |

## Team

| Who | Role |
|-----|------|
| Nikhil | Product decisions, integrations, sales, user feedback |
| Kestrel | Architecture, coordination, spec, testing, deployment |
| Forge | Primary engineering (frontend + backend + runtime) |

## Decisions (Resolved)

1. **Domain**: apex.kloudedge.xyz (for now, custom domain later)
2. **Free trial**: 3 days, no credit card required
3. **Agent approval flow**: Auto-approve by default. Human approval only for high-risk actions (sending emails to external contacts, publishing public content, financial transactions). Users can opt into approval for any action.
4. **Multi-region**: Single region (Azure East US) for MVP. Plan for multi later.
5. **Billing**: Existing Razorpay account
6. **Auth**: Clerk (Kestrel to set up)

## References

- Existing Apex site: apex.kloudedge.xyz
- Nueton MVP (similar stack): agency/mvp/
- Gojiberry playbook (inspiration): agency/content/linkedin/2026-02-27-ai-sdr-replacing-human-sdr.md
- Competitors: 11x.ai, Relevance AI, Artisan AI
