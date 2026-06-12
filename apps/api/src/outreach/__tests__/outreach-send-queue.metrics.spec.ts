import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  OutreachSendQueueService,
  OUTREACH_SEND_QUEUE_NAME,
} from "../outreach-send-queue.service";
import {
  MetricsService,
  METRIC,
  registerCanonicalMetrics,
} from "../../observability/metrics/metrics.service";

const getJobCountsMock = vi.fn();
const getWorkersMock = vi.fn();

vi.mock("bullmq", () => {
  class Queue {
    add = vi.fn().mockResolvedValue(undefined);
    close = vi.fn().mockResolvedValue(undefined);
    getJobCounts = getJobCountsMock;
    getWorkers = getWorkersMock;
  }
  return { Queue };
});

vi.mock("../../runtime/queue.service", () => ({
  buildRedisConnectionOptions: () => ({ host: "localhost", port: 6379 }),
}));

describe("OutreachSendQueueService queue stats + depth gauge (GL9)", () => {
  let metrics: MetricsService;
  let svc: OutreachSendQueueService;

  beforeEach(() => {
    getJobCountsMock.mockReset();
    getWorkersMock.mockReset();
    getJobCountsMock.mockResolvedValue({
      waiting: 2,
      active: 0,
      delayed: 0,
      failed: 1,
      completed: 5,
    });
    getWorkersMock.mockResolvedValue([]);
    metrics = new MetricsService();
    registerCanonicalMetrics(metrics);
    svc = new OutreachSendQueueService(metrics);
  });

  it("getQueueStats returns counts + workerCount for the outreach-send queue", async () => {
    const stats = await svc.getQueueStats();
    expect(stats).toEqual({
      queueName: OUTREACH_SEND_QUEUE_NAME,
      waiting: 2,
      active: 0,
      delayed: 0,
      failed: 1,
      completed: 5,
      workerCount: 0,
    });
  });

  it("refreshQueueDepthMetrics populates bullmq_queue_depth per state", async () => {
    await svc.refreshQueueDepthMetrics();
    const gauges = metrics.snapshot().gauges[METRIC.BULLMQ_QUEUE_DEPTH];
    expect(gauges).toEqual({
      [`queue=${OUTREACH_SEND_QUEUE_NAME},state=waiting`]: 2,
      [`queue=${OUTREACH_SEND_QUEUE_NAME},state=active`]: 0,
      [`queue=${OUTREACH_SEND_QUEUE_NAME},state=delayed`]: 0,
      [`queue=${OUTREACH_SEND_QUEUE_NAME},state=failed`]: 1,
      [`queue=${OUTREACH_SEND_QUEUE_NAME},state=completed`]: 5,
    });
  });

  it("refreshQueueDepthMetrics swallows Redis errors (never throws)", async () => {
    getJobCountsMock.mockRejectedValue(new Error("redis down"));
    await expect(svc.refreshQueueDepthMetrics()).resolves.toBeUndefined();
  });

  it("does nothing without an injected MetricsService (bare construction)", async () => {
    const bare = new OutreachSendQueueService();
    bare.onModuleInit();
    await bare.refreshQueueDepthMetrics();
    expect(getJobCountsMock).not.toHaveBeenCalled();
    await bare.onModuleDestroy();
  });
});
