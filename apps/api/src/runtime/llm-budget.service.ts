import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import IORedis, { type Redis } from "ioredis";
import { buildRedisConnectionOptions } from "./queue.service";

/**
 * LlmBudgetService — per-org daily cap on LLM spend.
 *
 * Audit P0 #16. The previous in-memory `Map` was per-process: with N api
 * replicas + worker replicas each holding its own ledger, a daily cap
 * effectively became the cap × N. This rewrite swaps to a Redis-backed counter
 * keyed on `llm_budget:{orgId}:{yyyy-mm-dd}` with TTL 25h, atomically
 * incremented via a Lua script so the check + add is replica-safe.
 *
 * Reliability model:
 *   • Production: REDIS_URL (or REDIS_HOST) MUST be set or the constructor
 *     throws — same fail-fast as GraphRunQueueService. Redis ping is
 *     attempted lazily on first call; an outage during tryCharge() returns
 *     `allowed: false` (fail-closed) so a partial Redis blip cannot waive
 *     the cap.
 *   • Development: when Redis is not configured, an in-memory fallback
 *     kicks in (per-process Map). Tests use `resetForTesting()` to reset
 *     between cases.
 *
 * Interface stays compatible with the previous version except `tryCharge`
 * and `getSpentToday` are now async. Callers updated in this commit.
 */

const DEFAULT_CAP_USD = 50;
const TTL_SECONDS = 25 * 60 * 60; // 25h — covers UTC day boundary + clock skew
const KEY_PREFIX = "llm_budget";

/**
 * Atomic check + add. Returns:
 *   [allowed, projected_or_current, cap]
 * Encoded as 3 integers/floats so a single Lua call handles the full
 * compare-and-swap. Charge is in micro-USD (×1_000_000) to keep Redis
 * counters as integers and avoid INCRBYFLOAT serialization edge cases.
 */
const TRY_CHARGE_LUA = `
local key = KEYS[1]
local charge_micro = tonumber(ARGV[1])
local cap_micro = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])

local current = tonumber(redis.call('GET', key) or '0')
local projected = current + charge_micro

if projected > cap_micro then
  return {0, current, cap_micro}
end

redis.call('SET', key, projected, 'EX', ttl)
return {1, projected, cap_micro}
`;

export interface BudgetChargeResult {
  readonly allowed: boolean;
  readonly spentToday: number;
  readonly cap: number;
}

@Injectable()
export class LlmBudgetService implements OnModuleDestroy {
  private readonly logger = new Logger(LlmBudgetService.name);
  private readonly redis: Redis | null;
  private readonly inMemoryLedger: Map<string, number> | null;
  private readonly warnedKeys = new Set<string>();

  constructor() {
    const opts = buildRedisConnectionOptions();
    if (opts) {
      // ioredis accepts the same shape BullMQ uses
      // (`{ url }` or `{ host, port, password, tls }`).
      const cast = opts as unknown as Record<string, unknown>;
      this.redis = typeof cast.url === "string"
        ? new IORedis(cast.url as string)
        : new IORedis(cast as never);
      this.inMemoryLedger = null;
      this.logger.log("LlmBudgetService connected to Redis");
    } else if (process.env.NODE_ENV === "production") {
      throw new Error(
        "REDIS_URL (or REDIS_HOST) is required in production. " +
          "Refusing to start LlmBudgetService with an in-memory ledger.",
      );
    } else {
      this.redis = null;
      this.inMemoryLedger = new Map();
      this.logger.warn("REDIS_URL not set — LlmBudgetService falls back to in-memory ledger (dev only)");
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.redis) {
      try {
        await this.redis.quit();
      } catch {
        // Ignore quit errors during shutdown.
      }
    }
  }

