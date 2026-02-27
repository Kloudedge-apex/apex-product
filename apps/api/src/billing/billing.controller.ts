import { Controller, Get, Post, Param, Body } from "@nestjs/common";
import { BillingService } from "./billing.service";

@Controller("billing")
export class BillingController {
  constructor(private readonly billingService: BillingService) {}

  @Get(":orgId")
  getSubscription(@Param("orgId") orgId: string) {
    return this.billingService.getSubscription(orgId);
  }

  @Post("subscribe")
  subscribe(@Body() body: { orgId: string; plan: string }) {
    return this.billingService.subscribe(body);
  }

  @Post("webhook")
  handleWebhook(@Body() body: unknown) {
    // TODO: Handle Razorpay webhook events
    return this.billingService.handleWebhook(body);
  }
}
