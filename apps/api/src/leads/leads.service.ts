import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AtsScraper } from "./sources/ats-scraper.service";
import { TeamPageScraper } from "./sources/team-page-scraper.service";
import { RegistryScraper } from "./sources/registry-scraper.service";
import { GithubEnrichment } from "./sources/github-enrichment.service";
import { JobSignalService } from "./sources/job-signal.service";
import { EmailPatternService } from "./enrichment/email-pattern.service";
import { IdentityResolver } from "./enrichment/identity-resolver.service";
import { LeadScorer } from "./scoring/lead-scorer.service";
import type { Seniority, Department, ScrapeStage } from "@prisma/client";

interface CompanyFilters {
  page: number;
  limit: number;
  industry?: string;
  country?: string;
}

interface PeopleFilters {
  page: number;
  limit: number;
  seniority?: Seniority;
  department?: Department;
  minScore?: number;
}

@Injectable()
export class LeadsService {
  private readonly logger = new Logger(LeadsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly atsScraper: AtsScraper,
    private readonly teamPageScraper: TeamPageScraper,
    private readonly registryScraper: RegistryScraper,
    private readonly githubEnrichment: GithubEnrichment,
    private readonly jobSignalService: JobSignalService,
    private readonly emailPatternService: EmailPatternService,
    private readonly identityResolver: IdentityResolver,
    private readonly leadScorer: LeadScorer,
  ) {}

  // ─── ICP ─────────────────────────────────────────────

  async createIcpProfile(
    orgId: string,
    data: {
      name: string;
      targetTitles?: string[];
      targetIndustries?: string[];
      targetGeos?: string[];
      minEmployees?: number;
      maxEmployees?: number;
      techStackSignals?: string[];
    },
  ) {
    return this.prisma.icpProfile.create({
      data: {
        orgId,
        name: data.name,
        targetTitles: data.targetTitles ?? [],
        targetIndustries: data.targetIndustries ?? [],
        targetGeos: data.targetGeos ?? [],
        minEmployees: data.minEmployees ?? null,
        maxEmployees: data.maxEmployees ?? null,
        techStackSignals: data.techStackSignals ?? [],
      },
    });
  }

  async listIcpProfiles(orgId: string) {
    return this.prisma.icpProfile.findMany({
      where: { orgId },
      orderBy: { createdAt: "desc" },
    });
  }

  // ─── Discovery Pipeline ──────────────────────────────

  async triggerDiscovery(orgId: string, icpProfileId: string) {
    const icp = await this.prisma.icpProfile.findFirstOrThrow({
      where: { id: icpProfileId, orgId },
    });

    this.logger.log(`Starting discovery pipeline for ICP "${icp.name}" (org: ${orgId})`);

    // Fire and forget: run pipeline stages sequentially in background
    void this.runPipeline(orgId, icpProfileId, icp).catch((err: unknown) => {
      this.logger.error(`Pipeline failed for ICP ${icpProfileId}`, err instanceof Error ? err.stack : String(err));
    });

    return { message: "Discovery pipeline started", icpProfileId };
  }

  private async runPipeline(
    orgId: string,
    icpProfileId: string,
    icp: { targetTitles: string[]; targetIndustries: string[]; targetGeos: string[]; minEmployees: number | null; maxEmployees: number | null; techStackSignals: string[] },
  ) {
    // Stage 1: Company Discovery
    const companyJobId = await this.createJob(orgId, icpProfileId, "COMPANY_DISCOVERY");
    try {
      await this.markJobRunning(companyJobId);
      const companies = await this.discoverCompanies(orgId, icp);
      await this.markJobCompleted(companyJobId, companies.length);
    } catch (err) {
      await this.markJobFailed(companyJobId, err);
    }

    // Stage 2: People Discovery
    const peopleJobId = await this.createJob(orgId, icpProfileId, "PEOPLE_DISCOVERY");
    try {
      await this.markJobRunning(peopleJobId);
      const count = await this.discoverPeople(orgId);
      await this.markJobCompleted(peopleJobId, count);
    } catch (err) {
      await this.markJobFailed(peopleJobId, err);
    }

    // Stage 3: Identity Resolution
    const identityJobId = await this.createJob(orgId, icpProfileId, "IDENTITY_RESOLUTION");
    try {
      await this.markJobRunning(identityJobId);
      const merged = await this.identityResolver.resolveAll(orgId);
      await this.markJobCompleted(identityJobId, merged);
    } catch (err) {
      await this.markJobFailed(identityJobId, err);
    }

    // Stage 4: Contact Enrichment
    const contactJobId = await this.createJob(orgId, icpProfileId, "CONTACT_ENRICHMENT");
    try {
      await this.markJobRunning(contactJobId);
      const enriched = await this.enrichContacts(orgId);
      await this.markJobCompleted(contactJobId, enriched);
    } catch (err) {
      await this.markJobFailed(contactJobId, err);
    }

    // Stage 5: Scoring
    const scoringJobId = await this.createJob(orgId, icpProfileId, "SCORING");
    try {
      await this.markJobRunning(scoringJobId);
      const scored = await this.scoreLeads(orgId, icp);
      await this.markJobCompleted(scoringJobId, scored);
    } catch (err) {
      await this.markJobFailed(scoringJobId, err);
    }

    this.logger.log(`Pipeline complete for ICP ${icpProfileId}`);
  }

