import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { LLMService, ChatMessage } from "./llm.service";
import { getPromptForTemplate } from "./prompts";
import { ToolRegistry } from "./tools/registry";
import { ToolContext, toolToOpenAIFunction, IntegrationCredentials } from "./tools/tool.interface";
import { MemoryService } from "./memory.service";
import { IntegrationsService } from "../integrations/integrations.service";

const MAX_STEPS = 10;

interface ExecutionResult {
  output: Record<string, unknown>;
  tokensUsed: number;
  cost: number;
  model: string;
  duration: number;
  steps: StepLog[];
}

interface StepLog {
  step: number;
  type: "planning" | "tool_call" | "tool_result" | "final_answer";
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: unknown;
  content?: string;
  timestamp: number;
}

@Injectable()
export class ExecutorService {
  private toolRegistry: ToolRegistry;

  constructor(
    private prisma: PrismaService,
    private llm: LLMService,
    private memoryService: MemoryService,
    private integrationsService: IntegrationsService,
  ) {
    this.toolRegistry = new ToolRegistry(memoryService);
  }

  async executeAgent(agentId: string, runId: string): Promise<ExecutionResult> {
    const startTime = Date.now();

    // Load agent with template and org
    const agent = await this.prisma.agent.findUnique({
      where: { id: agentId },
      include: { template: true, org: true },
    });

    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    await this.addLog(runId, "INFO", `Starting execution for agent: ${agent.name}`);

    // Load integration credentials for tool context
    const integrations = await this.loadIntegrations(agent.orgId);

    // Build tool context
    const toolContext: ToolContext = {
      orgId: agent.orgId,
      agentId: agent.id,
      runId,
      integrations,
    };

    // Get tools for this agent template
    const tools = this.toolRegistry.getForTemplate(agent.template.name);
    const openAITools = tools.map(toolToOpenAIFunction);

    await this.addLog(runId, "INFO", `Loaded ${tools.length} tools: ${tools.map((t) => t.name).join(", ")}`);

    // Load agent memories
    const memories = await this.memoryService.getAll(agent.id);
    const memoryContext = this.buildMemoryContext(memories);

    await this.addLog(runId, "DEBUG", `Loaded ${Object.keys(memories).length} memory entries`);

    // Build system prompt with tool awareness and memory
    const basePrompt = getPromptForTemplate(agent.template.name, agent.config as Record<string, unknown>);
    const systemPrompt = this.buildToolAwarePrompt(basePrompt, tools) + memoryContext;

    // Build user message
    const userMessage = this.buildUserMessage(agent.template.name, agent.config as Record<string, unknown>);

    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ];

    // Determine model
    const isComplex = this.isComplexTask(agent.template.name);
    const model = isComplex ? "gpt-4o" : "gpt-4o-mini";
    const plan = agent.org.plan;

    await this.addLog(runId, "INFO", `Using model: ${model}, plan: ${plan}`);

    // Multi-step agent loop
    let totalTokens = 0;
    let totalCost = 0;
    const steps: StepLog[] = [];
    let stepNum = 0;

