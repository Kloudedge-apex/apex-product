import { afterEach, describe, expect, it, vi } from "vitest";
import { OrgsService, SendReadiness } from "../orgs.service";

/**
 * GL5 — GET /orgs/me sendReadiness contract.
 *
 * The FE renders Dry Run / Live badges and the go-live checklist from this
 * object, so each field's derivation is pinned here against a mocked prisma:
 *
 *   liveSendAllowed    ← isLiveSendAllowedForOrg (OUTREACH_LIVE_FOR_ORGS)
 *   physicalAddressSet ← Org.physicalAddress non-empty after trim
 *   senderNameSet      ← Org.senderName non-empty after trim
 *   mailboxConnected   ← CONNECTED gmail/outlook Integration row exists
 *   dailyCapRemaining  ← GL8a cap (OUTREACH_DAILY_CAP_PER_ORG, default 40)
 *                        minus SENT-today (UTC), clamped at 0
 */

const ORG_ID = "org_readiness_test";

interface MockPrisma {
  user: { findUnique: ReturnType<typeof vi.fn> };
  integration: { count: ReturnType<typeof vi.fn> };
  outreachArtifact: { count: ReturnType<typeof vi.fn> };
}

function buildService(opts?: { mailboxCount?: number; sentToday?: number }): {
  service: OrgsService;
  prisma: MockPrisma;
} {
  const prisma: MockPrisma = {
    user: { findUnique: vi.fn() },
    integration: {
      count: vi.fn().mockResolvedValue(opts?.mailboxCount ?? 0),
    },
    outreachArtifact: {
      count: vi.fn().mockResolvedValue(opts?.sentToday ?? 0),
    },
  };
  const service = new OrgsService(prisma as never);
  return { service, prisma };
}

