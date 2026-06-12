import "reflect-metadata";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { RequestMethod } from "@nestjs/common";
import { OutreachSuppressionReason } from "@prisma/client";
import type { Request, Response } from "express";
import { UnsubscribeController } from "../unsubscribe.controller";
import { SuppressionService } from "../suppression.service";
import { SKIP_ORG_GUARD } from "../../common/org-scope.guard";
import { signUnsubscribeToken } from "../unsubscribe-token.util";

/** Nest stores @Get/@Post route metadata under these keys (PATH_METADATA / METHOD_METADATA). */
const PATH_METADATA = "path";
const METHOD_METADATA = "method";

type ServiceMock = Pick<SuppressionService, "suppress"> & {
  suppress: ReturnType<typeof vi.fn>;
};

function mockService(): ServiceMock {
  return {
    suppress: vi.fn().mockResolvedValue({ created: true }),
  };
}

/** Minimal request double — the controller only reads ip + user-agent. */
function mockReq(): Request {
  return {
    ip: "203.0.113.7",
    headers: { "user-agent": "Google-Mail-One-Click" },
  } as unknown as Request;
}

/** Express response double recording status + body for assertions. */
interface ResDouble {
  statusCode: number | null;
  body: unknown;
  status(code: number): ResDouble;
  send(payload?: unknown): ResDouble;
}

function mockRes(): ResDouble {
  const res: ResDouble = {
    statusCode: null,
    body: undefined,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    send(payload?: unknown) {
      res.body = payload;
      return res;
    },
  };
  return res;
}

function asExpress(res: ResDouble): Response {
  return res as unknown as Response;
}

/** Signs with the vitest.setup.ts ENCRYPTION_KEY fallback — same env the controller verifies against. */
function validToken(orgId = "org_1", recipientRef = "person@example.com"): string {
  return signUnsubscribeToken({ orgId, recipientRef });
}

function routeMeta(method: keyof UnsubscribeController): {
  path: unknown;
  method: unknown;
} {
  const handler = UnsubscribeController.prototype[method] as object;
  return {
    path: Reflect.getMetadata(PATH_METADATA, handler) as unknown,
    method: Reflect.getMetadata(METHOD_METADATA, handler) as unknown,
  };
}

describe("UnsubscribeController — route wiring (audit B11)", () => {
  it("registers a true POST route at :token — RFC 8058 providers POST, they never GET", () => {
    const meta = routeMeta("unsubscribeOneClick");
    expect(meta.path).toBe(":token");
    expect(meta.method).toBe(RequestMethod.POST);
  });

  it("keeps the human GET landing at :token unchanged", () => {
    const meta = routeMeta("unsubscribe");
    expect(meta.path).toBe(":token");
    expect(meta.method).toBe(RequestMethod.GET);
  });

  it("remains org-guard exempt at class level so the new POST is public too", () => {
    expect(Reflect.getMetadata(SKIP_ORG_GUARD, UnsubscribeController)).toBe(true);
  });
});

describe("UnsubscribeController — one-click POST behavior (audit B11)", () => {
  let service: ServiceMock;
  let controller: UnsubscribeController;

  beforeEach(() => {
    service = mockService();
    controller = new UnsubscribeController(service as unknown as SuppressionService);
  });

  it("suppresses and returns a bare 200 on a valid one-click POST", async () => {
    const res = mockRes();
    await controller.unsubscribeOneClick(validToken(), mockReq(), asExpress(res));

    expect(res.statusCode).toBe(200);
    // RFC 8058: no redirect, no body required — providers discard it anyway.
    expect(res.body).toBeUndefined();
    expect(service.suppress).toHaveBeenCalledTimes(1);
    expect(service.suppress).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org_1",
        recipientRef: "person@example.com",
        reason: OutreachSuppressionReason.USER_UNSUBSCRIBED,
        source: "unsubscribe_one_click",
      }),
    );
  });

  it("is idempotent — a repeat POST for an already-suppressed recipient still 200s", async () => {
    const token = validToken();

    const first = mockRes();
    await controller.unsubscribeOneClick(token, mockReq(), asExpress(first));
    expect(first.statusCode).toBe(200);

    // Second click: suppress() reports the row already exists.
    service.suppress.mockResolvedValueOnce({ created: false });
    const second = mockRes();
    await controller.unsubscribeOneClick(token, mockReq(), asExpress(second));

    expect(second.statusCode).toBe(200);
    expect(service.suppress).toHaveBeenCalledTimes(2);
  });

  it("rejects garbage tokens with 400 (permanent failure), never 5xx", async () => {
    const res = mockRes();
    await controller.unsubscribeOneClick("not-a-token", mockReq(), asExpress(res));

    expect(res.statusCode).toBe(400);
    expect(service.suppress).not.toHaveBeenCalled();
  });

  it("rejects a tampered signature with 400", async () => {
    const token = validToken();
    const last = token.slice(-1);
    const tampered = token.slice(0, -1) + (last === "A" ? "B" : "A");

    const res = mockRes();
    await controller.unsubscribeOneClick(tampered, mockReq(), asExpress(res));

    expect(res.statusCode).toBe(400);
    expect(service.suppress).not.toHaveBeenCalled();
  });

  it("returns 500 when the suppression write fails so the provider retries", async () => {
    service.suppress.mockRejectedValueOnce(new Error("pg down"));
    const res = mockRes();
    await controller.unsubscribeOneClick(validToken(), mockReq(), asExpress(res));

    expect(res.statusCode).toBe(500);
  });
});

describe("UnsubscribeController — GET human landing unchanged", () => {
  let service: ServiceMock;
  let controller: UnsubscribeController;

  beforeEach(() => {
    service = mockService();
    controller = new UnsubscribeController(service as unknown as SuppressionService);
  });

  it("still renders the HTML confirmation page on a valid GET", async () => {
    const res = mockRes();
    await controller.unsubscribe(validToken(), mockReq(), asExpress(res));

    expect(res.statusCode).toBe(200);
    expect(typeof res.body).toBe("string");
    expect(res.body as string).toContain("<!doctype html");
    expect(res.body as string).toContain("unsubscribed");
    expect(service.suppress).toHaveBeenCalledWith(
      expect.objectContaining({ source: "unsubscribe_token" }),
    );
  });

  it("still renders the HTML error page (400) on an invalid GET", async () => {
    const res = mockRes();
    await controller.unsubscribe("bogus", mockReq(), asExpress(res));

    expect(res.statusCode).toBe(400);
    expect(res.body as string).toContain("invalid");
    expect(service.suppress).not.toHaveBeenCalled();
  });
});
