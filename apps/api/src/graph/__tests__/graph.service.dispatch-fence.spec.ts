import { GraphRunStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../../prisma/prisma.service";
import { GraphService } from "../graph.service";
import { StageFailureError } from "../pipeline-graph";

const graphMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  getState: vi.fn(),
  StageFailureError: class StageFailureError extends Error {
    constructor(
      readonly stage: string,
      readonly reason: string,
    ) {
      super(`${stage}:${reason}`);
      this.name = "StageFailureError";
    }
  },
}));

vi.mock("../pipeline-graph", () => ({
  buildPipelineGraph: vi.fn(() => ({
    compile: () => ({
      invoke: graphMocks.invoke,
      getState: graphMocks.getState,
    }),
  })),
  StageFailureError: graphMocks.StageFailureError,
}));

function makeHarness(transitionCount: number) {
  const prisma = {
    graphRun: {
      findUnique: vi.fn().mockResolvedValue({
        id: "run_1",
        orgId: "org_1",
        langsmithRootRunId: null,
      }),
      findFirst: vi.fn().mockResolvedValue({
        id: "run_1",
        orgId: "org_1",
        threadId: "run_1",
        startIcpProfileIds: ["icp_1"],
        pendingResumeApproved: null,
      }),
      updateMany: vi.fn().mockResolvedValue({ count: transitionCount }),
    },
    graphCheckpoint: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
  } as unknown as PrismaService & {
    graphRun: {
      findUnique: ReturnType<typeof vi.fn>;
      findFirst: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
    };
    graphCheckpoint: {
      findFirst: ReturnType<typeof vi.fn>;
    };
  };
  const evidenceLedger = {
    approvalRequested: vi.fn().mockResolvedValue(undefined),
  };
  const evaluator = {
    evaluateGraphRun: vi.fn().mockResolvedValue(undefined),
  };
  const service = new GraphService(
    prisma,
    {} as never,
    {} as never,
    {} as never,
    evidenceLedger as never,
    {} as never,
    evaluator as never,
    { createRootRun: vi.fn().mockResolvedValue(null) } as never,
  );
  return { service, prisma, evidenceLedger, evaluator };
}

function completedResult() {
  return {
    orgId: "org_1",
    runId: "run_1",
    icpProfileIds: ["icp_1"],
    stagesCompleted: ["sourcing"],
    approved: false,
    messages: [],
    errors: [],
  };
}

