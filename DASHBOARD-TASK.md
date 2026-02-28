# DASHBOARD UPGRADE TASK

## Context
Current dashboard is useless: 4 stats cards, agent list, and a basic activity feed. Needs to be a real command center that gives users actionable insights at a glance.

## PART 1: Enhanced API Endpoints

### 1.1 Rich Stats Endpoint (`GET /orgs/:id/stats`)

Upgrade `orgs.service.ts` getStats to return much more:

```typescript
{
  // Overview
  activeAgents: number,
  pausedAgents: number,
  totalAgents: number,
  totalRuns: number,
  runsToday: number,
  runsThisWeek: number,
  successRate: number, // percentage of COMPLETED vs total
  integrations: number,
  tokensUsed: number,
  tokensToday: number,
  totalCost: number,
  costToday: number,
  
  // Trends (last 7 days, daily buckets)
  runsByDay: Array<{ date: string, total: number, completed: number, failed: number }>,
  tokensByDay: Array<{ date: string, tokens: number, cost: number }>,
  
  // Top performers
  topAgents: Array<{ id: string, name: string, domain: string, runs: number, successRate: number, avgTokens: number }>,
  
  // Recent failures
  recentFailures: Array<{ runId: string, agentName: string, error: string, timestamp: string }>,
  
  // Agent breakdown by domain
  agentsByDomain: { SALES: number, MARKETING: number, OPS: number },
  runsByDomain: { SALES: number, MARKETING: number, OPS: number },
}
```

Use Prisma aggregations, groupBy, and raw queries as needed. For daily buckets, use date_trunc.

### 1.2 Agent Analytics Endpoint (`GET /agents/:id/analytics`)

Add to AgentsController:

```typescript
{
  totalRuns: number,
  runsLast7Days: number,
  runsLast30Days: number,
  successRate: number,
  avgExecutionTime: number, // ms
  avgTokensPerRun: number,
  totalTokens: number,
  totalCost: number,
  
  // Last 7 days daily
  runsByDay: Array<{ date: string, total: number, completed: number, failed: number }>,
  
  // Memory usage
  memoryKeys: number,
  
  // Last 5 runs summary
  recentRuns: Array<{ id: string, status: string, startedAt: string, completedAt: string, tokensUsed: number, steps: number }>,
  
  // Tool usage breakdown
  toolUsage: Record<string, number>, // e.g. { "web_search": 12, "send_email": 5 }
}
```

For tool usage: parse the AgentLog entries that contain "Tool call" in their message to count tool invocations.

### 1.3 Runs List Enhancement

Update the runs list endpoint to support:
- `?status=COMPLETED,FAILED` - filter by status
- `?agentId=xxx` - filter by agent
- `?from=2026-02-01&to=2026-02-28` - date range
- `?limit=50&offset=0` - pagination
- Include step count from logs (count logs where level='INFO' and message starts with 'Step')
- Include `agent.name` and `agent.domain` in response

## PART 2: Dashboard Page Rewrite

Completely rewrite `apps/web/src/app/(dashboard)/dashboard/page.tsx`. The new dashboard should have these sections:

### Section 1: KPI Bar (top)
A horizontal row of 6-8 key metrics with sparkline-style indicators:
- Active Agents (with +/- vs last week)
- Runs Today (with trend arrow)
- Success Rate (as percentage with color: green >90%, yellow >75%, red <75%)
- Tokens Today (with cost in $)
- Total Cost (this month)
- Integrations Connected

Each metric: large number, small label, trend indicator (up/down arrow + percentage).

### Section 2: Activity Chart (main visual)
A 7-day bar chart showing runs per day, stacked by status (completed=green, failed=red, running=blue).
Build this with pure CSS/HTML (no chart library needed):
- Each day = a column
- Stacked colored bars proportional to count
- Date labels on x-axis
- Hover tooltips showing exact numbers
Use a div-based bar chart approach. Example:

```tsx
<div className="flex items-end gap-2 h-40">
  {runsByDay.map(day => (
    <div key={day.date} className="flex-1 flex flex-col justify-end">
      <div className="bg-green-500/80 rounded-t" style={{ height: `${(day.completed/maxRuns)*100}%` }} />
      <div className="bg-red-500/80" style={{ height: `${(day.failed/maxRuns)*100}%` }} />
      <span className="text-xs text-center mt-1">{formatDay(day.date)}</span>
    </div>
  ))}
</div>
```

