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
// Audit LGS-04: 10 minutes, up from 60s. `startedAt` is the run's activity
// anchor — it is set on creation AND refreshed by the HITL resume path
// (graph.service.ts, audit P0 #8) — so a freshly-resumed run sits well inside
// this window and the boot sweep cannot race a live resume driving the same
// LangGraph thread_id from another pod. GraphRun has no `updatedAt` column;
// if one is ever added it would be a strictly stronger gate than startedAt.
const BOOT_ORPHAN_AGE_MS = 600_000;
const BOOT_RECOVERY_LIMIT = 100;
const IN_MEMORY_BATCH_SIZE = 10;
const BULL_CONCURRENCY = 5;
const BULL_ATTEMPTS = 3;

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
 *    RUNNING GraphRuns whose startedAt is older than 30s — i.e. orphans the
 *    crash-recovery sweep already enqueued in BullMQ mode but the local
 *    worker has to catch on its own.
 *
 * Either way, onModuleInit runs a one-shot crash-recovery sweep: any
 * GraphRun in RUNNING status whose startedAt is older than 10 minutes gets
 * atomically claimed (updateMany status+staleness guard, audit LGS-04) and
 * re-enqueued (capped at 100 to avoid a thundering herd on a multi-node
 * deploy). Recovery re-enters the graph via a null input so LangGraph
 * resumes from the last persisted checkpoint instead of re-seeding state.
 */
