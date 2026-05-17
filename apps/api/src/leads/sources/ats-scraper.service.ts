import { Injectable, Logger } from "@nestjs/common";
import type { Seniority } from "@prisma/client";

interface DiscoveredCompany {
  domain: string;
  name: string;
  atsProvider: string;
  atsSlug: string;
  industry?: string;
  country?: string;
}

interface DiscoveredPerson {
  firstName: string;
  lastName: string;
  title?: string;
  seniority?: Seniority;
}

interface GreenhouseJob {
  id: number;
  title: string;
  content?: string;
  location?: { name?: string };
  departments?: Array<{ name: string }>;
}

interface LeverPosting {
  id: string;
  text: string;
  descriptionPlain?: string;
  categories?: { team?: string; location?: string; department?: string };
}

interface AshbyJob {
  id: string;
  title: string;
  descriptionHtml?: string;
  location?: string;
  departmentName?: string;
}

const HIRING_MANAGER_PATTERNS = [
  /reports?\s+to[:\s]+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/gi,
  /hiring\s+manager[:\s]+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/gi,
  /manager[:\s]+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/gi,
];

const SENIORITY_MAP: Record<string, Seniority> = {
  chief: "C_LEVEL",
  ceo: "C_LEVEL",
  cto: "C_LEVEL",
  cfo: "C_LEVEL",
  coo: "C_LEVEL",
  cmo: "C_LEVEL",
  "vice president": "VP",
  vp: "VP",
  director: "DIRECTOR",
  head: "DIRECTOR",
  manager: "MANAGER",
  lead: "MANAGER",
  senior: "IC",
  engineer: "IC",
  analyst: "IC",
};

/** Rate-limited fetch wrapper */
async function rateLimitedFetch(url: string, options?: RequestInit): Promise<Response> {
  await new Promise((r) => setTimeout(r, 200));
  return fetch(url, {
    ...options,
    headers: {
      "User-Agent": "WorkforceOS/1.0 (lead-engine)",
      ...options?.headers,
    },
    signal: AbortSignal.timeout(15000),
  });
}

@Injectable()
export class AtsScraper {
  private readonly logger = new Logger(AtsScraper.name);

  async discoverCompanies(
    _icp: { targetIndustries: string[]; targetGeos: string[]; techStackSignals: string[] },
    seedDomains?: string[],
  ): Promise<DiscoveredCompany[]> {
    if (!seedDomains || seedDomains.length === 0) {
      this.logger.log("ATS company discovery: no seed domains provided, skipping");
      return [];
    }

    this.logger.log(`ATS discovery: probing ${seedDomains.length} seed domains`);
    const results: DiscoveredCompany[] = [];

    for (const domain of seedDomains) {
      try {
        const detected = await this.discoverAtsSlugs([domain]);
        if (detected.length > 0) {
          const d = detected[0]!;
          results.push({
            domain,
            name: domain.replace(/\.\w+$/, ""),
            atsProvider: d.provider,
            atsSlug: d.slug,
          });
        }
      } catch (err) {
        this.logger.warn(`ATS probe failed for ${domain}: ${err instanceof Error ? err.message : String(err)}`);
      }
      await new Promise((r) => setTimeout(r, 300));
    }

    return results;
  }

  /** Probe domains to detect their ATS provider and slug */
  async discoverAtsSlugs(domains: string[]): Promise<Array<{ domain: string; provider: string; slug: string }>> {
    const results: Array<{ domain: string; provider: string; slug: string }> = [];

    for (const domain of domains) {
      const baseName = domain.replace(/\.\w+$/, "").toLowerCase();
      const noDots = domain.replace(/\./g, "").toLowerCase();
      const slugVariants = [...new Set([baseName, noDots, baseName.replace(/[^a-z0-9]/g, "-")])];

      const detected = await this.probeAtsProviders(domain, slugVariants);
      if (detected) {
        results.push({ domain, ...detected });
      }
    }

    return results;
  }

