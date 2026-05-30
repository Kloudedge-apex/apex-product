import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Job, Worker } from "bullmq";
import { PrismaService } from "../../prisma/prisma.service";
import {
  ReplyClassifierJobData,
  ReplyClassifierQueueService,
  REPLY_CLASSIFIER_QUEUE_NAME,
} from "./reply-classifier.queue";
import { ReplyClassifierService } from "./reply-classifier.service";

const BULL_CONCURRENCY = 5;

@Injectable()
export class ReplyClassifierProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReplyClassifierProcessor.name);
  private bullWorker: Worker<ReplyClassifierJobData> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: ReplyClassifierQueueService,
    private readonly classifier: ReplyClassifierService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.queue.isBullMode()) {
      this.logger.log(
        "ReplyClassifierProcessor running without Redis (no BullMQ worker started)",
      );
      return;
    }
    const connection = this.queue.getConnection();
    if (!connection) {
      throw new Error(
        "ReplyClassifierQueueService reported BullMQ mode but connection missing",
      );
    }
    this.bullWorker = new Worker<ReplyClassifierJobData>(
      REPLY_CLASSIFIER_QUEUE_NAME,
      async (job) => this.handleJob(job),
      { connection, concurrency: BULL_CONCURRENCY },
    );
    this.bullWorker.on("failed", (job, err) => {
      this.logger.error(
        `Reply classifier job ${job?.id} failed: ${err.message} (attempt ${job?.attemptsMade}/${job?.opts?.attempts ?? "?"})`,
      );
    });
    this.bullWorker.on("error", (err) => {
      this.logger.error(`ReplyClassifier BullMQ worker error: ${err.message}`);
    });
    this.logger.log(
      `ReplyClassifierProcessor enabled (BullMQ, queue=${REPLY_CLASSIFIER_QUEUE_NAME}, concurrency=${BULL_CONCURRENCY})`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    if (this.bullWorker) {
      await this.bullWorker.close();
      this.bullWorker = null;
    }
  }

  private async handleJob(job: Job<ReplyClassifierJobData>): Promise<void> {
    await this.process(job.data);
  }

  async process(data: ReplyClassifierJobData): Promise<void> {
    const reply = await this.prisma.reply.findFirst({
      where: { id: data.replyId, orgId: data.orgId },
      select: { id: true, orgId: true },
    });
    if (!reply) {
      this.logger.warn(
        `Reply ${data.replyId} not found for org ${data.orgId} — skipping`,
      );
      return;
    }
    if (reply.orgId !== data.orgId) {
      this.logger.warn(
        `Reply ${data.replyId} org mismatch (expected ${data.orgId}, got ${reply.orgId}) — skipping`,
      );
      return;
    }

    await this.classifier.classifyReply({ orgId: data.orgId, replyId: data.replyId });
  }
}

