import { Module } from "@nestjs/common";
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

@Module({
  imports: [IntegrationsModule, OutreachModule],
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
export class RuntimeModule {}
