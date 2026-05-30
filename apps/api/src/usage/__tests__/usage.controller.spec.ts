import { describe, it, expect, vi } from "vitest";
import { BadRequestException } from "@nestjs/common";
import { UsageController } from "../usage.controller";

describe("UsageController", () => {
  it("scopes usage queries to @OrgId() (ignores any client orgId attempts)", async () => {
    const usage = {
      getOrgUsage: vi.fn().mockResolvedValue([]),
      getOrgUsageSummary: vi.fn().mockResolvedValue({ totalCostUsd: 0 }),
    } as any;

    const controller = new UsageController(usage);

    await controller.list("org_from_jwt", {
      granularity: "hour",
      from: "2026-05-29T10:00:00.000Z",
      to: "2026-05-29T11:00:00.000Z",
      orgId: "org_spoofed",
    } as any);

    expect(usage.getOrgUsage).toHaveBeenCalledTimes(1);
    expect(usage.getOrgUsage).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org_from_jwt" }),
    );
  });

  it("rejects invalid date ranges", async () => {
    const usage = { getOrgUsage: vi.fn() } as any;
    const controller = new UsageController(usage);

    await expect(
      controller.list("org_1", {
        granularity: "hour",
        from: "not-a-date",
        to: "2026-05-29T11:00:00.000Z",
      } as any),
    ).rejects.toThrow(BadRequestException);
  });
});

