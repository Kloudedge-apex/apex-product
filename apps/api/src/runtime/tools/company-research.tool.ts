import { Tool, ToolContext, ToolResult } from "./tool.interface";
import { WebSearchTool } from "./web-search.tool";
import { WebScrapeTool } from "./web-scrape.tool";
import { MOCK_DISCLAIMER_SUFFIX, markMocked, markMockedItem } from "./mock-metadata";
import { EnrichmentLicenseScope } from "@prisma/client";
import type { EvidenceLedgerService } from "../../observability/evidence-ledger.service";
import type { EnrichmentFactService } from "../../enrichment/enrichment-fact.service";
import { withEnrichmentCache } from "../../enrichment/enrichment-cache.guard";

export class CompanyResearchTool implements Tool {
  name = "company_research";
  description =
    "Research a company by combining web search and website scraping. Returns a structured company profile including industry, size, description, recent news, and key people." +
    MOCK_DISCLAIMER_SUFFIX;
  parameters = {
    company_name: { type: "string", description: "Name of the company to research", required: true },
    domain: { type: "string", description: "Company website domain (e.g. acme.com)", required: false },
  };

  private searchTool: WebSearchTool;
  private scrapeTool: WebScrapeTool;

  constructor(
    searchTool?: WebSearchTool,
    scrapeTool?: WebScrapeTool,
    private readonly enrichmentFacts?: EnrichmentFactService,
    private readonly evidenceLedger?: EvidenceLedgerService,
  ) {
    this.searchTool = searchTool ?? new WebSearchTool();
    this.scrapeTool = scrapeTool ?? new WebScrapeTool();
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const companyName = params.company_name as string;
    const domain = params.domain as string | undefined;

    if (!companyName) {
      return { success: false, data: null, error: "company_name is required" };
    }

    const normalizedDomain = domain?.trim().toLowerCase();
    const lookupKey = `company:${companyName.trim().toLowerCase()}${normalizedDomain ? `|domain:${normalizedDomain}` : ""}`;

    if (this.enrichmentFacts) {
      try {
        const fact = await withEnrichmentCache(
          {
            enrichmentFacts: this.enrichmentFacts,
            evidenceLedger: this.evidenceLedger,
            orgId: context.orgId,
            runId: context.runId,
            provider: "company_research",
            lookupKey,
            field: "profile",
            ttlMs: 7 * 24 * 60 * 60 * 1000,
            costCredits: 1,
            licenseScope: EnrichmentLicenseScope.RESEARCH_OK,
          },
          async () => {
            const result = await this.executeUncached(companyName, domain, context);
            if (!result.success) {
              throw new Error(result.error ?? "company_research failed");
            }
            const data = result.data as unknown;
            if (data && typeof data === "object" && (data as { source?: string }).source === "mock") {
              const reason = (data as { reason?: string }).reason ?? "mock provider path";
              throw new Error(`provider_failed: ${reason}`);
            }
            return data as any;
          },
        );

        return { success: true, data: fact.value };
      } catch (error) {
        return this.executeUncached(companyName, domain, context);
      }
    }

    return this.executeUncached(companyName, domain, context);
  }

  private async executeUncached(
    companyName: string,
    domain: string | undefined,
    context: ToolContext,
  ): Promise<ToolResult> {
    try {
      // Search for company info
      const searchResult = await this.searchTool.execute(
        { query: `${companyName} company overview industry size funding`, max_results: 5 },
        context,
      );

      let websiteContent: { title: string; content: string; links: string[] } | null = null;

      // Scrape company website if domain is provided
      if (domain) {
        const scrapeUrl = domain.startsWith("http") ? domain : `https://${domain}`;
        const scrapeResult = await this.scrapeTool.execute({ url: scrapeUrl }, context);
        if (scrapeResult.success) {
          websiteContent = scrapeResult.data as { title: string; content: string; links: string[] };
        }
      }

      // Search for recent news
      const newsResult = await this.searchTool.execute(
        { query: `${companyName} latest news 2026`, max_results: 3 },
        context,
      );

      // Build company profile from gathered data
      const searchData = searchResult.data as { results: Array<{ title: string; snippet: string; content: string; source?: string; confidence?: number; reason?: string }>; answer?: string } | null;
      const newsData = newsResult.data as { results: Array<{ title: string; url: string; snippet: string; source?: string; confidence?: number; reason?: string }> } | null;

      const profile = this.buildProfile(companyName, domain, searchData, websiteContent, newsData);

      return { success: true, data: profile };
    } catch (error) {
      const reason = `company_research aggregation failed: ${error instanceof Error ? error.message : String(error)}`;
      return {
        success: true,
        data: markMocked(this.mockProfile(companyName, domain), reason),
      };
    }
  }

