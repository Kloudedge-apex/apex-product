import { describe, it, expect } from "vitest";
import { isFresh, FRESHNESS_WINDOWS } from "../freshness";
describe("isFresh", () => {
  const now = new Date("2026-06-07T00:00:00Z");
  it("counts a recent_hire within 75d as fresh", () => {
    expect(isFresh("recent_hire", "2026-05-01", now)).toBe(true);
  });
  it("excludes a recent_hire older than 75d", () => {
    expect(isFresh("recent_hire", "2026-01-01", now)).toBe(false);
  });
  it("uses a longer window for funding_event", () => {
    expect(isFresh("funding_event", "2025-09-01", now)).toBe(true);
    expect(FRESHNESS_WINDOWS.funding_event).toBeGreaterThan(FRESHNESS_WINDOWS.recent_hire);
  });
  it("excludes a future-dated signal (an event that hasn't happened cannot ground)", () => {
    // The wedge exists to stop fabricated grounding; a future date (typo, TZ
    // skew, or a mis-parsed non-ISO string) must NOT count as fresh.
    expect(isFresh("recent_hire", "2026-06-12", now)).toBe(false);
    expect(isFresh("funding_event", "2029-01-01", now)).toBe(false);
  });
  it("excludes impossible and non-ISO calendar dates", () => {
    expect(isFresh("recent_hire", "2026-02-30", now)).toBe(false);
    expect(isFresh("recent_hire", "06/01/2026", now)).toBe(false);
  });
  it("tolerates a one-day clock/TZ skew so a today/tomorrow source isn't false-stale", () => {
    expect(isFresh("recent_hire", "2026-06-07", now)).toBe(true);
    expect(isFresh("recent_hire", "2026-06-08", now)).toBe(true);
  });
});
