import { Global, Module, OnModuleInit } from "@nestjs/common";
import { LangSmithService } from "./langsmith.service";
import { EvidenceLedgerService } from "./evidence-ledger.service";
import { PiiLeakageEvaluator } from "./evaluators/pii-leakage.evaluator";
import { PromptInjectionEvaluator } from "./evaluators/prompt-injection.evaluator";
import { ToxicityEvaluator } from "./evaluators/toxicity.evaluator";
import { BiasFairnessEvaluator } from "./evaluators/bias-fairness.evaluator";
import { HallucinationEvaluator } from "./evaluators/hallucination.evaluator";
import { CorrectnessEvaluator } from "./evaluators/correctness.evaluator";
import { ToolUseCorrectnessEvaluator } from "./evaluators/tool-use-correctness.evaluator";
import { EvaluatorRunnerService } from "./evaluators/evaluator-runner.service";
import { RunLevelEvaluatorService } from "./run-level-evaluator.service";

@Global()
@Module({
  providers: [
    LangSmithService,
    EvidenceLedgerService,
    PiiLeakageEvaluator,
    PromptInjectionEvaluator,
    ToxicityEvaluator,
    BiasFairnessEvaluator,
    HallucinationEvaluator,
    CorrectnessEvaluator,
    ToolUseCorrectnessEvaluator,
    EvaluatorRunnerService,
    RunLevelEvaluatorService,
  ],
  exports: [
    LangSmithService,
    EvidenceLedgerService,
    EvaluatorRunnerService,
    RunLevelEvaluatorService,
    PiiLeakageEvaluator,
    PromptInjectionEvaluator,
    ToxicityEvaluator,
    BiasFairnessEvaluator,
    HallucinationEvaluator,
    CorrectnessEvaluator,
    ToolUseCorrectnessEvaluator,
  ],
})
export class ObservabilityModule implements OnModuleInit {
  constructor(
    private readonly langsmith: LangSmithService,
    private readonly runner: EvaluatorRunnerService,
  ) {}

  onModuleInit(): void {
    // Wire the evaluator runner into LangSmithService via setter to avoid a
    // circular DI graph (EvaluatorRunner → LLMService → LangSmithService).
    this.langsmith.setEvaluatorRunner(this.runner);
  }
}
