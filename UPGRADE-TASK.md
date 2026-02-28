# UPGRADE TASK: Make Apex Agents Actually Autonomous

## Context
The current Apex platform has a working skeleton but agents are thin wrappers around single LLM calls. They need to become multi-step autonomous agents with real tool use, memory, and integrations.

**Current state:** Agent runs = 1 LLM call with a system prompt → structured JSON output. No tools, no memory, no real actions.

**Target state:** Agents that plan, use tools (web search, email, CRM), remember past runs, take real actions, and produce actionable outputs.

## PHASE 1: Agent Tool System

### 1.1 Tool Framework (`apps/api/src/runtime/tools/`)

Create a tool execution framework that agents can use during runs:

```typescript
// tools/tool.interface.ts
interface Tool {
  name: string;
  description: string;
  parameters: Record<string, { type: string; description: string; required?: boolean }>;
  execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}

interface ToolContext {
  orgId: string;
  agentId: string;
  runId: string;
  integrations: Map<string, IntegrationCredentials>;
}

interface ToolResult {
  success: boolean;
  data: unknown;
  error?: string;
}
```

### 1.2 Built-in Tools

Create these tools in `apps/api/src/runtime/tools/`:

**a) `web-search.tool.ts`** - Search the web
- Use Tavily API (key from env: TAVILY_API_KEY) or fall back to basic fetch+extract
- Input: query string, max results
- Output: array of {title, url, snippet, content}

**b) `web-scrape.tool.ts`** - Extract content from a URL
- Fetch URL, extract readable text (use readability-like extraction)
- Input: url
- Output: {title, content, links}

**c) `send-email.tool.ts`** - Actually send emails
- Use Microsoft Graph API (check for outlook integration credentials)
- If no real credentials, use mock mode (log what would be sent, store in run result)
- Input: {to, subject, body, from?}
- Output: {sent: boolean, messageId?, error?}

**d) `hubspot.tool.ts`** - CRM operations
- Create/update contacts, deals, companies
- Search contacts
- Uses HubSpot integration credentials
- If no real credentials, mock mode
- Input: {action: "create_contact"|"update_deal"|"search", data: {...}}
- Output: CRM response

**e) `company-research.tool.ts`** - Research a company
- Combine web search + scrape to build company profile
- Input: {company_name, domain?}
- Output: {name, domain, industry, size, description, recent_news, key_people}

**f) `lead-score.tool.ts`** - Score a lead against ICP
- Takes lead data + ICP criteria from agent config
- Returns numeric score with reasoning
- Input: {lead: {...}, icp: {...}}
- Output: {score: 0-100, reasoning: string, signals: string[]}

### 1.3 Tool Registry (`tools/registry.ts`)

```typescript
class ToolRegistry {
  private tools = new Map<string, Tool>();
  
  register(tool: Tool): void;
  get(name: string): Tool | undefined;
  getForTemplate(templateName: string): Tool[]; // Returns relevant tools per agent type
  listAll(): { name: string; description: string }[];
}
```

Map tools to agent templates:
- SDR Agent: web-search, company-research, lead-score, send-email, hubspot
- CRM Sync Agent: hubspot, web-scrape
- Content Writer: web-search, web-scrape
- Social Engagement: web-search, web-scrape
- Inbox Monitor: send-email (for auto-replies)
- Reporting Agent: hubspot, web-search

## PHASE 2: Multi-Step Agent Execution

### 2.1 Upgrade Executor to Multi-Step (`executor.service.ts`)

Replace the single LLM call with an agentic loop:

```
1. Build system prompt with tool descriptions
2. Send initial message to LLM with function calling / tool use
3. LOOP (max 10 iterations):
   a. Parse LLM response
   b. If response contains tool calls → execute tools → feed results back
   c. If response is final answer → break
   d. Log each step
4. Parse final structured output
5. Return results
```

Use OpenAI function calling format:
- Convert Tool definitions to OpenAI function schemas
- Pass as `tools` parameter in the API call
- Handle `tool_calls` in the response
- Feed tool results back as `tool` role messages

### 2.2 LLM Service Upgrade (`llm.service.ts`)

Add support for:
- Function calling / tool use in the API call
- `tools` parameter (OpenAI format)
- `tool_choice` parameter
- Parsing `tool_calls` from response
- Higher token limits for multi-step (up to 8K per step, 32K total per run)
- Streaming support (optional, for future)

### 2.3 Step Logging

