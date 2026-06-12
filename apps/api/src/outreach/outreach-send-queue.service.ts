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

/**
 * BullMQ queue dedicated to consuming APPROVED OutreachArtifact rows and
 * actually delivering the message. Kept separate from the agent-runs queue
 * because send-on-approve is a distinct concern with its own retry/backoff
 * semantics and worker lifecycle.
 */

export interface EnqueueOutreachSendInput {
  readonly artifactId: string;
  readonly orgId: string;
}

export const OUTREACH_SEND_QUEUE_NAME = "outreach-send";

/** Cadence for refreshing the bullmq_queue_depth gauge (GO-LIVE GL9). */
export const QUEUE_DEPTH_POLL_INTERVAL_MS = 30_000;

const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 5_000 },
  removeOnComplete: { age: 24 * 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600, count: 5000 },
};

@Injectable()
export class OutreachSendQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutreachSendQueueService.name);

  private bullQueue: Queue | null = null;
  private connection: ConnectionOptions | null = null;
  private depthPollHandle: ReturnType<typeof setInterval> | null = null;

  /**
   * MetricsService is @Optional so bare `new OutreachSendQueueService()` in
   * unit tests still constructs. Under Nest DI it resolves to the single
   * global MetricsService instance (ObservabilityModule is @Global).
   */
  constructor(@Optional() private readonly metrics?: MetricsService) {
    this.connection = buildRedisConnectionOptions();

    if (this.connection) {
      this.bullQueue = new Queue(OUTREACH_SEND_QUEUE_NAME, {
        connection: this.connection,
      });
      this.logger.log(
        `OutreachSendQueueService connected to Redis (BullMQ mode, queue=${OUTREACH_SEND_QUEUE_NAME})`,
      );
    } else if (process.env.NODE_ENV === "production") {
      throw new Error(
        "REDIS_URL (or REDIS_HOST) is required in production. " +
          "Refusing to start outreach-send queue with no Redis backing.",
      );
    } else {
      this.logger.warn(
        `REDIS_URL not set — outreach-send falls back to DB polling (dev only)`,
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

  getBullQueue(): Queue | null {
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
      queueName: OUTREACH_SEND_QUEUE_NAME,
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
   * never thrown — metrics polling must not destabilize the send path.
   */
  async refreshQueueDepthMetrics(): Promise<void> {
    if (!this.metrics) return;
    try {
      const stats = await this.getQueueStats();
      if (!stats) return;
      publishQueueDepth(this.metrics, stats, { logger: this.logger });
    } catch (err) {
      this.logger.warn(
        `queue depth refresh failed for ${OUTREACH_SEND_QUEUE_NAME}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Enqueue an APPROVED artifact for delivery. Uses the artifact id as the
   * BullMQ jobId so duplicate enqueues (e.g. re-approving the same row
   * defensively) collapse to a single job rather than spawning multiple sends.
   */
  async enqueue(input: EnqueueOutreachSendInput): Promise<void> {
    if (!this.bullQueue) {
      // In-memory fallback path: the worker polls the DB directly, so no
      // enqueue work is needed here.
      return;
    }

    await this.bullQueue.add(
      "send-outreach",
      { artifactId: input.artifactId, orgId: input.orgId },
      { jobId: input.artifactId, ...DEFAULT_JOB_OPTIONS },
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
