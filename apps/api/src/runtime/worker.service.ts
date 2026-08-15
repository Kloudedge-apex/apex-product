import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  Optional,
} from "@nestjs/common";
import { Job, Worker } from "bullmq";
import { PrismaService } from "../prisma/prisma.service";
import { QueueService, RUN_QUEUE_NAME } from "./queue.service";
import { ExecutorService } from "./executor.service";
import {
  productionBootstrapWorkerMayActivate,
  ProductionBootstrapWriterFenceService,
  runWithProductionBootstrapWriterFence,
  runWithProductionBootstrapWriterFenceOrSkipClosed,
} from "../ops/production-bootstrap-writer-fence";

const PRODUCTION_BOOTSTRAP_ACTIVATION_POLL_MS = 1_000;

interface RunJobData {
  agentId: string;
  orgId: string;
  runId: string;
}

/**
 * Strict gating: only "true" (case-sensitive) enables the worker. Any other
 * value, including unset, keeps it off. Defaults to disabled so an API
 * container does not start consuming jobs unless explicitly opted in.
 */
export function isWorkerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.WORKER_ENABLED === "true";
}

@Injectable()
export class WorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorkerService.name);

  // BullMQ worker (used when REDIS_URL is configured)
  private bullWorker: Worker<RunJobData> | null = null;
  private activationIntervalHandle: ReturnType<typeof setInterval> | null = null;
  private activationProbeInFlight = false;

  // In-memory polling (used when no Redis is configured)
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private activeJobs = 0;
  private readonly maxConcurrency = Number(process.env.RUN_WORKER_CONCURRENCY ?? 5);

  constructor(
    private prisma: PrismaService,
    private queue: QueueService,
    private executor: ExecutorService,
    @Optional()
    private readonly productionBootstrapWriterFence?: ProductionBootstrapWriterFenceService,
  ) {}

  async onModuleInit() {
    if (!isWorkerEnabled()) {
      this.logger.log("Worker disabled in this process (set WORKER_ENABLED=true to enable)");
      return;
    }

    const startup = await runWithProductionBootstrapWriterFenceOrSkipClosed(
      this.productionBootstrapWriterFence,
      "recovery",
      () => this.recoverOrphanedRuns(),
    );
    if (!startup.ran) {
      this.logger.log(
        "Worker startup recovery skipped by the production bootstrap writer fence",
      );
    }

    if (this.queue.isBullMode()) {
      if (!this.queue.getConnection()) {
        throw new Error("BullMQ mode reported true but Redis connection missing");
      }
      if (!startup.ran) {
        this.logger.log(
          "Worker remains dormant until the guarded production bootstrap epoch is OPEN",
        );
        this.scheduleActivationProbe();
      } else {
        this.startBullWorker();
      }
    } else {
      this.intervalHandle = setInterval(
        () => this.runTimerTask("in-memory poll", () => this.processNext()),
        2000,
      );
      this.logger.log(
        `Worker enabled with concurrency=${this.maxConcurrency} (in-memory polling, no Redis)`,
      );
    }
  }

  async onModuleDestroy() {
    if (this.activationIntervalHandle) {
      clearInterval(this.activationIntervalHandle);
      this.activationIntervalHandle = null;
    }
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    if (this.bullWorker) {
      await this.bullWorker.close();
      this.bullWorker = null;
    }
  }

  private scheduleActivationProbe(): void {
    if (this.activationIntervalHandle) return;
    this.activationIntervalHandle = setInterval(
      () =>
        this.runTimerTask("bootstrap activation probe", () =>
          this.probeBullWorkerActivation(),
        ),
      PRODUCTION_BOOTSTRAP_ACTIVATION_POLL_MS,
    );
    this.activationIntervalHandle.unref?.();
  }

  private runTimerTask(
    label: string,
    operation: () => Promise<unknown>,
  ): void {
    void operation().catch((error) => {
      this.logger.error(
        `Worker ${label} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }

  private async probeBullWorkerActivation(): Promise<void> {
    if (this.bullWorker || this.activationProbeInFlight) return;
    this.activationProbeInFlight = true;
    try {
      if (
        !(await productionBootstrapWorkerMayActivate(
          this.productionBootstrapWriterFence,
        ))
      ) {
        return;
      }
      const recovery = await runWithProductionBootstrapWriterFenceOrSkipClosed(
        this.productionBootstrapWriterFence,
        "recovery",
        () => this.recoverOrphanedRuns(),
      );
      if (!recovery.ran) return;
      this.startBullWorker();
      if (this.activationIntervalHandle) {
        clearInterval(this.activationIntervalHandle);
        this.activationIntervalHandle = null;
      }
    } catch (error) {
      this.logger.warn(
        `Worker activation remains fail-closed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      this.activationProbeInFlight = false;
    }
  }

  private startBullWorker(): void {
    if (this.bullWorker) return;
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
      `Worker enabled with concurrency=${this.maxConcurrency} (BullMQ, queue=${RUN_QUEUE_NAME})`,
    );
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
    await runWithProductionBootstrapWriterFence(
      this.productionBootstrapWriterFence,
      "agent-worker",
      () => this.runAgent(agentId, runId),
    );
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
      await runWithProductionBootstrapWriterFence(
        this.productionBootstrapWriterFence,
        "agent-worker",
        () => this.runAgent(job.agentId, job.runId),
      );
      this.queue.complete(job.id);
    } catch (error) {
      this.queue.fail(job.id, error instanceof Error ? error.message : "unknown");
    } finally {
      this.activeJobs--;
    }
  }
}
