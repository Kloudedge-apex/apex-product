import { Tool, ToolContext, ToolResult } from "./tool.interface";
import { MOCK_DISCLAIMER_SUFFIX, markMocked, markMockedItem } from "./mock-metadata";
import { fetchWithRetry, withCircuitBreaker } from "../../common/http-retry.util";
import { EnrichmentLicenseScope, type Prisma } from "@prisma/client";
import type { EvidenceLedgerService } from "../../observability/evidence-ledger.service";
import type { EnrichmentFactService } from "../../enrichment/enrichment-fact.service";
import { withEnrichmentCache } from "../../enrichment/enrichment-cache.guard";

export class WebSearchTool implements Tool {
  name = "web_search";
  description =
    "Search the web for information. Returns titles, URLs, snippets and content for the top results." +
    MOCK_DISCLAIMER_SUFFIX;
  parameters = {
    query: { type: "string", description: "The search query", required: true },
    max_results: { type: "number", description: "Maximum number of results to return (default 5)", required: false },
  };

  constructor(
    private readonly enrichmentFacts?: EnrichmentFactService,
    private readonly evidenceLedger?: EvidenceLedgerService,
  ) {}

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const query = params.query as string;
    const maxResults = (params.max_results as number) || 5;

    if (!query) {
      return { success: false, data: null, error: "Query is required" };
    }

    const tavilyKey = process.env.TAVILY_API_KEY;

    if (tavilyKey) {
      if (this.enrichmentFacts) {
        try {
          const fact = await withEnrichmentCache(
            {
              enrichmentFacts: this.enrichmentFacts,
              evidenceLedger: this.evidenceLedger,
              orgId: context.orgId,
              runId: context.runId,
              provider: "tavily",
              lookupKey: `query:${query}`,
              field: "search",
              ttlMs: 7 * 24 * 60 * 60 * 1000,
              costCredits: 1,
              licenseScope: EnrichmentLicenseScope.INTERNAL_ONLY,
            },
            async () => this.searchWithTavilyData(query, maxResults, tavilyKey),
          );

          return { success: true, data: fact.value };
        } catch (error) {
          const reason = `Tavily provider failed: ${error instanceof Error ? error.message : String(error)}`;
          return this.mockSearch(query, maxResults, reason);
        }
      }

      return this.searchWithTavily(query, maxResults, tavilyKey);
    }

    return this.mockSearch(query, maxResults, "TAVILY_API_KEY not configured");
  }

  private async searchWithTavilyData(
    query: string,
    maxResults: number,
    apiKey: string,
  ): Promise<Prisma.InputJsonValue> {
    const response = await withCircuitBreaker("tavily", () =>
      fetchWithRetry(
        "https://api.tavily.com/search",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_key: apiKey,
            query,
            max_results: maxResults,
            include_answer: true,
          }),
        },
        { provider: "tavily" },
      ),
    );

    if (!response.ok) {
      throw new Error(`Tavily API error: ${response.status}`);
    }

    const data = (await response.json()) as {
      results: Array<{ title: string; url: string; content: string }>;
      answer?: string;
    };

    return {
      results: data.results.map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.content?.slice(0, 200),
        content: r.content,
      })),
      answer: data.answer,
    };
  }

  private async searchWithTavily(query: string, maxResults: number, apiKey: string): Promise<ToolResult> {
    try {
      const data = await this.searchWithTavilyData(query, maxResults, apiKey);
      return { success: true, data };
    } catch (error) {
      const reason = `Tavily provider failed: ${error instanceof Error ? error.message : String(error)}`;
      return this.mockSearch(query, maxResults, reason);
    }
  }

  private mockSearch(query: string, maxResults: number, reason: string): ToolResult {
    const mockResults = [
      { title: `${query} - Latest News and Insights`, url: `https://example.com/news/${encodeURIComponent(query)}`, snippet: `Comprehensive coverage of ${query}. Recent developments include significant market growth and technological advancements.`, content: `Comprehensive coverage of ${query}. Recent developments include significant market growth and technological advancements in the sector. Industry analysts predict continued expansion through 2026.` },
      { title: `${query} Company Profile & Overview`, url: `https://example.com/company/${encodeURIComponent(query)}`, snippet: `${query} is a leading organization in its sector, known for innovation and growth.`, content: `${query} is a leading organization in its sector, known for innovation and rapid growth. Founded with a mission to transform the industry, the company has expanded to serve clients globally.` },
      { title: `${query} Industry Analysis 2026`, url: `https://example.com/analysis/${encodeURIComponent(query)}`, snippet: `Market analysis for ${query} shows positive trends with projected growth of 25% YoY.`, content: `Market analysis for ${query} shows positive trends with projected year-over-year growth of 25%. Key drivers include digital transformation and increased enterprise adoption.` },
      { title: `Working at ${query} - Reviews & Culture`, url: `https://example.com/reviews/${encodeURIComponent(query)}`, snippet: `Employee reviews highlight strong culture, competitive compensation, and growth opportunities at ${query}.`, content: `Employee reviews highlight strong company culture, competitive compensation packages, and significant growth opportunities. The leadership team is noted for transparency and innovation focus.` },
      { title: `${query} - Recent Funding & Investors`, url: `https://example.com/funding/${encodeURIComponent(query)}`, snippet: `${query} recently closed a significant funding round, attracting top-tier investors.`, content: `${query} recently completed a Series B funding round of $45M, led by prominent venture capital firms. The funding will accelerate product development and market expansion.` },
    ];

    const taggedResults = mockResults.slice(0, maxResults).map((r) => markMockedItem(r, reason));

    return {
      success: true,
      data: markMocked(
        {
          results: taggedResults,
          answer: `Based on search results, ${query} appears to be an active and growing entity in its sector with recent positive developments.`,
        },
        reason,
      ),
    };
  }
}
