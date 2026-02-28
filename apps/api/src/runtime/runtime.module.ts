import { Module } from "@nestjs/common";
import { RuntimeService } from "./runtime.service";
import { QueueService } from "./queue.service";
import { WorkerService } from "./worker.service";
import { LLMService } from "./llm.service";
import { ExecutorService } from "./executor.service";
import { SchedulerService } from "./scheduler.service";
import { RuntimeController } from "./runtime.controller";

@Module({
  controllers: [RuntimeController],
  providers: [
    RuntimeService,
    QueueService,
    WorkerService,
    LLMService,
    ExecutorService,
    SchedulerService,
  ],
  exports: [RuntimeService, LLMService],
})
export class RuntimeModule {}