  private async discoverCompanies(
    orgId: string,
    icp: { targetIndustries: string[]; targetGeos: string[]; techStackSignals: string[] },
  ): Promise<string[]> {
    const companyIds: string[] = [];

    // ATS scraping: look for companies with public job boards
    const atsCompanies = await this.atsScraper.discoverCompanies(icp);
    for (const co of atsCompanies) {
      try {
        const company = await this.prisma.company.upsert({
          where: { domain: co.domain },
          create: { ...co, orgId },
          update: { ...co },
        });
        companyIds.push(company.id);
      } catch (err) {
        this.logger.warn(`Failed to upsert company ${co.domain}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Registry scraping
    const registryCompanies = await this.registryScraper.discoverCompanies(icp);
    for (const co of registryCompanies) {
      try {
        const company = await this.prisma.company.upsert({
          where: { domain: co.domain },
          create: { ...co, orgId },
          update: { ...co },
        });
        companyIds.push(company.id);
      } catch (err) {
        this.logger.warn(`Failed to upsert registry company ${co.domain}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return companyIds;
  }

  private async discoverPeople(orgId: string): Promise<number> {
    const companies = await this.prisma.company.findMany({
      where: { orgId },
      select: { id: true, domain: true, atsProvider: true, atsSlug: true, teamPageUrl: true },
    });

    let count = 0;
    for (const co of companies) {
      try {
        // Team page scraping
        const teamPeople = await this.teamPageScraper.scrapeTeamPage(co.domain, co.teamPageUrl);
        for (const p of teamPeople) {
          await this.upsertPerson(co.id, p);
          count++;
        }
      } catch (err) {
        this.logger.warn(`Team page scrape failed for ${co.domain}: ${err instanceof Error ? err.message : String(err)}`);
      }

      try {
        // ATS people extraction
        if (co.atsProvider && co.atsSlug) {
          const atsPeople = await this.atsScraper.extractPeopleFromJobs(co.atsProvider, co.atsSlug);
          for (const p of atsPeople) {
            await this.upsertPerson(co.id, p);
            count++;
          }
        }
      } catch (err) {
        this.logger.warn(`ATS people extract failed for ${co.domain}: ${err instanceof Error ? err.message : String(err)}`);
      }

      try {
        // GitHub enrichment
        const ghPeople = await this.githubEnrichment.discoverPeople(co.domain);
        for (const p of ghPeople) {
          await this.upsertPerson(co.id, p);
          count++;
        }
      } catch (err) {
        this.logger.warn(`GitHub enrichment failed for ${co.domain}: ${err instanceof Error ? err.message : String(err)}`);
      }

      // Rate limit between companies
      await delay(500);
    }

    return count;
  }

  private async upsertPerson(
    companyId: string,
    p: { firstName: string; lastName: string; title?: string; seniority?: Seniority; department?: Department; linkedinSlug?: string; linkedinUrl?: string; githubHandle?: string },
  ) {
    // Check for existing by linkedinSlug or name match
    const existing = p.linkedinSlug
      ? await this.prisma.person.findFirst({
          where: { companyId, linkedinSlug: p.linkedinSlug },
        })
      : await this.prisma.person.findFirst({
          where: {
            companyId,
            firstName: { equals: p.firstName, mode: "insensitive" },
            lastName: { equals: p.lastName, mode: "insensitive" },
          },
        });

    if (existing) {
      await this.prisma.person.update({
        where: { id: existing.id },
        data: {
          title: p.title ?? existing.title,
          seniority: p.seniority ?? existing.seniority,
          linkedinSlug: p.linkedinSlug ?? existing.linkedinSlug,
          linkedinUrl: p.linkedinUrl ?? existing.linkedinUrl,
          githubHandle: p.githubHandle ?? existing.githubHandle,
        },
      });
      return existing.id;
    }

    const created = await this.prisma.person.create({
      data: {
        companyId,
        firstName: p.firstName,
        lastName: p.lastName,
        title: p.title,
        seniority: p.seniority ?? "UNKNOWN",
        department: p.department ?? "UNKNOWN",
        linkedinSlug: p.linkedinSlug,
        linkedinUrl: p.linkedinUrl,
        githubHandle: p.githubHandle,
      },
    });
    return created.id;
  }

  private async enrichContacts(orgId: string): Promise<number> {
    const people = await this.prisma.person.findMany({
      where: { company: { orgId } },
      include: { company: { select: { domain: true } }, emails: true },
    });

    let count = 0;
    for (const person of people) {
      if (person.emails.length > 0) continue; // already has emails

      try {
        const candidates = await this.emailPatternService.generateCandidates(
          person.firstName,
          person.lastName,
          person.company.domain,
        );
        for (const c of candidates) {
          await this.prisma.emailCandidate.upsert({
            where: {
              personId_email: { personId: person.id, email: c.email },
            },
            create: {
              personId: person.id,
              email: c.email,
              pattern: c.pattern,
              source: c.source,
              confidence: c.confidence,
            },
            update: {},
          });
          count++;
        }
      } catch (err) {
        this.logger.warn(`Email enrichment failed for person ${person.id}: ${err instanceof Error ? err.message : String(err)}`);
      }

      await delay(200);
    }

    return count;
  }

  private async scoreLeads(
    orgId: string,
    icp: { targetTitles: string[]; targetGeos: string[]; targetIndustries: string[] },
  ): Promise<number> {
    const people = await this.prisma.person.findMany({
      where: { company: { orgId } },
      include: {
        company: true,
        emails: true,
      },
    });

    let count = 0;
    for (const person of people) {
      const { score, breakdown } = this.leadScorer.score(person, icp);
      await this.prisma.leadScore.upsert({
        where: { orgId_personId: { orgId, personId: person.id } },
        create: {
          orgId,
          personId: person.id,
          score,
          breakdown,
          qualifiedAt: score >= 100 ? new Date() : null,
        },
        update: {
          score,
          breakdown,
          qualifiedAt: score >= 100 ? new Date() : null,
        },
      });
      count++;
    }

    return count;
  }

  // ─── Job Helpers ─────────────────────────────────────

  private async createJob(orgId: string, icpProfileId: string, stage: ScrapeStage): Promise<string> {
    const job = await this.prisma.scrapeJob.create({
      data: { orgId, icpProfileId, stage, status: "QUEUED" },
    });
    return job.id;
  }

  private async markJobRunning(jobId: string) {
    await this.prisma.scrapeJob.update({
      where: { id: jobId },
      data: { status: "RUNNING", startedAt: new Date() },
    });
  }

  private async markJobCompleted(jobId: string, processedItems: number) {
    await this.prisma.scrapeJob.update({
      where: { id: jobId },
      data: { status: "COMPLETED", processedItems, completedAt: new Date() },
    });
  }

  private async markJobFailed(jobId: string, err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    this.logger.error(`Job ${jobId} failed: ${msg}`);
    await this.prisma.scrapeJob.update({
      where: { id: jobId },
      data: { status: "FAILED", error: msg, completedAt: new Date() },
    });
  }

  // ─── Query Methods ───────────────────────────────────

  async listCompanies(orgId: string, filters: CompanyFilters) {
    const where: Record<string, unknown> = { orgId };
    if (filters.industry) where.industry = filters.industry;
    if (filters.country) where.country = filters.country;

    const [data, total] = await Promise.all([
      this.prisma.company.findMany({
        where,
        skip: (filters.page - 1) * filters.limit,
        take: filters.limit,
        orderBy: { createdAt: "desc" },
      }),
      this.prisma.company.count({ where }),
    ]);

    return { data, total, page: filters.page, limit: filters.limit };
  }

  async listPeople(orgId: string, filters: PeopleFilters) {
    const where: Record<string, unknown> = {
      company: { orgId },
    };
    if (filters.seniority) where.seniority = filters.seniority;
    if (filters.department) where.department = filters.department;

    // If minScore filter, join through LeadScore
    if (filters.minScore !== undefined) {
      where.scores = {
        some: { orgId, score: { gte: filters.minScore } },
      };
    }

    const [data, total] = await Promise.all([
      this.prisma.person.findMany({
        where,
        include: {
          company: { select: { domain: true, name: true } },
          scores: { where: { orgId }, select: { score: true, qualifiedAt: true } },
          emails: { select: { email: true, verified: true, confidence: true } },
        },
        skip: (filters.page - 1) * filters.limit,
        take: filters.limit,
        orderBy: { createdAt: "desc" },
      }),
      this.prisma.person.count({ where }),
    ]);

    return { data, total, page: filters.page, limit: filters.limit };
  }

  async getPersonDetail(orgId: string, personId: string) {
    return this.prisma.person.findFirstOrThrow({
      where: { id: personId, company: { orgId } },
      include: {
        company: true,
        emails: { orderBy: { confidence: "desc" } },
        scores: { where: { orgId } },
      },
    });
  }

  async listJobs(orgId: string) {
    return this.prisma.scrapeJob.findMany({
      where: { orgId },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
  }

  async getStats(orgId: string) {
    const [companies, people, emails, qualified] = await Promise.all([
      this.prisma.company.count({ where: { orgId } }),
      this.prisma.person.count({ where: { company: { orgId } } }),
      this.prisma.emailCandidate.count({
        where: { person: { company: { orgId } } },
      }),
      this.prisma.leadScore.count({
        where: { orgId, qualifiedAt: { not: null } },
      }),
    ]);

    return { companies, people, emails, qualifiedLeads: qualified };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
