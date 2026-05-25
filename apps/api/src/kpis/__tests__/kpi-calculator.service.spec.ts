import { describe, it, expect } from "vitest";
import type { Prisma } from "@prisma/client";
import { OutreachArtifactStatus } from "@prisma/client";
import { KpiCalculatorService, type KpiPrismaClient } from "../kpi-calculator.service";

type EvidenceRow = {
  readonly orgId: string;
  readonly kind: string;
  readonly createdAt: Date;
  readonly payload: Prisma.JsonValue;
};

type LeadScoreRow = {
  readonly orgId: string;
  readonly score: number;
  readonly updatedAt: Date;
};

type OutreachArtifactRow = {
  readonly orgId: string;
  readonly status: OutreachArtifactStatus;
  readonly updatedAt: Date;
};

describe("KpiCalculatorService", () => {
  it("isolates orgId across KPI queries (commercial + guaranteeDefense)", async () => {
    const now = new Date();
    const evidence: EvidenceRow[] = [
      {
        orgId: "org_a",
        kind: "message.drafted",
        createdAt: now,
        payload: { kind: "message.drafted", cost_usd: 1.25, tokens_used: 10, model: "m" },
      },
      {
        orgId: "org_b",
        kind: "message.drafted",
        createdAt: now,
        payload: { kind: "message.drafted", cost_usd: 99.0, tokens_used: 10, model: "m" },
      },
    ];

    const leadScores: LeadScoreRow[] = [
      { orgId: "org_a", score: 80, updatedAt: now },
      { orgId: "org_b", score: 80, updatedAt: now },
      { orgId: "org_b", score: 80, updatedAt: now },
    ];

    const artifacts: OutreachArtifactRow[] = [
      { orgId: "org_a", status: OutreachArtifactStatus.REJECTED, updatedAt: now },
      { orgId: "org_b", status: OutreachArtifactStatus.REJECTED, updatedAt: now },
      { orgId: "org_b", status: OutreachArtifactStatus.APPROVED, updatedAt: now },
    ];

    let lastEvidenceOrgId: string | undefined;
    let lastLeadScoreOrgId: string | undefined;
    let lastArtifactOrgId: string | undefined;

    const prisma: KpiPrismaClient = {
      evidenceEvent: {
        findMany: async (args: Prisma.EvidenceEventFindManyArgs) => {
          const where = args.where;
          const orgId = typeof where?.orgId === "string" ? where.orgId : "";
          if (!orgId) throw new Error("evidenceEvent.findMany missing where.orgId");
          lastEvidenceOrgId = orgId;

          const createdAt = where?.createdAt;
          const since =
            createdAt && typeof createdAt === "object" && createdAt !== null && "gte" in createdAt
              ? createdAt.gte
              : undefined;
          if (!(since instanceof Date)) throw new Error("evidenceEvent.findMany missing createdAt.gte");

          const kinds =
            where?.kind && typeof where.kind === "object" && where.kind && "in" in where.kind
              ? where.kind.in
              : undefined;
          const kindSet = new Set(
            Array.isArray(kinds) ? kinds.filter((k): k is string => typeof k === "string") : [],
          );

          return evidence
            .filter((e) => e.orgId === orgId)
            .filter((e) => e.createdAt >= since)
            .filter((e) => (kindSet.size > 0 ? kindSet.has(e.kind) : true))
            .map((e) => ({ payload: e.payload }));
        },
      },
      leadScore: {
        findMany: async () => [],
        count: async (args: Prisma.LeadScoreCountArgs) => {
          const where = args.where;
          const orgId = typeof where?.orgId === "string" ? where.orgId : "";
          if (!orgId) throw new Error("leadScore.count missing where.orgId");
          lastLeadScoreOrgId = orgId;

          const updatedAt = where?.updatedAt;
          const since =
            updatedAt && typeof updatedAt === "object" && updatedAt !== null && "gte" in updatedAt
              ? updatedAt.gte
              : undefined;
          if (!(since instanceof Date)) throw new Error("leadScore.count missing updatedAt.gte");

          const score = where?.score;
          const gte =
            score && typeof score === "object" && score !== null && "gte" in score ? score.gte : 0;
          const minScore = typeof gte === "number" ? gte : 0;

          return leadScores
            .filter((s) => s.orgId === orgId)
            .filter((s) => s.updatedAt >= since)
            .filter((s) => s.score >= minScore)
            .length;
        },
      },
      outreachArtifact: {
        count: async (args: Prisma.OutreachArtifactCountArgs) => {
          const where = args.where;
          const orgId = typeof where?.orgId === "string" ? where.orgId : "";
          if (!orgId) throw new Error("outreachArtifact.count missing where.orgId");
          lastArtifactOrgId = orgId;

          const updatedAt = where?.updatedAt;
          const since =
            updatedAt && typeof updatedAt === "object" && updatedAt !== null && "gte" in updatedAt
              ? updatedAt.gte
              : undefined;
          if (!(since instanceof Date)) throw new Error("outreachArtifact.count missing updatedAt.gte");

          const status = where?.status;
          const allowedStatuses: OutreachArtifactStatus[] = [];
          if (typeof status === "string") {
            if (Object.values(OutreachArtifactStatus).includes(status as OutreachArtifactStatus)) {
              allowedStatuses.push(status as OutreachArtifactStatus);
            }
          } else if (
            status &&
            typeof status === "object" &&
            "in" in status &&
            Array.isArray((status as { in?: unknown }).in)
          ) {
            for (const v of (status as { in: unknown[] }).in) {
              if (
                typeof v === "string" &&
                Object.values(OutreachArtifactStatus).includes(v as OutreachArtifactStatus)
              ) {
                allowedStatuses.push(v as OutreachArtifactStatus);
              }
            }
          }
          const statusSet = new Set(allowedStatuses);

          return artifacts
            .filter((a) => a.orgId === orgId)
            .filter((a) => a.updatedAt >= since)
            .filter((a) => (statusSet.size > 0 ? statusSet.has(a.status) : true))
            .length;
        },
      },
      graphRun: { count: async () => 0 },
    };

    const svc = new KpiCalculatorService(prisma);
    const window = { windowDays: 7 };

    const commercial = await svc.commercial("org_a", window);
    expect(commercial.cost_usd).toBeCloseTo(1.25);
    expect(commercial.qualified_leads).toBe(1);
    expect(commercial.cost_per_qualified_lead_usd).toBeCloseTo(1.25);

    const guarantee = await svc.guaranteeDefense("org_a", window);
    expect(guarantee.rejected_artifacts).toBe(1);
    expect(guarantee.reviewed_artifacts).toBe(1);
    expect(guarantee.rejection_rate).toBeCloseTo(1);

    expect(lastEvidenceOrgId).toBe("org_a");
    expect(lastLeadScoreOrgId).toBe("org_a");
    expect(lastArtifactOrgId).toBe("org_a");
  });
});
