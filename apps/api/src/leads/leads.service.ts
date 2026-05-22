import { Injectable, Logger, ConflictException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AtsScraper } from "./sources/ats-scraper.service";
import { TeamPageScraper } from "./sources/team-page-scraper.service";
import { RegistryScraper } from "./sources/registry-scraper.service";
import { GithubEnrichment } from "./sources/github-enrichment.service";
import { JobSignalService } from "./sources/job-signal.service";
import { SerpDiscoveryService } from "./sources/serp-discovery.service";
import { TheirStackService } from "./sources/theirstack.service";
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
    private readonly serpDiscovery: SerpDiscoveryService,
    private readonly theirStack: TheirStackService,
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
      intentKeywords?: string[];
      seedDomains?: string[];
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
        intentKeywords: data.intentKeywords ?? [],
        seedDomains: data.seedDomains ?? [],
      },
    });
  }

  async listIcpProfiles(orgId: string) {
    return this.prisma.icpProfile.findMany({
      where: { orgId },
      orderBy: { createdAt: "desc" },
    });
  }

  async updateIcpSchedule(orgId: string, icpId: string, enabled: boolean, intervalHours?: number) {
    const icp = await this.prisma.icpProfile.findFirstOrThrow({
      where: { id: icpId, orgId },
    });

    const data: Record<string, unknown> = { scheduleEnabled: enabled };
    if (intervalHours !== undefined) data.scheduleInterval = intervalHours;

    return this.prisma.icpProfile.update({
      where: { id: icp.id },
      data,
    });
  }

  // ─── Discovery Pipeline ──────────────────────────────

  async triggerDiscovery(orgId: string, icpProfileId: string) {
    const existingJob = await this.prisma.scrapeJob.findFirst({
      where: { orgId, status: { in: ['QUEUED', 'RUNNING'] } },
    });
    if (existingJob) {
      throw new ConflictException('Discovery pipeline already running for this org');
    }

    const icp = await this.prisma.icpProfile.findFirstOrThrow({
      where: { id: icpProfileId, orgId },
    });

    this.logger.log(`Starting discovery pipeline for ICP "${icp.name}" (org: ${orgId})`);

    // Update lastRunAt
    await this.prisma.icpProfile.update({
      where: { id: icpProfileId },
      data: { lastRunAt: new Date() },
    });

    // Fire and forget: run pipeline stages sequentially in background
    void this.runPipeline(orgId, icpProfileId, icp).catch((err: unknown) => {
      this.logger.error(`Pipeline failed for ICP ${icpProfileId}`, err instanceof Error ? err.stack : String(err));
    });

    return { message: "Discovery pipeline started", icpProfileId };
  }

  private async runPipeline(
    orgId: string,
    icpProfileId: string,
    icp: { targetTitles: string[]; targetIndustries: string[]; targetGeos: string[]; minEmployees: number | null; maxEmployees: number | null; techStackSignals: string[]; seedDomains?: string[]; intentKeywords?: string[] },
  ) {
    // Stage 1: Company Discovery
    const companyJobId = await this.createJob(orgId, icpProfileId, "COMPANY_DISCOVERY");
    try {
      await this.markJobRunning(companyJobId);
      const companies = await this.discoverCompanies(orgId, icp, companyJobId);
      await this.markJobCompleted(companyJobId, companies.length);
    } catch (err) {
      await this.markJobFailed(companyJobId, err);
    }

    // Stage 2: People Discovery
    const peopleJobId = await this.createJob(orgId, icpProfileId, "PEOPLE_DISCOVERY");
    try {
      await this.markJobRunning(peopleJobId);
      const count = await this.discoverPeople(orgId, icp);
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
    icp: { targetTitles: string[]; targetIndustries: string[]; targetGeos: string[]; minEmployees?: number | null; maxEmployees?: number | null; techStackSignals: string[]; seedDomains?: string[]; intentKeywords?: string[] },
    jobId?: string,
  ): Promise<string[]> {
    const companyIds: string[] = [];
    const seenDomains = new Set<string>();
    let processed = 0;
    const totalSteps = 4;

    const upsertCompany = async (co: { domain: string; name: string; industry?: string; country?: string; atsProvider?: string; atsSlug?: string; source?: string; linkedinCompanyUrl?: string }) => {
      if (!co.domain || co.domain.length === 0) return;
      if (seenDomains.has(co.domain)) return;
      seenDomains.add(co.domain);
      try {
        const data = {
          domain: co.domain,
          name: co.name,
          industry: co.industry,
          country: co.country,
          atsProvider: co.atsProvider,
          atsSlug: co.atsSlug,
        };
        const company = await this.prisma.company.upsert({
          where: { orgId_domain: { orgId, domain: co.domain } },
          create: { ...data, orgId },
          update: data,
        });
        companyIds.push(company.id);
      } catch (err) {
        this.logger.warn(`Failed to upsert company ${co.domain}: ${err instanceof Error ? err.message : String(err)}`);
      }
    };

    // Step 1: SERP discovery (primary)
    const serpCompanies = await withRetry(() => this.serpDiscovery.discoverCompanies(icp));
    for (const co of serpCompanies) {
      await upsertCompany(co);
    }
    processed++;
    if (jobId) await this.updateJobProgress(jobId, processed, totalSteps, { stage: "serp-complete", found: serpCompanies.length });

    // Step 2: TheirStack (hiring intent)
    const theirStackCompanies = await withRetry(() => this.theirStack.discoverHiringCompanies(icp));
    for (const co of theirStackCompanies) {
      await upsertCompany({ domain: co.domain, name: co.name, country: co.country, industry: co.industry });
      // Score intent from TheirStack job data
      if (co.jobTitles.length > 0) {
        try {
          const { intentScore, signals } = this.jobSignalService.scoreJobIntent(
            co.jobTitles,
            [],
            icp.intentKeywords ?? [],
            icp.targetTitles,
          );
          const finalScore = Math.max(co.intentScore, intentScore);
          const finalSignals = [...new Set([...co.intentSignals, ...signals])];
          await this.prisma.company.update({
            where: { orgId_domain: { orgId, domain: co.domain } },
            data: { intentScore: finalScore, intentSignals: finalSignals },
          });
        } catch {
          // non-critical
        }
      }
    }
    processed++;
    if (jobId) await this.updateJobProgress(jobId, processed, totalSteps, { stage: "theirstack-complete", found: theirStackCompanies.length });

    // Step 3: ATS slug detection for discovered companies
    const atsCompanies = await withRetry(() => this.atsScraper.discoverCompanies(icp, icp.seedDomains));
    for (const co of atsCompanies) {
      await upsertCompany(co);
    }
    // Also probe ATS for SERP-discovered domains
    const newDomains = serpCompanies.map((c) => c.domain).filter((d) => !atsCompanies.some((a) => a.domain === d));
    if (newDomains.length > 0) {
      const atsSlugs = await withRetry(() => this.atsScraper.discoverAtsSlugs(newDomains.slice(0, 20)));
      for (const detected of atsSlugs) {
        await this.prisma.company.updateMany({
          where: { orgId, domain: detected.domain },
          data: { atsProvider: detected.provider, atsSlug: detected.slug },
        });
      }
    }
    processed++;
    if (jobId) await this.updateJobProgress(jobId, processed, totalSteps, { stage: "ats-complete" });

    // Step 4: Registry enrichment
    const registryCompanies = await withRetry(() => this.registryScraper.discoverCompanies(icp));
    for (const co of registryCompanies) {
      await upsertCompany(co);
    }
    processed++;
    if (jobId) await this.updateJobProgress(jobId, processed, totalSteps, { stage: "registry-complete", found: registryCompanies.length });

    return companyIds;
  }

  private async discoverPeople(orgId: string, icp?: { targetTitles: string[]; targetIndustries: string[]; targetGeos: string[]; minEmployees?: number | null; maxEmployees?: number | null }): Promise<number> {
    const companies = await this.prisma.company.findMany({
      where: { orgId },
      select: { id: true, domain: true, atsProvider: true, atsSlug: true, teamPageUrl: true },
    });

    let count = 0;

    // SERP-discovered people
    if (icp) {
      try {
        const serpPeople = await withRetry(() => this.serpDiscovery.discoverPeopleViaSERP(icp));
        for (const sp of serpPeople) {
          // Try to match to an existing company or skip
          if (sp.companyName) {
            // Try exact match first, then startsWith, then contains (skip if name too short)
            let company = await this.prisma.company.findFirst({
              where: { orgId, name: { equals: sp.companyName, mode: 'insensitive' } },
            });
            if (!company) {
              company = await this.prisma.company.findFirst({
                where: { orgId, name: { startsWith: sp.companyName, mode: 'insensitive' } },
              });
            }
            if (!company && sp.companyName.length >= 5) {
              company = await this.prisma.company.findFirst({
                where: { orgId, name: { contains: sp.companyName, mode: 'insensitive' } },
              });
            }
            if (company) {
              await this.upsertPerson(company.id, {
                firstName: sp.firstName,
                lastName: sp.lastName,
                title: sp.title,
                linkedinSlug: sp.linkedinSlug,
                linkedinUrl: sp.linkedinUrl,
              });
              count++;
            }
          }
        }
      } catch (err) {
        this.logger.warn(`SERP people discovery failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const processCompany = async (co: typeof companies[number]) => {
      try {
        const teamPeople = await this.teamPageScraper.scrapeTeamPage(co.domain, co.teamPageUrl);
        for (const p of teamPeople) {
          await this.upsertPerson(co.id, p);
          count++;
        }
      } catch (err) {
        this.logger.warn(`Team page scrape failed for ${co.domain}: ${err instanceof Error ? err.message : String(err)}`);
      }

      try {
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
        const ghPeople = await this.githubEnrichment.discoverPeople(co.domain);
        for (const p of ghPeople) {
          await this.upsertPerson(co.id, p);
          count++;
        }
      } catch (err) {
        this.logger.warn(`GitHub enrichment failed for ${co.domain}: ${err instanceof Error ? err.message : String(err)}`);
      }
    };

    await batchProcess(companies, 5, processCompany);

    return count;
  }

  private async upsertPerson(
    companyId: string,
    p: { firstName: string; lastName: string; title?: string; seniority?: Seniority; department?: Department; linkedinSlug?: string; linkedinUrl?: string; githubHandle?: string },
  ) {
    // Validate name: skip garbage entries from DOM parsing
    if (!this.isValidPersonName(p.firstName, p.lastName)) return null;

    // Infer seniority from title if not already set
    if ((!p.seniority || p.seniority === "UNKNOWN") && p.title) {
      p.seniority = this.inferSeniority(p.title);
    }

    // Infer department from title if not already set
    if ((!p.department || p.department === "UNKNOWN") && p.title) {
      p.department = this.inferDepartment(p.title);
    }

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

  /** Validate that a name looks like a real person, not DOM garbage */
  private isValidPersonName(firstName: string, lastName: string): boolean {
    // Each part should be 2-20 chars, start with uppercase, mostly alpha
    const nameRegex = /^[A-Z][a-zA-Z'-]{1,19}$/;
    if (!nameRegex.test(firstName) || !nameRegex.test(lastName.split(" ")[0] ?? "")) return false;

    // Filter out common DOM garbage
    const combined = `${firstName} ${lastName}`.toLowerCase();
    const garbage = [
      "find out", "learn more", "read more", "contact us", "get started",
      "discover how", "what to expect", "our program", "our team",
      "selection by", "supported by", "powered by", "backed by",
      "terms of", "privacy policy", "cookie policy", "all rights",
      "click here", "sign up", "log in", "join us",
    ];
    if (garbage.some((g) => combined.includes(g))) return false;

    // Name parts shouldn't be common English words
    const commonWords = new Set([
      "the", "and", "for", "our", "how", "what", "who", "when", "where",
      "more", "find", "out", "get", "all", "new", "top", "best",
      "programmes", "initiatives", "discover", "selection", "expect",
    ]);
    if (commonWords.has(firstName.toLowerCase()) || commonWords.has(lastName.toLowerCase())) return false;

    return true;
  }

  /** Infer seniority level from job title */
  private inferSeniority(title: string): Seniority {
    const lower = title.toLowerCase();
    if (/\b(chief|c[etomp]o|cfo|ciso|cro|cso)\b/.test(lower)) return "C_LEVEL";
    if (/\b(vp|vice\s+president)\b/.test(lower)) return "VP";
    if (/\b(director|head\s+of)\b/.test(lower)) return "DIRECTOR";
    if (/\b(manager|lead)\b/.test(lower)) return "MANAGER";
    if (/\b(senior|staff|principal)\b/.test(lower)) return "IC";
    return "UNKNOWN";
  }

  /** Infer department from job title */
  private inferDepartment(title: string): Department {
    const lower = title.toLowerCase();
    if (/\b(sales|revenue|account\s+exec|business\s+dev|bdr|sdr)\b/.test(lower)) return "SALES";
    if (/\b(marketing|growth|brand|content|seo|demand\s+gen)\b/.test(lower)) return "MARKETING";
    if (/\b(engineer|developer|devops|platform|infra|backend|frontend|fullstack|sre)\b/.test(lower)) return "ENGINEERING";
    if (/\b(financ|accounting|controller|treasury|cfo)\b/.test(lower)) return "FINANCE";
    if (/\b(operations|ops|logistics|supply\s+chain)\b/.test(lower)) return "OPERATIONS";
    if (/\b(people|hr|human\s+resources|talent|recruit)\b/.test(lower)) return "HR";
    if (/\b(legal|compliance|regulatory|counsel)\b/.test(lower)) return "LEGAL";
    if (/\b(ceo|coo|chief|president|founder|co-founder)\b/.test(lower)) return "EXECUTIVE";
    return "OTHER";
  }

  private async enrichContacts(orgId: string): Promise<number> {
    const people = await this.prisma.person.findMany({
      where: { company: { orgId } },
      include: { company: { select: { domain: true } }, emails: true },
    });

    let count = 0;

    const processPerson = async (person: typeof people[number]) => {
      if (person.emails.length > 0) return;

      try {
        const candidates = await this.emailPatternService.generateCandidates(
          person.firstName,
          person.lastName,
          person.company.domain,
        );

        // Verify top 2 candidates via SMTP
        const top2 = candidates.slice(0, 2);
        const verifyResults = await this.emailPatternService.verifyBatch(top2.map((c) => c.email));

        for (const c of candidates) {
          const verification = verifyResults.get(c.email);
          let adjustedConfidence = c.confidence;
          let verified = false;

          if (verification) {
            if (verification.result === "VALID") {
              adjustedConfidence = Math.min(0.98, c.confidence + 0.3);
              verified = true;
            } else if (verification.result === "INVALID") {
              adjustedConfidence = 0.05;
            } else if (verification.result === "CATCH_ALL") {
              // Catch-all: keep original confidence, can't confirm
              adjustedConfidence = Math.min(c.confidence, 0.5);
            }
          }

          await this.prisma.emailCandidate.upsert({
            where: {
              personId_email: { personId: person.id, email: c.email },
            },
            create: {
              personId: person.id,
              email: c.email,
              pattern: c.pattern,
              source: c.source,
              confidence: adjustedConfidence,
              verified,
            },
            update: {
              confidence: adjustedConfidence,
              verified,
            },
          });
          count++;
        }

        // Learn patterns from verified or source-confirmed emails
        for (const c of candidates) {
          const verification = verifyResults.get(c.email);
          if ((verification && verification.result === 'VALID') || ['TEAM_PAGE', 'GITHUB_COMMIT', 'SEC_FILING'].includes(c.source)) {
            await this.emailPatternService.learnPattern(c.email, person.company.domain);
            break; // Learn from the first confirmed email only
          }
        }
      } catch (err) {
        this.logger.warn(`Email enrichment failed for person ${person.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    };

    await batchProcess(people, 10, processPerson);

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

  // ─── Progress & Job Detail ───────────────────────────

  // ─── Stage Runners (used by the LangGraph pipeline) ──────────────────────
  //
  // Each runner owns its own ScrapeJob lifecycle and calls the same
  // private stage logic that `runPipeline` does. The graph supervisor invokes
  // these one at a time so each stage gets its own checkpoint + UI row.

  async runSourcingStage(orgId: string, icpProfileId: string): Promise<{ companies: number; people: number }> {
    const icp = await this.prisma.icpProfile.findFirstOrThrow({
      where: { id: icpProfileId, orgId },
    });

    const companyJobId = await this.createJob(orgId, icpProfileId, "COMPANY_DISCOVERY");
    let companies = 0;
    try {
      await this.markJobRunning(companyJobId);
      const ids = await this.discoverCompanies(orgId, icp, companyJobId);
      companies = ids.length;
      await this.markJobCompleted(companyJobId, companies);
    } catch (err) {
      await this.markJobFailed(companyJobId, err);
      throw err;
    }

    const peopleJobId = await this.createJob(orgId, icpProfileId, "PEOPLE_DISCOVERY");
    let people = 0;
    try {
      await this.markJobRunning(peopleJobId);
      people = await this.discoverPeople(orgId, icp);
      await this.markJobCompleted(peopleJobId, people);
    } catch (err) {
      await this.markJobFailed(peopleJobId, err);
      throw err;
    }

    return { companies, people };
  }

  async runEnrichmentStage(orgId: string, icpProfileId: string): Promise<{ merged: number; enriched: number }> {
    const identityJobId = await this.createJob(orgId, icpProfileId, "IDENTITY_RESOLUTION");
    let merged = 0;
    try {
      await this.markJobRunning(identityJobId);
      merged = await this.identityResolver.resolveAll(orgId);
      await this.markJobCompleted(identityJobId, merged);
    } catch (err) {
      await this.markJobFailed(identityJobId, err);
      throw err;
    }

    const contactJobId = await this.createJob(orgId, icpProfileId, "CONTACT_ENRICHMENT");
    let enriched = 0;
    try {
      await this.markJobRunning(contactJobId);
      enriched = await this.enrichContacts(orgId);
      await this.markJobCompleted(contactJobId, enriched);
    } catch (err) {
      await this.markJobFailed(contactJobId, err);
      throw err;
    }

    return { merged, enriched };
  }

  async runScoringStage(orgId: string, icpProfileId: string): Promise<{ scored: number }> {
    const icp = await this.prisma.icpProfile.findFirstOrThrow({
      where: { id: icpProfileId, orgId },
    });
    const jobId = await this.createJob(orgId, icpProfileId, "SCORING");
    try {
      await this.markJobRunning(jobId);
      const scored = await this.scoreLeads(orgId, icp);
      await this.markJobCompleted(jobId, scored);
      return { scored };
    } catch (err) {
      await this.markJobFailed(jobId, err);
      throw err;
    }
  }

  private async updateJobProgress(jobId: string, processedItems: number, totalItems: number, metadata?: Record<string, unknown>) {
    const progress = totalItems > 0 ? processedItems / totalItems : 0;
    await this.prisma.scrapeJob.update({
      where: { id: jobId },
      data: {
        processedItems,
        totalItems,
        progress: Math.min(1, progress),
        metadata: metadata ? (metadata as Record<string, string | number | boolean>) : undefined,
      },
    });
  }

  async getJob(orgId: string, jobId: string) {
    return this.prisma.scrapeJob.findFirstOrThrow({
      where: { id: jobId, orgId },
    });
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

    const [raw, total] = await Promise.all([
      this.prisma.company.findMany({
        where,
        include: { _count: { select: { people: true } } },
        skip: (filters.page - 1) * filters.limit,
        take: filters.limit,
        orderBy: { createdAt: "desc" },
      }),
      this.prisma.company.count({ where }),
    ]);

    const items = raw.map((c) => ({
      id: c.id,
      name: c.name,
      domain: c.domain,
      industry: c.industry,
      country: c.country,
      employeeRange: c.employeeRange,
      atsProvider: c.atsProvider,
      intentScore: c.intentScore,
      peopleCount: c._count.people,
    }));

    return { items, total, page: filters.page, limit: filters.limit };
  }

  async listCompanyPeople(orgId: string, companyId: string) {
    const raw = await this.prisma.person.findMany({
      where: { companyId, company: { orgId } },
      include: {
        company: { select: { domain: true, name: true } },
        scores: { where: { orgId }, select: { score: true, qualifiedAt: true } },
        emails: { select: { email: true, confidence: true }, orderBy: { confidence: "desc" }, take: 1 },
      },
      orderBy: { createdAt: "desc" },
    });

    return raw.map((p) => ({
      id: p.id,
      firstName: p.firstName,
      lastName: p.lastName,
      title: p.title,
      company: p.company?.name ?? null,
      companyDomain: p.company?.domain ?? null,
      seniority: p.seniority,
      department: p.department,
      linkedinUrl: p.linkedinUrl,
      bestEmail: p.emails[0]?.email ?? null,
      score: p.scores[0]?.score ?? null,
      qualifiedAt: p.scores[0]?.qualifiedAt ?? null,
    }));
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

    const [raw, total] = await Promise.all([
      this.prisma.person.findMany({
        where,
        include: {
          company: { select: { domain: true, name: true } },
          scores: { where: { orgId }, select: { score: true, qualifiedAt: true } },
          emails: { select: { email: true, verified: true, confidence: true }, orderBy: { confidence: "desc" }, take: 1 },
        },
        skip: (filters.page - 1) * filters.limit,
        take: filters.limit,
        orderBy: { createdAt: "desc" },
      }),
      this.prisma.person.count({ where }),
    ]);

    const items = raw.map((p) => ({
      id: p.id,
      firstName: p.firstName,
      lastName: p.lastName,
      title: p.title,
      company: p.company?.name ?? null,
      companyDomain: p.company?.domain ?? null,
      seniority: p.seniority,
      department: p.department,
      linkedinUrl: p.linkedinUrl,
      bestEmail: p.emails[0]?.email ?? null,
      score: p.scores[0]?.score ?? null,
      qualifiedAt: p.scores[0]?.qualifiedAt ?? null,
    }));

    return { items, total, page: filters.page, limit: filters.limit };
  }

  async getPersonDetail(orgId: string, personId: string) {
    const p = await this.prisma.person.findFirstOrThrow({
      where: { id: personId, company: { orgId } },
      include: {
        company: true,
        emails: { orderBy: { confidence: "desc" } },
        scores: { where: { orgId } },
      },
    });

    return {
      id: p.id,
      firstName: p.firstName,
      lastName: p.lastName,
      title: p.title,
      company: p.company?.name ?? null,
      companyDomain: p.company?.domain ?? null,
      seniority: p.seniority,
      department: p.department,
      linkedinUrl: p.linkedinUrl,
      location: null,
      bio: null,
      bestEmail: p.emails[0]?.email ?? null,
      score: p.scores[0]?.score ?? null,
      qualifiedAt: p.scores[0]?.qualifiedAt ?? null,
      emails: p.emails.map((e) => ({
        email: e.email,
        pattern: e.pattern,
        source: e.source,
        confidence: e.confidence,
        verified: e.verified,
        verificationResult: e.verificationResult,
      })),
      scoreBreakdown: p.scores[0] ? [
        { category: "Total", points: p.scores[0].score },
      ] : [],
    };
  }

  async listJobs(orgId: string) {
    const jobs = await this.prisma.scrapeJob.findMany({
      where: { orgId },
      orderBy: { createdAt: "desc" },
      take: 50,
    });

    return jobs.map((j) => ({
      id: j.id,
      stage: j.stage,
      status: j.status,
      progress: j.status === "COMPLETED" ? 100 : j.status === "RUNNING" ? 50 : 0,
      itemsProcessed: j.processedItems,
      startedAt: j.startedAt,
      completedAt: j.completedAt,
    }));
  }

  async exportCsv(orgId: string): Promise<string> {
    const people = await this.prisma.person.findMany({
      where: {
        company: { orgId },
        scores: { some: { orgId, score: { gte: 100 } } },
      },
      include: {
        company: { select: { name: true, domain: true } },
        emails: { orderBy: { confidence: 'desc' }, take: 1 },
        scores: { where: { orgId }, select: { score: true } },
      },
    });

    const header = 'firstName,lastName,title,company,domain,email,confidence,score,linkedinUrl';
    const rows = people.map(p => {
      const email = p.emails[0];
      const score = p.scores[0]?.score ?? 0;
      const escapeCsv = (s: string | null | undefined) => {
        if (!s) return '';
        // Strip formula injection characters
        let safe = s;
        if (/^[=+\-@\t\r]/.test(safe)) safe = `'${safe}`;
        if (safe.includes(',') || safe.includes('"') || safe.includes('\n')) return `"${safe.replace(/"/g, '""')}"`;
        return safe;
      };
      return [
        escapeCsv(p.firstName), escapeCsv(p.lastName), escapeCsv(p.title),
        escapeCsv(p.company.name), escapeCsv(p.company.domain),
        escapeCsv(email?.email), email?.confidence?.toString() ?? '', score.toString(),
        escapeCsv(p.linkedinUrl),
      ].join(',');
    });

    return [header, ...rows].join('\n');
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

    return { companiesFound: companies, peopleDiscovered: people, emailsFound: emails, qualifiedLeads: qualified };
  }
}

async function withRetry<T>(fn: () => Promise<T>, retries = 2, delayMs = 1000): Promise<T> {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === retries) throw err;
      await delay(delayMs * (i + 1));
    }
  }
  throw new Error("unreachable");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function batchProcess<T>(items: T[], batchSize: number, fn: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    await Promise.all(batch.map(fn));
    if (i + batchSize < items.length) await delay(500);
  }
}