Log each step of the agent loop as an AgentLog entry:
```
[INFO] Starting execution for agent: My SDR Agent
[INFO] Step 1: Planning approach
[INFO] Step 2: Tool call → web-search("Acme Corp SaaS")
[DEBUG] web-search returned 5 results
[INFO] Step 3: Tool call → company-research("Acme Corp")
[DEBUG] Company profile built: SaaS, 200 employees, Series B
[INFO] Step 4: Tool call → lead-score(lead, icp)
[DEBUG] Lead score: 85/100
[INFO] Step 5: Generating personalized email
[INFO] Step 6: Tool call → send-email({to: "cto@acme.com", ...})
[INFO] Execution completed: 6 steps, 3247 tokens, 12.4s
```

## PHASE 3: Agent Memory

### 3.1 Schema Changes

Add to Prisma schema:

```prisma
model AgentMemory {
  id        String   @id @default(cuid())
  agentId   String
  agent     Agent    @relation(fields: [agentId], references: [id], onDelete: Cascade)
  key       String   // e.g. "contacted_leads", "company_research_cache", "last_run_summary"
  value     Json
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([agentId, key])
  @@index([agentId])
}
```

Update the Agent model to add the relation:
```prisma
model Agent {
  // ... existing fields
  memories  AgentMemory[]
}
```

### 3.2 Memory Service (`runtime/memory.service.ts`)

```typescript
class MemoryService {
  // Store/retrieve agent-scoped memories
  async get(agentId: string, key: string): Promise<unknown | null>;
  async set(agentId: string, key: string, value: unknown): Promise<void>;
  async getAll(agentId: string): Promise<Record<string, unknown>>;
  async delete(agentId: string, key: string): Promise<void>;
  
  // Convenience methods
  async getContactedLeads(agentId: string): Promise<string[]>;
  async addContactedLead(agentId: string, email: string): Promise<void>;
  async getLastRunSummary(agentId: string): Promise<string | null>;
  async setLastRunSummary(agentId: string, summary: string): Promise<void>;
}
```

### 3.3 Memory in Executor

Before each run:
1. Load agent memories (last run summary, contacted leads, research cache)
2. Include relevant memory context in the system prompt
3. After run completes, update memories (add new contacts, cache research, store summary)

The LLM system prompt should include:
```
## Your Memory (from previous runs)
Last run: You researched 3 companies and sent 2 emails. Acme Corp responded positively.
Contacted leads: john@acme.com (replied), sarah@techco.com (no reply), mike@startup.io (bounced)
```

### 3.4 Memory Tool

Add a `memory.tool.ts` that the agent can call:
- `memory_read(key)` - Read from its own memory
- `memory_write(key, value)` - Write to its own memory
- `memory_list()` - List all memory keys

This lets the agent self-manage what it remembers.

## PHASE 4: Real Integration Support

### 4.1 Credential Decryption

The IntegrationsService already encrypts credentials with AES-256. Add a method to decrypt:

```typescript
async getDecryptedCredentials(orgId: string, provider: string): Promise<Record<string, unknown> | null>;
```

### 4.2 Integration Context in Executor

When executing an agent:
1. Load the org's integrations
2. Decrypt credentials for relevant integrations
3. Pass as ToolContext to tools
4. Tools use real credentials when available, mock when not

### 4.3 Microsoft Graph Email Tool (Real)

When outlook/gmail integration has real OAuth tokens:
- Use Graph API to send emails
- Use Graph API to read inbox
- Handle token refresh

For MVP: implement the send and read flows. The OAuth callback already stores tokens.

### 4.4 HubSpot Tool (Real)

When HubSpot integration has real OAuth tokens:
- Create/update contacts via HubSpot API
- Search contacts
- Create/update deals
- Log activities

## PHASE 5: Enhanced Agent Templates

### 5.1 SDR Agent (Full Workflow)

Multi-step workflow:
1. **Research phase**: Use web-search + company-research to find info about target
2. **Scoring phase**: Use lead-score to evaluate fit against ICP
3. **Personalization**: Generate highly personalized email using research data
4. **Action**: Send email (or queue for approval based on config)
5. **CRM Update**: Create/update lead in HubSpot
6. **Memory Update**: Record contacted lead, cache research

System prompt should instruct the agent to:
- ALWAYS research before emailing
- Reference specific company details in emails
- Score leads and skip low-quality ones
- Track who's been contacted to avoid duplicates

### 5.2 Content Writer (Full Workflow)

