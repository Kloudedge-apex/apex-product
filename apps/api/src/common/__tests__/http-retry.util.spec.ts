import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  CircuitBreaker,
  CircuitOpenError,
  RateLimitedError,
  circuitBreakerRegistry,
  fetchWithRetry,
  parseRetryAfter,
  withCircuitBreaker,
} from "../http-retry.util";

const ORIGINAL_FETCH = globalThis.fetch;

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...(headers ?? {}) },
  });
}

describe("parseRetryAfter", () => {
  it("returns ms when given seconds", () => {
    expect(parseRetryAfter("30")).toBe(30_000);
    expect(parseRetryAfter("0")).toBe(0);
  });

  it("returns ms delta when given HTTP-date", () => {
    const now = Date.now();
    const future = new Date(now + 15_000).toUTCString();
    const parsed = parseRetryAfter(future, now);
    // Allow ±1s rounding from UTCString truncating to seconds.
    expect(parsed).not.toBeNull();
    expect(Math.abs((parsed ?? 0) - 15_000)).toBeLessThanOrEqual(1_000);
  });

  it("returns null for missing / garbage", () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("")).toBeNull();
    expect(parseRetryAfter("not-a-date")).toBeNull();
  });

  it("clamps negative HTTP-date deltas to zero", () => {
    const past = new Date(Date.now() - 10_000).toUTCString();
    expect(parseRetryAfter(past)).toBe(0);
  });
});

