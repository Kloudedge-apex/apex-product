import {
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
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
import {
  buildLeadResearchBrief,
  normalizeLeadScoreBreakdown,
  toEvidenceTimeline,
  toIntentSignals,
} from "./lead-intelligence";
import { QUALIFIED_THRESHOLD } from "../common/qualification.constants";
import {
  isAggregatorDomain,
  isLikelyHumanName,
  isLikelyJobTitle,
} from "./quality/lead-quality.validators";
import type {
  Seniority,
  Department,
  ScrapeStage,
  Prisma,
  EmailSource,
} from "@prisma/client";
import { MeetingStatus, OutreachArtifactStatus } from "@prisma/client";
import { isIcpExcludedDomain } from "./icp-domain-exclusions";

const SOURCE_CONFIRMED_EMAIL_SOURCES = new Set<EmailSource>([
  "TEAM_PAGE",
  "GITHUB_COMMIT",
  "SEC_FILING",
  "PRESS_RELEASE",
  "VERIFIED_PATTERN",
]);
const EMAIL_VERIFICATION_BATCH_LIMIT = 10;

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

type UiLeadStage =
  | "sourced"
  | "enriched"
  | "qualified"
  | "in_crm"
  | "contacted"
  | "replied"
  | "meeting";

function deriveUiLeadStage(input: {
  hasMeeting: boolean;
  hasReply: boolean;
  hasContact: boolean;
  qualifiedAt: Date | null | undefined;
  hasEmail: boolean;
}): UiLeadStage {
  // Present the furthest durable customer outcome, not the lead's older
  // enrichment or scoring milestone.
  if (input.hasMeeting) return "meeting";
  if (input.hasReply) return "replied";
  if (input.hasContact) return "contacted";
  if (input.qualifiedAt) return "qualified";
  if (input.hasEmail) return "enriched";
  return "sourced";
}

function latestDate(
  ...values: readonly (Date | null | undefined)[]
): Date | null {
  let latest: Date | null = null;
  for (const value of values) {
    if (value && (!latest || value.getTime() > latest.getTime())) latest = value;
  }
  return latest;
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
      minEmployees?: number | null;
      maxEmployees?: number | null;
      techStackSignals?: string[];
      intentKeywords?: string[];
      seedDomains?: string[];
      exclusionDomains?: string[];
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
        exclusionDomains: data.exclusionDomains ?? [],
      },
    });
  }

  async upsertCurrentIcpProfile(
    orgId: string,
    data: {
      name: string;
      targetTitles?: string[];
      targetIndustries?: string[];
      targetGeos?: string[];
      minEmployees?: number | null;
      maxEmployees?: number | null;
      techStackSignals?: string[];
      intentKeywords?: string[];
      seedDomains?: string[];
      exclusionDomains?: string[];
    },
  ) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT pg_advisory_xact_lock(
          hashtextextended(${`workforce-current-icp:${orgId}`}, 0::bigint)
        ) IS NULL AS acquired
      `;
      const current = await tx.icpProfile.findFirst({
        where: { orgId },
        orderBy: { updatedAt: "desc" },
        select: { id: true },
      });
      const createProfile = {
        name: data.name,
        targetTitles: data.targetTitles ?? [],
        targetIndustries: data.targetIndustries ?? [],
        targetGeos: data.targetGeos ?? [],
        minEmployees: data.minEmployees ?? null,
        maxEmployees: data.maxEmployees ?? null,
        techStackSignals: data.techStackSignals ?? [],
        intentKeywords: data.intentKeywords ?? [],
        seedDomains: data.seedDomains ?? [],
        exclusionDomains: data.exclusionDomains ?? [],
      };
      if (current) {
        const update: Prisma.IcpProfileUpdateInput = { name: data.name };
        if (data.targetTitles !== undefined) update.targetTitles = data.targetTitles;
        if (data.targetIndustries !== undefined) update.targetIndustries = data.targetIndustries;
        if (data.targetGeos !== undefined) update.targetGeos = data.targetGeos;
        if (data.minEmployees !== undefined) update.minEmployees = data.minEmployees;
        if (data.maxEmployees !== undefined) update.maxEmployees = data.maxEmployees;
        if (data.techStackSignals !== undefined) update.techStackSignals = data.techStackSignals;
        if (data.intentKeywords !== undefined) update.intentKeywords = data.intentKeywords;
        if (data.seedDomains !== undefined) update.seedDomains = data.seedDomains;
        if (data.exclusionDomains !== undefined) update.exclusionDomains = data.exclusionDomains;
        return tx.icpProfile.update({
          where: { id: current.id },
          data: update,
        });
      }
      return tx.icpProfile.create({ data: { orgId, ...createProfile } });
    });
  }

  async listIcpProfiles(orgId: string) {
    return this.prisma.icpProfile.findMany({
      where: { orgId },
      orderBy: { createdAt: "desc" },
    });
  }

  // ─── Discovery Pipeline ──────────────────────────────

  private async discoverCompanies(
    orgId: string,
    icp: { targetTitles: string[]; targetIndustries: string[]; targetGeos: string[]; minEmployees?: number | null; maxEmployees?: number | null; techStackSignals: string[]; seedDomains?: string[]; intentKeywords?: string[]; exclusionDomains?: string[] },
    jobId?: string,
    serperOnly = false,
  ): Promise<string[]> {
    const companyIds = new Set<string>();
    const seenDomains = new Set<string>();
    let processed = 0;
    const totalSteps = serperOnly ? 1 : 4;

    const upsertCompany = async (co: { domain: string; name: string; industry?: string; country?: string; employeeRange?: string; atsProvider?: string; atsSlug?: string; source?: string; linkedinCompanyUrl?: string; description?: string; sourceUrl?: string }): Promise<boolean> => {
      if (!co.domain || co.domain.length === 0) return false;
      if (isIcpExcludedDomain(co.domain, icp.exclusionDomains ?? [])) {
        this.logger.log(
          `[lead-quality] Skipping ICP-excluded company domain: ${co.domain}`,
        );
        return false;
      }
      // Block aggregator / SEO / social / parking domains BEFORE we touch the
      // DB. Catches dnb.com, consultancy-me.com, legal500.com, cultureamp.com
      // and friends — see lead-quality.validators.ts for the full list and
      // the audit rows that motivated each entry.
      if (isAggregatorDomain(co.domain)) {
        this.logger.warn(
          `[lead-quality] Skipping aggregator/noise company domain: ${co.domain}`,
        );
        return false;
      }
      const firstObservation = !seenDomains.has(co.domain);
      seenDomains.add(co.domain);
      try {
        const data = {
          domain: co.domain,
          name: co.name,
          industry: co.industry,
          country: co.country,
          employeeRange: co.employeeRange,
          atsProvider: co.atsProvider,
          atsSlug: co.atsSlug,
          serpDescription: co.description,
          serpSourceUrl: co.sourceUrl,
        };
        const company = await this.prisma.company.upsert({
          where: { orgId_domain: { orgId, domain: co.domain } },
          create: { ...data, orgId },
          update: data,
        });
        companyIds.add(company.id);
        if (!firstObservation) {
          this.logger.debug(`[lead-quality] Merged another source for ${co.domain}`);
        }
        return true;
      } catch (err) {
        this.logger.warn(`Failed to upsert company ${co.domain}: ${err instanceof Error ? err.message : String(err)}`);
        return false;
      }
    };

    // Step 1: SERP discovery (primary)
    const serpCompanies = await withRetry(() =>
      this.serpDiscovery.discoverCompanies(orgId, icp),
    );
    for (const co of serpCompanies) {
      await upsertCompany(co);
    }
    processed++;
    if (jobId) await this.updateJobProgress(jobId, processed, totalSteps, { stage: "serp-complete", found: serpCompanies.length });
    if (serperOnly) return [...companyIds];

    // Step 2: TheirStack (hiring intent)
    const theirStackCompanies = await withRetry(() => this.theirStack.discoverHiringCompanies(icp));
    for (const co of theirStackCompanies) {
      const accepted = await upsertCompany({
        domain: co.domain,
        name: co.name,
        country: co.country,
        industry: co.industry,
        employeeRange: co.employeeRange,
      });
      if (!accepted) continue;
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
    const newDomains = serpCompanies.map((c) => c.domain).filter(
      (domain) =>
        !isIcpExcludedDomain(domain, icp.exclusionDomains ?? []) &&
        !isAggregatorDomain(domain) &&
        !atsCompanies.some((company) => company.domain === domain),
    );
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

    return [...companyIds];
  }

  private async discoverPeople(
    orgId: string,
    icp?: { targetTitles: string[]; targetIndustries: string[]; targetGeos: string[]; minEmployees?: number | null; maxEmployees?: number | null },
    scopedCompanyIds?: string[],
  ): Promise<{ count: number; personIds: string[] }> {
    if (scopedCompanyIds !== undefined && scopedCompanyIds.length === 0) {
      // An explicit empty per-run scope is a completed no-op. In particular,
      // do not spend a SERP request that can never match an eligible company.
      return { count: 0, personIds: [] };
    }

    // per-run only: when scopedCompanyIds is provided we restrict people
    // discovery to companies sourced in THIS pipeline run. Falling back to
    // the org-wide set is reserved for ad-hoc calls (e.g. manual reruns).
    const companies = await this.prisma.company.findMany({
      where: scopedCompanyIds !== undefined
        ? { orgId, id: { in: scopedCompanyIds } }
        : { orgId },
      select: { id: true, domain: true, atsProvider: true, atsSlug: true, teamPageUrl: true },
    });

    let count = 0;
    const personIds = new Set<string>();
    const trackUpsert = async (
      companyId: string,
      p: Parameters<LeadsService["upsertPerson"]>[1],
    ) => {
      const id = await this.upsertPerson(companyId, p);
      if (id) {
        personIds.add(id);
        count++;
      }
      return id;
    };

    // SERP-discovered people
    if (icp) {
      try {
        const serpPeople = await withRetry(() => this.serpDiscovery.discoverPeopleViaSERP(icp));
        for (const sp of serpPeople) {
          // Try to match to an existing company or skip
          if (sp.companyName) {
            // Try exact match first, then startsWith, then contains (skip if name too short)
            const companyScope = scopedCompanyIds !== undefined
              ? { id: { in: scopedCompanyIds } }
              : {};
            let company = await this.prisma.company.findFirst({
              where: {
                orgId,
                ...companyScope,
                name: { equals: sp.companyName, mode: 'insensitive' },
              },
            });
            if (!company) {
              company = await this.prisma.company.findFirst({
                where: {
                  orgId,
                  ...companyScope,
                  name: { startsWith: sp.companyName, mode: 'insensitive' },
                },
              });
            }
            if (!company && sp.companyName.length >= 5) {
              company = await this.prisma.company.findFirst({
                where: {
                  orgId,
                  ...companyScope,
                  name: { contains: sp.companyName, mode: 'insensitive' },
                },
              });
            }
            if (company) {
              await trackUpsert(company.id, {
                firstName: sp.firstName,
                lastName: sp.lastName,
                title: sp.title,
                linkedinSlug: sp.linkedinSlug,
                linkedinUrl: sp.linkedinUrl,
              });
            }
          }
        }
      } catch (err) {
        this.logger.warn(`SERP people discovery failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const processCompany = async (co: typeof companies[number]) => {
      try {
        const teamPeople = await this.teamPageScraper.scrapeTeamPage(
          orgId,
          co.domain,
          co.teamPageUrl,
        );
        for (const p of teamPeople) {
          const personId = await trackUpsert(co.id, p);
          const email = normalizePublicCompanyEmail(p.email, co.domain);
          if (!personId || !email) continue;
          await this.prisma.emailCandidate.upsert({
            where: { personId_email: { personId, email } },
            create: {
              personId,
              email,
              source: "TEAM_PAGE",
              verificationResult: "UNKNOWN",
              confidence: 0.9,
            },
            update: { source: "TEAM_PAGE", confidence: 0.9 },
          });
          await this.emailPatternService.learnPattern(orgId, email, co.domain);
        }
      } catch (err) {
        this.logger.warn(`Team page scrape failed for ${co.domain}: ${err instanceof Error ? err.message : String(err)}`);
      }

      try {
        if (co.atsProvider && co.atsSlug) {
          const atsPeople = await this.atsScraper.extractPeopleFromJobs(co.atsProvider, co.atsSlug);
          for (const p of atsPeople) {
            await trackUpsert(co.id, p);
          }
        }
      } catch (err) {
        this.logger.warn(`ATS people extract failed for ${co.domain}: ${err instanceof Error ? err.message : String(err)}`);
      }

      try {
        const ghPeople = await this.githubEnrichment.discoverPeople(co.domain);
        for (const p of ghPeople) {
          await trackUpsert(co.id, p);
        }
      } catch (err) {
        this.logger.warn(`GitHub enrichment failed for ${co.domain}: ${err instanceof Error ? err.message : String(err)}`);
      }
    };

    await batchProcess(companies, 5, processCompany);

    return { count, personIds: [...personIds] };
  }

  private async upsertPerson(
    companyId: string,
    p: { firstName: string; lastName: string; title?: string; seniority?: Seniority; department?: Department; linkedinSlug?: string; linkedinUrl?: string; githubHandle?: string; email?: string },
  ) {
    // Quality gate (1/3): shared validator — catches FAQ headers, country
    // names, all-caps DOM headings. Runs FIRST because it has the strongest
    // negative-keyword list (section-headers + country/region lists) and we
    // want to log the structured reason before falling through to the older
    // regex check.
    if (!isLikelyHumanName({ firstName: p.firstName, lastName: p.lastName })) {
      this.logger.warn(
        `[lead-quality] Skipping non-human-name person: ${p.firstName} ${p.lastName}`,
      );
      return null;
    }

    // Quality gate (2/3): existing regex + garbage-phrase check. Kept because
    // it has a useful list of marketing-phrase rejections ("Get Started",
    // "Click Here") that the shared validator doesn't cover.
    if (!this.isValidPersonName(p.firstName, p.lastName)) return null;

    // Quality gate (3/3): job title sanity. Optional field, so only check
    // when present — a missing title is fine (some sources don't provide one)
    // but a title like "Saudi Arabia" or "Housemaids · Dubai" means the row
    // came from a directory listing and isn't a real person.
    if (p.title && !isLikelyJobTitle(p.title)) {
      this.logger.warn(
        `[lead-quality] Skipping person with non-title field: ${p.firstName} ${p.lastName} — "${p.title}"`,
      );
      return null;
    }

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

  private async enrichContacts(
    orgId: string,
    scopedPersonIds?: string[],
  ): Promise<{ count: number; personIds: string[] }> {
    // per-run only: when scopedPersonIds is provided we restrict enrichment
    // to people sourced in THIS pipeline run. Falling back to org-wide is
    // reserved for ad-hoc reruns invoked outside the graph.
    const people = await this.prisma.person.findMany({
      where: scopedPersonIds !== undefined
        ? { company: { orgId }, id: { in: scopedPersonIds } }
        : { company: { orgId } },
      include: { company: { select: { domain: true } }, emails: true },
    });

    let count = 0;
    const touched = new Set<string>();

    const processPerson = async (person: typeof people[number]) => {
      if (person.emails.some((email) => isEligibleOutreachEmail(email))) {
        return;
      }

      try {
        const generatedCandidates = await this.emailPatternService.generateCandidates(
          orgId,
          person.firstName,
          person.lastName,
          person.company.domain,
        );

        // Existing UNKNOWN/INVALID guesses must be eligible for re-checking;
        // the previous `emails.length > 0` shortcut made their upsert update
        // path unreachable forever.
        type EnrichmentCandidate = {
          email: string;
          pattern: string | null;
          source: EmailSource;
          confidence: number;
        };
        const candidatesByAddress = new Map<string, EnrichmentCandidate>();
        const existingToRetry = person.emails
          .filter((email) => !isEligibleOutreachEmail(email))
          .sort(
            (a, b) =>
              b.confidence - a.confidence || a.email.localeCompare(b.email),
          );
        for (const existing of existingToRetry) {
          candidatesByAddress.set(existing.email.trim().toLowerCase(), {
            email: existing.email,
            pattern: existing.pattern,
            source: existing.source,
            confidence: existing.confidence,
          });
        }
        for (const generated of generatedCandidates) {
          const key = generated.email.trim().toLowerCase();
          const existing = candidatesByAddress.get(key);
          if (!existing || generated.source === "VERIFIED_PATTERN") {
            candidatesByAddress.set(key, generated);
          }
        }
        const candidates = [...candidatesByAddress.values()];

        // Keep the SMTP batch bounded while preventing either retry work or
        // candidates generated in this run from starving the other category.
        // Reserve one slot for the highest-ranked existing retry and one for
        // the first new generated address, then fill any vacancy in the stable
        // combined order above. Only attempted candidates are persisted. That
        // keeps an untried generated address "new" on the next run, so the
        // bounded second slot advances instead of retrying the same UNKNOWN
        // pair forever.
        const verificationCandidates: EnrichmentCandidate[] = [];
        const selectedAddresses = new Set<string>();
        const selectForVerification = (
          candidate: EnrichmentCandidate | undefined,
        ) => {
          if (
            !candidate ||
            verificationCandidates.length >= EMAIL_VERIFICATION_BATCH_LIMIT
          ) {
            return;
          }
          const key = candidate.email.trim().toLowerCase();
          if (selectedAddresses.has(key)) return;
          selectedAddresses.add(key);
          verificationCandidates.push(candidate);
        };

        const existingAddresses = new Set(
          existingToRetry.map((candidate) =>
            candidate.email.trim().toLowerCase(),
          ),
        );
        const highestRankedExisting = existingToRetry[0];
        selectForVerification(
          highestRankedExisting
            ? candidatesByAddress.get(
                highestRankedExisting.email.trim().toLowerCase(),
              )
            : undefined,
        );

        const firstNewGenerated = generatedCandidates.find(
          (candidate) =>
            !existingAddresses.has(candidate.email.trim().toLowerCase()),
        );
        const rankedGenerated = generatedCandidates
          .map(
            (candidate) =>
              candidatesByAddress.get(candidate.email.trim().toLowerCase()) ??
              candidate,
          )
          .sort(
            (a, b) =>
              b.confidence - a.confidence || a.email.localeCompare(b.email),
          );
        selectForVerification(
          firstNewGenerated
            ? candidatesByAddress.get(
                firstNewGenerated.email.trim().toLowerCase(),
              )
            : rankedGenerated[0],
        );

        for (const candidate of candidates) {
          selectForVerification(candidate);
        }

        const verifyResults = await this.emailPatternService.verifyBatch(
          verificationCandidates.map((candidate) => candidate.email),
        );

        for (const c of verificationCandidates) {
          const verification = verifyResults.get(c.email);
          let adjustedConfidence = c.confidence;

          if (verification) {
            if (verification.result === "VALID") {
              adjustedConfidence = Math.min(0.98, c.confidence + 0.3);
            } else {
              // An attempted but still-ineligible address must yield to
              // untried candidates on the next bounded pass. Persisting zero
              // confidence provides durable deterministic rotation without a
              // schema-only "last verification attempt" column.
              adjustedConfidence = 0;
            }
          }

          const verificationFields = verification
            ? {
                verified: verification.result === "VALID",
                verificationResult: verification.result,
                verifiedAt: verification.result === "VALID" ? new Date() : null,
              }
            : { verified: false };

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
              ...verificationFields,
            },
            update: {
              pattern: c.pattern,
              source: c.source,
              confidence: adjustedConfidence,
              ...(verification ? verificationFields : {}),
            },
          });
          count++;
          touched.add(person.id);
        }

        // Learn patterns from verified or source-confirmed emails
        for (const c of candidates) {
          const verification = verifyResults.get(c.email);
          if ((verification && verification.result === 'VALID') || ['TEAM_PAGE', 'GITHUB_COMMIT', 'SEC_FILING', 'PRESS_RELEASE'].includes(c.source)) {
            await this.emailPatternService.learnPattern(
              orgId,
              c.email,
              person.company.domain,
            );
            break; // Learn from the first confirmed email only
          }
        }
      } catch (err) {
        this.logger.warn(`Email enrichment failed for person ${person.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    };

    await batchProcess(people, 10, processPerson);

    // Union: people seen as input (so downstream gets all candidates this
    // run touched, even if they already had emails and we skipped them).
    for (const p of people) touched.add(p.id);

    return { count, personIds: [...touched] };
  }

  private async scoreLeads(
    orgId: string,
    icp: {
      targetTitles: string[];
      targetGeos: string[];
      targetIndustries: string[];
      minEmployees?: number | null;
      maxEmployees?: number | null;
      techStackSignals?: string[];
    },
    scopedPersonIds?: string[],
  ): Promise<{ count: number; personIds: string[] }> {
    // per-run only: when scopedPersonIds is provided we score only the
    // people sourced+enriched in THIS pipeline run. Falling back to org-wide
    // is reserved for ad-hoc reruns invoked outside the graph.
    const people = await this.prisma.person.findMany({
      where: scopedPersonIds !== undefined
        ? { company: { orgId }, id: { in: scopedPersonIds } }
        : { company: { orgId } },
      include: {
        company: true,
        emails: true,
      },
    });

    let count = 0;
    const scoredIds: string[] = [];
    for (const person of people) {
      const { score, breakdown } = this.leadScorer.score(person, icp);
      await this.prisma.leadScore.upsert({
        where: { orgId_personId: { orgId, personId: person.id } },
        create: {
          orgId,
          personId: person.id,
          score,
          breakdown,
          qualifiedAt: score >= QUALIFIED_THRESHOLD ? new Date() : null,
        },
        update: {
          score,
          breakdown,
          qualifiedAt: score >= QUALIFIED_THRESHOLD ? new Date() : null,
        },
      });
      scoredIds.push(person.id);
      count++;
    }

    return { count, personIds: scoredIds };
  }

  // ─── Progress & Job Detail ───────────────────────────

  // ─── Stage Runners (used by the LangGraph pipeline) ──────────────────────
  //
  // Each runner owns its own ScrapeJob lifecycle and calls the same
  // private stage logic that `runPipeline` does. The graph supervisor invokes
  // these one at a time so each stage gets its own checkpoint + UI row.

  async runSourcingStage(
    orgId: string,
    icpProfileId: string,
    options: { serperOnly?: boolean } = {},
  ): Promise<{ companies: number; people: number; companyIds: string[]; personIds: string[] }> {
    const icp = await this.prisma.icpProfile.findFirstOrThrow({
      where: { id: icpProfileId, orgId },
    });

    const companyJobId = await this.createJob(orgId, icpProfileId, "COMPANY_DISCOVERY");
    let companies = 0;
    let companyIds: string[] = [];
    try {
      await this.markJobRunning(companyJobId);
      companyIds = await this.discoverCompanies(
        orgId,
        icp,
        companyJobId,
        options.serperOnly === true,
      );
      companies = companyIds.length;
      await this.markJobCompleted(companyJobId, companies);
    } catch (err) {
      await this.markJobFailed(companyJobId, err);
      throw err;
    }

    const peopleJobId = await this.createJob(orgId, icpProfileId, "PEOPLE_DISCOVERY");
    let people = 0;
    let personIds: string[] = [];
    try {
      await this.markJobRunning(peopleJobId);
      // per-run only: scope people discovery to companies sourced in THIS
      // run so downstream nodes don't see leads from prior runs.
      const result = await this.discoverPeople(orgId, icp, companyIds);
      people = result.count;
      personIds = result.personIds;
      await this.markJobCompleted(peopleJobId, people);
    } catch (err) {
      await this.markJobFailed(peopleJobId, err);
      throw err;
    }

    return { companies, people, companyIds, personIds };
  }

  async runEnrichmentStage(
    orgId: string,
    icpProfileId: string,
    scopedPersonIds?: string[],
  ): Promise<{ merged: number; enriched: number; personIds: string[] }> {
    const identityJobId = await this.createJob(orgId, icpProfileId, "IDENTITY_RESOLUTION");
    let merged = 0;
    try {
      await this.markJobRunning(identityJobId);
      // Identity resolution is intentionally org-wide: it merges duplicate
      // Person rows across the org (including ones created in prior runs).
      // This is a data-quality op, not a per-run lead snapshot, so the
      // result feeds back into the run via scopedPersonIds being remapped.
      merged = await this.identityResolver.resolveAll(orgId);
      await this.markJobCompleted(identityJobId, merged);
    } catch (err) {
      await this.markJobFailed(identityJobId, err);
      throw err;
    }

    const contactJobId = await this.createJob(orgId, icpProfileId, "CONTACT_ENRICHMENT");
    let enriched = 0;
    let personIds: string[] = [];
    try {
      await this.markJobRunning(contactJobId);
      // per-run only: scope enrichment to people sourced in THIS run.
      const result = await this.enrichContacts(orgId, scopedPersonIds);
      enriched = result.count;
      personIds = result.personIds;
      await this.markJobCompleted(contactJobId, enriched);
    } catch (err) {
      await this.markJobFailed(contactJobId, err);
      throw err;
    }

    return { merged, enriched, personIds };
  }

  async runScoringStage(
    orgId: string,
    icpProfileId: string,
    scopedPersonIds?: string[],
  ): Promise<{ scored: number; personIds: string[] }> {
    const icp = await this.prisma.icpProfile.findFirstOrThrow({
      where: { id: icpProfileId, orgId },
    });
    const jobId = await this.createJob(orgId, icpProfileId, "SCORING");
    try {
      await this.markJobRunning(jobId);
      // per-run only: score only the people enriched in THIS run.
      const result = await this.scoreLeads(orgId, icp, scopedPersonIds);
      await this.markJobCompleted(jobId, result.count);
      return { scored: result.count, personIds: result.personIds };
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
    // Defense in depth for every job-producing path, including legacy/direct
    // callers that do not enter through GraphService. ScrapeJob currently has
    // independent orgId and icpProfileId foreign keys, so validate the pair
    // before creating a row and never allow a cross-tenant relation.
    const ownedProfile = await this.prisma.icpProfile.findFirst({
      where: { id: icpProfileId, orgId },
      select: { id: true },
    });
    if (!ownedProfile) {
      throw new NotFoundException("ICP profile not found");
    }

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

    const score = p.scores[0] ?? null;
    const recipientRefs = [p.id, ...p.emails.map((email) => email.email)];
    const [
      evidence,
      latestSentArtifact,
      latestOutboundConversation,
      latestInboundConversation,
      activeMeeting,
    ] = await Promise.all([
        this.prisma.evidenceEvent.findMany({
          where: {
            orgId,
            OR: [
              { refType: "person", refId: p.id },
              { refType: "company", refId: p.companyId },
            ],
          },
          select: { id: true, kind: true, payload: true, createdAt: true },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 25,
        }),
        this.prisma.outreachArtifact.findFirst({
          where: {
            orgId,
            status: OutreachArtifactStatus.SENT,
            recipientRef: { in: recipientRefs },
          },
          select: { sentAt: true },
          orderBy: { sentAt: "desc" },
        }),
        this.prisma.conversation.findFirst({
          where: { orgId, personId: p.id, lastOutboundAt: { not: null } },
          select: { lastOutboundAt: true },
          orderBy: { lastOutboundAt: "desc" },
        }),
        this.prisma.conversation.findFirst({
          where: { orgId, personId: p.id, lastInboundAt: { not: null } },
          select: { lastInboundAt: true },
          orderBy: { lastInboundAt: "desc" },
        }),
        this.prisma.meetingLedger.findFirst({
          where: {
            orgId,
            personId: p.id,
            status: { not: MeetingStatus.CANCELLED },
          },
          select: { id: true },
        }),
      ]);
    const lastContactedAt = latestDate(
      latestSentArtifact?.sentAt,
      latestOutboundConversation?.lastOutboundAt,
    );
    const stage = deriveUiLeadStage({
      hasMeeting: !!activeMeeting,
      hasReply: !!latestInboundConversation?.lastInboundAt,
      hasContact: !!lastContactedAt,
      qualifiedAt: score?.qualifiedAt,
      hasEmail: p.emails.length > 0,
    });
    const intentSignals = toIntentSignals(evidence);

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
      location: p.location,
      bio: p.bio,
      industry: p.company.industry,
      employeeRange: p.company.employeeRange,
      country: p.company.country,
      city: p.company.city,
      createdAt: p.createdAt,
      bestEmail: p.emails[0]?.email ?? null,
      score: score?.score ?? null,
      qualifiedAt: score?.qualifiedAt ?? null,
      stage,
      lastContactedAt,
      emails: p.emails.map((e) => ({
        email: e.email,
        pattern: e.pattern,
        source: e.source,
        confidence: e.confidence,
        verified: e.verified,
        verificationResult: e.verificationResult,
      })),
      researchBrief: buildLeadResearchBrief({
        firstName: p.firstName,
        lastName: p.lastName,
        title: p.title,
        location: p.location,
        company: {
          name: p.company.name,
          domain: p.company.domain,
          industry: p.company.industry,
          employeeRange: p.company.employeeRange,
          city: p.company.city,
          country: p.company.country,
          fundingStage: p.company.fundingStage,
          techStack: p.company.techStack,
        },
        score: score?.score ?? null,
        evidence,
      }),
      scoreBreakdown: normalizeLeadScoreBreakdown(score?.breakdown),
      recentEvidenceEvents: toEvidenceTimeline(evidence),
      intentSignals: intentSignals.length > 0 ? intentSignals : null,
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
        scores: { some: { orgId, score: { gte: QUALIFIED_THRESHOLD } } },
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

  async listLeadsForUi(
    orgId: string,
    opts: {
      stage?: UiLeadStage;
      minScore?: number;
      page: number;
      perPage: number;
      search?: string;
    },
  ): Promise<{
    leads: Array<{
      id: string;
      name: string;
      title: string;
      company: string;
      domain: string;
      email: string;
      industry: string;
      companySize: string;
      techStack: string[];
      score: number | null;
      scoreBreakdown: Array<{ label: string; value: number }>;
      stage: UiLeadStage;
      source: string;
      emailStatus: "not_sent" | "sent" | "opened" | "replied" | "bounced";
      timeline: Array<{ stage: string; at: string }>;
      lastContactedAt: string | null;
      createdAt: string;
    }>;
    total: number;
  }> {
    const where: Record<string, unknown> = { company: { orgId } };
    if (opts.minScore !== undefined) {
      where.scores = { some: { orgId, score: { gte: opts.minScore } } };
    }
    if (opts.search && opts.search.trim()) {
      const q = opts.search.trim().slice(0, 100);
      where.OR = [
        { firstName: { contains: q, mode: "insensitive" } },
        { lastName: { contains: q, mode: "insensitive" } },
        { title: { contains: q, mode: "insensitive" } },
        { company: { is: { name: { contains: q, mode: "insensitive" } } } },
      ];
    }

    const [raw, total] = await Promise.all([
      this.prisma.person.findMany({
        where,
        include: {
          company: {
            select: { name: true, domain: true, industry: true, employeeRange: true, techStack: true },
          },
          scores: { where: { orgId }, select: { score: true, breakdown: true, qualifiedAt: true } },
          emails: {
            select: { email: true, verified: true, confidence: true },
            orderBy: { confidence: "desc" },
            take: 1,
          },
        },
        skip: (opts.page - 1) * opts.perPage,
        take: opts.perPage,
        orderBy: { createdAt: "desc" },
      }),
      this.prisma.person.count({ where }),
    ]);

    const personIds = raw.map((p) => p.id);
    const recipientToPersonId = new Map<string, string>();
    const recipientRefs = new Set<string>();
    for (const person of raw) {
      recipientToPersonId.set(person.id, person.id);
      recipientRefs.add(person.id);
      const email = person.emails[0]?.email?.trim();
      if (email) {
        recipientRefs.add(email);
        recipientToPersonId.set(email, person.id);
        recipientToPersonId.set(email.toLowerCase(), person.id);
      }
    }

    const [artifactsByRecipient, meetingsByPerson, conversationsByPerson] = await Promise.all([
      recipientRefs.size
        ? this.prisma.outreachArtifact.findMany({
            where: {
              orgId,
              status: OutreachArtifactStatus.SENT,
              recipientRef: { in: [...recipientRefs] },
            },
            select: { recipientRef: true, status: true, sentAt: true },
          })
        : Promise.resolve([]),
      personIds.length
        ? this.prisma.meetingLedger.findMany({
            where: {
              orgId,
              personId: { in: personIds },
              status: { not: MeetingStatus.CANCELLED },
            },
            select: { personId: true, status: true },
          })
        : Promise.resolve([]),
      personIds.length
        ? this.prisma.conversation.findMany({
            where: { orgId, personId: { in: personIds } },
            select: {
              personId: true,
              lastInboundAt: true,
              lastOutboundAt: true,
            },
          })
        : Promise.resolve([]),
    ]);

    // Last contact is outbound-only. An inbound reply advances stage but must
    // not be mislabelled as the operator's most recent contact attempt.
    const lastContactedByPerson = new Map<string, Date>();
    const lastReplyByPerson = new Map<string, Date>();
    const retainLatest = (
      target: Map<string, Date>,
      personId: string,
      at: Date,
    ) => {
      const existing = target.get(personId);
      if (!existing || at.getTime() > existing.getTime()) {
        target.set(personId, at);
      }
    };
    for (const a of artifactsByRecipient) {
      const recipientRef = a.recipientRef?.trim();
      const personId = recipientRef
        ? recipientToPersonId.get(recipientRef) ??
          recipientToPersonId.get(recipientRef.toLowerCase())
        : undefined;
      if (personId && a.sentAt)
        retainLatest(lastContactedByPerson, personId, a.sentAt);
    }
    for (const conversation of conversationsByPerson) {
      if (!conversation.personId) continue;
      if (conversation.lastOutboundAt) {
        retainLatest(
          lastContactedByPerson,
          conversation.personId,
          conversation.lastOutboundAt,
        );
      }
      if (conversation.lastInboundAt) {
        retainLatest(
          lastReplyByPerson,
          conversation.personId,
          conversation.lastInboundAt,
        );
      }
    }
    const meetingSet = new Set<string>();
    for (const m of meetingsByPerson) {
      if (m.personId) meetingSet.add(m.personId);
    }

    const normalizeBreakdown = (
      raw: unknown,
    ): Array<{ label: string; value: number }> => {
      if (Array.isArray(raw)) {
        return raw
          .filter((b): b is Record<string, unknown> => !!b && typeof b === "object")
          .map((b) => ({
            label: typeof b.label === "string" ? b.label : typeof b.category === "string" ? b.category : "Score",
            value:
              typeof b.value === "number"
                ? b.value
                : typeof b.points === "number"
                  ? b.points
                  : 0,
          }));
      }
      if (raw && typeof raw === "object") {
        return Object.entries(raw as Record<string, unknown>).map(([k, v]) => ({
          label: k,
          value: typeof v === "number" ? v : 0,
        }));
      }
      return [];
    };

    const leads = raw.map((p) => {
      const email = p.emails[0]?.email ?? "";
      const score = p.scores[0]?.score ?? null;
      const stage = deriveUiLeadStage({
        hasMeeting: meetingSet.has(p.id),
        hasReply: lastReplyByPerson.has(p.id),
        hasContact: lastContactedByPerson.has(p.id),
        qualifiedAt: p.scores[0]?.qualifiedAt,
        hasEmail: !!email,
      });
      const lastContactedAt = lastContactedByPerson.get(p.id) ?? null;
      const lastReplyAt = lastReplyByPerson.get(p.id) ?? null;
      const timeline = [
        ...(lastContactedAt
          ? [{ stage: "contacted", at: lastContactedAt.toISOString() }]
          : []),
        ...(lastReplyAt
          ? [{ stage: "replied", at: lastReplyAt.toISOString() }]
          : []),
      ].sort((a, b) => a.at.localeCompare(b.at));
      return {
        id: p.id,
        name: `${p.firstName} ${p.lastName}`.trim(),
        title: p.title ?? "",
        company: p.company?.name ?? "",
        domain: p.company?.domain ?? "",
        email,
        industry: p.company?.industry ?? "",
        companySize: p.company?.employeeRange ?? "",
        techStack: p.company?.techStack ?? [],
        score,
        scoreBreakdown: normalizeBreakdown(p.scores[0]?.breakdown),
        stage,
        source: "discovery",
        emailStatus: (stage === "replied"
          ? "replied"
          : stage === "contacted" || stage === "meeting"
            ? "sent"
            : "not_sent") as
          | "not_sent"
          | "sent"
          | "opened"
          | "replied"
          | "bounced",
        timeline,
        lastContactedAt: lastContactedAt?.toISOString() ?? null,
        createdAt: p.createdAt.toISOString(),
      };
    });

    const filtered = opts.stage ? leads.filter((l) => l.stage === opts.stage) : leads;
    return { leads: filtered, total };
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

function isEligibleOutreachEmail(candidate: {
  verified: boolean;
  verificationResult: string;
  source: EmailSource;
}): boolean {
  if (
    candidate.verified &&
    candidate.verificationResult === "VALID"
  ) {
    return true;
  }
  return (
    candidate.verificationResult !== "INVALID" &&
    SOURCE_CONFIRMED_EMAIL_SOURCES.has(candidate.source)
  );
}

function normalizePublicCompanyEmail(
  value: string | undefined,
  companyDomain: string,
): string | null {
  if (!value) return null;
  const email = value.trim().toLowerCase().replace(/^mailto:/, "");
  const parts = email.split("@");
  if (
    parts.length !== 2 ||
    !parts[0] ||
    parts[1] !== companyDomain.trim().toLowerCase() ||
    !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+$/.test(email)
  ) {
    return null;
  }
  return email;
}
