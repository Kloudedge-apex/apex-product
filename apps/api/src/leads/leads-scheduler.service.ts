import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { PrismaService } from "../prisma/prisma.service";
import { LeadsService } from "./leads.service";

@Injectable()
export class LeadsSchedulerService {
  private readonly logger = new Logger(LeadsSchedulerService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly leadsService: LeadsService,
  ) {}

  /**
   * Runs every hour. Checks for ICP profiles with scheduled discovery enabled
   * whose last run was longer ago than their interval.
   *
   * @deprecated Wires the legacy {@link LeadsService.triggerDiscovery} direct
   * executor. Gated behind `LEGACY_TRIGGER_DISCOVERY_ENABLED=true` (default OFF).
   * The LangGraph supervisor in `GraphService.runPipelineGraph` is now the
   * single canonical entry point for pipeline runs.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async handleScheduledDiscovery(): Promise<void> {
    if (process.env.LEGACY_TRIGGER_DISCOVERY_ENABLED !== "true") {
      this.logger.warn(
        "triggerDiscovery is deprecated — set LEGACY_TRIGGER_DISCOVERY_ENABLED=true to opt back in; graph supervisor is now the single entry point",
      );
      this.logger.log("skipped: legacy disabled");
      return;
    }

    if (this.running) {
      this.logger.debug("Scheduler already running, skipping");
      return;
    }

    this.running = true;
    try {
      const now = new Date();

      // Find all ICP profiles with scheduling enabled that are due
      const dueProfiles = await this.prisma.icpProfile.findMany({
        where: {
          scheduleEnabled: true,
          OR: [
            { lastRunAt: null }, // never run
            // lastRunAt older than scheduleInterval hours ago
            // We check in application code since Prisma doesn't support dynamic date math
          ],
        },
        include: {
          org: { select: { id: true } },
        },
        orderBy: { lastRunAt: "asc" }, // oldest first
      });

      let triggered = 0;

      for (const profile of dueProfiles) {
        // Check if enough time has passed since last run
        if (profile.lastRunAt) {
          const hoursSinceLastRun = (now.getTime() - profile.lastRunAt.getTime()) / (1000 * 60 * 60);
          if (hoursSinceLastRun < profile.scheduleInterval) continue;
        }

        // Check if there's already a running job for this org
        const activeJob = await this.prisma.scrapeJob.findFirst({
          where: { orgId: profile.orgId, status: { in: ["QUEUED", "RUNNING"] } },
        });
        if (activeJob) {
          this.logger.debug(`Skipping ICP ${profile.id}: org ${profile.orgId} already has active job`);
          continue;
        }

        try {
          this.logger.log(`Triggering scheduled discovery for ICP "${profile.name}" (org: ${profile.orgId})`);
          await this.leadsService.triggerDiscovery(profile.orgId, profile.id);

          // Update lastRunAt
          await this.prisma.icpProfile.update({
            where: { id: profile.id },
            data: { lastRunAt: now },
          });

          triggered++;

          // Don't overwhelm: max 5 concurrent org discoveries per cycle
          if (triggered >= 5) {
            this.logger.log("Scheduler: hit max 5 triggers per cycle, stopping");
            break;
          }

          // Small delay between triggers
          await new Promise((r) => setTimeout(r, 2000));
        } catch (err) {
          this.logger.warn(
            `Scheduled discovery failed for ICP ${profile.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      if (triggered > 0) {
        this.logger.log(`Scheduler triggered ${triggered} discovery runs`);
      }
    } finally {
      this.running = false;
    }
  }
}
