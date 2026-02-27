# Apex Product — Sprint Plan

## Sprint 0: Foundation (Days 1-3)
**Goal**: Repo setup, DB schema, auth, basic shell

- [ ] Initialize monorepo (Next.js frontend + NestJS backend)
- [ ] PostgreSQL setup on Azure + Prisma schema (orgs, users, agents, templates, runs, integrations, billing)
- [ ] Clerk integration (signup, login, org creation)
- [ ] Base UI shell: layout, sidebar nav, responsive design
- [ ] CI/CD pipeline (GitHub Actions → Azure Container Apps)
- [ ] Dev environment setup (docker-compose for local Postgres + Redis)

**Owner**: Forge (engineering), Kestrel (architecture review)

## Sprint 1: Billing + Onboarding (Days 4-7)
**Goal**: User can sign up, pick a plan, and start onboarding

- [ ] Razorpay integration: subscription creation for Starter ($49) and Growth ($149)
- [ ] Plan management: upgrade/downgrade, billing portal
- [ ] Onboarding wizard UI (multi-step form):
  - Step 1: Organization details
  - Step 2: Select domain (Sales/Marketing/Ops)
  - Step 3: Choose agent template(s)
  - Step 4: Connect integrations
  - Step 5: Configure agent
  - Step 6: Review & deploy
- [ ] Seed agent templates (6 total, 2 per domain)

**Owner**: Forge (frontend + billing), Nikhil (Razorpay config)

## Sprint 2: Integration Hub (Days 8-12)
**Goal**: OAuth connections for core integrations

- [ ] Gmail OAuth (send/receive emails on behalf of user)
- [ ] Outlook/Microsoft Graph OAuth
- [ ] HubSpot OAuth (contacts, deals, companies)
- [ ] Integration management UI (connect/disconnect/status)
- [ ] Credential encryption + secure storage
- [ ] Integration health checks

**Owner**: Forge (OAuth flows), Kestrel (security review)

## Sprint 3: Agent Runtime (Days 13-18)
**Goal**: Agents can actually execute tasks

- [ ] BullMQ + Redis job queue setup
- [ ] Worker process: pick up jobs, execute agent logic, log results
- [ ] LLM router: model selection based on task complexity
- [ ] Token budget enforcement per plan
- [ ] Agent isolation: org-scoped execution context
- [ ] Structured output format (emails, leads, posts, reports)
- [ ] Error handling + retry logic
- [ ] Agent scheduling (cron-based triggers)

**Owner**: Forge (runtime), Kestrel (agent logic + prompt engineering)

## Sprint 4: Dashboard + Logs (Days 19-22)
**Goal**: Users can monitor and manage their agents

- [ ] Dashboard home: agent cards with status, last run, next run
- [ ] Agent detail page: config, run history, logs
- [ ] Run detail: inputs, outputs, tokens used, duration
- [ ] Log viewer with filtering (level, date, agent)
- [ ] Quick actions: pause/resume agent, trigger manual run
- [ ] Notifications: email alerts for errors, daily digest

**Owner**: Forge (UI), Kestrel (data modeling)

## Sprint 5: Agent Templates + Polish (Days 23-28)
**Goal**: All 6 agent templates working end-to-end

### Sales Templates
- [ ] SDR Agent: research → score → draft email → send (with approval)
- [ ] CRM Sync Agent: monitor email/calendar → log to HubSpot

### Marketing Templates
- [ ] Content Writer: generate posts → schedule via Typefully/direct
- [ ] Social Engagement: monitor mentions → draft replies

### Ops Templates
- [ ] Inbox Monitor: classify emails → route → draft replies
- [ ] Reporting Agent: pull data → generate report → deliver

**Owner**: Kestrel (prompt engineering + agent logic), Forge (integration wiring)

## Sprint 6: Landing Page + Launch Prep (Days 29-32)
**Goal**: Ready to accept users

- [ ] Landing page: hero, problem/solution, pricing, demo video, testimonials
- [ ] SEO basics: sitemap, robots.txt, meta tags, JSON-LD
- [ ] Analytics: Plausible or PostHog
- [ ] Error pages (404, 500, rate limit)
- [ ] Terms of Service + Privacy Policy
- [ ] Onboarding email sequence (welcome, getting started, tips)
- [ ] Production deployment + custom domain SSL
- [ ] Load testing
- [ ] Security audit (OWASP top 10)

**Owner**: All hands

## Sprint 7: Beta Launch (Days 33-35)
**Goal**: First users onboarded

- [ ] Invite 10-20 beta users (from existing pipeline contacts)
- [ ] Monitor agent runs, costs, errors
- [ ] Collect feedback
- [ ] Hotfix cycle
- [ ] Public launch announcement (LinkedIn, X, Reddit, Product Hunt prep)

## Timeline Summary

| Sprint | Days | Focus |
|--------|------|-------|
| 0 | 1-3 | Foundation |
| 1 | 4-7 | Billing + Onboarding |
| 2 | 8-12 | Integration Hub |
| 3 | 13-18 | Agent Runtime |
| 4 | 19-22 | Dashboard + Logs |
| 5 | 23-28 | Agent Templates |
| 6 | 29-32 | Landing Page + Launch |
| 7 | 33-35 | Beta Launch |

**Total: ~5 weeks to beta launch**
