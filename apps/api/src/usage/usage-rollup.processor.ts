import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Job, Worker } from "bullmq";
import { UsageService } from "./usage.service";
import { UsageRollupQueue, USAGE_ROLLUP_QUEUE_NAME, type UsageRollupJobData } from "./usage-rollup.queue";

export function isUsageRollupWorkerEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.USAGE_ROLLUP_WORKER_ENABLED === "true";
}

@Injectable()
export class UsageRollupProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(UsageRollupProcessor.name);

  private worker: Worker<UsageRollupJobData> | null = null;

  constructor(
    private readonly queue: UsageRollupQueue,
    private readonly usage: UsageService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!isUsageRollupWorkerEnabled()) {
      this.logger.log(
        "UsageRollupProcessor disabled (set USAGE_ROLLUP_WORKER_ENABLED=true to enable)",
      );
      return;
    }

    if (!this.queue.isBullMode()) {
      this.logger.warn("UsageRollupProcessor not started (no Redis / BullMQ)");
      return;
    }

    const connection = this.queue.getConnection();
    if (!connection) {
      throw new Error("BullMQ mode reported true but Redis connection missing");
    }

    this.worker = new Worker<UsageRollupJobData>(
      USAGE_ROLLUP_QUEUE_NAME,
      async (job) => this.process(job),
      { connection, concurrency: 5 },
    );

    this.worker.on("failed", (job, err) => {
      this.logger.error(`Job ${job?.id ?? "unknown"} failed: ${err.message}`);
    });
    this.worker.on("error", (err) => {
      this.logger.error(`BullMQ worker error: ${err.message}`);
    });

    this.logger.log(`UsageRollupProcessor enabled (queue=${USAGE_ROLLUP_QUEUE_NAME})`);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.worker) {
      await this.worker.close();
      this.worker = null;
    }
  }

  /**
   * Shared execution path used by BullMQ worker and unit tests.
   * Throws on failure so BullMQ records the error and retries.
   */
  async process(job: Job<UsageRollupJobData>): Promise<void> {
    const name = job.name;
    if (name === "rollup-hour") {
      const data = job.data as { orgId: string; hourBucket: string };
      await this.usage.rollupHour({ orgId: data.orgId, hourBucket: new Date(data.hourBucket) });
      return;
    }

    if (name === "rollup-day") {
      const data = job.data as { orgId: string; dayBucket: string };
      await this.usage.rollupDay({ orgId: data.orgId, dayBucket: new Date(data.dayBucket) });
      return;
    }

    this.logger.warn(`Unknown usage rollup job name: ${name}`);
  }
}