  private async probeAtsProviders(
    domain: string,
    slugs: string[],
  ): Promise<{ provider: string; slug: string } | null> {
    for (const slug of slugs) {
      // Greenhouse
      try {
        const res = await rateLimitedFetch(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`);
        if (res.ok) {
          const data = await res.json() as { jobs?: unknown[] };
          if (data.jobs && data.jobs.length > 0) {
            this.logger.debug(`Found Greenhouse board for ${domain}: ${slug}`);
            return { provider: "greenhouse", slug };
          }
        }
      } catch { /* skip */ }

      // Lever
      try {
        const res = await rateLimitedFetch(`https://api.lever.co/v0/postings/${slug}?mode=json`);
        if (res.ok) {
          const data = await res.json() as unknown[];
          if (Array.isArray(data) && data.length > 0) {
            this.logger.debug(`Found Lever board for ${domain}: ${slug}`);
            return { provider: "lever", slug };
          }
        }
      } catch { /* skip */ }

      // Ashby
      try {
        const res = await rateLimitedFetch(`https://api.ashbyhq.com/posting-api/job-board/${slug}`);
        if (res.ok) {
          const data = await res.json() as { jobs?: unknown[] };
          if (data.jobs && data.jobs.length > 0) {
            this.logger.debug(`Found Ashby board for ${domain}: ${slug}`);
            return { provider: "ashby", slug };
          }
        }
      } catch { /* skip */ }
    }

    return null;
  }

  async extractPeopleFromJobs(
    atsProvider: string,
    atsSlug: string,
  ): Promise<DiscoveredPerson[]> {
    this.logger.log(`Extracting people from ${atsProvider}/${atsSlug}`);

    try {
      switch (atsProvider.toLowerCase()) {
        case "greenhouse":
          return this.scrapeGreenhouse(atsSlug);
        case "lever":
          return this.scrapeLever(atsSlug);
        case "ashby":
          return this.scrapeAshby(atsSlug);
        default:
          this.logger.warn(`Unknown ATS provider: ${atsProvider}`);
          return [];
      }
    } catch (err) {
      this.logger.error(`ATS scrape failed for ${atsProvider}/${atsSlug}: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  private async scrapeGreenhouse(slug: string): Promise<DiscoveredPerson[]> {
    const url = `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`;
    const res = await rateLimitedFetch(url);
    if (!res.ok) return [];

    const data = (await res.json()) as { jobs?: GreenhouseJob[] };
    const jobs = data.jobs ?? [];
    return this.extractPeopleFromJobContent(jobs.map((j) => j.content ?? ""));
  }

  private async scrapeLever(slug: string): Promise<DiscoveredPerson[]> {
    const url = `https://api.lever.co/v0/postings/${slug}?mode=json`;
    const res = await rateLimitedFetch(url);
    if (!res.ok) return [];

    const postings = (await res.json()) as LeverPosting[];
    return this.extractPeopleFromJobContent(
      postings.map((p) => p.descriptionPlain ?? ""),
    );
  }

  private async scrapeAshby(slug: string): Promise<DiscoveredPerson[]> {
    const url = `https://api.ashbyhq.com/posting-api/job-board/${slug}`;
    const res = await rateLimitedFetch(url);
    if (!res.ok) return [];

    const data = (await res.json()) as { jobs?: AshbyJob[] };
    const jobs = data.jobs ?? [];
    return this.extractPeopleFromJobContent(
      jobs.map((j) => j.descriptionHtml?.replace(/<[^>]*>/g, " ") ?? ""),
    );
  }

  private extractPeopleFromJobContent(contents: string[]): DiscoveredPerson[] {
    const people: DiscoveredPerson[] = [];
    const seen = new Set<string>();

    for (const content of contents) {
      for (const pattern of HIRING_MANAGER_PATTERNS) {
        // Reset lastIndex for global regex
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(content)) !== null) {
          const fullName = match[1]?.trim();
          if (!fullName) continue;

          const key = fullName.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);

          const parts = fullName.split(/\s+/);
          if (parts.length < 2) continue;

          people.push({
            firstName: parts[0]!,
            lastName: parts.slice(1).join(" "),
            seniority: "MANAGER",
          });
        }
      }
    }

    return people;
  }

  /** Infer seniority from a job title string */
  inferSeniority(title: string): Seniority {
    const lower = title.toLowerCase();
    for (const [keyword, seniority] of Object.entries(SENIORITY_MAP)) {
      if (lower.includes(keyword)) return seniority;
    }
    return "UNKNOWN";
  }
}
