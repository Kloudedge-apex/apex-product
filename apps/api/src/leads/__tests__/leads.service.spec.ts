import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ConflictException } from "@nestjs/common";
import { LeadsService } from "../leads.service";
import { PrismaService } from "../../prisma/prisma.service";
import { GraphService } from "../../graph/graph.service";
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

function mockGraphService(): GraphService & {
  runPipelineGraph: ReturnType<typeof vi.fn>;
} {
  return {
    runPipelineGraph: vi.fn().mockResolvedValue({
      runId: "graph_run_xyz",
      threadId: "graph_run_xyz",
    }),
  } as unknown as GraphService & {
    runPipelineGraph: ReturnType<typeof vi.fn>;
  };
}

function buildService(
  prisma: ReturnType<typeof mockPrisma>,
  graphService: ReturnType<typeof mockGraphService> = mockGraphService(),
): LeadsService {
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
    graphService,
  );
}

describe("LeadsService.triggerDiscovery (legacy flag gate)", () => {
  let prisma: ReturnType<typeof mockPrisma>;
  let graph: ReturnType<typeof mockGraphService>;
  let service: LeadsService;
  const originalFlag = process.env.LEGACY_TRIGGER_DISCOVERY_ENABLED;

  beforeEach(() => {
    prisma = mockPrisma();
    graph = mockGraphService();
    service = buildService(prisma, graph);
  });

  afterEach(() => {
    if (originalFlag === undefined) {
      delete process.env.LEGACY_TRIGGER_DISCOVERY_ENABLED;
    } else {
      process.env.LEGACY_TRIGGER_DISCOVERY_ENABLED = originalFlag;
    }
  });

  it("routes through the graph supervisor when flag is OFF (default)", async () => {
    delete process.env.LEGACY_TRIGGER_DISCOVERY_ENABLED;

    const result = await service.triggerDiscovery("org_1", "icp_1");

    expect(graph.runPipelineGraph).toHaveBeenCalledWith("org_1", ["icp_1"]);
    expect(result).toMatchObject({
      icpProfileId: "icp_1",
      runId: "graph_run_xyz",
      threadId: "graph_run_xyz",
    });
    // Legacy path never runs: no ScrapeJob single-flight check, no icpProfile updates.
    expect(prisma.scrapeJob.findFirst).not.toHaveBeenCalled();
    expect(prisma.icpProfile.update).not.toHaveBeenCalled();
  });

  it("routes through the graph supervisor when flag is set to a value other than 'true'", async () => {
    process.env.LEGACY_TRIGGER_DISCOVERY_ENABLED = "false";

    const result = await service.triggerDiscovery("org_1", "icp_1");

    expect(graph.runPipelineGraph).toHaveBeenCalledWith("org_1", ["icp_1"]);
    expect(result).toMatchObject({ runId: "graph_run_xyz" });
    expect(prisma.scrapeJob.findFirst).not.toHaveBeenCalled();
  });

  it("executes the legacy direct-executor path when flag is ON", async () => {
    process.env.LEGACY_TRIGGER_DISCOVERY_ENABLED = "true";
    // Simulate an in-flight job so we short-circuit before launching the
    // background pipeline. The ConflictException proves the gate let us
    // through to the real single-flight check — and proves the graph
    // supervisor was NOT called for this path.
    prisma.scrapeJob.findFirst.mockResolvedValue({ id: "job_existing" });

    await expect(service.triggerDiscovery("org_1", "icp_1")).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(prisma.scrapeJob.findFirst).toHaveBeenCalledWith({
      where: { orgId: "org_1", status: { in: ["QUEUED", "RUNNING"] } },
    });
    expect(graph.runPipelineGraph).not.toHaveBeenCalled();
  });
});
