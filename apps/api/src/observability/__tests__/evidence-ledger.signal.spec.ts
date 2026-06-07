import { describe, it, expect } from "vitest";
import { EvidenceLedgerService } from "../evidence-ledger.service";

function fakePrisma() {
  const created: any[] = [];
  return { created, evidenceEvent: { create: async ({ data }: any) => { created.push(data); return data; } } } as any;
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
});
