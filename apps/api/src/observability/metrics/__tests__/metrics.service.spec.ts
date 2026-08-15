import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Logger } from "@nestjs/common";
import {
  MetricsService,
  METRIC,
  registerCanonicalMetrics,
  publishQueueDepth,
  queueDepthAlertThreshold,
  DEFAULT_QUEUE_DEPTH_ALERT_THRESHOLD,
  QUEUE_DEPTH_HIGH_LOG_MARKER,
  QueueStats,
} from "../metrics.service";

describe("MetricsService", () => {
  let svc: MetricsService;

  beforeEach(() => {
    svc = new MetricsService();
    registerCanonicalMetrics(svc);
  });

  it("registers the four canonical metrics with zero defaults", () => {
    const expo = svc.toPrometheus();
    expect(expo).toMatch(/# TYPE bullmq_queue_depth gauge/);
    expect(expo).toMatch(/# TYPE bullmq_failed_jobs_total counter/);
    expect(expo).toMatch(/# TYPE http_5xx_total counter/);
    expect(expo).toMatch(/# TYPE evaluator_floor_breach_total counter/);
    // Default zero series for each
    expect(expo).toMatch(/^bullmq_queue_depth 0$/m);
    expect(expo).toMatch(/^http_5xx_total 0$/m);
  });

  it("inc() accumulates with stable label-key ordering", () => {
    svc.inc(METRIC.BULLMQ_FAILED_JOBS_TOTAL, { queue: "graph-runs" });
    svc.inc(METRIC.BULLMQ_FAILED_JOBS_TOTAL, { queue: "graph-runs" });
    svc.inc(METRIC.BULLMQ_FAILED_JOBS_TOTAL, { queue: "outreach-send" });
    const snap = svc.snapshot();
    expect(snap.counters[METRIC.BULLMQ_FAILED_JOBS_TOTAL]).toEqual({
      "queue=graph-runs": 2,
      "queue=outreach-send": 1,
    });
  });

  it("set() overwrites the gauge per label-set", () => {
    svc.set(METRIC.BULLMQ_QUEUE_DEPTH, { queue: "graph-runs", state: "waiting" }, 5);
    svc.set(METRIC.BULLMQ_QUEUE_DEPTH, { queue: "graph-runs", state: "waiting" }, 3);
    svc.set(METRIC.BULLMQ_QUEUE_DEPTH, { queue: "graph-runs", state: "active" }, 1);
    const snap = svc.snapshot();
    expect(snap.gauges[METRIC.BULLMQ_QUEUE_DEPTH]).toEqual({
      "queue=graph-runs,state=waiting": 3,
      "queue=graph-runs,state=active": 1,
    });
  });

  it("toPrometheus output round-trips through label rendering", () => {
    svc.inc(METRIC.EVALUATOR_FLOOR_BREACH_TOTAL, { evaluator: "pii_leakage", org: "org_a" });
    svc.inc(METRIC.EVALUATOR_FLOOR_BREACH_TOTAL, { evaluator: "hallucination", org: "org_a" });
    const expo = svc.toPrometheus();
    expect(expo).toMatch(/evaluator_floor_breach_total\{evaluator="pii_leakage",org="org_a"\} 1/);
    expect(expo).toMatch(/evaluator_floor_breach_total\{evaluator="hallucination",org="org_a"\} 1/);
  });

  it("escapes special chars in label values", () => {
    svc.inc(METRIC.HTTP_5XX_TOTAL, { path: 'GET /api/test"x"' });
    const expo = svc.toPrometheus();
    expect(expo).toMatch(/path="GET \/api\/test\\"x\\""/);
  });

  it("auto-registers unknown metrics on inc()", () => {
    const fresh = new MetricsService();
    fresh.inc("brand_new", { k: "v" });
    expect(fresh.snapshot().counters.brand_new).toEqual({ "k=v": 1 });
  });
});

describe("publishQueueDepth (GL9)", () => {
  let svc: MetricsService;

  const stats = (overrides: Partial<QueueStats> = {}): QueueStats => ({
    queueName: "graph-runs",
    waiting: 4,
    active: 1,
    delayed: 2,
    failed: 3,
    completed: 9,
    workerCount: 1,
    ...overrides,
  });

  beforeEach(() => {
    svc = new MetricsService();
    registerCanonicalMetrics(svc);
  });

  it("sets one bullmq_queue_depth series per state", () => {
    publishQueueDepth(svc, stats(), { alertThreshold: 100 });
    expect(svc.snapshot().gauges[METRIC.BULLMQ_QUEUE_DEPTH]).toEqual({
      "queue=graph-runs,state=waiting": 4,
      "queue=graph-runs,state=active": 1,
      "queue=graph-runs,state=delayed": 2,
      "queue=graph-runs,state=failed": 3,
      "queue=graph-runs,state=completed": 9,
    });
  });

  it("emits the QUEUE_DEPTH_HIGH marker when waiting+active reaches the threshold", () => {
    const warn = vi.fn();
    const logger = { warn } as unknown as Logger;
    publishQueueDepth(svc, stats({ waiting: 20, active: 5 }), {
      logger,
      alertThreshold: 25,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    const line = warn.mock.calls[0]?.[0] as string;
    expect(line).toContain(QUEUE_DEPTH_HIGH_LOG_MARKER);
    expect(line).toContain("queue=graph-runs");
  });

  it("stays quiet below the threshold", () => {
    const warn = vi.fn();
    const logger = { warn } as unknown as Logger;
    publishQueueDepth(svc, stats({ waiting: 1, active: 0 }), {
      logger,
      alertThreshold: 25,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("queueDepthAlertThreshold reads env with a sane default", () => {
    expect(queueDepthAlertThreshold({})).toBe(DEFAULT_QUEUE_DEPTH_ALERT_THRESHOLD);
    expect(
      queueDepthAlertThreshold({ BULLMQ_QUEUE_DEPTH_ALERT_THRESHOLD: "50" }),
    ).toBe(50);
    expect(
      queueDepthAlertThreshold({ BULLMQ_QUEUE_DEPTH_ALERT_THRESHOLD: "junk" }),
    ).toBe(DEFAULT_QUEUE_DEPTH_ALERT_THRESHOLD);
  });
});
