import { BadRequestException, Injectable, Optional } from "@nestjs/common";
import * as crypto from "crypto";
import { OutreachArtifactStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { LLMService, ChatMessage } from "./llm.service";
import { LlmBudgetService } from "./llm-budget.service";
import { getPromptForTemplate } from "./prompts";
import { ToolRegistry } from "./tools/registry";
import { ToolContext, toolToOpenAIFunction, IntegrationCredentials } from "./tools/tool.interface";
import {
  SideEffectPolicy,
  type ApprovalEnvelope as PolicyApprovalEnvelope,
  type PolicyDecision,
} from "./tools/side-effect";
import {
  APPROVAL_PREVIEW_MAX,
  type PendingApprovalEnvelope,
} from "./approval-envelope.types";
import { MemoryService } from "./memory.service";
import { IntegrationsService } from "../integrations/integrations.service";
import { OutreachArtifactsService } from "../outreach/outreach-artifacts.service";
import { EvidenceLedgerService } from "../observability/evidence-ledger.service";
import { LinkedInService } from "../integrations/linkedin/linkedin.service";
import { ConfigService } from "@nestjs/config";
import { EnrichmentFactService } from "../enrichment/enrichment-fact.service";

export type { PendingApprovalEnvelope } from "./approval-envelope.types";

/**
 * Per-process default: when set to "dry_run", external_write tools that
 * support dry-run get a synthetic artifact result instead of executing. Any
 * other value (including unset) treats external_write as policy-blocked
 * unless an explicit ApprovalEnvelope is provided.
 *
 * For Phase 2.5 the default is dry_run on every container — autonomous
 * external sending is not yet enabled.
 */
function getOutreachExecutionMode(): "dry_run" | "agent_run" | "external_send" {
  const v = process.env.OUTREACH_EXECUTION_MODE;
  if (v === "agent_run" || v === "external_send") return v;
  return "dry_run";
}

const MAX_STEPS = 10;

/**
 * Tools whose side effects must not be replayed if a run retries.
 * Read-only tools (web_search, web_scrape, lead_score, company_research,
 * memory) are intentionally NOT in this set — replaying them is free and
 * gives the LLM a chance to re-observe whatever it needed.
 */
const IDEMPOTENT_TOOLS = new Set(["send_email", "hubspot"]);

/** Stable hash of tool input args for the idempotency receipt key. */
function hashToolInput(args: Record<string, unknown>): string {
  return crypto
    .createHash("sha256")
    .update(canonicalJSON(args))
    .digest("hex");
}

/** JSON stringify with sorted keys, so {a:1,b:2} and {b:2,a:1} hash the same. */
function canonicalJSON(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJSON).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJSON(v)}`).join(",")}}`;
}

/** Per-run token budgets by plan */
const TOKEN_BUDGETS: Record<string, number> = {
  TRIAL: 5000,
  STARTER: 10000,
  GROWTH: 50000,
  ENTERPRISE: Infinity,
};

