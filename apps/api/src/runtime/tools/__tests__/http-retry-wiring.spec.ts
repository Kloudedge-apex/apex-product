/**
 * Wiring tests for runtime tool external calls — confirms each tool routes
 * its `fetch` through the shared retry utility. Logic-level retry behavior
 * lives in `common/__tests__/http-retry.util.spec.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { circuitBreakerRegistry } from "../../../common/http-retry.util";
import type { ToolContext, IntegrationCredentials } from "../tool.interface";

// Bypass the SSRF guard's DNS check for these retry-wiring tests. The guard's
// real-world behavior is exercised by its own spec (ssrf-guard.spec.ts) — here
// we only care that `fetchWithRetry` is wired through the tool surface, not
// that fake test hostnames resolve to public IPs.
vi.mock("../../util/ssrf-guard", async () => {
  const actual = await vi.importActual<typeof import("../../util/ssrf-guard")>("../../util/ssrf-guard");
  return {
    ...actual,
    ssrfGuardedFetch: (input: string | URL, init: RequestInit, opts: { fetcher?: (u: URL, i: RequestInit) => Promise<Response> } = {}) => {
      const url = typeof input === "string" ? new URL(input) : input;
      const fetcher = opts.fetcher ?? ((u: URL, i: RequestInit) => fetch(u, i));
      return fetcher(url, init);
    },
    assertUrlIsPublicHttp: async (input: string | URL) => (typeof input === "string" ? new URL(input) : input),
  };
});

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_TAVILY = process.env.TAVILY_API_KEY;

function mockResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function buildContext(
  integrations: Map<string, IntegrationCredentials> = new Map(),
): ToolContext {
  return {
    orgId: "org_test",
    agentId: "agent_test",
    runId: "run_test",
    integrations,
  };
}

beforeEach(() => {
  circuitBreakerRegistry._resetForTests();
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

describe("WebSearchTool — retry wiring", () => {
  it("retries on 429 from Tavily", async () => {
    process.env.TAVILY_API_KEY = "tavily-test";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockResponse(429, {}))
      .mockResolvedValueOnce(mockResponse(200, { results: [], answer: "" }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { WebSearchTool } = await import("../web-search.tool");
    const tool = new WebSearchTool();
    const result = await tool.execute({ query: "test" }, buildContext());

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("tavily.com");
  });
});

describe("WebScrapeTool — retry wiring", () => {
  it("retries on 503 from target URL", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockResponse(503, {}))
      .mockResolvedValueOnce(
        new Response("<html><title>OK</title><body>hello</body></html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
      );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { WebScrapeTool } = await import("../web-scrape.tool");
    const tool = new WebScrapeTool();
    const result = await tool.execute({ url: "https://example.test/" }, buildContext());

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("HubSpotTool — retry wiring", () => {
  it("retries on 429 from HubSpot create_contact", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockResponse(429, {}))
      .mockResolvedValueOnce(mockResponse(200, { id: "contact_123" }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const integrations = new Map<string, IntegrationCredentials>([
      ["hubspot", { provider: "hubspot", accessToken: "real_token" }],
    ]);

    const { HubSpotTool } = await import("../hubspot.tool");
    const tool = new HubSpotTool();
    const result = await tool.execute(
      { action: "create_contact", data: { email: "a@b.com" } },
      buildContext(integrations),
    );

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("hubapi.com");
  });
});

describe("SendEmailTool — retry wiring", () => {
  it("retries on 429 from Gmail", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockResponse(429, {}))
      .mockResolvedValueOnce(mockResponse(200, { id: "msg_123" }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const integrations = new Map<string, IntegrationCredentials>([
      ["gmail", { provider: "gmail", accessToken: "real_token" }],
    ]);

    const { SendEmailTool } = await import("../send-email.tool");
    const tool = new SendEmailTool();
    const result = await tool.execute(
      { to: "a@b.com", subject: "Hi", body: "body" },
      buildContext(integrations),
    );

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("gmail.googleapis.com");
  });
});