Multi-step workflow:
1. **Research phase**: Search for trending topics in configured themes
2. **Analysis**: Analyze top content for gaps and angles
3. **Writing**: Generate content with brand voice
4. **Formatting**: Format for target platform (LinkedIn post, blog, tweet)
5. **Memory**: Track published topics to avoid repetition

### 5.3 Inbox Monitor (Full Workflow)

Multi-step workflow:
1. **Read inbox**: Fetch recent emails via Graph API
2. **Classify**: Categorize each email (urgent, follow-up, spam, etc.)
3. **Prioritize**: Rank by priority
4. **Draft replies**: Generate suggested replies for important emails
5. **Auto-reply**: Send auto-replies for configured categories
6. **Report**: Produce triage summary

### 5.4 Reporting Agent (Full Workflow)

Multi-step workflow:
1. **Gather data**: Query HubSpot for deals, contacts, activities
2. **Analyze**: Calculate metrics (pipeline value, conversion rates, activity)
3. **Research**: Check industry benchmarks via web search
4. **Generate report**: Structured report with metrics, insights, recommendations
5. **Memory**: Compare with last report to show trends

## PHASE 6: Frontend Upgrades

### 6.1 Run Detail View Enhancement

Update `apps/web/src/app/(dashboard)/agents/[id]/page.tsx`:
- Show each step of the agent execution (not just final result)
- Visual step timeline: Research → Score → Draft → Send → CRM Update
- Expandable log entries with tool call details
- Show tool inputs/outputs inline
- Color-coded step status (success/fail/pending)

### 6.2 Agent Output Display

For SDR agent runs, show:
- Email preview card (to, subject, body, lead score)
- Company research summary card
- CRM update confirmation
- "Approve & Send" button for approval-required configs

For Content Writer runs, show:
- Content preview with platform formatting
- "Copy to Clipboard" and "Schedule" buttons

For Inbox Monitor, show:
- Email triage table with categories and priorities
- Suggested reply previews
- "Send Reply" action buttons

### 6.3 Memory Panel

Add to agent detail page:
- "Memory" tab showing all stored memories
- Editable memory entries (user can correct agent's memory)
- Memory usage (how many entries, storage size)
- Clear memory button

### 6.4 Real-time Run Status

- Polling every 2 seconds while a run is in progress
- Show live step updates as they happen
- Progress indicator (Step 3 of 6)
- Estimated time remaining

## Implementation Rules

1. **Build incrementally**: Phase 1 → 2 → 3 → 4 → 5 → 6
2. **Commit after each phase**: `git add -A && git commit -m "Phase X: description"`
3. **Build must pass**: Run `pnpm build` after each phase
4. **Run Prisma migration** after schema changes: `cd packages/db && npx prisma db push`
5. **Test locally**: Start the API and verify tool execution works
6. **Mock gracefully**: If API keys aren't available (Tavily, OpenAI, Graph), mock with realistic data
7. **Keep backward compatible**: Existing agents should still work

## Environment Variables (new)

```
# Tools
TAVILY_API_KEY=          # For web search (optional, mocks if not set)

# Already set
OPENAI_API_KEY=          # For LLM calls (already configured)
ENCRYPTION_KEY=          # For credential decryption (already set)
DATABASE_URL=            # Already configured
```

## File Structure (new files)

```
apps/api/src/runtime/
├── tools/
│   ├── tool.interface.ts      # Tool interface + types
│   ├── registry.ts            # Tool registry
│   ├── web-search.tool.ts     # Tavily web search
│   ├── web-scrape.tool.ts     # URL content extraction
│   ├── send-email.tool.ts     # Email via Graph API
│   ├── hubspot.tool.ts        # CRM operations
│   ├── company-research.tool.ts  # Company profiling
│   ├── lead-score.tool.ts     # ICP scoring
│   └── memory.tool.ts         # Agent memory read/write
├── memory.service.ts          # Agent memory persistence
├── executor.service.ts        # UPGRADED: multi-step with tools
├── llm.service.ts             # UPGRADED: function calling support
├── prompts/                   # UPGRADED: tool-aware prompts
│   ├── sdr-agent.ts
│   ├── content-writer.ts
│   ├── inbox-monitor.ts
│   ├── crm-sync-agent.ts
│   ├── social-engagement.ts
│   ├── reporting-agent.ts
│   └── index.ts
└── ...existing files
```

## GO. Build all 6 phases. This transforms the agents from toys into real autonomous workers.
