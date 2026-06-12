import { describe, it, expect, beforeEach, vi } from "vitest";
import { GraphRun, GraphRunStatus } from "@prisma/client";
import { Command } from "@langchain/langgraph";
import { GraphRunWorker } from "../graph-run.worker";
import {
  GraphRunQueueService,
  EnqueueGraphRunInput,
} from "../graph-run-queue.service";
import { GraphService } from "../graph.service";
import { PrismaService } from "../../prisma/prisma.service";

function graphRunRow(overrides: Partial<GraphRun> = {}): GraphRun {
  const now = new Date("2026-05-25T12:00:00Z");
  return {
    id: "graph_1",
    orgId: "org_1",
    threadId: "graph_1",
    graphName: "pipeline-supervisor",
    status: GraphRunStatus.RUNNING,
    currentNode: "supervisor",
    state: null,
    needsApproval: false,
    approvedAt: null,
    approvedBy: null,
    error: null,
    startedAt: now,
    completedAt: null,
    langsmithRootRunId: null,
    ...overrides,
  };
}

function mockPrisma() {
  return {
    graphRun: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
  } as unknown as PrismaService & {
    graphRun: {
      findUnique: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
    };
  };
}

function mockQueue(): GraphRunQueueService & {
  enqueueGraphRun: ReturnType<typeof vi.fn>;
} {
  return {
    isBullMode: () => false,
    getBullQueue: () => null,
    getConnection: () => null,
    enqueueGraphRun: vi.fn().mockResolvedValue(undefined),
    onModuleDestroy: vi.fn(),
  } as unknown as GraphRunQueueService & {
    enqueueGraphRun: ReturnType<typeof vi.fn>;
  };
}

function mockGraphService(): GraphService & {
  processGraphRun: ReturnType<typeof vi.fn>;
} {
  return {
    processGraphRun: vi.fn().mockResolvedValue(undefined),
  } as unknown as GraphService & {
    processGraphRun: ReturnType<typeof vi.fn>;
  };
}

