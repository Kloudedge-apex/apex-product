import {
  Controller,
  Get,
  Post,
  Body,
  Req,
  Logger,
  HttpCode,
  HttpStatus,
  BadRequestException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Request } from "express";
import { BillingService } from "./billing.service";
import { OrgId } from "../common/org-context.decorator";
import { SkipOrgGuard } from "../common/org-scope.guard";
import { CreateSubscriptionDto } from "../common/dto/billing.dto";
import { verifyRazorpayWebhookSignature } from "../common/webhook-signature.util";

@Controller("billing")
export class BillingController {
  private readonly logger = new Logger(BillingController.name);

  constructor(
    private readonly billingService: BillingService,
    private readonly config: ConfigService,
  ) {}

  @Post("subscribe")
  createSubscription(
    @OrgId() orgId: string,
    @Body() body: CreateSubscriptionDto,
  ) {
    return this.billingService.createSubscription(orgId, body.planId);
  }

  @Get()
  getSubscription(@OrgId() orgId: string) {
    return this.billingService.getSubscription(orgId);
  }

  /**
   * Razorpay webhook. No JWT (Razorpay's servers call us), but the signature
   * over the raw body is verified before any DB writes. Plan changes only
   * happen through this endpoint — there is no client-callable upgrade.
   */
  @Post("webhook")
  @SkipOrgGuard()
  @HttpCode(HttpStatus.OK)
  async handleWebhook(@Req() req: Request) {
    const secret = this.config.get<string>("RAZORPAY_WEBHOOK_SECRET");
    if (!secret) {
      this.logger.error("RAZORPAY_WEBHOOK_SECRET not configured");
      throw new ServiceUnavailableException("Webhook not configured");
    }

    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
    if (!rawBody) {
      throw new BadRequestException("Missing raw body");
    }

    const sig = req.headers["x-razorpay-signature"];
    const signature = Array.isArray(sig) ? sig[0] : sig;

    try {
      verifyRazorpayWebhookSignature(rawBody, signature, secret);
    } catch (err) {
      this.logger.warn(
        `Razorpay webhook signature verification failed: ${
          err instanceof Error ? err.message : "unknown"
        }`,
      );
      throw new BadRequestException("Invalid signature");
    }

    await this.billingService.applyWebhookEvent(req.body);
    return { received: true };
  }
}
