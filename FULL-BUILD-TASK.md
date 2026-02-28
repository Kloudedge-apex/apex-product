# FULL BUILD TASK: Apex AI Workforce Platform (Sprints 2-7)

## Context
You're building a multi-tenant SaaS platform where businesses sign up, pick AI agent templates, connect integrations, and deploy autonomous AI agents. Think of it as "Zapier meets AI agents."

**What's already built (Sprint 0+1):**
- Monorepo: `apps/web` (Next.js 14 + Tailwind), `apps/api` (NestJS), `packages/db` (Prisma)
- PostgreSQL on Azure (live, 6 agent templates seeded)
- Clerk auth wired (signup, login, middleware)
- All pages exist with basic UI
- All API modules exist (orgs, agents, billing, integrations, runs, health)
- API client at `apps/web/src/lib/api.ts`
- Razorpay billing module scaffolded
- Build passes clean (`pnpm build`)

**DB connection:** See `.env` file for DATABASE_URL
**Tech stack:** Next.js 14, NestJS, Prisma, PostgreSQL, Clerk, Razorpay, Tailwind CSS, TypeScript

## YOUR MISSION: Complete Sprints 2-7

Build everything below. Work sprint by sprint. Commit after each sprint. Make sure `pnpm build` passes after every sprint.

---

## Sprint 2: Integration Hub (OAuth)

Build the OAuth connection system for integrations.

### Backend (`apps/api/src/integrations/`)
1. **Gmail OAuth flow**: Implement full OAuth2 flow
   - `GET /api/integrations/gmail/auth` → redirect to Google consent
   - `GET /api/integrations/gmail/callback` → exchange code for tokens, store encrypted
   - Scopes: `gmail.send`, `gmail.readonly`, `gmail.compose`
   
2. **Outlook/Microsoft Graph OAuth flow**:
   - `GET /api/integrations/outlook/auth` → redirect to Microsoft consent
   - `GET /api/integrations/outlook/callback` → exchange code, store tokens
   - Scopes: `Mail.ReadWrite`, `Mail.Send`

3. **HubSpot OAuth flow**:
   - `GET /api/integrations/hubspot/auth` → redirect to HubSpot consent
   - `GET /api/integrations/hubspot/callback` → exchange code, store tokens
   - Scopes: `contacts`, `crm.objects.deals.read`, `crm.objects.companies.read`

4. **Integration management endpoints**:
   - `GET /api/integrations?orgId=X` → list all integrations for org
   - `DELETE /api/integrations/:id` → disconnect (revoke + delete)
   - `GET /api/integrations/:id/health` → check if tokens still valid

5. **Credential encryption**: Use AES-256-GCM for storing OAuth tokens. Use an ENCRYPTION_KEY env var.

6. **Token refresh**: Implement automatic token refresh for expired access tokens.

### Frontend (`apps/web/src/app/(dashboard)/integrations/page.tsx`)
1. Integration cards showing: Gmail, Outlook, HubSpot (with icons)
2. Connect/Disconnect buttons per integration
3. Status indicators (Connected/Disconnected/Error)
4. Health check display
5. "Connect" button redirects to OAuth flow, callback updates UI

**IMPORTANT:** For MVP, the OAuth flows don't need real Google/Microsoft/HubSpot app credentials. Implement the full flow structure but make it work with placeholder/mock data if env vars aren't set. The UI should show connected/disconnected state from the database.

**Simpler approach for MVP:** Instead of full OAuth, implement a "Connect" button that creates an integration record in the DB with status CONNECTED (simulating the OAuth). The full OAuth can be wired later when we have app credentials. But build the endpoint structure so it's ready.

---

## Sprint 3: Agent Runtime Engine

Build the job queue and agent execution system.

### Backend

1. **Job Queue Setup** (`apps/api/src/runtime/`):
   - Create `runtime.module.ts`, `runtime.service.ts`, `queue.service.ts`
   - Use a simple in-memory queue for MVP (BullMQ/Redis can come later)
   - Queue interface: `enqueue(job)`, `dequeue()`, `getStatus(jobId)`

2. **Worker Process** (`apps/api/src/runtime/worker.service.ts`):
   - Pick up queued jobs and execute agent logic
   - Each job: load agent config, load integration credentials, call LLM, format output, log results
   - Run in the same NestJS process for MVP (separate worker later)