describe("GraphRunWorker.processGraphRun", () => {
  let prisma: ReturnType<typeof mockPrisma>;
  let queue: ReturnType<typeof mockQueue>;
  let graphService: ReturnType<typeof mockGraphService>;
  let worker: GraphRunWorker;

  beforeEach(() => {
    vi.restoreAllMocks();
    prisma = mockPrisma();
    queue = mockQueue();
    graphService = mockGraphService();
    worker = new GraphRunWorker(
      prisma as unknown as PrismaService,
      queue,
      graphService,
    );
  });

  it("drives a RUNNING start job through GraphService.processGraphRun", async () => {
    prisma.graphRun.findUnique.mockResolvedValue(graphRunRow());

    await worker.processGraphRun({
      kind: "start",
      graphRunId: "graph_1",
      orgId: "org_1",
      icpProfileIds: ["icp_1", "icp_2"],
    });

    expect(graphService.processGraphRun).toHaveBeenCalledTimes(1);
    expect(graphService.processGraphRun).toHaveBeenCalledWith("graph_1", {
      orgId: "org_1",
      runId: "graph_1",
      icpProfileIds: ["icp_1", "icp_2"],
    });
  });

  it("drives a resume job via Command({ resume })", async () => {
    prisma.graphRun.findUnique.mockResolvedValue(graphRunRow());

    await worker.processGraphRun({
      kind: "resume",
      graphRunId: "graph_1",
      orgId: "org_1",
      resume: { approved: true, approvedBy: "user_x" },
    });

    expect(graphService.processGraphRun).toHaveBeenCalledTimes(1);
    const [runId, input] = graphService.processGraphRun.mock.calls[0];
    expect(runId).toBe("graph_1");
    expect(input).toBeInstanceOf(Command);
  });

  it("crash-recovery start without icpProfileIds resumes from the checkpoint (null input)", async () => {
    prisma.graphRun.findUnique.mockResolvedValue(graphRunRow());

    // The in-memory poller and (post-LGS-04) boot sweep enqueue recovery
    // starts WITHOUT a seed: the checkpoint already holds icpProfileIds, and
    // LangGraph's contract is that null input resumes from the saved state.
    await worker.processGraphRun({
      kind: "start",
      graphRunId: "graph_1",
      orgId: "org_1",
    });

    expect(graphService.processGraphRun).toHaveBeenCalledTimes(1);
    expect(graphService.processGraphRun).toHaveBeenCalledWith("graph_1", null);
  });

  it("crash-recovery start with an empty seed never fabricates entry state", async () => {
    prisma.graphRun.findUnique.mockResolvedValue(graphRunRow());

    // Legacy recovery jobs carry icpProfileIds: [] — re-seeding with that
    // would clobber the checkpoint's saved seed AND re-trigger the graph from
    // START. An empty seed can only mean recovery (runPipelineGraph rejects
    // empty icpProfileIds), so it must also map to a null-input resume.
    await worker.processGraphRun({
      kind: "start",
      graphRunId: "graph_1",
      orgId: "org_1",
      icpProfileIds: [],
    });

    expect(graphService.processGraphRun).toHaveBeenCalledTimes(1);
    expect(graphService.processGraphRun).toHaveBeenCalledWith("graph_1", null);
  });

  it("is idempotent: re-running a COMPLETED graph is a no-op", async () => {
    prisma.graphRun.findUnique.mockResolvedValue(
      graphRunRow({
        status: GraphRunStatus.COMPLETED,
        completedAt: new Date(),
      }),
    );

    await worker.processGraphRun({
      kind: "start",
      graphRunId: "graph_1",
      orgId: "org_1",
      icpProfileIds: ["icp_1"],
    });

    expect(graphService.processGraphRun).not.toHaveBeenCalled();
    expect(prisma.graphRun.update).not.toHaveBeenCalled();
  });

  it("aborts when the GraphRun is AWAITING_APPROVAL (HITL paused)", async () => {
    prisma.graphRun.findUnique.mockResolvedValue(
      graphRunRow({
        status: GraphRunStatus.AWAITING_APPROVAL,
        needsApproval: true,
      }),
    );

    await worker.processGraphRun({
      kind: "start",
      graphRunId: "graph_1",
      orgId: "org_1",
      icpProfileIds: ["icp_1"],
    });

    expect(graphService.processGraphRun).not.toHaveBeenCalled();
  });

  it("aborts when org id mismatches the persisted row", async () => {
    prisma.graphRun.findUnique.mockResolvedValue(
      graphRunRow({ orgId: "other_org" }),
    );

    await worker.processGraphRun({
      kind: "start",
      graphRunId: "graph_1",
      orgId: "org_1",
      icpProfileIds: ["icp_1"],
    });

    expect(graphService.processGraphRun).not.toHaveBeenCalled();
  });

  it("aborts when the GraphRun no longer exists", async () => {
    prisma.graphRun.findUnique.mockResolvedValue(null);

    await worker.processGraphRun({
      kind: "start",
      graphRunId: "graph_missing",
      orgId: "org_1",
      icpProfileIds: ["icp_1"],
    });

    expect(graphService.processGraphRun).not.toHaveBeenCalled();
  });

  it("rethrows on transient failure so BullMQ retries (status stays RUNNING)", async () => {
    prisma.graphRun.findUnique.mockResolvedValue(graphRunRow());
    graphService.processGraphRun.mockRejectedValueOnce(
      new Error("LLM upstream 503"),
    );

    await expect(
      worker.processGraphRun({
        kind: "start",
        graphRunId: "graph_1",
        orgId: "org_1",
        icpProfileIds: ["icp_1"],
      }),
    ).rejects.toThrow(/LLM upstream 503/);

    // Worker does NOT flip status — that's the BullMQ "failed after attempts"
    // event's job, and on transient failure the row stays RUNNING so the
    // checkpoint picks up where it left off on retry.
    expect(prisma.graphRun.update).not.toHaveBeenCalled();
  });
});

