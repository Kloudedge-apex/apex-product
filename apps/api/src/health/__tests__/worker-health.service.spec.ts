import { describe, it, expect, vi } from "vitest";
import {
  WorkerHealthService,
  DEFAULT_WORKER_STALL_WINDOW_MS,
  workerStallWindowMs,
} from "../worker-health.service";
import type { QueueStats } from "../../observability/metrics/metrics.service";
import { GRAPH_RUN_QUEUE_NAME } from "../../graph/graph-run-queue.service";
import { OUTREACH_SEND_QUEUE_NAME } from "../../outreach/outreach-send-queue.service";
import { RUN_QUEUE_NAME } from "../../runtime/queue.service";

type StatsLike = Partial<QueueStats> & { queueName: string };

function stats(overrides: StatsLike): QueueStats {
  return {
    waiting: 0,
    active: 0,
    delayed: 0,
    failed: 0,
    completed: 0,
    workerCount: 1,
    ...overrides,
  };
}

interface FakeQueueService {
  getQueueStats: ReturnType<typeof vi.fn>;
}

function fakeSource(
  result: QueueStats | null | Error,
): FakeQueueService {
  return {
    getQueueStats: vi.fn(async () => {
      if (result instanceof Error) throw result;
      return result;
    }),
  };
}

function makeService(
  graph: FakeQueueService,
  outreach: FakeQueueService,
  run: FakeQueueService = fakeSource(stats({ queueName: RUN_QUEUE_NAME })),
): WorkerHealthService {
  return new WorkerHealthService(graph as never, outreach as never, run as never);
}

/** Bare env so ambient OUTREACH_WORKER_ENABLED etc. can't leak into tests. */
const ENV: NodeJS.ProcessEnv = {};

const T0 = 1_700_000_000_000;
const WINDOW = DEFAULT_WORKER_STALL_WINDOW_MS;

describe("workerStallWindowMs", () => {
  it("defaults to 5 minutes", () => {
    expect(workerStallWindowMs({})).toBe(5 * 60_000);
  });

  it("honors a positive numeric override", () => {
    expect(workerStallWindowMs({ WORKER_HEALTH_STALL_WINDOW_MS: "60000" })).toBe(60_000);
  });

  it("falls back on junk values", () => {
    expect(workerStallWindowMs({ WORKER_HEALTH_STALL_WINDOW_MS: "soon" })).toBe(WINDOW);
    expect(workerStallWindowMs({ WORKER_HEALTH_STALL_WINDOW_MS: "-5" })).toBe(WINDOW);
    expect(workerStallWindowMs({ WORKER_HEALTH_STALL_WINDOW_MS: "" })).toBe(WINDOW);
  });
});

