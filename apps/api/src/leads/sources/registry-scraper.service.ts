import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

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
    _icp: { targetIndustries: string[]; targetGeos: string[] },
  ): Promise<DiscoveredCompany[]> {
    // Registry-based company discovery requires specific search terms
    // This is typically used as an enrichment source, not primary discovery
    this.logger.log("Registry company discovery: stub (requires specific company names)");
    return [];
  }

  /** Fetch officers from UK Companies House by company number */
  async getCompaniesHouseOfficers(companyNumber: string): Promise<Array<{ firstName: string; lastName: string; title: string }>> {
    if (!this.companiesHouseKey) {
      this.logger.debug("Companies House API key not configured, skipping");
      return [];
    }

    try {
      const res = await fetch(
        `https://api.company-information.service.gov.uk/company/${companyNumber}/officers`,
        {
          headers: {
            Authorization: `Basic ${Buffer.from(this.companiesHouseKey + ":").toString("base64")}`,
          },
          signal: AbortSignal.timeout(10000),
        },
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
    try {
      // EDGAR full-text search
      const res = await fetch(
        `https://efts.sec.gov/LATEST/search-index?q=%22${encodeURIComponent(companyName)}%22&dateRange=custom&startdt=2023-01-01&forms=10-K,10-Q,DEF%2014A`,
        {
          headers: {
            "User-Agent": "WorkforceOS lead-engine support@workforceos.com",
            Accept: "application/json",
          },
          signal: AbortSignal.timeout(10000),
        },
      );

      if (!res.ok) {
        // Try the simpler EDGAR company search
        return this.searchEdgarCompanyApi(companyName);
      }

      // Parse filing results for officer names
      // This is a simplified extraction; real implementation would parse XBRL
      return [];
    } catch {
      return this.searchEdgarCompanyApi(companyName);
    }
  }

  private async searchEdgarCompanyApi(companyName: string): Promise<Array<{ firstName: string; lastName: string; title: string }>> {
    try {
      const res = await fetch(
        `https://efts.sec.gov/LATEST/search-index?q=%22${encodeURIComponent(companyName)}%22&forms=DEF+14A`,
        {
          headers: {
            "User-Agent": "WorkforceOS lead-engine support@workforceos.com",
            Accept: "application/json",
          },
          signal: AbortSignal.timeout(10000),
        },
      );

      if (!res.ok) return [];

      // EDGAR returns filing references; actual person extraction requires
      // downloading and parsing the filing documents (10-K, DEF 14A, etc.)
      this.logger.debug(`EDGAR search for "${companyName}" returned ${res.status}`);
      return [];
    } catch {
      return [];
    }
  }

  /** Search OpenCorporates for basic company info */
  async searchOpenCorporates(companyName: string): Promise<DiscoveredCompany[]> {
    try {
      const res = await fetch(
        `https://api.opencorporates.com/v0.4/companies/search?q=${encodeURIComponent(companyName)}&per_page=5`,
        {
          headers: { "User-Agent": "WorkforceOS/1.0" },
          signal: AbortSignal.timeout(10000),
        },
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
