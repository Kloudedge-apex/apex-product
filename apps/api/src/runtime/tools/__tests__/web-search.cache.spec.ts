import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../tool.interface";
import { EnrichmentLicenseScope } from "@prisma/client";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_TAVILY = process.env.TAVILY_API_KEY;

function buildContext(): ToolContext {
  return {
    orgId: "org_test",
    agentId: "agent_test",
    runId: "run_test",
    integrations: new Map(),
  };
}

function mockResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  process.env.TAVILY_API_KEY = "tavily-test";
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_TAVILY === undefined) {
    delete process.env.TAVILY_API_KEY;
  } else {
    process.env.TAVILY_API_KEY = ORIGINAL_TAVILY;
  }
  vi.restoreAllMocks();
});

describe("WebSearchTool — enrichment cache", () => {
  it("short-circuits Tavily fetch on cache hit", async () => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;

    const enrichmentFacts = {
      getCachedFact: vi.fn().mockResolvedValue({
        value: { results: [], answer: "cached" },
        fetchedAt: new Date("2026-05-29T00:00:00.000Z"),
        costUsd: null,
        licenseScope: EnrichmentLicenseScope.INTERNAL_ONLY,
      }),
      recordFact: vi.fn(),
    };

    const { WebSearchTool } = await import("../web-search.tool");
    const tool = new WebSearchTool(enrichmentFacts as any);
    const result = await tool.execute({ query: "test" }, buildContext());

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ results: [], answer: "cached" });
    expect(globalThis.fetch).toHaveBeenCalledTimes(0);
    expect(enrichmentFacts.recordFact).toHaveBeenCalledTimes(0);
  });

  it("records and returns Tavily result on cache miss", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockResponse(200, { results: [{ title: "t", url: "u", content: "c" }], answer: "a" }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const enrichmentFacts = {
      getCachedFact: vi.fn().mockResolvedValue(null),
      recordFact: vi.fn(async (args: any) => ({
        value: args.value,
        fetchedAt: new Date(),
        costUsd: null,
        licenseScope: args.licenseScope,
      })),
    };

    const { WebSearchTool } = await import("../web-search.tool");
    const tool = new WebSearchTool(enrichmentFacts as any);
    const result = await tool.execute({ query: "test", max_results: 1 }, buildContext());

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(enrichmentFacts.recordFact).toHaveBeenCalledTimes(1);
    expect(result.data).toEqual({
      results: [{ title: "t", url: "u", snippet: "c", content: "c" }],
      answer: "a",
    });
  });
});