describe("GraphRunWorker.recoverOrphanedRuns (crash recovery sweep)", () => {
  let prisma: ReturnType<typeof mockPrisma>;
  let queue: ReturnType<typeof mockQueue>;
  let graphService: ReturnType<typeof mockGraphService>;
  let worker: GraphRunWorker;

  beforeEach(() => {
    vi.restoreAllMocks();
    prisma = mockPrisma();
    queue = mockQueue();
    graphService = mockGraphService();
    // Default: the atomic claim succeeds (this pod wins the run).
    prisma.graphRun.updateMany.mockResolvedValue({ count: 1 });
    worker = new GraphRunWorker(
      prisma as unknown as PrismaService,
      queue,
      graphService,
    );
  });

  it("enqueues orphaned RUNNING runs older than the boot threshold", async () => {
    const orphans = [
      graphRunRow({ id: "graph_a", orgId: "org_a" }),
      graphRunRow({ id: "graph_b", orgId: "org_b" }),
    ];
    prisma.graphRun.findMany.mockResolvedValue(orphans);

    const count = await worker.recoverOrphanedRuns();

    expect(count).toBe(2);
    expect(queue.enqueueGraphRun).toHaveBeenCalledTimes(2);
    const calls = queue.enqueueGraphRun.mock.calls.map(
      ([c]) => c as EnqueueGraphRunInput,
    );
    expect(calls.map((c) => c.graphRunId).sort()).toEqual([
      "graph_a",
      "graph_b",
    ]);
    for (const call of calls) {
      expect(call.kind).toBe("start");
      // Recovery jobs must NOT carry a fabricated seed — an empty
      // icpProfileIds marks the job as "resume from checkpoint" downstream.
      expect(
        (call as Extract<EnqueueGraphRunInput, { kind: "start" }>)
          .icpProfileIds,
      ).toEqual([]);
    }

    // Caps query at BOOT_RECOVERY_LIMIT (100) to avoid thundering herd.
    expect(prisma.graphRun.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: GraphRunStatus.RUNNING,
        }),
        take: 100,
      }),
    );
  });

  it("returns 0 when no orphans are found", async () => {
    prisma.graphRun.findMany.mockResolvedValue([]);

    const count = await worker.recoverOrphanedRuns();

    expect(count).toBe(0);
    expect(queue.enqueueGraphRun).not.toHaveBeenCalled();
  });

  it("filters by startedAt < now() - 10min so fresh runs are never swept (LGS-04)", async () => {
    prisma.graphRun.findMany.mockResolvedValue([]);
    const before = Date.now();

    await worker.recoverOrphanedRuns();

    const call = prisma.graphRun.findMany.mock.calls[0][0] as {
      where: { startedAt: { lt: Date } };
    };
    const cutoff = call.where.startedAt.lt.getTime();
    // Cutoff should be ~10min before "now" — accept a small slop for the
    // test executor itself. A freshly-resumed HITL run has startedAt
    // refreshed to "now" (audit P0 #8), so it sits well inside this window
    // and the sweep cannot race the live resume driving the same thread_id.
    expect(before - cutoff).toBeGreaterThanOrEqual(600_000 - 100);
    expect(before - cutoff).toBeLessThan(600_000 + 1_000);
  });

  it("claims each orphan atomically (status + staleness guard) before enqueueing", async () => {
    prisma.graphRun.findMany.mockResolvedValue([
      graphRunRow({ id: "graph_a", orgId: "org_a" }),
    ]);

    await worker.recoverOrphanedRuns();

    // The claim must re-assert RUNNING + staleness inside updateMany and
    // bump startedAt forward in the same statement — that is what makes a
    // second pod's identical claim match 0 rows instead of double-recovering.
    expect(prisma.graphRun.updateMany).toHaveBeenCalledTimes(1);
    const claim = prisma.graphRun.updateMany.mock.calls[0][0] as {
      where: { id: string; status: GraphRunStatus; startedAt: { lt: Date } };
      data: { startedAt: Date };
    };
    expect(claim.where.id).toBe("graph_a");
    expect(claim.where.status).toBe(GraphRunStatus.RUNNING);
    expect(claim.where.startedAt.lt).toBeInstanceOf(Date);
    expect(claim.data.startedAt).toBeInstanceOf(Date);
    expect(claim.data.startedAt.getTime()).toBeGreaterThan(
      claim.where.startedAt.lt.getTime(),
    );

    // Claim happens BEFORE the enqueue, never after.
    expect(prisma.graphRun.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      queue.enqueueGraphRun.mock.invocationCallOrder[0],
    );
  });

  it("skips a run another pod already claimed (updateMany count 0)", async () => {
    prisma.graphRun.findMany.mockResolvedValue([
      graphRunRow({ id: "graph_a", orgId: "org_a" }),
      graphRunRow({ id: "graph_b", orgId: "org_b" }),
    ]);
    // graph_a: lost the claim race (another pod bumped startedAt, or the run
    // resumed / went terminal between read and claim). graph_b: won.
    prisma.graphRun.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });

    const count = await worker.recoverOrphanedRuns();

    expect(count).toBe(1);
    expect(queue.enqueueGraphRun).toHaveBeenCalledTimes(1);
    const [enqueued] = queue.enqueueGraphRun.mock.calls[0] as [
      EnqueueGraphRunInput,
    ];
    expect(enqueued.graphRunId).toBe("graph_b");
  });
});

