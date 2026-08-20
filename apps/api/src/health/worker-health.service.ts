import { Injectable } from "@nestjs/common";
import {
  GraphRunQueueService,
  GRAPH_RUN_QUEUE_NAME,
} from "../graph/graph-run-queue.service";
import {
  OutreachSendQueueService,
  OUTREACH_SEND_QUEUE_NAME,
} from "../outreach/outreach-send-queue.service";
import {
  QueueDepthCounts,
  QueueStats,
} from "../observability/metrics/metrics.service";
import { healthCheckTimeoutMs, withHealthTimeout } from "./health-timeout";

/**
 * GO-LIVE GL9: minimum worker-detection layer.
 *
 * Before this service, the only worker "health" signal was the static 200 at
 * /api/health/live — a wedged or mis-deployed worker (consumers never
 * attached, jobs piling up) looked identical to a healthy one. This service
 * answers "are the BullMQ consumers actually consuming?" from queue stats
 * alone, so it works from BOTH the api and the worker process (the BullMQ
 * Queue producer reads counts + the fleet-wide consumer list from Redis).
 *
 * Two failure conditions per supported queue across graph runs and approved
 * outreach sends:
 *
 *  1. NO CONSUMERS — `Queue.getWorkers()` (Redis CLIENT LIST, fleet-wide)
 *     reports zero attached consumers while jobs are backlogged
 *     (waiting+active > 0), OR while the process is env-gated to consume the
 *     queue. Production probes always require both supported fleet consumers, even
 *     when served by an API process whose local worker gates are false. Gate
 *     names are mirrored here instead of imported from worker files to keep
 *     HealthModule's file-import graph tiny; see outreach/suppression.module.ts
 *     for the boot-cycle incident that rule comes from.
 *
 *  2. STALLED — backlog was non-zero at a snapshot at least
 *     `stallWindowMs` ago, has not shrunk since, and neither the completed
 *     nor the failed count has increased. Consumers are attached but nothing
 *     is moving.
 *
 * KNOWN LIMITS of the heuristic (documented deliberately — this is a
 * minimum detection layer for live week, not APM):
 *
 *  - Snapshots live in process memory: detection needs the probe to be
 *    polled at least once per stall window, and a pod restart resets the
 *    baseline (you lose up to one window of stall detection after restart).
 *  - `completed`/`failed` counts are trimmed by removeOnComplete (24h /
 *    1000) and removeOnFail (7d / 5000). A queue sitting at the retention
 *    cap with inflow ≈ outflow can show zero completed-delta while actually
 *    consuming → rare false STALLED positive (the backlog-shrunk escape
 *    hatch covers the common case).
 *  - A backlog that fully drains and refills between probes resets the
 *    baseline → stall windows shorter than the probe interval are missed.
 *  - getWorkers() is fleet-wide, not per-pod: with >1 worker replica, one
 *    wedged replica hides behind a healthy one until throughput stalls.
 */

export const DEFAULT_WORKER_STALL_WINDOW_MS = 5 * 60_000;

/** Snapshots kept per queue (bounded; pruned to 2× the stall window). */
const MAX_SNAPSHOTS_PER_QUEUE = 720;

export function workerStallWindowMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.WORKER_HEALTH_STALL_WINDOW_MS;
  const parsed = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_WORKER_STALL_WINDOW_MS;
}

/**
 * Env var that gates consumption of each queue in a given process. Mirrors
 * the two supported queue gate helpers ("true" only, case-sensitive, default
 * off).
 */
const CONSUMER_GATE_ENV: Readonly<Record<string, string>> = {
  [GRAPH_RUN_QUEUE_NAME]: "GRAPH_RUN_WORKER_ENABLED",
  [OUTREACH_SEND_QUEUE_NAME]: "OUTREACH_WORKER_ENABLED",
};

interface QueueSnapshot {
  readonly at: number;
  readonly backlog: number;
  readonly completed: number;
  readonly failed: number;
}

/** Minimal structural view of the queue services this check consumes. */
interface QueueStatsSource {
  getQueueStats(): Promise<QueueStats | null>;
}

export interface QueueHealthVerdict {
  readonly queue: string;
  readonly mode: "bullmq" | "fallback";
  readonly healthy: boolean;
  readonly reasons: readonly string[];
  readonly workerCount: number | null;
  readonly backlog: number | null;
  readonly counts: QueueDepthCounts | null;
  /** Age of the stall baseline actually compared against, if one existed. */
  readonly observedWindowMs: number | null;
}

export interface WorkerHealthReport {
  readonly healthy: boolean;
  readonly stallWindowMs: number;
  readonly queues: readonly QueueHealthVerdict[];
}

@Injectable()
export class WorkerHealthService {
  private readonly history = new Map<string, QueueSnapshot[]>();

  constructor(
    private readonly graphRunQueue: GraphRunQueueService,
    private readonly outreachSendQueue: OutreachSendQueueService,
  ) {}