  private buildProfile(
    companyName: string,
    domain: string | undefined,
    searchData: { results: Array<{ title: string; snippet: string; content: string; source?: string; confidence?: number; reason?: string }>; answer?: string } | null,
    websiteContent: { title: string; content: string; links: string[] } | null,
    newsData: { results: Array<{ title: string; url: string; snippet: string; source?: string; confidence?: number; reason?: string }> } | null,
  ) {
    const allContent = [
      searchData?.answer || "",
      ...(searchData?.results?.map((r) => r.content || r.snippet) || []),
      websiteContent?.content || "",
    ].join(" ");

    // Extract industry signals
    const industryKeywords: Record<string, string[]> = {
      SaaS: ["saas", "software as a service", "cloud software", "subscription"],
      Fintech: ["fintech", "financial technology", "payments", "banking"],
      Healthcare: ["healthcare", "health tech", "medical", "pharma"],
      "E-commerce": ["ecommerce", "e-commerce", "retail", "online store"],
      AI: ["artificial intelligence", "machine learning", "ai-powered"],
      Cybersecurity: ["cybersecurity", "security", "infosec"],
      EdTech: ["edtech", "education technology", "learning platform"],
    };

    const contentLower = allContent.toLowerCase();
    let industry = "Technology";
    for (const [ind, keywords] of Object.entries(industryKeywords)) {
      if (keywords.some((kw) => contentLower.includes(kw))) {
        industry = ind;
        break;
      }
    }

    // Estimate size from content
    let size = "Unknown";
    const sizePatterns = [
      { pattern: /(\d{1,3}),?(\d{3})\+?\s*employees/i, extract: true },
      { pattern: /enterprise|large.scale|global/i, size: "1000+" },
      { pattern: /mid.size|mid.market|series\s*[bc]/i, size: "100-500" },
      { pattern: /startup|early.stage|seed|series\s*a/i, size: "10-100" },
    ];

    for (const sp of sizePatterns) {
      if ("extract" in sp) {
        const match = allContent.match(sp.pattern);
        if (match) {
          size = `${match[1]}${match[2] || ""} employees`;
          break;
        }
      } else if (sp.pattern.test(contentLower)) {
        size = sp.size;
        break;
      }
    }

    return {
      name: companyName,
      domain: domain || "unknown",
      industry,
      size,
      description: searchData?.answer || searchData?.results?.[0]?.snippet || `${companyName} is a technology company.`,
      recent_news: newsData?.results?.map((n) => {
        const base: { title: string; url: string; snippet: string; source?: string; confidence?: number; reason?: string } = {
          title: n.title,
          url: n.url,
          snippet: n.snippet,
        };
        // Preserve inline mock-tagging so downstream LLMs see fixture flags
        // even on aggregated fields.
        if (n.source === "mock") {
          base.source = "mock";
          base.confidence = 0;
          base.reason = n.reason || "propagated from web_search mock";
        }
        return base;
      }) || [],
      key_people: [],
      website_summary: websiteContent?.content?.slice(0, 300) || null,
    };
  }

  private mockProfile(companyName: string, domain?: string) {
    const reason = "fixture profile";
    return {
      name: companyName,
      domain: domain || `${companyName.toLowerCase().replace(/\s+/g, "")}.com`,
      industry: "SaaS",
      size: "100-500",
      description: `${companyName} is a growing technology company specializing in innovative SaaS solutions for enterprise clients. The company has been rapidly scaling its operations and recently secured significant funding to expand its product offerings.`,
      recent_news: [
        markMockedItem(
          { title: `${companyName} Raises Series B Funding`, url: "#", snippet: `${companyName} announced a $45M Series B round led by top-tier VCs.` },
          reason,
        ),
        markMockedItem(
          { title: `${companyName} Launches AI-Powered Features`, url: "#", snippet: `The company unveiled new AI capabilities in its flagship product.` },
          reason,
        ),
      ],
      key_people: [
        markMockedItem({ name: "CEO", role: "Chief Executive Officer" }, reason),
        markMockedItem({ name: "CTO", role: "Chief Technology Officer" }, reason),
      ],
      website_summary: `${companyName} provides enterprise-grade solutions that help teams work more efficiently. Their platform integrates with major business tools and offers advanced analytics capabilities.`,
    };
  }
}
