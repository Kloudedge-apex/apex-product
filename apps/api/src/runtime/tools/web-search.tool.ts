import { Tool, ToolContext, ToolResult } from "./tool.interface";
import { MOCK_DISCLAIMER_SUFFIX, markMocked, markMockedItem } from "./mock-metadata";
import { fetchWithRetry, withCircuitBreaker } from "../../common/http-retry.util";

export class WebSearchTool implements Tool {
  name = "web_search";
  description =
    "Search the web for information. Returns titles, URLs, snippets and content for the top results." +
    MOCK_DISCLAIMER_SUFFIX;
  parameters = {
    query: { type: "string", description: "The search query", required: true },
    max_results: { type: "number", description: "Maximum number of results to return (default 5)", required: false },
  };

  async execute(params: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
    const query = params.query as string;
    const maxResults = (params.max_results as number) || 5;

    if (!query) {
      return { success: false, data: null, error: "Query is required" };
    }

    const tavilyKey = process.env.TAVILY_API_KEY;
    if (tavilyKey) {
      return this.searchWithTavily(query, maxResults, tavilyKey);
    }

    // Fall back to Serper, which prod already has a key for. Without this, prod
    // (Tavily-less) would always mock the live trigger → the Evidence-Engine
    // grounding signal never lands and every lead refuses.
    const serperKey = process.env.SERPER_API_KEY;
    if (serperKey) {
      return this.searchWithSerper(query, maxResults, serperKey);
    }

    return this.mockSearch(query, maxResults, "no web_search provider configured (TAVILY_API_KEY / SERPER_API_KEY)");
  }

  private async searchWithTavily(query: string, maxResults: number, apiKey: string): Promise<ToolResult> {
    try {
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
        success: true,
        data: {
          results: data.results.map((r) => ({
            title: r.title,
            url: r.url,
            snippet: r.content?.slice(0, 200),
            content: r.content,
          })),
          answer: data.answer,
        },
      };
    } catch (error) {
      const reason = `Tavily provider failed: ${error instanceof Error ? error.message : String(error)}`;
      return this.mockSearch(query, maxResults, reason);
    }
  }

  private async searchWithSerper(query: string, maxResults: number, apiKey: string): Promise<ToolResult> {
    try {
      const response = await withCircuitBreaker("serper", () =>
        fetchWithRetry(
          "https://google.serper.dev/search",
          {
            method: "POST",
            headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
            body: JSON.stringify({ q: query, num: Math.min(maxResults, 10) }),
          },
          { provider: "serper" },
        ),
      );

      if (!response.ok) {
        throw new Error(`Serper API error: ${response.status}`);
      }

      const data = (await response.json()) as {
        organic?: Array<{ title?: string; link?: string; snippet?: string }>;
      };

      // Map Serper's `organic[].link` → `url` so the result shape matches Tavily's
      // and SignalExtractionService.extractLiveTrigger consumes it unchanged. A
      // result missing a link yields url:"" and is dropped by extraction's
      // url-length guard (never cited).
      return {
        success: true,
        data: {
          results: (data.organic ?? []).map((r) => ({
            title: r.title ?? "",
            url: r.link ?? "",
            snippet: r.snippet,
            content: r.snippet,
          })),
        },
      };
    } catch (error) {
      const reason = `Serper provider failed: ${error instanceof Error ? error.message : String(error)}`;
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
