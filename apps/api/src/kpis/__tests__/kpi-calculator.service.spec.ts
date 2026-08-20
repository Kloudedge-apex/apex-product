import { describe, it, expect, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { OutreachArtifactStatus } from "@prisma/client";
import {
  KpiCalculatorService,
  type KpiPrismaClient,
} from "../kpi-calculator.service";

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
  readonly reviewedAt?: Date | null;
  readonly reviewerNote?: string | null;
  readonly failedAt?: Date | null;
};

function artifactMatchesWhere(
  artifact: OutreachArtifactRow,
  where: Prisma.OutreachArtifactWhereInput,
): boolean {
  if (where.status) {
    if (typeof where.status === "string" && artifact.status !== where.status)
      return false;
    if (
      typeof where.status === "object" &&
      where.status.in &&
      !where.status.in.includes(artifact.status)
    ) {
      return false;
    }
    if (
      typeof where.status === "object" &&
      typeof where.status.not === "string" &&
      artifact.status === where.status.not
    ) {
      return false;
    }
    if (
      typeof where.status === "object" &&
      where.status.notIn &&
      where.status.notIn.includes(artifact.status)
    ) {
      return false;
    }
  }
  if (Object.prototype.hasOwnProperty.call(where, "reviewerNote")) {
    if (where.reviewerNote === null && artifact.reviewerNote != null)
      return false;
    if (
      where.reviewerNote &&
      typeof where.reviewerNote === "object" &&
      where.reviewerNote.startsWith &&
      !artifact.reviewerNote?.startsWith(where.reviewerNote.startsWith)
    ) {
      return false;
    }
  }
  if (
    where.failedAt &&
    typeof where.failedAt === "object" &&
    "not" in where.failedAt &&
    where.failedAt.not === null &&
    artifact.failedAt == null
  ) {
    return false;
  }
  const or = Array.isArray(where.OR) ? where.OR : where.OR ? [where.OR] : [];
  if (
    or.length > 0 &&
    !or.some((branch) => artifactMatchesWhere(artifact, branch))
  )
    return false;
  const and = Array.isArray(where.AND)
    ? where.AND
    : where.AND
      ? [where.AND]
      : [];
  if (
    and.length > 0 &&
    !and.every((branch) => artifactMatchesWhere(artifact, branch))
  )
    return false;
  const not = Array.isArray(where.NOT)
    ? where.NOT
    : where.NOT
      ? [where.NOT]
      : [];
  return !not.some((branch) => artifactMatchesWhere(artifact, branch));
}

function ratePrisma({
  graphRunCounts = [0, 0],
  outreachArtifactCounts = [0, 0],
}: {
  readonly graphRunCounts?: readonly number[];
  readonly outreachArtifactCounts?: readonly number[];
} = {}): KpiPrismaClient {
  const remainingGraphRunCounts = [...graphRunCounts];
  const remainingOutreachArtifactCounts = [...outreachArtifactCounts];

  return {
    evidenceEvent: { findMany: async () => [] },
    graphRun: {
      count: async () => remainingGraphRunCounts.shift() ?? 0,
    },
    outreachArtifact: {
      count: async () => remainingOutreachArtifactCounts.shift() ?? 0,
    },
    leadScore: {
      findMany: async () => [],
      count: async () => 0,
    },
  };
}

