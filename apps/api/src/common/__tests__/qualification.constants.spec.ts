import { describe, it, expect } from "vitest";
import {
  HIGH_PRIORITY_THRESHOLD,
  LOW_PRIORITY_THRESHOLD,
  QUALIFIED_THRESHOLD,
  isQualifiedScore,
  tierForScore,
} from "../qualification.constants";
import { LeadScorer } from "../../leads/scoring/lead-scorer.service";

/**
 * Guard against threshold drift: if anyone hardcodes a new qualification
 * number anywhere, these tests catch it.
 */
describe("qualification thresholds — single source of truth", () => {
  it("uses the graph-canonical values (75 / 50)", () => {
    // Document the values rather than re-deriving them — if these change
    // intentionally, this test forces a knowing edit.
    expect(QUALIFIED_THRESHOLD).toBe(75);
    expect(HIGH_PRIORITY_THRESHOLD).toBe(75);
    expect(LOW_PRIORITY_THRESHOLD).toBe(50);
  });

  it("HIGH_PRIORITY_THRESHOLD is the qualification floor", () => {
    // The product surface ("qualified") aligns with tier A.
    expect(HIGH_PRIORITY_THRESHOLD).toBe(QUALIFIED_THRESHOLD);
  });

  it("LOW_PRIORITY_THRESHOLD is strictly below the qualification floor", () => {
    expect(LOW_PRIORITY_THRESHOLD).toBeLessThan(QUALIFIED_THRESHOLD);
  });

  it("tierForScore matches the graph's bucketing", () => {
    expect(tierForScore(HIGH_PRIORITY_THRESHOLD)).toBe("A");
    expect(tierForScore(HIGH_PRIORITY_THRESHOLD + 1)).toBe("A");
    expect(tierForScore(HIGH_PRIORITY_THRESHOLD - 1)).toBe("B");
    expect(tierForScore(LOW_PRIORITY_THRESHOLD)).toBe("B");
    expect(tierForScore(LOW_PRIORITY_THRESHOLD - 1)).toBe("C");
    expect(tierForScore(0)).toBe("C");
  });

  it("isQualifiedScore agrees with LeadScorer.isQualified", () => {
    // The scorer and the shared helper must never disagree — that was
    // the original bug (scorer at 100, graph at 75).
    const scorer = new LeadScorer();
    for (const score of [0, 25, 49, 50, 60, 74, 75, 90, 100, 120]) {
      expect(scorer.isQualified(score)).toBe(isQualifiedScore(score));
    }
  });

  it("LeadScorer.isQualified uses QUALIFIED_THRESHOLD as its floor", () => {
    const scorer = new LeadScorer();
    expect(scorer.isQualified(QUALIFIED_THRESHOLD)).toBe(true);
    expect(scorer.isQualified(QUALIFIED_THRESHOLD - 1)).toBe(false);
  });
});
