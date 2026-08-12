import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  graphRunDispatchJobId,
  GraphRunQueueService,
} from "../graph-run-queue.service";

const addMock = vi.fn().mockResolvedValue(undefined);

vi.mock("bullmq", () => {
  class Queue {
    add = addMock;
    close = vi.fn().mockResolvedValue(undefined);
  }
  return { Queue };
});

vi.mock("../../runtime/queue.service", () => ({
  buildRedisConnectionOptions: () => ({ host: "localhost", port: 6379 }),
}));

describe("GraphRunQueueService.enqueueGraphRun", () => {
  let svc: GraphRunQueueService;

  beforeEach(() => {
    addMock.mockClear();
    svc = new GraphRunQueueService();
  });

  it("uses a deterministic generation-fenced id and pointer-only payload", async () => {
    await svc.enqueueGraphRun({
      graphRunId: "run-abc-123",
      orgId: "org-1",
      dispatchGeneration: 0,
    });
    expect(addMock).toHaveBeenCalledTimes(1);
    const [, data, opts] = addMock.mock.calls[0];
    expect(opts.jobId).toBe("run-abc-123-dispatch-0");
    expect(data).toEqual({
      graphRunId: "run-abc-123",
      orgId: "org-1",
      dispatchGeneration: 0,
    });
    expect(data).not.toHaveProperty("icpProfileIds");
    expect(data).not.toHaveProperty("resume");
  });

  it("gives recovery a fresh id that cannot collide with a retained completed job", async () => {
    await svc.enqueueGraphRun({
      graphRunId: "run-abc-123",
      orgId: "org-1",
      dispatchGeneration: 0,
    });
    await svc.enqueueGraphRun({
      graphRunId: "run-abc-123",
      orgId: "org-1",
      dispatchGeneration: 1,
    });
    expect(addMock).toHaveBeenCalledTimes(2);
    const firstId = addMock.mock.calls[0][2].jobId;
    const recoveryId = addMock.mock.calls[1][2].jobId;
    expect(firstId).toBe("run-abc-123-dispatch-0");
    expect(recoveryId).toBe("run-abc-123-dispatch-1");
    expect(recoveryId).not.toBe(firstId);
    expect(recoveryId).not.toContain(":");
  });

  it("rejects invalid generations before constructing a BullMQ id", () => {
    expect(() => graphRunDispatchJobId("run-1", -1)).toThrow(
      /non-negative integer/,
    );
  });
});
