import { describe, it, expect, beforeEach, vi } from "vitest";
import { BadRequestException } from "@nestjs/common";
import type { Request } from "express";
import { UnsubscribeController } from "../unsubscribe.controller";
import { SuppressionService } from "../suppression.service";
import { signToken } from "../unsubscribe-token.util";
import { SuppressionKind, SuppressionScope } from "@prisma/client";

interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

describe("UnsubscribeController", () => {
  beforeEach(() => {
    process.env.OUTREACH_UNSUBSCRIBE_SECRET = "test_secret_" + "y".repeat(32);
  });

  it("POST one-click creates an ORG UNSUBSCRIBE suppression", async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    const suppression = { add } as unknown as SuppressionService;
    const controller = new UnsubscribeController(suppression);

    const token = signToken({
      orgId: "org_1",
      recipientEmail: "dest@example.com",
      artifactId: "art_1",
    });

    const req = {
      rawBody: Buffer.from("List-Unsubscribe=One-Click", "utf8"),
    } as unknown as RawBodyRequest;

    await controller.oneClick(token, req, { "List-Unsubscribe": "One-Click" });

    expect(add).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org_1",
        scope: SuppressionScope.ORG,
        kind: SuppressionKind.UNSUBSCRIBE,
        subjectEmail: "dest@example.com",
      }),
    );
  });

  it("rejects when List-Unsubscribe=One-Click is missing", async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    const suppression = { add } as unknown as SuppressionService;
    const controller = new UnsubscribeController(suppression);

    const token = signToken({
      orgId: "org_1",
      recipientEmail: "dest@example.com",
      artifactId: "art_1",
    });

    const req = {
      rawBody: Buffer.from("foo=bar", "utf8"),
    } as unknown as RawBodyRequest;

    await expect(controller.oneClick(token, req, {})).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(add).not.toHaveBeenCalled();
  });
});