/** Tools whose failures should be surfaced prominently in the run output */
const CRITICAL_TOOLS = new Set(["send_email", "hubspot"]);

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
    private outreachArtifacts: OutreachArtifactsService,
    private readonly config: ConfigService,
    private readonly enrichmentFacts: EnrichmentFactService,
    @Optional() private readonly evidenceLedger?: EvidenceLedgerService,
    @Optional() private readonly linkedinService?: LinkedInService,
    @Optional() private readonly llmBudget?: LlmBudgetService,
  ) {
    this.toolRegistry = new ToolRegistry(
      memoryService,
      evidenceLedger,
      undefined,
      linkedinService,
      config,
      enrichmentFacts,
    );
  }

  /**
   * Policy-gate envelope: the *authorization* envelope consulted by
   * SideEffectPolicy before an external-write tool fires. Phase 2.5 has no
   * envelope source yet (graph approval gates only mark GraphRun.status,
   * not individual agent runs), so this returns undefined and external_write
   * tools fall through to the dry_run / blocked path.
   *
   * Future: read from GraphRun.approvalEnvelope JSON when the outreach
   * subgraph passes an envelope down to the SDR agent run.
   *
   * NOTE: this is distinct from `approvalEnvelopeForRun(runId)` below, which
   * returns the *review payload* (artifacts pending human review) for the UI.
   */
  protected policyApprovalEnvelopeForRun(_runId: string): PolicyApprovalEnvelope | undefined {
    return undefined;
  }

  /**
   * Resolve the GraphRun.id that owns this agent run, if any. Phase 2.5 has
   * no link from AgentRun to GraphRun yet; artifacts are still queryable by
   * orgId. Returns null for direct agent runs that aren't part of a graph.
   */
  protected graphRunIdForRun(_runId: string): string | null {
    return null;
  }

  /**
   * Return the pending-review approval payloads attached to an AgentRun.
   *
   * Resolution order:
   *   1. Look up the AgentRun (scope by id). If missing, return [].
   *   2. If we can resolve a GraphRun for the AgentRun (Phase 2.5: there is
   *      no FK; subclasses or future schema changes can hook this via
   *      `graphRunIdForRun`), pull every OutreachArtifact with status =
   *      PENDING_REVIEW linked to that GraphRun.
   *   3. Otherwise, return [] — a direct AgentRun that isn't part of a
   *      graph has no artifacts to surface. (When AgentRun gains a metadata
   *      / graphRunId column, this branch can use it without changing the
   *      method shape.)
   *
   * Always returns an array (never null) so the UI can render a stable
   * "0 items pending" state.
   */
  async approvalEnvelopeForRun(runId: string): Promise<PendingApprovalEnvelope[]> {
    const run = await this.prisma.agentRun.findUnique({
      where: { id: runId },
      select: { id: true, orgId: true },
    });
    if (!run) return [];

    const graphRunId = this.graphRunIdForRun(runId);
    if (!graphRunId) return [];

    const artifacts = await this.prisma.outreachArtifact.findMany({
      where: {
        orgId: run.orgId,
        graphRunId,
        status: OutreachArtifactStatus.PENDING_REVIEW,
      },
      orderBy: { createdAt: "asc" },
    });

    return artifacts.map(toPendingApprovalEnvelope);
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

    // Per-template tool whitelist enforced inside the agent loop. `null` means
    // the template has no explicit mapping (fallback = unrestricted, matches
    // the existing ToolRegistry behaviour). Any array is the exclusive set the
    // LLM is allowed to call — even if the global registry has more tools.
    const allowedToolNames = this.toolRegistry.getAllowedToolNames(agent.template.name);
    const allowedToolSet = allowedToolNames ? new Set(allowedToolNames) : null;

    await this.addLog(runId, "INFO", `Loaded ${tools.length} tools: ${tools.map((t) => t.name).join(", ")}`);

    // Build user message early so we can use it as the semantic-retrieval query
    const userMessage = this.buildUserMessage(agent.template.name, agent.config as Record<string, unknown>);

    // Load agent memories — keep the legacy KV dump for last_run_summary /
    // contacted_leads, but pull semantically-relevant chunks via pgvector
    // instead of dumping every memory key into the prompt.
    const memories = await this.memoryService.getAll(agent.id);
    const semanticHits = await this.memoryService.searchSemantic(agent.id, userMessage, 5);
    const memoryContext = this.buildMemoryContext(memories, semanticHits);

    await this.addLog(
      runId,
      "DEBUG",
      `Loaded ${Object.keys(memories).length} KV entries, ${semanticHits.length} semantic hits`,
    );

    // Build system prompt with tool awareness and memory
    const basePrompt = getPromptForTemplate(agent.template.name, agent.config as Record<string, unknown>);
    const systemPrompt = this.buildToolAwarePrompt(basePrompt, tools) + memoryContext;

    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ];

    // Determine model — pull from template config so we can swap models
    // per-agent without code changes. Templates declare a primary `model`
    // and an optional `fastModel` inside `defaultConfig` (Json on the DB
    // row). Fall back to the historical defaults if either field is absent.
    const isComplex = this.isComplexTask(agent.template.name);
    const templateConfig = (agent.template.defaultConfig ?? {}) as Record<string, unknown>;
    const templateModel =
      typeof templateConfig.model === "string" ? templateConfig.model : undefined;
    const templateFastModel =
      typeof templateConfig.fastModel === "string" ? templateConfig.fastModel : undefined;
    const defaultModel = process.env.DEFAULT_MODEL ?? "gpt-4o";
    const defaultFastModel = process.env.SYSTEM_MODEL_MINI ?? "gpt-4o-mini";
    const model = isComplex
      ? (templateModel ?? defaultModel)
      : (templateFastModel ?? defaultFastModel);
    const plan = agent.org.plan;

    await this.addLog(runId, "INFO", `Using model: ${model}, plan: ${plan}`);

    // Multi-step agent loop
    let totalTokens = 0;
    let totalCost = 0;
    const steps: StepLog[] = [];
    let stepNum = 0;
    let dbStepIndex = 0;
    const minToolSteps = this.getMinToolSteps(agent.template.name);
    const criticalToolFailures: string[] = [];
    const tokenBudget = TOKEN_BUDGETS[plan] ?? TOKEN_BUDGETS.TRIAL;

    for (let i = 0; i < MAX_STEPS; i++) {
      stepNum = i + 1;

      // ── Token budget enforcement ──────────────────────────────────────
      if (tokenBudget !== Infinity && totalTokens >= tokenBudget) {
        await this.addLog(runId, "WARN", `Token budget exhausted (${totalTokens}/${tokenBudget} for plan ${plan}). Stopping.`);
        await this.persistStep(runId, dbStepIndex++, "ERROR", undefined, undefined, { budget: tokenBudget, used: totalTokens }, 0, 0, `Token budget exhausted for plan ${plan}`);
        break;
      }

      // ── Daily USD budget enforcement (per org) ────────────────────────
      // Read-only check before the LLM call. The actual atomic charge happens
      // inside LLMService.chat() so every entry point (executor + LangGraph
      // nodes + judges) is gated by the same ledger. This fast-fail surfaces
      // the cap in the run trace before the BadRequestException bubbles up.
      if (this.llmBudget) {
        const spent = this.llmBudget.getSpentToday(agent.orgId);
        const cap = this.llmBudget.getCap();
        if (spent >= cap) {
          await this.addLog(
            runId,
            "ERROR",
            `Daily LLM USD cap reached for org ${agent.orgId} (spent ${spent.toFixed(2)}/${cap.toFixed(2)}). Stopping.`,
          );
          await this.persistStep(
            runId,
            dbStepIndex++,
            "ERROR",
            undefined,
            undefined,
            { cap, spent },
            0,
            0,
            `Daily LLM budget exceeded for org`,
          );
          throw new BadRequestException("Daily LLM budget exceeded for org");
        }
      }

      // Force tool use for the first N iterations to ensure agents actually use their tools
      const toolCallsSoFar = steps.filter((s) => s.type === "tool_call").length;
      const forceTools = toolCallsSoFar < minToolSteps && openAITools.length > 0;

      // Cap maxTokens to remaining budget
      const remainingBudget = tokenBudget === Infinity ? 4000 : Math.min(4000, tokenBudget - totalTokens);

      const templateSlug = String(agent.template.name).toLowerCase().replace(/\s+/g, "_");
	      const llmStart = Date.now();
	      const response = await this.llm.chat(messages, {
	        model,
	        plan,
	        maxTokens: Math.min(remainingBudget, 4000), // cap to remaining budget; minimum enforced below
	        orgId: agent.orgId,
	        tools: openAITools.length > 0 ? openAITools : undefined,
	        toolChoice: forceTools ? "required" : "auto",
	        agent: `${templateSlug}.step`,
        tags: ["executor", templateSlug, `step:${stepNum}`],
        metadata: {
          org_id: agent.orgId,
          agent_id: agent.id,
          agent_name: agent.name,
          template: agent.template.name,
          run_id: runId,
          step: stepNum,
          plan,
        },
      });
      const llmDuration = Date.now() - llmStart;

      totalTokens += response.tokensUsed;
      totalCost += response.cost;

      // Persist LLM_CALL step
      await this.persistStep(
        runId, dbStepIndex++, "LLM_CALL", undefined,
        { model: response.model, toolChoice: forceTools ? "required" : "auto" },
        { content: response.content?.slice(0, 500), hasToolCalls: !!(response.toolCalls && response.toolCalls.length > 0) },
        llmDuration, response.tokensUsed,
      );

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

          // Per-template whitelist enforcement. If the template declares a
          // whitelist and the LLM tried to call a tool outside it, reject the
          // call without ever touching the tool. The rejection result is
          // returned to the LLM so it can choose a different tool. This is the
          // choke point that makes scoped templates (Reply Handler, SEO Agent)
          // safe even if the global ToolRegistry has more tools available.
          if (allowedToolSet && !allowedToolSet.has(toolName)) {
            const reason = `Tool "${toolName}" is not allowed for this agent template. Allowed tools: ${[...allowedToolSet].join(", ")}.`;
            await this.addLog(runId, "WARN", `tool_not_whitelisted: ${reason}`);
            const rejection = { success: false, error: reason, tool_not_whitelisted: true };
            await this.persistStep(runId, dbStepIndex++, "TOOL_CALL", toolName, toolArgs, null, 0, 0);
            await this.persistStep(
              runId,
              dbStepIndex++,
              "TOOL_RESULT",
              toolName,
              null,
              rejection as Record<string, unknown>,
              0,
              0,
              reason,
            );
            steps.push({
              step: stepNum,
              type: "tool_result",
              toolName,
              toolOutput: rejection,
              timestamp: Date.now(),
            });
            messages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content: JSON.stringify(rejection),
            });
            continue;
          }

          const tool = this.toolRegistry.get(toolName);
          let toolResult: unknown;
          const toolStart = Date.now();
          const isIdempotent = IDEMPOTENT_TOOLS.has(toolName);
          const inputHash = isIdempotent ? hashToolInput(toolArgs) : null;
          let replayed = false;

          // Side-effect policy gate. Runs before idempotency replay so a
          // tool that became disallowed since the last receipt cannot be
          // re-served from cache.
          const policyDecision: PolicyDecision = SideEffectPolicy.check(toolName, {
            envelope: this.policyApprovalEnvelopeForRun(runId),
            defaultDryRun: getOutreachExecutionMode() === "dry_run",
          });

          if (!policyDecision.allow) {
            await this.addLog(runId, "WARN", `policy_blocked: ${toolName} — ${policyDecision.reason}`);
            toolResult = { success: false, error: policyDecision.reason, policy_blocked: true };
            // Persist a TOOL_CALL + TOOL_RESULT pair flagged as policy_blocked
            // so the trace surfaces what was attempted.
            await this.persistStep(runId, dbStepIndex++, "TOOL_CALL", toolName, toolArgs, null, 0, 0);
            await this.persistStep(
              runId,
              dbStepIndex++,
              "TOOL_RESULT",
              toolName,
              null,
              toolResult as Record<string, unknown>,
              0,
              0,
              policyDecision.reason,
            );
            steps.push({
              step: stepNum,
              type: "tool_result",
              toolName,
              toolOutput: toolResult,
              timestamp: Date.now(),
            });
            messages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content: JSON.stringify(toolResult),
            });
            continue;
          }

          // Dry-run short-circuit: policy allowed the call but routed it to
          // artifact generation instead of external execution. The synthetic
          // result lets the LLM continue its loop without touching the
          // outside world.
          if (policyDecision.mode === "dry_run") {
            let artifactId: string | null = null;
            try {
              const artifact = await this.outreachArtifacts.recordDryRun({
                orgId: agent.orgId,
                graphRunId: this.graphRunIdForRun(runId),
                toolName,
                toolArgs,
              });
              artifactId = artifact?.id ?? null;
            } catch (err) {
              await this.addLog(
                runId,
                "WARN",
                `dry_run: failed to persist artifact for ${toolName}: ${err instanceof Error ? err.message : "unknown error"}`,
              );
            }

            await this.addLog(
              runId,
              "INFO",
              `dry_run: ${toolName} captured as artifact${artifactId ? ` ${artifactId}` : " (none)"}`,
            );
            toolResult = {
              success: true,
              dryRun: true,
              wouldHaveSent: toolArgs,
              artifactId,
              message: `Dry-run: ${toolName} did not execute externally`,
            };
            await this.persistStep(runId, dbStepIndex++, "TOOL_CALL", toolName, toolArgs, null, 0, 0);
            await this.persistStep(
              runId,
              dbStepIndex++,
              "TOOL_RESULT",
              toolName,
              null,
              toolResult as Record<string, unknown>,
              0,
              0,
            );
            steps.push({
              step: stepNum,
              type: "tool_result",
              toolName,
              toolOutput: toolResult,
              timestamp: Date.now(),
            });
            messages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content: JSON.stringify(toolResult),
            });
            continue;
          }

          if (tool) {
            // Idempotency: if a receipt exists for (runId, toolName, inputHash),
            // return the persisted output without re-invoking the tool.
            if (isIdempotent && inputHash) {
              try {
                const existing = await this.prisma.toolCallReceipt.findUnique({
                  where: { runId_toolName_inputHash: { runId, toolName, inputHash } },
                });
                if (existing) {
                  toolResult = existing.output;
                  replayed = true;
                  await this.addLog(
                    runId,
                    "INFO",
                    `${toolName} idempotent replay: returning cached receipt ${existing.id}`,
                  );
                }
              } catch {
                // Receipt lookup failure should not block tool execution
              }
            }

            if (!replayed) {
              try {
                const result = await tool.execute(toolArgs, toolContext);
                toolResult = result;
                await this.addLog(runId, "DEBUG", `${toolName} returned: success=${result.success}`);

                // Track failures for critical tools
                if (CRITICAL_TOOLS.has(toolName) && !result.success) {
                  const errMsg = `${toolName}: ${(result as unknown as Record<string, unknown>).error || "returned success=false"}`;
                  criticalToolFailures.push(errMsg);
                  await this.addLog(runId, "ERROR", `Critical tool failure: ${errMsg}`);
                }

                // Persist receipt only for successful idempotent tool calls
                if (isIdempotent && inputHash && result.success) {
                  try {
                    await this.prisma.toolCallReceipt.create({
                      data: {
                        runId,
                        orgId: agent.orgId,
                        toolName,
                        inputHash,
                        output: toolResult as any,
                        success: true,
                      },
                    });
                  } catch {
                    // Unique-constraint races are fine; receipt already exists
                  }
                }
              } catch (error) {
                toolResult = { success: false, error: error instanceof Error ? error.message : "Tool execution failed" };
                await this.addLog(runId, "WARN", `${toolName} failed: ${error instanceof Error ? error.message : "unknown error"}`);

                if (CRITICAL_TOOLS.has(toolName)) {
                  const errMsg = `${toolName}: ${error instanceof Error ? error.message : "unknown error"}`;
                  criticalToolFailures.push(errMsg);
                  await this.addLog(runId, "ERROR", `Critical tool failure: ${errMsg}`);
                }
              }
            }
          } else {
            toolResult = { success: false, error: `Unknown tool: ${toolName}` };
            await this.addLog(runId, "WARN", `Unknown tool: ${toolName}`);
          }

          const toolDuration = Date.now() - toolStart;

          // Persist TOOL_CALL step
          await this.persistStep(runId, dbStepIndex++, "TOOL_CALL", toolName, toolArgs, null, toolDuration, 0);

          // Persist TOOL_RESULT step
          await this.persistStep(
            runId, dbStepIndex++, "TOOL_RESULT", toolName, null,
            typeof toolResult === "object" ? toolResult : { value: toolResult },
            0, 0,
            (toolResult as any)?.success === false ? ((toolResult as any)?.error || "Tool failed") : undefined,
          );

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

      // Persist FINAL_OUTPUT step
      await this.persistStep(
        runId, dbStepIndex++, "FINAL_OUTPUT", undefined,
        null, { content: response.content?.slice(0, 5000) },
        0, 0,
      );

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
      tokenBudget: tokenBudget === Infinity ? "unlimited" : tokenBudget,
      tokensUsed: totalTokens,
      budgetRemaining: tokenBudget === Infinity ? "unlimited" : Math.max(0, tokenBudget - totalTokens),
    };

    // Surface critical tool failures in the output
    if (criticalToolFailures.length > 0) {
      output._criticalFailures = criticalToolFailures;
      await this.addLog(
        runId,
        "ERROR",
        `Run completed with ${criticalToolFailures.length} critical tool failure(s): ${criticalToolFailures.join("; ")}`,
      );
    }

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
      case "reply handler":
        return `Process inbound prospect replies with these parameters:\n${configSummary}\n\nClassify intent, draft a polite contextual reply on the existing thread, and escalate to a human when in doubt.`;
      case "seo agent":
        return `Run SEO research with these parameters:\n${configSummary}\n\nDiscover keyword opportunities, analyze the SERP, and produce structured content briefs. Research only — no publishing.`;
      default:
        return `Execute task with configuration:\n${configSummary}`;
    }
  }

  private getMinToolSteps(templateName: string): number {
    // Minimum number of tool calls before allowing final answer
    // This prevents lazy LLMs from skipping research steps
    const minSteps: Record<string, number> = {
      "sdr agent": 3,          // web_search + company_research/lead_score + send_email
      "content writer": 2,     // web_search + web_scrape
      "inbox monitor": 1,      // at least check inbox
      "crm sync agent": 2,     // hubspot read + hubspot write
      "reporting agent": 2,    // hubspot + web_search
      "social engagement agent": 1,
      "reply handler": 1,      // at minimum, read memory for thread context
      "seo agent": 2,          // web_search + (web_scrape | company_research)
    };
    return minSteps[templateName.toLowerCase()] || 1;
  }

  private isComplexTask(templateName: string): boolean {
    const complexTemplates = ["reporting agent", "crm sync agent", "sdr agent"];
    return complexTemplates.includes(templateName.toLowerCase());
  }

  private buildMemoryContext(
    memories: Record<string, unknown>,
    semanticHits: import("./memory.service").SemanticMemoryHit[] = [],
  ): string {
    if (Object.keys(memories).length === 0 && semanticHits.length === 0) return "";

    const lines: string[] = ["\n\n## Your Memory (from previous runs)"];

    if (memories.last_run_summary) {
      lines.push(`Last run: ${memories.last_run_summary}`);
    }

    if (Array.isArray(memories.contacted_leads) && memories.contacted_leads.length > 0) {
      const leads = memories.contacted_leads as string[];
      lines.push(`Contacted leads (${leads.length}): ${leads.slice(-10).join(", ")}`);
    }

    if (semanticHits.length > 0) {
      lines.push("\n### Relevant prior context (semantic match)");
      for (const hit of semanticHits) {
        // Cosine distance: lower = more similar. Skip weak matches.
        if (hit.distance > 0.5) continue;
        lines.push(`- (${hit.distance.toFixed(2)}) ${hit.content.slice(0, 300)}`);
      }
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

      // Persist a semantic memory chunk capturing this run's outcome so
      // future runs can retrieve it by similarity rather than dumping every
      // KV entry into the prompt. Fire-and-forget; embedding failures must
      // not break the run.
      const semanticChunk = this.buildSemanticChunk(output, summary);
      if (semanticChunk) {
        await this.memoryService.addSemantic(agentId, semanticChunk, {
          runId,
          outputType: (output.type as string) ?? null,
          toolsUsed,
        });
      }
    } catch (error) {
      // Memory save failures should not break the run
    }
  }

  /** Compose a short, embeddable description of what this run accomplished. */
  private buildSemanticChunk(output: Record<string, unknown>, summary: string): string | null {
    const pieces: string[] = [summary];
    if (typeof output.to === "string") pieces.push(`Recipient: ${output.to}`);
    if (typeof output.subject === "string") pieces.push(`Subject: ${output.subject}`);
    if (typeof output.body === "string") pieces.push(`Body: ${output.body.slice(0, 500)}`);
    if (typeof output.content === "string") pieces.push(`Content: ${output.content.slice(0, 500)}`);
    if (typeof output.summary === "string") pieces.push(`Summary: ${output.summary.slice(0, 500)}`);
    const joined = pieces.join("\n").trim();
    return joined.length > 0 ? joined : null;
  }

  private async persistStep(
    runId: string,
    stepIndex: number,
    type: "LLM_CALL" | "TOOL_CALL" | "TOOL_RESULT" | "ERROR" | "FINAL_OUTPUT",
    toolName?: string,
    input?: unknown,
    output?: unknown,
    durationMs: number = 0,
    tokenCount: number = 0,
    error?: string,
  ): Promise<void> {
    try {
      await this.prisma.runStep.create({
        data: {
          runId,
          stepIndex,
          type,
          toolName: toolName || null,
          input: input != null ? (input as any) : undefined,
          output: output != null ? (output as any) : undefined,
          durationMs,
          tokenCount,
          error: error || null,
        },
      });
    } catch {
      // RunStep persistence should not break the run
    }
  }

  private async addLog(runId: string, level: "DEBUG" | "INFO" | "WARN" | "ERROR", message: string, metadata?: Record<string, unknown>) {
    return this.prisma.agentLog.create({
      data: { runId, level, message, metadata: (metadata || undefined) as any },
    });
  }
}

/**
 * Convert an OutreachArtifact row to the UI-facing PendingApprovalEnvelope.
 * Kept module-private so the mapping can be unit-tested via the service
 * surface without exposing a parallel API. `previewText` is truncated to
 * `APPROVAL_PREVIEW_MAX` chars so list responses stay compact even when
 * the underlying bodyText is multi-page.
 */
function toPendingApprovalEnvelope(artifact: {
  id: string;
  channel: "EMAIL" | "LINKEDIN" | "HUBSPOT_NOTE";
  recipientRef: string | null;
  subject: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  toolName: string;
  payload: unknown;
  createdAt: Date;
}): PendingApprovalEnvelope {
  const body = artifact.bodyText ?? "";
  const previewText =
    body.length > APPROVAL_PREVIEW_MAX ? body.slice(0, APPROVAL_PREVIEW_MAX) : body;
  return {
    artifactId: artifact.id,
    channel: artifact.channel,
    recipientRef: artifact.recipientRef,
    subject: artifact.subject,
    previewText,
    bodyHtml: artifact.bodyHtml,
    toolName: artifact.toolName,
    payload: artifact.payload,
    createdAt: artifact.createdAt,
  };
}
