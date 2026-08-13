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

function fakePrisma(events: unknown[], intentSignals: string[] = []) {
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
        intentSignals,
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
  it("scopes person facts through the lead organization", async () => {
    const prisma = fakePrisma([]);

    await assembleResearchBrief(prisma, lead());

    expect(prisma.person.findFirst).toHaveBeenCalledWith({
      where: { id: "p1", company: { orgId: "org_1" } },
      select: {
        title: true,
        seniority: true,
        department: true,
        location: true,
        bio: true,
      },
    });
  });

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

  it("refuses on undated intent strings alone — intentSignals never satisfy grounding", async () => {
    // The wedge dropped the old `|| company.intentSignals?.length` OR-clause:
    // an undated, unsourced intent string must NOT ground a lead. A company
    // rich in intent but with zero fresh dated signals still refuses.
    const prisma = fakePrisma([], ["hiring-spike", "budget-approved", "evaluating-vendors"]);
    const brief = await assembleResearchBrief(prisma, lead());
    expect(brief.hasGroundingSignal).toBe(false);
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

  it("continues past a full page of stale rows to find a fresh grounding signal", async () => {
    const stalePage = Array.from({ length: 25 }, (_, index) => ({
      id: `stale-${index}`,
      kind: "recent_hire",
      payload: {
        date: staleDate,
        source: `https://example.com/stale-${index}`,
        confidence: 0.9,
        jobTitle: "SDR",
      },
      createdAt: new Date(Date.now() - index * 1000),
    }));
    const freshEvent = {
      id: "fresh-1",
      kind: "product_launch",
      payload: {
        date: freshDate,
        source: "https://example.com/fresh",
        confidence: 0.95,
        product: "New platform",
      },
      createdAt: new Date(Date.now() - 30_000),
    };
    const prisma = fakePrisma([]);
    prisma.evidenceEvent.findMany
      .mockResolvedValueOnce(stalePage)
      .mockResolvedValueOnce([freshEvent]);

    const brief = await assembleResearchBrief(prisma, lead());

    expect(brief.hasGroundingSignal).toBe(true);
    expect(brief.facts.find((fact) => fact.id === "S1")?.date).toBe(freshDate);
    expect(prisma.evidenceEvent.findMany).toHaveBeenCalledTimes(2);
    expect(prisma.evidenceEvent.findMany.mock.calls[1]?.[0]).toMatchObject({
      cursor: { id: "stale-24" },
      skip: 1,
    });
  });
});
