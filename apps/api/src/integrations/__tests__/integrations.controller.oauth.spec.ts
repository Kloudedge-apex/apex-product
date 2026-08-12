import type { Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signOAuthState } from "../../common/webhook-signature.util";
import { GmailService } from "../gmail/gmail.service";
import { IntegrationsController } from "../integrations.controller";
import { IntegrationsService } from "../integrations.service";

describe("IntegrationsController OAuth callback routing", () => {
  let controller: IntegrationsController;
  let integrationsService: {
    handleOAuthCallback: ReturnType<typeof vi.fn>;
  };
  let gmailService: {
    handleCallback: ReturnType<typeof vi.fn>;
  };
  let response: Response;
  let redirect: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubEnv(
      "OAUTH_STATE_SECRET",
      "test-oauth-state-secret-that-is-at-least-32-characters",
    );
    vi.stubEnv("FRONTEND_URL", "https://app.example.com");
    integrationsService = {
      handleOAuthCallback: vi.fn().mockResolvedValue(undefined),
    };
    gmailService = {
      handleCallback: vi.fn().mockResolvedValue(undefined),
    };
    redirect = vi.fn().mockImplementation((_url: string) => response);
    response = { redirect } as unknown as Response;
    controller = new IntegrationsController(
      integrationsService as unknown as IntegrationsService,
      gmailService as unknown as GmailService,
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("routes Gmail through GmailService so identity and watch setup run", async () => {
    const state = signOAuthState("org_gmail");

    await controller.gmailCallback("gmail-auth-code", state, response);

    expect(gmailService.handleCallback).toHaveBeenCalledOnce();
    expect(gmailService.handleCallback).toHaveBeenCalledWith(
      "gmail-auth-code",
      "org_gmail",
    );
    expect(integrationsService.handleOAuthCallback).not.toHaveBeenCalled();
    expect(redirect).toHaveBeenCalledWith(
      "https://app.example.com/dashboard/integrations?connected=gmail",
    );
  });

  it("fails closed when a legacy non-Gmail callback reaches the disabled path", async () => {
    integrationsService.handleOAuthCallback.mockRejectedValue(
      new Error("Provider is not available in this release: outlook"),
    );
    const state = signOAuthState("org_outlook");

    await controller.outlookCallback("outlook-auth-code", state, response);

    expect(integrationsService.handleOAuthCallback).toHaveBeenCalledOnce();
    expect(integrationsService.handleOAuthCallback).toHaveBeenCalledWith(
      "outlook",
      "outlook-auth-code",
      "org_outlook",
    );
    expect(gmailService.handleCallback).not.toHaveBeenCalled();
    expect(redirect).toHaveBeenCalledWith(
      "https://app.example.com/dashboard/integrations?error=outlook",
    );
    expect(redirect).not.toHaveBeenCalledWith(
      "https://app.example.com/dashboard/integrations?connected=outlook",
    );
  });

  it("surfaces Gmail activation failure through the callback error redirect", async () => {
    gmailService.handleCallback.mockRejectedValue(
      new Error("Gmail inbound watch registration failed"),
    );
    const state = signOAuthState("org_gmail");

    await controller.gmailCallback("gmail-auth-code", state, response);

    expect(redirect).toHaveBeenCalledWith(
      "https://app.example.com/dashboard/integrations?error=gmail",
    );
    expect(redirect).not.toHaveBeenCalledWith(
      "https://app.example.com/dashboard/integrations?connected=gmail",
    );
  });
});
