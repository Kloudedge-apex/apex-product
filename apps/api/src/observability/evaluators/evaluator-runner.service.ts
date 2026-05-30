import { Inject, Injectable, Logger, forwardRef } from "@nestjs/common";
import { LangSmithService } from "../langsmith.service";
import { Evaluator, EvaluatorContext, EvaluatorDeps, stringifyForEval } from "./evaluator.interface";
import { isJudgeRun } from "./judge";
import { EvaluatorTargetType, Prisma } from "@prisma/client";
import { EvaluatorFactService } from "../evaluator-fact/evaluator-fact.service";
import { PiiLeakageEvaluator } from "./pii-leakage.evaluator";
import { PromptInjectionEvaluator } from "./prompt-injection.evaluator";
import { ToxicityEvaluator } from "./toxicity.evaluator";
import { BiasFairnessEvaluator } from "./bias-fairness.evaluator";
import { HallucinationEvaluator } from "./hallucination.evaluator";
import { CorrectnessEvaluator } from "./correctness.evaluator";
import { ToolUseCorrectnessEvaluator } from "./tool-use-correctness.evaluator";
import { BoilerplateEvaluator } from "./boilerplate.evaluator";
import { AiTellEvaluator } from "./ai-tell.evaluator";
import { CitationCoverageEvaluator } from "./citation-coverage.evaluator";

/**
 * Orchestrates evaluator execution. Called after each traced LLM run completes;
 * runs applicable evaluators in parallel and posts each result to LangSmith as
 * run-level feedback. Failures are logged but never propagated — evaluators
 * must not break the agent loop.
 *
 * The LLM judge function is wired in via `setJudge()` from RuntimeModule on
 * bootstrap to avoid the cycle EvaluatorRunner → LLMService → LangSmith → EvaluatorRunner.
 */
@Injectable()
export class EvaluatorRunnerService {
  private readonly logger = new Logger(EvaluatorRunnerService.name);
  private readonly evaluators: readonly Evaluator[];
  private judge: EvaluatorDeps["judge"];

  private static readonly EVALUATOR_PACK_VERSION = "1.0.0";
  private static readonly PASS_THRESHOLDS: Readonly<Record<string, number>> = {
    pii_leakage: 0.75,
    prompt_injection: 0.75,
    toxicity: 0.7,
    bias_fairness: 0.7,
    hallucination: 0.7,
    correctness: 0.99,
    ai_tell: 0.5,
    boilerplate: 0.5,
    citation_coverage: 0.7,
    tool_use_correctness: 0.75,
  };

  constructor(
    @Inject(forwardRef(() => LangSmithService))
    private readonly langsmith: LangSmithService,
    private readonly evaluatorFacts: EvaluatorFactService,
    pii: PiiLeakageEvaluator,
    promptInjection: PromptInjectionEvaluator,
    toxicity: ToxicityEvaluator,
    bias: BiasFairnessEvaluator,
    hallucination: HallucinationEvaluator,
    correctness: CorrectnessEvaluator,
    toolUseCorrectness: ToolUseCorrectnessEvaluator,
    boilerplate: BoilerplateEvaluator,
    aiTell: AiTellEvaluator,
    citationCoverage: CitationCoverageEvaluator,
  ) {
    this.evaluators = [
      pii,
      promptInjection,
      toxicity,
      bias,
      hallucination,
      correctness,
      toolUseCorrectness,
      boilerplate,
      aiTell,
      citationCoverage,
    ];
  }

  setJudge(judge: EvaluatorDeps["judge"]): void {
    this.judge = judge;
  }

