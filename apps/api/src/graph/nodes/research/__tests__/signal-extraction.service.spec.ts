import { describe, it, expect } from "vitest";
import { markMocked, markMockedItem } from "../../../../runtime/tools/mock-metadata";
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
    it("turns a real, dated web_search result into a press_mention dated by the RESULT", async () => {
      const search = fakeSearch(async () => ({
        success: true,
        data: {
          results: [
            {
              title: "Lumen raises $20M",
              url: "https://news.example.com/lumen",
              snippet: "...",
              date: "2026-06-01",
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
        // The result's OWN publication date — NOT the search day (2026-06-07).
        date: "2026-06-01",
      });
      expect(press?.fields?.outlet).toBe("news.example.com");
      expect(press?.fields?.headline).toBe("Lumen raises $20M");
    });

    it("requests the NEWS vertical — the dated-results endpoint — for the live-trigger search", async () => {
      // Organic search rarely carries a date; with fail-closed undated rejection
      // that meant ~100% trigger rejection. The news vertical is what makes
      // dated triggers actually land in prod.
      const calls: Array<Record<string, unknown>> = [];
      const search = fakeSearch(async (params) => {
        calls.push(params);
        return { success: true, data: { results: [] } };
      });
      const service = new SignalExtractionService(search);

      await service.extractLiveTrigger(company, NOW);

      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ vertical: "news", max_results: 3 });
      expect(String(calls[0].query)).toContain("Lumen");
    });

    it("emits NO signal when web_search returns mock data", async () => {
      const search = fakeSearch(async () => ({
        success: true,
        data: markMocked(
          { results: [{ title: "x", url: "https://x", date: "2026-06-01" }] },
          "no key",
        ),
      }));
      const service = new SignalExtractionService(search);

      const out = await service.extractForCompany(company, NOW);

      expect(out).toHaveLength(0);
    });

    it("skips a mock-tagged result item and uses the next clean result", async () => {
      // Outer payload is NOT mocked, but the first result item IS — this locks
      // in the per-result `!isMocked(r)` guard (defense-in-depth): without it,
      // the fixture item would be cited.
      const search = fakeSearch(async () => ({
        success: true,
        data: {
          results: [
            markMockedItem(
              { title: "fixture", url: "https://mock.example.com", date: "2026-06-01" },
              "no key",
            ),
            {
              title: "Lumen ships v2",
              url: "https://news.example.com/lumen-v2",
              snippet: "...",
              date: "2026-06-02",
            },
          ],
        },
      }));
      const service = new SignalExtractionService(search);

      const out = await service.extractLiveTrigger(company, NOW);

      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({
        kind: "press_mention",
        source: "https://news.example.com/lumen-v2",
        date: "2026-06-02",
      });
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

  describe("extractLiveTrigger — trigger dating (audit B3: result's own date or nothing)", () => {
    it("REJECTS an undated result entirely — never stamps the search day", async () => {
      // Pre-keystone code stamped `now` onto every hit, fabricating "recent"
      // triggers out of years-old pages. An undated result must yield NO signal.
      const search = fakeSearch(async () => ({
        success: true,
        data: {
          results: [
            { title: "Lumen raises $20M", url: "https://news.example.com/lumen", snippet: "..." },
          ],
        },
      }));
      const service = new SignalExtractionService(search);

      const out = await service.extractLiveTrigger(company, NOW);

      expect(out).toHaveLength(0);
    });

    it("parses Serper-news relative dates against the search time", async () => {
      const search = fakeSearch(async () => ({
        success: true,
        data: {
          results: [
            { title: "Lumen ships v2", url: "https://news.example.com/lumen", date: "2 days ago" },
          ],
        },
      }));
      const service = new SignalExtractionService(search);

      const out = await service.extractLiveTrigger(company, NOW);

      expect(out).toHaveLength(1);
      expect(out[0].date).toBe("2026-06-05");
    });

    it("parses Serper absolute dates like 'Jun 5, 2026'", async () => {
      const search = fakeSearch(async () => ({
        success: true,
        data: {
          results: [
            { title: "Lumen ships v2", url: "https://news.example.com/lumen", date: "Jun 5, 2026" },
          ],
        },
      }));
      const service = new SignalExtractionService(search);

      const out = await service.extractLiveTrigger(company, NOW);

      expect(out).toHaveLength(1);
      expect(out[0].date).toBe("2026-06-05");
    });

    it("accepts a Tavily-style published_date field", async () => {
      const search = fakeSearch(async () => ({
        success: true,
        data: {
          results: [
            {
              title: "Lumen ships v2",
              url: "https://news.example.com/lumen",
              published_date: "2026-06-03",
            },
          ],
        },
      }));
      const service = new SignalExtractionService(search);

      const out = await service.extractLiveTrigger(company, NOW);

      expect(out).toHaveLength(1);
      expect(out[0].date).toBe("2026-06-03");
    });

    it("REJECTS unparseable date strings rather than guessing", async () => {
      const search = fakeSearch(async () => ({
        success: true,
        data: {
          results: [
            { title: "a", url: "https://news.example.com/a", date: "last Tuesday" },
            { title: "b", url: "https://news.example.com/b", date: "recently" },
          ],
        },
      }));
      const service = new SignalExtractionService(search);

      const out = await service.extractLiveTrigger(company, NOW);

      expect(out).toHaveLength(0);
    });

    it("skips an undated first hit and cites the next dated one", async () => {
      const search = fakeSearch(async () => ({
        success: true,
        data: {
          results: [
            { title: "undated", url: "https://news.example.com/undated" },
            { title: "dated", url: "https://news.example.com/dated", date: "2026-06-04" },
          ],
        },
      }));
      const service = new SignalExtractionService(search);

      const out = await service.extractLiveTrigger(company, NOW);

      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({
        source: "https://news.example.com/dated",
        date: "2026-06-04",
      });
    });
  });

  describe("extractLiveTrigger — domain exclusions (audit B3)", () => {
    it("excludes hits on the company's own domain (incl. subdomains) — self-published is not a trigger", async () => {
      const search = fakeSearch(async () => ({
        success: true,
        data: {
          results: [
            { title: "own blog", url: "https://lumen.com/blog/launch", date: "2026-06-01" },
            { title: "own subdomain", url: "https://blog.lumen.com/launch", date: "2026-06-01" },
            { title: "third party", url: "https://news.example.com/lumen", date: "2026-06-02" },
          ],
        },
      }));
      const service = new SignalExtractionService(search);

      const out = await service.extractLiveTrigger(company, NOW);

      expect(out).toHaveLength(1);
      expect(out[0].source).toBe("https://news.example.com/lumen");
    });

    it.each([
      ["linkedin", "https://www.linkedin.com/posts/lumen-update"],
      ["twitter", "https://twitter.com/lumen/status/1"],
      ["x", "https://x.com/lumen/status/1"],
      ["facebook", "https://www.facebook.com/lumen/posts/1"],
    ])("excludes %s hits — social feeds are not citable dated coverage", async (_name, url) => {
      const search = fakeSearch(async () => ({
        success: true,
        data: { results: [{ title: "social post", url, date: "2026-06-01" }] },
      }));
      const service = new SignalExtractionService(search);

      const out = await service.extractLiveTrigger(company, NOW);

      expect(out).toHaveLength(0);
    });

    it("matches exclusions exact-or-subdomain, not substring (xerox.com / newsx.com pass)", async () => {
      const search = fakeSearch(async () => ({
        success: true,
        data: {
          results: [
            { title: "not x.com", url: "https://newsx.com/lumen", date: "2026-06-01" },
          ],
        },
      }));
      const service = new SignalExtractionService(search);

      const out = await service.extractLiveTrigger(company, NOW);

      expect(out).toHaveLength(1);
      expect(out[0].fields?.outlet).toBe("newsx.com");
    });

    it("rejects a result whose url does not parse — no attributable outlet", async () => {
      const search = fakeSearch(async () => ({
        success: true,
        data: { results: [{ title: "broken", url: "not-a-url", date: "2026-06-01" }] },
      }));
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

    it("skips a job whose date is not strict ISO yyyy-mm-dd (never cites a wrong date)", () => {
      const service = new SignalExtractionService(mockedSearch);
      // 'May 20, 2026'.slice(0,10) === 'May 20, 20' → new Date(...) is a VALID
      // year-2020 date, not NaN; and '05/20/2026' parses to a valid local date.
      // Both must be rejected, not stored verbatim or mis-dated.
      const longForm = service.extractFromScraped({
        ...company,
        raw: { jobs: [{ title: "Senior SDR", url: "https://jobs.example.com/1", postedAt: "May 20, 2026" }] },
      });
      expect(longForm.filter((s) => s.kind === "recent_hire")).toHaveLength(0);

      const slashForm = service.extractFromScraped({
        ...company,
        raw: { jobs: [{ title: "Senior SDR", url: "https://jobs.example.com/1", postedAt: "05/20/2026" }] },
      });
      expect(slashForm.filter((s) => s.kind === "recent_hire")).toHaveLength(0);
    });

    it("accepts a full ISO datetime by normalizing to yyyy-mm-dd", () => {
      const service = new SignalExtractionService(mockedSearch);
      const out = service.extractFromScraped({
        ...company,
        raw: { jobs: [{ title: "Senior SDR", url: "https://jobs.example.com/1", postedAt: "2026-05-20T09:30:00Z" }] },
      });
      expect(out.find((s) => s.kind === "recent_hire")).toMatchObject({ date: "2026-05-20" });
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
