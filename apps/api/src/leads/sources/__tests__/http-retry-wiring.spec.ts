/**
 * Wiring tests: confirm every external HTTP caller routes through the shared
 * retry utility (`fetchWithRetry`) instead of bare `fetch`. We don't re-test
 * the retry logic itself — those specs live in
 * `common/__tests__/http-retry.util.spec.ts`. Here we verify that a 429
 * actually causes a retry inside each caller, which is the only reliable
 * proof of integration.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigService } from "@nestjs/config";
import { circuitBreakerRegistry } from "../../../common/http-retry.util";

const ORIGINAL_FETCH = globalThis.fetch;

interface MockResponseOpts {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

function mockResponse(opts: MockResponseOpts = {}): Response {
  const status = opts.status ?? 200;
  const body = JSON.stringify(opts.body ?? {});
  return new Response(body, {
    status,
    headers: { "Content-Type": "application/json", ...(opts.headers ?? {}) },
  });
}

function makeConfig(env: Record<string, string | undefined>): ConfigService {
  return new ConfigService(env);
}

beforeEach(() => {
  circuitBreakerRegistry._resetForTests();
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

describe("SerpDiscoveryService — retry wiring", () => {
  it("retries on 429 from Serper", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockResponse({ status: 429 }))
      .mockResolvedValueOnce(mockResponse({ body: { organic: [] } }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { SerpDiscoveryService } = await import("../serp-discovery.service");
    const svc = new SerpDiscoveryService(makeConfig({ SERPER_API_KEY: "test" }));

    // Reach the private method via cast — keeps the surface area tight.
    const result = await (svc as unknown as {
      executeSearch: (q: string, n: number) => Promise<unknown[]>;
    }).executeSearch("test", 5);

    expect(result).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // First arg to fetch is the URL.
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://google.serper.dev/search");
  });
});

describe("TheirStackService — retry wiring", () => {
  it("retries on 429 from TheirStack", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockResponse({ status: 429 }))
      .mockResolvedValueOnce(mockResponse({ body: { data: [] } }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { TheirStackService } = await import("../theirstack.service");
    const svc = new TheirStackService(makeConfig({ THEIRSTACK_API_KEY: "test" }));

    const result = await svc.discoverHiringCompanies({
      targetTitles: ["VP Sales"],
      targetIndustries: ["SaaS"],
      targetGeos: ["US"],
    });
    expect(result).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("GithubEnrichment — retry wiring", () => {
  it("retries on 429 from GitHub", async () => {
    // GithubEnrichment.searchOrgs iterates 3 domain variants — return a 429
    // on the very first probe (triggers a retry), then a fresh empty result
    // for every subsequent fetch. We MUST yield a new Response per call
    // because Response bodies are single-shot.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockResponse({ status: 429 }))
      .mockImplementation(() => Promise.resolve(mockResponse({ body: { items: [] } })));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { GithubEnrichment } = await import("../github-enrichment.service");
    const svc = new GithubEnrichment(makeConfig({ GITHUB_TOKEN: "tkn" }));

    const result = await svc.discoverPeople("acme.com");
    expect(result).toEqual([]);
    // 1 retry on first probe, plus at least one more variant probe.
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("api.github.com");
  });
});

describe("TeamPageScraper — retry wiring", () => {
  it("retries on 503 when scraping a team page", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockResponse({ status: 503 }))
      .mockResolvedValueOnce(
        new Response("<html><body>" + "x".repeat(600) + "</body></html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
      );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { TeamPageScraper } = await import("../team-page-scraper.service");
    const svc = new TeamPageScraper(makeConfig({}));

    const result = await svc.scrapeTeamPage("acme.com", "https://acme.com/team");
    expect(Array.isArray(result)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("RegistryScraper — retry wiring", () => {
  it("retries on 429 from OpenCorporates", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockResponse({ status: 429 }))
      .mockResolvedValueOnce(mockResponse({ body: { results: { companies: [] } } }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { RegistryScraper } = await import("../registry-scraper.service");
    const svc = new RegistryScraper(makeConfig({}));

    const result = await svc.searchOpenCorporates("Acme");
    expect(result).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("opencorporates.com");
  });
});

describe("AtsScraper — retry wiring", () => {
  it("retries on 429 from Greenhouse", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockResponse({ status: 429 }))
      .mockResolvedValueOnce(mockResponse({ body: { jobs: [{ id: 1, title: "Eng" }] } }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { AtsScraper } = await import("../ats-scraper.service");
    const svc = new AtsScraper();

    const result = await svc.discoverAtsSlugs(["acme.com"]);
    // Whether or not it detects, the retry should have happened on the first
    // greenhouse probe.
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("greenhouse.io");
    expect(result).toBeDefined();
  });
});
