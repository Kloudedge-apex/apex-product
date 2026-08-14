import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  Optional,
} from "@nestjs/common";
import { Job, Worker } from "bullmq";
import { GraphRunStatus } from "@prisma/client";
import { Command } from "@langchain/langgraph";
import { PrismaService } from "../prisma/prisma.service";
import { GraphService } from "./graph.service";
import {
  GraphRunJobData,
  GraphRunQueueService,
  GRAPH_RUN_QUEUE_NAME,
} from "./graph-run-queue.service";
import { MetricsService, METRIC } from "../observability/metrics/metrics.service";
import {
  productionBootstrapWorkerMayActivate,
  ProductionBootstrapWriterFenceService,
  runWithProductionBootstrapWriterFence,
  runWithProductionBootstrapWriterFenceOrSkipClosed,
} from "../ops/production-bootstrap-writer-fence";

/**
 * Strict gating: only "true" enables this worker. Defaults off so an API
 * container won't start dispatching graph runs unless explicitly opted in.
 * Mirrors `OUTREACH_WORKER_ENABLED` semantics so the graph-runs worker and
 * other workers can be deployed in separate processes.
 */
export function isGraphRunWorkerEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.GRAPH_RUN_WORKER_ENABLED === "true";
}

const IN_MEMORY_POLL_INTERVAL_MS = 5_000;
const IN_MEMORY_ORPHAN_AGE_MS = 30_000;
const GRAPH_RUN_HEARTBEAT_INTERVAL_MS = 30_000;
export const GRAPH_RUN_RECOVERY_SWEEP_INTERVAL_MS = 60_000;
// Audit LGS-04: 10 minutes, up from 60s. lastActivityAt is a dedicated
// mutable worker/recovery clock; startedAt remains the immutable business
// start time shown in the product and used for elapsed-duration calculations.
const BOOT_ORPHAN_AGE_MS = 600_000;
const BOOT_RECOVERY_LIMIT = 100;
const IN_MEMORY_BATCH_SIZE = 10;
const BULL_CONCURRENCY = 5;
const BULL_ATTEMPTS = 3;
const PRODUCTION_BOOTSTRAP_ACTIVATION_POLL_MS = 1_000;

/**
 * LangGraph resume sentinel: invoking a compiled graph with `null` input
 * means "seed nothing — continue from the last persisted checkpoint".
 * GraphService.processGraphRun forwards its input verbatim to
 * `compiled.invoke()` (and only inspects it via `instanceof Command`, which
 * is null-safe), but its signature predates the recovery path and does not
 * admit `null` — hence the cast. Widening that signature lives in
 * graph.service.ts, which is out of scope this week.
 */
const RESUME_FROM_CHECKPOINT = null as unknown as Parameters<
  GraphService["processGraphRun"]
>[1];

/**
 * Worker that drives queued GraphRun jobs through GraphService.processGraphRun.
 *
 * Two modes:
 *  - BullMQ mode (when Redis is configured): subscribes to the graph-runs
 *    queue with concurrency=5, attempts=3, exponential backoff. On terminal
 *    failure (all attempts exhausted) flips GraphRun.status to FAILED with
 *    the error note.
 *  - In-memory fallback (dev/test without Redis): polls Prisma every 5s for
 *    RUNNING GraphRuns whose lastActivityAt is older than 30s — i.e. orphans the
 *    crash-recovery sweep already enqueued in BullMQ mode but the local
 *    worker has to catch on its own.
 *
 * Either way, boot and recurrent crash-recovery sweeps inspect stale RUNNING
 * rows. Each claim increments GraphRun.dispatchGeneration, producing a fresh
 * deterministic job id that cannot collide with a retained completed job.
 * The worker derives the correct invocation from durable database state:
 * pending decision, existing checkpoint, or canonical first-start seed.
 */
