import { Injectable, Logger, Optional } from "@nestjs/common";
import { OpenAIFunctionDef } from "./tools/tool.interface";
import { LangSmithService } from "../observability/langsmith.service";
import { withCircuitBreaker } from "../common/http-retry.util";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCallMessage[];
  tool_call_id?: string;
}

export interface ToolCallMessage {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface LLMResponse {
  content: string;
  tokensUsed: number;
  model: string;
  cost: number;
  toolCalls?: ToolCallMessage[];
  finishReason?: string;
}

const TOKEN_LIMITS: Record<string, number> = {
  TRIAL: 5000,
  STARTER: 10000,
  GROWTH: 50000,
  ENTERPRISE: Infinity,
};

const COST_PER_1K: Record<string, number> = {
  "gpt-4o-mini": 0.00015,
  "gpt-4o": 0.005,
  "claude-3-5-sonnet-20241022": 0.003,
  "claude-3-haiku-20240307": 0.00025,
};

const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS) || 60_000;
const AZURE_OPENAI_API_VERSION =
  process.env.AZURE_OPENAI_API_VERSION || "2024-08-01-preview";

/*
 * Model selection env vars (all optional; sensible defaults baked in):
 *
 *   DEFAULT_MODEL          — last-resort fallback when neither template nor
 *                            caller specifies a model. Read here in
 *                            LLMService.chat(). Default: "gpt-4o-mini".
 *
 *   SYSTEM_MODEL_MINI      — model used by system pipelines that have no
 *                            agent template (icp-auto, team-page-scraper)
 *                            and by ExecutorService for simple-task
 *                            templates (template.fastModel fallback).
 *                            Default: "gpt-4o-mini".
 *
 *   LANGSMITH_JUDGE_MODEL  — model used by evaluator judges (PII, toxicity,
 *                            bias, etc.). Judges are system-level, not
 *                            template-driven. Read in evaluators/judge.ts.
 *                            Default: "gpt-4o-mini".
 *
 * Templates declare their own primary `model` and optional `fastModel` in
 * `defaultConfig`; ExecutorService prefers those over DEFAULT_MODEL /
 * SYSTEM_MODEL_MINI when a template is present.
 */

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Map a public OpenAI model name to its Azure deployment name. Azure routes
 * by deployment name, not model name, so callers can keep using "gpt-4o" etc.
 * Returns null if Azure isn't configured or no deployment is mapped.
 */
function azureDeploymentFor(model: string): string | null {
  if (!process.env.AZURE_OPENAI_ENDPOINT || !process.env.AZURE_OPENAI_KEY) {
    return null;
  }
  if (model === "gpt-4o-mini") return process.env.AZURE_OPENAI_FAST_DEPLOYMENT || null;
  if (model === "gpt-4o") return process.env.AZURE_OPENAI_DEPLOYMENT || null;
  // Unknown model — let it fall through to public OpenAI rather than guessing.
  return null;
}

/** Default model for complex tasks — uses Claude when key available, else GPT-4o */
export function getComplexModel(): string {
  return process.env.ANTHROPIC_API_KEY ? "claude-3-5-sonnet-20241022" : "gpt-4o";
}

/**
 * gpt-5/o-series Azure deployments reject `max_tokens` and require
 * `max_completion_tokens`. gpt-4.x deployments still accept `max_tokens`.
 */
function maxTokensParamFor(deployment: string): "max_completion_tokens" | "max_tokens" {
  const d = deployment.toLowerCase();
  if (d.startsWith("gpt-5") || d.startsWith("o1") || d.startsWith("o3") || d.startsWith("o4")) {
    return "max_completion_tokens";
  }
  return "max_tokens";
}

interface LlmAttribution {
  parentRunId?: string;
  agent?: string;
  node?: string;
  tags?: readonly string[];
  metadata?: Readonly<Record<string, unknown>>;
  onRunStart?: (runId: string) => void;
}

export interface ChatOptions {
  model?: string;
  maxTokens?: number;
  plan?: string;
  tools?: OpenAIFunctionDef[];
  toolChoice?: "auto" | "none" | "required";
  parentRunId?: string;
  /** Logical agent name for LangSmith attribution, e.g. "sdr_agent.draft_message". */
  agent?: string;
  /** Graph node name, e.g. "sdr_outreach.qa_message". */
  node?: string;
  /** Free-form tags attached to the LangSmith run. */
  tags?: readonly string[];
  /** Extra metadata merged into the LangSmith run. */
  metadata?: Readonly<Record<string, unknown>>;
  /** Fires after the LangSmith run is created on the server, with the runId. */
  onRunStart?: (runId: string) => void;
}

