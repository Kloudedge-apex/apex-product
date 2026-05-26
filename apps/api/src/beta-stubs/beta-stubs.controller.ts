import { Controller, Get } from "@nestjs/common";
import { OrgId } from "../common/org-context.decorator";

/**
 * Empty-shape stubs for FE surfaces that don't yet have backend
 * implementations. Returning the correct shape (instead of letting the FE 404)
 * keeps the console clean during the prelaunch period and lets the
 * `VITE_SHOW_BETA_TABS` gate hide the corresponding nav items without code
 * changes per environment.
 *
 * Each handler depends only on the OrgScopeGuard (global) for auth — no DB
 * reads — so latency is dominated by JWT verification. When a real
 * implementation lands for one of these endpoints, move it into its own
 * module/controller and delete the stub here. Do NOT extend this controller
 * with business logic.
 */
@Controller()
export class BetaStubsController {
  @Get("inbox")
  inbox(@OrgId() _orgId: string): unknown[] {
    return [];
  }

  @Get("accounts")
  accounts(@OrgId() _orgId: string): unknown[] {
    return [];
  }

  @Get("campaigns")
  campaigns(@OrgId() _orgId: string): { campaigns: unknown[] } {
    return { campaigns: [] };
  }

  @Get("playbooks")
  playbooks(@OrgId() _orgId: string): unknown[] {
    return [];
  }

  @Get("deliverability")
  deliverability(@OrgId() _orgId: string) {
    return {
      overallScore: 0,
      bounceRate: 0,
      spamRate: 0,
      inboxPlacement: 0,
      mailboxes: [],
      domains: [],
      bounceRateTrend: [],
      spamRateTrend: [],
      sendVolume: [],
    };
  }
}
