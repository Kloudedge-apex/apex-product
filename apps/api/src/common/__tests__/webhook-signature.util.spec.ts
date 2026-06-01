import { describe, it, expect } from "vitest";
import * as crypto from "crypto";
import {
  timingSafeEqualBuffers,
  verifyRazorpayWebhookSignature,
} from "../webhook-signature.util";

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
