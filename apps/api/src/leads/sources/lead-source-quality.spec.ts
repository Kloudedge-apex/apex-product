import { describe, expect, it } from "vitest";
import { SerpDiscoveryService } from "./serp-discovery.service";
import { JobSignalService } from "./job-signal.service";
import type { ConfigService } from "@nestjs/config";

describe("lead-source quality guards", () => {
  it("never turns an ATS tenant slug into a guessed company domain", () => {
    const service = new SerpDiscoveryService({
      get: () => "test-key",
    } as unknown as ConfigService);
    const parse = (
      service as unknown as {
        parseCompanyResult(
          result: { title: string; link: string; snippet: string },
          icp: {
            targetTitles: string[];
            targetIndustries: string[];
            targetGeos: string[];
          },
        ): unknown;
      }
    ).parseCompanyResult.bind(service);

    expect(
      parse(
        {
          title: "Acme jobs",
          link: "https://jobs.lever.co/acme-north-america",
          snippet: "Open roles at Acme",
        },
        { targetTitles: [], targetIndustries: [], targetGeos: [] },
      ),
    ).toBeNull();
  });

  it("caps intent at 100 and returns unique signal labels", () => {
    const titles = Array.from(
      { length: 30 },
      () => "VP People HRIS Workforce Planning",
    );
    const result = new JobSignalService().scoreJobIntent(
      titles,
      ["employee experience payroll talent acquisition sales operations"],
      ["HRIS", "HRIS"],
      ["VP People", "VP People"],
    );

    expect(result.intentScore).toBe(100);
    expect(new Set(result.signals).size).toBe(result.signals.length);
  });
});
