import { describe, it, expect, vi } from "vitest";
import { assembleResearchBrief, type SdrLeadInput } from "../nodes/sdr-outreach-subgraph";

const freshDate = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
const staleDate = "2025-01-01";

function lead(): SdrLeadInput {
  return {
    orgId: "org_1",
    personId: "p1",
    email: "a@acme.io",
    firstName: "Alice",
    lastName: "Smith",
    title: "VP Sales",
    companyName: "Acme",
    companyDomain: "acme.io",
  };
}

function fakePrisma(events: unknown[]) {
  return {
    company: {
      findFirst: vi.fn().mockResolvedValue({
        id: "co1",
        name: "Acme",
        domain: "acme.io",
        industry: null,
        employeeRange: null,
        country: null,
        city: null,
        fundingStage: null,
        techStack: [],
        intentSignals: [],
      }),
    },
    person: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
    leadScore: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
    evidenceEvent: {
      findMany: vi.fn().mockResolvedValue(events),
    },
  } as any;
}

describe("assembleResearchBrief grounding (refusal-first)", () => {
  it("refuses when the only signal is stale", async () => {
    const prisma = fakePrisma([
      {
        kind: "recent_hire",
        payload: { date: staleDate, source: "https://x", confidence: 0.9, jobTitle: "SDR" },
        createdAt: new Date(),
      },
    ]);
    const brief = await assembleResearchBrief(prisma, lead());
    expect(brief.hasGroundingSignal).toBe(false);
  });

  it("grounds on a fresh real signal and emits a dated S1 fact", async () => {
    const prisma = fakePrisma([
      {
        kind: "recent_hire",
        payload: { date: freshDate, source: "https://x", confidence: 0.9, jobTitle: "SDR" },
        createdAt: new Date(),
      },
    ]);
    const brief = await assembleResearchBrief(prisma, lead());
    expect(brief.hasGroundingSignal).toBe(true);
    const signal = brief.facts.find((f) => f.category === "signal");
    expect(signal?.date).toBe(freshDate);
    expect(signal?.id).toBe("S1");
  });

  it("refuses when the only signal is mocked", async () => {
    const prisma = fakePrisma([
      {
        kind: "press_mention",
        payload: { source: "mock", confidence: 0, date: freshDate },
        createdAt: new Date(),
      },
    ]);
    const brief = await assembleResearchBrief(prisma, lead());
    expect(brief.hasGroundingSignal).toBe(false);
  });
});
