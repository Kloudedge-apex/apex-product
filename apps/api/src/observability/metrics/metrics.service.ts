import { Injectable, Logger } from "@nestjs/common";

/**
 * In-process Prometheus-style metric registry. Audit P0 #15.
 *
 * Why a custom registry instead of @opentelemetry/exporter-prometheus or
 * prom-client: the audit asks for FOUR specific metrics plus a /metrics
 * endpoint. Wiring the full OTel MeterProvider + readers + exporter chain
 * is multi-step and pulls in optional configuration surface that has
 * nothing to do with the audit gap. This file is ~70 LOC, zero new deps,
 * and emits the Prometheus 0.0.4 exposition format that any standard
 * scraper (Grafana Cloud, Azure Monitor, Datadog OpenMetrics) consumes.
 *
 * If/when the platform standardizes on OTel for metrics too, this module
 * is a drop-in swap — the call sites only depend on `inc()` / `set()`.
 */

type Labels = Readonly<Record<string, string>>;

interface CounterDef {
  readonly help: string;
  readonly values: Map<string, number>;
}

interface GaugeDef {
  readonly help: string;
  readonly values: Map<string, number>;
}

function labelKey(labels: Labels): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return "";
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return entries.map(([k, v]) => `${k}=${escapeLabelValue(v)}`).join(",");
}

function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function renderLabels(key: string): string {
  if (!key) return "";
  const parts = key
    .split(",")
    .map((kv) => {
      const eq = kv.indexOf("=");
      return `${kv.slice(0, eq)}="${kv.slice(eq + 1)}"`;
    });
  return `{${parts.join(",")}}`;
}

@Injectable()
export class MetricsService {
  private readonly logger = new Logger(MetricsService.name);
  private readonly counters = new Map<string, CounterDef>();
  private readonly gauges = new Map<string, GaugeDef>();

  /**
   * Register a counter (idempotent). Subsequent inc() calls on a
   * non-registered counter will auto-register with empty help.
   */
  registerCounter(name: string, help: string): void {
    if (!this.counters.has(name)) {
      this.counters.set(name, { help, values: new Map() });
    }
  }

  registerGauge(name: string, help: string): void {
    if (!this.gauges.has(name)) {
      this.gauges.set(name, { help, values: new Map() });
    }
  }

  inc(name: string, labels: Labels = {}, delta = 1): void {
    let def = this.counters.get(name);
    if (!def) {
      def = { help: "", values: new Map() };
      this.counters.set(name, def);
    }
    const key = labelKey(labels);
    def.values.set(key, (def.values.get(key) ?? 0) + delta);
  }

  set(name: string, labels: Labels, value: number): void {
    let def = this.gauges.get(name);
    if (!def) {
      def = { help: "", values: new Map() };
      this.gauges.set(name, def);
    }
    def.values.set(labelKey(labels), value);
  }

  /** Snapshot for tests. */
  snapshot(): { counters: Record<string, Record<string, number>>; gauges: Record<string, Record<string, number>> } {
    const out: { counters: Record<string, Record<string, number>>; gauges: Record<string, Record<string, number>> } = {
      counters: {},
      gauges: {},
    };
    for (const [n, def] of this.counters) {
      out.counters[n] = Object.fromEntries(def.values);
    }
    for (const [n, def] of this.gauges) {
      out.gauges[n] = Object.fromEntries(def.values);
    }
    return out;
  }

  /** Render the full registry in Prometheus 0.0.4 exposition format. */
  toPrometheus(): string {
    const lines: string[] = [];
    for (const [name, def] of this.counters) {
      if (def.help) lines.push(`# HELP ${name} ${def.help}`);
      lines.push(`# TYPE ${name} counter`);
      if (def.values.size === 0) {
        lines.push(`${name} 0`);
      } else {
        for (const [key, value] of def.values) {
          lines.push(`${name}${renderLabels(key)} ${value}`);
        }
      }
    }
    for (const [name, def] of this.gauges) {
      if (def.help) lines.push(`# HELP ${name} ${def.help}`);
      lines.push(`# TYPE ${name} gauge`);
      if (def.values.size === 0) {
        lines.push(`${name} 0`);
      } else {
        for (const [key, value] of def.values) {
          lines.push(`${name}${renderLabels(key)} ${value}`);
        }
      }
    }
    return lines.join("\n") + "\n";
  }

  resetForTesting(): void {
    this.counters.clear();
    this.gauges.clear();
  }
}

