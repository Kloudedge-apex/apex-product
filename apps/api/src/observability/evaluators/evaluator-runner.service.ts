import { Inject, Injectable, Logger, forwardRef } from "@nestjs/common";
import { LangSmithService } from "../langsmith.service";
import { Evaluator, EvaluatorContext, EvaluatorDeps } from "./evaluator.interface";
import { isJudgeRun } from "./judge";
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

  constructor(
    @Inject(forwardRef(() => LangSmithService))
    private readonly langsmith: LangSmithService,
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
          const result = await evaluator.evaluate(ctx, deps);
          if (!result) return;
          await this.langsmith.createFeedback({
            runId: ctx.runId,
            key: result.key,
            score: result.score,
            value: result.value,
            comment: result.comment,
          });
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
