import { ConflictException } from "@nestjs/common";
import { GraphRunStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../../prisma/prisma.service";
import { GraphService } from "../graph.service";

type StoredRun = {
  id: string;
  orgId: string;
  threadId: string;
  status: GraphRunStatus;
  startIcpProfileIds: string[];
  dispatchGeneration: number;
};

function lifecyclePrisma() {
  const rows: StoredRun[] = [];
  const graphRun = {
    findFirst: vi.fn(async (args: { where: { orgId?: string } }) =>
      rows.find(
        (row) =>
          row.orgId === args.where.orgId &&
          (row.status === GraphRunStatus.RUNNING ||
            row.status === GraphRunStatus.AWAITING_APPROVAL),
      ) ?? null,
    ),
    create: vi.fn(async (args: { data: StoredRun }) => {
      const row = { ...args.data };
      rows.push(row);
      return { id: row.id, dispatchGeneration: row.dispatchGeneration };
    }),
  };
  const tx = {
    graphRun,
    $queryRaw: vi.fn().mockResolvedValue([]),
  };

  // Deterministic stand-in for PostgreSQL's transaction-scoped advisory lock:
  // callbacks serialize in invocation order, while the service code itself
  // still has to inspect/create inside that transaction.
  let transactionTail: Promise<unknown> = Promise.resolve();
  const $transaction = vi.fn(
    <T>(callback: (client: typeof tx) => Promise<T>): Promise<T> => {
      const result = transactionTail.then(() => callback(tx));
      transactionTail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  );

  return {
    rows,
    graphRun,
    tx,
    prisma: {
      graphRun,
      $transaction,
    } as unknown as PrismaService,
  };
}

function graphService(
  prisma: PrismaService,
  enqueueGraphRun = vi.fn().mockResolvedValue(undefined),
) {
  return {
    service: new GraphService(
      prisma,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { enqueueGraphRun } as never,
      {} as never,
      {} as never,
    ),
    enqueueGraphRun,
  };
}

describe("GraphService durable start lifecycle", () => {
  it("serializes concurrent org starts and creates id/threadId atomically", async () => {
    const db = lifecyclePrisma();
    const { service, enqueueGraphRun } = graphService(db.prisma);

    const results = await Promise.allSettled([
      service.runPipelineGraph("org_1", ["icp_1", "icp_1", "icp_2"]),
      service.runPipelineGraph("org_1", ["icp_3"]),
    ]);

    expect(results[0].status).toBe("fulfilled");
    expect(results[1].status).toBe("rejected");
    if (results[1].status === "rejected") {
      expect(results[1].reason).toBeInstanceOf(ConflictException);
    }
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0].id).toBe(db.rows[0].threadId);
    expect(db.rows[0].threadId).not.toBe("");
    expect(db.rows[0].startIcpProfileIds).toEqual(["icp_1", "icp_2"]);
    expect(db.tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(enqueueGraphRun).toHaveBeenCalledTimes(1);
    expect(enqueueGraphRun).toHaveBeenCalledWith({
      graphRunId: db.rows[0].id,
      orgId: "org_1",
      dispatchGeneration: 0,
    });
  });

  it("keeps the canonical start durable and returns the run when enqueue fails", async () => {
    const db = lifecyclePrisma();
    const enqueueGraphRun = vi
      .fn()
      .mockRejectedValue(new Error("redis unavailable"));
    const { service } = graphService(db.prisma, enqueueGraphRun);

    const result = await service.runPipelineGraph("org_1", [" icp_1 "]);

    expect(result.runId).toBe(db.rows[0].id);
    expect(result.threadId).toBe(db.rows[0].threadId);
    expect(db.rows[0].status).toBe(GraphRunStatus.RUNNING);
    expect(db.rows[0].startIcpProfileIds).toEqual(["icp_1"]);
    expect(db.rows[0].dispatchGeneration).toBe(0);
    expect(enqueueGraphRun).toHaveBeenCalledTimes(1);
  });
});
