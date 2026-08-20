import { Controller, Get, Query, BadRequestException, UseGuards } from "@nestjs/common";
import { OrgId } from "../common/org-context.decorator";
import { OrgScopeGuard } from "../common/org-scope.guard";
import { RateLimitGuard } from "../common/rate-limit.guard";
import { WindowDto } from "./dto/window.dto";
import { KpiCalculatorService } from "./kpi-calculator.service";

@UseGuards(OrgScopeGuard, RateLimitGuard)
@Controller("kpis")
export class KpisController {
  constructor(private readonly kpis: KpiCalculatorService) {}

  @Get()
  async all(@OrgId() orgId: string | undefined, @Query() window: WindowDto) {
    if (!orgId) throw new BadRequestException("orgId required");
    const [operational, quality, commercial, guaranteeDefense] = await Promise.all([
      this.kpis.operational(orgId, window),
      this.kpis.quality(orgId, window),
      this.kpis.commercial(orgId, window),
      this.kpis.guaranteeDefense(orgId, window),
    ]);

    return { operational, quality, commercial, guaranteeDefense };
  }

  @Get("operational")
  operational(@OrgId() orgId: string | undefined, @Query() window: WindowDto) {
    if (!orgId) throw new BadRequestException("orgId required");
    return this.kpis.operational(orgId, window);
  }

  @Get("quality")
  quality(@OrgId() orgId: string | undefined, @Query() window: WindowDto) {
    if (!orgId) throw new BadRequestException("orgId required");
    return this.kpis.quality(orgId, window);
  }

  @Get("commercial")
  commercial(@OrgId() orgId: string | undefined, @Query() window: WindowDto) {
    if (!orgId) throw new BadRequestException("orgId required");
    return this.kpis.commercial(orgId, window);
  }

  @Get("guarantee-defense")
  guaranteeDefense(@OrgId() orgId: string | undefined, @Query() window: WindowDto) {
    if (!orgId) throw new BadRequestException("orgId required");
    return this.kpis.guaranteeDefense(orgId, window);
  }

}
