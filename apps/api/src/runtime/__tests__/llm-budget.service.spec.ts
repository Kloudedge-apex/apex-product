import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LlmBudgetService } from "../llm-budget.service";

describe("LlmBudgetService", () => {
  let svc: LlmBudgetService;
  const ORIGINAL_ENV = process.env.LLM_DAILY_USD_CAP_PER_ORG;

  beforeEach(() => {
    delete process.env.LLM_DAILY_USD_CAP_PER_ORG;
    svc = new LlmBudgetService();
  });

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.LLM_DAILY_USD_CAP_PER_ORG;
    } else {
      process.env.LLM_DAILY_USD_CAP_PER_ORG = ORIGINAL_ENV;
    }
    vi.useRealTimers();
  });

  describe("default cap", () => {
    it("uses 25 USD when env is unset", () => {
      expect(svc.getCap()).toBe(25);
    });

    it("falls back to default when env is non-numeric", () => {
      process.env.LLM_DAILY_USD_CAP_PER_ORG = "not-a-number";
      expect(svc.getCap()).toBe(25);
    });

    it("falls back to default when env is zero or negative", () => {
      process.env.LLM_DAILY_USD_CAP_PER_ORG = "0";
      expect(svc.getCap()).toBe(25);
      process.env.LLM_DAILY_USD_CAP_PER_ORG = "-5";
      expect(svc.getCap()).toBe(25);
    });

    it("respects env override", () => {
      process.env.LLM_DAILY_USD_CAP_PER_ORG = "7.5";
      expect(svc.getCap()).toBe(7.5);
    });
  });

  describe("tryCharge", () => {
    it("allows small calls and accumulates spend", () => {
      const r1 = svc.tryCharge("org-a", 1);
      expect(r1.allowed).toBe(true);
      expect(r1.spentToday).toBe(1);
      expect(r1.cap).toBe(25);

      const r2 = svc.tryCharge("org-a", 2.5);
      expect(r2.allowed).toBe(true);
      expect(r2.spentToday).toBe(3.5);

      const r3 = svc.tryCharge("org-a", 0.25);
      expect(r3.allowed).toBe(true);
      expect(r3.spentToday).toBe(3.75);
    });

    it("rejects the call that would exceed the cap without mutating", () => {
      process.env.LLM_DAILY_USD_CAP_PER_ORG = "10";
      expect(svc.tryCharge("org-a", 9).allowed).toBe(true);
      // 9 + 1.5 = 10.5 > cap; reject without changing spent
      const blocked = svc.tryCharge("org-a", 1.5);
      expect(blocked.allowed).toBe(false);
      expect(blocked.spentToday).toBe(9);
      expect(blocked.cap).toBe(10);

      // Subsequent smaller call within remaining headroom is still allowed
      const ok = svc.tryCharge("org-a", 1);
      expect(ok.allowed).toBe(true);
      expect(ok.spentToday).toBe(10);

      // And the next dollar fails
      expect(svc.tryCharge("org-a", 0.01).allowed).toBe(false);
    });

    it("allows the call that lands exactly on the cap", () => {
      process.env.LLM_DAILY_USD_CAP_PER_ORG = "5";
      const r = svc.tryCharge("org-a", 5);
      expect(r.allowed).toBe(true);
      expect(r.spentToday).toBe(5);
    });

    it("treats negative and non-finite estimates as zero charge", () => {
      const r1 = svc.tryCharge("org-a", -100);
      expect(r1.allowed).toBe(true);
      expect(r1.spentToday).toBe(0);

      const r2 = svc.tryCharge("org-a", Number.NaN);
      expect(r2.allowed).toBe(true);
      expect(r2.spentToday).toBe(0);

      const r3 = svc.tryCharge("org-a", Number.POSITIVE_INFINITY);
      expect(r3.allowed).toBe(true);
      expect(r3.spentToday).toBe(0);
    });
  });

  describe("multi-tenant isolation", () => {
    it("tracks two orgs independently", () => {
      process.env.LLM_DAILY_USD_CAP_PER_ORG = "10";
      expect(svc.tryCharge("org-a", 8).allowed).toBe(true);
      expect(svc.tryCharge("org-b", 8).allowed).toBe(true);

      // org-a hits cap
      expect(svc.tryCharge("org-a", 5).allowed).toBe(false);
      // org-b still has room
      expect(svc.tryCharge("org-b", 1).allowed).toBe(true);

      expect(svc.getSpentToday("org-a")).toBe(8);
      expect(svc.getSpentToday("org-b")).toBe(9);
    });
  });

  describe("UTC date rollover", () => {
    it("resets the bucket when the UTC date changes", () => {
      process.env.LLM_DAILY_USD_CAP_PER_ORG = "10";
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-05-26T23:30:00Z"));

      expect(svc.tryCharge("org-a", 9).allowed).toBe(true);
      expect(svc.tryCharge("org-a", 5).allowed).toBe(false);

      // Cross UTC midnight — new bucket key, fresh budget
      vi.setSystemTime(new Date("2026-05-27T00:30:00Z"));

      // Previous day's bucket is unreachable for "today" lookups
      expect(svc.getSpentToday("org-a")).toBe(0);

      const fresh = svc.tryCharge("org-a", 9);
      expect(fresh.allowed).toBe(true);
      expect(fresh.spentToday).toBe(9);
    });
  });

  describe("threshold logging", () => {
    it("warns at 80%, errors at 100%, and dedupes per (org,day,threshold)", () => {
      process.env.LLM_DAILY_USD_CAP_PER_ORG = "10";
      const warnSpy = vi.spyOn((svc as unknown as { logger: { warn: (m: string) => void } }).logger, "warn");
      const errorSpy = vi.spyOn((svc as unknown as { logger: { error: (m: string) => void } }).logger, "error");

      // Below 80% — no log
      svc.tryCharge("org-a", 7);
      expect(warnSpy).not.toHaveBeenCalled();

      // Crossing 80% emits warning once
      svc.tryCharge("org-a", 1.5); // 8.5/10 = 85%
      expect(warnSpy).toHaveBeenCalledTimes(1);

      // Further charges within 80–100% don't re-emit warn
      svc.tryCharge("org-a", 0.25); // 8.75/10
      expect(warnSpy).toHaveBeenCalledTimes(1);

      // Hitting cap emits error (8.75 + 5 = 13.75 > 10 → rejected)
      svc.tryCharge("org-a", 5);
      expect(errorSpy).toHaveBeenCalledTimes(1);

      // Repeated reject doesn't spam the error log
      svc.tryCharge("org-a", 5);
      expect(errorSpy).toHaveBeenCalledTimes(1);
    });
  });
});
