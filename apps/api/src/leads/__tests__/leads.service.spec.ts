import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ConflictException } from "@nestjs/common";
import { LeadsService } from "../leads.service";
import { PrismaService } from "../../prisma/prisma.service";
import { AtsScraper } from "../sources/ats-scraper.service";
import { TeamPageScraper } from "../sources/team-page-scraper.service";
import { RegistryScraper } from "../sources/registry-scraper.service";
import { GithubEnrichment } from "../sources/github-enrichment.service";
import { JobSignalService } from "../sources/job-signal.service";
import { SerpDiscoveryService } from "../sources/serp-discovery.service";
import { TheirStackService } from "../sources/theirstack.service";
import { EmailPatternService } from "../enrichment/email-pattern.service";
import { IdentityResolver } from "../enrichment/identity-resolver.service";
import { LeadScorer } from "../scoring/lead-scorer.service";

function mockPrisma() {
  return {
    scrapeJob: {
      findFirst: vi.fn(),
    },
    icpProfile: {
      findFirstOrThrow: vi.fn(),
      update: vi.fn(),
    },
  } as unknown as PrismaService & {
    scrapeJob: { findFirst: ReturnType<typeof vi.fn> };
    icpProfile: {
      findFirstOrThrow: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
  };
}

function buildService(prisma: ReturnType<typeof mockPrisma>): LeadsService {
  // The collaborators are not exercised by the flag gate; safe to stub as empty objects.
  const stub = {} as never;
  return new LeadsService(
    prisma,
    stub as AtsScraper,
    stub as TeamPageScraper,
    stub as RegistryScraper,
    stub as GithubEnrichment,
    stub as JobSignalService,
    stub as SerpDiscoveryService,
    stub as TheirStackService,
    stub as EmailPatternService,
    stub as IdentityResolver,
    stub as LeadScorer,
  );
}

describe("LeadsService.triggerDiscovery (legacy flag gate)", () => {
  let prisma: ReturnType<typeof mockPrisma>;
  let service: LeadsService;
  const originalFlag = process.env.LEGACY_TRIGGER_DISCOVERY_ENABLED;

  beforeEach(() => {
    prisma = mockPrisma();
    service = buildService(prisma);
  });

  afterEach(() => {
    if (originalFlag === undefined) {
      delete process.env.LEGACY_TRIGGER_DISCOVERY_ENABLED;
    } else {
      process.env.LEGACY_TRIGGER_DISCOVERY_ENABLED = originalFlag;
    }
  });

  it("returns early without touching prisma when flag is OFF (default)", async () => {
    delete process.env.LEGACY_TRIGGER_DISCOVERY_ENABLED;

    const result = await service.triggerDiscovery("org_1", "icp_1");

    expect(result).toMatchObject({ skipped: true, icpProfileId: "icp_1" });
    expect(prisma.scrapeJob.findFirst).not.toHaveBeenCalled();
    expect(prisma.icpProfile.findFirstOrThrow).not.toHaveBeenCalled();
    expect(prisma.icpProfile.update).not.toHaveBeenCalled();
  });

  it("returns early when flag is set to a value other than 'true'", async () => {
    process.env.LEGACY_TRIGGER_DISCOVERY_ENABLED = "false";

    const result = await service.triggerDiscovery("org_1", "icp_1");

    expect(result).toMatchObject({ skipped: true });
    expect(prisma.scrapeJob.findFirst).not.toHaveBeenCalled();
  });

  it("executes the legacy path when flag is ON", async () => {
    process.env.LEGACY_TRIGGER_DISCOVERY_ENABLED = "true";
    // Simulate an in-flight job so we short-circuit before launching the
    // background pipeline. The ConflictException proves the gate let us
    // through to the real single-flight check.
    prisma.scrapeJob.findFirst.mockResolvedValue({ id: "job_existing" });

    await expect(service.triggerDiscovery("org_1", "icp_1")).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(prisma.scrapeJob.findFirst).toHaveBeenCalledWith({
      where: { orgId: "org_1", status: { in: ["QUEUED", "RUNNING"] } },
    });
  });
});
