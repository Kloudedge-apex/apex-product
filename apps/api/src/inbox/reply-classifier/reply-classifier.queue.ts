import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { Queue, JobsOptions, ConnectionOptions } from "bullmq";
import { buildRedisConnectionOptions } from "../../runtime/queue.service";

export interface ReplyClassifierJobData {
  readonly orgId: string;
  readonly replyId: string;
}

export interface EnqueueReplyClassifierInput {
  readonly orgId: string;
  readonly replyId: string;
}

export const REPLY_CLASSIFIER_QUEUE_NAME = "reply-classifier";

const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 5_000 },
  removeOnComplete: { age: 24 * 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600, count: 5000 },
};

@Injectable()
export class ReplyClassifierQueueService implements OnModuleDestroy {
  private readonly logger = new Logger(ReplyClassifierQueueService.name);

  private bullQueue: Queue<ReplyClassifierJobData> | null = null;
  private connection: ConnectionOptions | null = null;

  constructor() {
    this.connection = buildRedisConnectionOptions();

    if (this.connection) {
      this.bullQueue = new Queue<ReplyClassifierJobData>(REPLY_CLASSIFIER_QUEUE_NAME, {
        connection: this.connection,
      });
      this.logger.log(
        `ReplyClassifierQueueService connected to Redis (BullMQ mode, queue=${REPLY_CLASSIFIER_QUEUE_NAME})`,
      );
    } else if (process.env.NODE_ENV === "production") {
      throw new Error(
        "REDIS_URL (or REDIS_HOST) is required in production. " +
          "Refusing to start reply-classifier queue with no Redis backing.",
      );
    } else {
      this.logger.warn(
        "REDIS_URL not set — reply-classifier enqueue is a no-op (dev only)",
      );
    }
  }

  isBullMode(): boolean {
    return this.bullQueue !== null;
  }

  getConnection(): ConnectionOptions | null {
    return this.connection;
  }

  async enqueue(input: EnqueueReplyClassifierInput): Promise<void> {
    if (!this.bullQueue) return;

    await this.bullQueue.add(
      "classify-reply",
      { orgId: input.orgId, replyId: input.replyId },
      { jobId: input.replyId, ...DEFAULT_JOB_OPTIONS },
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.bullQueue?.close();
  }
}

