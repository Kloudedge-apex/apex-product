import { Tool, ToolContext, ToolResult } from "./tool.interface";
import { WebSearchTool } from "./web-search.tool";
import { WebScrapeTool } from "./web-scrape.tool";
import { assertUrlIsPublicHttp } from "../util/ssrf-guard";

interface SearchItem {
  title?: string;
  url?: string;
  snippet?: string;
  content?: string;
  date?: string;
}

interface SearchData {
  results?: SearchItem[];
  answer?: string;
}

interface WebsiteContent {
  title: string;
  content: string;
  links: string[];
}

export class CompanyResearchTool implements Tool {
  name = "company_research";
  description =
    "Research a company using live web search and public website data. Returns a structured profile only when at least one attributable live source succeeds; otherwise returns an explicit failure.";
  parameters = {
    company_name: { type: "string", description: "Name of the company to research", required: true },
    domain: { type: "string", description: "Company website domain (e.g. acme.com)", required: false },
  };

  private searchTool = new WebSearchTool();
  private scrapeTool = new WebScrapeTool();

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const companyName = params.company_name as string;
    const domain = params.domain as string | undefined;

    if (!companyName) {
      return { success: false, data: null, error: "company_name is required" };
    }

    try {
      const [searchResult, newsResult] = await Promise.all([
        this.searchTool.execute(
          { query: `${companyName} company overview industry size funding`, max_results: 5 },
          context,
        ),
        this.searchTool.execute(
          { query: `${companyName} latest news`, max_results: 3, vertical: "news" },
          context,
        ),
      ]);

      let websiteContent: WebsiteContent | null = null;
      let websiteError: string | null = null;

      // Scrape company website if domain is provided
      if (domain) {
        const scrapeUrl = domain.startsWith("http") ? domain : `https://${domain}`;
        try {
          await assertUrlIsPublicHttp(scrapeUrl);
          const scrapeResult = await this.scrapeTool.execute({ url: scrapeUrl }, context);
          if (scrapeResult.success) {
            websiteContent = scrapeResult.data as WebsiteContent;
          } else {
            websiteError = scrapeResult.error || "company website retrieval failed";
          }
        } catch (error) {
          websiteError = error instanceof Error ? error.message : String(error);
        }
      }

      const searchData = searchResult.success ? (searchResult.data as SearchData) : null;
      const newsData = newsResult.success ? (newsResult.data as SearchData) : null;

      if (!this.hasLiveEvidence(searchData, websiteContent, newsData)) {
        const reasons = [searchResult.error, newsResult.error, websiteError].filter(
          (value): value is string => Boolean(value),
        );
        return {
          success: false,
          data: null,
          error:
            reasons.length > 0
              ? `Company research could not retrieve live evidence: ${reasons.join("; ")}`
              : "Company research returned no attributable live evidence.",
        };
      }

      const profile = this.buildProfile(companyName, domain, searchData, websiteContent, newsData);

      return { success: true, data: profile };
    } catch (error) {
      return {
        success: false,
        data: null,
        error: `Company research failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private hasLiveEvidence(
    searchData: SearchData | null,
    websiteContent: WebsiteContent | null,
    newsData: SearchData | null,
  ): boolean {
    const hasSearch = Boolean(
      searchData?.results?.some((item) => item.url?.trim()),
    );
    const hasWebsite = Boolean(
      websiteContent?.title?.trim() || websiteContent?.content?.trim(),
    );
    const hasNews = Boolean(newsData?.results?.some((item) => item.url?.trim()));
    return hasSearch || hasWebsite || hasNews;
  }

  private buildProfile(
    companyName: string,
    domain: string | undefined,
    searchData: SearchData | null,
    websiteContent: WebsiteContent | null,
    newsData: SearchData | null,
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
    let industry = "Unknown";
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

    const sources = [
      ...(searchData?.results || []).map((item) => ({
        type: "search",
        title: item.title || "Search result",
        url: item.url || "",
      })),
      ...(newsData?.results || []).map((item) => ({
        type: "news",
        title: item.title || "News result",
        url: item.url || "",
      })),
      ...(websiteContent && domain
        ? [
            {
              type: "website",
              title: websiteContent.title || `${companyName} website`,
              url: domain.startsWith("http") ? domain : `https://${domain}`,
            },
          ]
        : []),
    ].filter((source) => source.url.length > 0);

    return {
      name: companyName,
      domain: domain || "unknown",
      industry,
      size,
      description:
        searchData?.answer ||
        searchData?.results?.find((item) => item.snippet || item.content)?.snippet ||
        searchData?.results?.find((item) => item.content)?.content ||
        websiteContent?.content?.slice(0, 500) ||
        null,
      recent_news:
        newsData?.results?.filter((item) => item.url?.trim()).map((item) => ({
          title: item.title || "Untitled result",
          url: item.url || "",
          snippet: item.snippet || item.content || "",
          date: item.date,
        })) || [],
      key_people: [],
      website_summary: websiteContent?.content?.slice(0, 300) || null,
      sources,
    };
  }
}