@Injectable()
export class LLMService {
  private readonly logger = new Logger(LLMService.name);
  private apiKey = process.env.OPENAI_API_KEY;
  private readonly azureKey = process.env.AZURE_OPENAI_KEY;
  private readonly azureEndpoint = process.env.AZURE_OPENAI_ENDPOINT;

  constructor(
    @Optional() private readonly langsmith?: LangSmithService,
  ) {
    if (process.env.NODE_ENV === "production") {
      const hasAzure = !!(this.azureKey && this.azureEndpoint);
      const hasOpenAI = !!this.apiKey;
      const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
      if (!hasAzure && !hasOpenAI && !hasAnthropic) {
        throw new Error(
          "LLMService: no provider configured in production. " +
            "Set AZURE_OPENAI_ENDPOINT+AZURE_OPENAI_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY.",
        );
      }
      this.logger.log(
        `LLM providers — azure:${hasAzure} openai:${hasOpenAI} anthropic:${hasAnthropic}`,
      );
    }
  }

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<LLMResponse> {
    // Last-resort default when neither caller nor env specifies a model.
    // DEFAULT_MODEL lets ops re-point all unspecified callers without code
    // changes (matches the env knob used by ExecutorService).
    const model = options?.model || process.env.DEFAULT_MODEL || "gpt-4o-mini";
    const plan = options?.plan || "TRIAL";
    const tokenLimit = TOKEN_LIMITS[plan] || TOKEN_LIMITS.TRIAL;
    const maxTokens = Math.min(options?.maxTokens || 4000, tokenLimit);
    const attribution: LlmAttribution = {
      parentRunId: options?.parentRunId,
      agent: options?.agent,
      node: options?.node,
      tags: options?.tags,
      metadata: options?.metadata,
      onRunStart: options?.onRunStart,
    };

    // Route Claude models to Anthropic API
    if (model.startsWith("claude-")) {
      if (process.env.ANTHROPIC_API_KEY) {
        return this.callAnthropic(messages, model, maxTokens, options?.tools, attribution);
      }
      // Fall back to GPT-4o if no Anthropic key
      return this.callOpenAIOrMock(
        messages,
        "gpt-4o",
        maxTokens,
        options?.tools,
        options?.toolChoice,
        attribution,
      );
    }

    return this.callOpenAIOrMock(
      messages,
      model,
      maxTokens,
      options?.tools,
      options?.toolChoice,
      attribution,
    );
  }

  private async callOpenAIOrMock(
    messages: ChatMessage[],
    model: string,
    maxTokens: number,
    tools?: OpenAIFunctionDef[],
    toolChoice?: string,
    attribution?: LlmAttribution,
  ): Promise<LLMResponse> {
    const azureDeployment = azureDeploymentFor(model);
    if (azureDeployment) {
      return this.callAzureOpenAI(
        messages,
        model,
        azureDeployment,
        maxTokens,
        tools,
        toolChoice,
        attribution,
      );
    }
    if (this.apiKey) {
      return this.callOpenAI(messages, model, maxTokens, tools, toolChoice, attribution);
    }
    if (process.env.NODE_ENV === "production") {
      // Constructor guard should have caught this, but defend-in-depth: refuse
      // to return mock data in prod — that's how fake emails get sent.
      throw new Error(
        `LLMService: no provider available for model "${model}" in production.`,
      );
    }
    return this.mockResponse(messages, model, maxTokens, tools);
  }

  private async wrapWithLangSmith<TResult>(
    input: {
      readonly name: string;
      readonly model: string;
      readonly inputs: unknown;
      readonly attribution?: LlmAttribution;
    },
    fn: () => Promise<TResult>,
  ): Promise<TResult> {
    if (!this.langsmith) return await fn();
    return this.langsmith.wrapLlm(
      {
        name: input.name,
        model: input.model,
        inputs: input.inputs,
        parentRunId: input.attribution?.parentRunId,
        agent: input.attribution?.agent,
        node: input.attribution?.node,
        tags: input.attribution?.tags,
        metadata: input.attribution?.metadata,
        onRunStart: input.attribution?.onRunStart,
      },
      fn,
    );
  }

