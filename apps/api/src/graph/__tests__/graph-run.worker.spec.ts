import { describe, it, expect, beforeEach, vi } from "vitest";
import { GraphRun, GraphRunStatus } from "@prisma/client";
import { Command } from "@langchain/langgraph";
import {
  GraphRunWorker,
  GRAPH_RUN_RECOVERY_SWEEP_INTERVAL_MS,
} from "../graph-run.worker";
import {
  GraphRunQueueService,
  EnqueueGraphRunInput,
} from "../graph-run-queue.service";
import { GraphService } from "../graph.service";
import { PrismaService } from "../../prisma/prisma.service";
import {
  ProductionBootstrapWriterFenceClosedError,
  ProductionBootstrapWriterFenceUnavailableError,
  type ProductionBootstrapWriterFenceService,
} from "../../ops/production-bootstrap-writer-fence";

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
    startIcpProfileIds: ["icp_1"],
    pendingResumeApproved: null,
    pendingResumeApprovedBy: null,
    dispatchGeneration: 0,
    needsApproval: false,
    approvedAt: null,
    approvedBy: null,
    error: null,
    startedAt: now,
    lastActivityAt: now,
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
    graphCheckpoint: {
      findFirst: vi.fn(),
    },
  } as unknown as PrismaService & {
    graphRun: {
      findUnique: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
    };
    graphCheckpoint: {
      findFirst: ReturnType<typeof vi.fn>;
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
    prisma.graphRun.findUnique.mockResolvedValue(
      graphRunRow({ startIcpProfileIds: ["icp_1", "icp_2"] }),
    );
    prisma.graphCheckpoint.findFirst.mockResolvedValue(null);

    await worker.processGraphRun({
      graphRunId: "graph_1",
      orgId: "org_1",
      dispatchGeneration: 0,
    });

    expect(graphService.processGraphRun).toHaveBeenCalledTimes(1);
    expect(graphService.processGraphRun).toHaveBeenCalledWith(
      "graph_1",
      {
        orgId: "org_1",
        runId: "graph_1",
        icpProfileIds: ["icp_1", "icp_2"],
      },
      0,
    );
    expect(prisma.graphRun.updateMany).toHaveBeenCalledWith({
      where: {
        id: "graph_1",
        status: GraphRunStatus.RUNNING,
        dispatchGeneration: 0,
      },
      data: { lastActivityAt: expect.any(Date) },
    });
  });

  it("drives a resume job via Command({ resume })", async () => {
    prisma.graphRun.findUnique.mockResolvedValue(
      graphRunRow({
        pendingResumeApproved: true,
        pendingResumeApprovedBy: "user_x",
      }),
    );

    await worker.processGraphRun({
      graphRunId: "graph_1",
      orgId: "org_1",
      dispatchGeneration: 0,
    });

    expect(graphService.processGraphRun).toHaveBeenCalledTimes(1);
    const [runId, input] = graphService.processGraphRun.mock.calls[0];
    expect(runId).toBe("graph_1");
    expect(input).toBeInstanceOf(Command);
    expect(input).toMatchObject({
      resume: { approved: true, approvedBy: "user_x" },
    });
    expect(prisma.graphCheckpoint.findFirst).not.toHaveBeenCalled();
    expect(prisma.graphRun.updateMany).toHaveBeenLastCalledWith({
      where: {
        id: "graph_1",
        dispatchGeneration: 0,
        pendingResumeApproved: true,
      },
      data: {
        pendingResumeApproved: null,
        pendingResumeApprovedBy: null,
      },
    });
  });

  it("recovers a durable reviewer rejection without any decision in the queue payload", async () => {
    prisma.graphRun.findUnique.mockResolvedValue(
      graphRunRow({
        pendingResumeApproved: false,
        pendingResumeApprovedBy: "reviewer_1",
        dispatchGeneration: 3,
      }),
    );

    await worker.processGraphRun({
      graphRunId: "graph_1",
      orgId: "org_1",
      dispatchGeneration: 3,
    });

    const [, input] = graphService.processGraphRun.mock.calls[0];
    expect(input).toBeInstanceOf(Command);
    expect(input).toMatchObject({
      resume: { approved: false, approvedBy: "reviewer_1" },
    });
  });

  it("recovery with a checkpoint resumes with null and never replays the stored seed", async () => {
    prisma.graphRun.findUnique.mockResolvedValue(graphRunRow());
    prisma.graphCheckpoint.findFirst.mockResolvedValue({
      checkpointId: "checkpoint_1",
    });

    await worker.processGraphRun({
      graphRunId: "graph_1",
      orgId: "org_1",
      dispatchGeneration: 0,
    });

    expect(graphService.processGraphRun).toHaveBeenCalledTimes(1);
    expect(graphService.processGraphRun).toHaveBeenCalledWith(
      "graph_1",
      null,
      0,
    );
  });

  it("fails closed for a legacy run with neither checkpoint nor durable start seed", async () => {
    prisma.graphRun.findUnique.mockResolvedValue(
      graphRunRow({ startIcpProfileIds: [] }),
    );
    prisma.graphCheckpoint.findFirst.mockResolvedValue(null);

    await expect(
      worker.processGraphRun({
        graphRunId: "graph_1",
        orgId: "org_1",
        dispatchGeneration: 0,
      }),
    ).rejects.toThrow(/no checkpoint or durable start ICP input/);

    expect(graphService.processGraphRun).not.toHaveBeenCalled();
  });

  it("is idempotent: re-running a COMPLETED graph is a no-op", async () => {
    prisma.graphRun.findUnique.mockResolvedValue(
      graphRunRow({
        status: GraphRunStatus.COMPLETED,
        completedAt: new Date(),
      }),
    );

    await worker.processGraphRun({
      graphRunId: "graph_1",
      orgId: "org_1",
      dispatchGeneration: 0,
    });

    expect(graphService.processGraphRun).not.toHaveBeenCalled();
    expect(prisma.graphRun.update).not.toHaveBeenCalled();
  });

  it("ignores a stale retained job from an older dispatch generation", async () => {
    prisma.graphRun.findUnique.mockResolvedValue(
      graphRunRow({ dispatchGeneration: 5 }),
    );

    await worker.processGraphRun({
      graphRunId: "graph_1",
      orgId: "org_1",
      dispatchGeneration: 4,
    });

    expect(graphService.processGraphRun).not.toHaveBeenCalled();
    expect(prisma.graphCheckpoint.findFirst).not.toHaveBeenCalled();
    expect(prisma.graphRun.updateMany).not.toHaveBeenCalled();
  });

  it("aborts when the GraphRun is AWAITING_APPROVAL (HITL paused)", async () => {
    prisma.graphRun.findUnique.mockResolvedValue(
      graphRunRow({
        status: GraphRunStatus.AWAITING_APPROVAL,
        needsApproval: true,
      }),
    );

    await worker.processGraphRun({
      graphRunId: "graph_1",
      orgId: "org_1",
      dispatchGeneration: 0,
    });

    expect(graphService.processGraphRun).not.toHaveBeenCalled();
  });

  it("aborts when org id mismatches the persisted row", async () => {
    prisma.graphRun.findUnique.mockResolvedValue(
      graphRunRow({ orgId: "other_org" }),
    );

    await worker.processGraphRun({
      graphRunId: "graph_1",
      orgId: "org_1",
      dispatchGeneration: 0,
    });

    expect(graphService.processGraphRun).not.toHaveBeenCalled();
  });

  it("aborts when the GraphRun no longer exists", async () => {
    prisma.graphRun.findUnique.mockResolvedValue(null);

    await worker.processGraphRun({
      graphRunId: "graph_missing",
      orgId: "org_1",
      dispatchGeneration: 0,
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
        graphRunId: "graph_1",
        orgId: "org_1",
        dispatchGeneration: 0,
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
      expect(call.dispatchGeneration).toBe(1);
      // Queue transport is only a fenced pointer; business payload remains
      // durable on GraphRun.
      expect(call).not.toHaveProperty("icpProfileIds");
      expect(call).not.toHaveProperty("resume");
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

  it("filters by lastActivityAt < now() - 10min so fresh runs are never swept (LGS-04)", async () => {
    prisma.graphRun.findMany.mockResolvedValue([]);
    const before = Date.now();

    await worker.recoverOrphanedRuns();

    const call = prisma.graphRun.findMany.mock.calls[0][0] as {
      where: { lastActivityAt: { lt: Date } };
    };
    const cutoff = call.where.lastActivityAt.lt.getTime();
    // Cutoff should be ~10min before "now" — accept a small slop for the
    // test executor itself. A freshly-resumed HITL run has lastActivityAt
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
    // bump lastActivityAt forward in the same statement — that is what makes a
    // second pod's identical claim match 0 rows instead of double-recovering.
    expect(prisma.graphRun.updateMany).toHaveBeenCalledTimes(1);
    const claim = prisma.graphRun.updateMany.mock.calls[0][0] as {
      where: {
        id: string;
        status: GraphRunStatus;
        lastActivityAt: { lt: Date };
        dispatchGeneration: number;
      };
      data: {
        lastActivityAt: Date;
        dispatchGeneration: { increment: number };
      };
    };
    expect(claim.where.id).toBe("graph_a");
    expect(claim.where.status).toBe(GraphRunStatus.RUNNING);
    expect(claim.where.dispatchGeneration).toBe(0);
    expect(claim.where.lastActivityAt.lt).toBeInstanceOf(Date);
    expect(claim.data.lastActivityAt).toBeInstanceOf(Date);
    expect(claim.data.lastActivityAt.getTime()).toBeGreaterThan(
      claim.where.lastActivityAt.lt.getTime(),
    );
    expect(claim.data.dispatchGeneration).toEqual({ increment: 1 });
    expect(claim.data).not.toHaveProperty("startedAt");

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
    // graph_a: lost the claim race (another pod bumped lastActivityAt, or the run
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
    expect(enqueued.dispatchGeneration).toBe(1);
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
    prisma.graphRun.updateMany.mockResolvedValue({ count: 1 });
    worker = new GraphRunWorker(
      prisma as unknown as PrismaService,
      queue,
      graphService,
    );
  });

  it("resumes orphans from the checkpoint with null input (no fabricated seed)", async () => {
    const orphan = graphRunRow({ id: "graph_1", orgId: "org_1" });
    prisma.graphRun.findMany.mockResolvedValue([orphan]);
    prisma.graphRun.findUnique.mockResolvedValue(
      graphRunRow({
        id: "graph_1",
        orgId: "org_1",
        dispatchGeneration: 1,
      }),
    );
    prisma.graphCheckpoint.findFirst.mockResolvedValue({
      checkpointId: "checkpoint_1",
    });

    // Drive the private poll tick directly — the interval wiring is just a
    // setInterval around this method.
    const poll = (
      worker as unknown as { pollInMemory: () => Promise<void> }
    ).pollInMemory.bind(worker);
    await poll();

    expect(graphService.processGraphRun).toHaveBeenCalledTimes(1);
    expect(graphService.processGraphRun).toHaveBeenCalledWith(
      "graph_1",
      null,
      1,
    );
  });
});

describe("GraphRunWorker recurrent recovery scheduling", () => {
  it("contains and logs writer-fence rejection from periodic timer boundaries", async () => {
    vi.useFakeTimers();
    const previousGate = process.env.GRAPH_RUN_WORKER_ENABLED;
    process.env.GRAPH_RUN_WORKER_ENABLED = "true";
    const prisma = mockPrisma();
    prisma.graphRun.findMany.mockResolvedValue([]);
    let rejectTimer = false;
    const fence = {
      runWriter: vi.fn(async (_kind, operation) => {
        if (rejectTimer) {
          throw new ProductionBootstrapWriterFenceUnavailableError();
        }
        return operation();
      }),
    } as unknown as ProductionBootstrapWriterFenceService;
    const worker = new GraphRunWorker(
      prisma as unknown as PrismaService,
      mockQueue(),
      mockGraphService(),
      undefined,
      fence,
    );
    const errorLog = vi
      .spyOn(
        (worker as unknown as { logger: { error: (...args: unknown[]) => void } })
          .logger,
        "error",
      )
      .mockImplementation(() => undefined);
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);

    try {
      await worker.onModuleInit();
      rejectTimer = true;
      await vi.advanceTimersByTimeAsync(GRAPH_RUN_RECOVERY_SWEEP_INTERVAL_MS);

      expect(errorLog).toHaveBeenCalledWith(
        expect.stringContaining("in-memory poll failed"),
      );
      expect(errorLog).toHaveBeenCalledWith(
        expect.stringContaining("recurring recovery sweep failed"),
      );
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
      await worker.onModuleDestroy();
      if (previousGate === undefined) {
        delete process.env.GRAPH_RUN_WORKER_ENABLED;
      } else {
        process.env.GRAPH_RUN_WORKER_ENABLED = previousGate;
      }
      vi.useRealTimers();
    }
  });

  it("runs orphan recovery at boot and again on the recurring interval", async () => {
    vi.useFakeTimers();
    const previousGate = process.env.GRAPH_RUN_WORKER_ENABLED;
    process.env.GRAPH_RUN_WORKER_ENABLED = "true";

    const prisma = mockPrisma();
    prisma.graphRun.findMany.mockResolvedValue([]);
    const worker = new GraphRunWorker(
      prisma as unknown as PrismaService,
      mockQueue(),
      mockGraphService(),
    );
    const recover = vi
      .spyOn(worker, "recoverOrphanedRuns")
      .mockResolvedValue(0);

    try {
      await worker.onModuleInit();
      expect(recover).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(
        GRAPH_RUN_RECOVERY_SWEEP_INTERVAL_MS,
      );
      expect(recover).toHaveBeenCalledTimes(2);
    } finally {
      await worker.onModuleDestroy();
      if (previousGate === undefined) {
        delete process.env.GRAPH_RUN_WORKER_ENABLED;
      } else {
        process.env.GRAPH_RUN_WORKER_ENABLED = previousGate;
      }
      vi.useRealTimers();
    }
  });

  it("attaches and schedules while CLOSED but skips ticks and blocks jobs", async () => {
    vi.useFakeTimers();
    const previousGate = process.env.GRAPH_RUN_WORKER_ENABLED;
    process.env.GRAPH_RUN_WORKER_ENABLED = "true";
    const prisma = mockPrisma();
    const queue = mockQueue();
    const bullMode = vi.spyOn(queue, "isBullMode");
    const fence = {
      runWriter: vi.fn(async () => {
        throw new ProductionBootstrapWriterFenceClosedError();
      }),
    } as unknown as ProductionBootstrapWriterFenceService;
    const worker = new GraphRunWorker(
      prisma as unknown as PrismaService,
      queue,
      mockGraphService(),
      undefined,
      fence,
    );

    try {
      await expect(worker.onModuleInit()).resolves.toBeUndefined();
      expect(bullMode).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBeGreaterThanOrEqual(2);
      await expect(worker.runRecoverySweep("test")).resolves.toBe(0);
      await expect(
        worker.processGraphRun({
          graphRunId: "graph_1",
          orgId: "org_1",
          dispatchGeneration: 0,
        }),
      ).rejects.toBeInstanceOf(ProductionBootstrapWriterFenceClosedError);
      expect(prisma.graphRun.findUnique).not.toHaveBeenCalled();
    } finally {
      await worker.onModuleDestroy();
      if (previousGate === undefined) {
        delete process.env.GRAPH_RUN_WORKER_ENABLED;
      } else {
        process.env.GRAPH_RUN_WORKER_ENABLED = previousGate;
      }
      vi.useRealTimers();
    }
  });

  it("creates no BullMQ consumer while CLOSED and activates after exact OPEN", async () => {
    vi.useFakeTimers();
    const previousGate = process.env.GRAPH_RUN_WORKER_ENABLED;
    process.env.GRAPH_RUN_WORKER_ENABLED = "true";
    const prisma = mockPrisma();
    prisma.graphRun.findMany.mockResolvedValue([]);
    const isPaused = vi.fn(async () => false);
    const queue = {
      isBullMode: vi.fn(() => true),
      getConnection: vi.fn(() => ({})),
      getBullQueue: vi.fn(() => ({ isPaused })),
      enqueueGraphRun: vi.fn(),
    } as unknown as GraphRunQueueService;
    let closed = true;
    let epochUnavailable = true;
    const fence = {
      runWriter: vi.fn(async (_kind, operation) => {
        if (closed) throw new ProductionBootstrapWriterFenceClosedError();
        return operation();
      }),
      deploymentEpochMode: vi.fn(async () => {
        if (epochUnavailable) {
          throw new ProductionBootstrapWriterFenceUnavailableError();
        }
        return closed ? "closed" : "open";
      }),
    } as unknown as ProductionBootstrapWriterFenceService;
    const worker = new GraphRunWorker(
      prisma as unknown as PrismaService,
      queue,
      mockGraphService(),
      undefined,
      fence,
    );
    const start = vi
      .spyOn(
        worker as unknown as { startBullWorker(): void },
        "startBullWorker",
      )
      .mockImplementation(() => undefined);
    const warnLog = vi
      .spyOn(
        (worker as unknown as { logger: { warn: (...args: unknown[]) => void } })
          .logger,
        "warn",
      )
      .mockImplementation(() => undefined);
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);

    try {
      await expect(worker.onModuleInit()).resolves.toBeUndefined();
      expect(isPaused).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1_000);
      expect(warnLog).toHaveBeenCalledWith(
        expect.stringContaining("activation remains fail-closed"),
      );
      expect(unhandled).not.toHaveBeenCalled();

      epochUnavailable = false;
      closed = false;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(start).toHaveBeenCalledOnce();
    } finally {
      process.off("unhandledRejection", unhandled);
      await worker.onModuleDestroy();
      if (previousGate === undefined) {
        delete process.env.GRAPH_RUN_WORKER_ENABLED;
      } else {
        process.env.GRAPH_RUN_WORKER_ENABLED = previousGate;
      }
      vi.useRealTimers();
    }
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
    const markTerminal = (
      worker as unknown as {
        markTerminalFailure: (
          id: string,
          generation: number,
          reason: string,
        ) => Promise<void>;
      }
    ).markTerminalFailure.bind(worker);
    await markTerminal("graph_1", 4, "checkpoint dead-letter");

    expect(prisma.graphRun.updateMany).toHaveBeenCalledWith({
      where: {
        id: "graph_1",
        status: GraphRunStatus.RUNNING,
        dispatchGeneration: 4,
      },
      data: expect.objectContaining({
        status: GraphRunStatus.FAILED,
        completedAt: expect.any(Date),
        error: expect.stringContaining("auto-failed:"),
      }),
    });
  });

  it("fences terminal failure to the exact dispatch generation", async () => {
    const markTerminal = (
      worker as unknown as {
        markTerminalFailure: (
          id: string,
          generation: number,
          reason: string,
        ) => Promise<void>;
      }
    ).markTerminalFailure.bind(worker);
    await markTerminal("graph_1", 2, "stale failure event");

    expect(prisma.graphRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ dispatchGeneration: 2 }),
      }),
    );
  });
});
