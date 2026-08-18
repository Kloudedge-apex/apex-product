import { describe, expect, it } from "vitest";
import {
  buildLeadResearchBrief,
  normalizeLeadScoreBreakdown,
  toEvidenceTimeline,
  toIntentSignals,
  type LeadEvidenceRow,
} from "./lead-intelligence";

const now = new Date("2026-08-18T12:00:00.000Z");
const evidence: LeadEvidenceRow[] = [
  {
    id: "fresh",
    kind: "recent_hire",
    payload: {
      source: "https://jobs.example.com/account-executive",
      date: "2026-08-10",
      confidence: 0.92,
      jobTitle: "Account Executive",
    },
    createdAt: new Date("2026-08-10T10:00:00.000Z"),
  },
  {
    id: "mock",
    kind: "funding_event",
    payload: { source: "mock", date: "2026-08-11", confidence: 0 },
    createdAt: new Date("2026-08-11T10:00:00.000Z"),
  },
  {
    id: "stale",
    kind: "recent_hire",
    payload: {
      source: "https://jobs.example.com/old-role",
      date: "2025-01-01",
      confidence: 0.8,
      jobTitle: "Old Role",
    },
    createdAt: new Date("2025-01-01T10:00:00.000Z"),
  },
];

describe("lead intelligence presentation", () => {
  it("surfaces only fresh, non-mock signals with source and date", () => {
    expect(toIntentSignals(evidence, now)).toEqual([
      { label: "Hiring for Account Executive", confidence: 0.92 },
    ]);
    expect(toEvidenceTimeline(evidence, now)).toHaveLength(1);
    expect(toEvidenceTimeline(evidence, now)[0]?.description).toContain(
      "https://jobs.example.com/account-executive",
    );
  });

  it("builds a factual brief and explicitly reports missing attributable intent", () => {
    const brief = buildLeadResearchBrief({
      firstName: "Sam",
      lastName: "Rivera",
      title: "Head of Revenue Operations",
      location: "Austin, TX",
      company: {
        name: "Globex",
        domain: "globex.example",
        industry: "Software",
        employeeRange: "51-200",
        city: "Austin",
        country: "US",
        fundingStage: "Series A",
        techStack: ["HubSpot"],
      },
      score: 84,
      evidence: [],
      now,
    });

    expect(brief).toContain(
      "Sam Rivera is Head of Revenue Operations at Globex",
    );
    expect(brief).toContain("The current lead score is 84/100");
    expect(brief).toContain("No fresh attributable buying signal");
  });

  it("normalizes v2 categories and conservatively maps legacy features", () => {
    expect(
      normalizeLeadScoreBreakdown({
        fit: 91.6,
        intent: 110,
        engagement: -2,
        timing: 74,
      }),
    ).toEqual({ fit: 92, intent: 100, engagement: 0, timing: 74 });
    expect(
      normalizeLeadScoreBreakdown({
        fullName: 10,
        jobTitle: 10,
        companyDomain: 10,
        seniorityMatch: 10,
        verifiedEmail: 50,
        linkedinUrl: 20,
      }),
    ).toEqual({ fit: 89, intent: 0, engagement: 88, timing: 0 });
  });
});
