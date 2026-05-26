import { describe, it, expect, beforeEach, vi } from "vitest";
import { NotFoundException } from "@nestjs/common";
import { IntegrationsService } from "../integrations.service";
import { PrismaService } from "../../prisma/prisma.service";

/**
 * IDOR regression coverage for `IntegrationsService.findOne` and the
 * `disconnect` ("remove") path that builds on it.
 *
 * The service must scope every lookup by `orgId` so a stolen integration id
 * from another tenant can't be read or deleted. Before the fix, neither method
 * accepted `orgId` and Prisma was queried by `id` alone, leaking + allowing
 * delete of encrypted-credential rows across tenants.
 */

type Fn = ReturnType<typeof vi.fn>;

function mockPrisma(): PrismaService & {
  integration: {
    findFirst: Fn;
    delete: Fn;
  };
} {
  return {
    integration: {
      findFirst: vi.fn(),
      delete: vi.fn(),
    },
  } as unknown as PrismaService & {
    integration: {
      findFirst: Fn;
      delete: Fn;
    };
  };
}

describe("IntegrationsService.findOne (IDOR scoping)", () => {
  let prisma: ReturnType<typeof mockPrisma>;
  let service: IntegrationsService;

  beforeEach(() => {
    prisma = mockPrisma();
    service = new IntegrationsService(prisma as unknown as PrismaService);
  });

  it("includes orgId in the Prisma where clause", async () => {
    prisma.integration.findFirst.mockResolvedValue({
      id: "int_1",
      orgId: "org_a",
      provider: "gmail",
      status: "CONNECTED",
      credentials: { encrypted: "x" },
    });

    await service.findOne("int_1", "org_a");

    expect(prisma.integration.findFirst).toHaveBeenCalledTimes(1);
    const callArg = prisma.integration.findFirst.mock.calls[0][0];
    expect(callArg.where).toEqual({ id: "int_1", orgId: "org_a" });
  });

  it("throws NotFoundException when the integration belongs to a different org", async () => {
    prisma.integration.findFirst.mockResolvedValue(null);

    await expect(
      service.findOne("int_owned_by_org_a", "org_b"),
    ).rejects.toBeInstanceOf(NotFoundException);

    const callArg = prisma.integration.findFirst.mock.calls[0][0];
    expect(callArg.where).toEqual({
      id: "int_owned_by_org_a",
      orgId: "org_b",
    });
  });

  describe("disconnect (controller `remove`)", () => {
    it("refuses to delete an integration owned by another org", async () => {
      // `disconnect` delegates to `findOne` for the org check; cross-org
      // lookup returns null so the underlying Prisma delete must never fire.
      prisma.integration.findFirst.mockResolvedValue(null);

      await expect(
        service.disconnect("int_owned_by_org_a", "org_b"),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(prisma.integration.delete).not.toHaveBeenCalled();
    });

    it("deletes by id once cross-org check passes", async () => {
      prisma.integration.findFirst.mockResolvedValue({
        id: "int_1",
        orgId: "org_a",
        provider: "gmail",
        status: "CONNECTED",
        credentials: { encrypted: "x" },
      });
      prisma.integration.delete.mockResolvedValue({ id: "int_1" });

      await service.disconnect("int_1", "org_a");

      expect(prisma.integration.delete).toHaveBeenCalledWith({
        where: { id: "int_1" },
      });
    });
  });
});
