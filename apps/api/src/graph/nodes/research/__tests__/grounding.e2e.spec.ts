import { describe, it, expect } from "vitest";
import { buildResearchNode } from "../research.node";
import { SignalExtractionService } from "../signal-extraction.service";
import { EvidenceLedgerService } from "../../../../observability/evidence-ledger.service";
import { assembleResearchBrief } from "../../sdr-outreach-subgraph";
import { markMocked } from "../../../../runtime/tools/mock-metadata";

/**
 * END-TO-END grounding proof. Wires the REAL RESEARCH node + REAL
 * SignalExtractionService (mock/keyless web_search) + REAL EvidenceLedgerService,
 * all sharing ONE in-memory evidenceEvent store, then runs the REAL
 * assembleResearchBrief against the same store. This is the integration seam the
 * unit tests cannot exercise: recordSignal's WRITE payload shape must be readable
 * by the brief's READ filter. If recordSignal stamps a refType/kind/payload the
 * brief can't match, this fails — exactly the bug this test exists to catch.
 *
 * Test 1: a fresh dated `recent_hire` parsed from company.raw.jobs → one ledger
 *   row → brief grounds with a dated signal fact.
 * Test 2: no jobs + mock-only live search → zero ledger rows → brief refuses.
 */

interface EvidenceRow {
  orgId: string;
  runId: string | null;
  traceId: string | null;
  kind: string;
  refType: string;
  refId: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

/**
 * In-memory fake prisma sharing one `store` array across the write side
 * (evidenceEvent.create, driven by the node→ledger) and the read side
 * (evidenceEvent.findMany, driven by the brief). The findMany faithfully
 * reproduces the production filter: where.orgId, the where.OR (refType+refId)
 * list, where.kind.in, orderBy createdAt desc, then take. Cast `as any` — this is
 * test scaffolding standing in for the typed PrismaService.
 */
function makeFakePrisma(raw: unknown) {
  const store: EvidenceRow[] = [];
  const company = {
    id: "c1",
    name: "Acme",
    domain: "acme.io",
    industry: null,
    employeeRange: null,
    country: null,
    city: null,
    fundingStage: null,
    techStack: [] as string[],
    intentSignals: [] as string[],
  };

  const prisma = {
    company: {
      // Read by the brief.
      findFirst: async () => company,
      // Read by the RESEARCH node (resolves company.raw for extraction).
      findMany: async () => [{ id: "c1", name: "Acme", domain: "acme.io", raw }],
    },
    person: {
      // Read by the RESEARCH node (person → company resolve).
      findMany: async () => [{ companyId: "c1" }],
      // Read by the brief (person facts).
      findFirst: async () => null,
    },
    leadScore: {
      findFirst: async () => null,
    },
    evidenceEvent: {
      // Idempotency probe — recordSignal's pre-INSERT existence check. Reproduces
      // the real where: orgId + runId + refType + refId + kind + payload->>source.
      findFirst: async ({
        where,
      }: {
        where: {
          orgId: string;
          runId: string | null;
          refType: string;
          refId: string;
          kind: string;
          payload?: { path: string[]; equals: unknown };
        };
      }) =>
        store.find(
          (r) =>
            r.orgId === where.orgId &&
            (r.runId ?? null) === (where.runId ?? null) &&
            r.refType === where.refType &&
            r.refId === where.refId &&
            r.kind === where.kind &&
            r.payload?.[where.payload?.path?.[0] ?? "source"] === where.payload?.equals,
        ) ?? null,
      // Write side — the ledger's append() calls this.
      create: async ({ data }: { data: Omit<EvidenceRow, "createdAt"> }) => {
        const row: EvidenceRow = { ...data, createdAt: new Date() };
        store.push(row);
        return row;
      },
      // Read side — the brief's findMany. Reproduces the real where/orderBy/take.
      findMany: async ({
        where,
        take,
      }: {
        where: {
          orgId: string;
          OR: Array<{ refType: string; refId: string }>;
          kind: { in: string[] };
        };
        orderBy?: { createdAt: "desc" };
        take?: number;
        select?: unknown;
      }) => {
        const matches = store.filter(
          (r) =>
            r.orgId === where.orgId &&
            where.OR.some((o) => o.refType === r.refType && o.refId === r.refId) &&
            where.kind.in.includes(r.kind),
        );
        matches.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        const limited = typeof take === "number" ? matches.slice(0, take) : matches;
        return limited.map((r) => ({
          kind: r.kind,
          payload: r.payload,
          createdAt: r.createdAt,
        }));
      },
    },
    // Exposed for assertions.
    __store: store,
  };

  return prisma;
}

const lead = {
  orgId: "org1",
  personId: "p1",
  email: "alice@acme.io",
  firstName: "Alice",
  lastName: "Smith",
  title: "VP Sales",
  companyName: "Acme",
  companyDomain: "acme.io",
};

// Inside the recent_hire freshness window (75d) — counts toward grounding.
const freshDate = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);

// Keyless web_search returns a mock-tagged payload → extractLiveTrigger yields []
// (mock never becomes a fact), so the only possible signal is the scraped job.
const mockKeylessSearch = {
  execute: async () => ({ success: true, data: markMocked({ results: [] }, "no key") }),
};

describe("research grounding e2e (real node → real ledger → real brief, one store)", () => {
  it("grounds: a fresh dated recent_hire written by the node makes the brief ground the lead", async () => {
    const raw = { jobs: [{ title: "Senior SDR", url: "https://jobs.test/1", postedAt: freshDate }] };
    const prisma = makeFakePrisma(raw);

    const svc = new SignalExtractionService(mockKeylessSearch as any);
    const ledger = new EvidenceLedgerService(prisma as any);
    const node = buildResearchNode({ prisma: prisma as any, signalExtraction: svc, evidenceLedger: ledger });

    await node({
      orgId: "org1",
      runId: "run1",
      stageStatuses: {},
      scoredLeads: [{ personId: "p1", score: 90, tier: "A" }],
    } as any);

    // Exactly one signal written: the scraped recent_hire (live trigger was mock → []).
    expect(prisma.__store).toHaveLength(1);
    const row = prisma.__store[0];
    expect(row.kind).toBe("recent_hire");
    expect(row.refType).toBe("company");
    expect(row.refId).toBe("c1");
    expect(row.payload.date).toBe(freshDate);

    // The brief, reading the SAME store, grounds on that signal with a dated fact.
    const brief = await assembleResearchBrief(prisma as any, lead as any);
    expect(brief.hasGroundingSignal).toBe(true);
    expect(brief.facts.some((f) => f.category === "signal" && f.date === freshDate)).toBe(true);
  });

  it("refuses: no scraped job + mock-only live search → zero signals → brief does not ground", async () => {
    const raw = {}; // no jobs[]
    const prisma = makeFakePrisma(raw);

    const svc = new SignalExtractionService(mockKeylessSearch as any);
    const ledger = new EvidenceLedgerService(prisma as any);
    const node = buildResearchNode({ prisma: prisma as any, signalExtraction: svc, evidenceLedger: ledger });

    await node({
      orgId: "org1",
      runId: "run1",
      stageStatuses: {},
      scoredLeads: [{ personId: "p1", score: 90, tier: "A" }],
    } as any);

    // Nothing real to cite → nothing written.
    expect(prisma.__store).toHaveLength(0);

    const brief = await assembleResearchBrief(prisma as any, lead as any);
    expect(brief.hasGroundingSignal).toBe(false);
  });
});
