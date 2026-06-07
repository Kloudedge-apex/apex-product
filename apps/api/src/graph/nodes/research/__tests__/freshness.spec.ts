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
});
