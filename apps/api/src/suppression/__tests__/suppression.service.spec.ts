import { describe, it, expect, vi, beforeEach } from "vitest";
import { BadRequestException } from "@nestjs/common";
import {
  SuppressionEntry,
  SuppressionKind,
  SuppressionScope,
} from "@prisma/client";
import { SuppressionService } from "../suppression.service";
import { PrismaService } from "../../prisma/prisma.service";
import { EvidenceLedgerService } from "../../observability/evidence-ledger.service";

function entryRow(overrides: Partial<SuppressionEntry> = {}): SuppressionEntry {
  const now = new Date("2026-05-25T12:00:00Z");
  return {
    id: "sup_1",
    orgId: "org_1",
    scope: SuppressionScope.ORG,
    kind: SuppressionKind.UNSUBSCRIBE,
    subjectEmail: "dest@example.com",
    subjectDomain: null,
    subjectThreadId: null,
    senderMailboxId: null,
    expiresAt: null,
    source: "manual",
    reason: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function mockPrisma() {
  return {
    suppressionEntry: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
  } as unknown as PrismaService & {
    suppressionEntry: {
      create: ReturnType<typeof vi.fn>;
      findFirst: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
    };
  };
}

function mockLedger() {
  return {
    suppressionCreated: vi.fn().mockResolvedValue(undefined),
  } as unknown as EvidenceLedgerService & {
    suppressionCreated: ReturnType<typeof vi.fn>;
  };
}

describe("SuppressionService", () => {
  let prisma: ReturnType<typeof mockPrisma>;
  let ledger: ReturnType<typeof mockLedger>;
  let service: SuppressionService;

  beforeEach(() => {
    prisma = mockPrisma();
    ledger = mockLedger();
    service = new SuppressionService(prisma, ledger);
  });

  describe("add", () => {
    it("rejects GLOBAL writes without internalCli=true", async () => {
      await expect(
        service.add({
          orgId: null,
          scope: SuppressionScope.GLOBAL,
          kind: SuppressionKind.UNSUBSCRIBE,
          subjectEmail: "a@b.com",
          source: "manual-ops",
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("accepts GLOBAL writes when internalCli=true and orgId=null", async () => {
      prisma.suppressionEntry.create.mockResolvedValueOnce(
        entryRow({ id: "sup_global", orgId: null, scope: SuppressionScope.GLOBAL }),
      );

      const created = await service.add({
        orgId: null,
        scope: SuppressionScope.GLOBAL,
        kind: SuppressionKind.UNSUBSCRIBE,
        subjectEmail: "A@B.com",
        source: "manual-ops",
        internalCli: true,
      });

      expect(created.id).toBe("sup_global");
      expect(prisma.suppressionEntry.create).toHaveBeenCalledTimes(1);
    });

    it("rejects non-GLOBAL writes when orgId is null", async () => {
      await expect(
        service.add({
          orgId: null,
          scope: SuppressionScope.ORG,
          kind: SuppressionKind.UNSUBSCRIBE,
          subjectEmail: "a@b.com",
          source: "manual",
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("dedupes via partial-unique (P2002) by returning findFirst match", async () => {
      prisma.suppressionEntry.create.mockRejectedValueOnce({ code: "P2002" });
      prisma.suppressionEntry.findFirst.mockResolvedValueOnce(
        entryRow({ id: "sup_existing" }),
      );

      const result = await service.add({
        orgId: "org_1",
        scope: SuppressionScope.ORG,
        kind: SuppressionKind.UNSUBSCRIBE,
        subjectEmail: "dest@example.com",
        source: "inbound-reply",
      });

      expect(result.id).toBe("sup_existing");
      expect(prisma.suppressionEntry.findFirst).toHaveBeenCalledTimes(1);
    });
  });

  describe("isSuppressed", () => {
    it("matches GLOBAL by subjectEmail", async () => {
      prisma.suppressionEntry.findMany.mockResolvedValueOnce([
        entryRow({
          id: "sup_g",
          orgId: null,
          scope: SuppressionScope.GLOBAL,
          subjectEmail: "dest@example.com",
        }),
      ]);

      const res = await service.isSuppressed({
        orgId: "org_1",
        recipientEmail: "dest@example.com",
      });

      expect(res.suppressed).toBe(true);
      expect(res.matchedEntries.map((e) => e.id)).toEqual(["sup_g"]);
    });

    it("matches ORG by subjectDomain", async () => {
      prisma.suppressionEntry.findMany.mockResolvedValueOnce([
        entryRow({
          id: "sup_org_domain",
          orgId: "org_1",
          scope: SuppressionScope.ORG,
          subjectEmail: null,
          subjectDomain: "example.com",
        }),
      ]);

      const res = await service.isSuppressed({
        orgId: "org_1",
        recipientEmail: "Any@Example.com",
      });
      expect(res.suppressed).toBe(true);
      expect(res.matchedEntries[0]?.id).toBe("sup_org_domain");
    });

    it("matches SENDER only when senderMailboxId matches", async () => {
      prisma.suppressionEntry.findMany.mockResolvedValue([
        entryRow({
          id: "sup_sender",
          orgId: "org_1",
          scope: SuppressionScope.SENDER,
          senderMailboxId: "sender@apex.test",
          subjectEmail: "dest@example.com",
        }),
      ]);

      const miss = await service.isSuppressed({
        orgId: "org_1",
        recipientEmail: "dest@example.com",
        senderMailboxId: "other@apex.test",
      });
      expect(miss.suppressed).toBe(false);

      const hit = await service.isSuppressed({
        orgId: "org_1",
        recipientEmail: "dest@example.com",
        senderMailboxId: "sender@apex.test",
      });
      expect(hit.suppressed).toBe(true);
      expect(hit.matchedEntries[0]?.id).toBe("sup_sender");
    });

    it("matches THREAD by subjectThreadId", async () => {
      prisma.suppressionEntry.findMany.mockResolvedValueOnce([
        entryRow({
          id: "sup_thread",
          orgId: "org_1",
          scope: SuppressionScope.THREAD,
          subjectEmail: null,
          subjectThreadId: "thread_1",
        }),
      ]);

      const res = await service.isSuppressed({
        orgId: "org_1",
        recipientEmail: "dest@example.com",
        threadId: "thread_1",
      });

      expect(res.suppressed).toBe(true);
      expect(res.matchedEntries[0]?.id).toBe("sup_thread");
    });

    it("skips expired rows", async () => {
      prisma.suppressionEntry.findMany.mockResolvedValueOnce([
        entryRow({
          id: "sup_expired",
          orgId: "org_1",
          scope: SuppressionScope.ORG,
          expiresAt: new Date("2026-05-01T00:00:00Z"),
        }),
      ]);

      const res = await service.isSuppressed({
        orgId: "org_1",
        recipientEmail: "dest@example.com",
      });
      expect(res.suppressed).toBe(false);
      expect(res.matchedEntries).toEqual([]);
    });

    it("orders matches THREAD > SENDER > ORG > GLOBAL", async () => {
      prisma.suppressionEntry.findMany.mockResolvedValueOnce([
        entryRow({
          id: "sup_org",
          orgId: "org_1",
          scope: SuppressionScope.ORG,
          subjectEmail: "dest@example.com",
        }),
        entryRow({
          id: "sup_thread",
          orgId: "org_1",
          scope: SuppressionScope.THREAD,
          subjectEmail: null,
          subjectThreadId: "thread_1",
        }),
        entryRow({
          id: "sup_global",
          orgId: null,
          scope: SuppressionScope.GLOBAL,
          subjectEmail: "dest@example.com",
        }),
      ]);

      const res = await service.isSuppressed({
        orgId: "org_1",
        recipientEmail: "dest@example.com",
        threadId: "thread_1",
      });
      expect(res.suppressed).toBe(true);
      expect(res.matchedEntries.map((e) => e.id)).toEqual([
        "sup_thread",
        "sup_org",
        "sup_global",
      ]);
    });
  });
});
