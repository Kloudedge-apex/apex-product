import { describe, expect, it, vi } from "vitest";
import { DashboardService } from "../dashboard.service";

describe("DashboardService.stats", () => {
  it("returns only measured counts", async () => {
    const prisma = {
      leadScore: {
        count: vi.fn().mockResolvedValueOnce(12).mockResolvedValueOnce(5),
      },
      emailCandidate: { count: vi.fn().mockResolvedValue(8) },
      outreachArtifact: { count: vi.fn().mockResolvedValue(3) },
      meetingLedger: { count: vi.fn().mockResolvedValue(2) },
    };
    const service = new DashboardService(prisma as never);

    await expect(service.stats("org_1")).resolves.toEqual({
      leadsSourced: 12,
      leadsQualified: 5,
      verifiedEmails: 8,
      emailsSent: 3,
      meetingsBooked: 2,
    });
    expect(prisma.emailCandidate.count).toHaveBeenCalledWith({
      where: {
        verified: true,
        person: { company: { orgId: "org_1" } },
      },
    });
  });
});
