/**
 * Lead qualification score thresholds — single source of truth.
 *
 * History: prior to consolidation these thresholds were duplicated and
 * inconsistent across the codebase:
 *
 *   - `lead-scorer.service.ts` / `leads.service.ts` used `score >= 100` to
 *     set `qualifiedAt` and to filter CSV exports.
 *   - `pipeline-graph.ts` (production wiring) bucketed scores as
 *     `>= 75` → tier "A", `>= 50` → tier "B", else "C", and routed any A/B
 *     lead through outreach.
 *   - `kpi-calculator.service.ts` reported the same A/B/C buckets and
 *     counted `score >= 50` as a "qualified lead" for cost-per-lead KPIs.
 *
 * Decision: adopt the **graph values** (75 / 50) as canonical. The graph is
 * what actually shipped to customers — every outreach lead in production
 * cleared the 75 bar, not 100. The scorer at 100 was over-conservative: it
 * silently dropped ~40% of the leads the graph treated as qualified, which
 * in turn made evaluator correctness scoring disagree with itself (the
 * scorer would mark a lead unqualified while the graph routed it through
 * outreach).
 *
 * `QUALIFIED_THRESHOLD` is set to 75 — the tier-A floor — because that is
 * the score at which a lead is unambiguously "qualified" in both the graph
 * and the KPI distribution. Tier B (50–74) is tracked separately as
 * "low priority" / follow-up candidates: the graph still routes them
 * through outreach, but they are not what the product calls "qualified"
 * on dashboards or in CSV exports.
 *
 * We do NOT introduce a new value (e.g. 90) for "high priority" — every
 * threshold here is one of the values that already existed in the code,
 * to keep the consolidation a pure refactor with no semantic drift.
 *
 * Do NOT change these values without a feature flag — they are user-visible
 * (CSV exports, dashboard "qualified leads" counters, outreach eligibility).
 */

/**
 * Minimum score to consider a lead "qualified" — eligible for outreach,
 * counted in qualified-leads KPIs, included in CSV exports, and stamped
 * with `qualifiedAt`. Matches the graph's tier-A floor.
 */
export const QUALIFIED_THRESHOLD = 75;

/**
 * Minimum score for tier "A" (high priority). Equal to
 * `QUALIFIED_THRESHOLD`; named separately so tier-bucketing call sites
 * read naturally as A / B / C.
 */
export const HIGH_PRIORITY_THRESHOLD = 75;

/**
 * Minimum score for tier "B" — outreach-eligible but lower priority than
 * A. Below this score, leads are tier "C" and excluded from outreach.
 */
export const LOW_PRIORITY_THRESHOLD = 50;

export type LeadTier = "A" | "B" | "C";

/**
 * Bucket a numeric score into a tier using the canonical thresholds.
 * Centralized so the graph, KPI calculator, and any future caller cannot
 * drift apart again.
 */
export function tierForScore(score: number): LeadTier {
  if (score >= HIGH_PRIORITY_THRESHOLD) return "A";
  if (score >= LOW_PRIORITY_THRESHOLD) return "B";
  return "C";
}

/**
 * Is this score at or above the qualification floor?
 */
export function isQualifiedScore(score: number): boolean {
  return score >= QUALIFIED_THRESHOLD;
}
