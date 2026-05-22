import { Controller, Get, Query } from "@nestjs/common";
import { OrgId } from "../common/org-context.decorator";
import { DashboardService, ActivityEvent } from "./dashboard.service";

@Controller("activity")
export class ActivityController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get()
  async list(
    @OrgId() orgId: string,
    @Query("limit") limitRaw?: string,
  ): Promise<{ events: ActivityEvent[] }> {
    const parsed = limitRaw ? Number(limitRaw) : NaN;
    const limit = Number.isFinite(parsed) && parsed > 0 && parsed <= 100
      ? Math.floor(parsed)
      : 30;
    const events = await this.dashboard.activity(orgId, limit);
    return { events };
  }
}
