import { BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { LeadsController } from "../leads.controller";
import type { LeadsService } from "../leads.service";

describe("LeadsController current ICP exclusions", () => {
  it("normalizes and deduplicates exclusion domains before persistence", async () => {
    const upsertCurrentIcpProfile = vi.fn().mockResolvedValue({
      id: "icp_1",
    });
    const controller = new LeadsController({
      upsertCurrentIcpProfile,
    } as unknown as LeadsService);

    await controller.upsertCurrentIcp("org_1", {
      name: "Default ICP",
      exclusionDomains: [
        "HTTPS://WWW.Competitor.COM/jobs",
        "competitor.com",
        "partner.example",
      ],
    });

    expect(upsertCurrentIcpProfile).toHaveBeenCalledWith(
      "org_1",
      expect.objectContaining({
        exclusionDomains: ["competitor.com", "partner.example"],
      }),
    );
  });

  it("rejects an invalid exclusion instead of saving an inert rule", () => {
    const controller = new LeadsController({
      upsertCurrentIcpProfile: vi.fn(),
    } as unknown as LeadsService);

    expect(() =>
      controller.upsertCurrentIcp("org_1", {
        name: "Default ICP",
        exclusionDomains: ["not a domain"],
      }),
    ).toThrow(BadRequestException);
  });
});
