import { Module, OnModuleInit } from "@nestjs/common";
import { RuntimeService } from "./runtime.service";
import { QueueService } from "./queue.service";
import { WorkerService } from "./worker.service";
import { LLMService } from "./llm.service";
import { ExecutorService } from "./executor.service";
import { SchedulerService } from "./scheduler.service";
import { RuntimeController } from "./runtime.controller";
import { MemoryService } from "./memory.service";
import { IntegrationsModule } from "../integrations/integrations.module";
import { OutreachModule } from "../outreach/outreach.module";
import { ObservabilityModule } from "../observability/observability.module";
import { EvaluatorRunnerService } from "../observability/evaluators/evaluator-runner.service";
import { callJudge } from "../observability/evaluators/judge";

@Module({
  imports: [IntegrationsModule, OutreachModule, ObservabilityModule],
  controllers: [RuntimeController],
  providers: [
    RuntimeService,
    QueueService,
    WorkerService,
    LLMService,
    ExecutorService,
    SchedulerService,
    MemoryService,
  ],
  exports: [RuntimeService, LLMService, MemoryService],
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