3. **LLM Router** (`apps/api/src/runtime/llm.service.ts`):
   - Abstract interface: `chat(messages, model?)` 
   - Support OpenAI (GPT-4o-mini default, GPT-4o for complex)
   - Model selection based on task complexity flag
   - Token counting and budget enforcement per plan:
     - TRIAL: 5K tokens/run
     - STARTER: 10K tokens/run  
     - GROWTH: 50K tokens/run
     - ENTERPRISE: unlimited

4. **Agent Execution** (`apps/api/src/runtime/executor.service.ts`):
   - Load agent template + config
   - Build system prompt from template
   - Execute LLM call with org-scoped context
   - Parse structured output (email drafts, lead scores, posts, reports)
   - Log everything (tokens, duration, input/output)

5. **Agent Scheduling** (`apps/api/src/runtime/scheduler.service.ts`):
   - Simple cron-based scheduling using `node-cron` or `cron` npm package
   - Check active agents' schedules, enqueue runs when due
   - Default schedules per template type

6. **API Endpoints**:
   - `POST /api/agents/:id/runs` → trigger manual run
   - `GET /api/agents/:id/runs` → list runs with pagination
   - `GET /api/runs/:id` → run detail with logs
   - `POST /api/agents/:id/runs/:runId/cancel` → cancel a running job

7. **Structured Output Types**: Define output schemas for each agent type:
   ```typescript
   // SDR Agent output
   { type: 'email_draft', to: string, subject: string, body: string, leadScore: number }
   // Content Writer output  
   { type: 'content', platform: string, title: string, body: string, hashtags: string[] }
   // Inbox Monitor output
   { type: 'email_triage', emails: Array<{ id, category, priority, suggestedReply }> }
   ```

**NOTE:** For MVP, the LLM calls can be mocked if no OPENAI_API_KEY is set. Return realistic-looking sample outputs so the UI can be demoed. When the key IS set, make real calls.

---

## Sprint 4: Dashboard + Logs

Build the monitoring and management UI.

### Dashboard Home (`apps/web/src/app/(dashboard)/dashboard/page.tsx`)
1. **Stats cards at top**: Total agents, Active runs today, Tokens used today, Integrations connected
2. **Agent cards grid**: Each card shows agent name, template type, status (active/paused/error), last run time, next scheduled run, success rate
3. **Quick actions per card**: Pause/Resume, Trigger Run, View Logs
4. **Recent activity feed**: Last 10 agent runs with status, duration, token count

### Agent Detail Page (`apps/web/src/app/(dashboard)/agents/[id]/page.tsx`)
1. **Header**: Agent name, template, status badge, domain badge
2. **Config panel**: Show current configuration (read-only for now, edit in Sprint 5)
3. **Run history table**: Sortable by date, status, tokens, duration. Clickable rows.
4. **Run detail modal/page**: Show full input/output, token breakdown, duration, logs
5. **Log viewer**: Filterable by level (DEBUG/INFO/WARN/ERROR), searchable, with timestamps
6. **Actions**: Pause/Resume, Trigger Manual Run, Delete Agent

### Activity Page (`apps/web/src/app/(dashboard)/activity/page.tsx`)
1. **Timeline view**: All agent runs across all agents, chronological
2. **Filters**: By agent, by status (completed/failed/running), by date range
3. **Run detail expandable**: Click to see output, logs inline

### Settings Page (`apps/web/src/app/(dashboard)/settings/page.tsx`)
1. **Organization info**: Name, plan, member count (from Clerk)
2. **Billing section**: Current plan, usage this period, upgrade button
3. **API Keys** (placeholder): Show where API keys will go for Enterprise
4. **Danger zone**: Delete organization (confirmation modal)

### UI Requirements
- Dark theme consistent with existing design (bg-apex-dark, text-white, apex-indigo accents)
- Loading skeletons for all data-fetching states
- Empty states for no agents, no runs, etc.
- Error boundaries with retry buttons
- Responsive: mobile-friendly sidebar collapse

---

## Sprint 5: Agent Templates (End-to-End)

Make all 6 agent templates work with real configuration.

### Agent Configuration UI
1. **Config form per template type**: Dynamic form based on template's config_schema
2. **SDR Agent config**:
   - ICP criteria (industry, company size, geography, keywords)
   - Email tone selector (professional/casual/direct)
   - Follow-up cadence (days between follow-ups)
   - Daily email limit
   - Required: Email integration connected
   
3. **CRM Sync Agent config**:
   - Sync frequency (real-time/hourly/daily)
   - Fields to sync (contacts, deals, companies)
   - Required: CRM (HubSpot) + Email integration
   
4. **Content Writer config**:
   - Brand voice description (textarea)
   - Target platforms (LinkedIn, X, Blog)
   - Content themes/topics (tags)
   - Posting schedule
   - Required: None (outputs to dashboard)
   