describe("GraphService dispatch-generation lifecycle fence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    graphMocks.invoke.mockResolvedValue(completedResult());
    graphMocks.getState.mockResolvedValue({ tasks: [] });
  });

  it("does not complete or evaluate a run after its generation was superseded", async () => {
    const { service, prisma, evaluator } = makeHarness(0);

    await service.processGraphRun(
      "run_1",
      completedResult(),
      4,
    );

    expect(prisma.graphRun.updateMany).toHaveBeenCalledWith({
      where: {
        id: "run_1",
        status: GraphRunStatus.RUNNING,
        dispatchGeneration: 4,
      },
      data: expect.objectContaining({ status: GraphRunStatus.COMPLETED }),
    });
    expect(evaluator.evaluateGraphRun).not.toHaveBeenCalled();
  });

  it("leaves a retryable invocation failure RUNNING for BullMQ", async () => {
    graphMocks.invoke.mockRejectedValueOnce(new Error("stale worker failed"));
    const { service, prisma, evaluator } = makeHarness(0);

    await expect(
      service.processGraphRun("run_1", completedResult(), 7),
    ).rejects.toThrow("stale worker failed");

    expect(prisma.graphRun.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: GraphRunStatus.FAILED }),
      }),
    );
    expect(evaluator.evaluateGraphRun).not.toHaveBeenCalled();
  });

  it("rebuilds a missing-checkpoint continuation from the durable start seed", async () => {
    const { service, prisma } = makeHarness(1);

    await service.processGraphRun("run_1", null, 8);

    expect(prisma.graphCheckpoint.findFirst).toHaveBeenCalledWith({
      where: { threadId: "run_1", checkpointNamespace: "" },
      select: { checkpointId: true },
    });
    expect(graphMocks.invoke).toHaveBeenCalledWith(
      {
        orgId: "org_1",
        runId: "run_1",
        icpProfileIds: ["icp_1"],
      },
      { configurable: { thread_id: "run_1" } },
    );
  });

  it("keeps null continuation when the root checkpoint exists", async () => {
    const { service, prisma } = makeHarness(1);
    prisma.graphCheckpoint.findFirst.mockResolvedValueOnce({
      checkpointId: "checkpoint_1",
    });

    await service.processGraphRun("run_1", null, 8);

    expect(graphMocks.invoke).toHaveBeenCalledWith(null, {
      configurable: { thread_id: "run_1" },
    });
  });

  it("refuses to replace a pending reviewer decision with a start seed", async () => {
    const { service, prisma } = makeHarness(1);
    prisma.graphRun.findFirst.mockResolvedValueOnce({
      id: "run_1",
      orgId: "org_1",
      threadId: "run_1",
      startIcpProfileIds: ["icp_1"],
      pendingResumeApproved: false,
    });

    await expect(service.processGraphRun("run_1", null, 8)).rejects.toThrow(
      "pending reviewer decision but no root checkpoint",
    );
    expect(graphMocks.invoke).not.toHaveBeenCalled();
  });

  it("marks a deterministic stage failure terminal immediately", async () => {
    graphMocks.invoke.mockRejectedValueOnce(
      new StageFailureError("sourcing", "no_companies"),
    );
    const { service, prisma, evaluator } = makeHarness(1);

    await expect(
      service.processGraphRun("run_1", completedResult(), 10),
    ).rejects.toThrow("sourcing:no_companies");

    expect(prisma.graphRun.updateMany).toHaveBeenCalledWith({
      where: {
        id: "run_1",
        status: GraphRunStatus.RUNNING,
        dispatchGeneration: 10,
      },
      data: expect.objectContaining({
        status: GraphRunStatus.FAILED,
        error: "sourcing:no_companies",
      }),
    });
    expect(evaluator.evaluateGraphRun).toHaveBeenCalledWith("run_1");
  });

  it("emits approval-requested evidence only after the fenced transition wins", async () => {
    graphMocks.getState.mockResolvedValueOnce({
      tasks: [{ interrupts: [{}] }],
    });
    const { service, evidenceLedger } = makeHarness(0);

    await service.processGraphRun("run_1", completedResult(), 9);

    expect(evidenceLedger.approvalRequested).not.toHaveBeenCalled();
  });

  it("persists terminal FAILED when a completed graph state contains a failed stage", async () => {
    graphMocks.invoke.mockResolvedValueOnce({
      ...completedResult(),
      stageStatuses: { outreach: "FAILED" },
      outreachResults: [
        {
          personId: "p1",
          agentRunId: "artifact_1",
          status: "queued",
        },
        { personId: "p2", status: "failed", error: "no_eligible_email" },
        // A nominal queued outcome without a persisted artifact is not a
        // generated draft and must not inflate the public count.
        { personId: "p3", status: "queued" },
      ],
    });
    const { service, prisma, evaluator } = makeHarness(1);

    await service.processGraphRun("run_1", completedResult(), 11);

    expect(prisma.graphRun.updateMany).toHaveBeenCalledWith({
      where: {
        id: "run_1",
        status: GraphRunStatus.RUNNING,
        dispatchGeneration: 11,
      },
      data: expect.objectContaining({
        status: GraphRunStatus.FAILED,
        error: "pipeline_failed:outreach (outreach_failures=1)",
        state: expect.objectContaining({
          stageStatuses: { outreach: "FAILED" },
          counts: expect.objectContaining({ outreach: 1, outreachFailed: 1 }),
          outreachFailures: [
            { personId: "p2", error: "no_eligible_email" },
          ],
        }),
      }),
    });
    expect(evaluator.evaluateGraphRun).toHaveBeenCalledWith("run_1");
  });

  it("completes a partial outreach run while reporting only persisted drafts", async () => {
    graphMocks.invoke.mockResolvedValueOnce({
      ...completedResult(),
      stageStatuses: { outreach: "PARTIAL" },
      outreachResults: [
        {
          personId: "p1",
          agentRunId: "artifact_1",
          status: "queued",
        },
        { personId: "p2", status: "failed", error: "draft_failed" },
        {
          personId: "p3",
          agentRunId: "artifact_rejected",
          status: "persisted",
          artifactStatus: "REJECTED",
        },
        {
          personId: "p4",
          agentRunId: "artifact_1",
          status: "queued",
        },
      ],
    });
    const { service, prisma } = makeHarness(1);

    await service.processGraphRun("run_1", completedResult(), 12);

    expect(prisma.graphRun.updateMany).toHaveBeenCalledWith({
      where: {
        id: "run_1",
        status: GraphRunStatus.RUNNING,
        dispatchGeneration: 12,
      },
      data: expect.objectContaining({
        status: GraphRunStatus.COMPLETED,
        state: expect.objectContaining({
          counts: expect.objectContaining({ outreach: 2, outreachFailed: 1 }),
        }),
      }),
    });
  });
});
