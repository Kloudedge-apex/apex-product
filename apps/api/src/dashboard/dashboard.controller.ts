import { Controller, Get, Post, Body, HttpCode } from "@nestjs/common";
import { OrgId } from "../common/org-context.decorator";
import { DashboardService } from "./dashboard.service";

interface KpiSelectionBody {
  metrics?: unknown;
}

@Controller("dashboard")
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get("stats")
  stats(@OrgId() orgId: string) {
    return this.dashboard.stats(orgId);
  }

  @Post("kpis")
  @HttpCode(204)
  kpis(@OrgId() _orgId: string, @Body() _body: KpiSelectionBody): void {
    // Client persists selection in localStorage. Server-side persistence is
    // a future enhancement (would require a User.dashboardKpis column).
    return;
  }
}
