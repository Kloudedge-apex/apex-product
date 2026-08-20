import { ConflictException, NotFoundException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GraphRunStatus } from "@prisma/client";
import { GraphService } from "../graph.service";
import type { PrismaService } from "../../prisma/prisma.service";

function makePrisma() {
  const graphRun = {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  };
  const prisma = {
    graphRun,
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation(
    async (
      input:
        | Promise<unknown>[]
        | ((tx: typeof prisma) => Promise<unknown>),
    ) =>
      typeof input === "function"
        ? input(prisma)
        : Promise.all(input),
  );
  return prisma as unknown as PrismaService & {
    graphRun: typeof graphRun;
    $transaction: ReturnType<typeof vi.fn>;
    $queryRaw: ReturnType<typeof vi.fn>;
  };
}

function makeService(prisma: ReturnType<typeof makePrisma>) {
  const evidenceLedger = {
    approvalGranted: vi.fn().mockResolvedValue(undefined),
    approvalDenied: vi.fn().mockResolvedValue(undefined),
  };
  const queue = {
    enqueueGraphRun: vi.fn().mockResolvedValue(undefined),
  };
  const service = new GraphService(
    prisma,
    {} as never,
    {} as never,
    {} as never,
    evidenceLedger as never,
    queue as never,
    {} as never,
    {} as never,
  );
  return { service, evidenceLedger, queue };
}

describe("GraphService run metadata truth", () => {
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(() => {
    prisma = makePrisma();
  });

  it("resumes by refreshing lastActivityAt without overwriting startedAt", async () => {
    prisma.graphRun.updateMany.mockResolvedValue({ count: 1 });
    prisma.graphRun.findFirst.mockResolvedValue({
      status: GraphRunStatus.RUNNING,
      dispatchGeneration: 8,
    });
    const { service, queue } = makeService(prisma);

    await service.resumePipelineGraph("run_1", "org_1", {
      approved: true,
      approvedBy: "user_1",
    });

    const update = prisma.graphRun.updateMany.mock.calls[0][0];
    expect(update.where).toEqual({
      id: "run_1",
      orgId: "org_1",
      status: GraphRunStatus.AWAITING_APPROVAL,
    });
    expect(update.data.status).toBe(GraphRunStatus.RUNNING);
    expect(update.data.lastActivityAt).toBeInstanceOf(Date);
    expect(update.data.approvedAt).toBe(update.data.lastActivityAt);
    expect(update.data.pendingResumeApproved).toBe(true);
    expect(update.data.pendingResumeApprovedBy).toBe("user_1");
    expect(update.data.dispatchGeneration).toEqual({ increment: 1 });
    expect(update.data).not.toHaveProperty("startedAt");
    expect(queue.enqueueGraphRun).toHaveBeenCalledWith({
      graphRunId: "run_1",
      orgId: "org_1",
      dispatchGeneration: 8,
    });
  });

  it("does not emit evidence or enqueue after losing the decision claim", async () => {
    prisma.graphRun.updateMany.mockResolvedValue({ count: 0 });
    prisma.graphRun.findFirst.mockResolvedValue({
      status: GraphRunStatus.RUNNING,
      dispatchGeneration: 2,
    });
    const { service, evidenceLedger, queue } = makeService(prisma);

    await expect(
      service.resumePipelineGraph("run_1", "org_1", {
        approved: false,
        approvedBy: "user_2",
      }),
    ).rejects.toThrow(ConflictException);

    expect(prisma.graphRun.findFirst).toHaveBeenCalledWith({
      where: { id: "run_1", orgId: "org_1" },
      select: { status: true, dispatchGeneration: true },
    });
    expect(evidenceLedger.approvalGranted).not.toHaveBeenCalled();
    expect(evidenceLedger.approvalDenied).not.toHaveBeenCalled();
    expect(queue.enqueueGraphRun).not.toHaveBeenCalled();
  });

  it("preserves not-found semantics when no tenant-owned run wins the claim", async () => {
    prisma.graphRun.updateMany.mockResolvedValue({ count: 0 });
    prisma.graphRun.findFirst.mockResolvedValue(null);
    const { service, evidenceLedger, queue } = makeService(prisma);

    await expect(
      service.resumePipelineGraph("run_missing", "org_1", {
        approved: true,
        approvedBy: "user_1",
      }),
    ).rejects.toThrow(NotFoundException);

    expect(evidenceLedger.approvalGranted).not.toHaveBeenCalled();
    expect(evidenceLedger.approvalDenied).not.toHaveBeenCalled();
    expect(queue.enqueueGraphRun).not.toHaveBeenCalled();
  });

  it("allows exactly one winner in concurrent opposing decisions", async () => {
    prisma.graphRun.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    prisma.graphRun.findFirst.mockResolvedValue({
      status: GraphRunStatus.RUNNING,
      dispatchGeneration: 3,
    });
    const { service, evidenceLedger, queue } = makeService(prisma);

    const [rejectResult, approveResult] = await Promise.allSettled([
      service.resumePipelineGraph("run_1", "org_1", {
        approved: false,
        approvedBy: "rejecter",
      }),
      service.resumePipelineGraph("run_1", "org_1", {
        approved: true,
        approvedBy: "approver",
      }),
    ]);

    expect(rejectResult).toEqual({
      status: "fulfilled",
      value: { status: "resuming" },
    });
    expect(approveResult.status).toBe("rejected");
    if (approveResult.status === "rejected") {
      expect(approveResult.reason).toBeInstanceOf(ConflictException);
    }
    expect(evidenceLedger.approvalGranted).not.toHaveBeenCalled();
    expect(evidenceLedger.approvalDenied).toHaveBeenCalledTimes(1);
    expect(evidenceLedger.approvalDenied).toHaveBeenCalledWith({
      orgId: "org_1",
      runId: "run_1",
      deniedBy: "rejecter",
    });
    expect(queue.enqueueGraphRun).toHaveBeenCalledTimes(1);
    expect(queue.enqueueGraphRun).toHaveBeenCalledWith({
      graphRunId: "run_1",
      orgId: "org_1",
      dispatchGeneration: 3,
    });
  });

  it("keeps a claimed resume decision durable when enqueue fails", async () => {
    prisma.graphRun.updateMany.mockResolvedValue({ count: 1 });
    prisma.graphRun.findFirst.mockResolvedValue({
      status: GraphRunStatus.RUNNING,
      dispatchGeneration: 11,
    });
    const { service, queue } = makeService(prisma);
    queue.enqueueGraphRun.mockRejectedValueOnce(new Error("redis unavailable"));

    await expect(
      service.resumePipelineGraph("run_1", "org_1", {
        approved: false,
        approvedBy: "reviewer_1",
      }),
    ).resolves.toEqual({ status: "resuming" });

    const update = prisma.graphRun.updateMany.mock.calls[0][0];
    expect(update.data).toEqual(
      expect.objectContaining({
        status: GraphRunStatus.RUNNING,
        pendingResumeApproved: false,
        pendingResumeApprovedBy: "reviewer_1",
        dispatchGeneration: { increment: 1 },
      }),
    );
    expect(queue.enqueueGraphRun).toHaveBeenCalledWith({
      graphRunId: "run_1",
      orgId: "org_1",
      dispatchGeneration: 11,
    });
  });
});

describe("GraphService.listGraphRuns", () => {
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(() => {
    prisma = makePrisma();
  });

  it("preserves the legacy bare-array response with stable ordering", async () => {
    const rows = [{ id: "run_2" }, { id: "run_1" }];
    prisma.graphRun.findMany.mockResolvedValue(rows);
    const { service } = makeService(prisma);

    await expect(service.listGraphRuns("org_1")).resolves.toBe(rows);
    expect(prisma.graphRun.findMany).toHaveBeenCalledWith({
      where: { orgId: "org_1" },
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      take: 20,
    });
    expect(prisma.graphRun.count).not.toHaveBeenCalled();
  });

  it("returns a real-count paginated envelope with stable ordering", async () => {
    const rows = [{ id: "run_2" }, { id: "run_1" }];
    prisma.graphRun.findMany.mockResolvedValue(rows);
    prisma.graphRun.count.mockResolvedValue(42);
    const { service } = makeService(prisma);

    await expect(
      service.listGraphRuns("org_1", { page: 2, limit: 20 }),
    ).resolves.toEqual({
      items: rows,
      total: 42,
      page: 2,
      limit: 20,
      totalPages: 3,
    });
    expect(prisma.graphRun.findMany).toHaveBeenCalledWith({
      where: { orgId: "org_1" },
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      skip: 20,
      take: 20,
    });
    expect(prisma.graphRun.count).toHaveBeenCalledWith({
      where: { orgId: "org_1" },
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it("applies status to both the page and its real total", async () => {
    prisma.graphRun.findMany.mockResolvedValue([]);
    prisma.graphRun.count.mockResolvedValue(0);
    const { service } = makeService(prisma);

    await service.listGraphRuns("org_1", {
      page: 1,
      limit: 20,
      status: GraphRunStatus.FAILED,
    });

    const where = { orgId: "org_1", status: GraphRunStatus.FAILED };
    expect(prisma.graphRun.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where }),
    );
    expect(prisma.graphRun.count).toHaveBeenCalledWith({ where });
  });
});
