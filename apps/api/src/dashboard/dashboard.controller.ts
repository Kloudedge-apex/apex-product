import { Controller, Get } from "@nestjs/common";
import { OrgId } from "../common/org-context.decorator";
import { DashboardService } from "./dashboard.service";

@Controller("dashboard")
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get("stats")
  stats(@OrgId() orgId: string) {
    return this.dashboard.stats(orgId);
  }
}
