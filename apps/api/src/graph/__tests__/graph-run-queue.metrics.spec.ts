import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  GraphRunQueueService,
  GRAPH_RUN_QUEUE_NAME,
} from "../graph-run-queue.service";
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

describe("GraphRunQueueService queue stats + depth gauge (GL9)", () => {
  let metrics: MetricsService;
  let svc: GraphRunQueueService;

  beforeEach(() => {
    getJobCountsMock.mockReset();
    getWorkersMock.mockReset();
    getJobCountsMock.mockResolvedValue({
      waiting: 4,
      active: 1,
      delayed: 2,
      failed: 3,
      completed: 9,
    });
    getWorkersMock.mockResolvedValue([{ id: "w1" }]);
    metrics = new MetricsService();
    registerCanonicalMetrics(metrics);
    svc = new GraphRunQueueService(metrics);
  });

  it("getQueueStats returns counts + workerCount for the graph-runs queue", async () => {
    const stats = await svc.getQueueStats();
    expect(stats).toEqual({
      queueName: GRAPH_RUN_QUEUE_NAME,
      waiting: 4,
      active: 1,
      delayed: 2,
      failed: 3,
      completed: 9,
      workerCount: 1,
    });
  });

  it("getQueueStats defaults missing states to 0", async () => {
    getJobCountsMock.mockResolvedValue({ waiting: 7 });
    getWorkersMock.mockResolvedValue([]);
    const stats = await svc.getQueueStats();
    expect(stats).toMatchObject({
      waiting: 7,
      active: 0,
      delayed: 0,
      failed: 0,
      completed: 0,
      workerCount: 0,
    });
  });

  it("refreshQueueDepthMetrics populates bullmq_queue_depth per state", async () => {
    await svc.refreshQueueDepthMetrics();
    const gauges = metrics.snapshot().gauges[METRIC.BULLMQ_QUEUE_DEPTH];
    expect(gauges).toEqual({
      [`queue=${GRAPH_RUN_QUEUE_NAME},state=waiting`]: 4,
      [`queue=${GRAPH_RUN_QUEUE_NAME},state=active`]: 1,
      [`queue=${GRAPH_RUN_QUEUE_NAME},state=delayed`]: 2,
      [`queue=${GRAPH_RUN_QUEUE_NAME},state=failed`]: 3,
      [`queue=${GRAPH_RUN_QUEUE_NAME},state=completed`]: 9,
    });
  });

  it("refreshQueueDepthMetrics swallows Redis errors (never throws)", async () => {
    getJobCountsMock.mockRejectedValue(new Error("redis down"));
    await expect(svc.refreshQueueDepthMetrics()).resolves.toBeUndefined();
  });

  it("onModuleInit starts the poll timer and primes the gauge", async () => {
    vi.useFakeTimers();
    try {
      svc.onModuleInit();
      // allow the primed refresh microtasks to flush
      await vi.advanceTimersByTimeAsync(0);
      expect(getJobCountsMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(getJobCountsMock).toHaveBeenCalledTimes(2);
      await svc.onModuleDestroy();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(getJobCountsMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does nothing without an injected MetricsService (bare construction)", async () => {
    const bare = new GraphRunQueueService();
    bare.onModuleInit();
    await bare.refreshQueueDepthMetrics();
    expect(getJobCountsMock).not.toHaveBeenCalled();
    await bare.onModuleDestroy();
  });
});
