import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LlmBudgetService } from "../llm-budget.service";

describe("LlmBudgetService", () => {
  let svc: LlmBudgetService;
  const ORIGINAL_ENV = process.env.LLM_DAILY_USD_CAP_PER_ORG;
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

  beforeEach(() => {
    delete process.env.LLM_DAILY_USD_CAP_PER_ORG;
    // Spec runs without REDIS_URL — service falls back to in-memory ledger.
    // We assert NODE_ENV is not "production" so the constructor permits that.
    delete process.env.NODE_ENV;
    svc = new LlmBudgetService();
  });

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.LLM_DAILY_USD_CAP_PER_ORG;
    } else {
      process.env.LLM_DAILY_USD_CAP_PER_ORG = ORIGINAL_ENV;
    }
    if (ORIGINAL_NODE_ENV === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    }
    vi.useRealTimers();
  });

  describe("default cap", () => {
    it("uses 50 USD when env is unset", () => {
      expect(svc.getCap()).toBe(50);
    });

    it("falls back to default when env is non-numeric", () => {
      process.env.LLM_DAILY_USD_CAP_PER_ORG = "not-a-number";
      expect(svc.getCap()).toBe(50);
    });

    it("falls back to default when env is zero or negative", () => {
      process.env.LLM_DAILY_USD_CAP_PER_ORG = "0";
      expect(svc.getCap()).toBe(50);
      process.env.LLM_DAILY_USD_CAP_PER_ORG = "-5";
      expect(svc.getCap()).toBe(50);
    });

    it("respects env override", () => {
      process.env.LLM_DAILY_USD_CAP_PER_ORG = "7.5";
      expect(svc.getCap()).toBe(7.5);
    });
  });

  describe("tryCharge", () => {
    it("allows small calls and accumulates spend", async () => {
      const r1 = await svc.tryCharge("org-a", 1);
      expect(r1.allowed).toBe(true);
      expect(r1.spentToday).toBe(1);
      expect(r1.cap).toBe(50);

      const r2 = await svc.tryCharge("org-a", 2.5);
      expect(r2.allowed).toBe(true);
      expect(r2.spentToday).toBe(3.5);

      const r3 = await svc.tryCharge("org-a", 0.25);
      expect(r3.allowed).toBe(true);
      expect(r3.spentToday).toBe(3.75);
    });

    it("rejects the call that would exceed the cap without mutating", async () => {
      process.env.LLM_DAILY_USD_CAP_PER_ORG = "10";
      expect((await svc.tryCharge("org-a", 9)).allowed).toBe(true);
      const blocked = await svc.tryCharge("org-a", 1.5);
      expect(blocked.allowed).toBe(false);
      expect(blocked.spentToday).toBe(9);
      expect(blocked.cap).toBe(10);

      const ok = await svc.tryCharge("org-a", 1);
      expect(ok.allowed).toBe(true);
      expect(ok.spentToday).toBe(10);

      expect((await svc.tryCharge("org-a", 0.01)).allowed).toBe(false);
    });

    it("allows the call that lands exactly on the cap", async () => {
      process.env.LLM_DAILY_USD_CAP_PER_ORG = "5";
      const r = await svc.tryCharge("org-a", 5);
      expect(r.allowed).toBe(true);
      expect(r.spentToday).toBe(5);
    });

    it("treats negative and non-finite estimates as zero charge", async () => {
      const r1 = await svc.tryCharge("org-a", -100);
      expect(r1.allowed).toBe(true);
      expect(r1.spentToday).toBe(0);

      const r2 = await svc.tryCharge("org-a", Number.NaN);
      expect(r2.allowed).toBe(true);
      expect(r2.spentToday).toBe(0);

      const r3 = await svc.tryCharge("org-a", Number.POSITIVE_INFINITY);
      expect(r3.allowed).toBe(true);
      expect(r3.spentToday).toBe(0);
    });
  });

  describe("multi-tenant isolation", () => {
    it("tracks two orgs independently", async () => {
      process.env.LLM_DAILY_USD_CAP_PER_ORG = "10";
      expect((await svc.tryCharge("org-a", 8)).allowed).toBe(true);
      expect((await svc.tryCharge("org-b", 8)).allowed).toBe(true);

      expect((await svc.tryCharge("org-a", 5)).allowed).toBe(false);
      expect((await svc.tryCharge("org-b", 1)).allowed).toBe(true);

      expect(await svc.getSpentToday("org-a")).toBe(8);
      expect(await svc.getSpentToday("org-b")).toBe(9);
    });
  });

  describe("UTC date rollover", () => {
    it("resets the bucket when the UTC date changes", async () => {
      process.env.LLM_DAILY_USD_CAP_PER_ORG = "10";
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-05-26T23:30:00Z"));

      expect((await svc.tryCharge("org-a", 9)).allowed).toBe(true);
      expect((await svc.tryCharge("org-a", 5)).allowed).toBe(false);

      vi.setSystemTime(new Date("2026-05-27T00:30:00Z"));

      expect(await svc.getSpentToday("org-a")).toBe(0);

      const fresh = await svc.tryCharge("org-a", 9);
      expect(fresh.allowed).toBe(true);
      expect(fresh.spentToday).toBe(9);
    });
  });

  describe("threshold logging", () => {
    it("warns at 80%, errors at 100%, and dedupes per (org,day,threshold)", async () => {
      process.env.LLM_DAILY_USD_CAP_PER_ORG = "10";
      const warnSpy = vi.spyOn((svc as unknown as { logger: { warn: (m: string) => void } }).logger, "warn");
      const errorSpy = vi.spyOn((svc as unknown as { logger: { error: (m: string) => void } }).logger, "error");

      await svc.tryCharge("org-a", 7);
      expect(warnSpy).not.toHaveBeenCalled();

      await svc.tryCharge("org-a", 1.5); // 8.5/10 = 85%
      expect(warnSpy).toHaveBeenCalledTimes(1);

      await svc.tryCharge("org-a", 0.25); // 8.75/10
      expect(warnSpy).toHaveBeenCalledTimes(1);

      await svc.tryCharge("org-a", 5); // rejected
      expect(errorSpy).toHaveBeenCalledTimes(1);

      await svc.tryCharge("org-a", 5);
      expect(errorSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("production guard", () => {
    it("throws at construction when NODE_ENV=production and no Redis configured", () => {
      process.env.NODE_ENV = "production";
      delete process.env.REDIS_URL;
      delete process.env.REDIS_HOST;
      expect(() => new LlmBudgetService()).toThrow(/Redis/i);
    });
  });
});