  /**
   * Atomically check whether `usdEstimate` can be charged to `orgId` today,
   * and increment the running total if so. Returns the post-charge
   * `spentToday` on success, and the pre-charge `spentToday` on rejection.
   *
   * `usdEstimate` is clamped to `>= 0`; negative or non-finite values are
   * treated as zero and still return `allowed: true`.
   *
   * Fail-closed: a Redis outage returns `allowed: false`. In dev fallback
   * the in-memory map preserves the previous synchronous semantics.
   */
  async tryCharge(orgId: string, usdEstimate: number): Promise<BudgetChargeResult> {
    const cap = this.getCap();
    const charge = Number.isFinite(usdEstimate) && usdEstimate > 0 ? usdEstimate : 0;
    const key = this.bucketKey(orgId);

    if (this.redis) {
      try {
        const chargeMicro = Math.round(charge * 1_000_000);
        const capMicro = Math.round(cap * 1_000_000);
        const result = (await this.redis.eval(
          TRY_CHARGE_LUA,
          1,
          key,
          String(chargeMicro),
          String(capMicro),
          String(TTL_SECONDS),
        )) as [number, number, number];
        const [allowedFlag, valueMicro] = result;
        const spentToday = valueMicro / 1_000_000;
        const allowed = allowedFlag === 1;
        if (!allowed) {
          this.emitThresholdLog(key, orgId, spentToday, cap, /* crossed100 */ true);
        } else if (spentToday >= cap * 0.8 && spentToday - charge < cap * 0.8) {
          this.emitThresholdLog(key, orgId, spentToday, cap, /* crossed100 */ false);
        }
        return { allowed, spentToday, cap };
      } catch (err) {
        // Fail-closed: do NOT permit the call when Redis is unreachable —
        // that's the entire point of moving to Redis in the first place.
        this.logger.error(
          `Redis unavailable during tryCharge for org=${orgId}: ${err instanceof Error ? err.message : "unknown"} — failing closed`,
        );
        return { allowed: false, spentToday: 0, cap };
      }
    }

    // Dev fallback: in-memory.
    if (!this.inMemoryLedger) {
      // Should be unreachable (constructor guarantees one or the other).
      return { allowed: false, spentToday: 0, cap };
    }
    const current = this.inMemoryLedger.get(key) ?? 0;
    const projected = current + charge;
    if (projected > cap) {
      this.emitThresholdLog(key, orgId, current, cap, true);
      return { allowed: false, spentToday: current, cap };
    }
    this.inMemoryLedger.set(key, projected);
    if (current < cap * 0.8 && projected >= cap * 0.8) {
      this.emitThresholdLog(key, orgId, projected, cap, false);
    }
    return { allowed: true, spentToday: projected, cap };
  }

  /** Inspect current spend without mutating. */
  async getSpentToday(orgId: string): Promise<number> {
    const key = this.bucketKey(orgId);
    if (this.redis) {
      try {
        const raw = await this.redis.get(key);
        const microUsd = raw ? Number.parseInt(raw, 10) : 0;
        return Number.isFinite(microUsd) ? microUsd / 1_000_000 : 0;
      } catch (err) {
        this.logger.error(
          `Redis unavailable during getSpentToday for org=${orgId}: ${err instanceof Error ? err.message : "unknown"}`,
        );
        return 0;
      }
    }
    return this.inMemoryLedger?.get(key) ?? 0;
  }

  /** Current cap (env-driven). Re-read each call so tests can flip the env. */
  getCap(): number {
    const raw = process.env.LLM_DAILY_USD_CAP_PER_ORG;
    if (raw === undefined || raw === null || raw === "") return DEFAULT_CAP_USD;
    const parsed = Number.parseFloat(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_CAP_USD;
    return parsed;
  }

  /** Test seam: drop all in-memory state. NOT exposed in prod. */
  async resetForTesting(): Promise<void> {
    if (this.redis) {
      // Flush only our keyspace prefix to avoid stomping unrelated test data.
      const pattern = `${KEY_PREFIX}:*`;
      let cursor = "0";
      do {
        const [next, keys] = await this.redis.scan(cursor, "MATCH", pattern, "COUNT", 100);
        cursor = next;
        if (keys.length > 0) {
          await this.redis.del(...keys);
        }
      } while (cursor !== "0");
    }
    this.inMemoryLedger?.clear();
    this.warnedKeys.clear();
  }

  private bucketKey(orgId: string): string {
    const now = new Date();
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(now.getUTCDate()).padStart(2, "0");
    return `${KEY_PREFIX}:${orgId}:${yyyy}-${mm}-${dd}`;
  }

  private emitThresholdLog(
    bucketKey: string,
    orgId: string,
    spent: number,
    cap: number,
    crossed100: boolean,
  ): void {
    const tag = crossed100 ? "100" : "80";
    const dedupeKey = `${bucketKey}|${tag}`;
    if (this.warnedKeys.has(dedupeKey)) return;
    this.warnedKeys.add(dedupeKey);

    const pct = cap > 0 ? Math.round((spent / cap) * 100) : 0;
    const msg = `org=${orgId} LLM spend ${spent.toFixed(4)}/${cap.toFixed(2)} USD (${pct}%) — daily cap ${crossed100 ? "EXCEEDED" : "warning 80%"}`;
    if (crossed100) {
      this.logger.error(msg);
    } else {
      this.logger.warn(msg);
    }
  }
}
