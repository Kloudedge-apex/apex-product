import { describe, it, expect, vi } from "vitest";
import { NotFoundException } from "@nestjs/common";
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
  const prisma = {
    $transaction: vi.fn(),
    $queryRaw: vi.fn().mockResolvedValue([]),
    scrapeJob: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    company: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      upsert: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    person: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    emailCandidate: {
      upsert: vi.fn(),
    },
    icpProfile: {
      findFirst: vi.fn(),
      findFirstOrThrow: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
  } as unknown as PrismaService & {
    $transaction: ReturnType<typeof vi.fn>;
    $queryRaw: ReturnType<typeof vi.fn>;
    scrapeJob: {
      findFirst: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
    };
    company: {
      findMany: ReturnType<typeof vi.fn>;
      findFirst: ReturnType<typeof vi.fn>;
      upsert: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
    };
    person: {
      findMany: ReturnType<typeof vi.fn>;
    };
    emailCandidate: {
      upsert: ReturnType<typeof vi.fn>;
    };
    icpProfile: {
      findFirst: ReturnType<typeof vi.fn>;
      findFirstOrThrow: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
  };
  prisma.$transaction.mockImplementation(
    async (callback: (tx: typeof prisma) => Promise<unknown>) => callback(prisma),
  );
  return prisma;
}

function buildService(
  prisma: ReturnType<typeof mockPrisma>,
  overrides: {
    serpDiscovery?: SerpDiscoveryService;
    atsScraper?: AtsScraper;
    registryScraper?: RegistryScraper;
    theirStack?: TheirStackService;
    emailPatternService?: EmailPatternService;
  } = {},
): LeadsService {
  // These collaborators are not exercised by the focused unit cases.
  const stub = {} as never;
  return new LeadsService(
    prisma,
    overrides.atsScraper ?? (stub as AtsScraper),
    stub as TeamPageScraper,
    overrides.registryScraper ?? (stub as RegistryScraper),
    stub as GithubEnrichment,
    stub as JobSignalService,
    overrides.serpDiscovery ?? (stub as SerpDiscoveryService),
    overrides.theirStack ?? (stub as TheirStackService),
    overrides.emailPatternService ?? (stub as EmailPatternService),
    stub as IdentityResolver,
    stub as LeadScorer,
  );
}

type ScopedLeadsInternals = {
  discoverCompanies(
    orgId: string,
    icp: {
      targetTitles: string[];
      targetIndustries: string[];
      targetGeos: string[];
      techStackSignals: string[];
      exclusionDomains?: string[];
    },
    jobId?: string,
    primarySourcesOnly?: boolean,
  ): Promise<string[]>;
  discoverPeople(
    orgId: string,
    icp: {
      targetTitles: string[];
      targetIndustries: string[];
      targetGeos: string[];
    } | undefined,
    scopedCompanyIds?: string[],
  ): Promise<{ count: number; personIds: string[] }>;
  enrichContacts(
    orgId: string,
    scopedPersonIds?: string[],
  ): Promise<{ count: number; personIds: string[] }>;
  scoreLeads(
    orgId: string,
    icp: {
      targetTitles: string[];
      targetIndustries: string[];
      targetGeos: string[];
    },
    scopedPersonIds?: string[],
  ): Promise<{ count: number; personIds: string[] }>;
};

function scopedInternals(service: LeadsService): ScopedLeadsInternals {
  return service as unknown as ScopedLeadsInternals;
}

describe("LeadsService.upsertCurrentIcpProfile", () => {
  it("updates the newest org profile instead of creating targeting history", async () => {
    const prisma = mockPrisma();
    const service = buildService(prisma);
    prisma.icpProfile.findFirst.mockResolvedValue({ id: "icp_current" });
    prisma.icpProfile.update.mockResolvedValue({ id: "icp_current" });

    await service.upsertCurrentIcpProfile("org_1", {
      name: "Default ICP",
      targetTitles: ["VP Sales"],
      exclusionDomains: ["competitor.com"],
    });

    expect(prisma.$queryRaw).toHaveBeenCalledOnce();
    expect(prisma.icpProfile.findFirst).toHaveBeenCalledWith({
      where: { orgId: "org_1" },
      orderBy: { updatedAt: "desc" },
      select: { id: true },
    });
    expect(prisma.icpProfile.update).toHaveBeenCalledWith({
      where: { id: "icp_current" },
      data: expect.objectContaining({
        targetTitles: ["VP Sales"],
        exclusionDomains: ["competitor.com"],
      }),
    });
    expect(prisma.icpProfile.update).toHaveBeenCalledWith({
      where: { id: "icp_current" },
      data: expect.not.objectContaining({ techStackSignals: [] }),
    });
    expect(prisma.icpProfile.create).not.toHaveBeenCalled();
  });

  it("preserves omitted targeting fields and clears bounds only when null is explicit", async () => {
    const prisma = mockPrisma();
    const service = buildService(prisma);
    prisma.icpProfile.findFirst.mockResolvedValue({ id: "icp_current" });
    prisma.icpProfile.update.mockResolvedValue({ id: "icp_current" });

    await service.upsertCurrentIcpProfile("org_1", {
      name: "Default ICP",
      minEmployees: null,
      maxEmployees: null,
    });

    expect(prisma.icpProfile.update).toHaveBeenCalledWith({
      where: { id: "icp_current" },
      data: { name: "Default ICP", minEmployees: null, maxEmployees: null },
    });
  });

  it("creates exactly one current profile for a clean tenant", async () => {
    const prisma = mockPrisma();
    const service = buildService(prisma);
    prisma.icpProfile.findFirst.mockResolvedValue(null);
    prisma.icpProfile.create.mockResolvedValue({ id: "icp_new" });

    await service.upsertCurrentIcpProfile("org_1", { name: "Default ICP" });

    expect(prisma.icpProfile.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ orgId: "org_1", name: "Default ICP" }),
    });
    expect(prisma.icpProfile.update).not.toHaveBeenCalled();
  });
});

