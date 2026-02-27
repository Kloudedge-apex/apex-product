import { Controller, Get, Post, Param, Body } from "@nestjs/common";
import { BillingService } from "./billing.service";

@Controller("billing")
export class BillingController {
  constructor(private readonly billingService: BillingService) {}

  @Post("subscribe")
  createSubscription(@Body() body: { orgId: string; planId: string }) {
    return this.billingService.createSubscription(body.orgId, body.planId);
  }

  @Get(":orgId")
  getSubscription(@Param("orgId") orgId: string) {
    return this.billingService.getSubscription(orgId);
  }

  @Post("upgrade")
  upgradePlan(@Body() body: { orgId: string; plan: "STARTER" | "GROWTH" | "ENTERPRISE" }) {
    return this.billingService.upgradePlan(body.orgId, body.plan);
  }
}