@Injectable()
export class GraphRunWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GraphRunWorker.name);

  private bullWorker: Worker<GraphRunJobData> | null = null;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private recoveryIntervalHandle: ReturnType<typeof setInterval> | null = null;
  private activationIntervalHandle: ReturnType<typeof setInterval> | null = null;
  private activationProbeInFlight = false;
  private inFlight = false;
  private recoverySweepInFlight = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: GraphRunQueueService,
    private readonly graphService: GraphService,
    @Optional() private readonly metrics?: MetricsService,
    @Optional()
    private readonly productionBootstrapWriterFence?: ProductionBootstrapWriterFenceService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!isGraphRunWorkerEnabled()) {
      this.logger.log(
        "GraphRunWorker disabled (set GRAPH_RUN_WORKER_ENABLED=true to enable)",
      );
      return;
    }

    // Validate the epoch before deciding whether this revision may attach a
    // consumer. CLOSED candidates stay alive but create no BullMQ Worker, so
    // even loss of BullMQ's pause key cannot claim or burn a queued attempt.
    const startup = await runWithProductionBootstrapWriterFenceOrSkipClosed(
      this.productionBootstrapWriterFence,
      "graph-worker",
      async () => undefined,
    );
    if (this.queue.isBullMode()) {
      if (!this.queue.getConnection()) {
        throw new Error(
          "GraphRunQueueService reported BullMQ mode but connection missing",
        );
      }
      if (!startup.ran) {
        this.logger.log(
          "GraphRunWorker remains dormant until the guarded production bootstrap epoch is OPEN",
        );
        this.scheduleActivationProbe();
      } else {
        this.startBullWorker();
      }
    } else {
      this.intervalHandle = setInterval(
        () =>
          this.runTimerTask("in-memory poll", () => this.pollInMemory()),
        IN_MEMORY_POLL_INTERVAL_MS,
      );
      this.logger.log(
        `GraphRunWorker enabled (in-memory polling every ${IN_MEMORY_POLL_INTERVAL_MS}ms, orphan-age=${IN_MEMORY_ORPHAN_AGE_MS}ms)`,
      );
    }

    // Recovery cannot be boot-only: a Redis add may fail after this process
    // has already started, and a worker can disappear between deploys. Keep a
    // bounded periodic sweep in every explicitly enabled worker process.
    this.recoveryIntervalHandle = setInterval(
      () =>
        this.runTimerTask("recurring recovery sweep", () =>
          this.runRecoverySweep("Recurring"),
        ),
      GRAPH_RUN_RECOVERY_SWEEP_INTERVAL_MS,
    );
    this.recoveryIntervalHandle.unref?.();
    await this.runRecoverySweep("Boot");
  }

  async onModuleDestroy(): Promise<void> {
    if (this.activationIntervalHandle) {
      clearInterval(this.activationIntervalHandle);
      this.activationIntervalHandle = null;
    }
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    if (this.recoveryIntervalHandle) {
      clearInterval(this.recoveryIntervalHandle);
      this.recoveryIntervalHandle = null;
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
        `GraphRunWorker ${label} failed: ${
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
      await this.runRecoverySweep("Post-bootstrap");
      this.startBullWorker();
      if (this.activationIntervalHandle) {
        clearInterval(this.activationIntervalHandle);
        this.activationIntervalHandle = null;
      }
    } catch (error) {
      this.logger.warn(
        `GraphRunWorker activation remains fail-closed: ${
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
      throw new Error(
        "GraphRunQueueService reported BullMQ mode but connection missing",
      );
    }
    this.bullWorker = new Worker<GraphRunJobData>(
      GRAPH_RUN_QUEUE_NAME,
      async (job) => this.handleJob(job),
      { connection, concurrency: BULL_CONCURRENCY },
    );
    this.bullWorker.on("failed", async (job, err) => {
      this.logger.error(
        `Graph run job ${job?.id} failed: ${err.message} (attempt ${job?.attemptsMade}/${job?.opts?.attempts ?? "?"})`,
      );
      this.metrics?.inc(METRIC.BULLMQ_FAILED_JOBS_TOTAL, {
        queue: GRAPH_RUN_QUEUE_NAME,
      });
      const attempts = job?.opts?.attempts ?? BULL_ATTEMPTS;
      if (job && job.attemptsMade >= attempts) {
        await this.markTerminalFailure(
          job.data.graphRunId,
          job.data.dispatchGeneration,
          err.message,
        );
      }
    });
    this.bullWorker.on("error", (err) => {
      this.logger.error(`GraphRun BullMQ worker error: ${err.message}`);
    });
    this.logger.log(
      `GraphRunWorker enabled (BullMQ, queue=${GRAPH_RUN_QUEUE_NAME}, concurrency=${BULL_CONCURRENCY})`,
    );
  }

  /** BullMQ entrypoint. Throws to let BullMQ record failure + retry. */
  private async handleJob(job: Job<GraphRunJobData>): Promise<void> {
    await this.processGraphRun(job.data);
  }

  /**
   * In-memory polling fallback. Used when REDIS_URL is unset (dev/test).
   * Loads up to IN_MEMORY_BATCH_SIZE orphaned RUNNING GraphRuns per tick.
   * Single-flight via `inFlight` so overlapping intervals don't double-process.
   */
  private async pollInMemory(): Promise<void> {
    await runWithProductionBootstrapWriterFenceOrSkipClosed(
      this.productionBootstrapWriterFence,
      "graph-worker",
      () => this.pollInMemoryWithLease(),
    );
  }

  private async pollInMemoryWithLease(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const cutoff = new Date(Date.now() - IN_MEMORY_ORPHAN_AGE_MS);
      const orphans = await this.prisma.graphRun.findMany({
        where: {
          status: GraphRunStatus.RUNNING,
          lastActivityAt: { lt: cutoff },
        },
        orderBy: [{ lastActivityAt: "asc" }, { id: "asc" }],
        take: IN_MEMORY_BATCH_SIZE,
      });
      for (const run of orphans) {
        try {
          const claimed = await this.prisma.graphRun.updateMany({
            where: {
              id: run.id,
              status: GraphRunStatus.RUNNING,
              lastActivityAt: { lt: cutoff },
              dispatchGeneration: run.dispatchGeneration,
            },
            data: {
              lastActivityAt: new Date(),
              dispatchGeneration: { increment: 1 },
            },
          });
          if (claimed.count === 0) continue;

          // The pointer contains no business payload. processGraphRun re-reads
          // the now-incremented generation and derives start/checkpoint/resume
          // intent from the durable row.
          await this.processGraphRun({
            graphRunId: run.id,
            orgId: run.orgId,
            dispatchGeneration: run.dispatchGeneration + 1,
          });
        } catch (err) {
          this.logger.warn(
            `In-memory recovery failed for run ${run.id}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    } catch (err) {
      this.logger.error(
        `In-memory poll failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * Core idempotent processing path. Re-reads the GraphRun, aborts unless it
   * is still RUNNING, then drives GraphService.processGraphRun.
   *
   * Idempotency hinges on PrismaCheckpointSaver: re-invoking with the same
   * thread_id (== graphRunId) picks up from the last persisted checkpoint
   * regardless of how many times the job is retried. Re-runs against rows
   * that already moved to COMPLETED / AWAITING_APPROVAL / FAILED / CANCELLED
   * are no-ops (early return).
   */
  async processGraphRun(data: GraphRunJobData): Promise<void> {
    await runWithProductionBootstrapWriterFence(
      this.productionBootstrapWriterFence,
      "graph-worker",
      () => this.processGraphRunWithLease(data),
    );
  }

  private async processGraphRunWithLease(data: GraphRunJobData): Promise<void> {
    const run = await this.prisma.graphRun.findUnique({
      where: { id: data.graphRunId },
    });
    if (!run) {
      this.logger.warn(`GraphRun ${data.graphRunId} not found — skipping`);
      return;
    }
    if (run.orgId !== data.orgId) {
      this.logger.warn(
        `GraphRun ${data.graphRunId} org mismatch (expected ${data.orgId}, got ${run.orgId}) — skipping`,
      );
      return;
    }
    if (run.status !== GraphRunStatus.RUNNING) {
      // Idempotency guard: COMPLETED / FAILED / CANCELLED / AWAITING_APPROVAL
      // rows are not re-driven. The HITL resume path explicitly transitions
      // AWAITING_APPROVAL → RUNNING before enqueuing, so by the time the
      // worker sees a resume job the row is RUNNING again.
      this.logger.log(
        `GraphRun ${data.graphRunId} is ${run.status} — already processed, skipping`,
      );
      return;
    }
    if (run.dispatchGeneration !== data.dispatchGeneration) {
      this.logger.log(
        `GraphRun ${data.graphRunId} dispatch ${data.dispatchGeneration} is stale; current generation is ${run.dispatchGeneration}`,
      );
      return;
    }

    // A pending boolean is the durable resume discriminator. In particular,
    // false means a real reviewer rejection and must not be mistaken for an
    // absent decision.
    if (typeof run.pendingResumeApproved === "boolean") {
      const decision: { approved: boolean; approvedBy?: string } = {
        approved: run.pendingResumeApproved,
      };
      if (run.pendingResumeApprovedBy) {
        decision.approvedBy = run.pendingResumeApprovedBy;
      }
      await this.driveWithHeartbeat(run.id, data.dispatchGeneration, () =>
        this.graphService.processGraphRun(
          run.id,
          new Command({ resume: decision }),
          data.dispatchGeneration,
        ),
      );
      // Clear only the generation we just drove. A stale worker can never
      // erase a newer reviewer decision.
      await this.prisma.graphRun.updateMany({
        where: {
          id: run.id,
          dispatchGeneration: data.dispatchGeneration,
          pendingResumeApproved: run.pendingResumeApproved,
        },
        data: {
          pendingResumeApproved: null,
          pendingResumeApprovedBy: null,
        },
      });
      return;
    }

    // Once any checkpoint exists, never replay the first-start seed. Null is
    // LangGraph's checkpoint-continuation contract and preserves partial work.
    const checkpoint = await this.prisma.graphCheckpoint.findFirst({
      where: { threadId: run.threadId },
      select: { checkpointId: true },
    });
    if (checkpoint) {
      await this.driveWithHeartbeat(run.id, data.dispatchGeneration, () =>
        this.graphService.processGraphRun(
          run.id,
          RESUME_FROM_CHECKPOINT,
          data.dispatchGeneration,
        ),
      );
      return;
    }

    // No checkpoint means the first invocation was never durably entered
    // (for example Redis enqueue failed). Use only the canonical stored seed.
    // Legacy rows backfilled with [] cannot be reconstructed safely.
    if (run.startIcpProfileIds.length === 0) {
      throw new Error(
        `GraphRun ${run.id} has no checkpoint or durable start ICP input`,
      );
    }
    await this.driveWithHeartbeat(run.id, data.dispatchGeneration, () =>
      this.graphService.processGraphRun(
        run.id,
        {
          orgId: run.orgId,
          runId: run.id,
          icpProfileIds: [...run.startIcpProfileIds],
        },
        data.dispatchGeneration,
      ),
    );
  }

  /** Run one boot/periodic sweep without allowing interval overlap. */
  async runRecoverySweep(source = "Recurring"): Promise<number> {
    const result = await runWithProductionBootstrapWriterFenceOrSkipClosed(
      this.productionBootstrapWriterFence,
      "recovery",
      () => this.runRecoverySweepWithLease(source),
    );
    return result.ran ? result.value : 0;
  }

  private async runRecoverySweepWithLease(source: string): Promise<number> {
    if (this.recoverySweepInFlight) return 0;
    this.recoverySweepInFlight = true;
    try {
      const recovered = await this.recoverOrphanedRuns();
      if (recovered > 0) {
        this.logger.log(
          `${source} recovery: re-enqueued ${recovered} orphaned graph run(s)`,
        );
      }
      return recovered;
    } catch (err) {
      this.logger.error(
        `${source} recovery sweep failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return 0;
    } finally {
      this.recoverySweepInFlight = false;
    }
  }

  /**
   * Boot/periodic sweep: find RUNNING GraphRuns whose lastActivityAt is older
   * than BOOT_ORPHAN_AGE_MS, atomically claim each one, and re-enqueue it.
   * Capped at BOOT_RECOVERY_LIMIT to avoid a thundering herd if a long-down
   * deploy comes back up. Returns the count of re-enqueued runs.
   *
   * Audit LGS-04: the claim is an updateMany that re-asserts RUNNING +
   * staleness and bumps lastActivityAt forward in the same statement, so when
   * several pods boot concurrently exactly one wins each run — the losers'
   * claims match 0 rows because the winner already refreshed lastActivityAt.
   *
   * Exposed (public) so tests can drive it deterministically without having
   * to spin up the BullMQ worker.
   */
  async recoverOrphanedRuns(): Promise<number> {
    return runWithProductionBootstrapWriterFence(
      this.productionBootstrapWriterFence,
      "recovery",
      () => this.recoverOrphanedRunsWithLease(),
    );
  }

  private async recoverOrphanedRunsWithLease(): Promise<number> {
    const cutoff = new Date(Date.now() - BOOT_ORPHAN_AGE_MS);
    const orphans = await this.prisma.graphRun.findMany({
      where: {
        status: GraphRunStatus.RUNNING,
        lastActivityAt: { lt: cutoff },
      },
      orderBy: [{ lastActivityAt: "asc" }, { id: "asc" }],
      take: BOOT_RECOVERY_LIMIT,
    });

    let count = 0;
    for (const run of orphans) {
      try {
        // Atomic claim. lastActivityAt is the run's mutable activity anchor,
        // so bumping it here simultaneously (a) voids any concurrent pod's claim and
        // (b) grants the recovered run a fresh BOOT_ORPHAN_AGE_MS grace
        // window before the next sweep may touch it. count === 0 means
        // another pod won, or the run progressed (resumed / went terminal)
        // between our read and this write — either way it is not ours.
        const claimed = await this.prisma.graphRun.updateMany({
          where: {
            id: run.id,
            status: GraphRunStatus.RUNNING,
            lastActivityAt: { lt: cutoff },
            dispatchGeneration: run.dispatchGeneration,
          },
          data: {
            lastActivityAt: new Date(),
            dispatchGeneration: { increment: 1 },
          },
        });
        if (claimed.count === 0) continue;

        await this.queue.enqueueGraphRun({
          graphRunId: run.id,
          orgId: run.orgId,
          dispatchGeneration: run.dispatchGeneration + 1,
        });
        count++;
      } catch (err) {
        // If enqueue fails after the claim, the row still carries the newer
        // generation and all canonical payload. A later recurrent sweep can
        // increment again and publish a fresh id safely.
        this.logger.warn(
          `Failed to re-enqueue orphaned run ${run.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    return count;
  }

  /**
   * Keep the recovery lease fresh while a graph is actively executing.
   * The status guard prevents a late interval tick from touching a terminal
   * row. Heartbeat failure is logged but does not cancel the graph invocation;
   * the invocation's own database work remains the authoritative outcome.
   */
  private async driveWithHeartbeat(
    graphRunId: string,
    dispatchGeneration: number,
    drive: () => Promise<void>,
  ): Promise<void> {
    await this.touchActivity(graphRunId, dispatchGeneration);
    const heartbeat = setInterval(() => {
      void this.touchActivity(graphRunId, dispatchGeneration).catch((err) => {
        this.logger.warn(
          `GraphRun ${graphRunId} heartbeat failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    }, GRAPH_RUN_HEARTBEAT_INTERVAL_MS);
    heartbeat.unref?.();

    try {
      await drive();
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async touchActivity(
    graphRunId: string,
    dispatchGeneration: number,
  ): Promise<void> {
    await this.prisma.graphRun.updateMany({
      where: {
        id: graphRunId,
        status: GraphRunStatus.RUNNING,
        dispatchGeneration,
      },
      data: { lastActivityAt: new Date() },
    });
  }

  /**
   * Called when BullMQ has exhausted retries. Flip the GraphRun to FAILED if
   * it is still RUNNING — if it raced to COMPLETED / AWAITING_APPROVAL in the
   * meantime, leave it alone.
   */
  private async markTerminalFailure(
    graphRunId: string,
    dispatchGeneration: number,
    reason: string,
  ): Promise<void> {
    try {
      // Fence the failed-event side effect too: a retained/stale BullMQ job
      // must not fail a newer resume or recovery generation.
      await this.prisma.graphRun.updateMany({
        where: {
          id: graphRunId,
          status: GraphRunStatus.RUNNING,
          dispatchGeneration,
        },
        data: {
          status: GraphRunStatus.FAILED,
          completedAt: new Date(),
          error: `auto-failed: ${reason}`.slice(0, 1000),
        },
      });
    } catch (err) {
      this.logger.error(
        `Failed to mark terminal failure for ${graphRunId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
