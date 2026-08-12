import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { Queue, JobsOptions, ConnectionOptions } from "bullmq";
import type { QueueStats } from "../observability/metrics/metrics.service";

export interface QueueJob {
  id: string;
  agentId: string;
  orgId: string;
  runId: string;
  status: "queued" | "processing" | "completed" | "failed" | "cancelled";
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  error?: string;
}

export interface EnqueueInput {
  id: string;
  agentId: string;
  orgId: string;
  runId: string;
}

export const RUN_QUEUE_NAME = "agent-runs";

const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 5_000 },
  removeOnComplete: { age: 24 * 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600, count: 5000 },
};

/**
 * Builds BullMQ connection options from env. Returns null when no Redis is
 * configured so dev/test fall back to the in-memory queue. BullMQ uses the
 * options object to create its own ioredis client (avoids ioredis version
 * mismatches when callers also import ioredis directly).
 */
export function buildRedisConnectionOptions(): ConnectionOptions | null {
  const url = process.env.REDIS_URL;
  const host = process.env.REDIS_HOST;

  if (!url && !host) return null;

  const base = {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  };

  if (url) {
    // BullMQ accepts a URL string via the `url` shorthand on ConnectionOptions
    return { ...base, url } as unknown as ConnectionOptions;
  }

  return {
    ...base,
    host: host!,
    port: Number(process.env.REDIS_PORT ?? 6380),
    password: process.env.REDIS_PASSWORD,
    tls: process.env.REDIS_TLS === "false" ? undefined : {},
  } as unknown as ConnectionOptions;
}

@Injectable()
export class QueueService implements OnModuleDestroy {
  private readonly logger = new Logger(QueueService.name);

  // BullMQ-backed members (set when Redis is configured)
  private bullQueue: Queue | null = null;
  private connection: ConnectionOptions | null = null;

  // In-memory fallback (used in dev/tests without Redis)
  private memQueue: QueueJob[] = [];
  private memProcessing = new Map<string, QueueJob>();

  constructor() {
    this.connection = buildRedisConnectionOptions();

    if (this.connection) {
      this.bullQueue = new Queue(RUN_QUEUE_NAME, { connection: this.connection });
      this.logger.log(`QueueService connected to Redis (BullMQ mode)`);
    } else if (process.env.NODE_ENV === "production") {
      throw new Error(
        "REDIS_URL (or REDIS_HOST) is required in production. " +
          "Refusing to start with an in-memory queue.",
      );
    } else {
      this.logger.warn("REDIS_URL not set — using in-memory queue (dev only)");
    }
  }

  isBullMode(): boolean {
    return this.bullQueue !== null;
  }

  /** Returns the underlying BullMQ Queue (for the worker to subscribe to). */
  getBullQueue(): Queue | null {
    return this.bullQueue;
  }

  /** Returns the BullMQ connection options (shared with the Worker). */
  getConnection(): ConnectionOptions | null {
    return this.connection;
  }

  async enqueue(job: EnqueueInput): Promise<QueueJob> {
    const queueJob: QueueJob = {
      ...job,
      status: "queued",
      createdAt: new Date(),
    };

    if (this.bullQueue) {
      await this.bullQueue.add(
        "execute-agent",
        { agentId: job.agentId, orgId: job.orgId, runId: job.runId },
        { jobId: job.id, ...DEFAULT_JOB_OPTIONS },
      );
      return queueJob;
    }

    this.memQueue.push(queueJob);
    return queueJob;
  }

  /** In-memory only: pop the next job. BullMQ Worker bypasses this. */
  dequeue(): QueueJob | null {
    if (this.bullQueue) return null;
    const job = this.memQueue.shift();
    if (job) {
      job.status = "processing";
      job.startedAt = new Date();
      this.memProcessing.set(job.id, job);
    }
    return job || null;
  }

  /** In-memory only. BullMQ tracks completion internally. */
  complete(jobId: string): void {
    if (this.bullQueue) return;
    const job = this.memProcessing.get(jobId);
    if (job) {
      job.status = "completed";
      job.completedAt = new Date();
      this.memProcessing.delete(jobId);
    }
  }

  /** In-memory only. BullMQ tracks failure internally. */
  fail(jobId: string, error: string): void {
    if (this.bullQueue) return;
    const job = this.memProcessing.get(jobId);
    if (job) {
      job.status = "failed";
      job.error = error;
      job.completedAt = new Date();
      this.memProcessing.delete(jobId);
    }
  }

  async cancel(jobId: string): Promise<boolean> {
    if (this.bullQueue) {
      const job = await this.bullQueue.getJob(jobId);
      if (!job) return false;
      try {
        const state = await job.getState();
        if (state === "active") {
          // Active jobs can't be removed mid-flight; mark for failure on next tick.
          // BullMQ doesn't have a "cancel running" primitive — caller (RuntimeService)
          // updates the DB row to CANCELLED and the worker checks status on tool boundaries.
          await job.discard();
        } else {
          await job.remove();
        }
        return true;
      } catch (err) {
        this.logger.warn(`Failed to cancel BullMQ job ${jobId}: ${(err as Error).message}`);
        return false;
      }
    }

    // In-memory cancel
    const idx = this.memQueue.findIndex((j) => j.id === jobId);
    if (idx >= 0) {
      this.memQueue[idx].status = "cancelled";
      this.memQueue.splice(idx, 1);
      return true;
    }
    const job = this.memProcessing.get(jobId);
    if (job) {
      job.status = "cancelled";
      this.memProcessing.delete(jobId);
      return true;
    }
    return false;
  }

  async getStatus(jobId: string): Promise<QueueJob | null> {
    if (this.bullQueue) {
      const job = await this.bullQueue.getJob(jobId);
      if (!job) return null;
      const state = await job.getState();
      const statusMap: Record<string, QueueJob["status"]> = {
        waiting: "queued",
        "waiting-children": "queued",
        delayed: "queued",
        active: "processing",
        completed: "completed",
        failed: "failed",
      };
      return {
        id: job.id ?? jobId,
        agentId: (job.data?.agentId as string) ?? "",
        orgId: (job.data?.orgId as string) ?? "",
        runId: (job.data?.runId as string) ?? "",
        status: statusMap[state] ?? "queued",
        createdAt: new Date(job.timestamp),
        startedAt: job.processedOn ? new Date(job.processedOn) : undefined,
        completedAt: job.finishedOn ? new Date(job.finishedOn) : undefined,
        error: job.failedReason,
      };
    }

    const queued = this.memQueue.find((j) => j.id === jobId);
    if (queued) return queued;
    return this.memProcessing.get(jobId) || null;
  }

  async getQueueLength(): Promise<number> {
    if (this.bullQueue) {
      return this.bullQueue.getWaitingCount();
    }
    return this.memQueue.length;
  }

  async getProcessingCount(): Promise<number> {
    if (this.bullQueue) {
      return this.bullQueue.getActiveCount();
    }
    return this.memProcessing.size;
  }

  /** Point-in-time stats used by the worker readiness probe. */
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
      queueName: RUN_QUEUE_NAME,
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      delayed: counts.delayed ?? 0,
      failed: counts.failed ?? 0,
      completed: counts.completed ?? 0,
      workerCount: workers.length,
    };
  }

  async onModuleDestroy() {
    await this.bullQueue?.close();
  }
}
