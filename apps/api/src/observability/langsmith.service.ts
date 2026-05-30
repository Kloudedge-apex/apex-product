import { Injectable, Logger, OnModuleDestroy, Optional } from "@nestjs/common";
import { createHash } from "node:crypto";
import { LlmRequestStatus } from "@prisma/client";
import { getLangSmithConfig } from "./langsmith.config";
import { LlmFactService } from "./llm-fact/llm-fact.service";
import { estimateCostUsd } from "./llm-fact/model-cost";

interface EvaluatorRunnerLike {
  run(ctx: {
    readonly runId: string;
    readonly agent?: string;
    readonly node?: string;
    readonly model: string;
    readonly inputs: unknown;
    readonly outputs: unknown;
    readonly metadata?: Readonly<Record<string, unknown>>;
    readonly tags?: readonly string[];
  }): Promise<void>;
}

type JsonSafe =
  | null
  | boolean
  | number
  | string
  | readonly JsonSafe[]
  | { readonly [key: string]: JsonSafe };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return value.slice(0, Math.max(0, maxChars));
}

function hashEmail(email: string): string {
  return createHash("sha256").update(email.toLowerCase()).digest("hex");
}

function hashEmailsInText(text: string): string {
  // Conservative email matcher; avoids over-matching adjacent punctuation.
  const emailRegex =
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

  return text.replace(emailRegex, (match) => `sha256:${hashEmail(match)}`);
}

const DROP_KEYS = new Set<string>([
  "tool_call_id",
  // Raw tool arguments often contain PII; drop unconditionally.
  "arguments",
  "tool_args",
  // Embedding inputs can contain raw text; drop unconditionally.
  "embedding_input",
  "embeddings_input",
]);

function redactForLangSmith(
  value: unknown,
  opts: { readonly maxChars: number; readonly capturePrompts: boolean },
  seen: WeakSet<object>,
): JsonSafe {
  if (value === null) return null;

  if (typeof value === "string") {
    if (!opts.capturePrompts) return "[redacted]";
    return truncate(hashEmailsInText(value), opts.maxChars);
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined") return null;

  if (value instanceof Date) {
    return truncate(value.toISOString(), opts.maxChars);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactForLangSmith(item, opts, seen));
  }

  if (typeof value === "object") {
    if (seen.has(value)) return "[circular]";
    seen.add(value);

    if (!isPlainObject(value)) {
      return truncate(String(value), opts.maxChars);
    }

    const obj = value;
    const isEmbeddingLike =
      typeof obj.type === "string" && obj.type.toLowerCase().includes("embedding");

    const out: Record<string, JsonSafe> = {};
    for (const [key, inner] of Object.entries(obj)) {
      if (DROP_KEYS.has(key)) continue;
      if (isEmbeddingLike && (key === "input" || key === "texts")) continue;
      if (key.toLowerCase().includes("embedding") && (key === "input" || key === "texts")) {
        continue;
      }

      out[key] = redactForLangSmith(inner, opts, seen);
    }
    return out;
  }

  return truncate(String(value), opts.maxChars);
}

function redactInputsAndOutputs(
  value: unknown,
  opts: { readonly maxChars: number; readonly capturePrompts: boolean },
): JsonSafe {
  return redactForLangSmith(value, opts, new WeakSet<object>());
}

type LangSmithClient = import("langsmith").Client;
type LangSmithRunTree = import("langsmith").RunTree;

export interface WrapLlmInput {
  readonly name: string;
  readonly model: string;
  readonly inputs: unknown;
  readonly parentRunId?: string;
  /** Logical agent identifier — when set, overrides `name` as the LangSmith run name so traces are agent-scoped instead of provider-scoped. e.g. "sdr_agent.draft_message". */
  readonly agent?: string;
  /** Graph node identifier — emitted as metadata.node for filtering. e.g. "sdr_outreach.qa_message". */
  readonly node?: string;
  /** Tenant owning this call. Required for billing persistence; if missing, the LlmRequestFact write is skipped. */
  readonly orgId?: string;
  readonly campaignId?: string | null;
  readonly leadId?: string | null;
  readonly artifactId?: string | null;
  readonly graphRunId?: string | null;
  readonly promptVersion?: string | null;
  readonly evalBundleVersion?: string | null;
  /** Free-form tags attached to the run for LangSmith filtering. */
  readonly tags?: readonly string[];
  /** Extra metadata merged into the run's metadata field. */
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** Optional callback fired after the run is created on the server, with the runId. Used by evaluators to attach feedback. */
  readonly onRunStart?: (runId: string) => void;
}

