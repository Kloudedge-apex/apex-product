import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { fetchWithRetry, withCircuitBreaker } from "../../common/http-retry.util";

interface IcpInput {
  targetTitles: string[];
  targetIndustries: string[];
  targetGeos: string[];
  minEmployees?: number | null;
  maxEmployees?: number | null;
}

interface TheirStackJob {
  id: string | number;
  job_title: string;
  description?: string;
  company?: string;
  company_domain?: string | null;
  date_posted?: string;
  source_url?: string;
  url?: string;
  hiring_team?: Array<{
    full_name?: string | null;
    first_name?: string | null;
    role?: string | null;
  }> | null;
  company_object?: {
    name: string;
    domain?: string | null;
    country?: string | null;
    industry?: string | null;
    employee_count_range?: string | null;
  };
}

interface TheirStackResponse {
  data?: TheirStackJob[];
  total?: number;
}

interface DiscoveredCompany {
  domain: string;
  name: string;
  country?: string;
  industry?: string;
  employeeRange?: string;
  intentScore: number;
  intentSignals: string[];
  jobTitles: string[];
  jobs: Array<{ title: string; url: string; postedAt: string }>;
  source: string;
}

interface DiscoveredHiringManager {
  firstName: string;
  lastName: string;
  title?: string;
  department?: string;
  companyDomain: string;
}

/** Map common geo names to ISO country codes */
const GEO_TO_COUNTRY_CODE: Record<string, string> = {
  "uk": "GB", "united kingdom": "GB", "england": "GB", "london": "GB",
  "us": "US", "united states": "US", "usa": "US",
  "germany": "DE", "france": "FR", "india": "IN",
  "canada": "CA", "australia": "AU", "netherlands": "NL",
  "singapore": "SG", "uae": "AE", "dubai": "AE",
};

