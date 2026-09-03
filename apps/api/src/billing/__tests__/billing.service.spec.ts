import { describe, expect, it, vi } from "vitest";
import { BillingService } from "../billing.service";

describe("BillingService design partners", () => {
  it("bypasses Razorpay subscription creation", async () => {
    const prisma = {
      org: {
        findUnique: vi.fn().mockResolvedValue({
          id: "org_1",
          plan: "ENTERPRISE",
          designPartner: true,
          billingId: null,
        }),
      },
    };
    const service = new BillingService(
      prisma as never,
      { get: vi.fn().mockReturnValue(undefined) } as never,
    );

    await expect(
      service.createSubscription("org_1", "plan_growth"),
    ).resolves.toEqual({
      plan: "ENTERPRISE",
      subscription: null,
      billingBypassed: true,
    });
  });

  it("ignores Razorpay plan changes for a design partner", async () => {
    const update = vi.fn();
    const prisma = {
      org: {
        findUnique: vi.fn().mockResolvedValue({
          id: "org_1",
          plan: "ENTERPRISE",
          designPartner: true,
          billingId: null,
        }),
        findFirst: vi.fn(),
        update,
      },
    };
    const service = new BillingService(
      prisma as never,
      { get: vi.fn().mockReturnValue(undefined) } as never,
    );

    await service.applyWebhookEvent({
      event: "subscription.cancelled",
      payload: {
        subscription: {
          entity: {
            id: "sub_1",
            notes: { orgId: "org_1" },
          },
        },
      },
    });

    expect(update).not.toHaveBeenCalled();
  });
});
