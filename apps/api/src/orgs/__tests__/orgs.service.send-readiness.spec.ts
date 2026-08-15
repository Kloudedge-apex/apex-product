import { afterEach, describe, expect, it, vi } from "vitest";
import { OrgsService, SendReadiness } from "../orgs.service";

/**
 * GL5 — GET /orgs/me sendReadiness contract.
 *
 * The FE renders Dry Run / Live badges and the go-live checklist from this
 * object, so each field's derivation is pinned here against a mocked prisma:
 *
 *   liveSendAllowed    ← isLiveSendAllowedForOrg (OUTREACH_LIVE_FOR_ORGS)
 *   physicalAddressSet ← Org.physicalAddress satisfies the persisted 5-char floor
 *   senderNameSet      ← Org.senderName non-empty after trim
 *   countrySet         ← Org.country is uppercase, assigned ISO-3166 alpha-2
 *   mailboxConnected   ← CONNECTED Gmail row has credentials, identity,
 *                        cursor, and an unexpired provider watch
 *   dailyCapRemaining  ← GL8a cap (OUTREACH_DAILY_CAP_PER_ORG, default 40)
 *                        minus confirmed/in-flight/unknown capacity, clamped
 *                        at 0
 */

const ORG_ID = "org_readiness_test";

interface MockPrisma {
  user: { findUnique: ReturnType<typeof vi.fn> };
  integration: { findFirst: ReturnType<typeof vi.fn> };
  outreachArtifact: { count: ReturnType<typeof vi.fn> };
}

function buildService(opts?: { mailboxCount?: number; sentToday?: number }): {
  service: OrgsService;
  prisma: MockPrisma;
} {
  const prisma: MockPrisma = {
    user: { findUnique: vi.fn() },
    integration: {
      findFirst: vi.fn().mockResolvedValue(
        (opts?.mailboxCount ?? 0) > 0
          ? {
              credentials: {
                watchExpiration: String(
                  Date.now() + 7 * 24 * 60 * 60 * 1000,
                ),
              },
            }
          : null,
      ),
    },
    outreachArtifact: {
      count: vi.fn().mockResolvedValue(opts?.sentToday ?? 0),
    },
  };
  const service = new OrgsService(prisma as never);
  return { service, prisma };
}

