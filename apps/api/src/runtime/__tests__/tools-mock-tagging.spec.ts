import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { WebSearchTool } from "../tools/web-search.tool";
import { WebScrapeTool } from "../tools/web-scrape.tool";
import { CompanyResearchTool } from "../tools/company-research.tool";
import { MOCK_DISCLAIMER_SUFFIX } from "../tools/mock-metadata";
import type { ToolContext } from "../tools/tool.interface";

const ctx: ToolContext = {
  orgId: "org_test",
  agentId: "agent_test",
  runId: "run_test",
  integrations: new Map(),
};

describe("tool mock-data tagging", () => {
  let originalTavilyKey: string | undefined;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalTavilyKey = process.env.TAVILY_API_KEY;
    delete process.env.TAVILY_API_KEY;
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    if (originalTavilyKey === undefined) delete process.env.TAVILY_API_KEY;
    else process.env.TAVILY_API_KEY = originalTavilyKey;
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe("WebSearchTool", () => {
    it("includes mock disclaimer in LLM-facing description", () => {
      const tool = new WebSearchTool();
      expect(tool.description).toContain(MOCK_DISCLAIMER_SUFFIX.trim());
    });

    it("tags wrapper and every result item with source=mock when TAVILY_API_KEY is unset", async () => {
      const tool = new WebSearchTool();
      const result = await tool.execute({ query: "acme", max_results: 3 }, ctx);

      expect(result.success).toBe(true);
      const data = result.data as {
        source: string;
        confidence: number;
        reason: string;
        results: Array<{ source: string; confidence: number; reason: string }>;
      };

      expect(data.source).toBe("mock");
      expect(data.confidence).toBe(0);
      expect(data.reason).toMatch(/TAVILY_API_KEY/);

      expect(data.results.length).toBe(3);
      for (const item of data.results) {
        expect(item.source).toBe("mock");
        expect(item.confidence).toBe(0);
        expect(typeof item.reason).toBe("string");
      }
    });

    // Longer timeout: WebSearchTool now routes Tavily through fetchWithRetry,
    // which exponentially backs off across 5 attempts on persistent network
    // errors (~7.5s worst-case before the final give-up).
    it("tags mock data with provider-failure reason when Tavily call throws", async () => {
      process.env.TAVILY_API_KEY = "test-key";
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("network down")) as unknown as typeof fetch;

      const tool = new WebSearchTool();
      const result = await tool.execute({ query: "acme" }, ctx);

      const data = result.data as { source: string; reason: string };
      expect(data.source).toBe("mock");
      expect(data.reason).toMatch(/Tavily provider failed/);
      expect(data.reason).toMatch(/network down/);
    }, 15000);
  });

  describe("WebScrapeTool", () => {
    it("includes mock disclaimer in LLM-facing description", () => {
      const tool = new WebScrapeTool();
      expect(tool.description).toContain(MOCK_DISCLAIMER_SUFFIX.trim());
    });

    // Longer timeout: WebScrapeTool routes through fetchWithRetry (3 attempts
    // for arbitrary URLs), which takes ~1.5s of real backoff on persistent
    // network errors. Give CI breathing room.
    it("tags mock data when underlying fetch fails", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("DNS failure")) as unknown as typeof fetch;

      const tool = new WebScrapeTool();
      const result = await tool.execute({ url: "https://nonexistent.invalid/" }, ctx);

      expect(result.success).toBe(true);
      const data = result.data as { source: string; confidence: number; reason: string; title: string };
      expect(data.source).toBe("mock");
      expect(data.confidence).toBe(0);
      expect(data.reason).toMatch(/Scrape fetch failed/);
      expect(data.reason).toMatch(/DNS failure/);
      expect(typeof data.title).toBe("string");
    }, 10000);
  });

  describe("CompanyResearchTool", () => {
    it("includes mock disclaimer in LLM-facing description", () => {
      const tool = new CompanyResearchTool();
      expect(tool.description).toContain(MOCK_DISCLAIMER_SUFFIX.trim());
    });

    it("returns search-derived data with inline mock flags when no providers are configured", async () => {
      const tool = new CompanyResearchTool();
      const result = await tool.execute({ company_name: "Acme Co" }, ctx);

      expect(result.success).toBe(true);
      // The aggregation path succeeds — but it draws from WebSearchTool, which
      // returns mock-flagged results. The aggregated profile's `recent_news`
      // therefore inherits per-item `source: "mock"` from the search tool.
      const data = result.data as {
        recent_news: Array<{ source?: string; confidence?: number; reason?: string }>;
      };
      expect(Array.isArray(data.recent_news)).toBe(true);
      // News items propagated from web_search mock are inline-tagged.
      for (const item of data.recent_news) {
        expect(item.source).toBe("mock");
        expect(item.confidence).toBe(0);
      }
    });

    it("returns fully-tagged mock profile when aggregation throws", async () => {
      const tool = new CompanyResearchTool();
      // Force the internal search tool to throw.
      const searchTool = (tool as unknown as { searchTool: { execute: () => Promise<unknown> } }).searchTool;
      vi.spyOn(searchTool, "execute").mockRejectedValue(new Error("boom"));

      const result = await tool.execute({ company_name: "Acme Co", domain: "acme.com" }, ctx);

      expect(result.success).toBe(true);
      const data = result.data as {
        source: string;
        confidence: number;
        reason: string;
        recent_news: Array<{ source: string; confidence: number; reason: string }>;
        key_people: Array<{ source: string; confidence: number; reason: string }>;
      };

      expect(data.source).toBe("mock");
      expect(data.confidence).toBe(0);
      expect(data.reason).toMatch(/company_research aggregation failed/);
      expect(data.reason).toMatch(/boom/);

      for (const news of data.recent_news) {
        expect(news.source).toBe("mock");
        expect(news.confidence).toBe(0);
      }
      for (const person of data.key_people) {
        expect(person.source).toBe("mock");
        expect(person.confidence).toBe(0);
      }
    });
  });
});
