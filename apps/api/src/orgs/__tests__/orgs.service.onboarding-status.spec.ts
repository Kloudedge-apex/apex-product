import { afterEach, describe, expect, it, vi } from "vitest";
import { OrgsService } from "../orgs.service";

const ORG_ID = "org_onboarding";

interface OrgRow {
  id: string;
  name: string;
  website: string | null;
  senderName: string | null;
  country: string | null;
  physicalAddress: string | null;
}

interface IcpRow {
  name: string;
  targetTitles: string[];
  targetIndustries: string[];
  targetGeos: string[];
  techStackSignals: string[];
  intentKeywords: string[];
  seedDomains: string[];
}

function completeOrg(overrides?: Partial<OrgRow>): OrgRow {
  return {
    id: ORG_ID,
    name: "Acme",
    website: "https://acme.example/",
    senderName: "Ava",
    country: "US",
    physicalAddress: "1 Market Street, San Francisco, CA",
    ...overrides,
  };
}

function usableIcp(overrides?: Partial<IcpRow>): IcpRow {
  return {
    name: "Mid-market SaaS",
    targetTitles: ["VP Sales"],
    targetIndustries: [],
    targetGeos: [],
    techStackSignals: [],
    intentKeywords: [],
    seedDomains: [],
    ...overrides,
  };
}

function buildService(options?: {
  org?: OrgRow | null;
  icps?: IcpRow[];
  mailboxCount?: number;
  sentToday?: number;
}) {
  const prisma = {
    org: {
      findUnique: vi.fn().mockResolvedValue(options?.org ?? completeOrg()),
    },
    icpProfile: {
      findFirst: vi.fn().mockResolvedValue((options?.icps ?? [usableIcp()])[0] ?? null),
    },
    integration: {
      count: vi.fn().mockResolvedValue(options?.mailboxCount ?? 1),
    },
    outreachArtifact: {
      count: vi.fn().mockResolvedValue(options?.sentToday ?? 0),
    },
  };
  return { service: new OrgsService(prisma as never), prisma };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("OrgsService.getOnboardingStatus", () => {
  it("derives complete and live-ready truth from org-scoped persisted state", async () => {
    vi.stubEnv("OUTREACH_LIVE_FOR_ORGS", ORG_ID);
    vi.stubEnv("OUTREACH_DAILY_CAP_PER_ORG", "10");
    const { service, prisma } = buildService({ sentToday: 2 });

    await expect(service.getOnboardingStatus(ORG_ID)).resolves.toEqual({
      organization: {
        nameSet: true,
        websiteSet: true,
        complete: true,
      },
      senderIdentity: {
        senderNameSet: true,
        countrySet: true,
        physicalAddressSet: true,
        complete: true,
      },
      icp: { usable: true, complete: true },
      mailbox: { connected: true, complete: true },
      sendReadiness: {
        liveSendAllowed: true,
        physicalAddressSet: true,
        senderNameSet: true,
        mailboxConnected: true,
        dailyCapRemaining: 8,
      },
      currentStep: "complete",
      complete: true,
      readyForLiveSend: true,
    });

    expect(prisma.org.findUnique).toHaveBeenCalledWith({
      where: { id: ORG_ID },
      select: {
        id: true,
        name: true,
        website: true,
        senderName: true,
        country: true,
        physicalAddress: true,
      },
    });
    expect(prisma.icpProfile.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { orgId: ORG_ID },
        orderBy: { updatedAt: "desc" },
      }),
    );
    expect(prisma.integration.count).toHaveBeenCalledWith({
      where: {
        orgId: ORG_ID,
        status: "CONNECTED",
        provider: { in: ["gmail", "outlook"] },
      },
    });
  });

  it("marks setup complete without fabricating operator allowlisting", async () => {
    vi.stubEnv("OUTREACH_LIVE_FOR_ORGS", "another_org");
    const { service } = buildService();

    const status = await service.getOnboardingStatus(ORG_ID);

    expect(status.complete).toBe(true);
    expect(status.currentStep).toBe("complete");
    expect(status.sendReadiness.liveSendAllowed).toBe(false);
    expect(status.readyForLiveSend).toBe(false);
  });

  it("requires a nonblank targeting signal before an ICP is usable", async () => {
    const emptyIcp = usableIcp({
      targetTitles: ["   "],
      targetIndustries: [],
      targetGeos: [],
      techStackSignals: [],
      intentKeywords: [],
      seedDomains: [],
    });
    const { service } = buildService({ icps: [emptyIcp] });

    const status = await service.getOnboardingStatus(ORG_ID);

    expect(status.icp).toEqual({ usable: false, complete: false });
    expect(status.currentStep).toBe("icp");
    expect(status.complete).toBe(false);
    expect(status.readyForLiveSend).toBe(false);
  });

  it("requires an assigned uppercase ISO country and follows step order", async () => {
    const { service } = buildService({
      org: completeOrg({ country: "ZZ", website: null }),
      icps: [],
      mailboxCount: 0,
    });

    const status = await service.getOnboardingStatus(ORG_ID);

    expect(status.organization).toEqual({
      nameSet: true,
      websiteSet: false,
      complete: false,
    });
    expect(status.senderIdentity.countrySet).toBe(false);
    expect(status.currentStep).toBe("organization");
  });

  it("keeps live readiness false when the daily cap has no headroom", async () => {
    vi.stubEnv("OUTREACH_LIVE_FOR_ORGS", ORG_ID);
    vi.stubEnv("OUTREACH_DAILY_CAP_PER_ORG", "2");
    const { service } = buildService({ sentToday: 2 });

    const status = await service.getOnboardingStatus(ORG_ID);

    expect(status.complete).toBe(true);
    expect(status.sendReadiness.dailyCapRemaining).toBe(0);
    expect(status.readyForLiveSend).toBe(false);
  });
});
