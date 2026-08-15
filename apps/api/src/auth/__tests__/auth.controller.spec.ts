import { describe, it, expect, beforeEach, vi } from "vitest";
import { UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Webhook } from "svix";
import type { Request } from "express";
import { AuthController } from "../auth.controller";
import { AuthService } from "../auth.service";

interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

// A valid `whsec_*` secret is `whsec_` + base64(random bytes). We use a
// deterministic 32-byte payload so signature math is reproducible.
const TEST_SECRET = "whsec_" + Buffer.alloc(32, 7).toString("base64");
const TEST_MSG_ID = "msg_2abcDEF123";

function buildHandlerCtx(handleWebhook = vi.fn().mockResolvedValue({ received: true })) {
  const authService = {
    handleWebhook,
    getUserByClerkId: vi.fn(),
  } as unknown as AuthService;
  const config = {
    get: vi.fn((key: string) => {
      if (key === "CLERK_WEBHOOK_SECRET") return TEST_SECRET;
      return undefined;
    }),
  } as unknown as ConfigService;
  return { authService, config, handleWebhook };
}

function buildSignedRequest(
  body: object,
  opts: { tamper?: boolean; tsOffsetSec?: number; omit?: "id" | "ts" | "sig" } = {},
): RawBodyRequest {
  const raw = Buffer.from(JSON.stringify(body), "utf8");
  const ts = new Date(Date.now() + (opts.tsOffsetSec ?? 0) * 1000);
  const wh = new Webhook(TEST_SECRET);
  let signature = wh.sign(TEST_MSG_ID, ts, raw);
  if (opts.tamper) {
    // Flip one character of the base64 sig payload (after the "v1," prefix).
    const idx = signature.length - 1;
    const swap = signature[idx] === "A" ? "B" : "A";
    signature = signature.slice(0, idx) + swap;
  }
  const tsSec = Math.floor(ts.getTime() / 1000).toString();

  const headers: Record<string, string> = {};
  if (opts.omit !== "id") headers["svix-id"] = TEST_MSG_ID;
  if (opts.omit !== "ts") headers["svix-timestamp"] = tsSec;
  if (opts.omit !== "sig") headers["svix-signature"] = signature;

  return {
    headers,
    rawBody: raw,
  } as unknown as RawBodyRequest;
}

describe("AuthController.handleWebhook", () => {
  let controller: AuthController;
  let handleWebhook: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const ctx = buildHandlerCtx();
    handleWebhook = ctx.handleWebhook;
    controller = new AuthController(ctx.authService, ctx.config);
  });

  it("dispatches to authService when the svix signature is valid", async () => {
    const body = { type: "user.created", data: { id: "user_1" } };
    const req = buildSignedRequest(body);

    const result = await controller.handleWebhook(req);

    expect(handleWebhook).toHaveBeenCalledTimes(1);
    expect(handleWebhook).toHaveBeenCalledWith(body, {
      id: TEST_MSG_ID,
      timestampSeconds: Number(req.headers["svix-timestamp"]),
    });
    expect(result).toEqual({ received: true });
  });

  it("rejects with 401 when the signature is invalid", async () => {
    const req = buildSignedRequest({ type: "user.created" }, { tamper: true });

    await expect(controller.handleWebhook(req)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(controller.handleWebhook(req)).rejects.toMatchObject({
      message: "Invalid webhook signature",
    });
    expect(handleWebhook).not.toHaveBeenCalled();
  });

  it("rejects with 401 when svix-id is missing", async () => {
    const req = buildSignedRequest({ type: "user.created" }, { omit: "id" });

    await expect(controller.handleWebhook(req)).rejects.toMatchObject({
      message: "Missing svix signature headers",
    });
    expect(handleWebhook).not.toHaveBeenCalled();
  });

  it("rejects with 401 when svix-timestamp is missing", async () => {
    const req = buildSignedRequest({ type: "user.created" }, { omit: "ts" });

    await expect(controller.handleWebhook(req)).rejects.toMatchObject({
      message: "Missing svix signature headers",
    });
    expect(handleWebhook).not.toHaveBeenCalled();
  });

  it("rejects with 401 when svix-signature is missing", async () => {
    const req = buildSignedRequest({ type: "user.created" }, { omit: "sig" });

    await expect(controller.handleWebhook(req)).rejects.toMatchObject({
      message: "Missing svix signature headers",
    });
    expect(handleWebhook).not.toHaveBeenCalled();
  });

  it("rejects replays whose timestamp is outside the 5-minute window", async () => {
    // Sign with a timestamp 10 minutes in the past — svix would still accept
    // (its window is 5 min) but our defense-in-depth check rejects first.
    const req = buildSignedRequest(
      { type: "user.created" },
      { tsOffsetSec: -10 * 60 },
    );

    await expect(controller.handleWebhook(req)).rejects.toMatchObject({
      message: "Webhook timestamp outside tolerance window",
    });
    expect(handleWebhook).not.toHaveBeenCalled();
  });

  it("rejects when raw body is unavailable", async () => {
    const req = {
      headers: {
        "svix-id": TEST_MSG_ID,
        "svix-timestamp": Math.floor(Date.now() / 1000).toString(),
        "svix-signature": "v1,deadbeef",
      },
      // rawBody intentionally omitted
    } as unknown as RawBodyRequest;

    await expect(controller.handleWebhook(req)).rejects.toMatchObject({
      message: "Raw body unavailable; cannot verify signature",
    });
  });

  it("rejects when the webhook secret is unset", async () => {
    const authService = {
      handleWebhook: vi.fn(),
      getUserByClerkId: vi.fn(),
    } as unknown as AuthService;
    const config = {
      get: vi.fn(() => undefined),
    } as unknown as ConfigService;

    const ctrl = new AuthController(authService, config);
    const req = buildSignedRequest({ type: "user.created" });

    await expect(ctrl.handleWebhook(req)).rejects.toMatchObject({
      message: "Webhook secret not configured",
    });
  });
});
