import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { fetchWithRetry, withCircuitBreaker } from "../../common/http-retry.util";
import { ssrfGuardedFetch } from "../../runtime/util/ssrf-guard";
import {
  isAggregatorDomain,
  isLikelyHumanName,
} from "../quality/lead-quality.validators";

interface IcpInput {
  targetTitles: string[];
  targetIndustries: string[];
  targetGeos: string[];
  minEmployees?: number | null;
  maxEmployees?: number | null;
}

interface DiscoveredCompany {
  domain: string;
  name: string;
  country?: string;
  industry?: string;
  linkedinCompanyUrl?: string;
  source: string;
}

interface DiscoveredPerson {
  firstName: string;
  lastName: string;
  title?: string;
  linkedinSlug?: string;
  linkedinUrl?: string;
  location?: string;
  companyName?: string;
}

interface SerperResult {
  title: string;
  link: string;
  snippet: string;
}

interface SerperResponse {
  organic?: SerperResult[];
}

@Injectable()
export class SerpDiscoveryService {
  private readonly logger = new Logger(SerpDiscoveryService.name);
  private readonly apiKey: string;
  private readonly MAX_QUERIES = 50;

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get<string>('SERPER_API_KEY') ?? '';
  }

  private get enabled(): boolean {
    return this.apiKey.length > 0;
  }

  // ─── Company Discovery ───────────────────────────────

  async discoverCompanies(icp: IcpInput): Promise<DiscoveredCompany[]> {
    if (!this.enabled) {
      this.logger.warn("SERP discovery skipped: no SERPER_API_KEY");
      return [];
    }

    const queries = this.generateCompanyQueries(icp);
    this.logger.log(`SERP company discovery: executing ${queries.length} queries`);

    const allResults: DiscoveredCompany[] = [];
    const seenDomains = new Set<string>();

    for (const q of queries) {
      try {
        const results = await this.executeSearch(q, 30);
        for (const r of results) {
          const parsed = this.parseCompanyResult(r, icp);
          if (parsed && !seenDomains.has(parsed.domain)) {
            seenDomains.add(parsed.domain);
            allResults.push(parsed);
          }
        }
      } catch (err) {
        this.logger.warn(`SERP query failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      await delay(300);
    }

    // Validate domains in batch
    const validated: DiscoveredCompany[] = [];
    for (const co of allResults) {
      const validDomain = await this.validateDomain(co.domain);
      if (validDomain) {
        co.domain = validDomain;
        validated.push(co);
      }
    }

    this.logger.log(`SERP discovery found ${validated.length} unique companies (after domain validation)`);
    return validated;
  }

  // ─── People Discovery ───────────────────────────────

  async discoverPeopleViaSERP(icp: IcpInput): Promise<DiscoveredPerson[]> {
    if (!this.enabled) {
      this.logger.warn("SERP people discovery skipped: no SERPER_API_KEY");
      return [];
    }

    const queries = this.generatePeopleQueries(icp);
    this.logger.log(`SERP people discovery: executing ${queries.length} queries`);

    const allPeople: DiscoveredPerson[] = [];
    const seen = new Set<string>();

    for (const q of queries) {
      try {
        const results = await this.executeSearch(q, 30);
        for (const r of results) {
          const person = this.parseLinkedInPersonResult(r);
          if (person) {
            const key = person.linkedinSlug
              ? `linkedin:${person.linkedinSlug.toLowerCase()}`
              : [person.firstName, person.lastName, person.companyName ?? "unknown-company"]
                  .map((value) => value.toLowerCase().trim())
                  .join(":");
            if (!seen.has(key)) {
              seen.add(key);
              allPeople.push(person);
            }
          }
        }
      } catch (err) {
        this.logger.warn(`SERP people query failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      await delay(300);
    }

    this.logger.log(`SERP people discovery found ${allPeople.length} unique people`);
    return allPeople;
  }

  // ─── Query Generation ───────────────────────────────

  generateDorkQueries(icp: IcpInput): string[] {
    return [
      ...this.generateCompanyQueries(icp),
      ...this.generatePeopleQueries(icp),
    ].slice(0, this.MAX_QUERIES);
  }

  private generateCompanyQueries(icp: IcpInput): string[] {
    const queries: string[] = [];
    const industries = icp.targetIndustries.length > 0 ? icp.targetIndustries : ["technology"];
    const geos = icp.targetGeos.length > 0 ? icp.targetGeos : [""];

    for (const industry of industries) {
      for (const geo of geos) {
        const geoStr = geo ? ` "${geo}"` : "";

        // LinkedIn company pages
        queries.push(`site:linkedin.com/company "${industry}"${geoStr}`);

        // Direct company websites
        queries.push(`"${industry}" "company"${geoStr} -site:linkedin.com`);

        // ATS pages (hiring signal)
        queries.push(
          `site:greenhouse.io OR site:lever.co OR site:ashbyhq.com "${industry}"${geoStr}`,
        );

        if (queries.length >= this.MAX_QUERIES) break;
      }
      if (queries.length >= this.MAX_QUERIES) break;
    }

    return queries.slice(0, this.MAX_QUERIES);
  }

  private generatePeopleQueries(icp: IcpInput): string[] {
    const queries: string[] = [];
    const titles = icp.targetTitles.length > 0 ? icp.targetTitles : [];
    const geos = icp.targetGeos.length > 0 ? icp.targetGeos : [""];
    const industries = icp.targetIndustries.length > 0 ? icp.targetIndustries : [''];

    for (const title of titles) {
      for (const geo of geos) {
        for (const industry of industries) {
          const geoStr = geo ? ` "${geo}"` : '';
          queries.push(`site:linkedin.com/in "${title}" "${industry}"${geoStr}`);
          if (queries.length >= this.MAX_QUERIES) break;
        }
        if (queries.length >= this.MAX_QUERIES) break;
      }
      if (queries.length >= this.MAX_QUERIES) break;
    }

    return queries.slice(0, this.MAX_QUERIES);
  }

  // ─── API Execution ──────────────────────────────────

  private async executeSearch(query: string, num: number): Promise<SerperResult[]> {
    const res = await withCircuitBreaker("serper", () =>
      fetchWithRetry(
        "https://google.serper.dev/search",
        {
          method: "POST",
          headers: {
            "X-API-KEY": this.apiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ q: query, num: Math.min(num, 10) }),
          signal: AbortSignal.timeout(15000),
        },
        { provider: "serper" },
      ),
    );

    if (!res.ok) {
      throw new Error(`Serper API error: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as SerperResponse;
    return data.organic ?? [];
  }

  // ─── Result Parsing ─────────────────────────────────

  private parseCompanyResult(result: SerperResult, icp: IcpInput): DiscoveredCompany | null {
    // The `icp` param is intentionally unused now — we no longer mechanically
    // stamp `icp.targetIndustries[0]` / `icp.targetGeos[0]` onto every row.
    // The destination Company schema accepts null industry/country and a real
    // classifier (or downstream enrichment) fills those in later. See TODO
    // at the bottom of this method.
    void icp;

    const link = result.link;
    let domain: string;
    let name: string;
    let linkedinCompanyUrl: string | undefined;

    // LinkedIn company page
    const linkedinMatch = link.match(/linkedin\.com\/company\/([^/?]+)/);
    if (linkedinMatch) {
      linkedinCompanyUrl = link;
      // Extract company name from title (pattern: "CompanyName | LinkedIn")
      name = result.title.replace(/\s*[\|–-]\s*LinkedIn.*$/i, "").trim();
      // Try to extract domain from snippet
      const domainMatch = result.snippet.match(/(?:https?:\/\/)?(?:www\.)?([a-z0-9][-a-z0-9]*\.[a-z]{2,})/i);
      if (domainMatch) {
        domain = domainMatch[1]!;
      } else {
        // We used to synthesize `${slug}.com` here. That produced bogus rows
        // for every LinkedIn company hit where the snippet didn't mention a
        // domain — including SEO listing pages where the slug was a region
        // tag, not a real company. Drop the result instead; downstream
        // discovery will pick the company up via the team-page / SERP direct
        // branches if it actually exists.
        return null;
      }
    } else if (link.match(/greenhouse\.io|lever\.co|ashbyhq\.com/)) {
      // An ATS tenant slug is not a company domain. The dedicated ATS scraper
      // resolves tenant slugs against already admitted company domains.
      return null;
    } else {
      // Direct website
      try {
        const url = new URL(link);
        domain = url.hostname.replace(/^www\./, "");
        name = result.title.replace(/\s*[\|–-].*$/, "").trim();
      } catch {
        return null;
      }
    }

    // Filter out aggregator / SEO / parking / social domains. Single source
    // of truth is the shared blocklist in lead-quality.validators — keep this
    // call site dumb (a single function call) so updates propagate.
    if (isAggregatorDomain(domain)) return null;

    // Defensive cap on absurd lengths — keeps us from inserting a hostname
    // that survived URL parsing but is obviously bogus.
    if (domain.length > 253) return null;

    // TODO(deep-research follow-up): replace null industry/country with a
    // real classifier (homepage-text → industry, WHOIS/CDN/IP → country).
    // We deliberately do NOT stamp icp.targetIndustries[0] / icp.targetGeos[0]
    // onto every row anymore — that produced the "all 200 companies are B2B
    // SaaS in UAE" pathology in prod.
    return {
      domain,
      name: name || domain,
      country: undefined,
      industry: undefined,
      linkedinCompanyUrl,
      source: "serp",
    };
  }

  private async validateDomain(candidateDomain: string): Promise<string | null> {
    if (await this.probePublicDomain(candidateDomain)) {
      return candidateDomain;
    }

    // Try removing common suffixes. Every derived hostname is independently
    // admitted by the SSRF guard; a failed or blocked original probe never
    // grants authority to a fallback hostname.
    const suffixes = ['-inc', '-hq', '-io', '-co', '-app', '-labs'];
    const base = candidateDomain.replace(/\.[^.]+$/, ''); // strip TLD
    const tld = candidateDomain.slice(base.length); // e.g. '.com'
    for (const suffix of suffixes) {
      if (base.endsWith(suffix)) {
        const cleaned = base.slice(0, -suffix.length) + tld;
        if (await this.probePublicDomain(cleaned)) {
          return cleaned;
        }
      }
    }
    return null;
  }

  private async probePublicDomain(domain: string): Promise<boolean> {
    try {
      const res = await ssrfGuardedFetch(
        `https://${domain}`,
        {
          method: "HEAD",
          signal: AbortSignal.timeout(5000),
        },
        {
          maxRedirects: 5,
          fetcher: (nextUrl, init, pinnedFetch) =>
            fetchWithRetry(nextUrl, init, {
              provider: "serp-domain-validation",
              maxAttempts: 2,
              fetchImpl: pinnedFetch,
            }),
        },
      );
      return res.ok;
    } catch {
      return false;
    }
  }

  private parseLinkedInPersonResult(result: SerperResult): DiscoveredPerson | null {
    const link = result.link;
    const slugMatch = link.match(/linkedin\.com\/in\/([^/?]+)/);
    if (!slugMatch) return null;

    const linkedinSlug = slugMatch[1]!;

    // Title pattern: "FirstName LastName - Headline | LinkedIn"
    const titleMatch = result.title.match(/^(.+?)\s*[-–]\s*(.+?)(?:\s*\|\s*LinkedIn)?$/);
    if (!titleMatch) return null;

    const fullName = titleMatch[1]!.trim();
    const headline = titleMatch[2]!.trim();

    const nameParts = fullName.split(/\s+/);
    if (nameParts.length < 2) return null;

    const firstName = nameParts[0]!;
    const lastName = nameParts.slice(1).join(" ");

    // Drop SERP titles whose "name half" is actually a region tag, FAQ
    // header, or other directory-listing noise. Without this filter we saw
    // rows like firstName="Saudi" lastName="Arabia" from LinkedIn region
    // pages and firstName="Frequently" lastName="Asked Questions" from
    // SEO listing snippets that happened to contain a /in/ link.
    if (!isLikelyHumanName({ firstName, lastName })) {
      this.logger.warn(
        `[lead-quality] Skipping LinkedIn SERP hit with non-human name: ${firstName} ${lastName}`,
      );
      return null;
    }

    // Extract location from snippet
    const locMatch = result.snippet.match(/(?:Location|Based in|Located in)[:\s]+([^.·]+)/i);
    const location = locMatch ? locMatch[1]!.trim() : undefined;

    // Extract company from snippet or headline
    const companyMatch = headline.match(/(?:at|@)\s+(.+?)(?:\s*\||\s*$)/i);
    const companyName = companyMatch ? companyMatch[1]!.trim() : undefined;

    return {
      firstName,
      lastName,
      title: headline,
      linkedinSlug,
      linkedinUrl: `https://www.linkedin.com/in/${linkedinSlug}`,
      location,
      companyName,
    };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
