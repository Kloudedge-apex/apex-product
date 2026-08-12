import { beforeEach, describe, expect, it, vi } from "vitest";
import { OutreachSuppressionReason } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { SuppressionService } from "../suppression.service";

function mockPrisma() {
  const outreachSuppression = {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
  const client = {
    outreachSuppression,
    $queryRaw: vi.fn().mockResolvedValue([]),
    $transaction: vi.fn(),
  };
  client.$transaction.mockImplementation(
    async (operation: (tx: typeof client) => Promise<unknown>) =>
      operation(client),
  );
  return {
    client: client as unknown as PrismaService,
    outreachSuppression,
    $queryRaw: client.$queryRaw,
    $transaction: client.$transaction,
  };
}

describe("SuppressionService legacy Gmail reply-stop compatibility", () => {
  let prisma: ReturnType<typeof mockPrisma>;
  let service: SuppressionService;

  beforeEach(() => {
    prisma = mockPrisma();
    service = new SuppressionService(prisma.client);
  });

  it("bypasses only an exact MANUAL/source=gmail_reply row when explicitly requested", async () => {
    prisma.outreachSuppression.findUnique.mockResolvedValue({
      id: "sup_legacy",
      reason: OutreachSuppressionReason.MANUAL,
      source: "gmail_reply",
    });

    await expect(
      service.isSuppressed("org_1", " Prospect@Example.com "),
    ).resolves.toBe(true);
    await expect(
      service.isSuppressed("org_1", " Prospect@Example.com ", {
        allowLegacyReplyStop: true,
      }),
    ).resolves.toBe(false);

    expect(prisma.outreachSuppression.findUnique).toHaveBeenLastCalledWith({
      where: {
        orgId_recipientRef: {
          orgId: "org_1",
          recipientRef: "prospect@example.com",
        },
      },
      select: { id: true, reason: true, source: true },
    });
  });

  it.each([
    {
      label: "different reason",
      reason: OutreachSuppressionReason.USER_UNSUBSCRIBED,
      source: "gmail_reply",
    },
    {
      label: "different source",
      reason: OutreachSuppressionReason.MANUAL,
      source: "admin_manual",
    },
    {
      label: "case-mismatched source",
      reason: OutreachSuppressionReason.MANUAL,
      source: "Gmail_reply",
    },
  ])("does not bypass a $label row", async ({ reason, source }) => {
    prisma.outreachSuppression.findUnique.mockResolvedValue({
      id: "sup_real",
      reason,
      source,
    });

    await expect(
      service.isSuppressed("org_1", "prospect@example.com", {
        allowLegacyReplyStop: true,
      }),
    ).resolves.toBe(true);
  });

  it("fails closed even when the legacy bypass was requested", async () => {
    prisma.outreachSuppression.findUnique.mockRejectedValue(
      new Error("database unavailable"),
    );

    await expect(
      service.isSuppressed("org_1", "prospect@example.com", {
        allowLegacyReplyStop: true,
      }),
    ).resolves.toBe(true);
  });

  it("serializes a suppression write under the shared org reservation lock", async () => {
    prisma.outreachSuppression.findUnique.mockResolvedValue(null);
    prisma.outreachSuppression.create.mockResolvedValue({ id: "sup_new" });

    await expect(
      service.suppress({
        orgId: "org_1",
        recipientRef: " Prospect@Example.com ",
        reason: OutreachSuppressionReason.USER_UNSUBSCRIBED,
        source: "list_unsubscribe",
      }),
    ).resolves.toEqual({ created: true });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    const lockCall = prisma.$queryRaw.mock.calls[0] as unknown[];
    expect((lockCall[0] as readonly string[]).join("?")).toContain(
      "pg_advisory_xact_lock",
    );
    expect(lockCall[1]).toBe("outreach-send-reservation:org_1");
    expect(prisma.outreachSuppression.create).toHaveBeenCalledWith({
      data: {
        orgId: "org_1",
        recipientRef: "prospect@example.com",
        reason: OutreachSuppressionReason.USER_UNSUBSCRIBED,
        source: "list_unsubscribe",
        metadata: undefined,
      },
    });
    expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.outreachSuppression.findUnique.mock.invocationCallOrder[0],
    );
    expect(
      prisma.outreachSuppression.findUnique.mock.invocationCallOrder[0],
    ).toBeLessThan(
      prisma.outreachSuppression.create.mock.invocationCallOrder[0],
    );
  });

  it("serializes an admin unsuppress under the same org lock", async () => {
    prisma.outreachSuppression.findUnique.mockResolvedValue({
      id: "sup_1",
      orgId: "org_1",
      recipientRef: "prospect@example.com",
    });
    prisma.outreachSuppression.delete.mockResolvedValue({ id: "sup_1" });

    await expect(service.unsuppress("org_1", "sup_1")).resolves.toBe(true);

    expect(prisma.outreachSuppression.delete).toHaveBeenCalledWith({
      where: { id: "sup_1" },
    });
    expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.outreachSuppression.delete.mock.invocationCallOrder[0],
    );
  });

  it.each([
    {
      reason: OutreachSuppressionReason.USER_UNSUBSCRIBED,
      source: "list_unsubscribe",
    },
    {
      reason: OutreachSuppressionReason.BOUNCED,
      source: "gmail_dsn",
    },
    {
      reason: OutreachSuppressionReason.COMPLAINED,
      source: "provider_complaint",
    },
    {
      reason: OutreachSuppressionReason.MANUAL,
      source: "admin_manual",
    },
  ])(
    "upgrades a legacy reply-stop to $reason/$source so replies are blocked",
    async ({ reason, source }) => {
      prisma.outreachSuppression.findUnique
        .mockResolvedValueOnce({
          id: "sup_legacy",
          reason: OutreachSuppressionReason.MANUAL,
          source: "gmail_reply",
        })
        .mockResolvedValueOnce({ id: "sup_legacy", reason, source });
      prisma.outreachSuppression.update.mockResolvedValue({ id: "sup_legacy" });

      await expect(
        service.suppress({
          orgId: "org_1",
          recipientRef: "Prospect@Example.com",
          reason,
          source,
          metadata: { eventId: "evt_1" },
        }),
      ).resolves.toEqual({ created: false, upgraded: true });

      expect(prisma.outreachSuppression.update).toHaveBeenCalledWith({
        where: { id: "sup_legacy" },
        data: {
          reason,
          source,
          metadata: { eventId: "evt_1" },
        },
      });
      await expect(
        service.isSuppressed("org_1", "prospect@example.com", {
          allowLegacyReplyStop: true,
        }),
      ).resolves.toBe(true);
    },
  );

  it("never downgrades a real suppression when a legacy reply event is replayed", async () => {
    prisma.outreachSuppression.findUnique.mockResolvedValue({
      id: "sup_real",
      reason: OutreachSuppressionReason.USER_UNSUBSCRIBED,
      source: "list_unsubscribe",
    });

    await expect(
      service.suppress({
        orgId: "org_1",
        recipientRef: "prospect@example.com",
        reason: OutreachSuppressionReason.MANUAL,
        source: "gmail_reply",
      }),
    ).resolves.toEqual({ created: false });

    expect(prisma.outreachSuppression.update).not.toHaveBeenCalled();
    expect(prisma.outreachSuppression.create).not.toHaveBeenCalled();
  });
});
