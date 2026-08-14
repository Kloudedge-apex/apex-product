/**
 * HTTP retry + circuit-breaker primitives.
 *
 * Hand-rolled — no external retry/circuit-breaker dependency — so the surface
 * area is tiny and predictable. Used by every external HTTP caller in the API
 * (Serper, TheirStack, Hunter, GitHub, ATS boards, EDGAR/Companies House,
 * OpenAI/Anthropic/Azure, Tavily, HubSpot, Gmail/Graph, etc.) to avoid
 * cascade failures when an upstream provider rate-limits or briefly degrades.
 *
 * Design choices:
 *   - Retries only on 429 / 503 and on network/abort errors. Other 4xx are
 *     business failures (auth, malformed) and should NOT be retried.
 *   - `Retry-After` is honored when present (seconds OR HTTP-date).
 *   - Exponential backoff with full jitter, capped per attempt.
 *   - Body re-use: callers pass a normal `RequestInit`. If `init.body` is a
 *     `ReadableStream`, the caller is responsible for fresh streams; for
 *     `string`/`Buffer`/`URLSearchParams` bodies we re-send the same value.
 *   - Circuit breaker is in-memory and per-process. That is sufficient for
 *     bursty rate-limit protection in a single API/worker container; the
 *     trade-off is that horizontally-scaled replicas trip independently.
 */

import { Logger } from "@nestjs/common";
import { drainResponseBodyWithLimit } from "./http-body.util";

const log = new Logger("HttpRetry");

// ─── Errors ──────────────────────────────────────────────────────────────

/**
 * Thrown when {@link fetchWithRetry} gives up after exhausting attempts on a
 * rate-limited / unavailable upstream. Distinct from a generic Error so
 * callers can branch (e.g. surface to user as "provider X is throttled").
 */
export class RateLimitedError extends Error {
  readonly name = "RateLimitedError";
  constructor(
    message: string,
    readonly provider: string,
    readonly lastStatus: number | null,
    readonly attempts: number,
  ) {
    super(message);
  }
}

/** Thrown by {@link withCircuitBreaker} when the breaker is open. */
export class CircuitOpenError extends Error {
  readonly name = "CircuitOpenError";
  constructor(readonly breakerName: string, readonly until: number) {
    super(`Circuit breaker "${breakerName}" is open until ${new Date(until).toISOString()}`);
  }
}

// ─── fetchWithRetry ──────────────────────────────────────────────────────

export interface FetchWithRetryOptions {
  /** Logical provider name used in errors / logs. Required for observability. */
  provider: string;
  /** Max total attempts (including the first). Default 5. */
  maxAttempts?: number;
  /** Base delay for exponential backoff in ms. Default 500. */
  baseDelayMs?: number;
  /** Cap per-attempt wait in ms (post-jitter, pre Retry-After). Default 30_000. */
  maxDelayMs?: number;
  /**
   * Override the wait source. Test seam — keeps specs fast and deterministic
   * without monkey-patching `setTimeout`.
   */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Optional transport seam. SSRF-sensitive callers provide a DNS-pinned
   * fetch implementation so retries cannot silently re-resolve a hostname.
   */
  fetchImpl?: (
    input: string | URL,
    init?: RequestInit,
  ) => Promise<Response>;
}

const DEFAULTS = {
  maxAttempts: 5,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Parse a `Retry-After` header value: integer seconds or HTTP-date. */
export function parseRetryAfter(header: string | null, now: number = Date.now()): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (!trimmed) return null;

  // Pure integer => seconds
  if (/^\d+$/.test(trimmed)) {
    const seconds = parseInt(trimmed, 10);
    return Math.max(0, seconds * 1000);
  }

  // HTTP-date (RFC 7231)
  const ts = Date.parse(trimmed);
  if (Number.isNaN(ts)) return null;
  return Math.max(0, ts - now);
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 503;
}

