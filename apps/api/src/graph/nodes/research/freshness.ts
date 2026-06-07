import type { SignalEventKind } from "../../../observability/evidence-event.types";

/** Max age (days) a signal kind may be and still count toward grounding. */
export const FRESHNESS_WINDOWS: Record<SignalEventKind, number> = {
  recent_hire: 75,
  funding_event: 365,
  leadership_change: 365,
  product_launch: 120,
  press_mention: 90,
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** True if `isoDate` is within the freshness window for `kind` relative to `now`. */
export function isFresh(kind: string, isoDate: string | undefined, now: Date = new Date()): boolean {
  const window = (FRESHNESS_WINDOWS as Record<string, number>)[kind];
  if (!window || !isoDate) return false;
  const d = new Date(isoDate);
  if (Number.isNaN(d.getTime())) return false;
  return now.getTime() - d.getTime() <= window * DAY_MS;
}
