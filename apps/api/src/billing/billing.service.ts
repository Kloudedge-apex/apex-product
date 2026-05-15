import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";
import Razorpay from "razorpay";

/** Explicit Razorpay plan ID to internal plan mapping */
const PLAN_ID_MAP: Record<string, "STARTER" | "GROWTH" | "ENTERPRISE"> = {
  // Add actual Razorpay plan IDs here as they are created
  // e.g. "plan_abc123": "STARTER",
};

// Also match by substring as fallback for legacy plan IDs
function resolvePlan(planId: string): "STARTER" | "GROWTH" | "ENTERPRISE" {
  if (PLAN_ID_MAP[planId]) return PLAN_ID_MAP[planId];
  const lower = planId.toLowerCase();
  if (lower.includes("enterprise")) return "ENTERPRISE";
  if (lower.includes("starter")) return "STARTER";
  return "GROWTH";
}

@Injectable()
export class BillingService {
  private razorpay: Razorpay | null = null;

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
  ) {
    const keyId = this.config.get("RAZORPAY_KEY_ID");
    const keySecret = this.config.get("RAZORPAY_KEY_SECRET");
    if (keyId && keySecret) {
      this.razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });
    }
  }

  async createSubscription(orgId: string, planId: string) {
    if (!this.razorpay) throw new Error("Razorpay not configured");
    // Create Razorpay subscription
    const subscription = await this.razorpay.subscriptions.create({
      plan_id: planId,
      total_count: 12, // 12 months
      quantity: 1,
    });

    // Update org with billing info
    await this.prisma.org.update({
      where: { id: orgId },
      data: {
        billingId: subscription.id,
        plan: resolvePlan(planId),
      },
    });

    return subscription;
  }

  async getSubscription(orgId: string) {
    const org = await this.prisma.org.findUnique({ where: { id: orgId } });
    if (!org?.billingId) return { plan: org?.plan, subscription: null };

    try {
      if (!this.razorpay) return { plan: org?.plan, subscription: null };
      const subscription = await this.razorpay.subscriptions.fetch(org.billingId);
      return { plan: org.plan, subscription };
    } catch {
      return { plan: org?.plan, subscription: null };
    }
  }

  async upgradePlan(orgId: string, plan: "STARTER" | "GROWTH" | "ENTERPRISE") {
    return this.prisma.org.update({
      where: { id: orgId },
      data: { plan },
    });
  }
}
