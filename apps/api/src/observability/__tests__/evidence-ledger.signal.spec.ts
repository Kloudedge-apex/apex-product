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
    const result = await svc.recordSignal({
      orgId: "o1", runId: "r1", companyId: "c1", kind: "recent_hire",
      source: "https://jobs.example.com/123", date: "2026-05-20",
      summary: 'Posted "Senior SDR".', confidence: 0.9, fields: { jobTitle: "Senior SDR" },
    });
    expect(prisma.created).toHaveLength(1);
    expect(result).toBe("CREATED");
    expect(prisma.created[0]).toMatchObject({
      orgId: "o1", runId: "r1", kind: "recent_hire", refType: "company", refId: "c1",
    });
    expect(prisma.created[0].payload).toMatchObject({
      kind: "recent_hire", source: "https://jobs.example.com/123", date: "2026-05-20", confidence: 0.9, jobTitle: "Senior SDR",
    });
  });

  it("fails closed on malformed citation fields (the invariant lives in the writer)", async () => {
    const prisma = fakePrisma();
    const svc = new EvidenceLedgerService(prisma);
    const missingSource = await svc.recordSignal({
      orgId: "o1", runId: "r1", companyId: "c1", kind: "recent_hire",
      source: "", date: "2026-05-20", confidence: 0.9,
    });
    const missingDate = await svc.recordSignal({
      orgId: "o1", runId: "r1", companyId: "c1", kind: "recent_hire",
      source: "https://jobs.example.com/123", date: "   ", confidence: 0.9,
    });
    const nonUrlSource = await svc.recordSignal({
      orgId: "o1", runId: "r1", companyId: "c1", kind: "recent_hire",
      source: "jobs.example.com/123", date: "2026-05-20", confidence: 0.9,
    });
    const credentialUrl = await svc.recordSignal({
      orgId: "o1", runId: "r1", companyId: "c1", kind: "recent_hire",
      source: "https://user:secret@jobs.example.com/123", date: "2026-05-20", confidence: 0.9,
    });
    const impossibleDate = await svc.recordSignal({
      orgId: "o1", runId: "r1", companyId: "c1", kind: "recent_hire",
      source: "https://jobs.example.com/123", date: "2026-02-30", confidence: 0.9,
    });
    const invalidConfidence = await svc.recordSignal({
      orgId: "o1", runId: "r1", companyId: "c1", kind: "recent_hire",
      source: "https://jobs.example.com/123", date: "2026-05-20", confidence: 90,
    });
    expect([
      missingSource,
      missingDate,
      nonUrlSource,
      credentialUrl,
      impossibleDate,
      invalidConfidence,
    ]).toEqual(Array(6).fill("REJECTED"));
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
    expect(await svc.recordSignal(sig)).toBe("CREATED");
    expect(await svc.recordSignal(sig)).toBe("EXISTING"); // resume/retry replays the same write
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

  it("reports a failed insert instead of presenting an attempted write as durable", async () => {
    const prisma = fakePrisma();
    prisma.evidenceEvent.create = async () => {
      throw new Error("database unavailable");
    };
    const svc = new EvidenceLedgerService(prisma);

    const result = await svc.recordSignal({
      orgId: "o1", runId: "r1", companyId: "c1", kind: "recent_hire",
      source: "https://jobs.example.com/123", date: "2026-05-20", confidence: 0.9,
    });

    expect(result).toBe("FAILED");
    expect(prisma.created).toHaveLength(0);
  });

  it("reports an idempotency-read failure as non-durable", async () => {
    const prisma = fakePrisma();
    prisma.evidenceEvent.findFirst = async () => {
      throw new Error("read unavailable");
    };
    const svc = new EvidenceLedgerService(prisma);

    const result = await svc.recordSignal({
      orgId: "o1", runId: "r1", companyId: "c1", kind: "recent_hire",
      source: "https://jobs.example.com/123", date: "2026-05-20", confidence: 0.9,
    });

    expect(result).toBe("FAILED");
    expect(prisma.created).toHaveLength(0);
  });
});
