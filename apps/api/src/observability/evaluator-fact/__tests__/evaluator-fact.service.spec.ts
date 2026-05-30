import { describe, it, expect, vi } from "vitest";
import { EvaluatorTargetType, type EvaluatorRun } from "@prisma/client";
import { EvaluatorFactService, type EvaluatorFactPrisma } from "../evaluator-fact.service";

function makePrisma() {
  const rows: EvaluatorRun[] = [];

  const prisma: EvaluatorFactPrisma & { _rows: EvaluatorRun[] } = {
    evaluatorRun: {
      create: vi.fn(async (args: any) => {
        const data = args.data as Omit<EvaluatorRun, "id" | "createdAt">;
        const row: EvaluatorRun = {
          id: `ev_${rows.length + 1}`,
          createdAt: new Date(),
          ...data,
        } as EvaluatorRun;
        rows.push(row);
        return row;
      }),
      findMany: vi.fn(async (args: any) => {
        const where = (args?.where ?? {}) as Partial<EvaluatorRun>;
        const filtered = rows.filter((r) => {
          if (where.orgId && r.orgId !== where.orgId) return false;
          if (where.evaluatorName && r.evaluatorName !== where.evaluatorName) return false;
          if (where.targetType && r.targetType !== where.targetType) return false;
          return true;
        });
        return filtered.slice(0, args?.take ?? filtered.length);
      }),
      groupBy: vi.fn(async (args: any) => {
        const where = args?.where ?? {};
        const orgId = where.orgId as string;
        const since = where.createdAt?.gte as Date | undefined;
        const filtered = rows.filter((r) => {
          if (orgId && r.orgId !== orgId) return false;
          if (since && r.createdAt < since) return false;
          return true;
        });
        const map = new Map<string, Map<boolean, number>>();
        for (const r of filtered) {
          const byEval = map.get(r.evaluatorName) ?? new Map<boolean, number>();
          byEval.set(r.passed, (byEval.get(r.passed) ?? 0) + 1);
          map.set(r.evaluatorName, byEval);
        }
        const out: Array<{ evaluatorName: string; passed: boolean; _count: { _all: number } }> =
          [];
        for (const [evaluatorName, byPassed] of map.entries()) {
          for (const [passed, count] of byPassed.entries()) {
            out.push({ evaluatorName, passed, _count: { _all: count } });
          }
        }
        return out;
      }),
    },
    _rows: rows,
  };

  return prisma;
}

describe("EvaluatorFactService", () => {
  it("recordEvaluatorRun writes a prisma row (includes orgId + evidence)", async () => {
    const prisma = makePrisma();
    const evidenceLedger = { evaluatorRunRecorded: vi.fn(async () => {}) };
    const svc = new EvaluatorFactService(prisma, evidenceLedger as any);

    await svc.recordEvaluatorRun({
      orgId: "org_a",
      targetType: EvaluatorTargetType.ARTIFACT,
      targetId: "artifact_1",
      evaluatorName: "pii_leakage",
      evaluatorVersion: "1.0.0",
      score: 1,
      passed: true,
      reason: "clean",
      latencyMs: 12,
      evidence: { threshold: 0.75 },
      langsmithFeedbackId: "fb_1",
    });

    expect(prisma._rows.length).toBe(1);
    expect(prisma._rows[0]!.orgId).toBe("org_a");
    expect(prisma._rows[0]!.targetId).toBe("artifact_1");
    expect(prisma._rows[0]!.evaluatorName).toBe("pii_leakage");
    expect(prisma._rows[0]!.evaluatorVersion).toBe("1.0.0");
    expect(prisma._rows[0]!.evidence).toMatchObject({ threshold: 0.75, langsmith_feedback_id: "fb_1" });
    expect(evidenceLedger.evaluatorRunRecorded).toHaveBeenCalledTimes(1);
  });

  it("recordEvaluatorRun never throws even if prisma fails", async () => {
    const prisma = makePrisma();
    (prisma.evaluatorRun.create as any).mockImplementationOnce(async () => {
      throw new Error("db down");
    });
    const evidenceLedger = { evaluatorRunRecorded: vi.fn(async () => {}) };
    const svc = new EvaluatorFactService(prisma, evidenceLedger as any);

    await expect(
      svc.recordEvaluatorRun({
        orgId: "org_a",
        targetType: EvaluatorTargetType.ARTIFACT,
        targetId: "artifact_1",
        evaluatorName: "pii_leakage",
        evaluatorVersion: "1.0.0",
        score: 0,
        passed: false,
        latencyMs: 5,
        evidence: {},
      }),
    ).resolves.toBeUndefined();
  });

  it("getRecentRuns enforces tenant isolation (orgA cannot read orgB)", async () => {
    const prisma = makePrisma();
    const evidenceLedger = { evaluatorRunRecorded: vi.fn(async () => {}) };
    const svc = new EvaluatorFactService(prisma, evidenceLedger as any);

    await svc.recordEvaluatorRun({
      orgId: "org_a",
      targetType: EvaluatorTargetType.CLASSIFICATION,
      targetId: "x1",
      evaluatorName: "boilerplate",
      evaluatorVersion: "1.0.0",
      score: 1,
      passed: true,
      latencyMs: 1,
      evidence: {},
    });
    await svc.recordEvaluatorRun({
      orgId: "org_b",
      targetType: EvaluatorTargetType.CLASSIFICATION,
      targetId: "x2",
      evaluatorName: "boilerplate",
      evaluatorVersion: "1.0.0",
      score: 0,
      passed: false,
      latencyMs: 1,
      evidence: {},
    });

    const orgARuns = await svc.getRecentRuns({ orgId: "org_a", limit: 50 });
    expect(orgARuns.length).toBe(1);
    expect(orgARuns[0]!.orgId).toBe("org_a");
  });
});

