import { Module, OnModuleInit } from "@nestjs/common";
import { LLMService } from "./llm.service";
import { LlmBudgetService } from "./llm-budget.service";
import { ObservabilityModule } from "../observability/observability.module";
import { EvaluatorRunnerService } from "../observability/evaluators/evaluator-runner.service";
import { callJudge } from "../observability/evaluators/judge";

@Module({
  // The guarded release uses only the LLM + budget boundary. Legacy generic
  // AgentRun execution, its scheduler, and its queue worker are deliberately
  // not providers, so importing RuntimeModule cannot activate them.
  imports: [ObservabilityModule],
  providers: [LLMService, LlmBudgetService],
  exports: [LLMService, LlmBudgetService],
})
export class RuntimeModule implements OnModuleInit {
  constructor(
    private readonly llm: LLMService,
    private readonly runner: EvaluatorRunnerService,
  ) {}

  onModuleInit(): void {
    // Wire the LLM judge into the evaluator runner so LLM-as-judge evaluators
    // (toxicity, bias, hallucination) can run. Set after both modules init to
    // avoid an ObservabilityModule → RuntimeModule cycle.
    this.runner.setJudge(async (args) => callJudge(this.llm, args));
  }
}
