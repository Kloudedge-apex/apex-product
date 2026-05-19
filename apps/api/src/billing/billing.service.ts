import {
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Plan } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import Razorpay from "razorpay";

const PLAN_FROM_ID: Array<{ match: RegExp; plan: Plan }> = [
  { match: /enterprise/i, plan: "ENTERPRISE" },
  { match: /growth/i, plan: "GROWTH" },
  { match: /starter/i, plan: "STARTER" },
];

const PLAN_FROM_PLAN_FIELD: Record<string, Plan> = {
  starter: "STARTER",
  growth: "GROWTH",
  enterprise: "ENTERPRISE",
  trial: "TRIAL",
};

interface RazorpayWebhookPayload {
  event?: string;
  payload?: {
    subscription?: {
      entity?: {
        id?: string;
        status?: string;
        notes?: Record<string, string> | null;
        plan_id?: string;
      };
    };
  };
}

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);
  private razorpay: Razorpay | null = null;

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
  ) {
    const keyId = this.config.get<string>("RAZORPAY_KEY_ID");
    const keySecret = this.config.get<string>("RAZORPAY_KEY_SECRET");
    if (keyId && keySecret) {
      this.razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });
    }
  }

  /**
   * Create a Razorpay subscription and link it to the org atomically.
   * If the DB write fails after Razorpay accepts the subscription, we cancel
   * the subscription to avoid leaving the org in a half-paid state.
   */
  async createSubscription(orgId: string, planId: string) {
    if (!this.razorpay) {
      throw new ServiceUnavailableException("Billing is not configured");
    }

    const org = await this.prisma.org.findUnique({ where: { id: orgId } });
    if (!org) throw new NotFoundException("Org not found");

    const subscription = await this.razorpay.subscriptions.create({
      plan_id: planId,
      total_count: 12,
      quantity: 1,
      notes: { orgId },
    });

    try {
      await this.prisma.org.update({
        where: { id: orgId },
        data: { billingId: subscription.id },
      });
    } catch (err) {
      this.logger.error(
        `Failed to persist Razorpay subscription ${subscription.id} for org ${orgId}; cancelling`,
        err instanceof Error ? err.stack : String(err),
      );
      try {
        await this.razorpay.subscriptions.cancel(subscription.id, false);
      } catch (cancelErr) {
        this.logger.error(
          `CRITICAL: failed to cancel orphan Razorpay subscription ${subscription.id}`,
          cancelErr instanceof Error ? cancelErr.stack : String(cancelErr),
        );
      }
      throw err;
    }

    return subscription;
  }

  async getSubscription(orgId: string) {
    const org = await this.prisma.org.findUnique({ where: { id: orgId } });
    if (!org) throw new NotFoundException("Org not found");
    if (!org.billingId || !this.razorpay) {
      return { plan: org.plan, subscription: null };
    }
    try {
      const subscription = await this.razorpay.subscriptions.fetch(org.billingId);
      return { plan: org.plan, subscription };
    } catch (err) {
      this.logger.warn(
        `Failed to fetch Razorpay subscription for org ${orgId}: ${
          err instanceof Error ? err.message : "unknown"
        }`,
      );
      return { plan: org.plan, subscription: null };
    }
  }

  /**
   * Apply a Razorpay webhook event. Plan changes only happen here — there is
   * no client-callable upgrade endpoint, so an attacker cannot flip plans by
   * hitting the API.
   */
  async applyWebhookEvent(payload: RazorpayWebhookPayload): Promise<void> {
    const event = payload.event;
    const entity = payload.payload?.subscription?.entity;
    if (!event || !entity) {
      this.logger.warn(`Razorpay webhook missing event/entity (event=${event})`);
      return;
    }

    const subId = entity.id;
    const status = entity.status;
    const noteOrgId = entity.notes?.orgId;
    const planId = entity.plan_id;

    if (!subId) {
      this.logger.warn(`Razorpay webhook ${event} with no subscription id`);
      return;
    }

    const org =
      (noteOrgId &&
        (await this.prisma.org.findUnique({ where: { id: noteOrgId } }))) ||
      (await this.prisma.org.findFirst({ where: { billingId: subId } }));

    if (!org) {
      this.logger.warn(
        `Razorpay webhook ${event} for sub ${subId} matched no org`,
      );
      return;
    }

    const update: { plan?: Plan; billingId?: string | null } = {};

    switch (event) {
      case "subscription.activated":
      case "subscription.charged":
      case "subscription.resumed":
      case "subscription.updated": {
        const plan = this.derivePlan(planId);
        if (plan) update.plan = plan;
        if (!org.billingId) update.billingId = subId;
        break;
      }
      case "subscription.cancelled":
      case "subscription.completed":
      case "subscription.halted":
      case "subscription.paused":
        update.plan = "TRIAL";
        break;
      default:
        this.logger.log(`Razorpay webhook ${event} acknowledged, no plan change`);
        return;
    }

    if (Object.keys(update).length === 0) return;

    await this.prisma.org.update({ where: { id: org.id }, data: update });
    this.logger.log(
      `Applied Razorpay ${event} to org ${org.id} (status=${status}, sub=${subId})`,
    );
  }

  private derivePlan(planId: string | undefined): Plan | null {
    if (!planId) return null;
    for (const { match, plan } of PLAN_FROM_ID) {
      if (match.test(planId)) return plan;
    }
    const lower = planId.toLowerCase();
    return PLAN_FROM_PLAN_FIELD[lower] || null;
  }
}
