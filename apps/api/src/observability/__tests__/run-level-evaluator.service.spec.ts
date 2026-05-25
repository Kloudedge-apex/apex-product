import { describe, it, expect, vi, beforeEach } from "vitest";
import { GraphRunStatus, OutreachArtifactStatus } from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { RunLevelEvaluatorService } from "../run-level-evaluator.service";
import type { LangSmithService } from "../langsmith.service";

type GraphRunRow = {
  readonly id: string;
  readonly orgId: string;
  readonly status: GraphRunStatus;
  readonly startedAt: Date;
  readonly completedAt: Date | null;
};

type FakeLeadScore = { readonly orgId: string; readonly score: number; readonly updatedAt: Date };
type FakeEvidenceEvent = {
  readonly orgId: string;
  readonly runId: string | null;
  readonly kind: string;
};
type FakeArtifact = {
  readonly orgId: string;
  readonly graphRunId: string | null;
  readonly status: OutreachArtifactStatus;
};

interface Fixtures {
  readonly graphRuns: readonly GraphRunRow[];
  readonly leadScores: readonly FakeLeadScore[];
  readonly evidenceEvents: readonly FakeEvidenceEvent[];
  readonly artifacts: readonly FakeArtifact[];
}

function makePrisma(fx: Fixtures) {
  return {
    graphRun: {
      findUnique: async (args: Prisma.GraphRunFindUniqueArgs) => {
        const id = (args.where as { id?: string }).id;
        return fx.graphRuns.find((r) => r.id === id) ?? null;
      },
    },
    leadScore: {
      count: async (args: Prisma.LeadScoreCountArgs) => {
        const where = args.where ?? {};
        const orgId =
          typeof (where as { orgId?: unknown }).orgId === "string"
            ? ((where as { orgId: string }).orgId)
            : "";
        const scoreFilter = (where as { score?: { gte?: number } }).score;
        const gte = scoreFilter?.gte ?? -Infinity;
        const updatedAt = (where as { updatedAt?: { gte?: Date; lte?: Date } }).updatedAt;
        const since = updatedAt?.gte ?? new Date(0);
        const until = updatedAt?.lte ?? new Date("9999-01-01");
        return fx.leadScores.filter(
          (s) => s.orgId === orgId && s.score >= gte && s.updatedAt >= since && s.updatedAt <= until,
        ).length;
      },
    },
    evidenceEvent: {
      count: async (args: Prisma.EvidenceEventCountArgs) => {
        const where = args.where ?? {};
        const orgId = (where as { orgId?: string }).orgId ?? "";
        const runId = (where as { runId?: string | null }).runId ?? null;
        const kind = (where as { kind?: string }).kind;
        return fx.evidenceEvents.filter(
          (e) =>
            e.orgId === orgId &&
            e.runId === runId &&
            (kind ? e.kind === kind : true),
        ).length;
      },
    },
    outreachArtifact: {
      count: async (args: Prisma.OutreachArtifactCountArgs) => {
        const where = args.where ?? {};
        const orgId = (where as { orgId?: string }).orgId ?? "";
        const graphRunId = (where as { graphRunId?: string | null }).graphRunId ?? null;
        const status = (where as { status?: OutreachArtifactStatus }).status;
        return fx.artifacts.filter(
          (a) =>
            a.orgId === orgId &&
            a.graphRunId === graphRunId &&
            (status ? a.status === status : true),
        ).length;
      },
    },
  };
}

function makeLangSmith(): {
  langsmith: LangSmithService;
  feedbacks: Array<{ key: string; score?: number; value?: unknown; comment?: string }>;
} {
  const feedbacks: Array<{ key: string; score?: number; value?: unknown; comment?: string }> = [];
  const langsmith = {
    createFeedback: vi.fn(async (input: {
      key: string;
      score?: number;
      value?: string | number | boolean;
      comment?: string;
    }) => {
      feedbacks.push({
        key: input.key,
        score: input.score,
        value: input.value,
        comment: input.comment,
      });
    }),
  } as unknown as LangSmithService;
  return { langsmith, feedbacks };
}

const ORG = "org_x";
const RUN = "run_x";
const START = new Date("2026-05-25T00:00:00Z");
const END = new Date("2026-05-25T01:00:00Z");