  /**
   * `now` and `env` are parameters (with production defaults) so tests can
   * drive the staleness heuristic deterministically — no fake timers, no
   * process.env mutation.
   */
  async check(
    now: number = Date.now(),
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<WorkerHealthReport> {
    const windowMs = workerStallWindowMs(env);
    const sources: ReadonlyArray<readonly [string, QueueStatsSource]> = [
      [GRAPH_RUN_QUEUE_NAME, this.graphRunQueue],
      [OUTREACH_SEND_QUEUE_NAME, this.outreachSendQueue],
    ];

    const timeoutMs = healthCheckTimeoutMs(env);
    const queues = await Promise.all(
      sources.map(([name, source]) =>
        this.evaluateQueue(name, source, now, windowMs, timeoutMs, env),
      ),
    );
    return {
      healthy: queues.every((q) => q.healthy),
      stallWindowMs: windowMs,
      queues,
    };
  }

  private async evaluateQueue(
    name: string,
    source: QueueStatsSource,
    now: number,
    windowMs: number,
    timeoutMs: number,
    env: NodeJS.ProcessEnv,
  ): Promise<QueueHealthVerdict> {
    let stats: QueueStats | null;
    try {
      stats = await withHealthTimeout(
        source.getQueueStats(),
        `${name} queue stats`,
        timeoutMs,
      );
    } catch (err) {
      // Redis unreachable → we cannot confirm consumption. Fail the probe;
      // /health/ready fails on the same condition, so this adds no new
      // flakiness class.
      return {
        queue: name,
        mode: "bullmq",
        healthy: false,
        reasons: [
          `queue stats unavailable: ${err instanceof Error ? err.message : String(err)}`,
        ],
        workerCount: null,
        backlog: null,
        counts: null,
        observedWindowMs: null,
      };
    }

    if (stats === null) {
      // Dev DB-polling fallback (no Redis). Mirrors /health/ready: this is
      // only legitimate outside production (the queue services throw at boot
      // in prod without Redis), so report healthy-but-unassessable.
      return {
        queue: name,
        mode: "fallback",
        healthy: true,
        reasons: [
          "no Redis configured — DB-polling fallback (dev only); consumer health not assessable from queue stats",
        ],
        workerCount: null,
        backlog: null,
        counts: null,
        observedWindowMs: null,
      };
    }

    const backlog = stats.waiting + stats.active;
    const reasons: string[] = [];

    // Condition 1: nobody is consuming.
    if (stats.workerCount === 0) {
      const gateEnvName = CONSUMER_GATE_ENV[name];
      const processExpectsConsumers =
        env.NODE_ENV === "production" ||
        (gateEnvName !== undefined && env[gateEnvName] === "true");
      if (backlog > 0) {
        reasons.push(
          `${backlog} job(s) backlogged on "${name}" with zero BullMQ consumers attached`,
        );
      } else if (processExpectsConsumers) {
        reasons.push(
          `${
            env.NODE_ENV === "production"
              ? "production requires an attached consumer"
              : `this process sets ${gateEnvName ?? "?"}=true`
          } but zero BullMQ consumers are attached to "${name}"`,
        );
      }
    }

    // Condition 2: consumers attached but nothing is moving.
    const baseline = this.findBaseline(name, now, windowMs);
    let observedWindowMs: number | null = null;
    if (baseline) {
      observedWindowMs = now - baseline.at;
      const stalled =
        baseline.backlog > 0 &&
        backlog >= baseline.backlog &&
        stats.completed <= baseline.completed &&
        stats.failed <= baseline.failed;
      if (stalled) {
        reasons.push(
          `"${name}" appears stalled: backlog ${baseline.backlog} -> ${backlog} with no completed/failed progress over ${Math.round(observedWindowMs / 1000)}s`,
        );
      }
    }

    // Record AFTER evaluating so the current probe can never be its own
    // baseline.
    this.recordSnapshot(
      name,
      { at: now, backlog, completed: stats.completed, failed: stats.failed },
      now,
      windowMs,
    );

    return {
      queue: name,
      mode: "bullmq",
      healthy: reasons.length === 0,
      reasons,
      workerCount: stats.workerCount,
      backlog,
      counts: {
        waiting: stats.waiting,
        active: stats.active,
        delayed: stats.delayed,
        failed: stats.failed,
        completed: stats.completed,
      },
      observedWindowMs,
    };
  }

  /** Newest snapshot at least one full stall window old. */
  private findBaseline(
    name: string,
    now: number,
    windowMs: number,
  ): QueueSnapshot | null {
    const snapshots = this.history.get(name);
    if (!snapshots) return null;
    for (let i = snapshots.length - 1; i >= 0; i--) {
      const snapshot = snapshots[i];
      if (snapshot && now - snapshot.at >= windowMs) return snapshot;
    }
    return null;
  }

  private recordSnapshot(
    name: string,
    snapshot: QueueSnapshot,
    now: number,
    windowMs: number,
  ): void {
    const snapshots = this.history.get(name) ?? [];
    snapshots.push(snapshot);
    // Prune anything older than two windows (we only ever compare against
    // the newest >= one-window-old snapshot) and hard-cap the array so a
    // high-frequency prober cannot grow memory unboundedly.
    const cutoff = now - 2 * windowMs;
    const pruned = snapshots
      .filter((s) => s.at >= cutoff)
      .slice(-MAX_SNAPSHOTS_PER_QUEUE);
    this.history.set(name, pruned);
  }
}
