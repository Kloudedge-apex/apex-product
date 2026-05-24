import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { Queue, JobsOptions, ConnectionOptions } from "bullmq";
import { Command } from "@langchain/langgraph";
import { buildRedisConnectionOptions } from "../runtime/queue.service";

/**
 * BullMQ queue dedicated to driving LangGraph pipeline runs to the next
 * checkpoint. Kept separate from the agent-runs / outreach-send queues so the
 * graph supervisor has its own retry / backoff envelope and worker lifecycle.
 *
 * The job payload carries only the GraphRun id plus a small discriminator
 * describing whether this is a fresh start or a resume after HITL — actual
 * graph state lives in GraphCheckpoint / GraphCheckpointWrite (written by
 * PrismaCheckpointSaver) and is re-hydrated by the worker.
 */

export type EnqueueGraphRunInput =
  | {
      readonly kind: "start";
      readonly graphRunId: string;
      readonly orgId: string;
      readonly icpProfileIds: readonly string[];
    }
  | {
      readonly kind: "resume";
      readonly graphRunId: string;
      readonly orgId: string;
      readonly resume: { approved: boolean; approvedBy?: string };
    };

export interface GraphRunJobData {
  readonly kind: "start" | "resume";
  readonly graphRunId: string;
  readonly orgId: string;
  readonly icpProfileIds?: readonly string[];
  readonly resume?: { approved: boolean; approvedBy?: string };
}

export const GRAPH_RUN_QUEUE_NAME = "graph-runs";

const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 5_000 },
  removeOnComplete: { age: 24 * 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600, count: 5000 },
};

@Injectable()
export class GraphRunQueueService implements OnModuleDestroy {
  private readonly logger = new Logger(GraphRunQueueService.name);

  private bullQueue: Queue<GraphRunJobData> | null = null;
  private connection: ConnectionOptions | null = null;

  constructor() {
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
   * Enqueue a GraphRun for execution. Uses the GraphRun id as the BullMQ
   * jobId so duplicate enqueues (e.g. crash-recovery sweep racing the boot
   * controller path) collapse to a single job rather than spawning multiple
   * concurrent invocations against the same checkpoint thread.
   *
   * `resume` jobs intentionally use a distinct jobId suffix so a resume can
   * coexist with any leftover start job for the same run.
   */
  async enqueueGraphRun(input: EnqueueGraphRunInput): Promise<void> {
    if (!this.bullQueue) {
      // In-memory fallback path: the worker polls the DB directly for ACTIVE
      // GraphRuns whose updatedAt is stale, so no enqueue work is needed here.
      return;
    }

    const data: GraphRunJobData =
      input.kind === "start"
        ? {
            kind: "start",
            graphRunId: input.graphRunId,
            orgId: input.orgId,
            icpProfileIds: input.icpProfileIds,
          }
        : {
            kind: "resume",
            graphRunId: input.graphRunId,
            orgId: input.orgId,
            resume: input.resume,
          };

    const jobId =
      input.kind === "resume"
        ? `${input.graphRunId}:resume`
        : input.graphRunId;

    await this.bullQueue.add("process-graph-run", data, {
      jobId,
      ...DEFAULT_JOB_OPTIONS,
    });
  }

  async onModuleDestroy() {
    await this.bullQueue?.close();
  }
}

/**
 * Helper: convert a queued job's resume payload back into a LangGraph
 * `Command`. Kept out of the worker to keep `Command` import discipline tight.
 */
export function resumeCommandFromJob(
  resume: { approved: boolean; approvedBy?: string },
): Command {
  return new Command({ resume });
}
