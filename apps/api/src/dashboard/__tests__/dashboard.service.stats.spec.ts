import { describe, expect, it, vi } from "vitest";
import { DashboardService } from "../dashboard.service";

describe("DashboardService.stats", () => {
  it("returns measured counts and keeps an unmeasured reply rate null", async () => {
    const prisma = {
      leadScore: {
        count: vi.fn().mockResolvedValueOnce(12).mockResolvedValueOnce(5),
      },
      outreachArtifact: { count: vi.fn().mockResolvedValue(3) },
      meetingLedger: { count: vi.fn().mockResolvedValue(2) },
    };
    const service = new DashboardService(prisma as never);

    await expect(service.stats("org_1")).resolves.toEqual({
      leadsSourced: 12,
      leadsQualified: 5,
      emailsSent: 3,
      replyRate: null,
      meetingsBooked: 2,
    });
  });
});
