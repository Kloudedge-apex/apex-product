import { Injectable, OnModuleInit, OnModuleDestroy } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { QueueService } from "./queue.service";
import { ExecutorService } from "./executor.service";

@Injectable()
export class WorkerService implements OnModuleInit, OnModuleDestroy {
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private activeJobs = 0;
  private readonly maxConcurrency = 5;

  constructor(
    private prisma: PrismaService,
    private queue: QueueService,
    private executor: ExecutorService,
  ) {}

  async onModuleInit() {
    // Recover orphaned QUEUED runs from DB (runs created but never enqueued)
    await this.recoverOrphanedRuns();
    // Poll queue every 2 seconds
    this.intervalHandle = setInterval(() => this.processNext(), 2000);
  }

  private async recoverOrphanedRuns() {
    try {
      const orphaned = await this.prisma.agentRun.findMany({
        where: { status: "QUEUED" },
        orderBy: { startedAt: "asc" },
        take: 20,
      });
      for (const run of orphaned) {
        this.queue.enqueue({
          id: `job_${run.id}`,
          agentId: run.agentId,
          orgId: run.orgId,
          runId: run.id,
        });
      }
      if (orphaned.length > 0) {
        console.log(`[Worker] Recovered ${orphaned.length} orphaned QUEUED runs`);
      }
    } catch (err) {
      console.error("[Worker] Failed to recover orphaned runs:", err);
    }
  }

  onModuleDestroy() {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
    }
  }

  private async processNext() {
    if (this.activeJobs >= this.maxConcurrency) return;

    const job = this.queue.dequeue();
    if (!job) return;

    this.activeJobs++;

    try {
      // Update run status to RUNNING
      await this.prisma.agentRun.update({
        where: { id: job.runId },
        data: { status: "RUNNING" },
      });

      // Execute the agent
      const result = await this.executor.executeAgent(job.agentId, job.runId);

      // Update run with results
      await this.prisma.agentRun.update({
        where: { id: job.runId },
        data: {
          status: "COMPLETED",
          completedAt: new Date(),
          result: result.output as any,
          tokensUsed: result.tokensUsed,
          cost: result.cost,
        },
      });

      this.queue.complete(job.id);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown execution error";

      // Update run as failed
      await this.prisma.agentRun.update({
        where: { id: job.runId },
        data: {
          status: "FAILED",
          completedAt: new Date(),
          result: { error: errorMessage } as any,
        },
      });

      // Log the error
      await this.prisma.agentLog.create({
        data: {
          runId: job.runId,
          level: "ERROR",
          message: errorMessage,
        },
      });

      this.queue.fail(job.id, errorMessage);
    } finally {
      this.activeJobs--;
    }
  }
}
