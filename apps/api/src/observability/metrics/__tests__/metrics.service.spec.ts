import { describe, it, expect, beforeEach } from "vitest";
import { MetricsService, METRIC, registerCanonicalMetrics } from "../metrics.service";

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
