import { Injectable } from "@nestjs/common";
import { OpenAIFunctionDef } from "./tools/tool.interface";

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
};

export interface ChatOptions {
  model?: string;
  maxTokens?: number;
  plan?: string;
  tools?: OpenAIFunctionDef[];
  toolChoice?: "auto" | "none" | "required";
}

@Injectable()
export class LLMService {
  private apiKey = process.env.OPENAI_API_KEY;

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<LLMResponse> {
    const model = options?.model || "gpt-4o-mini";
    const plan = options?.plan || "TRIAL";
    const tokenLimit = TOKEN_LIMITS[plan] || TOKEN_LIMITS.TRIAL;
    const maxTokens = Math.min(options?.maxTokens || 4000, tokenLimit);

    if (this.apiKey) {
      return this.callOpenAI(messages, model, maxTokens, options?.tools, options?.toolChoice);
    }

    return this.mockResponse(messages, model, maxTokens, options?.tools);
  }

  private async callOpenAI(
    messages: ChatMessage[],
    model: string,
    maxTokens: number,
    tools?: OpenAIFunctionDef[],
    toolChoice?: string,
  ): Promise<LLMResponse> {
    try {
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

      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      });

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
    } catch (error) {
      return this.mockResponse(messages, model, maxTokens, tools);
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

    // If tools are available and this is not a tool result, simulate tool calls
    if (tools && tools.length > 0 && lastMessage?.role !== "tool") {
      return this.mockToolCallResponse(tools, systemMessage, userMessage, model, mockTokens);
    }

    // After tool results, generate final response
    const content = this.generateMockContent(systemMessage, userMessage);

    return {
      content,
      tokensUsed: mockTokens,
      model: `${model}-mock`,
      cost: (mockTokens / 1000) * (COST_PER_1K[model] || 0.00015),
      finishReason: "stop",
    };
  }

  private mockToolCallResponse(
    tools: OpenAIFunctionDef[],
    systemMessage: string,
    _userMessage: string,
    model: string,
    mockTokens: number,
  ): LLMResponse {
    const sysLower = systemMessage.toLowerCase();
    const toolCalls: ToolCallMessage[] = [];
    const hasTool = (name: string) => tools.some((t) => t.function.name === name);

    if (sysLower.includes("sdr") || sysLower.includes("sales")) {
      if (hasTool("web_search")) {
        toolCalls.push({ id: `call_${Date.now()}_1`, type: "function", function: { name: "web_search", arguments: JSON.stringify({ query: "target company SaaS overview", max_results: 3 }) } });
      }
    } else if (sysLower.includes("content") || sysLower.includes("writer")) {
      if (hasTool("web_search")) {
        toolCalls.push({ id: `call_${Date.now()}_1`, type: "function", function: { name: "web_search", arguments: JSON.stringify({ query: "trending B2B content topics 2026", max_results: 3 }) } });
      }
    } else if (sysLower.includes("report")) {
      if (hasTool("hubspot")) {
        toolCalls.push({ id: `call_${Date.now()}_1`, type: "function", function: { name: "hubspot", arguments: JSON.stringify({ action: "search_contacts", data: { company: "all" } }) } });
      }
    } else if (tools.length > 0) {
      toolCalls.push({ id: `call_${Date.now()}_1`, type: "function", function: { name: tools[0].function.name, arguments: JSON.stringify({}) } });
    }

    if (toolCalls.length === 0) {
      return {
        content: this.generateMockContent(systemMessage, _userMessage),
        tokensUsed: mockTokens,
        model: `${model}-mock`,
        cost: (mockTokens / 1000) * (COST_PER_1K[model] || 0.00015),
        finishReason: "stop",
      };
    }

    return {
      content: "",
      tokensUsed: mockTokens,
      model: `${model}-mock`,
      cost: (mockTokens / 1000) * (COST_PER_1K[model] || 0.00015),
      toolCalls,
      finishReason: "tool_calls",
    };
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
}
