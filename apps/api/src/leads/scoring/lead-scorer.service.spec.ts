import { describe, expect, it } from "vitest";
import { LeadScorer } from "./lead-scorer.service";

const matchedPerson = {
  firstName: "Elena",
  lastName: "Park",
  title: "VP of Sales",
  seniority: "VP" as const,
  location: "Austin, TX",
  linkedinUrl: "https://linkedin.com/in/elena-park",
  company: {
    domain: "example.com",
    name: "Example",
    country: "US",
    industry: "B2B Software",
    employeeRange: "201-500",
    techStack: ["Salesforce", "React"],
    intentScore: 88,
    intentSignals: ["active hiring"],
    updatedAt: new Date(),
  },
  emails: [
    {
      email: "elena@example.com",
      verified: true,
      source: "TEAM_PAGE" as const,
      confidence: 0.98,
    },
  ],
};

const icp = {
  targetTitles: ["VP Sales"],
  targetIndustries: ["Software"],
  targetGeos: ["United States"],
  minEmployees: 50,
  maxEmployees: 1000,
  techStackSignals: ["Salesforce"],
};

describe("LeadScorer", () => {
  it("scores independent fit, intent, reachability and timing percentages", () => {
    const result = new LeadScorer().score(matchedPerson, icp);

    expect(result.breakdown).toEqual({
      fit: 100,
      intent: 88,
      engagement: 90,
      timing: 88,
    });
    expect(result.score).toBe(94);
  });

  it("never returns a score or category above 100", () => {
    const result = new LeadScorer().score(
      {
        ...matchedPerson,
        company: { ...matchedPerson.company, intentScore: 500 },
        emails: [
          ...matchedPerson.emails,
          {
            email: "e.park@example.com",
            verified: false,
            source: "GITHUB_COMMIT" as const,
            confidence: 0.8,
          },
        ],
      },
      icp,
    );

    expect(result.score).toBe(100);
    expect(Object.values(result.breakdown).every((value) => value <= 100)).toBe(
      true,
    );
  });

  it("does not award ICP fit when the configured criteria do not match", () => {
    const result = new LeadScorer().score(matchedPerson, {
      ...icp,
      targetTitles: ["Chief Financial Officer"],
      targetIndustries: ["Healthcare"],
      targetGeos: ["Germany"],
      minEmployees: 5000,
      maxEmployees: 10000,
      techStackSignals: ["SAP"],
    });

    expect(result.breakdown.fit).toBe(0);
    expect(result.score).toBeLessThan(75);
  });
});
