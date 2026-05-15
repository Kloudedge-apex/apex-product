import { Controller, Get, Post, Param, Body, Req, ForbiddenException } from "@nestjs/common";
import { BillingService } from "./billing.service";
import { Request } from "express";

@Controller("billing")
export class BillingController {
  constructor(private readonly billingService: BillingService) {}

  /** Verify the authenticated user has access to the given orgId */
  private assertOrgAccess(req: Request, orgId: string): void {
    const authenticatedOrgId = (req as unknown as Record<string, unknown>).orgId as string | undefined;
    if (!authenticatedOrgId || authenticatedOrgId !== orgId) {
      throw new ForbiddenException("You do not have access to this organization's billing");
    }
  }

  @Post("subscribe")
  createSubscription(@Req() req: Request, @Body() body: { orgId: string; planId: string }) {
    this.assertOrgAccess(req, body.orgId);
    return this.billingService.createSubscription(body.orgId, body.planId);
  }

  @Get(":orgId")
  getSubscription(@Req() req: Request, @Param("orgId") orgId: string) {
    this.assertOrgAccess(req, orgId);
    return this.billingService.getSubscription(orgId);
  }

  @Post("upgrade")
  upgradePlan(@Req() req: Request, @Body() body: { orgId: string; plan: "STARTER" | "GROWTH" | "ENTERPRISE" }) {
    this.assertOrgAccess(req, body.orgId);
    return this.billingService.upgradePlan(body.orgId, body.plan);
  }
}
