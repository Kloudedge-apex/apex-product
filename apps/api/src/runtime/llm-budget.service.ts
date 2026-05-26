import { Injectable, Logger } from "@nestjs/common";

/**
 * LlmBudgetService — per-org daily cap on LLM spend.
 *
 * MUST-SHIP control: without a cap, a runaway loop or compromised agent can
 * drain the OpenAI/Anthropic budget for the entire tenant. This service is the
 * single arbiter consulted by both the legacy ExecutorService and the LLM
 * chokepoint (LLMService.chat) before any provider call is dispatched.
 *
 * Design:
 *   - In-memory `Map<orgId|yyyy-mm-dd UTC, number>`. Date suffix is what
 *     resets the bucket — old keys sit until process restart, which is fine
 *     for now (the API gets bounced often enough that the map stays small).
 *   - tryCharge() is the atomic check-and-increment used by every caller.
 *     If incrementing would exceed the cap, the increment is NOT applied and
 *     `allowed: false` is returned so the caller can refuse the call.
 *   - Cap is sourced from `LLM_DAILY_USD_CAP_PER_ORG`. Parsed with
 *     `Number.parseFloat`; NaN / non-positive values fall back to the default.
 *   - Warns at 80% of cap, errors at 100% — surfaced once per (org, day,
 *     threshold) so logs aren't spammed across hundreds of LLM calls.
 *
 * Thread-safety: Node is single-threaded per process, and tryCharge reads and
 * writes the map synchronously inside one function call, so there's no
 * interleaving concern within a single API container. Across containers each
 * has its own map — that's a conservative-overshoot model (each container can
 * spend up to the cap independently), but the alternative (Redis-backed
 * counter) is out of scope for this MUST-SHIP slot. Comment flagged in the
 * spec for the reviewer.
 */

const DEFAULT_CAP_USD = 25;

export interface BudgetChargeResult {
  readonly allowed: boolean;
  readonly spentToday: number;
  readonly cap: number;
}

@Injectable()
export class LlmBudgetService {
  private readonly logger = new Logger(LlmBudgetService.name);
  /** `${orgId}|${yyyy-mm-dd}` → cumulative USD spent today */
  private readonly ledger = new Map<string, number>();
  /** keys for which we've already emitted the 80%/100% log — debounces noise */
  private readonly warnedKeys = new Set<string>();

  /**
   * Atomically check whether `usdEstimate` can be charged to `orgId` today,
   * and increment the running total if so. Returns the post-charge `spentToday`
   * on success, and the pre-charge `spentToday` on rejection (so callers can
   * include both in error messages without a second lookup).
   *
   * `usdEstimate` is clamped to `>= 0` — negative inputs are treated as zero
   * and still count as "allowed" (they just don't move the ledger).
   */
  tryCharge(orgId: string, usdEstimate: number): BudgetChargeResult {
    const cap = this.getCap();
    const charge = Number.isFinite(usdEstimate) && usdEstimate > 0 ? usdEstimate : 0;
    const key = this.bucketKey(orgId);
    const current = this.ledger.get(key) ?? 0;
    const projected = current + charge;

    if (projected > cap) {
      this.emitThresholdLog(key, orgId, current, cap, /* crossed100 */ true);
      return { allowed: false, spentToday: current, cap };
    }

    this.ledger.set(key, projected);

    // 80% threshold warning — only after the spend actually moves us over
    // the line, so the first call that crosses it triggers exactly once.
    if (current < cap * 0.8 && projected >= cap * 0.8 && projected <= cap) {
      this.emitThresholdLog(key, orgId, projected, cap, /* crossed100 */ false);
    }

    return { allowed: true, spentToday: projected, cap };
  }

  /** Inspect current spend without mutating. Used by tests and admin endpoints. */
  getSpentToday(orgId: string): number {
    return this.ledger.get(this.bucketKey(orgId)) ?? 0;
  }

  /** Current cap (env-driven). Re-read each call so tests can flip the env. */
  getCap(): number {
    const raw = process.env.LLM_DAILY_USD_CAP_PER_ORG;
    if (raw === undefined || raw === null || raw === "") return DEFAULT_CAP_USD;
    const parsed = Number.parseFloat(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_CAP_USD;
    return parsed;
  }

  /** Test seam: drop all in-memory state. Not exposed via DI in prod. */
  resetForTesting(): void {
    this.ledger.clear();
    this.warnedKeys.clear();
  }

  private bucketKey(orgId: string): string {
    const now = new Date();
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(now.getUTCDate()).padStart(2, "0");
    return `${orgId}|${yyyy}-${mm}-${dd}`;
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