// ── Canonical metric names exported for type-safe call sites ─────────────
export const METRIC = {
  BULLMQ_QUEUE_DEPTH: "bullmq_queue_depth",
  BULLMQ_FAILED_JOBS_TOTAL: "bullmq_failed_jobs_total",
  HTTP_5XX_TOTAL: "http_5xx_total",
  EVALUATOR_FLOOR_BREACH_TOTAL: "evaluator_floor_breach_total",
} as const;

export function registerCanonicalMetrics(svc: MetricsService): void {
  svc.registerGauge(METRIC.BULLMQ_QUEUE_DEPTH, "BullMQ queue depth by queue name and state.");
  svc.registerCounter(METRIC.BULLMQ_FAILED_JOBS_TOTAL, "BullMQ failed-job count by queue.");
  svc.registerCounter(METRIC.HTTP_5XX_TOTAL, "Count of HTTP 5xx responses by sanitized path.");
  svc.registerCounter(
    METRIC.EVALUATOR_FLOOR_BREACH_TOTAL,
    "Count of evaluator score floor breaches by evaluator and org.",
  );
}

// ── Queue depth wiring (GO-LIVE GL9) ──────────────────────────────────────
//
// The bullmq_queue_depth gauge existed since audit P0 #15 but nothing set it.
// The queue services (graph/graph-run-queue.service.ts and
// outreach/outreach-send-queue.service.ts) now poll their BullMQ counts on a
// timer and publish through `publishQueueDepth` below. The shared types live
// HERE (not in graph/ or outreach/) so neither queue service has to import
// the other's domain and the health module can consume the same shape — see
// outreach/suppression.module.ts for why we keep cross-domain import edges
// minimal (boot-cycle incident, 2026-06-12).

/** Per-state job counts as returned by BullMQ's Queue.getJobCounts(). */
export interface QueueDepthCounts {
  readonly waiting: number;
  readonly active: number;
  readonly delayed: number;
  readonly failed: number;
  readonly completed: number;
}

/** Counts plus consumer attachment info, for the worker health heuristic. */
export interface QueueStats extends QueueDepthCounts {
  readonly queueName: string;
  /** Number of BullMQ consumers attached to the queue (Queue.getWorkers() —
   * fleet-wide via Redis CLIENT LIST, not per-process). */
  readonly workerCount: number;
}

/**
 * Stable log marker for the depth-based fallback alert. Azure Container Apps
 * has no managed Prometheus scrape of /api/metrics, so scripts/setup-alerts.sh
 * creates a Log Analytics scheduled-query alert matching this exact token in
 * container console logs. Do not reword without updating that script.
 */
export const QUEUE_DEPTH_HIGH_LOG_MARKER = "QUEUE_DEPTH_HIGH";

export const DEFAULT_QUEUE_DEPTH_ALERT_THRESHOLD = 25;

/** waiting+active threshold above which the poller emits the alert marker. */
export function queueDepthAlertThreshold(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.BULLMQ_QUEUE_DEPTH_ALERT_THRESHOLD;
  const parsed = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_QUEUE_DEPTH_ALERT_THRESHOLD;
}

const QUEUE_DEPTH_STATES: ReadonlyArray<keyof QueueDepthCounts> = [
  "waiting",
  "active",
  "delayed",
  "failed",
  "completed",
];

/**
 * Publishes one bullmq_queue_depth series per (queue, state) and emits the
 * QUEUE_DEPTH_HIGH log marker when waiting+active reaches the alert
 * threshold. `set()` is idempotent per label-set, so multiple service
 * instances refreshing the same queue (GraphModule + HealthModule each
 * provide a GraphRunQueueService) converge instead of double-counting.
 */
export function publishQueueDepth(
  svc: MetricsService,
  stats: QueueStats,
  opts: { logger?: Logger; alertThreshold?: number } = {},
): void {
  for (const state of QUEUE_DEPTH_STATES) {
    svc.set(
      METRIC.BULLMQ_QUEUE_DEPTH,
      { queue: stats.queueName, state },
      stats[state],
    );
  }
  const backlog = stats.waiting + stats.active;
  const threshold = opts.alertThreshold ?? queueDepthAlertThreshold();
  if (backlog >= threshold) {
    opts.logger?.warn(
      `${QUEUE_DEPTH_HIGH_LOG_MARKER} queue=${stats.queueName} waiting=${stats.waiting} ` +
        `active=${stats.active} backlog=${backlog} threshold=${threshold} workers=${stats.workerCount}`,
    );
  }
}
