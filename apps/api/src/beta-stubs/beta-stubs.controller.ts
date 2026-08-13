import { Controller, Get, NotImplementedException } from "@nestjs/common";
import { OrgId } from "../common/org-context.decorator";

/**
 * Explicit release-boundary responses for surfaces that do not belong to the
 * guarded SDR product. A success-shaped empty payload (and especially a zero
 * metric) would falsely claim that the capability is implemented and measured.
 *
 * These routes remain mounted so any stale beta client receives an explicit,
 * authenticated 501 instead of fabricated business state. When a capability
 * gets its own durable product contract, replace its route with a real module
 * and delete the matching boundary method here.
 */
@Controller()
export class BetaStubsController {
  private unavailable(capability: string): never {
    throw new NotImplementedException({
      error: "capability_unavailable",
      capability,
      message: `${capability} is not available in the guarded SDR release`,
    });
  }

  @Get("inbox")
  inbox(@OrgId() _orgId: string): never {
    return this.unavailable("inbox");
  }

  @Get("accounts")
  accounts(@OrgId() _orgId: string): never {
    return this.unavailable("accounts");
  }

  @Get("campaigns")
  campaigns(@OrgId() _orgId: string): never {
    return this.unavailable("campaigns");
  }

  @Get("playbooks")
  playbooks(@OrgId() _orgId: string): never {
    return this.unavailable("playbooks");
  }

  @Get("deliverability")
  deliverability(@OrgId() _orgId: string): never {
    return this.unavailable("deliverability");
  }
}