function computeBackoff(attempt: number, base: number, cap: number): number {
  // Full jitter: random in [0, min(cap, base * 2^attempt)]
  const exp = Math.min(cap, base * Math.pow(2, attempt));
  return Math.floor(Math.random() * exp);
}

/**
 * `fetch()` wrapper that retries on 429/503 and on network errors with
 * exponential backoff + jitter. Honors `Retry-After`. Throws
 * {@link RateLimitedError} on final give-up due to throttling.
 *
 * Non-retryable HTTP errors (4xx other than 429, 5xx other than 503) are
 * returned to the caller as a normal `Response` — they decide how to handle.
 */
export async function fetchWithRetry(
  input: string | URL,
  init: RequestInit | undefined,
  opts: FetchWithRetryOptions,
): Promise<Response> {
  const maxAttempts = opts.maxAttempts ?? DEFAULTS.maxAttempts;
  const baseDelayMs = opts.baseDelayMs ?? DEFAULTS.baseDelayMs;
  const maxDelayMs = opts.maxDelayMs ?? DEFAULTS.maxDelayMs;
  const sleep = opts.sleep ?? defaultSleep;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const provider = opts.provider;

  let lastStatus: number | null = null;
  let lastNetworkError: unknown = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const response = await fetchImpl(input, init);

      if (!isRetryableStatus(response.status)) {
        return response;
      }

      lastStatus = response.status;

      // Drain only a bounded prefix. Provider error bodies are untrusted and
      // must not be buffered without limit just to make a connection reusable.
      await drainResponseBodyWithLimit(response);

      if (attempt === maxAttempts - 1) {
        break;
      }

      const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
      const backoffMs = computeBackoff(attempt, baseDelayMs, maxDelayMs);
      const waitMs = Math.min(
        maxDelayMs,
        retryAfterMs !== null ? Math.max(retryAfterMs, backoffMs) : backoffMs,
      );

      log.debug(
        `provider=${provider} attempt=${attempt + 1} status=${response.status} wait=${waitMs}ms`,
      );
      await sleep(waitMs);
      continue;
    } catch (err) {
      // Network error / abort. AbortError on caller-supplied signal => bail.
      if (err instanceof Error && err.name === "AbortError") {
        // Caller-controlled abort (timeout / cancellation). Don't retry.
        // (If the caller's AbortSignal.timeout fires mid-attempt the request
        // itself was aborted; retrying would just hit the same timeout.)
        throw err;
      }

      lastNetworkError = err;
      lastStatus = null;

      if (attempt === maxAttempts - 1) {
        break;
      }

      const backoffMs = computeBackoff(attempt, baseDelayMs, maxDelayMs);
      log.debug(
        `provider=${provider} attempt=${attempt + 1} network-error=${
          err instanceof Error ? err.message : String(err)
        } wait=${backoffMs}ms`,
      );
      await sleep(backoffMs);
      continue;
    }
  }

  const reason =
    lastStatus !== null
      ? `status=${lastStatus}`
      : `network-error=${
          lastNetworkError instanceof Error ? lastNetworkError.message : String(lastNetworkError)
        }`;

  throw new RateLimitedError(
    `${provider} gave up after ${maxAttempts} attempts (${reason})`,
    provider,
    lastStatus,
    maxAttempts,
  );
}

// ─── Circuit breaker ─────────────────────────────────────────────────────

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitBreakerOptions {
  /** Consecutive failures within `windowMs` that trip the breaker. Default 5. */
  failureThreshold?: number;
  /** Window (ms) in which `failureThreshold` failures must occur. Default 60_000. */
  windowMs?: number;
  /** How long the breaker stays open before allowing a half-open probe. Default 30_000. */
  openDurationMs?: number;
  /** Test seam — defaults to `Date.now`. */
  now?: () => number;
}

const BREAKER_DEFAULTS = {
  failureThreshold: 5,
  windowMs: 60_000,
  openDurationMs: 30_000,
};

