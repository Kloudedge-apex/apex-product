import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyResearchTool } from "../tools/company-research.tool";
import { HubSpotTool } from "../tools/hubspot.tool";
import { WebScrapeTool } from "../tools/web-scrape.tool";
import { WebSearchTool } from "../tools/web-search.tool";
import type { ToolContext, ToolResult } from "../tools/tool.interface";

const ctx: ToolContext = {
  orgId: "org_test",
  agentId: "agent_test",
  runId: "run_test",
  integrations: new Map(),
};

describe("live research tools fail closed", () => {
  let originalTavilyKey: string | undefined;
  let originalSerperKey: string | undefined;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalTavilyKey = process.env.TAVILY_API_KEY;
    originalSerperKey = process.env.SERPER_API_KEY;
    delete process.env.TAVILY_API_KEY;
    delete process.env.SERPER_API_KEY;
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    if (originalTavilyKey === undefined) delete process.env.TAVILY_API_KEY;
    else process.env.TAVILY_API_KEY = originalTavilyKey;
    if (originalSerperKey === undefined) delete process.env.SERPER_API_KEY;
    else process.env.SERPER_API_KEY = originalSerperKey;
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe("WebSearchTool", () => {
    it("returns an explicit failure when no live provider is configured", async () => {
      const result = await new WebSearchTool().execute(
        { query: "acme", max_results: 3 },
        ctx,
      );

      expect(result).toMatchObject({
        success: false,
        data: null,
      });
      expect(result.error).toMatch(/no live provider is configured/i);
      expect(JSON.stringify(result)).not.toContain("example.com");
      expect(JSON.stringify(result)).not.toContain('"source":"mock"');
    });

    // Longer timeout: WebSearchTool routes Tavily through fetchWithRetry,
    // which exponentially backs off across 5 attempts on persistent errors.
    it("returns an explicit failure when the live provider fails", async () => {
      process.env.TAVILY_API_KEY = "test-key";
      globalThis.fetch = vi
        .fn()
        .mockRejectedValue(new Error("network down")) as unknown as typeof fetch;

      const result = await new WebSearchTool().execute({ query: "acme" }, ctx);

      expect(result).toMatchObject({ success: false, data: null });
      expect(result.error).toMatch(/Tavily web search failed/);
      expect(result.error).toMatch(/network down/);
    }, 15000);
  });

  describe("WebScrapeTool", () => {
    // Longer timeout: WebScrapeTool routes through fetchWithRetry (3 attempts)
    // when DNS succeeds but the remote page remains unavailable.
    it("returns an explicit failure when the page cannot be retrieved", async () => {
      globalThis.fetch = vi
        .fn()
        .mockRejectedValue(new Error("DNS failure")) as unknown as typeof fetch;

      const result = await new WebScrapeTool().execute(
        { url: "https://nonexistent.invalid/" },
        ctx,
      );

      expect(result).toMatchObject({ success: false, data: null });
      expect(result.error).toMatch(/Web page retrieval failed/);
      expect(result.error).toMatch(/DNS lookup failed|DNS failure|getaddrinfo|ENOTFOUND/);
      expect(JSON.stringify(result)).not.toContain('"source":"mock"');
    }, 10000);
  });

  describe("CompanyResearchTool", () => {
    it("returns an explicit failure instead of a fixture profile", async () => {
      const result = await new CompanyResearchTool().execute(
        { company_name: "Acme Co" },
        ctx,
      );

      expect(result).toMatchObject({ success: false, data: null });
      expect(result.error).toMatch(/could not retrieve live evidence/);
      expect(JSON.stringify(result)).not.toContain("Series B");
      expect(JSON.stringify(result)).not.toContain('"source":"mock"');
    });

    it("returns an explicit failure when aggregation throws", async () => {
      const tool = new CompanyResearchTool();
      const searchTool = (
        tool as unknown as {
          searchTool: { execute: () => Promise<ToolResult> };
        }
      ).searchTool;
      vi.spyOn(searchTool, "execute").mockRejectedValue(new Error("boom"));

      const result = await tool.execute(
        { company_name: "Acme Co", domain: "acme.com" },
        ctx,
      );

      expect(result).toMatchObject({ success: false, data: null });
      expect(result.error).toMatch(/Company research failed: boom/);
    });

    it("builds a sourced partial profile when one live source succeeds", async () => {
      const tool = new CompanyResearchTool();
      const searchTool = (
        tool as unknown as {
          searchTool: { execute: () => Promise<ToolResult> };
        }
      ).searchTool;
      vi.spyOn(searchTool, "execute")
        .mockResolvedValueOnce({
          success: true,
          data: {
            results: [
              {
                title: "Acme profile",
                url: "https://directory.example/acme",
                snippet: "Acme makes verified workflow software.",
                content: "Acme makes verified workflow software for finance teams.",
              },
            ],
          },
        })
        .mockResolvedValueOnce({
          success: false,
          data: null,
          error: "news provider unavailable",
        });

      const result = await tool.execute({ company_name: "Acme Co" }, ctx);

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({
        name: "Acme Co",
        description: "Acme makes verified workflow software.",
        recent_news: [],
        sources: [
          {
            type: "search",
            title: "Acme profile",
            url: "https://directory.example/acme",
          },
        ],
      });
    });
  });

  describe("HubSpotTool", () => {
    it("fails explicitly instead of manufacturing CRM records", async () => {
      const result = await new HubSpotTool().execute(
        {
          action: "create_contact",
          data: { email: "prospect@example.test" },
        },
        ctx,
      );

      expect(result).toMatchObject({ success: false, data: null });
      expect(result.error).toMatch(/not connected with live credentials/);
      expect(JSON.stringify(result)).not.toContain('"mock":true');
      expect(JSON.stringify(result)).not.toContain("John");
      expect(JSON.stringify(result)).not.toContain("Example Corp");
    });
  });
});
