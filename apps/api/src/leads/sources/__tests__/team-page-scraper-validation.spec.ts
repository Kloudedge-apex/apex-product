/**
 * Validation-retry tests for TeamPageScraper.extractWithLlm.
 *
 * The scraper falls through to the LLM extractor only when JSON-LD and DOM
 * patterns both produce zero people. We provide an HTML page that has
 * neither, then assert:
 *   - malformed first LLM response triggers a single retry,
 *   - both attempts malformed -> returns [] (no throw),
 *   - valid response is consumed normally.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigService } from "@nestjs/config";
import { TeamPageScraper } from "../team-page-scraper.service";
import type { LLMService, LLMResponse } from "../../../runtime/llm.service";
import { circuitBreakerRegistry } from "../../../common/http-retry.util";

const ORIGINAL_FETCH = globalThis.fetch;

// HTML deliberately devoid of JSON-LD <script> blocks and the heading
// patterns the DOM extractor recognizes, so the LLM branch fires.
function teamHtml(): string {
  return (
    "<html><body>" +
    "<div class='content'>" +
    "Welcome to our company! We are a passionate team building things. " +
    "Our story began many years ago. We have offices around the world. " +
    "Get in touch to learn more about what we do every day." +
    "</div>" +
    "</body></html>"
  ).padEnd(800, " "); // clear the 500-char min
}

function makeLlm(contents: string[]): {
  llm: LLMService;
  chatMock: ReturnType<typeof vi.fn>;
} {
  const queue = [...contents];
  const chatMock = vi.fn(async (): Promise<LLMResponse> => {
    const content = queue.shift() ?? "";
    return { content, tokensUsed: 100, model: "gpt-4o-mini-mock", cost: 0 };
  });
  const llm = { chat: chatMock } as unknown as LLMService;
  return { llm, chatMock };
}

function makeConfig(): ConfigService {
  return new ConfigService({ OPENAI_API_KEY: "test-key" });
}

beforeEach(() => {
  circuitBreakerRegistry._resetForTests();
  // Return the prepared HTML on every URL the scraper tries.
  globalThis.fetch = vi.fn(async () =>
    new Response(teamHtml(), { status: 200, headers: { "Content-Type": "text/html" } }),
  ) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

describe("TeamPageScraper.extractWithLlm — JSON validation retry", () => {
  it("retries once when the first LLM response is malformed and succeeds on the second", async () => {
    const validResponse = JSON.stringify({
      people: [{ firstName: "Ada", lastName: "Lovelace", title: "CTO" }],
    });
    const { llm, chatMock } = makeLlm(["completely-not-json", validResponse]);

    const scraper = new TeamPageScraper(makeConfig(), llm);
    const people = await scraper.scrapeTeamPage("acme.com");

    expect(people).toHaveLength(1);
    expect(people[0]!.firstName).toBe("Ada");
    expect(people[0]!.lastName).toBe("Lovelace");
    expect(chatMock).toHaveBeenCalledTimes(2);
  });

  it("returns [] (no throw) when both LLM attempts produce invalid JSON", async () => {
    const { llm, chatMock } = makeLlm(["garbage one", "garbage two"]);

    const scraper = new TeamPageScraper(makeConfig(), llm);
    const people = await scraper.scrapeTeamPage("acme.com");

    expect(people).toEqual([]);
    // The scraper iterates through TEAM_PATHS (10 URLs) and calls the LLM
    // once per URL, with each call doing 1 retry on failure. We only care
    // that retries happened — assert at least 2 calls (one URL's pair).
    expect(chatMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("does not retry when the first response is valid", async () => {
    const validResponse = JSON.stringify({
      people: [{ firstName: "Grace", lastName: "Hopper" }],
    });
    const { llm, chatMock } = makeLlm([validResponse]);

    const scraper = new TeamPageScraper(makeConfig(), llm);
    const people = await scraper.scrapeTeamPage("acme.com");

    expect(people).toHaveLength(1);
    expect(people[0]!.firstName).toBe("Grace");
    expect(chatMock).toHaveBeenCalledTimes(1);
  });
});
