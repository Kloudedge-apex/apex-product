import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { QueueService } from "./queue.service";

@Injectable()
export class RuntimeService {
  constructor(
    private prisma: PrismaService,
    private queue: QueueService,
  ) {}

  async triggerRun(agentId: string, orgId: string) {
    // Create run record
    const run = await this.prisma.agentRun.create({
      data: {
        agentId,
        orgId,
        status: "QUEUED",
      },
    });

    // Enqueue the job
    this.queue.enqueue({
      id: `job_${run.id}`,
      agentId,
      orgId,
      runId: run.id,
    });

    // Log
    await this.prisma.agentLog.create({
      data: {
        runId: run.id,
        level: "INFO",
        message: "Run queued for execution",
      },
    });

    return run;
  }

  async cancelRun(runId: string) {
    const jobId = `job_${runId}`;
    const cancelled = this.queue.cancel(jobId);

    if (cancelled) {
      await this.prisma.agentRun.update({
        where: { id: runId },
        data: {
          status: "CANCELLED",
          completedAt: new Date(),
        },
      });
    }

    return { cancelled };
  }

  getQueueStats() {
    return {
      queued: this.queue.getQueueLength(),
      processing: this.queue.getProcessingCount(),
    };
  }
}
