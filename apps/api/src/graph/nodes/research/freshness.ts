import type { SignalEventKind } from "../../../observability/evidence-event.types";
import { normalizeSignalDate } from "../../../observability/signal-citation";

/**
 * Max age (days) a signal kind may be and still count toward grounding.
 *
 * Keyed by `SignalEventKind`, which deliberately EXCLUDES `intent_signal`:
 * intent is a non-dated string array on `company.intentSignals`, not a
 * ledger-backed dated EvidenceEvent, so it has no freshness window here. Note
 * `assembleResearchBrief`'s query set (`SIGNAL_KINDS`) still lists
 * `intent_signal`; any such row will fall through `isFresh`'s no-window guard
 * and be excluded from grounding. If `intent_signal` ever becomes a real dated
 * ledger signal, give it a window here so it isn't silently dropped.
 */
export const FRESHNESS_WINDOWS: Record<SignalEventKind, number> = {
  recent_hire: 75,
  funding_event: 365,
  leadership_change: 365,
  product_launch: 120,
  press_mention: 90,
};

const DAY_MS = 24 * 60 * 60 * 1000;
// A signal dated slightly in the future (a TZ-ahead source, or a date-only ISO
// compared against a `now` that carries a time-of-day) is real, not fabricated.
// Tolerate one day of skew; anything further in the future is rejected.
const SKEW_TOLERANCE_MS = DAY_MS;

/**
 * True if `isoDate` is within the freshness window for `kind` relative to `now`.
 * Bounded on BOTH sides: a future-dated signal (age < 0 beyond a one-day skew
 * tolerance) is excluded — an event that hasn't happened must never count as a
 * "fresh" grounding fact, or a typo'd/mis-parsed future date would fabricate a
 * trigger the wedge is meant to forbid.
 */
export function isFresh(kind: string, isoDate: string | undefined, now: Date = new Date()): boolean {
  const window = (FRESHNESS_WINDOWS as Record<string, number>)[kind];
  // `window === undefined` (no window for this kind), not `!window`, so a future
  // 0-day "same-day only" window would not be misread as "exclude all".
  const normalizedDate = normalizeSignalDate(isoDate);
  if (window === undefined || !normalizedDate) return false;
  const d = new Date(`${normalizedDate}T00:00:00.000Z`);
  const age = now.getTime() - d.getTime();
  return age >= -SKEW_TOLERANCE_MS && age <= window * DAY_MS;
}
