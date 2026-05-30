import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { estimateCostUsd } from "../model-cost";

describe("model-cost", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("computes known model costs (gpt-4o-mini)", () => {
    const cost = estimateCostUsd({
      model: "gpt-4o-mini",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cachedInputTokens: 0,
    });
    expect(cost).toBeCloseTo(0.75, 10);
  });

  it("applies cached input token pricing when provided", () => {
    const cost = estimateCostUsd({
      model: "gpt-4o-mini",
      inputTokens: 1000,
      outputTokens: 2000,
      cachedInputTokens: 400,
    });

    const expected =
      (600 / 1_000_000) * 0.15 +
      (400 / 1_000_000) * 0.075 +
      (2000 / 1_000_000) * 0.6;

    expect(cost).toBeCloseTo(expected, 12);
  });

  it("returns 0 and warns once for unknown models", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cost = estimateCostUsd({
      model: "unknown-model-for-test",
      inputTokens: 123,
      outputTokens: 456,
      cachedInputTokens: 0,
    });
    expect(cost).toBe(0);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});