describe("LeadsService ICP domain exclusions", () => {
  it("never persists or probes excluded source domains", async () => {
    const prisma = mockPrisma();
    prisma.company.upsert.mockImplementation(
      async ({ create }: { create: { domain: string } }) => ({
        id: `company_${create.domain}`,
      }),
    );
    const serpDiscovery = {
      discoverCompanies: vi.fn().mockResolvedValue([
        { domain: "competitor.com", name: "Competitor" },
        { domain: "allowed.example", name: "Allowed" },
      ]),
    } as unknown as SerpDiscoveryService;
    const atsScraper = {
      discoverCompanies: vi.fn().mockResolvedValue([]),
      discoverAtsSlugs: vi.fn().mockResolvedValue([]),
    } as unknown as AtsScraper;
    const theirStack = {
      discoverHiringCompanies: vi.fn().mockResolvedValue([]),
    } as unknown as TheirStackService;
    const registryScraper = {
      discoverCompanies: vi.fn().mockResolvedValue([]),
    } as unknown as RegistryScraper;
    const service = buildService(prisma, {
      serpDiscovery,
      atsScraper,
      theirStack,
      registryScraper,
    });

    const companyIds = await scopedInternals(service).discoverCompanies(
      "org_1",
      {
        targetTitles: [],
        targetIndustries: [],
        targetGeos: [],
        techStackSignals: [],
        exclusionDomains: ["competitor.com"],
      },
    );

    expect(prisma.company.upsert).toHaveBeenCalledOnce();
    expect(prisma.company.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ domain: "allowed.example" }),
      }),
    );
    expect(atsScraper.discoverAtsSlugs).toHaveBeenCalledWith([
      "allowed.example",
    ]);
    expect(companyIds).toEqual(["company_allowed.example"]);
  });
});

describe("LeadsService autonomous sources", () => {
  it("uses TheirStack and persists dated jobs without invoking legacy sources", async () => {
    const prisma = mockPrisma();
    prisma.company.upsert.mockResolvedValue({ id: "company_acme" });
    const serpDiscovery = {
      discoverCompanies: vi.fn().mockResolvedValue([]),
    } as unknown as SerpDiscoveryService;
    const theirStack = {
      discoverHiringCompanies: vi.fn().mockResolvedValue([
        {
          domain: "acme.com",
          name: "Acme",
          jobTitles: ["VP Sales"],
          jobs: [
            {
              title: "VP Sales",
              url: "https://acme.com/jobs/vp-sales",
              postedAt: "2026-09-01",
            },
          ],
          intentScore: 5,
          intentSignals: ["theirstack-active-hiring"],
          source: "theirstack",
        },
      ]),
    } as unknown as TheirStackService;
    const atsScraper = {
      discoverCompanies: vi.fn(),
      discoverAtsSlugs: vi.fn(),
    } as unknown as AtsScraper;
    const registryScraper = {
      discoverCompanies: vi.fn(),
    } as unknown as RegistryScraper;
    const service = buildService(prisma, {
      serpDiscovery,
      theirStack,
      atsScraper,
      registryScraper,
    });

    await scopedInternals(service).discoverCompanies(
      "org_1",
      {
        targetTitles: ["VP Sales"],
        targetIndustries: ["software"],
        targetGeos: ["US"],
        techStackSignals: [],
      },
      undefined,
      true,
    );

    expect(theirStack.discoverHiringCompanies).toHaveBeenCalledOnce();
    expect(atsScraper.discoverCompanies).not.toHaveBeenCalled();
    expect(registryScraper.discoverCompanies).not.toHaveBeenCalled();
    expect(prisma.company.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { orgId_domain: { orgId: "org_1", domain: "acme.com" } },
        create: expect.objectContaining({
          orgId: "org_1",
          raw: {
            jobs: [
              {
                title: "VP Sales",
                url: "https://acme.com/jobs/vp-sales",
                postedAt: "2026-09-01",
              },
            ],
          },
        }),
      }),
    );
  });
});

