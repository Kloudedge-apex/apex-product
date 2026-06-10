import { describe, it, expect } from "vitest";
import { EvidenceLedgerService } from "../evidence-ledger.service";

// Fake Prisma with the same (orgId, runId, refType, refId, kind, payload.source)
// existence check recordSignal uses for idempotency, so a duplicate is skipped.
function fakePrisma() {
  const created: any[] = [];
  const matches = (row: any, where: any) =>
    row.orgId === where.orgId &&
    (row.runId ?? null) === (where.runId ?? null) &&
    row.refType === where.refType &&
    row.refId === where.refId &&
    row.kind === where.kind &&
    row.payload?.source === where.payload?.equals;
  return {
    created,
    evidenceEvent: {
      create: async ({ data }: any) => {
        created.push(data);
        return data;
      },
      findFirst: async ({ where }: any) => created.find((r) => matches(r, where)) ?? null,
    },
  } as any;
}

describe("recordSignal", () => {
  it("appends a signal EvidenceEvent with company refType + payload", async () => {
    const prisma = fakePrisma();
    const svc = new EvidenceLedgerService(prisma);
    await svc.recordSignal({
      orgId: "o1", runId: "r1", companyId: "c1", kind: "recent_hire",
      source: "https://jobs.example.com/123", date: "2026-05-20",
      summary: 'Posted "Senior SDR".', confidence: 0.9, fields: { jobTitle: "Senior SDR" },
    });
    expect(prisma.created).toHaveLength(1);
    expect(prisma.created[0]).toMatchObject({
      orgId: "o1", runId: "r1", kind: "recent_hire", refType: "company", refId: "c1",
    });
    expect(prisma.created[0].payload).toMatchObject({
      kind: "recent_hire", source: "https://jobs.example.com/123", date: "2026-05-20", confidence: 0.9, jobTitle: "Senior SDR",
    });
  });

  it("fails closed on an empty source or date (the citation invariant lives in the writer)", async () => {
    const prisma = fakePrisma();
    const svc = new EvidenceLedgerService(prisma);
    await svc.recordSignal({
      orgId: "o1", runId: "r1", companyId: "c1", kind: "recent_hire",
      source: "", date: "2026-05-20", confidence: 0.9,
    });
    await svc.recordSignal({
      orgId: "o1", runId: "r1", companyId: "c1", kind: "recent_hire",
      source: "https://jobs.example.com/123", date: "   ", confidence: 0.9,
    });
    expect(prisma.created).toHaveLength(0);
  });

  it("canonical citation keys cannot be overridden by fields", async () => {
    const prisma = fakePrisma();
    const svc = new EvidenceLedgerService(prisma);
    await svc.recordSignal({
      orgId: "o1", runId: "r1", companyId: "c1", kind: "recent_hire",
      source: "https://real.example.com", date: "2026-05-20", confidence: 0.9,
      // A future extractor that stuffs source/date into `fields` must NOT be able
      // to clobber the canonical citation — they win regardless of spread order.
      fields: { source: "https://spoof.example.com", date: "1999-01-01", jobTitle: "SDR" } as any,
    });
    expect(prisma.created[0].payload.source).toBe("https://real.example.com");
    expect(prisma.created[0].payload.date).toBe("2026-05-20");
    expect(prisma.created[0].payload.jobTitle).toBe("SDR");
  });

  it("is idempotent: a re-run does not duplicate an identical signal for the run", async () => {
    const prisma = fakePrisma();
    const svc = new EvidenceLedgerService(prisma);
    const sig = {
      orgId: "o1", runId: "r1", companyId: "c1", kind: "recent_hire" as const,
      source: "https://jobs.example.com/123", date: "2026-05-20", confidence: 0.9,
    };
    await svc.recordSignal(sig);
    await svc.recordSignal(sig); // resume/retry replays the same write
    expect(prisma.created).toHaveLength(1);
  });

  it("does not treat a different source as a duplicate", async () => {
    const prisma = fakePrisma();
    const svc = new EvidenceLedgerService(prisma);
    const base = { orgId: "o1", runId: "r1", companyId: "c1", kind: "recent_hire" as const, date: "2026-05-20", confidence: 0.9 };
    await svc.recordSignal({ ...base, source: "https://jobs.example.com/1" });
    await svc.recordSignal({ ...base, source: "https://jobs.example.com/2" });
    expect(prisma.created).toHaveLength(2);
  });
});