function orgRow(
  partial?: Partial<{
    physicalAddress: string | null;
    senderName: string | null;
    country: string | null;
  }>,
): {
  id: string;
  physicalAddress: string | null;
  senderName: string | null;
  country: string | null;
} {
  return {
    id: ORG_ID,
    physicalAddress: null,
    senderName: null,
    country: null,
    ...partial,
  };
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
      "countrySet",
      "dailyCapRemaining",
      "liveSendAllowed",
      "mailboxConnected",
      "physicalAddressSet",
      "senderNameSet",
    ]);
    expect(typeof readiness.liveSendAllowed).toBe("boolean");
    expect(typeof readiness.physicalAddressSet).toBe("boolean");
    expect(typeof readiness.senderNameSet).toBe("boolean");
    expect(typeof readiness.countrySet).toBe("boolean");
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
      ["abc", false],
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

    it.each([
      [null, false],
      ["us", false],
      ["ZZ", false],
      ["US", true],
    ] as const)("country %j → %s", async (country, expected) => {
      const { service } = buildService();
      const readiness = await service.computeSendReadiness(
        orgRow({ country }),
      );
      expect(readiness.countrySet).toBe(expected);
    });
  });

  describe("mailboxConnected (identified + watched Gmail integration)", () => {
    it("is false when no fully initialized Gmail integration exists", async () => {
      const { service } = buildService({ mailboxCount: 0 });
      const readiness = await service.computeSendReadiness(orgRow());
      expect(readiness.mailboxConnected).toBe(false);
    });

    it("is false after cursor expiry disables the integration and clears its cursor", async () => {
      const { service, prisma } = buildService({ mailboxCount: 0 });

      const readiness = await service.computeSendReadiness(orgRow());

      expect(readiness.mailboxConnected).toBe(false);
      expect(prisma.integration.findFirst).toHaveBeenCalledWith({
        where: expect.objectContaining({
          status: "CONNECTED",
          lastHistoryId: { not: null },
        }),
        select: { credentials: true },
      });
    });

    it("is true when an identified, watched Gmail integration exists", async () => {
      const { service } = buildService({ mailboxCount: 1 });
      const readiness = await service.computeSendReadiness(orgRow());
      expect(readiness.mailboxConnected).toBe(true);
    });

    it("fails closed unless Gmail has a resolved accountEmail and watch cursor", async () => {
      const { service, prisma } = buildService({ mailboxCount: 1 });
      await service.computeSendReadiness(orgRow());

      expect(prisma.integration.findFirst).toHaveBeenCalledTimes(1);
      expect(prisma.integration.findFirst).toHaveBeenCalledWith({
        where: {
          orgId: ORG_ID,
          status: "CONNECTED",
          provider: "gmail",
          credentials: {
            path: ["accountEmail"],
            string_contains: "@",
          },
          encryptedCredentials: { not: null },
          lastHistoryId: { not: null },
        },
        select: { credentials: true },
      });
    });

    it.each([
      ["missing", {}],
      ["invalid", { watchExpiration: "not-a-timestamp" }],
      ["expired", { watchExpiration: "1780000000000" }],
    ])("fails closed for a %s provider watch expiration", async (_name, credentials) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-08-13T12:00:00.000Z"));
      const { service, prisma } = buildService({ mailboxCount: 1 });
      prisma.integration.findFirst.mockResolvedValue({ credentials });

      const readiness = await service.computeSendReadiness(orgRow());

      expect(readiness.mailboxConnected).toBe(false);
    });
  });

  describe("dailyCapRemaining (GL8a cap minus reserved capacity, UTC)", () => {
    it("subtracts today's capacity usage from the default cap (40)", async () => {
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

    it("counts this org's confirmed, unresolved in-flight, and unknown delivery risk", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-06-13T15:30:00.000Z"));

      const { service, prisma } = buildService({ sentToday: 0 });
      await service.computeSendReadiness(orgRow());

      expect(prisma.outreachArtifact.count).toHaveBeenCalledTimes(1);
      expect(prisma.outreachArtifact.count).toHaveBeenCalledWith({
        where: {
          orgId: ORG_ID,
          OR: [
            {
              status: "SENT",
              sentAt: { gte: new Date("2026-06-13T00:00:00.000Z") },
            },
            {
              status: "SENDING",
            },
            {
              status: "DELIVERY_UNKNOWN",
              updatedAt: { gte: new Date("2026-06-13T00:00:00.000Z") },
            },
            {
              status: "REJECTED",
              reviewerNote: { startsWith: "delivery-unknown:" },
              updatedAt: { gte: new Date("2026-06-13T00:00:00.000Z") },
            },
          ],
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
      membershipActive: true,
      org: {
        id: ORG_ID,
        name: "Nikxius",
        physicalAddress: "221B Baker Street, London",
        senderName: "Ava",
        country: "GB",
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
      countrySet: true,
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
    expect(prisma.integration.findFirst).not.toHaveBeenCalled();
    expect(prisma.outreachArtifact.count).not.toHaveBeenCalled();
  });

  it("returns null for an inactive membership without exposing the old tenant", async () => {
    const { service, prisma } = buildService();
    prisma.user.findUnique.mockResolvedValue({
      membershipActive: false,
      org: { id: ORG_ID },
    });

    await expect(
      service.findByClerkUser("user_clerk_removed"),
    ).resolves.toBeNull();
    expect(prisma.integration.findFirst).not.toHaveBeenCalled();
    expect(prisma.outreachArtifact.count).not.toHaveBeenCalled();
  });
});
