import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  Optional,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { RuntimeService } from "./runtime.service";
import {
  ProductionBootstrapWriterFenceService,
  runWithProductionBootstrapWriterFenceOrSkipClosed,
} from "../ops/production-bootstrap-writer-fence";

/** Cadence scheduling is deferred from the guarded-SDR release and fail-closed. */
export function isSchedulerEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.SCHEDULER_ENABLED === "true";
}

@Injectable()
export class SchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SchedulerService.name);
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  constructor(
    private prisma: PrismaService,
    private runtime: RuntimeService,
    @Optional()
    private readonly productionBootstrapWriterFence?: ProductionBootstrapWriterFenceService,
  ) {}

  onModuleInit(env: NodeJS.ProcessEnv = process.env) {
    if (!isSchedulerEnabled(env)) {
      this.logger.log(
        "Scheduler disabled in this process (set SCHEDULER_ENABLED=true to enable)",
      );
      return;
    }
    // Check schedules every 60 seconds
    this.intervalHandle = setInterval(
      () => this.runTimerTask("schedule poll", () => this.checkSchedules()),
      60000,
    );
    this.intervalHandle.unref();
    this.logger.log("Scheduler enabled (60s polling interval)");
  }

  onModuleDestroy() {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
    }
  }

  private runTimerTask(
    label: string,
    operation: () => Promise<unknown>,
  ): void {
    void operation().catch((error) => {
      this.logger.error(
        `Scheduler ${label} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }

  private async checkSchedules() {
    await runWithProductionBootstrapWriterFenceOrSkipClosed(
      this.productionBootstrapWriterFence,
      "scheduler",
      () => this.checkSchedulesWithLease(),
    );
  }

  private async checkSchedulesWithLease() {
    try {
      // Get all active agents with schedules
      const agents = await this.prisma.agent.findMany({
        where: {
          status: "ACTIVE",
          schedule: { not: null },
        },
        include: {
          runs: {
            take: 1,
            orderBy: { startedAt: "desc" },
          },
        },
      });

      this.logger.debug(`scheduler.tick schedulesChecked=${agents.length}`);

      let hitlSkips = 0;
      let activeSkips = 0;

      for (const agent of agents) {
        if (!agent.schedule) continue;

        const lastRun = agent.runs[0];
        const shouldRun = this.shouldRunNow(agent.schedule, lastRun?.startedAt || null);

        if (!shouldRun) continue;

        // HITL safety: do not fire a new scheduled step when this agent's
        // org has a GraphRun paused for human review. Re-triggering would
        // bypass the approval gate. Scope by orgId because Phase 2.5 does
        // not link AgentRun → GraphRun yet (see executor.graphRunIdForRun).
        const blockingGraphRun = await this.prisma.graphRun.findFirst({
          where: {
            orgId: agent.orgId,
            status: { in: ["AWAITING_APPROVAL", "RUNNING"] },
          },
          select: { id: true, status: true },
          orderBy: { startedAt: "desc" },
        });

        if (blockingGraphRun?.status === "AWAITING_APPROVAL") {
          this.logger.debug("skipping scheduled run — graph awaiting approval", {
            agentId: agent.id,
            graphRunId: blockingGraphRun.id,
          });
          hitlSkips++;
          continue;
        }

        if (blockingGraphRun?.status === "RUNNING") {
          this.logger.debug("skipping scheduled run — graph already running", {
            agentId: agent.id,
            graphRunId: blockingGraphRun.id,
          });
          activeSkips++;
          continue;
        }

        await this.runtime.triggerRun(agent.id, agent.orgId);
      }

      this.logger.debug(
        `scheduler.tick hitl_skips=${hitlSkips} active_skips=${activeSkips}`,
      );
    } catch (err) {
      this.logger.warn(
        "Scheduler tick failed",
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  /**
   * Simple cron-like schedule matching.
   * Supports: "every_hour", "every_day", "every_15min", "every_6h", or cron expressions.
   */
  private shouldRunNow(schedule: string, lastRunAt: Date | null): boolean {
    const now = new Date();
    const lastRun = lastRunAt ? new Date(lastRunAt) : null;
    const diffMs = lastRun ? now.getTime() - lastRun.getTime() : Infinity;
    const diffMinutes = diffMs / 60000;

    switch (schedule) {
      case "every_15min":
        return diffMinutes >= 15;
      case "every_hour":
        return diffMinutes >= 60;
      case "every_6h":
        return diffMinutes >= 360;
      case "every_day":
        return diffMinutes >= 1440;
      case "every_week":
        return diffMinutes >= 10080;
      default:
        // Simple cron: check if minute boundary matches
        return this.matchCron(schedule, now, diffMinutes);
    }
  }

  private matchCron(expression: string, now: Date, diffMinutes: number): boolean {
    const parts = expression.split(" ");
    if (parts.length !== 5) return diffMinutes >= 60; // fallback: once per hour

    const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

    // Must have at least 1 minute since last run to avoid double-firing
    if (diffMinutes < 1) return false;

    const currentMinute = now.getUTCMinutes();
    const currentHour = now.getUTCHours();
    const currentDayOfMonth = now.getUTCDate();
    const currentMonth = now.getUTCMonth() + 1; // 1-indexed
    const currentDayOfWeek = now.getUTCDay(); // 0=Sunday

    const minuteMatch = this.matchCronField(minute, currentMinute);
    const hourMatch = this.matchCronField(hour, currentHour);
    const dayOfMonthMatch = this.matchCronField(dayOfMonth, currentDayOfMonth);
    const monthMatch = this.matchCronField(month, currentMonth);
    const dayOfWeekMatch = this.matchCronField(dayOfWeek, currentDayOfWeek);

    return minuteMatch && hourMatch && dayOfMonthMatch && monthMatch && dayOfWeekMatch;
  }

  /** Match a single cron field (supports *, exact numbers, comma-separated, and step syntax) */
  private matchCronField(field: string, value: number): boolean {
    if (field === "*") return true;

    // Handle step syntax: */5 or 1-10/2
    if (field.includes("/")) {
      const [range, stepStr] = field.split("/");
      const step = parseInt(stepStr);
      if (isNaN(step) || step <= 0) return false;
      if (range === "*") return value % step === 0;
      // range like 1-10/2
      if (range.includes("-")) {
        const [start, end] = range.split("-").map(Number);
        return value >= start && value <= end && (value - start) % step === 0;
      }
      return false;
    }

    // Handle comma-separated values: 1,15,30
    if (field.includes(",")) {
      return field.split(",").some((v) => parseInt(v) === value);
    }

    // Handle range: 1-5
    if (field.includes("-")) {
      const [start, end] = field.split("-").map(Number);
      return value >= start && value <= end;
    }

    return parseInt(field) === value;
  }
}
