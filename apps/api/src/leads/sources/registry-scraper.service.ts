import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { fetchWithRetry, withCircuitBreaker } from "../../common/http-retry.util";

interface DiscoveredCompany {
  domain: string;
  name: string;
  industry?: string;
  country?: string;
  registryId?: string;
  registrySource?: string;
}

interface CompaniesHouseOfficer {
  name?: string;
  officer_role?: string;
  appointed_on?: string;
  resigned_on?: string;
}

interface EdgarFiling {
  company_name?: string;
  entity_name?: string;
}

interface EdgarPerson {
  name?: string;
  title?: string;
}

@Injectable()
export class RegistryScraper {
  private readonly logger = new Logger(RegistryScraper.name);
  private readonly companiesHouseKey: string | undefined;

  constructor(private readonly config: ConfigService) {
    this.companiesHouseKey = this.config.get<string>("COMPANIES_HOUSE_API_KEY");
  }

  async discoverCompanies(
    icp: { targetIndustries: string[]; targetGeos: string[] },
  ): Promise<DiscoveredCompany[]> {
    const results: DiscoveredCompany[] = [];

    // Search EDGAR for companies in target industries
    for (const industry of icp.targetIndustries.slice(0, 5)) {
      try {
        const edgarResults = await this.searchEdgarCompanies(industry);
        results.push(...edgarResults);
      } catch (err) {
        this.logger.warn(`EDGAR industry search failed for "${industry}": ${err instanceof Error ? err.message : String(err)}`);
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    return results.filter(c => c.domain.length > 0);
  }

  /** Search EDGAR full-text search for companies */
  private async searchEdgarCompanies(query: string): Promise<DiscoveredCompany[]> {
    try {
      const res = await withCircuitBreaker("edgar", () =>
        fetchWithRetry(
          `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(`"${query}"`)}&forms=10-K&dateRange=custom&startdt=2024-01-01`,
          {
            headers: {
              "User-Agent": "WorkforceOS lead-engine support@workforceos.com",
              Accept: "application/json",
            },
            signal: AbortSignal.timeout(10000),
          },
          { provider: "edgar" },
        ),
      );

      if (!res.ok) return [];

      const data = await res.json() as { hits?: { hits?: Array<{ _source?: { entity_name?: string; file_num?: string } }> } };
      const hits = data.hits?.hits ?? [];
      const seen = new Set<string>();
      const results: DiscoveredCompany[] = [];

      for (const hit of hits.slice(0, 20)) {
        const name = hit._source?.entity_name;
        if (!name || seen.has(name.toLowerCase())) continue;
        seen.add(name.toLowerCase());

        results.push({
          domain: "",
          name,
          registryId: hit._source?.file_num,
          registrySource: "edgar",
        });
      }

      return results;
    } catch {
      return [];
    }
  }

  /** Fetch officers from UK Companies House by company number */
  async getCompaniesHouseOfficers(companyNumber: string): Promise<Array<{ firstName: string; lastName: string; title: string }>> {
    if (!this.companiesHouseKey) {
      this.logger.debug("Companies House API key not configured, skipping");
      return [];
    }

    try {
      const res = await withCircuitBreaker("companies-house", () =>
        fetchWithRetry(
          `https://api.company-information.service.gov.uk/company/${companyNumber}/officers`,
          {
            headers: {
              Authorization: `Basic ${Buffer.from(this.companiesHouseKey + ":").toString("base64")}`,
            },
            signal: AbortSignal.timeout(10000),
          },
          { provider: "companies-house" },
        ),
      );

      if (!res.ok) return [];

      const data = await res.json() as { items?: CompaniesHouseOfficer[] };
      const officers = data.items ?? [];

      return officers
        .filter((o) => !o.resigned_on) // only active officers
        .map((o) => {
          const name = o.name ?? "";
          // Companies House format: "LASTNAME, Firstname Middlename"
          const parts = name.split(",").map((s) => s.trim());
          const lastName = this.titleCase(parts[0] ?? "");
          const firstNames = (parts[1] ?? "").split(/\s+/);
          const firstName = firstNames[0] ?? "";

          return {
            firstName,
            lastName,
            title: o.officer_role ?? "Director",
          };
        })
        .filter((o) => o.firstName.length > 0 && o.lastName.length > 0);
    } catch (err) {
      this.logger.warn(`Companies House fetch failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /** Search SEC EDGAR for company filings and extract officer names */
  async searchEdgar(companyName: string): Promise<Array<{ firstName: string; lastName: string; title: string }>> {
    // First, find the CIK for this company
    const cik = await this.findEdgarCik(companyName);
    if (!cik) return [];

    // Fetch company submissions which include officer info
    try {
      const paddedCik = cik.padStart(10, "0");
      const res = await withCircuitBreaker("edgar", () =>
        fetchWithRetry(
          `https://data.sec.gov/submissions/CIK${paddedCik}.json`,
          {
            headers: {
              "User-Agent": "WorkforceOS lead-engine support@workforceos.com",
              Accept: "application/json",
            },
            signal: AbortSignal.timeout(10000),
          },
          { provider: "edgar" },
        ),
      );

      if (!res.ok) return [];

      // TODO: data.sec.gov/submissions/CIK*.json does not include an 'officers' field.
      // Officer extraction would require parsing specific filing documents (e.g. DEF 14A proxy statements).
      // For now, we use this endpoint only for company metadata validation.
      await res.json(); // consume body
      this.logger.debug(`EDGAR submissions endpoint does not provide officer data for CIK ${cik}; returning empty`);
      return [];
    } catch (err) {
      this.logger.warn(`EDGAR submissions fetch failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /** Find a company's CIK number via EDGAR company search */
  private async findEdgarCik(companyName: string): Promise<string | null> {
    try {
      const res = await withCircuitBreaker("edgar", () =>
        fetchWithRetry(
          `https://www.sec.gov/cgi-bin/browse-edgar?company=${encodeURIComponent(companyName)}&CIK=&type=10-K&dateb=&owner=include&count=1&search_text=&action=getcompany&output=atom`,
          {
            headers: {
              "User-Agent": "WorkforceOS lead-engine support@workforceos.com",
              Accept: "application/atom+xml",
            },
            signal: AbortSignal.timeout(10000),
          },
          { provider: "edgar" },
        ),
      );

      if (!res.ok) return null;

      const text = await res.text();
      // Extract CIK from the Atom feed
      const cikMatch = text.match(/CIK=(\d+)/);
      return cikMatch?.[1] ?? null;
    } catch {
      return null;
    }
  }

