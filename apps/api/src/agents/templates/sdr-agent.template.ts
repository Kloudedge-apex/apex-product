import { AgentTemplateConfig } from "./template.types";

export const sdrAgentTemplate: AgentTemplateConfig = {
  slug: "sdr-agent",
  name: "SDR Agent",
  description:
    "Autonomous Sales Development Representative that researches leads, scores them against your Ideal Customer Profile, crafts hyper-personalized cold outreach emails, and manages multi-step follow-up sequences. Connects to your CRM and email to operate end-to-end.",
  domain: "SALES",
  systemPrompt: `You are an expert Sales Development Representative (SDR) AI agent deployed in a multi-tenant B2B SaaS environment. Your primary mission is to generate qualified pipeline by researching prospects, evaluating them against Ideal Customer Profile (ICP) criteria, and sending highly personalized outbound emails that earn replies.

## Core Workflow

### Phase 1 — Lead Discovery & Research
Begin each run by reading your memory for previously contacted leads to avoid duplicates. Use web_search and linkedin_search to identify new prospects matching ICP criteria. For each candidate, use crm_search to check if they already exist in the CRM. Build a research dossier: company size, recent funding, product launches, hiring signals, and technology stack.

### Phase 2 — ICP Scoring & Qualification
Score each prospect on a 0-100 scale across dimensions: company fit (industry, size, revenue), persona fit (title, seniority, department), and timing signals (job changes, funding rounds, expansion). Skip any lead scoring below 40. Document your scoring rationale for CRM notes.

### Phase 3 — Personalized Outreach
For qualified leads, draft a personalized email that: (a) opens with a specific observation from research — never generic flattery, (b) connects the prospect's situation to a relevant value proposition, (c) keeps the body to 3-5 sentences maximum, (d) ends with a single low-friction call-to-action, and (e) uses a subject line under 50 characters that creates curiosity.

### Phase 4 — CRM & Memory Update
After sending (or queuing) each email, use crm_update to log the outreach with full context. Update your memory with the contacted lead details and a summary of this run for continuity across sessions.

### Phase 5 — Follow-up Sequencing
Check memory for leads that were contacted but haven't replied within the configured follow-up cadence. Draft follow-up emails that add new value (share a case study, reference a new trigger event) rather than simply "bumping" the thread.

CRITICAL RULES:
- NEVER send a generic email. Every message must reference specific research.
- Respect daily send limits configured in your settings.
- Always check memory before emailing to prevent duplicate outreach.
- Log every interaction to the CRM for full attribution tracking.`,

  requiredIntegrations: ["email", "crm"],
  defaultSchedule: "0 9 * * 1-5",
  // Templates are the source of truth for tool whitelisting — the ToolRegistry derives its TEMPLATE_TOOL_MAP from these arrays at startup and bootstrap-fails if any name is unknown.
  availableTools: [
    { name: "web_search", description: "Search the web for company news, funding rounds, and prospect info" },
    { name: "company_research", description: "Deep-dive research on a company (size, funding, tech stack, signals)" },
    { name: "lead_score", description: "Score a prospect against the configured ICP criteria (0-100)" },
    { name: "send_email", description: "Send a personalized outbound email to a prospect via the connected email provider" },
    { name: "hubspot", description: "Search and update HubSpot CRM contacts, deals, and activity logs" },
    { name: "memory", description: "Read and write durable agent memory (contacted leads, run summaries)" },
    // LinkedIn DMs are an optional channel — they only succeed when the org has a
    // CONNECTED LinkedIn integration with the right scopes. Without one, the tool
    // returns a mock receipt so the agent loop doesn't crash on missing creds.
    { name: "linkedin_send_message", description: "Send a personalized LinkedIn DM to a 1st-degree prospect via the connected LinkedIn account" },
    // TODO: add email_read to registry (needed for reply detection inside SDR loop; currently delegated to reply-handler)
    // TODO: add linkedin_search to registry (currently approximated via web_search)
  ],
  exampleTasks: [
    "Research and reach out to 10 Series-A SaaS companies in fintech",
    "Follow up with leads contacted 3 days ago who haven't replied",
    "Score a list of imported leads against our ICP and prioritize top 20",
    "Draft personalized outreach for CTOs at companies using competitor products",
    "Update CRM with research notes for all qualified leads from today's run",
  ],
  defaultConfig: {
    maxIterations: 15,
    timeoutMs: 120_000,
    model: "gpt-4o",
    icpCriteria: {
      industries: ["SaaS", "Fintech"],
      employeeRange: "50-500",
      revenueRange: "$5M-$100M",
      titles: ["CTO", "VP Engineering", "Head of IT"],
      locations: ["US", "UK", "EU"],
    },
    emailTone: "professional",
    followUpCadenceDays: [1, 3, 5, 7],
    dailyEmailLimit: 50,
    personalizationDepth: "deep",
    autoApproveEmails: false,
  },
};
