import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { JobsOptions, Queue, type ConnectionOptions } from "bullmq";
import { buildRedisConnectionOptions } from "../runtime/queue.service";

export const USAGE_ROLLUP_QUEUE_NAME = "usage-rollup";

export type UsageRollupJobName = "rollup-hour" | "rollup-day";

export type RollupHourJobData = {
  readonly orgId: string;
  readonly hourBucket: string; // ISO
};

export type RollupDayJobData = {
  readonly orgId: string;
  readonly dayBucket: string; // ISO
};

export type UsageRollupJobData = RollupHourJobData | RollupDayJobData;

const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 10_000 },
  removeOnComplete: { age: 24 * 3600, count: 2000 },
  removeOnFail: { age: 7 * 24 * 3600, count: 10_000 },
};

@Injectable()
export class UsageRollupQueue implements OnModuleDestroy {
  private readonly logger = new Logger(UsageRollupQueue.name);

  private bullQueue: Queue | null = null;
  private connection: ConnectionOptions | null = null;

  constructor() {
    this.connection = buildRedisConnectionOptions();
    if (this.connection) {
      this.bullQueue = new Queue(USAGE_ROLLUP_QUEUE_NAME, {
        connection: this.connection,
      });
      this.logger.log(
        `UsageRollupQueue connected to Redis (BullMQ mode, queue=${USAGE_ROLLUP_QUEUE_NAME})`,
      );
    } else if (process.env.NODE_ENV === "production") {
      throw new Error(
        "REDIS_URL (or REDIS_HOST) is required in production. " +
          "Refusing to start usage-rollup queue with no Redis backing.",
      );
    } else {
      this.logger.warn(
        "REDIS_URL not set — usage-rollup queue disabled (dev only)",
      );
    }
  }

  isBullMode(): boolean {
    return this.bullQueue !== null;
  }

  getConnection(): ConnectionOptions | null {
    return this.connection;
  }

  async enqueueRollupHour(input: { readonly orgId: string; readonly hourBucket: Date }) {
    if (!this.bullQueue) return;
    const hourIso = input.hourBucket.toISOString();
    // BullMQ jobId cannot contain ':' — strip colons from the timestamp.
    const safeIso = hourIso.replace(/:/g, "_");
    await this.bullQueue.add(
      "rollup-hour",
      { orgId: input.orgId, hourBucket: hourIso },
      { jobId: `hour-${input.orgId}-${safeIso}`, ...DEFAULT_JOB_OPTIONS },
    );
  }

  async enqueueRollupDay(input: { readonly orgId: string; readonly dayBucket: Date }) {
    if (!this.bullQueue) return;
    const dayIso = input.dayBucket.toISOString();
    const safeIso = dayIso.replace(/:/g, "_");
    await this.bullQueue.add(
      "rollup-day",
      { orgId: input.orgId, dayBucket: dayIso },
      { jobId: `day-${input.orgId}-${safeIso}`, ...DEFAULT_JOB_OPTIONS },
    );
  }

  async onModuleDestroy() {
    await this.bullQueue?.close();
  }
}

