import { describe, it, expect, beforeEach, vi } from "vitest";
import { NotFoundException } from "@nestjs/common";
import { IntegrationsService } from "../integrations.service";
import { PrismaService } from "../../prisma/prisma.service";

/**
 * IDOR regression coverage for `IntegrationsService.findOne` and the
 * history-safe `disconnect` path that builds on it.
 *
 * The service must scope every lookup by `orgId` so a stolen integration id
 * from another tenant can't be read or revoked. Before the IDOR fix, neither
 * method accepted `orgId` and Prisma was queried by `id` alone.
 */

type Fn = ReturnType<typeof vi.fn>;

function mockPrisma(): PrismaService & {
  $transaction: Fn;
  integration: {
    findMany: Fn;
    findFirst: Fn;
    updateMany: Fn;
  };
} {
  const prisma = {
    integration: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      updateMany: vi.fn(),
    },
  } as unknown as PrismaService & {
    $transaction: Fn;
    integration: {
      findMany: Fn;
      findFirst: Fn;
      updateMany: Fn;
    };
  };
  prisma.$transaction = vi.fn(async (operation: (tx: typeof prisma) => unknown) =>
    operation(prisma),
  );
  return prisma;
}

describe("IntegrationsService.findOne (IDOR scoping)", () => {
  let prisma: ReturnType<typeof mockPrisma>;
  let service: IntegrationsService;

  beforeEach(() => {
    prisma = mockPrisma();
    service = new IntegrationsService(prisma as unknown as PrismaService);
  });

  it("advertises only Gmail as available in the guarded release", () => {
    const catalog = service.getCatalog();
    expect(catalog).toEqual([
      expect.objectContaining({ provider: "gmail", status: "available" }),
    ]);
  });

  it("rejects generic callbacks so Gmail activation only uses GmailService", async () => {
    await expect(
      service.handleOAuthCallback("gmail", "mock_code", "org_a"),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it.each(["outlook", "hubspot", "linkedin", "arbitrary"])(
    "rejects non-Gmail provider auth for %s",
    (provider) => {
      expect(() => service.getOAuthUrl(provider, "org_a")).toThrow(
        NotFoundException,
      );
    },
  );

  it("rejects every direct integration write surface", async () => {
    await expect(
      service.create("org_a", {
        provider: "gmail",
        credentials: { access_token: "unsafe" },
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.simulateConnect("org_a", "gmail"),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.connectApiKey("org_a", "gmail", "unsafe"),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("includes orgId in the Prisma where clause", async () => {
    prisma.integration.findFirst.mockResolvedValue({
      id: "int_1",
      provider: "gmail",
      status: "CONNECTED",
      scopes: [],
    });

    await service.findOne("int_1", "org_a");

    expect(prisma.integration.findFirst).toHaveBeenCalledTimes(1);
    const callArg = prisma.integration.findFirst.mock.calls[0][0];
    expect(callArg.where).toEqual({
      id: "int_1",
      orgId: "org_a",
      provider: "gmail",
    });
    expect(callArg.select).not.toHaveProperty("credentials");
    expect(callArg.select).not.toHaveProperty("encryptedCredentials");
    expect(callArg.select).not.toHaveProperty("lastHistoryId");
  });

  it("uses a credential-free projection for integration lists", async () => {
    prisma.integration.findMany.mockResolvedValue([]);

    await service.findAll("org_a");

    const callArg = prisma.integration.findMany.mock.calls[0][0];
    expect(callArg.where).toEqual({ orgId: "org_a", provider: "gmail" });
    expect(callArg.select).not.toHaveProperty("credentials");
    expect(callArg.select).not.toHaveProperty("encryptedCredentials");
    expect(callArg.select).not.toHaveProperty("lastHistoryId");
    expect(callArg.select).toMatchObject({
      id: true,
      provider: true,
      status: true,
      lastSyncAt: true,
      lastErrorMessage: true,
    });
  });

  it("uses the same credential-free projection after OAuth finalization", async () => {
    prisma.integration.findFirst.mockResolvedValue({
      id: "int_1",
      provider: "gmail",
      status: "CONNECTED",
      scopes: [],
    });

    await service.findByProvider("org_a", "gmail");

    const callArg = prisma.integration.findFirst.mock.calls[0][0];
    expect(callArg.where).toEqual({ orgId: "org_a", provider: "gmail" });
    expect(callArg.select).not.toHaveProperty("credentials");
    expect(callArg.select).not.toHaveProperty("encryptedCredentials");
    expect(callArg.select).not.toHaveProperty("lastHistoryId");
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
      provider: "gmail",
    });
  });

  describe("disconnect (controller `remove`)", () => {
    it("refuses to revoke an integration owned by another org", async () => {
      // `disconnect` delegates to `findOne` for the org check; cross-org
      // lookup returns null so the underlying mutation must never fire.
      prisma.integration.findFirst.mockResolvedValue(null);

      await expect(
        service.disconnect("int_owned_by_org_a", "org_b"),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(prisma.integration.updateMany).not.toHaveBeenCalled();
    });

    it("scrubs credentials in place so retained conversations keep their integration", async () => {
      prisma.integration.findFirst
        .mockResolvedValueOnce({
          id: "int_1",
          provider: "gmail",
          status: "CONNECTED",
          scopes: ["gmail.send"],
        })
        .mockResolvedValueOnce({
          id: "int_1",
          provider: "gmail",
          status: "REVOKED",
          scopes: [],
          lastSyncAt: null,
          lastErrorAt: null,
          lastErrorMessage: null,
        });
      prisma.integration.updateMany.mockResolvedValue({ count: 1 });

      await expect(service.disconnect("int_1", "org_a")).resolves.toMatchObject({
        id: "int_1",
        status: "REVOKED",
      });

      expect(prisma.integration.updateMany).toHaveBeenCalledWith({
        where: { id: "int_1", orgId: "org_a", provider: "gmail" },
        data: {
          credentials: {},
          encryptedCredentials: null,
          status: "REVOKED",
          scopes: [],
          lastHistoryId: null,
          lastSyncAt: null,
          lastErrorAt: null,
          lastErrorMessage: null,
        },
      });
      const publicRead = prisma.integration.findFirst.mock.calls[1]?.[0];
      expect(publicRead.where).toEqual({
        id: "int_1",
        orgId: "org_a",
        provider: "gmail",
      });
      expect(publicRead.select).not.toHaveProperty("credentials");
      expect(publicRead.select).not.toHaveProperty("encryptedCredentials");
    });

    it("keeps provider disconnect retry-safe by revoking an existing tombstone", async () => {
      prisma.integration.findFirst
        .mockResolvedValueOnce({ id: "int_1" })
        .mockResolvedValueOnce({
          id: "int_1",
          provider: "gmail",
          status: "REVOKED",
          scopes: [],
        });
      prisma.integration.updateMany.mockResolvedValue({ count: 1 });

      await expect(
        service.disconnectByProvider("org_a", "gmail"),
      ).resolves.toMatchObject({ status: "REVOKED" });

      expect(prisma.integration.updateMany).toHaveBeenCalledOnce();
      expect(prisma.integration.updateMany.mock.calls[0]?.[0].where).toEqual({
        id: "int_1",
        orgId: "org_a",
        provider: "gmail",
      });
    });
  });
});