function orgRow(
  partial?: Partial<{ physicalAddress: string | null; senderName: string | null }>,
): { id: string; physicalAddress: string | null; senderName: string | null } {
  return { id: ORG_ID, physicalAddress: null, senderName: null, ...partial };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("OrgsService.computeSendReadiness", () => {
  it("returns the full GL5 contract shape", async () => {
    const { service } = buildService();
    const readiness = await service.computeSendReadiness(orgRow());

    expect(Object.keys(readiness).sort()).toEqual([
      "dailyCapRemaining",
      "liveSendAllowed",
      "mailboxConnected",
      "physicalAddressSet",
      "senderNameSet",
    ]);
    expect(typeof readiness.liveSendAllowed).toBe("boolean");
    expect(typeof readiness.physicalAddressSet).toBe("boolean");
    expect(typeof readiness.senderNameSet).toBe("boolean");
    expect(typeof readiness.mailboxConnected).toBe("boolean");
    expect(typeof readiness.dailyCapRemaining).toBe("number");
  });

  describe("liveSendAllowed (OUTREACH_LIVE_FOR_ORGS allowlist)", () => {
    it("is false when the allowlist env is unset (fail-closed)", async () => {
      vi.stubEnv("OUTREACH_LIVE_FOR_ORGS", "");
      const { service } = buildService();
      const readiness = await service.computeSendReadiness(orgRow());
      expect(readiness.liveSendAllowed).toBe(false);
    });

    it("is true when the org is on the allowlist", async () => {
      vi.stubEnv("OUTREACH_LIVE_FOR_ORGS", `other_org,${ORG_ID}`);
      const { service } = buildService();
      const readiness = await service.computeSendReadiness(orgRow());
      expect(readiness.liveSendAllowed).toBe(true);
    });

    it("is false when only other orgs are allowlisted", async () => {
      vi.stubEnv("OUTREACH_LIVE_FOR_ORGS", "other_org_a,other_org_b");
      const { service } = buildService();
      const readiness = await service.computeSendReadiness(orgRow());
      expect(readiness.liveSendAllowed).toBe(false);
    });
  });

  describe("physicalAddressSet / senderNameSet (non-empty after trim)", () => {
    const addressCases: ReadonlyArray<[string | null, boolean]> = [
      [null, false],
      ["", false],
      ["   ", false],
      ["221B Baker Street, London", true],
    ];
    it.each(addressCases)(
      "physicalAddress %j → %s",
      async (physicalAddress, expected) => {
        const { service } = buildService();
        const readiness = await service.computeSendReadiness(
          orgRow({ physicalAddress }),
        );
        expect(readiness.physicalAddressSet).toBe(expected);
      },
    );

    const senderCases: ReadonlyArray<[string | null, boolean]> = [
      [null, false],
      ["", false],
      ["  \t ", false],
      ["Ava from Nikxius", true],
    ];
    it.each(senderCases)("senderName %j → %s", async (senderName, expected) => {
      const { service } = buildService();
      const readiness = await service.computeSendReadiness(
        orgRow({ senderName }),
      );
      expect(readiness.senderNameSet).toBe(expected);
    });
  });

  describe("mailboxConnected (CONNECTED gmail/outlook Integration)", () => {
    it("is false when no CONNECTED mailbox integration exists", async () => {
      const { service } = buildService({ mailboxCount: 0 });
      const readiness = await service.computeSendReadiness(orgRow());
      expect(readiness.mailboxConnected).toBe(false);
    });

    it("is true when a CONNECTED mailbox integration exists", async () => {
      const { service } = buildService({ mailboxCount: 1 });
      const readiness = await service.computeSendReadiness(orgRow());
      expect(readiness.mailboxConnected).toBe(true);
    });

    it("scopes the count to this org, CONNECTED status, mailbox providers only", async () => {
      const { service, prisma } = buildService({ mailboxCount: 1 });
      await service.computeSendReadiness(orgRow());

      expect(prisma.integration.count).toHaveBeenCalledTimes(1);
      expect(prisma.integration.count).toHaveBeenCalledWith({
        where: {
          orgId: ORG_ID,
          status: "CONNECTED",
          provider: { in: ["gmail", "outlook"] },
        },
      });
    });
  });

  describe("dailyCapRemaining (GL8a cap minus SENT-today, UTC)", () => {
    it("subtracts today's SENT count from the default cap (40)", async () => {
      const { service } = buildService({ sentToday: 7 });
      const readiness = await service.computeSendReadiness(orgRow());
      expect(readiness.dailyCapRemaining).toBe(33);
    });

    it("clamps at 0 when the org is over cap", async () => {
      const { service } = buildService({ sentToday: 45 });
      const readiness = await service.computeSendReadiness(orgRow());
      expect(readiness.dailyCapRemaining).toBe(0);
    });

    it("honors the OUTREACH_DAILY_CAP_PER_ORG override", async () => {
      vi.stubEnv("OUTREACH_DAILY_CAP_PER_ORG", "10");
      const { service } = buildService({ sentToday: 4 });
      const readiness = await service.computeSendReadiness(orgRow());
      expect(readiness.dailyCapRemaining).toBe(6);
    });

    it("counts only this org's real sends since midnight UTC", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-06-13T15:30:00.000Z"));

      const { service, prisma } = buildService({ sentToday: 0 });
      await service.computeSendReadiness(orgRow());

      expect(prisma.outreachArtifact.count).toHaveBeenCalledTimes(1);
      expect(prisma.outreachArtifact.count).toHaveBeenCalledWith({
        where: {
          orgId: ORG_ID,
          status: "SENT",
          sentAt: { gte: new Date("2026-06-13T00:00:00.000Z") },
        },
      });
    });
  });
});

describe("OrgsService.findByClerkUser (GET /orgs/me payload)", () => {
  it("attaches sendReadiness to the org payload", async () => {
    vi.stubEnv("OUTREACH_LIVE_FOR_ORGS", ORG_ID);
    const { service, prisma } = buildService({
      mailboxCount: 1,
      sentToday: 2,
    });
    prisma.user.findUnique.mockResolvedValue({
      id: "user_internal",
      org: {
        id: ORG_ID,
        name: "Nikxius",
        physicalAddress: "221B Baker Street, London",
        senderName: "Ava",
        agents: [],
        integrations: [],
      },
    });

    const result = await service.findByClerkUser("user_clerk_test");

    expect(result).not.toBeNull();
    expect(result?.id).toBe(ORG_ID);
    expect(result?.name).toBe("Nikxius");
    const expected: SendReadiness = {
      liveSendAllowed: true,
      physicalAddressSet: true,
      senderNameSet: true,
      mailboxConnected: true,
      dailyCapRemaining: 38,
    };
    expect(result?.sendReadiness).toEqual(expected);
  });

  it("returns null (and runs no readiness queries) when the user is unknown", async () => {
    const { service, prisma } = buildService();
    prisma.user.findUnique.mockResolvedValue(null);

    const result = await service.findByClerkUser("user_clerk_missing");

    expect(result).toBeNull();
    expect(prisma.integration.count).not.toHaveBeenCalled();
    expect(prisma.outreachArtifact.count).not.toHaveBeenCalled();
  });
});