describe("KpiCalculatorService", () => {
  it("returns a null graph error rate when no graph runs were measured", async () => {
    const svc = new KpiCalculatorService(
      ratePrisma({ graphRunCounts: [0, 0] }),
    );

    const operational = await svc.operational("org_a", { windowDays: 7 });

    expect(operational.graph_runs_total).toBe(0);
    expect(operational.graph_runs_failed).toBe(0);
    expect(operational.graph_error_rate).toBeNull();
  });

  it("computes the graph error rate when graph runs were measured", async () => {
    const svc = new KpiCalculatorService(
      ratePrisma({ graphRunCounts: [4, 1] }),
    );

    const operational = await svc.operational("org_a", { windowDays: 7 });

    expect(operational.graph_runs_total).toBe(4);
    expect(operational.graph_runs_failed).toBe(1);
    expect(operational.graph_error_rate).toBeCloseTo(0.25);
  });

  it("returns a null rejection rate when no artifacts were reviewed", async () => {
    const svc = new KpiCalculatorService(
      ratePrisma({ outreachArtifactCounts: [0, 0] }),
    );

    const guarantee = await svc.guaranteeDefense("org_a", { windowDays: 7 });

    expect(guarantee.rejected_artifacts).toBe(0);
    expect(guarantee.reviewed_artifacts).toBe(0);
    expect(guarantee.rejection_rate).toBeNull();
  });

  it("computes the rejection rate when artifacts were reviewed", async () => {
    const svc = new KpiCalculatorService(
      ratePrisma({ outreachArtifactCounts: [1, 4] }),
    );

    const guarantee = await svc.guaranteeDefense("org_a", { windowDays: 7 });

    expect(guarantee.rejected_artifacts).toBe(1);
    expect(guarantee.reviewed_artifacts).toBe(4);
    expect(guarantee.rejection_rate).toBeCloseTo(0.25);
  });

  it("reports dispatch failures separately from human rejections", async () => {
    const svc = new KpiCalculatorService(
      ratePrisma({ outreachArtifactCounts: [2, 3, 4, 5, 6] }),
    );

    const quality = await svc.quality("org_a", { windowDays: 7 });

    expect(quality.outreach_artifacts).toEqual({
      pending_review: 2,
      approved: 3,
      rejected: 4,
      failed: 5,
      sent: 6,
    });
  });

  it("uses authoritative lifecycle timestamps for quality windows", async () => {
    const count = vi.fn(
      async (_args: Prisma.OutreachArtifactCountArgs): Promise<number> => 0,
    );
    const svc = new KpiCalculatorService({
      evidenceEvent: { findMany: async () => [] },
      graphRun: { count: async () => 0 },
      outreachArtifact: { count },
      leadScore: {
        findMany: async () => [],
        count: async () => 0,
      },
    });

    await svc.quality("org_a", { windowDays: 7 });

    const wheres = count.mock.calls.map(([args]) => args.where);
    expect(wheres).toHaveLength(5);
    expect(wheres[0]).toMatchObject({
      orgId: "org_a",
      status: OutreachArtifactStatus.PENDING_REVIEW,
      createdAt: { gte: expect.any(Date) },
    });
    expect(wheres[1]).toMatchObject({
      orgId: "org_a",
      status: OutreachArtifactStatus.APPROVED,
      reviewedAt: { gte: expect.any(Date) },
    });
    expect(wheres[2]).toMatchObject({
      orgId: "org_a",
      reviewedAt: { gte: expect.any(Date) },
    });
    expect(wheres[3]).toMatchObject({
      orgId: "org_a",
      failedAt: { gte: expect.any(Date) },
    });
    expect(wheres[4]).toMatchObject({
      orgId: "org_a",
      status: OutreachArtifactStatus.SENT,
      sentAt: { gte: expect.any(Date) },
    });
    for (const where of wheres) {
      expect(where).not.toHaveProperty("updatedAt");
    }
  });

  it("isolates orgId and keeps reviewed suppressions in guaranteeDefense", async () => {
    const now = new Date();
    const evidence: EvidenceRow[] = [
      {
        orgId: "org_a",
        kind: "message.drafted",
        createdAt: now,
        payload: {
          kind: "message.drafted",
          cost_usd: 1.25,
          tokens_used: 10,
          model: "m",
        },
      },
      {
        orgId: "org_b",
        kind: "message.drafted",
        createdAt: now,
        payload: {
          kind: "message.drafted",
          cost_usd: 99.0,
          tokens_used: 10,
          model: "m",
        },
      },
    ];

    const leadScores: LeadScoreRow[] = [
      { orgId: "org_a", score: 80, updatedAt: now },
      { orgId: "org_b", score: 80, updatedAt: now },
      { orgId: "org_b", score: 80, updatedAt: now },
    ];

    const artifacts: OutreachArtifactRow[] = [
      {
        orgId: "org_a",
        status: OutreachArtifactStatus.REJECTED,
        updatedAt: now,
        reviewedAt: now,
        reviewerNote: "off tone",
      },
      {
        orgId: "org_a",
        status: OutreachArtifactStatus.REJECTED,
        updatedAt: now,
        reviewedAt: now,
        reviewerNote: "auto-failed: legacy retry exhaustion",
      },
      {
        orgId: "org_a",
        status: OutreachArtifactStatus.REJECTED,
        updatedAt: now,
        reviewedAt: now,
        reviewerNote: "auto-failed: gated transition failure",
        failedAt: now,
      },
      {
        orgId: "org_a",
        status: OutreachArtifactStatus.FAILED,
        updatedAt: now,
        reviewedAt: now,
      },
      {
        orgId: "org_a",
        status: OutreachArtifactStatus.REJECTED,
        updatedAt: now,
        reviewedAt: now,
        reviewerNote: null,
      },
      {
        orgId: "org_a",
        status: OutreachArtifactStatus.SUPPRESSED,
        updatedAt: now,
        reviewedAt: now,
      },
      {
        orgId: "org_a",
        status: OutreachArtifactStatus.SUPPRESSED,
        updatedAt: now,
        reviewedAt: null,
      },
      {
        orgId: "org_b",
        status: OutreachArtifactStatus.REJECTED,
        updatedAt: now,
        reviewedAt: now,
      },
      {
        orgId: "org_b",
        status: OutreachArtifactStatus.APPROVED,
        updatedAt: now,
        reviewedAt: now,
      },
    ];

    let lastEvidenceOrgId: string | undefined;
    let lastLeadScoreOrgId: string | undefined;
    let lastArtifactOrgId: string | undefined;

    const prisma: KpiPrismaClient = {
      evidenceEvent: {
        findMany: async (args: Prisma.EvidenceEventFindManyArgs) => {
          const where = args.where;
          const orgId = typeof where?.orgId === "string" ? where.orgId : "";
          if (!orgId)
            throw new Error("evidenceEvent.findMany missing where.orgId");
          lastEvidenceOrgId = orgId;

          const createdAt = where?.createdAt;
          const since =
            createdAt &&
            typeof createdAt === "object" &&
            createdAt !== null &&
            "gte" in createdAt
              ? createdAt.gte
              : undefined;
          if (!(since instanceof Date))
            throw new Error("evidenceEvent.findMany missing createdAt.gte");

          const kinds =
            where?.kind &&
            typeof where.kind === "object" &&
            where.kind &&
            "in" in where.kind
              ? where.kind.in
              : undefined;
          const kindSet = new Set(
            Array.isArray(kinds)
              ? kinds.filter((k): k is string => typeof k === "string")
              : [],
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
            updatedAt &&
            typeof updatedAt === "object" &&
            updatedAt !== null &&
            "gte" in updatedAt
              ? updatedAt.gte
              : undefined;
          if (!(since instanceof Date))
            throw new Error("leadScore.count missing updatedAt.gte");

          const score = where?.score;
          const gte =
            score &&
            typeof score === "object" &&
            score !== null &&
            "gte" in score
              ? score.gte
              : 0;
          const minScore = typeof gte === "number" ? gte : 0;

          return leadScores
            .filter((s) => s.orgId === orgId)
            .filter((s) => s.updatedAt >= since)
            .filter((s) => s.score >= minScore).length;
        },
      },
      outreachArtifact: {
        count: async (args: Prisma.OutreachArtifactCountArgs) => {
          const where = args.where;
          const orgId = typeof where?.orgId === "string" ? where.orgId : "";
          if (!orgId)
            throw new Error("outreachArtifact.count missing where.orgId");
          lastArtifactOrgId = orgId;

          const updatedAt = where?.updatedAt ?? where?.reviewedAt;
          const since =
            updatedAt &&
            typeof updatedAt === "object" &&
            updatedAt !== null &&
            "gte" in updatedAt
              ? updatedAt.gte
              : undefined;
          if (!(since instanceof Date)) {
            throw new Error(
              "outreachArtifact.count missing lifecycle timestamp gte",
            );
          }

          return artifacts
            .filter((a) => a.orgId === orgId)
            .filter(
              (a) =>
                (where?.reviewedAt
                  ? (a.reviewedAt ?? new Date(0))
                  : a.updatedAt) >= since,
            )
            .filter((a) => artifactMatchesWhere(a, where ?? {})).length;
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
    expect(guarantee.rejected_artifacts).toBe(2);
    expect(guarantee.reviewed_artifacts).toBe(5);
    expect(guarantee.rejection_rate).toBeCloseTo(0.4);

    expect(lastEvidenceOrgId).toBe("org_a");
    expect(lastLeadScoreOrgId).toBe("org_a");
    expect(lastArtifactOrgId).toBe("org_a");
  });
});