describe("WorkerHealthService.check", () => {
  it("reports healthy fallback mode when no Redis is configured (null stats)", async () => {
    const svc = makeService(fakeSource(null), fakeSource(null), fakeSource(null));
    const report = await svc.check(T0, ENV);
    expect(report.healthy).toBe(true);
    expect(report.queues).toHaveLength(3);
    for (const q of report.queues) {
      expect(q.mode).toBe("fallback");
      expect(q.healthy).toBe(true);
    }
  });

  it("covers all three worker queues by name", async () => {
    const svc = makeService(
      fakeSource(stats({ queueName: GRAPH_RUN_QUEUE_NAME })),
      fakeSource(stats({ queueName: OUTREACH_SEND_QUEUE_NAME })),
    );
    const report = await svc.check(T0, ENV);
    expect(report.queues.map((q) => q.queue)).toEqual([
      GRAPH_RUN_QUEUE_NAME,
      OUTREACH_SEND_QUEUE_NAME,
      RUN_QUEUE_NAME,
    ]);
  });

  it("fails when the agent-runs gate is enabled without a consumer", async () => {
    const svc = makeService(
      fakeSource(stats({ queueName: GRAPH_RUN_QUEUE_NAME })),
      fakeSource(stats({ queueName: OUTREACH_SEND_QUEUE_NAME })),
      fakeSource(stats({ queueName: RUN_QUEUE_NAME, workerCount: 0 })),
    );
    const report = await svc.check(T0, { WORKER_ENABLED: "true" });

    expect(report.healthy).toBe(false);
    expect(report.queues[2]?.reasons.join(" ")).toMatch(/WORKER_ENABLED=true/);
  });

  it("requires all fleet consumers from an API process in production", async () => {
    const svc = makeService(
      fakeSource(stats({ queueName: GRAPH_RUN_QUEUE_NAME, workerCount: 0 })),
      fakeSource(stats({ queueName: OUTREACH_SEND_QUEUE_NAME, workerCount: 0 })),
      fakeSource(stats({ queueName: RUN_QUEUE_NAME, workerCount: 0 })),
    );
    const report = await svc.check(T0, { NODE_ENV: "production" });

    expect(report.healthy).toBe(false);
    expect(report.queues).toHaveLength(3);
    for (const queue of report.queues) {
      expect(queue.reasons.join(" ")).toMatch(/production requires an attached consumer/);
    }
  });

  it("fails when jobs are backlogged with zero consumers attached", async () => {
    const svc = makeService(
      fakeSource(
        stats({ queueName: GRAPH_RUN_QUEUE_NAME, waiting: 4, workerCount: 0 }),
      ),
      fakeSource(stats({ queueName: OUTREACH_SEND_QUEUE_NAME })),
    );
    const report = await svc.check(T0, ENV);
    expect(report.healthy).toBe(false);
    const graph = report.queues[0];
    expect(graph?.healthy).toBe(false);
    expect(graph?.reasons.join(" ")).toMatch(/zero BullMQ consumers/);
  });

  it("stays healthy when idle with zero consumers and no worker gate set (api pod)", async () => {
    const svc = makeService(
      fakeSource(stats({ queueName: GRAPH_RUN_QUEUE_NAME, workerCount: 0 })),
      fakeSource(stats({ queueName: OUTREACH_SEND_QUEUE_NAME, workerCount: 0 })),
    );
    const report = await svc.check(T0, ENV);
    expect(report.healthy).toBe(true);
  });

  it("fails when the process is gated to consume but no consumer is attached, even with an empty backlog", async () => {
    const svc = makeService(
      fakeSource(stats({ queueName: GRAPH_RUN_QUEUE_NAME, workerCount: 0 })),
      fakeSource(stats({ queueName: OUTREACH_SEND_QUEUE_NAME, workerCount: 0 })),
    );
    const report = await svc.check(T0, {
      OUTREACH_WORKER_ENABLED: "true",
    });
    expect(report.healthy).toBe(false);
    const outreach = report.queues[1];
    expect(outreach?.healthy).toBe(false);
    expect(outreach?.reasons.join(" ")).toMatch(/OUTREACH_WORKER_ENABLED=true/);
    // graph-runs queue has no gate set in this env → not failing
    expect(report.queues[0]?.healthy).toBe(true);
  });

  it("flags a stall: backlog non-decreasing with zero completions/failures across the window", async () => {
    const graph = fakeSource(
      stats({
        queueName: GRAPH_RUN_QUEUE_NAME,
        waiting: 3,
        completed: 10,
        failed: 2,
      }),
    );
    const svc = makeService(graph, fakeSource(null));

    // First probe records the baseline — healthy (no baseline yet).
    const first = await svc.check(T0, ENV);
    expect(first.healthy).toBe(true);

    // One full window later, identical counts → stalled.
    const second = await svc.check(T0 + WINDOW, ENV);
    expect(second.healthy).toBe(false);
    const verdict = second.queues[0];
    expect(verdict?.reasons.join(" ")).toMatch(/stalled/);
    expect(verdict?.observedWindowMs).toBe(WINDOW);
  });

  it("does NOT flag a stall when completions advanced", async () => {
    const graph = fakeSource(
      stats({ queueName: GRAPH_RUN_QUEUE_NAME, waiting: 3, completed: 10 }),
    );
    const svc = makeService(graph, fakeSource(null));
    await svc.check(T0, ENV);

    graph.getQueueStats.mockResolvedValueOnce(
      stats({ queueName: GRAPH_RUN_QUEUE_NAME, waiting: 3, completed: 11 }),
    );
    const second = await svc.check(T0 + WINDOW, ENV);
    expect(second.healthy).toBe(true);
  });

  it("does NOT flag a stall when failures advanced (jobs are churning, not stuck)", async () => {
    const graph = fakeSource(
      stats({ queueName: GRAPH_RUN_QUEUE_NAME, waiting: 3, failed: 5 }),
    );
    const svc = makeService(graph, fakeSource(null));
    await svc.check(T0, ENV);

    graph.getQueueStats.mockResolvedValueOnce(
      stats({ queueName: GRAPH_RUN_QUEUE_NAME, waiting: 3, failed: 7 }),
    );
    const second = await svc.check(T0 + WINDOW, ENV);
    expect(second.healthy).toBe(true);
  });

  it("does NOT flag a stall when the backlog shrank (retention-trim escape hatch)", async () => {
    const graph = fakeSource(
      stats({ queueName: GRAPH_RUN_QUEUE_NAME, waiting: 5, completed: 1000 }),
    );
    const svc = makeService(graph, fakeSource(null));
    await svc.check(T0, ENV);

    // completed pinned at the removeOnComplete cap, but backlog went down.
    graph.getQueueStats.mockResolvedValueOnce(
      stats({ queueName: GRAPH_RUN_QUEUE_NAME, waiting: 2, completed: 1000 }),
    );
    const second = await svc.check(T0 + WINDOW, ENV);
    expect(second.healthy).toBe(true);
  });

  it("does NOT flag a stall before a full window has elapsed", async () => {
    const graph = fakeSource(
      stats({ queueName: GRAPH_RUN_QUEUE_NAME, waiting: 3 }),
    );
    const svc = makeService(graph, fakeSource(null));
    await svc.check(T0, ENV);
    const second = await svc.check(T0 + WINDOW - 1, ENV);
    expect(second.healthy).toBe(true);
  });

  it("does NOT flag a stall when the baseline backlog was zero (queue only just filled)", async () => {
    const graph = fakeSource(
      stats({ queueName: GRAPH_RUN_QUEUE_NAME, waiting: 0 }),
    );
    const svc = makeService(graph, fakeSource(null));
    await svc.check(T0, ENV);

    graph.getQueueStats.mockResolvedValueOnce(
      stats({ queueName: GRAPH_RUN_QUEUE_NAME, waiting: 9 }),
    );
    const second = await svc.check(T0 + WINDOW, ENV);
    expect(second.healthy).toBe(true);
  });

  it("compares against the NEWEST window-old snapshot, not stale history", async () => {
    const graph = fakeSource(
      stats({ queueName: GRAPH_RUN_QUEUE_NAME, waiting: 3, completed: 0 }),
    );
    const svc = makeService(graph, fakeSource(null));
    await svc.check(T0, ENV); // old: backlog 3, completed 0

    graph.getQueueStats.mockResolvedValueOnce(
      stats({ queueName: GRAPH_RUN_QUEUE_NAME, waiting: 3, completed: 50 }),
    );
    await svc.check(T0 + WINDOW, ENV); // progress happened here

    // Two windows in: identical to the T0+WINDOW snapshot → stalled relative
    // to the NEWEST baseline even though completed grew vs. T0.
    graph.getQueueStats.mockResolvedValueOnce(
      stats({ queueName: GRAPH_RUN_QUEUE_NAME, waiting: 3, completed: 50 }),
    );
    const third = await svc.check(T0 + 2 * WINDOW, ENV);
    expect(third.healthy).toBe(false);
    expect(third.queues[0]?.reasons.join(" ")).toMatch(/stalled/);
  });

  it("respects WORKER_HEALTH_STALL_WINDOW_MS overrides", async () => {
    const graph = fakeSource(
      stats({ queueName: GRAPH_RUN_QUEUE_NAME, waiting: 3 }),
    );
    const svc = makeService(graph, fakeSource(null));
    const env: NodeJS.ProcessEnv = { WORKER_HEALTH_STALL_WINDOW_MS: "60000" };
    await svc.check(T0, env);
    const second = await svc.check(T0 + 60_000, env);
    expect(second.healthy).toBe(false);
    expect(second.stallWindowMs).toBe(60_000);
  });

  it("fails the probe when queue stats are unavailable (Redis down)", async () => {
    const svc = makeService(
      fakeSource(new Error("connect ECONNREFUSED")),
      fakeSource(null),
    );
    const report = await svc.check(T0, ENV);
    expect(report.healthy).toBe(false);
    expect(report.queues[0]?.reasons.join(" ")).toMatch(/stats unavailable/);
  });

  it("fails promptly when queue stats never settle", async () => {
    const hangingSource: FakeQueueService = {
      getQueueStats: vi.fn(() => new Promise(() => undefined)),
    };
    const svc = makeService(hangingSource, fakeSource(null));
    const report = await svc.check(T0, { HEALTH_CHECK_TIMEOUT_MS: "5" });

    expect(report.healthy).toBe(false);
    expect(report.queues[0]?.reasons.join(" ")).toMatch(/timed out after 5ms/);
  });
});