5. **Social Engagement config**:
   - Keywords to monitor
   - Response style
   - Platforms to monitor
   - Required: None for MVP
   
6. **Inbox Monitor config**:
   - Email categories to classify
   - Auto-reply rules
   - Priority rules
   - Required: Email integration
   
7. **Reporting Agent config**:
   - Report type (daily/weekly)
   - Metrics to track
   - Delivery method (email/dashboard)
   - Required: None for MVP

### System Prompts
For each template, create well-crafted system prompts in `apps/api/src/runtime/prompts/`:
- `sdr-agent.ts` - Lead research and email drafting
- `crm-sync-agent.ts` - CRM data synchronization logic
- `content-writer.ts` - Content generation with brand voice
- `social-engagement.ts` - Social media monitoring and response
- `inbox-monitor.ts` - Email triage and categorization
- `reporting-agent.ts` - Data analysis and report generation

### Onboarding Wizard Enhancement
Update `apps/web/src/app/(dashboard)/onboarding/page.tsx`:
1. Step 1: Org details (name, industry, size) → POST to create org
2. Step 2: Domain selection (Sales/Marketing/Ops) → filters templates
3. Step 3: Template selection → shows available templates for domain
4. Step 4: Integration connection → shows required integrations, connect buttons
5. Step 5: Agent configuration → dynamic form based on template config_schema
6. Step 6: Review all choices → confirm and deploy
7. Each step persists state, back/forward navigation works
8. Final step creates agent + triggers first run

---

## Sprint 6: Landing Page + Launch Prep

### Landing Page (`apps/web/src/app/page.tsx`)
Complete redesign with:
1. **Hero section**: "Deploy Your AI Workforce in Minutes" headline, subtext about autonomous agents, CTA button
2. **Social proof**: "14 agents, 1 founder, $2.7M pipeline" stat bar
3. **Problem/Solution**: 3-column layout showing pain points → solutions
4. **How it works**: 4-step visual (Sign Up → Pick Agents → Connect Tools → Deploy)
5. **Agent showcase**: Interactive cards showing each agent type with example outputs
6. **Pricing section**: 3-tier pricing cards (Starter $49, Growth $149, Enterprise Custom)
7. **FAQ section**: Accordion with common questions
8. **Footer**: Links, social, legal

### SEO
1. Add `metadata` exports to all pages (title, description, openGraph)
2. Create `apps/web/src/app/sitemap.ts` (dynamic sitemap)
3. Create `apps/web/src/app/robots.ts`
4. Add JSON-LD structured data to landing page

### Error Pages
1. `apps/web/src/app/not-found.tsx` - Custom 404
2. `apps/web/src/app/error.tsx` - Custom error boundary
3. Rate limit page (if applicable)

### Legal Pages
1. `apps/web/src/app/terms/page.tsx` - Terms of Service
2. `apps/web/src/app/privacy/page.tsx` - Privacy Policy
(Generate reasonable boilerplate for a SaaS product called "Apex by Kloudedge")

---

## Sprint 7: Polish + Launch Ready

### Final Polish
1. **Loading states everywhere**: Skeleton screens for all pages
2. **Empty states**: Friendly messages + CTAs for zero-data states
3. **Toast notifications**: Success/error feedback for all actions (use a simple toast system)
4. **Form validation**: All forms validated with helpful error messages
5. **Responsive design**: Test and fix mobile layout for all pages
6. **Keyboard shortcuts**: ESC to close modals, Enter to submit forms
7. **Breadcrumbs**: Navigation context on detail pages

### Performance
1. Lazy load heavy components
2. Image optimization (next/image)
3. API response caching where appropriate

