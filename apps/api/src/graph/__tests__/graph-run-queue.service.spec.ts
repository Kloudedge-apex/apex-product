import { describe, it, expect, vi, beforeEach } from "vitest";
import { GraphRunQueueService } from "../graph-run-queue.service";

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

  it("uses the raw graphRunId as the jobId for a start enqueue", async () => {
    await svc.enqueueGraphRun({
      kind: "start",
      graphRunId: "run-abc-123",
      orgId: "org-1",
      icpProfileIds: ["icp-1"],
    });
    expect(addMock).toHaveBeenCalledTimes(1);
    const [, , opts] = addMock.mock.calls[0];
    expect(opts.jobId).toBe("run-abc-123");
  });

  it("does NOT use ':' in the resume jobId — BullMQ rejects colons", async () => {
    await svc.enqueueGraphRun({
      kind: "resume",
      graphRunId: "run-abc-123",
      orgId: "org-1",
      resume: { approved: true, approvedBy: "tester" },
    });
    expect(addMock).toHaveBeenCalledTimes(1);
    const [, , opts] = addMock.mock.calls[0];
    expect(opts.jobId).not.toContain(":");
    // Suffix must still distinguish resume from start jobs.
    expect(opts.jobId).toBe("run-abc-123-resume");
  });
});
