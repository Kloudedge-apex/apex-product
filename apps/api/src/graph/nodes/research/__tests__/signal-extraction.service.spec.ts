import { describe, it, expect } from "vitest";
import { markMocked } from "../../../../runtime/tools/mock-metadata";
import {
  SignalExtractionService,
  type WebSearchExecutor,
  type CompanyForExtraction,
} from "../signal-extraction.service";

const NOW = new Date("2026-06-07T00:00:00Z");

function fakeSearch(execute: WebSearchExecutor["execute"]): WebSearchExecutor {
  return { execute };
}

const company: CompanyForExtraction = {
  id: "c1",
  name: "Lumen",
  domain: "lumen.com",
  raw: {},
};

describe("SignalExtractionService", () => {
  describe("extractForCompany — live trigger", () => {
    it("turns a real web_search result into a press_mention", async () => {
      const search = fakeSearch(async () => ({
        success: true,
        data: {
          results: [
            {
              title: "Lumen raises $20M",
              url: "https://news.example.com/lumen",
              snippet: "...",
            },
          ],
        },
      }));
      const service = new SignalExtractionService(search);

      const out = await service.extractForCompany(company, NOW);

      const press = out.find((s) => s.kind === "press_mention");
      expect(press).toBeDefined();
      expect(press).toMatchObject({
        source: "https://news.example.com/lumen",
        date: "2026-06-07",
      });
      expect(press?.fields?.outlet).toBe("news.example.com");
      expect(press?.fields?.headline).toBe("Lumen raises $20M");
    });

    it("emits NO signal when web_search returns mock data", async () => {
      const search = fakeSearch(async () => ({
        success: true,
        data: markMocked(
          { results: [{ title: "x", url: "https://x" }] },
          "no key",
        ),
      }));
      const service = new SignalExtractionService(search);

      const out = await service.extractForCompany(company, NOW);

      expect(out).toHaveLength(0);
    });

    it("emits NO live signal when the search fails (success:false)", async () => {
      const search = fakeSearch(async () => ({
        success: false,
        data: null,
        error: "boom",
      }));
      const service = new SignalExtractionService(search);

      const out = await service.extractLiveTrigger(company, NOW);

      expect(out).toHaveLength(0);
    });

    it("emits NO live signal when execute throws", async () => {
      const search = fakeSearch(async () => {
        throw new Error("network down");
      });
      const service = new SignalExtractionService(search);

      const out = await service.extractLiveTrigger(company, NOW);

      expect(out).toHaveLength(0);
    });
  });

  describe("extractFromScraped — recent_hire", () => {
    // A search that returns mock data so it contributes no press_mention noise.
    const mockedSearch = fakeSearch(async () => ({
      success: true,
      data: markMocked(
        { results: [{ title: "x", url: "https://x" }] },
        "no key",
      ),
    }));

    it("turns a real scraped job into a recent_hire via extractForCompany", async () => {
      const service = new SignalExtractionService(mockedSearch);
      const withJobs: CompanyForExtraction = {
        ...company,
        raw: {
          jobs: [
            {
              title: "Senior SDR",
              url: "https://jobs.example.com/1",
              postedAt: "2026-05-20",
            },
          ],
        },
      };

      const out = await service.extractForCompany(withJobs, NOW);

      const hire = out.find((s) => s.kind === "recent_hire");
      expect(hire).toBeDefined();
      expect(hire).toMatchObject({
        source: "https://jobs.example.com/1",
        date: "2026-05-20",
      });
      expect(hire?.fields?.jobTitle).toBe("Senior SDR");
      // no press_mention because search was mocked
      expect(out.find((s) => s.kind === "press_mention")).toBeUndefined();
    });

    it("skips a job missing a url", () => {
      const service = new SignalExtractionService(mockedSearch);
      const out = service.extractFromScraped({
        ...company,
        raw: { jobs: [{ title: "Senior SDR", postedAt: "2026-05-20" }] },
      });
      expect(out.filter((s) => s.kind === "recent_hire")).toHaveLength(0);
    });

    it("skips a job missing a date", () => {
      const service = new SignalExtractionService(mockedSearch);
      const out = service.extractFromScraped({
        ...company,
        raw: { jobs: [{ title: "Senior SDR", url: "https://jobs.example.com/1" }] },
      });
      expect(out.filter((s) => s.kind === "recent_hire")).toHaveLength(0);
    });

    it("skips a mock-tagged job", () => {
      const service = new SignalExtractionService(mockedSearch);
      const out = service.extractFromScraped({
        ...company,
        raw: {
          jobs: [
            markMocked(
              {
                title: "Senior SDR",
                url: "https://jobs.example.com/1",
                postedAt: "2026-05-20",
              },
              "fixture",
            ),
          ],
        },
      });
      expect(out.filter((s) => s.kind === "recent_hire")).toHaveLength(0);
    });

    it("returns [] when raw is null / empty / non-object", () => {
      const service = new SignalExtractionService(mockedSearch);
      expect(service.extractFromScraped({ ...company, raw: null })).toHaveLength(0);
      expect(service.extractFromScraped({ ...company, raw: {} })).toHaveLength(0);
      expect(service.extractFromScraped({ ...company, raw: [] })).toHaveLength(0);
      expect(
        service.extractFromScraped({ ...company, raw: { jobs: "not-an-array" } }),
      ).toHaveLength(0);
    });
  });
});
