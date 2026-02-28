import { Injectable } from "@nestjs/common";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMResponse {
  content: string;
  tokensUsed: number;
  model: string;
  cost: number;
}

const TOKEN_LIMITS: Record<string, number> = {
  TRIAL: 5000,
  STARTER: 10000,
  GROWTH: 50000,
  ENTERPRISE: Infinity,
};

// Cost per 1K tokens (approximation)
const COST_PER_1K: Record<string, number> = {
  "gpt-4o-mini": 0.00015,
  "gpt-4o": 0.005,
};

@Injectable()
export class LLMService {
  private apiKey = process.env.OPENAI_API_KEY;

  async chat(messages: ChatMessage[], options?: { model?: string; maxTokens?: number; plan?: string }): Promise<LLMResponse> {
    const model = options?.model || "gpt-4o-mini";
    const plan = options?.plan || "TRIAL";
    const tokenLimit = TOKEN_LIMITS[plan] || TOKEN_LIMITS.TRIAL;
    const maxTokens = Math.min(options?.maxTokens || 2000, tokenLimit);

    if (this.apiKey) {
      return this.callOpenAI(messages, model, maxTokens);
    }

    return this.mockResponse(messages, model, maxTokens);
  }

  private async callOpenAI(messages: ChatMessage[], model: string, maxTokens: number): Promise<LLMResponse> {
    try {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: maxTokens,
          temperature: 0.7,
        }),
      });

      if (!response.ok) {
        throw new Error(`OpenAI API error: ${response.status}`);
      }

      const data = await response.json() as {
        choices: Array<{ message: { content: string } }>;
        usage: { total_tokens: number };
      };

      const tokensUsed = data.usage?.total_tokens || 0;
      const costPer1K = COST_PER_1K[model] || COST_PER_1K["gpt-4o-mini"];

      return {
        content: data.choices[0]?.message?.content || "",
        tokensUsed,
        model,
        cost: (tokensUsed / 1000) * costPer1K,
      };
    } catch (error) {
      // Fallback to mock on API error
      return this.mockResponse(messages, model, maxTokens);
    }
  }

  private mockResponse(messages: ChatMessage[], model: string, maxTokens: number): LLMResponse {
    const systemMessage = messages.find((m) => m.role === "system")?.content || "";
    const userMessage = messages.find((m) => m.role === "user")?.content || "";
    const mockTokens = Math.min(Math.floor(Math.random() * 500) + 100, maxTokens);

    let content: string;

    if (systemMessage.includes("SDR") || systemMessage.includes("sales")) {
      content = JSON.stringify({
        type: "email_draft",
        to: "prospect@example.com",
        subject: "Quick question about your growth strategy",
        body: `Hi there,\n\nI noticed your company has been scaling rapidly in the ${userMessage.includes("SaaS") ? "SaaS" : "tech"} space. We help teams like yours automate outbound sales with AI-powered agents.\n\nWould you be open to a 15-minute call this week to explore how we could help?\n\nBest regards,\nYour AI SDR Agent`,
        leadScore: 72,
      });
    } else if (systemMessage.includes("content") || systemMessage.includes("writer")) {
      content = JSON.stringify({
        type: "content",
        platform: "LinkedIn",
        title: "5 Ways AI is Transforming B2B Sales in 2026",
        body: "The B2B sales landscape is evolving faster than ever. Here are 5 key trends:\n\n1. AI-powered lead scoring is replacing gut feelings\n2. Automated outreach is becoming hyper-personalized\n3. CRM data enrichment happens in real-time\n4. Sales forecasting accuracy has jumped 40%\n5. Follow-up cadences are now AI-optimized\n\nThe companies adopting these tools are seeing 3x pipeline growth.\n\nWhat trends are you seeing?",
        hashtags: ["#AI", "#B2BSales", "#SalesTech", "#Automation"],
      });
    } else if (systemMessage.includes("inbox") || systemMessage.includes("email triage")) {
      content = JSON.stringify({
        type: "email_triage",
        emails: [
          { id: "e1", category: "urgent", priority: 1, suggestedReply: "This needs immediate attention. I'll review and respond within the hour." },
          { id: "e2", category: "follow-up", priority: 2, suggestedReply: "Thank you for following up. Let me check on this and get back to you by EOD." },
          { id: "e3", category: "newsletter", priority: 4, suggestedReply: null },
        ],
      });
    } else if (systemMessage.includes("CRM") || systemMessage.includes("sync")) {
      content = JSON.stringify({
        type: "crm_sync",
        synced: { contacts: 12, deals: 5, companies: 3 },
        updates: [
          { entity: "contact", action: "updated", name: "John Doe", field: "email", newValue: "john.doe@newco.com" },
          { entity: "deal", action: "created", name: "Enterprise License", value: 45000 },
        ],
      });
    } else if (systemMessage.includes("social") || systemMessage.includes("engagement")) {
      content = JSON.stringify({
        type: "social_engagement",
        monitored: 15,
        engaged: 4,
        actions: [
          { platform: "LinkedIn", action: "comment", post: "AI in sales discussion", response: "Great insights! We've seen similar results..." },
          { platform: "Twitter", action: "like", post: "B2B automation thread" },
        ],
      });
    } else if (systemMessage.includes("report")) {
      content = JSON.stringify({
        type: "report",
        reportType: "weekly",
        period: "Last 7 days",
        metrics: {
          emailsSent: 142,
          responseRate: "23%",
          meetingsBooked: 8,
          pipelineValue: "$127,500",
          topLeads: ["Acme Corp", "TechStartup Inc", "GlobalScale Ltd"],
        },
        summary: "Strong week with 23% response rate on outbound emails. 8 meetings booked, representing $127,500 in pipeline. Acme Corp showing highest engagement.",
      });
    } else {
      content = JSON.stringify({
        type: "generic",
        message: "Agent task completed successfully.",
        details: `Processed request based on: ${userMessage.slice(0, 100)}`,
      });
    }

    return {
      content,
      tokensUsed: mockTokens,
      model: `${model}-mock`,
      cost: (mockTokens / 1000) * (COST_PER_1K[model] || 0.00015),
    };
  }

  getTokenLimit(plan: string): number {
    return TOKEN_LIMITS[plan] || TOKEN_LIMITS.TRIAL;
  }
}
