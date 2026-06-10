/**
 * Provider-selection + response-mapping tests for WebSearchTool. The retry/SSRF
 * layer is mocked out (it has its own coverage in http-retry-wiring.spec.ts);
 * here we prove: Tavily wins when its key is set, Serper is the fallback when
 * prod has only SERPER_API_KEY, neither key → mock (refusal-safe), and a Serper
 * failure degrades to mock rather than fabricating a real result.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { isMocked } from "../mock-metadata";
import type { ToolContext } from "../tool.interface";

// fetchWithRetry delegates to the per-test globalThis.fetch; withCircuitBreaker
// just runs the fn — so these tests exercise only the tool's own branching/mapping.
vi.mock("../../../common/http-retry.util", () => ({
  fetchWithRetry: (input: unknown, init: unknown) =>
    (globalThis.fetch as (i: unknown, n: unknown) => Promise<Response>)(input, init),
  withCircuitBreaker: (_name: string, fn: () => Promise<Response>) => fn(),
}));

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_TAVILY = process.env.TAVILY_API_KEY;
const ORIGINAL_SERPER = process.env.SERPER_API_KEY;

function mockResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

const ctx: ToolContext = { orgId: "o", agentId: "a", runId: "r", integrations: new Map() };

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  restoreEnv("TAVILY_API_KEY", ORIGINAL_TAVILY);
  restoreEnv("SERPER_API_KEY", ORIGINAL_SERPER);
  vi.restoreAllMocks();
});

describe("WebSearchTool provider selection", () => {
  it("uses Tavily when TAVILY_API_KEY is set (Serper key ignored)", async () => {
    process.env.TAVILY_API_KEY = "tav";
    process.env.SERPER_API_KEY = "serp";
    const fetchMock = vi
      .fn()
      .mockResolvedValue(mockResponse(200, { results: [{ title: "T", url: "https://t/1", content: "c" }], answer: "a" }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { WebSearchTool } = await import("../web-search.tool");
    const r = await new WebSearchTool().execute({ query: "Acme" }, ctx);

    expect(r.success).toBe(true);
    expect(isMocked(r.data)).toBe(false);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("tavily.com");
    expect((r.data as { results: Array<{ url: string }> }).results[0].url).toBe("https://t/1");
  });

  it("falls back to Serper when TAVILY absent but SERPER_API_KEY is set, mapping link→url", async () => {
    delete process.env.TAVILY_API_KEY;
    process.env.SERPER_API_KEY = "serp";
    const fetchMock = vi.fn().mockResolvedValue(
      mockResponse(200, { organic: [{ title: "Lumen raises $20M", link: "https://news.example.com/x", snippet: "..." }] }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { WebSearchTool } = await import("../web-search.tool");
    const r = await new WebSearchTool().execute({ query: "Lumen", max_results: 3 }, ctx);

    expect(r.success).toBe(true);
    expect(isMocked(r.data)).toBe(false);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("google.serper.dev");
    // organic[].link mapped to results[].url → SignalExtractionService consumes it unchanged.
    expect((r.data as { results: Array<Record<string, unknown>> }).results[0]).toMatchObject({
      title: "Lumen raises $20M",
      url: "https://news.example.com/x",
      snippet: "...",
    });
  });

  it("returns mock (refusal-safe) when neither provider key is configured", async () => {
    delete process.env.TAVILY_API_KEY;
    delete process.env.SERPER_API_KEY;

    const { WebSearchTool } = await import("../web-search.tool");
    const r = await new WebSearchTool().execute({ query: "Acme" }, ctx);

    expect(r.success).toBe(true);
    // mock data → extractLiveTrigger writes no signal → the lead refuses (never fabricates).
    expect(isMocked(r.data)).toBe(true);
  });

  it("degrades to mock when Serper errors (never fabricates a real signal)", async () => {
    delete process.env.TAVILY_API_KEY;
    process.env.SERPER_API_KEY = "serp";
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse(500, {})) as unknown as typeof fetch;

    const { WebSearchTool } = await import("../web-search.tool");
    const r = await new WebSearchTool().execute({ query: "Acme" }, ctx);

    expect(r.success).toBe(true);
    expect(isMocked(r.data)).toBe(true);
  });
});
