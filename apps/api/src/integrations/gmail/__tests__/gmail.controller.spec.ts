import {
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GmailController } from "../gmail.controller";
import { GmailService } from "../gmail.service";

function encodedPush(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), "utf-8").toString("base64");
}

describe("GmailController push durability", () => {
  let controller: GmailController;
  let service: {
    verifyPushAuth: ReturnType<typeof vi.fn>;
    handlePushNotification: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    service = {
      verifyPushAuth: vi.fn().mockResolvedValue(true),
      handlePushNotification: vi.fn().mockResolvedValue(undefined),
    };
    controller = new GmailController(service as unknown as GmailService);
  });

  it("returns success only after durable push processing resolves", async () => {
    const result = await controller.handlePush("Bearer valid", {
      message: {
        data: encodedPush({
          emailAddress: "owner@example.com",
          historyId: "200",
        }),
      },
    });

    expect(service.handlePushNotification).toHaveBeenCalledWith({
      emailAddress: "owner@example.com",
      historyId: "200",
    });
    expect(result).toEqual({ ok: true });
  });

  it("returns a retryable non-2xx exception when durable processing fails", async () => {
    service.handlePushNotification.mockRejectedValue(new Error("database down"));

    await expect(
      controller.handlePush("Bearer valid", {
        message: {
          data: encodedPush({
            emailAddress: "owner@example.com",
            historyId: "200",
          }),
        },
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it("fails closed before decoding when push authentication is invalid", async () => {
    service.verifyPushAuth.mockResolvedValue(false);

    await expect(
      controller.handlePush(undefined, {
        message: {
          data: encodedPush({
            emailAddress: "owner@example.com",
            historyId: "200",
          }),
        },
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(service.handlePushNotification).not.toHaveBeenCalled();
  });

  it("acknowledges malformed envelopes without entering a retry loop", async () => {
    const result = await controller.handlePush("Bearer valid", {
      message: {
        data: Buffer.from("not-json", "utf-8").toString("base64"),
      },
    });

    expect(result).toEqual({ ok: true });
    expect(service.handlePushNotification).not.toHaveBeenCalled();
  });
});