describe("GraphRunWorker in-memory poll recovery", () => {
  let prisma: ReturnType<typeof mockPrisma>;
  let queue: ReturnType<typeof mockQueue>;
  let graphService: ReturnType<typeof mockGraphService>;
  let worker: GraphRunWorker;

  beforeEach(() => {
    vi.restoreAllMocks();
    prisma = mockPrisma();
    queue = mockQueue();
    graphService = mockGraphService();
    worker = new GraphRunWorker(
      prisma as unknown as PrismaService,
      queue,
      graphService,
    );
  });

  it("resumes orphans from the checkpoint with null input (no fabricated seed)", async () => {
    const orphan = graphRunRow({ id: "graph_1", orgId: "org_1" });
    prisma.graphRun.findMany.mockResolvedValue([orphan]);
    prisma.graphRun.findUnique.mockResolvedValue(orphan);

    // Drive the private poll tick directly — the interval wiring is just a
    // setInterval around this method.
    const poll = (
      worker as unknown as { pollInMemory: () => Promise<void> }
    ).pollInMemory.bind(worker);
    await poll();

    expect(graphService.processGraphRun).toHaveBeenCalledTimes(1);
    expect(graphService.processGraphRun).toHaveBeenCalledWith("graph_1", null);
  });
});

describe("GraphRunWorker terminal-failure handler", () => {
  let prisma: ReturnType<typeof mockPrisma>;
  let queue: ReturnType<typeof mockQueue>;
  let graphService: ReturnType<typeof mockGraphService>;
  let worker: GraphRunWorker;

  beforeEach(() => {
    vi.restoreAllMocks();
    prisma = mockPrisma();
    queue = mockQueue();
    graphService = mockGraphService();
    worker = new GraphRunWorker(
      prisma as unknown as PrismaService,
      queue,
      graphService,
    );
  });

  it("flips a RUNNING graph to FAILED when retries exhaust", async () => {
    // Drive markTerminalFailure via a private cast — the BullMQ event wiring
    // calls this method when all attempts have been consumed.
    prisma.graphRun.findUnique.mockResolvedValue(graphRunRow());
    prisma.graphRun.update.mockResolvedValue(
      graphRunRow({ status: GraphRunStatus.FAILED }),
    );

    const markTerminal = (
      worker as unknown as {
        markTerminalFailure: (id: string, reason: string) => Promise<void>;
      }
    ).markTerminalFailure.bind(worker);
    await markTerminal("graph_1", "checkpoint dead-letter");

    expect(prisma.graphRun.update).toHaveBeenCalledWith({
      where: { id: "graph_1" },
      data: expect.objectContaining({
        status: GraphRunStatus.FAILED,
        completedAt: expect.any(Date),
        error: expect.stringContaining("auto-failed:"),
      }),
    });
  });

  it("leaves COMPLETED rows alone (race with success)", async () => {
    prisma.graphRun.findUnique.mockResolvedValue(
      graphRunRow({ status: GraphRunStatus.COMPLETED }),
    );

    const markTerminal = (
      worker as unknown as {
        markTerminalFailure: (id: string, reason: string) => Promise<void>;
      }
    ).markTerminalFailure.bind(worker);
    await markTerminal("graph_1", "stale failure event");

    expect(prisma.graphRun.update).not.toHaveBeenCalled();
  });
});