@Injectable()
export class GraphRunWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GraphRunWorker.name);

  private bullWorker: Worker<GraphRunJobData> | null = null;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: GraphRunQueueService,
    private readonly graphService: GraphService,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!isGraphRunWorkerEnabled()) {
      this.logger.log(
        "GraphRunWorker disabled (set GRAPH_RUN_WORKER_ENABLED=true to enable)",
      );
      return;
    }

    if (this.queue.isBullMode()) {
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
        this.metrics?.inc(METRIC.BULLMQ_FAILED_JOBS_TOTAL, { queue: GRAPH_RUN_QUEUE_NAME });
        const attempts = job?.opts?.attempts ?? BULL_ATTEMPTS;
        if (job && job.attemptsMade >= attempts) {
          await this.markTerminalFailure(job.data.graphRunId, err.message);
        }
      });
      this.bullWorker.on("error", (err) => {
        this.logger.error(`GraphRun BullMQ worker error: ${err.message}`);
      });
      this.logger.log(
        `GraphRunWorker enabled (BullMQ, queue=${GRAPH_RUN_QUEUE_NAME}, concurrency=${BULL_CONCURRENCY})`,
      );
    } else {
      this.intervalHandle = setInterval(
        () => this.pollInMemory(),
        IN_MEMORY_POLL_INTERVAL_MS,
      );
      this.logger.log(
        `GraphRunWorker enabled (in-memory polling every ${IN_MEMORY_POLL_INTERVAL_MS}ms, orphan-age=${IN_MEMORY_ORPHAN_AGE_MS}ms)`,
      );
    }

    // One-shot crash-recovery sweep: re-enqueue RUNNING GraphRuns whose
    // startedAt is older than the BOOT_ORPHAN_AGE_MS threshold. These are
    // runs the previous pod was driving when it died — without this sweep
    // they'd sit in RUNNING forever because the in-flight BullMQ job (if
    // any) is gone with the dead worker.
    try {
      const recovered = await this.recoverOrphanedRuns();
      if (recovered > 0) {
        this.logger.log(
          `Crash recovery: re-enqueued ${recovered} orphaned graph run(s)`,
        );
      }
    } catch (err) {
      this.logger.error(
        `Crash recovery sweep failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    if (this.bullWorker) {
      await this.bullWorker.close();
      this.bullWorker = null;
    }
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
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const cutoff = new Date(Date.now() - IN_MEMORY_ORPHAN_AGE_MS);
      const orphans = await this.prisma.graphRun.findMany({
        where: {
          status: GraphRunStatus.RUNNING,
          startedAt: { lt: cutoff },
        },
        orderBy: { startedAt: "asc" },
        take: IN_MEMORY_BATCH_SIZE,
      });
      for (const run of orphans) {
        try {
          // Recovery via the shared processGraphRun path: a "start" job with
          // no icpProfileIds means "resume from checkpoint with null input" —
          // the saved checkpoint (thread_id == graphRunId) already holds the
          // seed, and fabricating one here would clobber it. If a resume is
          // needed (AWAITING_APPROVAL), the user-driven path is what triggers
          // it; the poller never resumes HITL-paused runs (those are filtered
          // out by status above).
          await this.processGraphRun({
            kind: "start",
            graphRunId: run.id,
            orgId: run.orgId,
            // icpProfileIds intentionally undefined — the checkpoint already
            // has them; supplying empty array would clobber.
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

    if (data.kind === "resume") {
      if (!data.resume) {
        throw new Error(
          `GraphRun ${data.graphRunId} resume job missing resume payload`,
        );
      }
      await this.graphService.processGraphRun(
        run.id,
        new Command({ resume: data.resume }),
      );
      return;
    }

    // start: two flavors share this kind.
    //  - Fresh start (runPipelineGraph): carries a non-empty ICP seed and
    //    boots the graph with the static entry state.
    //  - Crash recovery (boot sweep / in-memory poller): carries NO seed.
    //    Re-seeding here would clobber the checkpoint's saved icpProfileIds
    //    AND re-trigger the graph from START instead of continuing where the
    //    dead pod left off — so recovery hands LangGraph a null input and
    //    lets PrismaCheckpointSaver re-hydrate everything from the last
    //    persisted checkpoint. An empty/missing seed can only mean recovery:
    //    runPipelineGraph rejects empty icpProfileIds before enqueueing.
    if (!data.icpProfileIds || data.icpProfileIds.length === 0) {
      await this.graphService.processGraphRun(run.id, RESUME_FROM_CHECKPOINT);
      return;
    }

    await this.graphService.processGraphRun(run.id, {
      orgId: run.orgId,
      runId: run.id,
      icpProfileIds: [...data.icpProfileIds],
    });
  }

  /**
   * One-shot boot sweep: find RUNNING GraphRuns whose startedAt is older
   * than BOOT_ORPHAN_AGE_MS, atomically claim each one, and re-enqueue it.
   * Capped at BOOT_RECOVERY_LIMIT to avoid a thundering herd if a long-down
   * deploy comes back up. Returns the count of re-enqueued runs.
   *
   * Audit LGS-04: the claim is an updateMany that re-asserts RUNNING +
   * staleness and bumps startedAt forward in the same statement, so when
   * several pods boot concurrently exactly one wins each run — the losers'
   * claims match 0 rows because the winner already refreshed startedAt.
   *
   * Exposed (public) so tests can drive it deterministically without having
   * to spin up the BullMQ worker.
   */
  async recoverOrphanedRuns(): Promise<number> {
    const cutoff = new Date(Date.now() - BOOT_ORPHAN_AGE_MS);
    const orphans = await this.prisma.graphRun.findMany({
      where: {
        status: GraphRunStatus.RUNNING,
        startedAt: { lt: cutoff },
      },
      orderBy: { startedAt: "asc" },
      take: BOOT_RECOVERY_LIMIT,
    });

    let count = 0;
    for (const run of orphans) {
      try {
        // Atomic claim. startedAt doubles as the run's activity anchor (the
        // HITL resume path refreshes it too — audit P0 #8), so bumping it
        // here simultaneously (a) voids any concurrent pod's claim and
        // (b) grants the recovered run a fresh BOOT_ORPHAN_AGE_MS grace
        // window before the next sweep may touch it. count === 0 means
        // another pod won, or the run progressed (resumed / went terminal)
        // between our read and this write — either way it is not ours.
        const claimed = await this.prisma.graphRun.updateMany({
          where: {
            id: run.id,
            status: GraphRunStatus.RUNNING,
            startedAt: { lt: cutoff },
          },
          data: { startedAt: new Date() },
        });
        if (claimed.count === 0) continue;

        await this.queue.enqueueGraphRun({
          kind: "start",
          graphRunId: run.id,
          orgId: run.orgId,
          // Empty on purpose: an empty seed marks the job as crash recovery,
          // which processGraphRun turns into a null-input checkpoint resume
          // instead of fabricated entry state (fresh starts are guaranteed a
          // non-empty seed by runPipelineGraph).
          icpProfileIds: [],
        });
        count++;
      } catch (err) {
        // If the enqueue fails after a successful claim, the bumped
        // startedAt defers retry to the next boot sweep / orphan window —
        // safe (the run stays RUNNING) but worth the warn for operators.
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
   * Called when BullMQ has exhausted retries. Flip the GraphRun to FAILED if
   * it is still RUNNING — if it raced to COMPLETED / AWAITING_APPROVAL in the
   * meantime, leave it alone.
   */
  private async markTerminalFailure(
    graphRunId: string,
    reason: string,
  ): Promise<void> {
    try {
      const run = await this.prisma.graphRun.findUnique({
        where: { id: graphRunId },
      });
      if (!run) return;
      if (run.status !== GraphRunStatus.RUNNING) return;

      await this.prisma.graphRun.update({
        where: { id: graphRunId },
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
