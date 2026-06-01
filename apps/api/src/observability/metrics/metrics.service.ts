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