    for (let i = 0; i < MAX_STEPS; i++) {
      stepNum = i + 1;

      const response = await this.llm.chat(messages, {
        model,
        plan,
        maxTokens: 4000,
        tools: openAITools.length > 0 ? openAITools : undefined,
      });

      totalTokens += response.tokensUsed;
      totalCost += response.cost;

      // Check for tool calls
      if (response.toolCalls && response.toolCalls.length > 0) {
        // Add assistant message with tool calls
        messages.push({
          role: "assistant",
          content: response.content || null,
          tool_calls: response.toolCalls,
        });

        // Execute each tool call
        for (const toolCall of response.toolCalls) {
          const toolName = toolCall.function.name;
          let toolArgs: Record<string, unknown>;
          try {
            toolArgs = JSON.parse(toolCall.function.arguments);
          } catch {
            toolArgs = {};
          }

          await this.addLog(runId, "INFO", `Step ${stepNum}: Tool call -> ${toolName}(${JSON.stringify(toolArgs).slice(0, 200)})`);

          steps.push({
            step: stepNum,
            type: "tool_call",
            toolName,
            toolInput: toolArgs,
            timestamp: Date.now(),
          });

          const tool = this.toolRegistry.get(toolName);
          let toolResult: unknown;

          if (tool) {
            try {
              const result = await tool.execute(toolArgs, toolContext);
              toolResult = result;
              await this.addLog(runId, "DEBUG", `${toolName} returned: success=${result.success}`);
            } catch (error) {
              toolResult = { success: false, error: error instanceof Error ? error.message : "Tool execution failed" };
              await this.addLog(runId, "WARN", `${toolName} failed: ${error instanceof Error ? error.message : "unknown error"}`);
            }
          } else {
            toolResult = { success: false, error: `Unknown tool: ${toolName}` };
            await this.addLog(runId, "WARN", `Unknown tool: ${toolName}`);
          }

          steps.push({
            step: stepNum,
            type: "tool_result",
            toolName,
            toolOutput: toolResult,
            timestamp: Date.now(),
          });

          // Add tool result message
          messages.push({
            role: "tool",
            content: JSON.stringify(toolResult),
            tool_call_id: toolCall.id,
          });
        }

        continue; // Next iteration to get LLM's response to tool results
      }

      // No tool calls = final answer
      await this.addLog(runId, "INFO", `Step ${stepNum}: Final answer generated`);

      steps.push({
        step: stepNum,
        type: "final_answer",
        content: response.content,
        timestamp: Date.now(),
      });

      break;
    }

    // Parse final output from the last response
    const lastStep = steps[steps.length - 1];
    let output: Record<string, unknown>;

    try {
      output = JSON.parse(lastStep?.content || "{}");
      await this.addLog(runId, "DEBUG", `Output parsed: type=${output.type || "unknown"}`);
    } catch {
      output = { type: "raw", content: lastStep?.content || "" };
      await this.addLog(runId, "WARN", "Could not parse structured output, storing raw");
    }

    // Add step metadata to output
    output._meta = {
      steps: steps.length,
      toolCalls: steps.filter((s) => s.type === "tool_call").length,
      toolsUsed: [...new Set(steps.filter((s) => s.type === "tool_call").map((s) => s.toolName))],
    };

    // Save post-run memory
    await this.savePostRunMemory(agent.id, output, steps, runId);

    const duration = Date.now() - startTime;
    await this.addLog(runId, "INFO", `Execution completed: ${stepNum} steps, ${totalTokens} tokens, ${(duration / 1000).toFixed(1)}s`);

