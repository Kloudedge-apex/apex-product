import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from "@nestjs/common";
import { Queue, JobsOptions, ConnectionOptions } from "bullmq";
import { buildRedisConnectionOptions } from "../runtime/queue.service";
import {
  MetricsService,
  QueueStats,
  publishQueueDepth,
} from "../observability/metrics/metrics.service";
import {
  ProductionBootstrapWriterFenceService,
  runWithProductionBootstrapWriterFence,
} from "../ops/production-bootstrap-writer-fence";

/**
 * BullMQ queue dedicated to driving LangGraph pipeline runs to the next
 * checkpoint. Kept separate from the agent-runs / outreach-send queues so the
 * graph supervisor has its own retry / backoff envelope and worker lifecycle.
 *
 * The job payload is only a fenced pointer to GraphRun. Canonical first-start
 * input and pending HITL decisions live on GraphRun; checkpoint state lives in
 * GraphCheckpoint / GraphCheckpointWrite. Redis is transport, never truth.
 */

export interface EnqueueGraphRunInput {
  readonly graphRunId: string;
  readonly orgId: string;
  readonly dispatchGeneration: number;
}

export interface GraphRunJobData {
  readonly graphRunId: string;
  readonly orgId: string;
  readonly dispatchGeneration: number;
}

export const GRAPH_RUN_QUEUE_NAME = "graph-runs";

/** Cadence for refreshing the bullmq_queue_depth gauge (GO-LIVE GL9). */
export const QUEUE_DEPTH_POLL_INTERVAL_MS = 30_000;

const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 5_000 },
  removeOnComplete: { age: 24 * 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600, count: 5000 },
};

/**
 * BullMQ retains completed jobs for 24 hours. A monotonic durable generation
 * makes every later resume/recovery id fresh while remaining deterministic
 * across duplicate publication attempts for the same lifecycle phase.
 */
export function graphRunDispatchJobId(
  graphRunId: string,
  dispatchGeneration: number,
): string {
  if (
    !Number.isSafeInteger(dispatchGeneration) ||
    dispatchGeneration < 0
  ) {
    throw new Error("GraphRun dispatchGeneration must be a non-negative integer");
  }
  // BullMQ rejects ':' in custom ids; hyphens are safe.
  return `${graphRunId}-dispatch-${dispatchGeneration}`;
}

@Injectable()
export class GraphRunQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GraphRunQueueService.name);

  private bullQueue: Queue<GraphRunJobData> | null = null;
  private connection: ConnectionOptions | null = null;
  private depthPollHandle: ReturnType<typeof setInterval> | null = null;

  /**
   * MetricsService is @Optional so bare `new GraphRunQueueService()` in unit
   * tests (and any module that provides this class without the @Global
   * ObservabilityModule) still constructs. Under Nest DI it resolves to the
   * single global MetricsService instance.
   */
  constructor(
    @Optional() private readonly metrics?: MetricsService,
    @Optional()
    private readonly productionBootstrapWriterFence?: ProductionBootstrapWriterFenceService,
  ) {
    this.connection = buildRedisConnectionOptions();

    if (this.connection) {
      this.bullQueue = new Queue<GraphRunJobData>(GRAPH_RUN_QUEUE_NAME, {
        connection: this.connection,
      });
      this.logger.log(
        `GraphRunQueueService connected to Redis (BullMQ mode, queue=${GRAPH_RUN_QUEUE_NAME})`,
      );
    } else if (process.env.NODE_ENV === "production") {
      throw new Error(
        "REDIS_URL (or REDIS_HOST) is required in production. " +
          "Refusing to start graph-runs queue with no Redis backing.",
      );
    } else {
      this.logger.warn(
        `REDIS_URL not set — graph-runs falls back to DB polling (dev only)`,
      );
    }
  }

  /**
   * GO-LIVE GL9: keep the bullmq_queue_depth gauge real. Runs in EVERY
   * process that constructs this service (api + worker) — a BullMQ Queue
   * producer can read counts from Redis without consuming jobs. No-op when
   * Redis is absent (dev fallback) or when MetricsService was not injected
   * (bare unit-test construction). The handle is unref()'d so a poller never
   * keeps a shutting-down process alive.
   */
  onModuleInit(): void {
    if (!this.bullQueue || !this.metrics) return;
    this.depthPollHandle = setInterval(
      () => void this.refreshQueueDepthMetrics(),
      QUEUE_DEPTH_POLL_INTERVAL_MS,
    );
    this.depthPollHandle.unref();
    // Prime at boot so /api/metrics is meaningful before the first tick.
    void this.refreshQueueDepthMetrics();
  }

  isBullMode(): boolean {
    return this.bullQueue !== null;
  }

  getBullQueue(): Queue<GraphRunJobData> | null {
    return this.bullQueue;
  }

  getConnection(): ConnectionOptions | null {
    return this.connection;
  }

  /**
   * Point-in-time queue stats for the depth gauge and /api/health/worker.
   * Returns null in the dev DB-polling fallback (no Redis), in which case
   * consumer health is not assessable from queue counts.
   */
  async getQueueStats(): Promise<QueueStats | null> {
    if (!this.bullQueue) return null;
    const [counts, workers] = await Promise.all([
      this.bullQueue.getJobCounts(
        "waiting",
        "active",
        "delayed",
        "failed",
        "completed",
      ),
      this.bullQueue.getWorkers(),
    ]);
    return {
      queueName: GRAPH_RUN_QUEUE_NAME,
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      delayed: counts.delayed ?? 0,
      failed: counts.failed ?? 0,
      completed: counts.completed ?? 0,
      workerCount: workers.length,
    };
  }

  /**
   * One gauge refresh pass. Public so tests (and ops debugging) can drive it
   * deterministically without waiting on the interval. Failures are logged,
   * never thrown — metrics polling must not destabilize the process.
   */
  async refreshQueueDepthMetrics(): Promise<void> {
    if (!this.metrics) return;
    try {
      const stats = await this.getQueueStats();
      if (!stats) return;
      publishQueueDepth(this.metrics, stats, { logger: this.logger });
    } catch (err) {
      this.logger.warn(
        `queue depth refresh failed for ${GRAPH_RUN_QUEUE_NAME}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Enqueue a fenced GraphRun pointer. Duplicate publications of one durable
   * generation collapse; a later resume/recovery uses a different generation
   * and therefore cannot collide with a completed job retained by BullMQ.
   */
  async enqueueGraphRun(input: EnqueueGraphRunInput): Promise<void> {
    await runWithProductionBootstrapWriterFence(
      this.productionBootstrapWriterFence,
      "queue-producer",
      async () => {
        if (!this.bullQueue) {
          // In-memory fallback path: the worker polls the DB directly for ACTIVE
          // GraphRuns whose updatedAt is stale, so no enqueue work is needed here.
          return;
        }

        const data: GraphRunJobData = {
          graphRunId: input.graphRunId,
          orgId: input.orgId,
          dispatchGeneration: input.dispatchGeneration,
        };
        const jobId = graphRunDispatchJobId(
          input.graphRunId,
          input.dispatchGeneration,
        );

        await this.bullQueue.add("process-graph-run", data, {
          jobId,
          ...DEFAULT_JOB_OPTIONS,
        });
      },
    );
  }

  async onModuleDestroy() {
    if (this.depthPollHandle) {
      clearInterval(this.depthPollHandle);
      this.depthPollHandle = null;
    }
    await this.bullQueue?.close();
  }
}
