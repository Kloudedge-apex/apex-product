import { Module, forwardRef } from "@nestjs/common";
import { GraphService } from "./graph.service";
import { GraphController } from "./graph.controller";
import { GraphRunQueueService } from "./graph-run-queue.service";
import { GraphRunWorker } from "./graph-run.worker";
import { LeadsModule } from "../leads/leads.module";
import { RuntimeModule } from "../runtime/runtime.module";
import { OutreachModule } from "../outreach/outreach.module";
import { ObservabilityModule } from "../observability/observability.module";

@Module({
  imports: [
    forwardRef(() => LeadsModule),
    RuntimeModule,
    OutreachModule,
    ObservabilityModule,
  ],
  controllers: [GraphController],
  providers: [GraphService, GraphRunQueueService, GraphRunWorker],
  exports: [GraphService, GraphRunQueueService],
})
export class GraphModule {}