  /**
   * Run all applicable evaluators against the given context and post results
   * as LangSmith feedback. Fire-and-forget — never throws.
   */
  async run(ctx: EvaluatorContext): Promise<void> {
    // Recursion guard: never evaluate judge calls themselves.
    if (isJudgeRun(ctx.tags)) return;

    const applicable = this.evaluators.filter((e) => !e.appliesTo || e.appliesTo(ctx));
    if (applicable.length === 0) return;

    const deps: EvaluatorDeps = { judge: this.judge };

    await Promise.all(
      applicable.map(async (evaluator) => {
        try {
          const orgId = resolveOrgId(ctx.metadata);
          const { targetType, targetId, targetResolution } = resolveTarget(ctx);
          const threshold =
            EvaluatorRunnerService.PASS_THRESHOLDS[evaluator.key] ?? 0.7;

          const startedAt = Date.now();
          const result = await evaluator.evaluate(ctx, deps);
          const latencyMs = Date.now() - startedAt;
          if (!result) return;

          const passed = result.score >= threshold;
          const reason = truncateReason(result.comment ?? result.value);

          const feedbackId =
            (await this.langsmith.createFeedback({
            runId: ctx.runId,
            key: result.key,
            score: result.score,
            value: result.value,
            comment: result.comment,
          })) ?? null;

          if (orgId) {
            void this.evaluatorFacts
              .recordEvaluatorRun({
              orgId,
              targetType,
              targetId,
              evaluatorName: result.key,
              evaluatorVersion: EvaluatorRunnerService.EVALUATOR_PACK_VERSION,
              score: result.score,
              passed,
              reason,
              latencyMs,
              evidence: {
                target_resolution: targetResolution,
                threshold,
                evaluator_value: result.value ?? null,
                evaluator_comment: result.comment ?? null,
                agent: ctx.agent ?? null,
                node: ctx.node ?? null,
                model: ctx.model,
                tags: ctx.tags ?? [],
                metadata: toJsonSafe(ctx.metadata ?? {}),
                inputs_excerpt: stringifyForEval(ctx.inputs, 8000),
                outputs_excerpt: stringifyForEval(ctx.outputs, 8000),
              },
              langsmithFeedbackId: feedbackId,
            })
              .catch((persistErr) => {
                this.logger.warn(
                  `EvaluatorRun persist threw for evaluator=${result.key} run=${ctx.runId}: ${
                    persistErr instanceof Error ? persistErr.message : String(persistErr)
                  }`,
                );
              });
          }
        } catch (err) {
          this.logger.warn(
            `Evaluator ${evaluator.key} failed for run ${ctx.runId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }),
    );
  }
}

function resolveOrgId(metadata: Readonly<Record<string, unknown>> | undefined): string | null {
  if (!metadata) return null;
  const orgId =
    typeof metadata.org_id === "string"
      ? metadata.org_id
      : typeof metadata.orgId === "string"
        ? metadata.orgId
        : null;
  return orgId && orgId.length > 0 ? orgId : null;
}

function resolveTarget(ctx: EvaluatorContext): {
  readonly targetType: EvaluatorTargetType;
  readonly targetId: string;
  readonly targetResolution: string;
} {
  const md = ctx.metadata ?? {};
  const artifactId =
    typeof md.outreach_artifact_id === "string"
      ? md.outreach_artifact_id
      : typeof md.artifact_id === "string"
        ? md.artifact_id
        : null;
  if (artifactId) {
    return {
      targetType: EvaluatorTargetType.ARTIFACT,
      targetId: artifactId,
      targetResolution: "metadata.(outreach_artifact_id|artifact_id)",
    };
  }

  const replyId = typeof md.reply_id === "string" ? md.reply_id : null;
  if (replyId) {
    return {
      targetType: EvaluatorTargetType.REPLY,
      targetId: replyId,
      targetResolution: "metadata.reply_id",
    };
  }

  const enrichmentId =
    typeof md.enrichment_fact_id === "string" ? md.enrichment_fact_id : null;
  if (enrichmentId) {
    return {
      targetType: EvaluatorTargetType.ENRICHMENT,
      targetId: enrichmentId,
      targetResolution: "metadata.enrichment_fact_id",
    };
  }

  const classificationId =
    typeof md.classification_id === "string" ? md.classification_id : null;
  if (classificationId) {
    return {
      targetType: EvaluatorTargetType.CLASSIFICATION,
      targetId: classificationId,
      targetResolution: "metadata.classification_id",
    };
  }

  // Fallback: persist against the LangSmith run id so evaluator history is
  // always queryable even when the caller didn't attach a stronger ref.
  return {
    targetType: EvaluatorTargetType.CLASSIFICATION,
    targetId: ctx.runId,
    targetResolution: "fallback.langsmith_run_id",
  };
}

function truncateReason(reason: unknown): string | null {
  if (typeof reason !== "string") return null;
  const trimmed = reason.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > 280 ? `${trimmed.slice(0, 277)}...` : trimmed;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function toJsonSafe(
  value: unknown,
  seen: WeakSet<object> = new WeakSet<object>(),
): Prisma.InputJsonValue {
  if (value === null) return "[null]";
  if (value === undefined) return "[undefined]";
  if (typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((v) => toJsonSafe(v, seen));
  if (typeof value === "object") {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    if (!isPlainObject(value)) return String(value);
    const out: Record<string, Prisma.InputJsonValue> = {};
    for (const [k, v] of Object.entries(value)) out[k] = toJsonSafe(v, seen);
    return out;
  }
  return String(value);
}
