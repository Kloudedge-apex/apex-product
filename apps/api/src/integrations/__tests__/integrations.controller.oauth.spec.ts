import {
  ForbiddenException,
  GoneException,
} from "@nestjs/common";
import type { Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GmailService } from "../gmail/gmail.service";
import { IntegrationsController } from "../integrations.controller";
import { IntegrationsService } from "../integrations.service";
import { OAuthAttemptService } from "../oauth-attempt.service";

describe("IntegrationsController OAuth transaction boundary", () => {
  const attemptId = "a".repeat(43);
  const parkedCode = "encrypted-store-returned-provider-code";
  const publicIntegration = {
    id: "integration_1",
    provider: "gmail",
    status: "CONNECTED",
    scopes: ["gmail.send"],
    lastSyncAt: new Date("2026-08-13T10:00:00.000Z"),
    lastErrorAt: null,
    lastErrorMessage: null,
    createdAt: new Date("2026-08-13T09:00:00.000Z"),
    updatedAt: new Date("2026-08-13T10:00:00.000Z"),
  };

  let controller: IntegrationsController;
  let integrationsService: {
    getOAuthUrl: ReturnType<typeof vi.fn>;
    findByProvider: ReturnType<typeof vi.fn>;
  };
  let gmailService: {
    handleCallback: ReturnType<typeof vi.fn>;
  };
  let oauthAttempts: {
    start: ReturnType<typeof vi.fn>;
    parkAuthorizationCode: ReturnType<typeof vi.fn>;
    consumeAuthorizationCode: ReturnType<typeof vi.fn>;
  };
  let response: Response;
  let redirect: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubEnv("FRONTEND_URL", "https://workforceos.xyz");
    integrationsService = {
      getOAuthUrl: vi.fn().mockReturnValue("https://accounts.google.test/oauth"),
      findByProvider: vi.fn().mockResolvedValue(publicIntegration),
    };
    gmailService = {
      handleCallback: vi.fn().mockResolvedValue(undefined),
    };
    oauthAttempts = {
      start: vi.fn().mockResolvedValue({
        attemptId,
        state: "signed-opaque-state",
        expiresAt: new Date(Date.now() + 60_000),
      }),
      parkAuthorizationCode: vi.fn().mockResolvedValue({
        attemptId,
        provider: "gmail",
      }),
      consumeAuthorizationCode: vi.fn().mockResolvedValue(parkedCode),
    };
    redirect = vi.fn().mockImplementation((_url: string) => response);
    response = { redirect } as unknown as Response;
    controller = new IntegrationsController(
      integrationsService as unknown as IntegrationsService,
      gmailService as unknown as GmailService,
      oauthAttempts as unknown as OAuthAttemptService,
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("binds auth-url state to the initiating Clerk user and organization", async () => {
    await expect(
      controller.gmailAuthUrl("org_1", "user_1"),
    ).resolves.toEqual({ authUrl: "https://accounts.google.test/oauth" });

    expect(oauthAttempts.start).toHaveBeenCalledWith({
      orgId: "org_1",
      clerkUserId: "user_1",
      provider: "gmail",
    });
    expect(integrationsService.getOAuthUrl).toHaveBeenCalledWith(
      "gmail",
      "signed-opaque-state",
    );
    expect(integrationsService.getOAuthUrl).not.toHaveBeenCalledWith(
      "gmail",
      "org_1",
    );
  });

  it("parks the callback code without invoking Gmail or Integration writes", async () => {
    await controller.gmailCallback(
      "gmail-auth-code",
      "signed-opaque-state",
      undefined,
      response,
    );

    expect(oauthAttempts.parkAuthorizationCode).toHaveBeenCalledWith({
      state: "signed-opaque-state",
      expectedProvider: "gmail",
      code: "gmail-auth-code",
    });
    expect(gmailService.handleCallback).not.toHaveBeenCalled();
    expect(integrationsService.findByProvider).not.toHaveBeenCalled();
    expect(redirect).toHaveBeenCalledWith(
      `https://workforceos.xyz/settings/integrations?oauth_attempt=${attemptId}&provider=gmail`,
    );
  });

  it("fails a malformed, expired, replayed, or Redis-failed callback closed", async () => {
    oauthAttempts.parkAuthorizationCode.mockRejectedValue(
      new GoneException("attempt unavailable"),
    );

    await controller.gmailCallback(
      "gmail-auth-code",
      "bad-or-replayed-state",
      undefined,
      response,
    );

    expect(gmailService.handleCallback).not.toHaveBeenCalled();
    expect(integrationsService.findByProvider).not.toHaveBeenCalled();
    expect(redirect).toHaveBeenCalledWith(
      "https://workforceos.xyz/settings/integrations?error=gmail_oauth&provider=gmail",
    );
  });

  it("does not park a code when the provider reports consent denial", async () => {
    await controller.gmailCallback(
      "",
      "signed-opaque-state",
      "access_denied",
      response,
    );

    expect(oauthAttempts.parkAuthorizationCode).not.toHaveBeenCalled();
    expect(gmailService.handleCallback).not.toHaveBeenCalled();
    expect(redirect).toHaveBeenCalledWith(
      "https://workforceos.xyz/settings/integrations?error=gmail_denied&provider=gmail",
    );
  });

  it("keeps unsupported provider callbacks explicitly unavailable", async () => {
    await controller.outlookCallback(
      "outlook-auth-code",
      "signed-state",
      undefined,
      response,
    );

    expect(oauthAttempts.parkAuthorizationCode).not.toHaveBeenCalled();
    expect(gmailService.handleCallback).not.toHaveBeenCalled();
    expect(redirect).toHaveBeenCalledWith(
      "https://workforceos.xyz/settings/integrations?error=outlook_unavailable&provider=outlook",
    );
  });

  it("consumes once, activates canonical Gmail, and returns only the public projection", async () => {
    const result = await controller.finalizeGmail(
      "org_1",
      "user_1",
      { attemptId },
    );

    expect(oauthAttempts.consumeAuthorizationCode).toHaveBeenCalledWith({
      attemptId,
      orgId: "org_1",
      clerkUserId: "user_1",
      provider: "gmail",
    });
    expect(gmailService.handleCallback).toHaveBeenCalledWith(parkedCode, "org_1");
    expect(integrationsService.findByProvider).toHaveBeenCalledWith(
      "org_1",
      "gmail",
    );
    expect(
      oauthAttempts.consumeAuthorizationCode.mock.invocationCallOrder[0],
    ).toBeLessThan(gmailService.handleCallback.mock.invocationCallOrder[0]);
    expect(result).toEqual(publicIntegration);
    expect(result).not.toHaveProperty("credentials");
    expect(result).not.toHaveProperty("encryptedCredentials");
  });

  it("fails a finalization retry before Gmail can run twice", async () => {
    oauthAttempts.consumeAuthorizationCode
      .mockResolvedValueOnce(parkedCode)
      .mockRejectedValueOnce(new GoneException("already used"));

    await controller.finalizeGmail("org_1", "user_1", { attemptId });
    await expect(
      controller.finalizeGmail("org_1", "user_1", { attemptId }),
    ).rejects.toBeInstanceOf(GoneException);
    expect(gmailService.handleCallback).toHaveBeenCalledTimes(1);
  });

  it("does not activate when exact actor or tenant matching fails", async () => {
    oauthAttempts.consumeAuthorizationCode.mockRejectedValue(
      new ForbiddenException("actor mismatch"),
    );

    await expect(
      controller.finalizeGmail("org_other", "user_other", { attemptId }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(gmailService.handleCallback).not.toHaveBeenCalled();
    expect(integrationsService.findByProvider).not.toHaveBeenCalled();
  });

  it("requires a concrete Clerk actor for initiation and finalization", async () => {
    await expect(
      controller.gmailAuthUrl("org_1", undefined),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      controller.finalizeGmail("org_1", undefined, { attemptId }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(oauthAttempts.start).not.toHaveBeenCalled();
    expect(oauthAttempts.consumeAuthorizationCode).not.toHaveBeenCalled();
  });
});
