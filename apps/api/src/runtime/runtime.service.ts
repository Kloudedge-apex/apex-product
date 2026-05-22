import { Injectable, ForbiddenException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { QueueService } from "./queue.service";

const DAILY_RUN_LIMITS: Record<string, number> = {
  TRIAL: 3,
  STARTER: 10,
  GROWTH: 50,
  ENTERPRISE: Infinity,
};

@Injectable()
export class RuntimeService {
  constructor(
    private prisma: PrismaService,
    private queue: QueueService,
  ) {}

  async triggerRun(agentId: string, orgId: string) {
    const org = await this.prisma.org.findUnique({
      where: { id: orgId },
      select: { plan: true },
    });
    const plan = org?.plan || "TRIAL";
    const limit = DAILY_RUN_LIMITS[plan] ?? DAILY_RUN_LIMITS.TRIAL;

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    // Atomic count + insert: a Serializable transaction prevents two
    // concurrent triggers from each seeing N runs and both inserting (which
    // would push the org over its plan limit).
    const run = await this.prisma.$transaction(
      async (tx) => {
        if (limit !== Infinity) {
          const runsToday = await tx.agentRun.count({
            where: { orgId, startedAt: { gte: todayStart } },
          });
          if (runsToday >= limit) {
            throw new ForbiddenException(
              `Daily run limit reached for your plan (${plan}: ${limit} runs/day).`,
            );
          }
        }
        return tx.agentRun.create({
          data: { agentId, orgId, status: "QUEUED" },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    await this.queue.enqueue({
      id: `job_${run.id}`,
      agentId,
      orgId,
      runId: run.id,
    });

    await this.prisma.agentLog.create({
      data: { runId: run.id, level: "INFO", message: "Run queued for execution" },
    });

    return run;
  }

  async cancelRun(runId: string) {
    const jobId = `job_${runId}`;
    const cancelled = await this.queue.cancel(jobId);

    if (cancelled) {
      await this.prisma.agentRun.update({
        where: { id: runId },
        data: { status: "CANCELLED", completedAt: new Date() },
      });
    }

    return { cancelled };
  }

  async getQueueStats() {
    return {
      queued: await this.queue.getQueueLength(),
      processing: await this.queue.getProcessingCount(),
    };
  }
}
