import { describe, it, expect, beforeEach, vi } from "vitest";
import { BadRequestException, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Request } from "express";
import * as crypto from "crypto";
import { BillingController } from "../billing.controller";
import { BillingService } from "../billing.service";

interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

const TEST_SECRET = "rp_webhook_secret_test_32_bytes_minimum";

function buildHandlerCtx(
  applyWebhookEvent = vi.fn().mockResolvedValue(undefined),
) {
  const billingService = {
    applyWebhookEvent,
    createSubscription: vi.fn(),
    getSubscription: vi.fn(),
  } as unknown as BillingService;
  const config = {
    get: vi.fn((key: string) => {
      if (key === "RAZORPAY_WEBHOOK_SECRET") return TEST_SECRET;
      return undefined;
    }),
  } as unknown as ConfigService;
  return { billingService, config, applyWebhookEvent };
}

function sign(body: Buffer): string {
  return crypto.createHmac("sha256", TEST_SECRET).update(body).digest("hex");
}

function buildSignedRequest(
  body: object,
  opts: { tamper?: boolean; omitSignature?: boolean; omitRawBody?: boolean } = {},
): RawBodyRequest {
  const raw = Buffer.from(JSON.stringify(body), "utf8");
  let signature = sign(raw);
  if (opts.tamper) {
    const idx = signature.length - 1;
    const swap = signature[idx] === "a" ? "b" : "a";
    signature = signature.slice(0, idx) + swap;
  }

  const headers: Record<string, string> = {};
  if (!opts.omitSignature) headers["x-razorpay-signature"] = signature;

  const req: RawBodyRequest = { headers } as unknown as RawBodyRequest;
  if (!opts.omitRawBody) req.rawBody = raw;
  (req as Request).body = body;
  return req;
}

describe("BillingController.handleWebhook", () => {
  let controller: BillingController;
  let applyWebhookEvent: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const ctx = buildHandlerCtx();
    applyWebhookEvent = ctx.applyWebhookEvent;
    controller = new BillingController(ctx.billingService, ctx.config);
  });

  it("dispatches applyWebhookEvent when the HMAC is valid", async () => {
    const body = {
      event: "subscription.activated",
      created_at: Math.floor(Date.now() / 1000),
      payload: { subscription: { entity: { id: "sub_1", status: "active" } } },
    };
    const req = buildSignedRequest(body);

    const result = await controller.handleWebhook(req);

    expect(applyWebhookEvent).toHaveBeenCalledTimes(1);
    expect(applyWebhookEvent).toHaveBeenCalledWith(body);
    expect(result).toEqual({ received: true });
  });

  it("returns 400 when the signature is tampered", async () => {
    const body = {
      event: "subscription.activated",
      created_at: Math.floor(Date.now() / 1000),
      payload: { subscription: { entity: { id: "sub_1", status: "active" } } },
    };
    const req = buildSignedRequest(body, { tamper: true });

    await expect(controller.handleWebhook(req)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(controller.handleWebhook(req)).rejects.toMatchObject({
      message: "Invalid signature",
    });
    expect(applyWebhookEvent).not.toHaveBeenCalled();
  });

  it("returns 400 when x-razorpay-signature is missing", async () => {
    const body = {
      event: "subscription.activated",
      created_at: Math.floor(Date.now() / 1000),
      payload: { subscription: { entity: { id: "sub_1", status: "active" } } },
    };
    const req = buildSignedRequest(body, { omitSignature: true });

    await expect(controller.handleWebhook(req)).rejects.toMatchObject({
      message: "Missing x-razorpay-signature header",
    });
    expect(applyWebhookEvent).not.toHaveBeenCalled();
  });

  it("returns 400 when rawBody is missing", async () => {
    const body = {
      event: "subscription.activated",
      created_at: Math.floor(Date.now() / 1000),
      payload: { subscription: { entity: { id: "sub_1", status: "active" } } },
    };
    const req = buildSignedRequest(body, { omitRawBody: true });

    await expect(controller.handleWebhook(req)).rejects.toMatchObject({
      message: "Missing raw body",
    });
    expect(applyWebhookEvent).not.toHaveBeenCalled();
  });

  it("returns 503 when RAZORPAY_WEBHOOK_SECRET is unset", async () => {
    const billingService = {
      applyWebhookEvent: vi.fn(),
      createSubscription: vi.fn(),
      getSubscription: vi.fn(),
    } as unknown as BillingService;
    const config = {
      get: vi.fn(() => undefined),
    } as unknown as ConfigService;

    const ctrl = new BillingController(billingService, config);
    const req = buildSignedRequest({
      event: "subscription.activated",
      created_at: Math.floor(Date.now() / 1000),
    });

    await expect(ctrl.handleWebhook(req)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await expect(ctrl.handleWebhook(req)).rejects.toMatchObject({
      message: "Webhook not configured",
    });
  });

  it("rejects replays whose created_at is outside the 5-minute window", async () => {
    const req = buildSignedRequest({
      event: "subscription.activated",
      created_at: Math.floor(Date.now() / 1000) - 10 * 60,
      payload: { subscription: { entity: { id: "sub_1", status: "active" } } },
    });

    await expect(controller.handleWebhook(req)).rejects.toMatchObject({
      message: "Webhook timestamp outside tolerance window",
    });
    expect(applyWebhookEvent).not.toHaveBeenCalled();
  });

  it("returns 400 when created_at is missing", async () => {
    const req = buildSignedRequest({
      event: "subscription.activated",
      payload: { subscription: { entity: { id: "sub_1", status: "active" } } },
    });

    await expect(controller.handleWebhook(req)).rejects.toMatchObject({
      message: "Missing created_at",
    });
    expect(applyWebhookEvent).not.toHaveBeenCalled();
  });

  it("returns 400 when created_at is invalid", async () => {
    const req = buildSignedRequest({
      event: "subscription.activated",
      created_at: "nope",
      payload: { subscription: { entity: { id: "sub_1", status: "active" } } },
    });

    await expect(controller.handleWebhook(req)).rejects.toMatchObject({
      message: "Invalid created_at",
    });
    expect(applyWebhookEvent).not.toHaveBeenCalled();
  });
});

