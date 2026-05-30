import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { PrismaService } from "../prisma/prisma.service";
import { UsageRollupQueue } from "./usage-rollup.queue";

function startOfUtcHour(d: Date): Date {
  return new Date(
    Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth(),
      d.getUTCDate(),
      d.getUTCHours(),
      0,
      0,
      0,
    ),
  );
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
}

function addHours(d: Date, hours: number): Date {
  return new Date(d.getTime() + hours * 60 * 60 * 1000);
}

function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 24 * 60 * 60 * 1000);
}

@Injectable()
export class UsageRollupScheduler {
  private readonly logger = new Logger(UsageRollupScheduler.name);
  private runningHour = false;
  private runningDay = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: UsageRollupQueue,
  ) {}

  private isCronEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.ROLLUP_CRON_ENABLED !== "false";
  }

  /**
   * Every 5 minutes: enqueue rollup for the previous full UTC hour.
   * Example: at 14:05Z, roll up 13:00Z bucket.
   */
  @Cron(CronExpression.EVERY_5_MINUTES, { timeZone: "UTC" })
  async enqueueHourlyRollups(): Promise<void> {
    if (!this.isCronEnabled()) return;
    if (this.runningHour) return;
    this.runningHour = true;
    try {
      const now = new Date();
      const currentHour = startOfUtcHour(now);
      const previousHour = addHours(currentHour, -1);

      const orgs = await this.prisma.org.findMany({ select: { id: true } });
      await Promise.all(
        orgs.map((o) => this.queue.enqueueRollupHour({ orgId: o.id, hourBucket: previousHour })),
      );
      this.logger.debug(
        `Enqueued rollup-hour for ${orgs.length} orgs (bucket=${previousHour.toISOString()})`,
      );
    } catch (err) {
      this.logger.warn(
        `enqueueHourlyRollups failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.runningHour = false;
    }
  }

  /**
   * Daily at 00:15 UTC: enqueue rollup for yesterday.
   */
  @Cron("15 0 * * *", { timeZone: "UTC" })
  async enqueueDailyRollups(): Promise<void> {
    if (!this.isCronEnabled()) return;
    if (this.runningDay) return;
    this.runningDay = true;
    try {
      const today = startOfUtcDay(new Date());
      const yesterday = addDays(today, -1);

      const orgs = await this.prisma.org.findMany({ select: { id: true } });
      await Promise.all(
        orgs.map((o) => this.queue.enqueueRollupDay({ orgId: o.id, dayBucket: yesterday })),
      );
      this.logger.debug(
        `Enqueued rollup-day for ${orgs.length} orgs (bucket=${yesterday.toISOString()})`,
      );
    } catch (err) {
      this.logger.warn(
        `enqueueDailyRollups failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.runningDay = false;
    }
  }
}

