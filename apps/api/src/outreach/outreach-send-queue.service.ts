import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { Queue, JobsOptions, ConnectionOptions } from "bullmq";
import { buildRedisConnectionOptions } from "../runtime/queue.service";

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

const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 5_000 },
  removeOnComplete: { age: 24 * 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600, count: 5000 },
};

@Injectable()
export class OutreachSendQueueService implements OnModuleDestroy {
  private readonly logger = new Logger(OutreachSendQueueService.name);

  private bullQueue: Queue | null = null;
  private connection: ConnectionOptions | null = null;

  constructor() {
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
    await this.bullQueue?.close();
  }
}
