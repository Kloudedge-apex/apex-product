import { afterEach, describe, expect, it, vi } from "vitest";
import { OrgsService, type OnboardingStatus } from "../orgs.service";

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_API_PUBLIC_URL = process.env.API_PUBLIC_URL;

function completeStatus(
  overrides: Partial<OnboardingStatus["sendReadiness"]> = {},
): OnboardingStatus {
  const sendReadiness = {
    liveSendAllowed: true,
    physicalAddressSet: true,
    senderNameSet: true,
    countrySet: true,
    mailboxConnected: true,
    dailyCapRemaining: 40,
    ...overrides,
  };
  return {
    organization: { nameSet: true, websiteSet: true, complete: true },
    senderIdentity: {
      senderNameSet: sendReadiness.senderNameSet,
      countrySet: sendReadiness.countrySet,
      physicalAddressSet: sendReadiness.physicalAddressSet,
      complete:
        sendReadiness.senderNameSet &&
        sendReadiness.countrySet &&
        sendReadiness.physicalAddressSet,
    },
    icp: { usable: true, complete: true },
    mailbox: {
      connected: sendReadiness.mailboxConnected,
      complete: sendReadiness.mailboxConnected,
    },
    sendReadiness,
    currentStep: "complete",
    complete: true,
    readyForLiveSend:
      sendReadiness.liveSendAllowed &&
      sendReadiness.mailboxConnected &&
      sendReadiness.senderNameSet &&
      sendReadiness.countrySet &&
      sendReadiness.physicalAddressSet &&
      sendReadiness.dailyCapRemaining !== null &&
      sendReadiness.dailyCapRemaining > 0,
  };
}

function buildService(suppressionCount = 3) {
  const prisma = {
    outreachSuppression: {
      count: vi.fn().mockResolvedValue(suppressionCount),
    },
  };
  const service = new OrgsService(prisma as never);
  return { service, prisma };
}

afterEach(() => {
  if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  if (ORIGINAL_API_PUBLIC_URL === undefined) delete process.env.API_PUBLIC_URL;
  else process.env.API_PUBLIC_URL = ORIGINAL_API_PUBLIC_URL;
  vi.restoreAllMocks();
});

describe("OrgsService.getOrgHealth", () => {
  it("returns a green projection only when every persisted and runtime gate is ready", async () => {
    process.env.NODE_ENV = "production";
    process.env.API_PUBLIC_URL = "https://api.workforceos.xyz";
    const { service, prisma } = buildService(7);
    vi.spyOn(service, "getOnboardingStatus").mockResolvedValue(
      completeStatus(),
    );

    await expect(service.getOrgHealth("org_1")).resolves.toEqual({
      liveSendEnabled: true,
      postalAddressConfigured: true,
      unsubscribeConfigured: true,
      suppressionCount: 7,
      blockers: [],
    });
    expect(prisma.outreachSuppression.count).toHaveBeenCalledWith({
      where: { orgId: "org_1" },
    });
  });

  it("fails closed and reports concrete blockers without exposing suppression rows", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.API_PUBLIC_URL;
    const { service } = buildService(2);
    vi.spyOn(service, "getOnboardingStatus").mockResolvedValue(
      completeStatus({
        liveSendAllowed: false,
        mailboxConnected: false,
        physicalAddressSet: false,
        dailyCapRemaining: 0,
      }),
    );

    const health = await service.getOrgHealth("org_1");
    expect(health).toMatchObject({
      liveSendEnabled: false,
      postalAddressConfigured: false,
      unsubscribeConfigured: false,
      suppressionCount: 2,
    });
    expect(health.blockers).toEqual(
      expect.arrayContaining([
        "Physical postal address is missing",
        "Gmail mailbox is not ready",
        "Public unsubscribe origin is not configured",
        "Live sending is not enabled for this workspace",
        "Daily send capacity is unavailable",
      ]),
    );
  });
});