### Security
1. CORS configuration on API
2. Rate limiting on API endpoints (simple in-memory)
3. Input validation/sanitization on all endpoints
4. Org-scoped data access (users can only see their own org's data)

### Final Checks
1. `pnpm build` passes with zero errors
2. All TypeScript strict mode passes
3. No console.log/console.error left in production code
4. All environment variables documented in `.env.example`

---

## Implementation Rules

1. **Build incrementally**: Complete one sprint before moving to the next
2. **Commit after each sprint**: `git add -A && git commit -m "Sprint X: <description>"`
3. **Build must pass**: Run `pnpm build` after each sprint, fix any errors
4. **TypeScript strict**: No `any` types unless absolutely necessary
5. **Consistent styling**: Follow existing Tailwind patterns (dark theme, apex-* custom classes)
6. **No new major dependencies** unless essential. Prefer built-in/lightweight solutions.
7. **Mock gracefully**: If external service credentials aren't available (OpenAI, Google OAuth, etc.), mock with realistic data. The app should be fully demoable without any external API keys.
8. **Error handling**: Every API call should have try/catch, every fetch should handle errors

## File Structure Reference

```
apex-product/
├── apps/
│   ├── api/
│   │   └── src/
│   │       ├── agents/         # Agent CRUD (EXISTS)
│   │       ├── auth/           # Auth (EXISTS)
│   │       ├── billing/        # Billing (EXISTS)
│   │       ├── health/         # Health check (EXISTS)
│   │       ├── integrations/   # Integration CRUD (EXISTS, needs OAuth flows)
│   │       ├── orgs/           # Org CRUD (EXISTS)
│   │       ├── prisma/         # Prisma service (EXISTS)
│   │       ├── runs/           # Run CRUD (EXISTS)
│   │       ├── runtime/        # NEW: Agent execution engine
│   │       │   ├── runtime.module.ts
│   │       │   ├── runtime.service.ts
│   │       │   ├── queue.service.ts
│   │       │   ├── worker.service.ts
│   │       │   ├── llm.service.ts
│   │       │   ├── executor.service.ts
│   │       │   ├── scheduler.service.ts
│   │       │   └── prompts/
│   │       │       ├── sdr-agent.ts
│   │       │       ├── crm-sync-agent.ts
│   │       │       ├── content-writer.ts
│   │       │       ├── social-engagement.ts
│   │       │       ├── inbox-monitor.ts
│   │       │       └── reporting-agent.ts
│   │       ├── app.module.ts
│   │       └── main.ts
│   └── web/
│       └── src/
│           ├── app/
│           │   ├── page.tsx              # Landing page (needs redesign)
│           │   ├── sitemap.ts            # NEW
│           │   ├── robots.ts             # NEW
│           │   ├── not-found.tsx          # NEW
│           │   ├── error.tsx              # NEW
│           │   ├── terms/page.tsx         # NEW
│           │   ├── privacy/page.tsx       # NEW
│           │   ├── (auth)/
│           │   │   ├── login/page.tsx     # EXISTS
│           │   │   └── signup/page.tsx    # EXISTS
│           │   └── (dashboard)/
│           │       ├── dashboard/page.tsx  # EXISTS (needs real data)
│           │       ├── agents/page.tsx     # EXISTS (needs enhancement)
│           │       ├── agents/[id]/page.tsx # EXISTS (needs detail view)
│           │       ├── onboarding/page.tsx  # EXISTS (needs full wizard)
│           │       ├── integrations/page.tsx # EXISTS (needs OAuth UI)
│           │       ├── activity/page.tsx    # EXISTS (needs timeline)
│           │       └── settings/page.tsx    # EXISTS (needs org/billing)
│           ├── components/
│           │   ├── sidebar.tsx            # EXISTS
│           │   └── ui/                    # NEW: reusable components
│           │       ├── toast.tsx
│           │       ├── modal.tsx
│           │       ├── skeleton.tsx
│           │       ├── badge.tsx
│           │       ├── empty-state.tsx
│           │       └── ...
│           └── lib/
│               ├── api.ts                 # EXISTS
│               └── cn.ts                  # EXISTS
└── packages/
    └── db/
        └── prisma/
            ├── schema.prisma              # EXISTS (don't modify!)
            └── seed.ts                    # EXISTS
```

## Environment Variables (.env.example)

```
DATABASE_URL=postgresql://...
ENCRYPTION_KEY=<32-byte-hex-key-for-aes-256>

# Clerk (already configured)
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_...
CLERK_SECRET_KEY=sk_...

# OAuth (optional for MVP - app works with mocks if not set)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=http://localhost:4000/api/integrations/gmail/callback

MICROSOFT_CLIENT_ID=
MICROSOFT_CLIENT_SECRET=
MICROSOFT_REDIRECT_URI=http://localhost:4000/api/integrations/outlook/callback

HUBSPOT_CLIENT_ID=
HUBSPOT_CLIENT_SECRET=
HUBSPOT_REDIRECT_URI=http://localhost:4000/api/integrations/hubspot/callback

# LLM (optional - mocks if not set)
OPENAI_API_KEY=

# Razorpay (already configured)
RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=

# App
API_URL=http://localhost:4000
NEXT_PUBLIC_API_URL=http://localhost:4000/api
```

## GO. Build it all. Sprint by sprint. Commit after each. Make it demoable.