  /** Search OpenCorporates for basic company info */
  async searchOpenCorporates(companyName: string): Promise<DiscoveredCompany[]> {
    try {
      const res = await withCircuitBreaker("opencorporates", () =>
        fetchWithRetry(
          `https://api.opencorporates.com/v0.4/companies/search?q=${encodeURIComponent(companyName)}&per_page=5`,
          {
            headers: { "User-Agent": "WorkforceOS/1.0" },
            signal: AbortSignal.timeout(10000),
          },
          { provider: "opencorporates" },
        ),
      );

      if (!res.ok) return [];

      const data = await res.json() as {
        results?: {
          companies?: Array<{
            company?: {
              name?: string;
              company_number?: string;
              jurisdiction_code?: string;
              registered_address?: { country?: string };
            };
          }>;
        };
      };

      const companies = data.results?.companies ?? [];
      const results: DiscoveredCompany[] = [];
      for (const c of companies) {
        const co = c.company;
        if (!co?.name) continue;
        results.push({
          domain: "",
          name: co.name,
          country: co.jurisdiction_code?.toUpperCase(),
          registryId: co.company_number,
          registrySource: "opencorporates",
        });
      }
      return results.filter((c) => c.name.length > 0);
    } catch {
      return [];
    }
  }

  private titleCase(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  }
}