/**
 * Simple in-memory circuit breaker. Lifecycle:
 *   - CLOSED: requests pass through. Track failures.
 *   - On Nth consecutive failure within windowMs => OPEN.
 *   - OPEN: requests throw {@link CircuitOpenError} until openDurationMs elapses.
 *   - After openDurationMs => HALF_OPEN: one probe is allowed through.
 *     Success => CLOSED. Failure => OPEN again.
 */
export class CircuitBreaker {
  private state: CircuitState = "CLOSED";
  private failures: number[] = [];
  private openedAt = 0;
  private halfOpenInFlight = false;

  private readonly failureThreshold: number;
  private readonly windowMs: number;
  private readonly openDurationMs: number;
  private readonly now: () => number;

  constructor(
    readonly name: string,
    options: CircuitBreakerOptions = {},
  ) {
    this.failureThreshold = options.failureThreshold ?? BREAKER_DEFAULTS.failureThreshold;
    this.windowMs = options.windowMs ?? BREAKER_DEFAULTS.windowMs;
    this.openDurationMs = options.openDurationMs ?? BREAKER_DEFAULTS.openDurationMs;
    this.now = options.now ?? Date.now;
  }

  /** Run `fn`, applying the breaker policy. */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.maybeTransitionFromOpen();

    if (this.state === "OPEN") {
      throw new CircuitOpenError(this.name, this.openedAt + this.openDurationMs);
    }

    if (this.state === "HALF_OPEN") {
      if (this.halfOpenInFlight) {
        // Only one probe at a time.
        throw new CircuitOpenError(this.name, this.openedAt + this.openDurationMs);
      }
      this.halfOpenInFlight = true;
      try {
        const result = await fn();
        this.transition("CLOSED");
        this.failures = [];
        return result;
      } catch (err) {
        this.transition("OPEN");
        this.openedAt = this.now();
        throw err;
      } finally {
        this.halfOpenInFlight = false;
      }
    }

    // CLOSED
    try {
      const result = await fn();
      // Success resets failure counter so transient blips don't accumulate.
      this.failures = [];
      return result;
    } catch (err) {
      this.recordFailure();
      throw err;
    }
  }

  /** Current state — exposed for diagnostics/tests. */
  getState(): CircuitState {
    this.maybeTransitionFromOpen();
    return this.state;
  }

  private recordFailure(): void {
    const t = this.now();
    this.failures.push(t);
    // Prune anything outside the window
    const cutoff = t - this.windowMs;
    while (this.failures.length > 0 && this.failures[0]! < cutoff) {
      this.failures.shift();
    }
    if (this.failures.length >= this.failureThreshold) {
      this.transition("OPEN");
      this.openedAt = t;
    }
  }

  private maybeTransitionFromOpen(): void {
    if (this.state !== "OPEN") return;
    if (this.now() - this.openedAt >= this.openDurationMs) {
      this.transition("HALF_OPEN");
    }
  }

  private transition(next: CircuitState): void {
    if (this.state === next) return;
    log.warn(`circuit breaker "${this.name}" ${this.state} -> ${next}`);
    this.state = next;
  }
}

/** Process-wide registry — one breaker instance per logical provider. */
class CircuitBreakerRegistry {
  private readonly breakers = new Map<string, CircuitBreaker>();

  get(name: string, options?: CircuitBreakerOptions): CircuitBreaker {
    let breaker = this.breakers.get(name);
    if (!breaker) {
      breaker = new CircuitBreaker(name, options);
      this.breakers.set(name, breaker);
    }
    return breaker;
  }

  /** Test seam — wipes all breakers. */
  _resetForTests(): void {
    this.breakers.clear();
  }
}

export const circuitBreakerRegistry = new CircuitBreakerRegistry();

/**
 * Convenience wrapper: run `fn` through the named breaker. The breaker is
 * lazily created on first use. Same options on subsequent calls are ignored.
 */
export async function withCircuitBreaker<T>(
  name: string,
  fn: () => Promise<T>,
  options?: CircuitBreakerOptions,
): Promise<T> {
  const breaker = circuitBreakerRegistry.get(name, options);
  return breaker.execute(fn);
}
