import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller";
import { PrismaModule } from "../prisma/prisma.module";
import { GraphRunQueueService } from "../graph/graph-run-queue.service";
import { OutreachSendQueueService } from "../outreach/outreach-send-queue.service";
import { WorkerHealthService } from "./worker-health.service";

/**
 * The queue services are provided DIRECTLY (own instances) instead of
 * importing GraphModule / OutreachModule: both classes are dependency-light
 * (Redis connection from env + the @Global MetricsService), and importing the
 * full domain modules here would add exactly the kind of module-graph edges
 * that caused the 2026-06-12 boot-cycle incident (see
 * outreach/suppression.module.ts and src/__tests__/module-graph.spec.ts).
 * A second Queue producer per process is harmless — BullMQ producers are
 * stateless readers/writers over the same Redis keys.
 */
@Module({
  imports: [PrismaModule],
  controllers: [HealthController],
  providers: [GraphRunQueueService, OutreachSendQueueService, WorkerHealthService],
})
export class HealthModule {}