describe("LeadsService ScrapeJob tenant boundary", () => {
  it("rejects a foreign ICP before creating an enrichment job", async () => {
    const prisma = mockPrisma();
    const service = buildService(prisma);
    prisma.icpProfile.findFirst.mockResolvedValue(null);

    await expect(
      service.runEnrichmentStage("org_1", "icp_foreign", []),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(prisma.icpProfile.findFirst).toHaveBeenCalledWith({
      where: { id: "icp_foreign", orgId: "org_1" },
      select: { id: true },
    });
    expect(prisma.scrapeJob.create).not.toHaveBeenCalled();
  });
});

describe("LeadsService per-run lead scopes", () => {
  const icp = {
    targetTitles: ["VP Sales"],
    targetIndustries: ["Software"],
    targetGeos: ["US"],
  };

  it("keeps an explicit empty company scope empty during people discovery", async () => {
    const prisma = mockPrisma();
    const serpDiscovery = {
      discoverPeopleViaSERP: vi.fn().mockResolvedValue([]),
    } as unknown as SerpDiscoveryService;
    const service = buildService(prisma, { serpDiscovery });

    const result = await scopedInternals(service).discoverPeople("org_1", icp, []);

    expect(prisma.company.findMany).not.toHaveBeenCalled();
    expect(serpDiscovery.discoverPeopleViaSERP).not.toHaveBeenCalled();
    expect(result).toEqual({ count: 0, personIds: [] });
  });

  it("constrains every SERP company-name match to the supplied company ids", async () => {
    const prisma = mockPrisma();
    const serpDiscovery = {
      discoverPeopleViaSERP: vi.fn().mockResolvedValue([
        {
          firstName: "Ada",
          lastName: "Lovelace",
          title: "VP Sales",
          companyName: "Scoped Company",
        },
      ]),
    } as unknown as SerpDiscoveryService;
    const service = buildService(prisma, { serpDiscovery });

    await scopedInternals(service).discoverPeople("org_1", icp, ["company_in_run"]);

    expect(prisma.company.findFirst).toHaveBeenCalledTimes(3);
    for (const [query] of prisma.company.findFirst.mock.calls) {
      expect(query.where).toMatchObject({
        orgId: "org_1",
        id: { in: ["company_in_run"] },
      });
    }
  });

  it("keeps an explicit empty person scope empty during enrichment", async () => {
    const prisma = mockPrisma();
    const service = buildService(prisma);

    const result = await scopedInternals(service).enrichContacts("org_1", []);

    expect(prisma.person.findMany).toHaveBeenCalledWith({
      where: { company: { orgId: "org_1" }, id: { in: [] } },
      include: { company: { select: { domain: true } }, emails: true },
    });
    expect(result).toEqual({ count: 0, personIds: [] });
  });

  it("persists valid and invalid SMTP verification outcomes on create and update", async () => {
    const prisma = mockPrisma();
    prisma.person.findMany.mockResolvedValue([
      {
        id: "person_1",
        firstName: "Ada",
        lastName: "Lovelace",
        company: { domain: "scoped.example" },
        emails: [],
      },
    ]);
    const emailPatternService = {
      generateCandidates: vi.fn().mockResolvedValue([
        {
          email: "ada.lovelace@scoped.example",
          pattern: "first.last",
          source: "PATTERN_GUESS",
          confidence: 0.6,
        },
        {
          email: "alovelace@scoped.example",
          pattern: "flast",
          source: "PATTERN_GUESS",
          confidence: 0.5,
        },
      ]),
      verifyBatch: vi.fn().mockResolvedValue(
        new Map([
          [
            "ada.lovelace@scoped.example",
            { valid: true, catchAll: false, result: "VALID" },
          ],
          [
            "alovelace@scoped.example",
            { valid: false, catchAll: false, result: "INVALID" },
          ],
        ]),
      ),
      learnPattern: vi.fn().mockResolvedValue(undefined),
    } as unknown as EmailPatternService;
    const service = buildService(prisma, {
      emailPatternService,
    });

    await scopedInternals(service).enrichContacts("org_1", ["person_1"]);

    expect(prisma.emailCandidate.upsert).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        create: expect.objectContaining({
          email: "ada.lovelace@scoped.example",
          verified: true,
          verificationResult: "VALID",
          verifiedAt: expect.any(Date),
        }),
        update: expect.objectContaining({
          verified: true,
          verificationResult: "VALID",
          verifiedAt: expect.any(Date),
        }),
      }),
    );
    expect(prisma.emailCandidate.upsert).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        create: expect.objectContaining({
          email: "alovelace@scoped.example",
          verified: false,
          verificationResult: "INVALID",
          verifiedAt: null,
        }),
        update: expect.objectContaining({
          verified: false,
          verificationResult: "INVALID",
          verifiedAt: null,
        }),
      }),
    );
  });

  it("reverifies an existing ineligible UNKNOWN candidate instead of skipping the person", async () => {
    const prisma = mockPrisma();
    prisma.person.findMany.mockResolvedValue([
      {
        id: "person_existing",
        firstName: "Ada",
        lastName: "Lovelace",
        company: { domain: "scoped.example" },
        emails: [
          {
            id: "email_existing",
            email: "ada.lovelace@scoped.example",
            pattern: "first.last",
            source: "PATTERN_GUESS",
            verified: false,
            verificationResult: "UNKNOWN",
            confidence: 0.6,
            verifiedAt: null,
            createdAt: new Date("2026-05-01T00:00:00.000Z"),
          },
        ],
      },
    ]);
    const emailPatternService = {
      generateCandidates: vi.fn().mockResolvedValue([
        {
          email: "ada.lovelace@scoped.example",
          pattern: "first.last",
          source: "PATTERN_GUESS",
          confidence: 0.6,
        },
      ]),
      verifyBatch: vi.fn().mockResolvedValue(
        new Map([
          [
            "ada.lovelace@scoped.example",
            { valid: true, catchAll: false, result: "VALID" },
          ],
        ]),
      ),
      learnPattern: vi.fn().mockResolvedValue(undefined),
    } as unknown as EmailPatternService;
    const service = buildService(prisma, {
      emailPatternService,
    });

    const result = await scopedInternals(service).enrichContacts(
      "org_1",
      ["person_existing"],
    );

    expect(emailPatternService.verifyBatch).toHaveBeenCalledWith([
      "ada.lovelace@scoped.example",
    ]);
    expect(prisma.emailCandidate.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          personId_email: {
            personId: "person_existing",
            email: "ada.lovelace@scoped.example",
          },
        },
        update: expect.objectContaining({
          verified: true,
          verificationResult: "VALID",
          verifiedAt: expect.any(Date),
        }),
      }),
    );
    expect(result).toEqual({ count: 1, personIds: ["person_existing"] });
  });

  it("does not let two existing UNKNOWN rows starve a current generated candidate", async () => {
    const prisma = mockPrisma();
    prisma.person.findMany.mockResolvedValue([
      {
        id: "person_starvation",
        firstName: "Ada",
        lastName: "Lovelace",
        company: { domain: "scoped.example" },
        emails: [
          {
            id: "email_existing_one",
            email: "legacy.one@scoped.example",
            pattern: "first.last",
            source: "PATTERN_GUESS",
            verified: false,
            verificationResult: "UNKNOWN",
            confidence: 0.95,
            verifiedAt: null,
            createdAt: new Date("2026-05-01T00:00:00.000Z"),
          },
          {
            id: "email_existing_two",
            email: "legacy.two@scoped.example",
            pattern: "flast",
            source: "PATTERN_GUESS",
            verified: false,
            verificationResult: "UNKNOWN",
            confidence: 0.9,
            verifiedAt: null,
            createdAt: new Date("2026-05-02T00:00:00.000Z"),
          },
        ],
      },
    ]);
    const emailPatternService = {
      generateCandidates: vi.fn().mockResolvedValue([
        {
          email: "ada@scoped.example",
          pattern: "hunter",
          source: "HUNTER",
          confidence: 0.4,
        },
      ]),
      verifyBatch: vi.fn().mockResolvedValue(
        new Map([
          [
            "legacy.one@scoped.example",
            { valid: false, catchAll: false, result: "UNKNOWN" },
          ],
          [
            "ada@scoped.example",
            { valid: true, catchAll: false, result: "VALID" },
          ],
        ]),
      ),
      learnPattern: vi.fn().mockResolvedValue(undefined),
    } as unknown as EmailPatternService;
    const service = buildService(prisma, {
      emailPatternService,
    });

    await scopedInternals(service).enrichContacts("org_1", [
      "person_starvation",
    ]);

    expect(emailPatternService.verifyBatch).toHaveBeenCalledWith([
      "legacy.one@scoped.example",
      "ada@scoped.example",
      "legacy.two@scoped.example",
    ]);
    expect(prisma.emailCandidate.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          personId_email: {
            personId: "person_starvation",
            email: "ada@scoped.example",
          },
        },
        create: expect.objectContaining({
          verified: true,
          verificationResult: "VALID",
          verifiedAt: expect.any(Date),
        }),
        update: expect.objectContaining({
          verified: true,
          verificationResult: "VALID",
          verifiedAt: expect.any(Date),
        }),
      }),
    );
  });

  it("checks an all-existing UNKNOWN backlog within the ten-address batch", async () => {
    const prisma = mockPrisma();
    const existingCandidate = (email: string, confidence: number) => ({
      id: `email_${email}`,
      email,
      pattern: "first.last",
      source: "PATTERN_GUESS" as const,
      verified: false,
      verificationResult: "UNKNOWN" as const,
      confidence,
      verifiedAt: null,
      createdAt: new Date("2026-05-01T00:00:00.000Z"),
    });
    prisma.person.findMany
      .mockResolvedValueOnce([
        {
          id: "person_backlog",
          firstName: "Ada",
          lastName: "Lovelace",
          company: { domain: "scoped.example" },
          emails: [
            existingCandidate("a@scoped.example", 0.95),
            existingCandidate("b@scoped.example", 0.9),
            existingCandidate("c@scoped.example", 0.4),
          ],
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "person_backlog",
          firstName: "Ada",
          lastName: "Lovelace",
          company: { domain: "scoped.example" },
          emails: [
            existingCandidate("a@scoped.example", 0),
            existingCandidate("b@scoped.example", 0),
            existingCandidate("c@scoped.example", 0.4),
          ],
        },
      ]);
    const generatedCandidates = [
      {
        email: "a@scoped.example",
        pattern: "first.last",
        source: "PATTERN_GUESS",
        confidence: 0.95,
      },
      {
        email: "b@scoped.example",
        pattern: "first",
        source: "PATTERN_GUESS",
        confidence: 0.9,
      },
      {
        email: "c@scoped.example",
        pattern: "flast",
        source: "PATTERN_GUESS",
        confidence: 0.4,
      },
    ];
    const unknown = { valid: false, catchAll: false, result: "UNKNOWN" };
    const emailPatternService = {
      generateCandidates: vi.fn().mockResolvedValue(generatedCandidates),
      verifyBatch: vi
        .fn()
        .mockResolvedValueOnce(
          new Map([
            ["a@scoped.example", unknown],
            ["b@scoped.example", unknown],
          ]),
        )
        .mockResolvedValueOnce(
          new Map([
            [
              "c@scoped.example",
              { valid: true, catchAll: false, result: "VALID" },
            ],
            ["a@scoped.example", unknown],
          ]),
        ),
      learnPattern: vi.fn().mockResolvedValue(undefined),
    } as unknown as EmailPatternService;
    const service = buildService(prisma, {
      emailPatternService,
    });

    await scopedInternals(service).enrichContacts("org_1", ["person_backlog"]);
    await scopedInternals(service).enrichContacts("org_1", ["person_backlog"]);

    expect(emailPatternService.verifyBatch).toHaveBeenNthCalledWith(1, [
      "a@scoped.example",
      "b@scoped.example",
      "c@scoped.example",
    ]);
    expect(emailPatternService.verifyBatch).toHaveBeenNthCalledWith(2, [
      "c@scoped.example",
      "a@scoped.example",
      "b@scoped.example",
    ]);
    expect(prisma.emailCandidate.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          personId_email: {
            personId: "person_backlog",
            email: "c@scoped.example",
          },
        },
        update: expect.objectContaining({
          verified: true,
          verificationResult: "VALID",
        }),
      }),
    );
  });

  it("keeps an explicit empty person scope empty during scoring", async () => {
    const prisma = mockPrisma();
    const service = buildService(prisma);

    const result = await scopedInternals(service).scoreLeads("org_1", icp, []);

    expect(prisma.person.findMany).toHaveBeenCalledWith({
      where: { company: { orgId: "org_1" }, id: { in: [] } },
      include: { company: true, emails: true },
    });
    expect(result).toEqual({ count: 0, personIds: [] });
  });
});
