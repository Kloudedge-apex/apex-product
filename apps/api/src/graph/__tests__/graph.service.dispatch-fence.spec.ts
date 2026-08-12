import { GraphRunStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../../prisma/prisma.service";
import { GraphService } from "../graph.service";

const graphMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  getState: vi.fn(),
}));

vi.mock("../pipeline-graph", () => ({
  buildPipelineGraph: vi.fn(() => ({
    compile: () => ({
      invoke: graphMocks.invoke,
      getState: graphMocks.getState,
    }),
  })),
}));

function makeHarness(transitionCount: number) {
  const prisma = {
    graphRun: {
      findUnique: vi.fn().mockResolvedValue({
        id: "run_1",
        orgId: "org_1",
        langsmithRootRunId: null,
      }),
      updateMany: vi.fn().mockResolvedValue({ count: transitionCount }),
    },
  } as unknown as PrismaService & {
    graphRun: {
      findUnique: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
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

  it("does not persist FAILED or evaluate when a stale invocation throws", async () => {
    graphMocks.invoke.mockRejectedValueOnce(new Error("stale worker failed"));
    const { service, prisma, evaluator } = makeHarness(0);

    await expect(
      service.processGraphRun("run_1", completedResult(), 7),
    ).rejects.toThrow("stale worker failed");

    expect(prisma.graphRun.updateMany).toHaveBeenCalledWith({
      where: {
        id: "run_1",
        status: GraphRunStatus.RUNNING,
        dispatchGeneration: 7,
      },
      data: expect.objectContaining({ status: GraphRunStatus.FAILED }),
    });
    expect(evaluator.evaluateGraphRun).not.toHaveBeenCalled();
  });

  it("emits approval-requested evidence only after the fenced transition wins", async () => {
    graphMocks.getState.mockResolvedValueOnce({
      tasks: [{ interrupts: [{}] }],
    });
    const { service, evidenceLedger } = makeHarness(0);

    await service.processGraphRun("run_1", completedResult(), 9);

    expect(evidenceLedger.approvalRequested).not.toHaveBeenCalled();
  });
});