### Section 3: Two-Column Layout

**Left Column (60%): Agent Performance Table**
A sortable table showing each agent:
| Agent | Domain | Status | Runs (7d) | Success % | Avg Time | Tokens | Actions |
Sortable by any column. Color-coded status badges. Quick action buttons (Run, Pause/Resume).
Click agent name → goes to agent detail page.

**Right Column (40%): Live Activity Feed**
Real-time-ish feed of recent events:
- "SDR Agent completed run in 3.2s (612 tokens)" with green dot
- "Content Writer failed: API timeout" with red dot  
- "Inbox Monitor queued for execution" with yellow dot
- Each entry: timestamp, agent name, status icon, brief description
- Auto-refresh every 10 seconds
- "View all" link to /activity page

### Section 4: Domain Breakdown (below two-column)
Three cards side by side for SALES, MARKETING, OPS:
Each card shows:
- Number of agents in that domain
- Total runs this week
- A mini donut chart (CSS-based) showing success/fail ratio
- Top agent in that domain

### Section 5: Alerts & Recommendations
A card at the bottom showing actionable items:
- "3 agents haven't run in 7+ days" (with list)
- "SDR Agent has 40% failure rate - check configuration"
- "No email integration connected - connect to enable real outreach"
- "Trial expires in X days - upgrade to keep your agents running"
These come from simple logic checks on the stats data.

### Section 6: Token Usage & Cost
A horizontal bar showing token usage:
- Usage bar (filled portion = used / limit based on plan)
- Plan label and upgrade CTA if > 80% used
- Cost breakdown: "Today: $0.45 | This Week: $2.30 | This Month: $8.50"
- Per-agent cost breakdown (mini horizontal bars)

## PART 3: Improved Agent Detail Page

The current agent detail page (agents/[id]/page.tsx) was upgraded in Phase 6 but needs more:

### 3.1 Analytics Tab
Add an "Analytics" tab alongside existing tabs:
- 7-day run chart (same style as dashboard)
- Success rate trend
- Average execution time trend
- Token usage over time
- Tool usage breakdown (which tools this agent uses most)

### 3.2 Run Comparison
When viewing a run, show a "Compare" toggle that shows the previous run side by side:
- What changed in the output?
- Token usage difference
- Different tools used?

Keep this simple: just show both outputs side by side with headers "Current Run" vs "Previous Run".

## PART 4: Activity Page Enhancement

Rewrite `apps/web/src/app/(dashboard)/activity/page.tsx`:
- Filterable by: agent, status, date range, domain
- Searchable (search through run results)
- Paginated (25 per page with load more)
- Each entry expandable to show steps and tool calls inline (without navigating away)
- Export as CSV button (client-side, generates from visible data)

## Implementation Rules

1. **No chart libraries**. Use CSS-based visualizations (div bars, border-radius donuts, etc.)
2. **All data from API**. Add new endpoints as needed.
3. **Dark theme only**. Use existing apex-* Tailwind classes.
4. **Responsive**. Works on desktop (primary) and tablet. Mobile is nice-to-have.
5. **Build must pass** after each commit.
6. **Don't break existing functionality** — the onboarding, agent CRUD, integrations pages must still work.
7. **Use existing components** where possible (from `apps/web/src/components/`).
8. Commit each part separately: Part 1, Part 2, Part 3, Part 4.

## CSS-Based Donut Chart Example

```tsx
function DonutChart({ success, fail, size = 80 }: { success: number; fail: number; size?: number }) {
  const total = success + fail;
  const successPct = total > 0 ? (success / total) * 100 : 0;
  return (
    <div className="relative" style={{ width: size, height: size }}>
      <div
        className="absolute inset-0 rounded-full"
        style={{
          background: `conic-gradient(
            #22c55e 0% ${successPct}%,
            #ef4444 ${successPct}% 100%
          )`,
        }}
      />
      <div className="absolute inset-2 rounded-full bg-apex-card flex items-center justify-center">
        <span className="text-sm font-bold">{Math.round(successPct)}%</span>
      </div>
    </div>
  );
}
```

## GO. Build all 4 parts. Make the dashboard actually useful.
