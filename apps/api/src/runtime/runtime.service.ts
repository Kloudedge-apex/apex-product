import { Injectable, ForbiddenException } from "@nestjs/common";
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
  ) { }

  async triggerRun(agentId: string, orgId: string) {
    // ── Enforce per-plan daily run limits ──────────────────────────────────
    const org = await this.prisma.org.findUnique({
      where: { id: orgId },
      select: { plan: true },
    });

    const plan = org?.plan || "TRIAL";
    const limit = DAILY_RUN_LIMITS[plan] ?? DAILY_RUN_LIMITS.TRIAL;

    if (limit !== Infinity) {
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      const runsToday = await this.prisma.agentRun.count({
        where: {
          orgId,
          startedAt: { gte: todayStart },
        },
      });

      if (runsToday >= limit) {
        throw new ForbiddenException(
          `Daily run limit reached for your plan (${plan}: ${limit} runs/day). ` +
          `Upgrade your plan to run more agents today.`,
        );
      }
    }

    // ── Create run record ─────────────────────────────────────────────────
    const run = await this.prisma.agentRun.create({
      data: {
        agentId,
        orgId,
        status: "QUEUED",
      },
    });

    // Enqueue the job
    this.queue.enqueue({
      id: `job_${run.id}`,
      agentId,
      orgId,
      runId: run.id,
    });

    // Log
    await this.prisma.agentLog.create({
      data: {
        runId: run.id,
        level: "INFO",
        message: "Run queued for execution",
      },
    });

    return run;
  }

  async cancelRun(runId: string) {
    const jobId = `job_${runId}`;
    const cancelled = this.queue.cancel(jobId);

    if (cancelled) {
      await this.prisma.agentRun.update({
        where: { id: runId },
        data: {
          status: "CANCELLED",
          completedAt: new Date(),
        },
      });
    }

    return { cancelled };
  }

  getQueueStats() {
    return {
      queued: this.queue.getQueueLength(),
      processing: this.queue.getProcessingCount(),
    };
  }
}
