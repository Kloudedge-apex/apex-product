import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { getLangSmithConfig } from "./langsmith.config";

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

/**
 * Input to {@link LangSmithService.createRootRun}. The caller mints a stable
 * top-level LangSmith run that all subsequent traced LLM calls in the same
 * GraphRun (across nodes, across pods on resume) reattach to via
 * `ChatOptions.parentRunId`. Audit P0 #12: without this anchor every LLM
 * call lands as its own orphaned top-level run, which breaks cross-pod
 * resume after HITL and prevents run-level feedback from threading.
 */
export interface CreateRootRunInput {
  readonly name: string;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly tags?: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** Defaults to "chain" — the LangSmith run_type for a multi-step workflow. */
  readonly runType?: string;
}

@Injectable()
export class LangSmithService implements OnModuleDestroy {
  private readonly logger = new Logger(LangSmithService.name);
  private clientPromise: Promise<LangSmithClient> | undefined;
  private bootLogged = false;
  private evaluatorRunner: EvaluatorRunnerLike | undefined;

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
   * Mint a top-level LangSmith run that subsequent traced LLM calls in the
   * same GraphRun can reattach to via {@link WrapLlmInput.parentRunId}.
   *
   * SDK caveat: `Client.createRun(params)` returns `void` — it does NOT echo
   * back the server-assigned id. We therefore allocate the UUID locally with
   * `crypto.randomUUID()` and pass it as `params.id`; the server honors a
   * caller-supplied id (this is how `RunTree` itself works internally).
   *
   * Tags belong inside `extra.metadata.tags` to mirror how `RunTree` builds the
   * payload server-side (the SDK pulls them off `extra` when persisting). We
   * also merge the caller's `metadata` into `extra.metadata` for the same
   * reason.
   *
   * Fail-soft: any throw from the SDK (network blip, missing key, schema
   * drift) returns `null`. A LangSmith outage MUST NOT take down a GraphRun.
   * Callers should fall back to the `null` branch (typically: skip persisting
   * the id and continue without a parent — older behaviour).
   */
  async createRootRun(input: CreateRootRunInput): Promise<string | null> {
    const config = getLangSmithConfig();
    if (!config.apiKey || config.tracing === false) return null;
    const id = randomUUID();
    try {
      const client = (await this.getClient(config.apiKey)) as LangSmithClient & {
        createRun?: (params: {
          id?: string;
          name: string;
          inputs: Record<string, unknown>;
          run_type: string;
          parent_run_id?: string;
          project_name?: string;
          extra?: Record<string, unknown>;
        }) => Promise<void>;
      };
      if (typeof client.createRun !== "function") {
        this.logger.warn(
          `LangSmith client missing createRun — cannot mint root run for name=${input.name}`,
        );
        return null;
      }

      const metadata: Record<string, unknown> = { ...(input.metadata ?? {}) };
      if (input.tags && input.tags.length > 0) {
        metadata.tags = [...input.tags];
      }

      await client.createRun({
        id,
        name: input.name,
        inputs: { ...input.inputs },
        run_type: input.runType ?? "chain",
        project_name: config.project,
        extra: { metadata },
      });
      return id;
    } catch (err) {
      this.logger.warn(
        `LangSmith createRootRun failed for name=${input.name}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
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
  async createFeedback(input: FeedbackInput): Promise<void> {
    const config = getLangSmithConfig();
    if (!config.apiKey || config.tracing === false) return;
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
        ) => Promise<void>;
      };
      if (typeof client.createFeedback !== "function") return;
      await client.createFeedback(input.runId, input.key, {
        score: input.score,
        value: input.value,
        comment: input.comment,
        correction: input.correction,
      });
    } catch (err) {
      this.logger.warn(
        `LangSmith createFeedback failed (key=${input.key} runId=${input.runId}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  async wrapLlm<TResult>(
    input: WrapLlmInput,
    fn: () => Promise<TResult>,
  ): Promise<TResult> {
    const config = getLangSmithConfig();
    const shouldAttemptTracing = Boolean(config.apiKey) && config.tracing !== false;

    if (!shouldAttemptTracing) return await fn();

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
      ...(input.metadata ?? {}),
    };

    let runTree: LangSmithRunTree | undefined;
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
      return await fn();
    }

    const startedAt = Date.now();
    try {
      const result = await fn();

      const durationMs = Date.now() - startedAt;
      const outputs =
        config.capturePrompts === true
          ? {
              outputs: redactInputsAndOutputs(result, {
                maxChars: config.maxContentChars,
                capturePrompts: true,
              }),
              duration_ms: durationMs,
            }
          : { duration_ms: durationMs };

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

      return result;
    } catch (err) {
      const durationMs = Date.now() - startedAt;
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
      throw err;
    }
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