export interface FeedbackInput {
  readonly runId: string;
  readonly key: string;
  readonly score?: number;
  readonly value?: string | number | boolean;
  readonly comment?: string;
  readonly correction?: Readonly<Record<string, unknown>>;
}

@Injectable()
export class LangSmithService implements OnModuleDestroy {
  private readonly logger = new Logger(LangSmithService.name);
  private clientPromise: Promise<LangSmithClient> | undefined;
  private bootLogged = false;
  private evaluatorRunner: EvaluatorRunnerLike | undefined;
  private warnedMissingOrgId = false;

  constructor(@Optional() private readonly llmFacts?: LlmFactService) {}

  static async loadSdk(): Promise<typeof import("langsmith")> {
    return import("langsmith");
  }

  /**
   * Setter-injected to avoid a circular DI graph between LangSmithService and
   * EvaluatorRunnerService (which itself depends on LLMService → LangSmithService).
   * Module wires this up at bootstrap via onModuleInit.
   */
  setEvaluatorRunner(runner: EvaluatorRunnerLike): void {
    this.evaluatorRunner = runner;
  }

  private async getClient(apiKey: string): Promise<LangSmithClient> {
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        const { Client } = await LangSmithService.loadSdk();
        const client = new Client({ apiKey });
        if (!this.bootLogged) {
          const cfg = getLangSmithConfig();
          this.logger.log(
            `LangSmith tracing enabled (project=${cfg.project ?? "default"}, capturePrompts=${cfg.capturePrompts === true})`,
          );
          this.bootLogged = true;
        }
        return client;
      })();
    }
    return this.clientPromise;
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.clientPromise) return;
    try {
      const client = (await this.clientPromise) as LangSmithClient & {
        awaitPendingTraceBatches?: () => Promise<void>;
      };
      if (typeof client.awaitPendingTraceBatches === "function") {
        await client.awaitPendingTraceBatches();
      }
    } catch (err) {
      this.logger.warn(
        `LangSmith shutdown flush failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Append a LangSmith run to a named dataset as a new example, creating the
   * dataset on first call. Used by the HITL reject flow to build a regression
   * corpus of bad agent outputs (e.g. "apex-bad-sdr-drafts") that evaluators
   * can be tested against later.
   *
   * Fire-and-forget by design — failures log a warning but never throw, since
   * dataset upload is best-effort training data, not part of the user-facing
   * reject path.
   */
  async addRunToDataset(
    datasetName: string,
    runId: string,
    metadata: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const config = getLangSmithConfig();
    if (!config.apiKey || config.tracing === false) return;
    if (!runId) return;
    try {
      const client = (await this.getClient(config.apiKey)) as LangSmithClient & {
        hasDataset?: (args: { datasetName?: string; datasetId?: string }) => Promise<boolean>;
        createDataset?: (
          name: string,
          opts?: { description?: string },
        ) => Promise<unknown>;
        createExample?: (update: {
          inputs: Record<string, unknown>;
          outputs?: Record<string, unknown>;
          metadata?: Record<string, unknown>;
          dataset_name?: string;
          source_run_id?: string;
          use_source_run_io?: boolean;
        }) => Promise<unknown>;
      };

      if (
        typeof client.hasDataset !== "function" ||
        typeof client.createDataset !== "function" ||
        typeof client.createExample !== "function"
      ) {
        this.logger.warn(
          `LangSmith client missing dataset APIs — skipping addRunToDataset(${datasetName}, runId=${runId})`,
        );
        return;
      }

      // Idempotent dataset bootstrap. hasDataset throws if the dataset is
      // missing in some SDK versions, so we also catch "already exists" on
      // create as a belt-and-braces fallback.
      let exists = false;
      try {
        exists = await client.hasDataset({ datasetName });
      } catch {
        exists = false;
      }
      if (!exists) {
        try {
          await client.createDataset(datasetName, {
            description:
              "Apex auto-collected regression set — bad agent outputs flagged by HITL reviewers.",
          });
        } catch (createErr) {
          const msg = createErr instanceof Error ? createErr.message : String(createErr);
          // Race: another worker created it between hasDataset and createDataset.
          if (!/already.?exists|409/i.test(msg)) {
            throw createErr;
          }
        }
      }

      // source_run_id + use_source_run_io copies the run's inputs/outputs
      // into the example, so the dataset stays useful even after the run TTL
      // expires on LangSmith's side.
      await client.createExample({
        inputs: {},
        dataset_name: datasetName,
        source_run_id: runId,
        use_source_run_io: true,
        metadata: { ...metadata, source_run_id: runId },
      });
    } catch (err) {
      this.logger.warn(
        `LangSmith addRunToDataset failed (dataset=${datasetName} runId=${runId}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Post run-level feedback (e.g. evaluator scores) to LangSmith. Non-blocking
   * by design — failures log a warning but never throw, since evaluator
   * feedback must not break the agent loop.
   */
  async createFeedback(input: FeedbackInput): Promise<string | null> {
    const config = getLangSmithConfig();
    if (!config.apiKey || config.tracing === false) return null;
    try {
      const client = (await this.getClient(config.apiKey)) as LangSmithClient & {
        createFeedback?: (
          runId: string,
          key: string,
          opts: {
            score?: number;
            value?: string | number | boolean;
            comment?: string;
            correction?: Readonly<Record<string, unknown>>;
          },
        ) => Promise<unknown>;
      };
      if (typeof client.createFeedback !== "function") return null;
      const res = await client.createFeedback(input.runId, input.key, {
        score: input.score,
        value: input.value,
        comment: input.comment,
        correction: input.correction,
      });
      if (res && typeof res === "object" && "id" in res) {
        const id = (res as { readonly id?: unknown }).id;
        if (typeof id === "string" && id.length > 0) return id;
      }
      return null;
    } catch (err) {
      this.logger.warn(
        `LangSmith createFeedback failed (key=${input.key} runId=${input.runId}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  async wrapLlm<TResult>(
    input: WrapLlmInput,
    fn: () => Promise<TResult>,
  ): Promise<TResult> {
    const config = getLangSmithConfig();
    const shouldAttemptTracing = Boolean(config.apiKey) && config.tracing !== false;

    // Prefer the caller-supplied `agent` tag as the run name so traces are
    // agent-scoped (e.g. "sdr_agent.draft_message") instead of provider-scoped
    // ("openai.chat"). Original `name` is preserved as metadata.provider_name.
    const runName = input.agent ?? input.name;
    const tags = [
      ...(input.tags ?? []),
      ...(input.agent ? [`agent:${input.agent}`] : []),
      ...(input.node ? [`node:${input.node}`] : []),
      `model:${input.model}`,
      `provider:${input.name}`,
    ];
    const metadata: Record<string, unknown> = {
      model: input.model,
      provider_name: input.name,
      ...(input.agent ? { agent: input.agent } : {}),
      ...(input.node ? { node: input.node } : {}),
      ...(input.orgId ? { orgId: input.orgId } : {}),
      ...(input.campaignId ? { campaignId: input.campaignId } : {}),
      ...(input.leadId ? { leadId: input.leadId } : {}),
      ...(input.artifactId ? { artifactId: input.artifactId } : {}),
      ...(input.graphRunId ? { graphRunId: input.graphRunId } : {}),
      ...(input.node ? { nodeName: input.node } : {}),
      ...(input.promptVersion ? { promptVersion: input.promptVersion } : {}),
      ...(input.evalBundleVersion ? { evalBundleVersion: input.evalBundleVersion } : {}),
      ...(input.metadata ?? {}),
    };

    let runTree: LangSmithRunTree | undefined;
    if (shouldAttemptTracing) {
      try {
        const { RunTree } = await LangSmithService.loadSdk();
        const client = await this.getClient(config.apiKey as string);

        runTree = new RunTree({
          name: runName,
          run_type: "llm",
          project_name: config.project,
          parent_run_id: input.parentRunId,
          tracingEnabled: config.tracing ?? true,
          client,
          tags,
          metadata,
          inputs: config.capturePrompts === true
            ? {
                model: input.model,
                inputs: redactInputsAndOutputs(input.inputs, {
                  maxChars: config.maxContentChars,
                  capturePrompts: true,
                }),
              }
            : { model: input.model },
        });

        await runTree.postRun();
        if (input.onRunStart) {
          const runId = (runTree as unknown as { id?: string }).id;
          if (typeof runId === "string" && runId.length > 0) {
            try {
              input.onRunStart(runId);
            } catch (cbErr) {
              this.logger.warn(
                `onRunStart callback threw for ${runName}: ${
                  cbErr instanceof Error ? cbErr.message : String(cbErr)
                }`,
              );
            }
          }
        }
      } catch (err) {
        this.logger.warn(
          `LangSmith tracing failed to initialize for name=${runName} model=${input.model}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        runTree = undefined;
      }
    }

    const requestedAt = new Date();
    const startedAt = requestedAt.getTime();
    try {
      const result = await fn();

      const completedAt = new Date();
      const durationMs = completedAt.getTime() - startedAt;
      const outputs =
        runTree && config.capturePrompts === true
          ? {
              outputs: redactInputsAndOutputs(result, {
                maxChars: config.maxContentChars,
                capturePrompts: true,
              }),
              duration_ms: durationMs,
            }
          : { duration_ms: durationMs };

      if (runTree) {
        try {
          await runTree.end(outputs);
          const patch = (runTree as { patchRun?: () => Promise<void> }).patchRun;
          if (typeof patch === "function") {
            await patch.call(runTree);
          }
        } catch (innerErr) {
          this.logger.warn(
            `LangSmith finalize (success) failed for ${runName}: ${
              innerErr instanceof Error ? innerErr.message : String(innerErr)
            }`,
          );
        }

        this.fireEvaluators({
          runTree,
          agent: input.agent,
          node: input.node,
          model: input.model,
          inputs: input.inputs,
          outputs: result,
          metadata,
          tags,
        });
      }

      this.recordFact({
        input,
        requestedAt,
        completedAt,
        latencyMs: durationMs,
        result,
        status: LlmRequestStatus.OK,
        errorKind: null,
        runTree,
      });

      return result;
    } catch (err) {
      const completedAt = new Date();
      const durationMs = completedAt.getTime() - startedAt;
      if (runTree) {
        try {
          await runTree.end(
            { duration_ms: durationMs },
            err instanceof Error ? err.message : String(err),
          );
          const patch = (runTree as { patchRun?: () => Promise<void> }).patchRun;
          if (typeof patch === "function") {
            await patch.call(runTree);
          }
        } catch (innerErr) {
          this.logger.warn(
            `LangSmith finalize (error) failed for ${runName}: ${
              innerErr instanceof Error ? innerErr.message : String(innerErr)
            }`,
          );
        }
      }

      const classified = classifyLlmError(err);
      this.recordFact({
        input,
        requestedAt,
        completedAt,
        latencyMs: durationMs,
        result: undefined,
        status: classified.status,
        errorKind: classified.errorKind,
        runTree,
      });
      throw err;
    }
  }

  private recordFact(args: {
    readonly input: WrapLlmInput;
    readonly requestedAt: Date;
    readonly completedAt: Date;
    readonly latencyMs: number;
    readonly result: unknown;
    readonly status: LlmRequestStatus;
    readonly errorKind: string | null;
    readonly runTree: LangSmithRunTree | undefined;
  }): void {
    if (!this.llmFacts) return;

    const orgId = resolveOrgId(args.input);
    if (!orgId) {
      if (!this.warnedMissingOrgId) {
        this.warnedMissingOrgId = true;
        this.logger.warn(
          "wrapLlm called without orgId; skipping LlmRequestFact persistence. " +
            "WS-6+ call sites should pass ChatOptions.orgId (or metadata.org_id as a fallback).",
        );
      }
      return;
    }

    const usage = parseUsage(args.result);
    const costUsd = estimateCostUsd({
      model: args.input.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedInputTokens: usage.cachedInputTokens,
    });

    const langsmithRunId =
      args.runTree && typeof args.runTree === "object"
        ? (args.runTree as unknown as { id?: string }).id
        : undefined;
    void this.llmFacts
      .recordRequest({
        orgId,
        campaignId: args.input.campaignId ?? null,
        leadId: args.input.leadId ?? null,
        artifactId: args.input.artifactId ?? null,
        graphRunId: args.input.graphRunId ?? null,
        nodeName: args.input.node ?? null,
        promptVersion: args.input.promptVersion ?? null,
        evalBundleVersion: args.input.evalBundleVersion ?? null,
        model: args.input.model,
        provider: providerFor(args.input.name),
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        latencyMs: args.latencyMs,
        costUsd,
        langsmithRunId: typeof langsmithRunId === "string" ? langsmithRunId : null,
        status: args.status,
        errorKind: args.errorKind,
        requestedAt: args.requestedAt,
        completedAt: args.completedAt,
      })
      .catch((err) => {
        this.logger.warn(
          `LlmRequestFact fire-and-forget promise rejected: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
  }

  private fireEvaluators(args: {
    readonly runTree: LangSmithRunTree;
    readonly agent?: string;
    readonly node?: string;
    readonly model: string;
    readonly inputs: unknown;
    readonly outputs: unknown;
    readonly metadata: Readonly<Record<string, unknown>>;
    readonly tags: readonly string[];
  }): void {
    if (!this.evaluatorRunner) return;
    const runId = (args.runTree as unknown as { id?: string }).id;
    if (typeof runId !== "string" || runId.length === 0) return;
    // Fire-and-forget; evaluators must never block the agent loop.
    void this.evaluatorRunner
      .run({
        runId,
        agent: args.agent,
        node: args.node,
        model: args.model,
        inputs: args.inputs,
        outputs: args.outputs,
        metadata: args.metadata,
        tags: args.tags,
      })
      .catch((err) => {
        this.logger.warn(
          `Evaluator runner threw for runId=${runId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
  }
}

function providerFor(name: string): string {
  const idx = name.indexOf(".");
  if (idx <= 0) return name;
  return name.slice(0, idx);
}

function resolveOrgId(input: WrapLlmInput): string | undefined {
  if (typeof input.orgId === "string" && input.orgId.length > 0) return input.orgId;
  const meta = input.metadata;
  if (meta && typeof meta === "object") {
    const candidate = (meta as Record<string, unknown>).org_id;
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return undefined;
}

function parseUsage(result: unknown): {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
} {
  if (!result || typeof result !== "object") {
    return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  }

  const usage =
    "usage" in result ? (result as { readonly usage?: unknown }).usage : undefined;

  // OpenAI-style: usage.prompt_tokens / usage.completion_tokens / usage.prompt_tokens_details.cached_tokens
  if (usage && typeof usage === "object") {
    const u = usage as Record<string, unknown>;
    const promptTokens = asInt(u.prompt_tokens);
    const completionTokens = asInt(u.completion_tokens);
    const details = u.prompt_tokens_details;
    const cached = details && typeof details === "object"
      ? asInt((details as Record<string, unknown>).cached_tokens)
      : 0;

    if (promptTokens > 0 || completionTokens > 0 || cached > 0) {
      return {
        inputTokens: promptTokens,
        outputTokens: completionTokens,
        cachedInputTokens: cached,
      };
    }

    // Anthropic-style: usage.input_tokens / usage.output_tokens / usage.cache_read_input_tokens
    const inputTokens = asInt(u.input_tokens);
    const outputTokens = asInt(u.output_tokens);
    const cacheRead = asInt(u.cache_read_input_tokens);
    if (inputTokens > 0 || outputTokens > 0 || cacheRead > 0) {
      return {
        inputTokens,
        outputTokens,
        cachedInputTokens: cacheRead,
      };
    }

    // Internal: usage.inputTokens / usage.outputTokens / usage.cachedInputTokens
    const internalIn = asInt(u.inputTokens);
    const internalOut = asInt(u.outputTokens);
    const internalCached = asInt(u.cachedInputTokens);
    if (internalIn > 0 || internalOut > 0 || internalCached > 0) {
      return {
        inputTokens: internalIn,
        outputTokens: internalOut,
        cachedInputTokens: internalCached,
      };
    }
  }

  // Fallback: existing LLMService response shape (tokensUsed only).
  const tokensUsed =
    "tokensUsed" in result ? asInt((result as Record<string, unknown>).tokensUsed) : 0;
  return { inputTokens: tokensUsed, outputTokens: 0, cachedInputTokens: 0 };
}

function asInt(value: unknown): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num) || num <= 0) return 0;
  return Math.floor(num);
}

function classifyLlmError(err: unknown): { readonly status: LlmRequestStatus; readonly errorKind: string } {
  const message = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : "";
  const lower = message.toLowerCase();

  const isAbort =
    name === "AbortError" ||
    lower.includes("aborterror") ||
    lower.includes("aborted") ||
    lower.includes("abort");

  if (isAbort) {
    if (lower.includes("cancel")) {
      return { status: LlmRequestStatus.CANCELLED, errorKind: "cancelled" };
    }
    return { status: LlmRequestStatus.TIMEOUT, errorKind: "timeout" };
  }

  if (lower.includes("429") || lower.includes("rate limit") || lower.includes("too many requests")) {
    return { status: LlmRequestStatus.ERROR, errorKind: "rate_limit" };
  }
  if (lower.includes("401") || lower.includes("403") || lower.includes("unauthorized")) {
    return { status: LlmRequestStatus.ERROR, errorKind: "auth" };
  }
  if (lower.includes("network") || lower.includes("econnreset") || lower.includes("enotfound")) {
    return { status: LlmRequestStatus.ERROR, errorKind: "network" };
  }

  return { status: LlmRequestStatus.ERROR, errorKind: "unknown" };
}