  private async callAzureOpenAI(
    messages: ChatMessage[],
    model: string,
    deployment: string,
    maxTokens: number,
    tools?: OpenAIFunctionDef[],
    toolChoice?: string,
    attribution?: LlmAttribution,
  ): Promise<LLMResponse> {
    return this.wrapWithLangSmith(
      { name: "azure.chat", model, inputs: messages, attribution },
      async () => {
        const url = `${this.azureEndpoint!.replace(/\/$/, "")}/openai/deployments/${encodeURIComponent(
          deployment,
        )}/chat/completions?api-version=${AZURE_OPENAI_API_VERSION}`;

        const body: Record<string, unknown> = {
          messages,
          [maxTokensParamFor(deployment)]: maxTokens,
          temperature: 0.7,
        };
        if (tools && tools.length > 0) {
          body.tools = tools;
          body.tool_choice = toolChoice || "auto";
        }

        // Circuit-breaker only (no retry layer): the Azure deployment owns
        // its own throttle behavior, and LLM calls are expensive — duplicate
        // requests on a 429 risk double-billing if the upstream actually did
        // process the first request. The breaker still protects us from a
        // sustained outage.
        const response = await withCircuitBreaker("azure-openai", () =>
          fetchWithTimeout(
            url,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "api-key": this.azureKey!,
              },
              body: JSON.stringify(body),
            },
            LLM_TIMEOUT_MS,
          ),
        );

        if (!response.ok) {
          const text = await response.text().catch(() => "");
          throw new Error(`Azure OpenAI ${response.status}: ${text.slice(0, 200)}`);
        }

        const data = (await response.json()) as {
          choices: Array<{
            message: { content: string | null; tool_calls?: ToolCallMessage[] };
            finish_reason: string;
          }>;
          usage: { total_tokens: number };
        };

        const choice = data.choices[0];
        const tokensUsed = data.usage?.total_tokens || 0;
        const costPer1K = COST_PER_1K[model] || COST_PER_1K["gpt-4o-mini"];

        return {
          content: choice?.message?.content || "",
          tokensUsed,
          model,
          cost: (tokensUsed / 1000) * costPer1K,
          toolCalls: choice?.message?.tool_calls,
          finishReason: choice?.finish_reason,
        };
      },
    );
  }

  private async callOpenAI(
    messages: ChatMessage[],
    model: string,
    maxTokens: number,
    tools?: OpenAIFunctionDef[],
    toolChoice?: string,
    attribution?: LlmAttribution,
  ): Promise<LLMResponse> {
    try {
      return await this.wrapWithLangSmith(
        { name: "openai.chat", model, inputs: messages, attribution },
        async () => {
          const body: Record<string, unknown> = {
            model,
            messages,
            max_tokens: maxTokens,
            temperature: 0.7,
          };

          if (tools && tools.length > 0) {
            body.tools = tools;
            body.tool_choice = toolChoice || "auto";
          }

          // CB-only — see note in callAzureOpenAI.
          const response = await withCircuitBreaker("openai", () =>
            fetchWithTimeout(
              "https://api.openai.com/v1/chat/completions",
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${this.apiKey}`,
                },
                body: JSON.stringify(body),
              },
              LLM_TIMEOUT_MS,
            ),
          );

          if (!response.ok) {
            throw new Error(`OpenAI API error: ${response.status}`);
          }

          const data = (await response.json()) as {
            choices: Array<{
              message: { content: string | null; tool_calls?: ToolCallMessage[] };
              finish_reason: string;
            }>;
            usage: { total_tokens: number };
          };

          const choice = data.choices[0];
          const tokensUsed = data.usage?.total_tokens || 0;
          const costPer1K = COST_PER_1K[model] || COST_PER_1K["gpt-4o-mini"];

          return {
            content: choice?.message?.content || "",
            tokensUsed,
            model,
            cost: (tokensUsed / 1000) * costPer1K,
            toolCalls: choice?.message?.tool_calls,
            finishReason: choice?.finish_reason,
          };
        },
      );
    } catch (error) {
      throw error instanceof Error ? error : new Error("OpenAI API call failed");
    }
  }

  private async callAnthropic(
    messages: ChatMessage[],
    model: string,
    maxTokens: number,
    tools?: OpenAIFunctionDef[],
    attribution?: LlmAttribution,
  ): Promise<LLMResponse> {
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (!anthropicKey) return this.mockResponse(messages, model, maxTokens, tools);

    try {
      return await this.wrapWithLangSmith(
        { name: "anthropic.chat", model, inputs: messages, attribution },
        async () => {
          // Extract system message (Anthropic takes it as a top-level param)
          const systemMsg = messages.find((m) => m.role === "system")?.content || "";
          const nonSystemMessages = messages.filter((m) => m.role !== "system").map((m) => ({
            role: m.role === "tool" ? "user" : m.role,
            content: m.role === "tool"
              ? [{ type: "tool_result", tool_use_id: m.tool_call_id, content: m.content || "" }]
              : m.content || "",
          }));

          const body: Record<string, unknown> = {
            model,
            max_tokens: maxTokens,
            system: systemMsg,
            messages: nonSystemMessages,
          };

          if (tools && tools.length > 0) {
            body.tools = tools.map((t) => ({
              name: t.function.name,
              description: t.function.description,
              input_schema: t.function.parameters,
            }));
          }

          // CB-only — see note in callAzureOpenAI.
          const response = await withCircuitBreaker("anthropic", () =>
            fetchWithTimeout(
              "https://api.anthropic.com/v1/messages",
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "x-api-key": anthropicKey,
                  "anthropic-version": "2023-06-01",
                },
                body: JSON.stringify(body),
              },
              LLM_TIMEOUT_MS,
            ),
          );

          if (!response.ok) {
            throw new Error(`Anthropic API error: ${response.status}`);
          }

          const data = (await response.json()) as {
            content: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
            usage: { input_tokens: number; output_tokens: number };
            stop_reason: string;
          };

          const tokensUsed = (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0);
          const costPer1K = COST_PER_1K[model] || COST_PER_1K["claude-3-5-sonnet-20241022"];

          // Map tool_use blocks to OpenAI-style tool_calls
          const toolUseBlocks = data.content.filter((b) => b.type === "tool_use");
          const openAIToolCalls: ToolCallMessage[] = toolUseBlocks.map((b) => ({
            id: b.id || `call_${Date.now()}`,
            type: "function" as const,
            function: { name: b.name || "", arguments: JSON.stringify(b.input || {}) },
          }));

          const textBlock = data.content.find((b) => b.type === "text");

          return {
            content: textBlock?.text || "",
            tokensUsed,
            model,
            cost: (tokensUsed / 1000) * costPer1K,
            toolCalls: openAIToolCalls.length > 0 ? openAIToolCalls : undefined,
            finishReason: data.stop_reason,
          };
        },
      );
    } catch (error) {
      throw error instanceof Error ? error : new Error("Anthropic API call failed");
    }
  }

  private mockResponse(
    messages: ChatMessage[],
    model: string,
    maxTokens: number,
    tools?: OpenAIFunctionDef[],
  ): LLMResponse {
    const systemMessage = messages.find((m) => m.role === "system")?.content || "";
    const userMessage = messages.find((m) => m.role === "user")?.content || "";
    const lastMessage = messages[messages.length - 1];
    const mockTokens = Math.min(Math.floor(Math.random() * 500) + 100, maxTokens);

    // If tools are available, simulate multi-step tool calling
    if (tools && tools.length > 0) {
      // Count how many tool results we've received so far
      const toolResultCount = messages.filter((m) => m.role === "tool").length;
      const toolCallCount = messages.filter((m) => m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0).length;

      // Get the planned tool sequence for this agent type
      const sequence = this.getToolSequence(systemMessage, tools);

      // If we haven't exhausted the sequence, make the next tool call
      if (toolCallCount < sequence.length) {
        const next = sequence[toolCallCount];
        return {
          content: "",
          tokensUsed: mockTokens,
          model: `${model}-mock`,
          cost: (mockTokens / 1000) * (COST_PER_1K[model] || 0.00015),
          toolCalls: [{ id: `call_${Date.now()}_${toolCallCount + 1}`, type: "function" as const, function: { name: next.name, arguments: JSON.stringify(next.args) } }],
          finishReason: "tool_calls",
        };
      }
    }

    // All tool calls done (or no tools) — generate final response
    const content = this.generateMockContent(systemMessage, userMessage);

    return {
      content,
      tokensUsed: mockTokens,
      model: `${model}-mock`,
      cost: (mockTokens / 1000) * (COST_PER_1K[model] || 0.00015),
      finishReason: "stop",
    };
  }

  private getToolSequence(systemMessage: string, tools: OpenAIFunctionDef[]): Array<{ name: string; args: Record<string, unknown> }> {
    const sysLower = systemMessage.toLowerCase();
    const hasTool = (name: string) => tools.some((t) => t.function.name === name);
    const seq: Array<{ name: string; args: Record<string, unknown> }> = [];

    if (sysLower.includes("sdr") || sysLower.includes("sales")) {
      if (hasTool("web_search")) seq.push({ name: "web_search", args: { query: "Acme Corp SaaS company overview funding", max_results: 3 } });
      if (hasTool("company_research")) seq.push({ name: "company_research", args: { company_name: "Acme Corp", domain: "acme.com" } });
      if (hasTool("lead_score")) seq.push({ name: "lead_score", args: { lead: { company: "Acme Corp", industry: "SaaS", size: "200", title: "CTO" }, icp: { industry: "SaaS", min_size: 50, max_size: 1000 } } });
      if (hasTool("send_email")) seq.push({ name: "send_email", args: { to: "cto@acme.com", subject: "Quick question about Acme's growth", body: "Hi Alex,\n\nI noticed Acme Corp just closed your Series B — congrats. We help SaaS teams like yours automate outbound with AI agents that research, personalize, and send at scale.\n\nWorth a 15-min call this week?\n\nBest,\nYour AI SDR" } });
      if (hasTool("hubspot")) seq.push({ name: "hubspot", args: { action: "create_contact", data: { email: "cto@acme.com", firstname: "Alex", lastname: "Chen", company: "Acme Corp", jobtitle: "CTO" } } });
    } else if (sysLower.includes("content") || sysLower.includes("writer")) {
      if (hasTool("web_search")) seq.push({ name: "web_search", args: { query: "trending B2B SaaS content topics 2026", max_results: 5 } });
      if (hasTool("web_scrape")) seq.push({ name: "web_scrape", args: { url: "https://example.com/trending-b2b-topics" } });
    } else if (sysLower.includes("inbox") || sysLower.includes("email triage")) {
      if (hasTool("send_email")) seq.push({ name: "send_email", args: { action: "read_inbox", limit: 20 } });
    } else if (sysLower.includes("report")) {
      if (hasTool("hubspot")) seq.push({ name: "hubspot", args: { action: "search_contacts", data: { limit: 50 } } });
      if (hasTool("web_search")) seq.push({ name: "web_search", args: { query: "B2B SaaS benchmarks response rate 2026", max_results: 3 } });
    } else if (sysLower.includes("crm") || sysLower.includes("sync")) {
      if (hasTool("hubspot")) seq.push({ name: "hubspot", args: { action: "search_contacts", data: { recently_modified: true } } });
      if (hasTool("hubspot")) seq.push({ name: "hubspot", args: { action: "update_contact", data: { email: "john@example.com", properties: { last_synced: new Date().toISOString() } } } });
    } else if (sysLower.includes("social") || sysLower.includes("engagement")) {
      if (hasTool("web_search")) seq.push({ name: "web_search", args: { query: "LinkedIn B2B AI discussions today", max_results: 5 } });
    }

    // Fallback: if no sequence matched, call first available tool
    if (seq.length === 0 && tools.length > 0) {
      seq.push({ name: tools[0].function.name, args: {} });
    }

    return seq;
  }

  private generateMockContent(systemMessage: string, userMessage: string): string {
    if (systemMessage.includes("SDR") || systemMessage.includes("sales")) {
      return JSON.stringify({
        type: "email_draft",
        to: "prospect@example.com",
        subject: "Quick question about your growth strategy",
        body: `Hi there,\n\nI noticed your company has been scaling rapidly in the ${userMessage.includes("SaaS") ? "SaaS" : "tech"} space. We help teams like yours automate outbound sales with AI-powered agents.\n\nWould you be open to a 15-minute call this week to explore how we could help?\n\nBest regards,\nYour AI SDR Agent`,
        leadScore: 72,
        companyResearch: { industry: "SaaS", size: "100-500", recentNews: ["Series B funding announced"] },
      });
    } else if (systemMessage.includes("content") || systemMessage.includes("writer")) {
      return JSON.stringify({
        type: "content",
        platform: "LinkedIn",
        title: "5 Ways AI is Transforming B2B Sales in 2026",
        body: "The B2B sales landscape is evolving faster than ever. Here are 5 key trends:\n\n1. AI-powered lead scoring is replacing gut feelings\n2. Automated outreach is becoming hyper-personalized\n3. CRM data enrichment happens in real-time\n4. Sales forecasting accuracy has jumped 40%\n5. Follow-up cadences are now AI-optimized\n\nThe companies adopting these tools are seeing 3x pipeline growth.\n\nWhat trends are you seeing?",
        hashtags: ["#AI", "#B2BSales", "#SalesTech", "#Automation"],
      });
    } else if (systemMessage.includes("inbox") || systemMessage.includes("email triage")) {
      return JSON.stringify({
        type: "email_triage",
        emails: [
          { id: "e1", category: "urgent", priority: 1, suggestedReply: "This needs immediate attention. I'll review and respond within the hour." },
          { id: "e2", category: "follow-up", priority: 2, suggestedReply: "Thank you for following up. Let me check on this and get back to you by EOD." },
          { id: "e3", category: "newsletter", priority: 4, suggestedReply: null },
        ],
      });
    } else if (systemMessage.includes("CRM") || systemMessage.includes("sync")) {
      return JSON.stringify({
        type: "crm_sync",
        synced: { contacts: 12, deals: 5, companies: 3 },
        updates: [
          { entity: "contact", action: "updated", name: "John Doe", field: "email", newValue: "john.doe@newco.com" },
          { entity: "deal", action: "created", name: "Enterprise License", value: 45000 },
        ],
      });
    } else if (systemMessage.includes("social") || systemMessage.includes("engagement")) {
      return JSON.stringify({
        type: "social_engagement",
        monitored: 15,
        engaged: 4,
        actions: [
          { platform: "LinkedIn", action: "comment", post: "AI in sales discussion", response: "Great insights! We've seen similar results..." },
          { platform: "Twitter", action: "like", post: "B2B automation thread" },
        ],
      });
    } else if (systemMessage.includes("report")) {
      return JSON.stringify({
        type: "report",
        reportType: "weekly",
        period: "Last 7 days",
        metrics: { emailsSent: 142, responseRate: "23%", meetingsBooked: 8, pipelineValue: "$127,500", topLeads: ["Acme Corp", "TechStartup Inc", "GlobalScale Ltd"] },
        summary: "Strong week with 23% response rate on outbound emails. 8 meetings booked, representing $127,500 in pipeline. Acme Corp showing highest engagement.",
      });
    }
    return JSON.stringify({
      type: "generic",
      message: "Agent task completed successfully.",
      details: `Processed request based on: ${userMessage.slice(0, 100)}`,
    });
  }

  getTokenLimit(plan: string): number {
    return TOKEN_LIMITS[plan] || TOKEN_LIMITS.TRIAL;
  }

  /**
   * Generate an embedding vector for a piece of text. Used by MemoryService
   * for semantic retrieval. Returns null when no embedding provider is
   * configured (dev/test without keys); callers must handle null gracefully.
   *
   * Provider order: Azure OpenAI (if AZURE_OPENAI_EMBEDDING_DEPLOYMENT is set)
   * → OpenAI public API → null.
   */
  async embed(text: string): Promise<number[] | null> {
    const trimmed = text.trim().slice(0, 8000);
    if (!trimmed) return null;

    const azureDeployment = process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT;
    if (this.azureEndpoint && this.azureKey && azureDeployment) {
      const url = `${this.azureEndpoint.replace(/\/$/, "")}/openai/deployments/${azureDeployment}/embeddings?api-version=${AZURE_OPENAI_API_VERSION}`;
      const azureKey = this.azureKey; // capture for closure (TS narrowing)
      const response = await withCircuitBreaker("azure-openai-embed", () =>
        fetchWithTimeout(
          url,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", "api-key": azureKey },
            body: JSON.stringify({ input: trimmed }),
          },
          LLM_TIMEOUT_MS,
        ),
      );
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Azure embedding failed: ${response.status} ${body}`);
      }
      const data = (await response.json()) as { data: { embedding: number[] }[] };
      return data.data[0]?.embedding ?? null;
    }

    if (this.apiKey) {
      const response = await withCircuitBreaker("openai-embed", () =>
        fetchWithTimeout(
          "https://api.openai.com/v1/embeddings",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify({ model: "text-embedding-3-large", input: trimmed }),
          },
          LLM_TIMEOUT_MS,
        ),
      );
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`OpenAI embedding failed: ${response.status} ${body}`);
      }
      const data = (await response.json()) as { data: { embedding: number[] }[] };
      return data.data[0]?.embedding ?? null;
    }

    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "LLMService.embed: no embedding provider configured. " +
          "Set AZURE_OPENAI_EMBEDDING_DEPLOYMENT or OPENAI_API_KEY.",
      );
    }

    this.logger.warn("embed() called without an embedding provider — returning null (dev only)");
    return null;
  }
}