@Injectable()
export class TheirStackService {
  private readonly logger = new Logger(TheirStackService.name);
  private readonly apiKey: string;

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get<string>("THEIRSTACK_API_KEY") ?? "";
  }

  private get enabled(): boolean {
    return this.apiKey.length > 0;
  }

  async discoverHiringCompanies(icp: IcpInput): Promise<DiscoveredCompany[]> {
    if (!this.enabled) {
      this.logger.warn("TheirStack discovery skipped: no THEIRSTACK_API_KEY");
      return [];
    }

    const countryCodes = icp.targetGeos
      .map((g) => GEO_TO_COUNTRY_CODE[g.toLowerCase()] ?? g.toUpperCase().slice(0, 2))
      .filter((c) => c.length === 2);

    const body: Record<string, unknown> = {
      job_title_or: icp.targetTitles.length > 0 ? icp.targetTitles : undefined,
      posted_at_max_age_days: 30,
      limit: 100,
    };
    if (countryCodes.length > 0) body.company_country_code_or = countryCodes;
    if (icp.targetIndustries.length > 0) body.industry_or = icp.targetIndustries;
    if (icp.minEmployees) body.min_employee_count = icp.minEmployees;
    if (icp.maxEmployees) body.max_employee_count = icp.maxEmployees;

    this.logger.log("TheirStack: searching for hiring companies");

    try {
      const res = await withCircuitBreaker("theirstack", () =>
        fetchWithRetry(
          "https://api.theirstack.com/v1/jobs/search",
          {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${this.apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(20000),
          },
          { provider: "theirstack" },
        ),
      );

      if (!res.ok) {
        throw new Error(`TheirStack API error: ${res.status} ${res.statusText}`);
      }

      const data = (await res.json()) as TheirStackResponse;
      const jobs = data.data ?? [];

      this.logger.log(`TheirStack returned ${jobs.length} jobs`);

      // Group by company domain
      const companyMap = new Map<string, DiscoveredCompany>();
      for (const job of jobs) {
        const domain = (job.company_object?.domain ?? job.company_domain)
          ?.trim()
          .toLowerCase()
          .replace(/^www\./, "");
        if (!domain || !job.job_title) continue;

        const sourceUrl = job.url ?? job.source_url;
        const datedJob =
          sourceUrl && job.date_posted
            ? { title: job.job_title, url: sourceUrl, postedAt: job.date_posted }
            : null;
        const existing = companyMap.get(domain);
        if (existing) {
          existing.jobTitles.push(job.job_title);
          if (datedJob) existing.jobs.push(datedJob);
        } else {
          companyMap.set(domain, {
            domain,
            name: job.company_object?.name ?? job.company ?? domain,
            country: job.company_object?.country ?? undefined,
            industry: job.company_object?.industry ?? undefined,
            employeeRange: job.company_object?.employee_count_range ?? undefined,
            intentScore: 0,
            intentSignals: ["theirstack-active-hiring"],
            jobTitles: [job.job_title],
            jobs: datedJob ? [datedJob] : [],
            source: "theirstack",
          });
        }
      }

      // Calculate intent scores based on job volume + signals
      const results = Array.from(companyMap.values());
      for (const co of results) {
        co.intentScore = Math.min(100, co.jobTitles.length * 5 + co.intentSignals.length * 3);
      }

      this.logger.log(`TheirStack discovered ${results.length} unique companies`);
      return results;
    } catch (err) {
      this.logger.error(`TheirStack discovery failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  async getHiringManagers(companyDomain: string): Promise<DiscoveredHiringManager[]> {
    if (!this.enabled) return [];

    try {
      const res = await withCircuitBreaker("theirstack", () =>
        fetchWithRetry(
          "https://api.theirstack.com/v1/jobs/search",
          {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${this.apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              company_domain_or: [companyDomain],
              posted_at_max_age_days: 90,
              limit: 50,
            }),
            signal: AbortSignal.timeout(15000),
          },
          { provider: "theirstack" },
        ),
      );

      if (!res.ok) return [];

      const data = (await res.json()) as TheirStackResponse;
      const jobs = data.data ?? [];
      const managers: DiscoveredHiringManager[] = [];
      const seen = new Set<string>();

      for (const job of jobs) {
        for (const person of job.hiring_team ?? []) {
          const name = (person.full_name ?? person.first_name ?? "").trim();
          if (!name || seen.has(name.toLowerCase())) continue;
          seen.add(name.toLowerCase());

          const parts = name.split(/\s+/);
          if (parts.length < 2) continue;

          managers.push({
            firstName: parts[0]!,
            lastName: parts.slice(1).join(" "),
            title: person.role ?? this.inferManagerTitle(job.job_title),
            department: this.inferDepartment(job.job_title),
            companyDomain,
          });
        }
      }

      return managers;
    } catch (err) {
      this.logger.warn(`TheirStack hiring managers failed for ${companyDomain}: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  private inferManagerTitle(jobTitle: string): string {
    const lower = jobTitle.toLowerCase();
    if (lower.includes("engineer") || lower.includes("developer")) return "Engineering Manager";
    if (lower.includes("sales") || lower.includes("account")) return "Sales Manager";
    if (lower.includes("marketing") || lower.includes("growth")) return "Marketing Manager";
    if (lower.includes("product")) return "Product Manager";
    if (lower.includes("design")) return "Design Manager";
    if (lower.includes("people") || lower.includes("hr")) return "People Manager";
    return "Hiring Manager";
  }

  private inferDepartment(jobTitle: string): string {
    const lower = jobTitle.toLowerCase();
    if (lower.includes("engineer") || lower.includes("developer") || lower.includes("devops")) return "Engineering";
    if (lower.includes("sales") || lower.includes("account") || lower.includes("revenue")) return "Sales";
    if (lower.includes("marketing") || lower.includes("growth") || lower.includes("content")) return "Marketing";
    if (lower.includes("product")) return "Product";
    if (lower.includes("design")) return "Design";
    if (lower.includes("people") || lower.includes("hr") || lower.includes("talent")) return "People";
    if (lower.includes("finance") || lower.includes("accounting")) return "Finance";
    return "Other";
  }
}