describe("fetchWithRetry", () => {
  let sleepCalls: number[];
  let sleep: (ms: number) => Promise<void>;

  beforeEach(() => {
    sleepCalls = [];
    sleep = (ms: number) => {
      sleepCalls.push(ms);
      return Promise.resolve();
    };
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    vi.restoreAllMocks();
  });

  it("retries on 429 then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, { error: "throttled" }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const res = await fetchWithRetry("https://example.test/api", undefined, {
      provider: "example",
      sleep,
    });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleepCalls.length).toBe(1);
  });

  it("retries on 503 then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(503, { error: "down" }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const res = await fetchWithRetry("https://example.test/api", undefined, {
      provider: "example",
      sleep,
    });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses an injected DNS-pinned transport for every retry", async () => {
    const globalFetch = vi.fn().mockRejectedValue(new Error("unpinned fetch used"));
    globalThis.fetch = globalFetch as unknown as typeof fetch;
    const pinnedFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(503, { error: "down" }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    const res = await fetchWithRetry("https://example.test/api", undefined, {
      provider: "example",
      sleep,
      fetchImpl: pinnedFetch,
    });

    expect(res.status).toBe(200);
    expect(pinnedFetch).toHaveBeenCalledTimes(2);
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("throws RateLimitedError after exhausting attempts on 429", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(429, { error: "throttled" }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      fetchWithRetry("https://example.test/api", undefined, {
        provider: "example",
        maxAttempts: 5,
        sleep,
      }),
    ).rejects.toMatchObject({
      name: "RateLimitedError",
      provider: "example",
      lastStatus: 429,
      attempts: 5,
    });
    expect(fetchMock).toHaveBeenCalledTimes(5);
    // 4 waits between 5 attempts.
    expect(sleepCalls.length).toBe(4);
  });

  it("returns 4xx other than 429 without retry", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(401, { error: "unauthorized" }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const res = await fetchWithRetry("https://example.test/api", undefined, {
      provider: "example",
      sleep,
    });
    expect(res.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleepCalls.length).toBe(0);
  });

  it("returns 5xx other than 503 without retry", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(500, { error: "boom" }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const res = await fetchWithRetry("https://example.test/api", undefined, {
      provider: "example",
      sleep,
    });
    expect(res.status).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("honors Retry-After header (seconds)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("{}", { status: 429, headers: { "Retry-After": "2" } }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await fetchWithRetry("https://example.test/api", undefined, {
      provider: "example",
      sleep,
      baseDelayMs: 10, // tiny to ensure Retry-After dominates
    });

    expect(sleepCalls.length).toBe(1);
    // Retry-After=2s should dominate over the tiny baseDelay backoff.
    expect(sleepCalls[0]).toBeGreaterThanOrEqual(2_000);
  });

  it("retries on network error then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("ECONNRESET"))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const res = await fetchWithRetry("https://example.test/api", undefined, {
      provider: "example",
      sleep,
    });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry on caller-supplied AbortError", async () => {
    const abortErr = new Error("aborted");
    abortErr.name = "AbortError";
    const fetchMock = vi.fn().mockRejectedValue(abortErr);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      fetchWithRetry("https://example.test/api", undefined, {
        provider: "example",
        sleep,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws RateLimitedError after exhausting attempts on persistent network error", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("ECONNRESET"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      fetchWithRetry("https://example.test/api", undefined, {
        provider: "example",
        maxAttempts: 3,
        sleep,
      }),
    ).rejects.toMatchObject({
      name: "RateLimitedError",
      provider: "example",
      lastStatus: null,
      attempts: 3,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("CircuitBreaker", () => {
  let clock: number;
  const now = () => clock;

  beforeEach(() => {
    clock = 1_000_000;
  });

  it("starts CLOSED and stays CLOSED on success", async () => {
    const breaker = new CircuitBreaker("ok-svc", { now });
    const result = await breaker.execute(async () => "ok");
    expect(result).toBe("ok");
    expect(breaker.getState()).toBe("CLOSED");
  });

  it("opens after threshold consecutive failures within window", async () => {
    const breaker = new CircuitBreaker("flaky-svc", {
      now,
      failureThreshold: 5,
      windowMs: 60_000,
      openDurationMs: 30_000,
    });

    for (let i = 0; i < 5; i++) {
      await expect(
        breaker.execute(async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
    }

    expect(breaker.getState()).toBe("OPEN");

    // Further calls short-circuit with CircuitOpenError.
    await expect(breaker.execute(async () => "wont-run")).rejects.toBeInstanceOf(CircuitOpenError);
  });

  it("transitions OPEN -> HALF_OPEN after openDurationMs", async () => {
    const breaker = new CircuitBreaker("flip", {
      now,
      failureThreshold: 5,
      windowMs: 60_000,
      openDurationMs: 30_000,
    });

    for (let i = 0; i < 5; i++) {
      await expect(
        breaker.execute(async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow();
    }
    expect(breaker.getState()).toBe("OPEN");

    clock += 30_000;
    expect(breaker.getState()).toBe("HALF_OPEN");
  });

  it("HALF_OPEN success closes the breaker and resets failures", async () => {
    const breaker = new CircuitBreaker("recover", {
      now,
      failureThreshold: 5,
      windowMs: 60_000,
      openDurationMs: 30_000,
    });

    for (let i = 0; i < 5; i++) {
      await expect(
        breaker.execute(async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow();
    }
    expect(breaker.getState()).toBe("OPEN");

    clock += 30_001;
    expect(breaker.getState()).toBe("HALF_OPEN");

    const result = await breaker.execute(async () => "recovered");
    expect(result).toBe("recovered");
    expect(breaker.getState()).toBe("CLOSED");
  });

  it("HALF_OPEN failure re-opens", async () => {
    const breaker = new CircuitBreaker("flap", {
      now,
      failureThreshold: 5,
      windowMs: 60_000,
      openDurationMs: 30_000,
    });

    for (let i = 0; i < 5; i++) {
      await expect(
        breaker.execute(async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow();
    }
    clock += 30_001;
    expect(breaker.getState()).toBe("HALF_OPEN");

    await expect(
      breaker.execute(async () => {
        throw new Error("still-down");
      }),
    ).rejects.toThrow("still-down");
    expect(breaker.getState()).toBe("OPEN");

    // And it stays open for another openDurationMs from this point.
    clock += 1_000;
    expect(breaker.getState()).toBe("OPEN");
    clock += 30_000;
    expect(breaker.getState()).toBe("HALF_OPEN");
  });

  it("failures outside the window do not accumulate", async () => {
    const breaker = new CircuitBreaker("slow-bleed", {
      now,
      failureThreshold: 5,
      windowMs: 60_000,
      openDurationMs: 30_000,
    });

    // 4 failures, then >60s passes, then 4 more — should NOT trip.
    for (let i = 0; i < 4; i++) {
      await expect(
        breaker.execute(async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow();
    }
    clock += 60_001;
    for (let i = 0; i < 4; i++) {
      await expect(
        breaker.execute(async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow();
    }
    expect(breaker.getState()).toBe("CLOSED");
  });
});

describe("withCircuitBreaker + registry", () => {
  beforeEach(() => {
    circuitBreakerRegistry._resetForTests();
  });

  it("shares state across calls with the same name", async () => {
    let calls = 0;
    const run = () =>
      withCircuitBreaker(
        "shared-svc",
        async () => {
          calls++;
          throw new Error("boom");
        },
        { failureThreshold: 2, windowMs: 60_000, openDurationMs: 30_000 },
      );

    await expect(run()).rejects.toThrow("boom");
    await expect(run()).rejects.toThrow("boom");
    // Breaker should now be OPEN — third call should not invoke fn.
    await expect(run()).rejects.toBeInstanceOf(CircuitOpenError);
    expect(calls).toBe(2);
  });
});

describe("RateLimitedError", () => {
  it("carries provider / status / attempts", () => {
    const err = new RateLimitedError("oops", "serper", 429, 5);
    expect(err.name).toBe("RateLimitedError");
    expect(err.provider).toBe("serper");
    expect(err.lastStatus).toBe(429);
    expect(err.attempts).toBe(5);
  });
});