    return {
      output,
      tokensUsed: totalTokens,
      cost: totalCost,
      model,
      duration,
      steps,
    };
  }

  private buildToolAwarePrompt(basePrompt: string, tools: { name: string; description: string }[]): string {
    if (tools.length === 0) return basePrompt;

    const toolDescriptions = tools
      .map((t) => `- ${t.name}: ${t.description}`)
      .join("\n");

    return `${basePrompt}

## Available Tools
You have access to the following tools. Use them to research, take actions, and produce better results:
${toolDescriptions}

## Execution Strategy
1. ALWAYS use available tools to gather real data before generating output
2. Call tools one at a time or in batches as needed
3. Use tool results to inform your final structured JSON output
4. If a tool fails, note the failure and proceed with available information`;
  }

  private async loadIntegrations(orgId: string): Promise<Map<string, IntegrationCredentials>> {
    const integrations = new Map<string, IntegrationCredentials>();

    try {
      const records = await this.prisma.integration.findMany({
        where: { orgId, status: "CONNECTED" },
      });

      for (const record of records) {
        try {
          // Use IntegrationsService for token refresh
          const decrypted = await this.integrationsService.refreshTokenIfNeeded(orgId, record.provider);
          if (!decrypted) continue;

          integrations.set(record.provider, {
            provider: record.provider,
            accessToken: (decrypted.access_token as string) || "",
            refreshToken: decrypted.refresh_token as string | undefined,
            expiresAt: decrypted.expires_at as number | undefined,
            scopes: decrypted.scope as string | undefined,
          });
        } catch {
          // Skip integration with bad credentials
        }
      }
    } catch {
      // No integrations available
    }

    return integrations;
  }

  private buildUserMessage(templateName: string, config: Record<string, unknown>): string {
    const configSummary = Object.entries(config)
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
      .join("\n");

    switch (templateName.toLowerCase()) {
      case "sdr agent":
        return `Execute outbound sales task with these parameters:\n${configSummary}\n\nResearch the target, score the lead, and generate a personalized prospecting email.`;
      case "crm sync agent":
        return `Perform CRM synchronization with these settings:\n${configSummary}\n\nSync and report on changes.`;
      case "content writer":
        return `Create content with these parameters:\n${configSummary}\n\nResearch trending topics and generate engaging content for the target platform.`;
      case "social engagement agent":
        return `Monitor and engage on social media with:\n${configSummary}\n\nReport on engagement opportunities.`;
      case "inbox monitor":
        return `Triage emails with these rules:\n${configSummary}\n\nClassify and prioritize incoming messages, draft replies for urgent items.`;
      case "reporting agent":
        return `Generate a report with these metrics:\n${configSummary}\n\nGather data, analyze metrics, and create a comprehensive summary report.`;
      default:
        return `Execute task with configuration:\n${configSummary}`;
    }
  }

  private isComplexTask(templateName: string): boolean {
    const complexTemplates = ["reporting agent", "crm sync agent", "sdr agent"];
    return complexTemplates.includes(templateName.toLowerCase());
  }

  private buildMemoryContext(memories: Record<string, unknown>): string {
    if (Object.keys(memories).length === 0) return "";

    const lines: string[] = ["\n\n## Your Memory (from previous runs)"];

    if (memories.last_run_summary) {
      lines.push(`Last run: ${memories.last_run_summary}`);
    }

    if (Array.isArray(memories.contacted_leads) && memories.contacted_leads.length > 0) {
      const leads = memories.contacted_leads as string[];
      lines.push(`Contacted leads (${leads.length}): ${leads.slice(-10).join(", ")}`);
    }

    // Include other memory keys
    for (const [key, value] of Object.entries(memories)) {
      if (key === "last_run_summary" || key === "contacted_leads") continue;
      const valueStr = typeof value === "string" ? value : JSON.stringify(value);
      lines.push(`${key}: ${valueStr.slice(0, 200)}`);
    }

    lines.push("\nUse the memory tool to update your memories as you work. Avoid contacting leads you've already reached out to.");

    return lines.join("\n");
  }

  private async savePostRunMemory(agentId: string, output: Record<string, unknown>, steps: StepLog[], runId: string): Promise<void> {
    try {
      // Save run summary
      const toolsUsed = [...new Set(steps.filter((s) => s.type === "tool_call").map((s) => s.toolName))];
      const summary = `Completed ${steps.length} steps using ${toolsUsed.join(", ") || "no tools"}. Output type: ${output.type || "unknown"}.`;
      await this.memoryService.setLastRunSummary(agentId, summary);

      // If output has a "to" field (email), track as contacted lead
      if (output.to && typeof output.to === "string" && output.to.includes("@")) {
        await this.memoryService.addContactedLead(agentId, output.to as string);
      }
    } catch (error) {
      // Memory save failures should not break the run
    }
  }

  private async addLog(runId: string, level: "DEBUG" | "INFO" | "WARN" | "ERROR", message: string, metadata?: Record<string, unknown>) {
    return this.prisma.agentLog.create({
      data: { runId, level, message, metadata: (metadata || undefined) as any },
    });
  }
}
