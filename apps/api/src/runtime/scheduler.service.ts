import { Injectable, OnModuleInit, OnModuleDestroy } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { RuntimeService } from "./runtime.service";

@Injectable()
export class SchedulerService implements OnModuleInit, OnModuleDestroy {
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  constructor(
    private prisma: PrismaService,
    private runtime: RuntimeService,
  ) {}

  onModuleInit() {
    // Check schedules every 60 seconds
    this.intervalHandle = setInterval(() => this.checkSchedules(), 60000);
  }

  onModuleDestroy() {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
    }
  }

  private async checkSchedules() {
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

      for (const agent of agents) {
        if (!agent.schedule) continue;

        const lastRun = agent.runs[0];
        const shouldRun = this.shouldRunNow(agent.schedule, lastRun?.startedAt || null);

        if (shouldRun) {
          await this.runtime.triggerRun(agent.id, agent.orgId);
        }
      }
    } catch {
      // Silently handle schedule check errors
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
    // Basic cron parser for simple expressions like "0 * * * *" (every hour)
    const parts = expression.split(" ");
    if (parts.length !== 5) return diffMinutes >= 60; // fallback: once per hour

    const [minute, hour] = parts;

    if (minute === "*" && hour === "*") {
      return diffMinutes >= 1;
    }

    const currentMinute = now.getMinutes();
    const currentHour = now.getHours();

    const minuteMatch = minute === "*" || parseInt(minute) === currentMinute;
    const hourMatch = hour === "*" || parseInt(hour) === currentHour;

    return minuteMatch && hourMatch && diffMinutes >= 1;
  }
}