describe("RunLevelEvaluatorService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("COMPLETED run with 10 qualified leads, 5 approved, 5 sent → high composite + posts feedback", async () => {
    const fx: Fixtures = {
      graphRuns: [
        { id: RUN, orgId: ORG, status: GraphRunStatus.COMPLETED, startedAt: START, completedAt: END },
      ],
      leadScores: Array.from({ length: 10 }).map(() => ({
        orgId: ORG,
        score: 90,
        updatedAt: new Date(START.getTime() + 60_000),
      })),
      evidenceEvents: Array.from({ length: 5 }).map(() => ({
        orgId: ORG,
        runId: RUN,
        kind: "message.sent",
      })),
      artifacts: Array.from({ length: 5 }).map(() => ({
        orgId: ORG,
        graphRunId: RUN,
        status: OutreachArtifactStatus.APPROVED,
      })),
    };
    const prisma = makePrisma(fx);
    const { langsmith, feedbacks } = makeLangSmith();

    const svc = new RunLevelEvaluatorService(
      prisma as unknown as ConstructorParameters<typeof RunLevelEvaluatorService>[0],
      langsmith,
    );
    svc.recordLangSmithRunId(RUN, "ls_root_run_id");

    const score = await svc.evaluateGraphRun(RUN);

    expect(score).not.toBeNull();
    expect(score!.subScores.pipeline_completed).toBe(1);
    expect(score!.subScores.qualified_leads_produced).toBe(1); // capped at 1
    expect(score!.subScores.messages_reached_send).toBe(1); // 5/5
    expect(score!.subScores.approval_drop_off_rate).toBe(1); // 0 rejected of 5
    expect(score!.composite_score).toBeCloseTo(1, 5);
    expect(score!.verdict).toBe("pass");

    const composite = feedbacks.find((f) => f.key === "run_outcome_composite");
    expect(composite).toBeDefined();
    expect(composite!.score).toBeCloseTo(1, 5);
    expect(composite!.value).toBe("pass");
    expect(feedbacks.some((f) => f.key === "run_completion")).toBe(true);
    expect(feedbacks.some((f) => f.key === "run_qualified_leads")).toBe(true);
    expect(feedbacks.some((f) => f.key === "run_send_rate")).toBe(true);
    expect(feedbacks.some((f) => f.key === "run_approval_drop_off")).toBe(true);
  });

  it("FAILED run with zero outputs → low composite, verdict=fail", async () => {
    const fx: Fixtures = {
      graphRuns: [
        { id: RUN, orgId: ORG, status: GraphRunStatus.FAILED, startedAt: START, completedAt: END },
      ],
      leadScores: [],
      evidenceEvents: [],
      artifacts: [],
    };
    const prisma = makePrisma(fx);
    const { langsmith } = makeLangSmith();

    const svc = new RunLevelEvaluatorService(
      prisma as unknown as ConstructorParameters<typeof RunLevelEvaluatorService>[0],
      langsmith,
    );
    svc.recordLangSmithRunId(RUN, "ls_root");

    const score = await svc.evaluateGraphRun(RUN);

    expect(score).not.toBeNull();
    expect(score!.subScores.pipeline_completed).toBe(0);
    expect(score!.subScores.qualified_leads_produced).toBe(0);
    expect(score!.subScores.messages_reached_send).toBe(0); // 0 sent / max(0,1)
    // No artifacts at all → rejectionRate is 0 → approval_drop_off_rate is 1
    expect(score!.subScores.approval_drop_off_rate).toBe(1);
    // Composite = (0 + 0 + 0 + 1) / 4 = 0.25 → fail
    expect(score!.composite_score).toBeCloseTo(0.25, 5);
    expect(score!.verdict).toBe("fail");
  });

  it("AWAITING_APPROVAL run → pipeline_completed sub-score is 0.5", async () => {
    const fx: Fixtures = {
      graphRuns: [
        {
          id: RUN,
          orgId: ORG,
          status: GraphRunStatus.AWAITING_APPROVAL,
          startedAt: START,
          completedAt: null,
        },
      ],
      leadScores: [],
      evidenceEvents: [],
      artifacts: [],
    };
    const prisma = makePrisma(fx);
    const { langsmith } = makeLangSmith();

    const svc = new RunLevelEvaluatorService(
      prisma as unknown as ConstructorParameters<typeof RunLevelEvaluatorService>[0],
      langsmith,
    );
    svc.recordLangSmithRunId(RUN, "ls_root");

    const score = await svc.evaluateGraphRun(RUN);

    expect(score).not.toBeNull();
    expect(score!.subScores.pipeline_completed).toBe(0.5);
  });

  it("no LangSmith root run id → evaluation runs, feedback is not posted (no throw)", async () => {
    const fx: Fixtures = {
      graphRuns: [
        { id: RUN, orgId: ORG, status: GraphRunStatus.COMPLETED, startedAt: START, completedAt: END },
      ],
      leadScores: [{ orgId: ORG, score: 90, updatedAt: new Date(START.getTime() + 60_000) }],
      evidenceEvents: [],
      artifacts: [],
    };
    const prisma = makePrisma(fx);
    const { langsmith, feedbacks } = makeLangSmith();

    const svc = new RunLevelEvaluatorService(
      prisma as unknown as ConstructorParameters<typeof RunLevelEvaluatorService>[0],
      langsmith,
    );
    // intentionally do NOT call recordLangSmithRunId

    const score = await svc.evaluateGraphRun(RUN);

    expect(score).not.toBeNull();
    expect(feedbacks).toEqual([]);
    expect(langsmith.createFeedback).not.toHaveBeenCalled();
  });

  it("composite_score equals the arithmetic mean of the four sub-scores (within 0.01)", async () => {
    // status COMPLETED → 1
    // 2 qualified / 5 target = 0.4
    // 3 sent / max(3 approved, 1) = 1.0 (clamped via Math.max + min)
    // 1 rejected / 4 total = 0.25 → drop_off score = 1 - 0.25 = 0.75
    // mean = (1 + 0.4 + 1.0 + 0.75) / 4 = 0.7875
    const fx: Fixtures = {
      graphRuns: [
        { id: RUN, orgId: ORG, status: GraphRunStatus.COMPLETED, startedAt: START, completedAt: END },
      ],
      leadScores: Array.from({ length: 2 }).map(() => ({
        orgId: ORG,
        score: 80,
        updatedAt: new Date(START.getTime() + 60_000),
      })),
      evidenceEvents: Array.from({ length: 3 }).map(() => ({
        orgId: ORG,
        runId: RUN,
        kind: "message.sent",
      })),
      artifacts: [
        ...Array.from({ length: 3 }).map(() => ({
          orgId: ORG,
          graphRunId: RUN,
          status: OutreachArtifactStatus.APPROVED,
        })),
        { orgId: ORG, graphRunId: RUN, status: OutreachArtifactStatus.REJECTED },
      ],
    };
    const prisma = makePrisma(fx);
    const { langsmith } = makeLangSmith();

    const svc = new RunLevelEvaluatorService(
      prisma as unknown as ConstructorParameters<typeof RunLevelEvaluatorService>[0],
      langsmith,
    );
    svc.recordLangSmithRunId(RUN, "ls_root");

    const score = await svc.evaluateGraphRun(RUN);

    expect(score).not.toBeNull();
    const expectedMean =
      (score!.subScores.pipeline_completed +
        score!.subScores.qualified_leads_produced +
        score!.subScores.messages_reached_send +
        score!.subScores.approval_drop_off_rate) /
      4;
    expect(Math.abs(score!.composite_score - expectedMean)).toBeLessThan(0.01);
    expect(score!.composite_score).toBeCloseTo(0.7875, 2);
  });

  it("returns null and does not throw when GraphRun row is missing", async () => {
    const fx: Fixtures = {
      graphRuns: [],
      leadScores: [],
      evidenceEvents: [],
      artifacts: [],
    };
    const prisma = makePrisma(fx);
    const { langsmith } = makeLangSmith();

    const svc = new RunLevelEvaluatorService(
      prisma as unknown as ConstructorParameters<typeof RunLevelEvaluatorService>[0],
      langsmith,
    );

    const result = await svc.evaluateGraphRun("missing");
    expect(result).toBeNull();
    expect(langsmith.createFeedback).not.toHaveBeenCalled();
  });
});
