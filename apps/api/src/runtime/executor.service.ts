import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { LLMService, ChatMessage } from "./llm.service";
import { getPromptForTemplate } from "./prompts";

interface ExecutionResult {
  output: Record<string, unknown>;
  tokensUsed: number;
  cost: number;
  model: string;
  duration: number;
}

@Injectable()
export class ExecutorService {
  constructor(
    private prisma: PrismaService,
    private llm: LLMService,
  ) {}

  async executeAgent(agentId: string, runId: string): Promise<ExecutionResult> {
    const startTime = Date.now();

    // Load agent with template
    const agent = await this.prisma.agent.findUnique({
      where: { id: agentId },
      include: { template: true, org: true },
    });

    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    // Log start
    await this.addLog(runId, "INFO", `Starting execution for agent: ${agent.name}`);

    // Build system prompt from template
    const systemPrompt = getPromptForTemplate(agent.template.name, agent.config as Record<string, unknown>);

    await this.addLog(runId, "DEBUG", `System prompt loaded for template: ${agent.template.name}`);

    // Build user message with context
    const userMessage = this.buildUserMessage(agent.template.name, agent.config as Record<string, unknown>);

    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ];

    // Determine model based on complexity
    const isComplex = this.isComplexTask(agent.template.name);
    const model = isComplex ? "gpt-4o" : "gpt-4o-mini";

    await this.addLog(runId, "INFO", `Using model: ${model} (complex: ${isComplex})`);

    // Execute LLM call
    const plan = agent.org.plan;
    const response = await this.llm.chat(messages, { model, plan });

    await this.addLog(runId, "INFO", `LLM response received: ${response.tokensUsed} tokens used`);

    // Parse structured output
    let output: Record<string, unknown>;
    try {
      output = JSON.parse(response.content);
      await this.addLog(runId, "DEBUG", `Output parsed successfully: type=${(output as Record<string, unknown>).type || "unknown"}`);
    } catch {
      output = { type: "raw", content: response.content };
      await this.addLog(runId, "WARN", "Could not parse structured output, storing raw");
    }

    const duration = Date.now() - startTime;

    await this.addLog(runId, "INFO", `Execution completed in ${duration}ms`);

    return {
      output,
      tokensUsed: response.tokensUsed,
      cost: response.cost,
      model: response.model,
      duration,
    };
  }

  private buildUserMessage(templateName: string, config: Record<string, unknown>): string {
    const configSummary = Object.entries(config)
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
      .join("\n");

    switch (templateName.toLowerCase()) {
      case "sdr agent":
        return `Execute outbound sales task with these parameters:\n${configSummary}\n\nGenerate a prospecting email draft based on the ICP criteria.`;
      case "crm sync agent":
        return `Perform CRM synchronization with these settings:\n${configSummary}\n\nSync and report on changes.`;
      case "content writer":
        return `Create content with these parameters:\n${configSummary}\n\nGenerate a piece of content for the target platform.`;
      case "social engagement agent":
        return `Monitor and engage on social media with:\n${configSummary}\n\nReport on engagement opportunities.`;
      case "inbox monitor":
        return `Triage emails with these rules:\n${configSummary}\n\nClassify and prioritize incoming messages.`;
      case "reporting agent":
        return `Generate a report with these metrics:\n${configSummary}\n\nCreate a summary report.`;
      default:
        return `Execute task with configuration:\n${configSummary}`;
    }
  }

  private isComplexTask(templateName: string): boolean {
    const complexTemplates = ["reporting agent", "crm sync agent"];
    return complexTemplates.includes(templateName.toLowerCase());
  }

  private async addLog(runId: string, level: "DEBUG" | "INFO" | "WARN" | "ERROR", message: string) {
    return this.prisma.agentLog.create({
      data: { runId, level, message },
    });
  }
}
