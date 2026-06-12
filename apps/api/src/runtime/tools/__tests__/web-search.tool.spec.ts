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
    // No vertical requested → the default organic endpoint, NOT /news.
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://google.serper.dev/search");
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

// The trigger-dating contract (audit B3): SignalExtractionService dates a live
// trigger ONLY from the result's own date field and rejects undated results
// fail-closed. These tests prove the tool actually forwards that field — the
// pre-fix mapping dropped it for both providers, so every live trigger was
// rejected and press_mention grounding never fired in prod.
describe("WebSearchTool date forwarding + news vertical", () => {
  type MappedResult = { date?: string } & Record<string, unknown>;
  const resultsOf = (r: { data: unknown }): MappedResult[] =>
    (r.data as { results: MappedResult[] }).results;

  it("forwards Serper organic[].date to results[].date; absent date stays undefined", async () => {
    delete process.env.TAVILY_API_KEY;
    process.env.SERPER_API_KEY = "serp";
    const fetchMock = vi.fn().mockResolvedValue(
      mockResponse(200, {
        organic: [
          { title: "Lumen raises $20M", link: "https://news.example.com/x", snippet: "...", date: "Jun 5, 2026" },
          { title: "Lumen profile", link: "https://dir.example.com/lumen", snippet: "..." },
        ],
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { WebSearchTool } = await import("../web-search.tool");
    const r = await new WebSearchTool().execute({ query: "Lumen", max_results: 3 }, ctx);

    expect(r.success).toBe(true);
    const results = resultsOf(r);
    expect(results[0]).toMatchObject({ url: "https://news.example.com/x", date: "Jun 5, 2026" });
    // No date on the provider result → undefined, never a fabricated stamp.
    expect(results[1].date).toBeUndefined();
  });

  it("forwards Tavily published_date to results[].date; absent date stays undefined", async () => {
    process.env.TAVILY_API_KEY = "tav";
    const fetchMock = vi.fn().mockResolvedValue(
      mockResponse(200, {
        results: [
          { title: "Lumen ships v2", url: "https://news.example.com/v2", content: "c", published_date: "2026-06-03" },
          { title: "Lumen docs", url: "https://docs.example.com/lumen", content: "c" },
        ],
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { WebSearchTool } = await import("../web-search.tool");
    const r = await new WebSearchTool().execute({ query: "Lumen" }, ctx);

    expect(r.success).toBe(true);
    const results = resultsOf(r);
    expect(results[0]).toMatchObject({ url: "https://news.example.com/v2", date: "2026-06-03" });
    expect(results[1].date).toBeUndefined();
  });

  it("vertical:'news' hits Serper's news endpoint and maps news[].date", async () => {
    delete process.env.TAVILY_API_KEY;
    process.env.SERPER_API_KEY = "serp";
    const fetchMock = vi.fn().mockResolvedValue(
      mockResponse(200, {
        news: [
          { title: "Lumen raises $20M", link: "https://news.example.com/x", snippet: "...", date: "2 days ago" },
        ],
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { WebSearchTool } = await import("../web-search.tool");
    const r = await new WebSearchTool().execute({ query: "Lumen", max_results: 3, vertical: "news" }, ctx);

    expect(r.success).toBe(true);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://google.serper.dev/news");
    expect(resultsOf(r)[0]).toMatchObject({
      title: "Lumen raises $20M",
      url: "https://news.example.com/x",
      snippet: "...",
      date: "2 days ago",
    });
  });

  it("vertical:'news' requests Tavily's news topic (the published_date-bearing vertical)", async () => {
    process.env.TAVILY_API_KEY = "tav";
    const fetchMock = vi.fn().mockResolvedValue(
      mockResponse(200, {
        results: [{ title: "Lumen ships v2", url: "https://news.example.com/v2", content: "c", published_date: "2026-06-03" }],
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { WebSearchTool } = await import("../web-search.tool");
    const r = await new WebSearchTool().execute({ query: "Lumen", vertical: "news" }, ctx);

    expect(r.success).toBe(true);
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as { body: string }).body)) as Record<string, unknown>;
    expect(body.topic).toBe("news");
    expect(resultsOf(r)[0].date).toBe("2026-06-03");
  });

  it("default vertical sends a byte-identical Tavily body (no topic key)", async () => {
    process.env.TAVILY_API_KEY = "tav";
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(200, { results: [] }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { WebSearchTool } = await import("../web-search.tool");
    await new WebSearchTool().execute({ query: "Lumen" }, ctx);

    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as { body: string }).body)) as Record<string, unknown>;
    expect("topic" in body).toBe(false);
  });
});
