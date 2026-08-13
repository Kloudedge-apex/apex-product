import { afterEach, describe, it, expect, vi } from "vitest";
import * as crypto from "crypto";
import {
  timingSafeEqualBuffers,
  signOAuthAttemptState,
  verifyOAuthAttemptState,
  verifyRazorpayWebhookSignature,
} from "../webhook-signature.util";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("timingSafeEqualBuffers", () => {
  it("returns true for identical buffers", () => {
    const a = Buffer.from("deadbeef", "hex");
    const b = Buffer.from("deadbeef", "hex");

    expect(timingSafeEqualBuffers(a, b)).toBe(true);
  });

  it("returns false for same-length buffers with different contents", () => {
    const a = Buffer.from("deadbeef", "hex");
    const b = Buffer.from("deadbeee", "hex");

    expect(timingSafeEqualBuffers(a, b)).toBe(false);
  });

  it("returns false (and does not throw) when lengths differ", () => {
    const a = Buffer.from("deadbeef", "hex");
    const b = Buffer.from("deadbeef00", "hex");

    // Node's crypto.timingSafeEqual throws if buffer lengths differ.
    expect(() => crypto.timingSafeEqual(a, b)).toThrow();
    expect(() => timingSafeEqualBuffers(a, b)).not.toThrow();
    expect(timingSafeEqualBuffers(a, b)).toBe(false);
  });
});

describe("verifyRazorpayWebhookSignature", () => {
  it("accepts a valid signature and rejects an invalid one", () => {
    const secret = "secret";
    const rawBody = Buffer.from(JSON.stringify({ ok: true }), "utf8");
    const signature = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");

    expect(() => verifyRazorpayWebhookSignature(rawBody, signature, secret)).not.toThrow();
    expect(() =>
      verifyRazorpayWebhookSignature(rawBody, signature.slice(0, -1) + "0", secret),
    ).toThrow(/Razorpay signature mismatch/);
    expect(() => verifyRazorpayWebhookSignature(rawBody, undefined, secret)).toThrow(
      /Missing X-Razorpay-Signature header/,
    );
  });
});

describe("opaque OAuth attempt state", () => {
  const attemptId = "a".repeat(43);

  it("roundtrips only the opaque attempt pointer and provider", () => {
    vi.stubEnv("OAUTH_STATE_SECRET", "s".repeat(32));
    const expiresAtMs = Date.now() + 60_000;

    const state = signOAuthAttemptState({
      attemptId,
      provider: "gmail",
      expiresAtMs,
    });

    expect(verifyOAuthAttemptState(state)).toEqual({
      attemptId,
      provider: "gmail",
      expiresAtMs,
    });
    expect(state).not.toContain("org_");
    expect(state).not.toContain("user_");
  });

  it("rejects tampering and noncanonical encodings", () => {
    vi.stubEnv("OAUTH_STATE_SECRET", "s".repeat(32));
    const state = signOAuthAttemptState({
      attemptId,
      provider: "gmail",
      expiresAtMs: Date.now() + 60_000,
    });
    const [payload, signature] = state.split(".");

    expect(() =>
      verifyOAuthAttemptState(`${payload}.${signature.slice(0, -1)}x`),
    ).toThrow(/signature|encoding/i);
    expect(() => verifyOAuthAttemptState(`${payload}=.${signature}`)).toThrow(
      /encoding/i,
    );
  });

  it("rejects an expired signed state", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T10:00:00.000Z"));
    vi.stubEnv("OAUTH_STATE_SECRET", "s".repeat(32));
    const state = signOAuthAttemptState({
      attemptId,
      provider: "gmail",
      expiresAtMs: Date.now() + 1_000,
    });

    vi.advanceTimersByTime(1_001);
    expect(() => verifyOAuthAttemptState(state)).toThrow(/expired/i);
  });
});
