import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from "@nestjs/common";
import { Job, Worker } from "bullmq";
import { PrismaService } from "../prisma/prisma.service";
import { QueueService, RUN_QUEUE_NAME } from "./queue.service";
import { ExecutorService } from "./executor.service";

interface RunJobData {
  agentId: string;
  orgId: string;
  runId: string;
}

@Injectable()
export class WorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorkerService.name);

  // BullMQ worker (used when REDIS_URL is configured)
  private bullWorker: Worker<RunJobData> | null = null;

  // In-memory polling (used when no Redis is configured)
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private activeJobs = 0;
  private readonly maxConcurrency = Number(process.env.RUN_WORKER_CONCURRENCY ?? 5);

  constructor(
    private prisma: PrismaService,
    private queue: QueueService,
    private executor: ExecutorService,
  ) {}

  async onModuleInit() {
    await this.recoverOrphanedRuns();

    if (this.queue.isBullMode()) {
      const connection = this.queue.getConnection();
      if (!connection) {
        throw new Error("BullMQ mode reported true but Redis connection missing");
      }
      this.bullWorker = new Worker<RunJobData>(
        RUN_QUEUE_NAME,
        async (job) => this.handleJob(job),
        {
          connection,
          concurrency: this.maxConcurrency,
        },
      );
      this.bullWorker.on("failed", (job, err) => {
        this.logger.error(`Job ${job?.id} failed: ${err.message}`);
      });
      this.bullWorker.on("error", (err) => {
        this.logger.error(`BullMQ worker error: ${err.message}`);
      });
      this.logger.log(
        `BullMQ Worker started (queue=${RUN_QUEUE_NAME}, concurrency=${this.maxConcurrency})`,
      );
    } else {
      this.intervalHandle = setInterval(() => this.processNext(), 2000);
      this.logger.log("In-memory polling worker started (no Redis configured)");
    }
  }

  async onModuleDestroy() {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    if (this.bullWorker) {
      await this.bullWorker.close();
      this.bullWorker = null;
    }
  }

  /** Re-enqueue any AgentRun rows stuck in QUEUED state (worker crash recovery). */
  private async recoverOrphanedRuns() {
    try {
      const orphaned = await this.prisma.agentRun.findMany({
        where: { status: "QUEUED" },
        orderBy: { startedAt: "asc" },
        take: 20,
      });
      for (const run of orphaned) {
        await this.queue.enqueue({
          id: `job_${run.id}`,
          agentId: run.agentId,
          orgId: run.orgId,
          runId: run.id,
        });
      }
      if (orphaned.length > 0) {
        this.logger.log(`Recovered ${orphaned.length} orphaned QUEUED runs`);
      }
    } catch (err) {
      this.logger.error(`Failed to recover orphaned runs: ${(err as Error).message}`);
    }
  }

  /** BullMQ job handler. Throws on failure so BullMQ records the error and retries. */
  private async handleJob(job: Job<RunJobData>): Promise<void> {
    const { agentId, runId } = job.data;
    await this.runAgent(agentId, runId);
  }

  /** Shared execution path used by both BullMQ worker and in-memory poller. */
  private async runAgent(agentId: string, runId: string): Promise<void> {
    // Refuse to run if the run was cancelled while waiting in the queue
    const run = await this.prisma.agentRun.findUnique({
      where: { id: runId },
      select: { status: true },
    });
    if (!run || run.status === "CANCELLED") {
      this.logger.warn(`Skipping cancelled/missing run ${runId}`);
      return;
    }

    await this.prisma.agentRun.update({
      where: { id: runId },
      data: { status: "RUNNING" },
    });

    try {
      const result = await this.executor.executeAgent(agentId, runId);

      await this.prisma.agentRun.update({
        where: { id: runId },
        data: {
          status: "COMPLETED",
          completedAt: new Date(),
          result: result.output as any,
          tokensUsed: result.tokensUsed,
          cost: result.cost,
        },
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown execution error";

      await this.prisma.agentRun.update({
        where: { id: runId },
        data: {
          status: "FAILED",
          completedAt: new Date(),
          result: { error: errorMessage } as any,
        },
      });

      await this.prisma.agentLog.create({
        data: { runId, level: "ERROR", message: errorMessage },
      });

      // Re-throw so BullMQ records the failure and applies retry/backoff
      throw error;
    }
  }

  /** In-memory polling path. Not used in BullMQ mode. */
  private async processNext() {
    if (this.activeJobs >= this.maxConcurrency) return;
    const job = this.queue.dequeue();
    if (!job) return;

    this.activeJobs++;
    try {
      await this.runAgent(job.agentId, job.runId);
      this.queue.complete(job.id);
    } catch (error) {
      this.queue.fail(job.id, error instanceof Error ? error.message : "unknown");
    } finally {
      this.activeJobs--;
    }
  }
}
