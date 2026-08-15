import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  Query,
  Res,
  Logger,
  UseGuards,
  ForbiddenException,
} from "@nestjs/common";
import { Response } from "express";
import { IntegrationsService } from "./integrations.service";
import { GmailService } from "./gmail/gmail.service";
import { ClerkUserId, OrgId } from "../common/org-context.decorator";
import { SkipOrgGuard } from "../common/org-scope.guard";
import {
  CreateIntegrationDto,
  ConnectIntegrationDto,
  FinalizeGmailOAuthDto,
} from "../common/dto/integrations.dto";
import { AdminOrManagerGuard } from "../common/admin-or-manager.guard";
import { OAuthAttemptService } from "./oauth-attempt.service";

@Controller("integrations")
export class IntegrationsController {
  private readonly logger = new Logger(IntegrationsController.name);

  constructor(
    private readonly integrationsService: IntegrationsService,
    private readonly gmailService: GmailService,
    private readonly oauthAttempts: OAuthAttemptService,
  ) {}

  @Get()
  findAll(@OrgId() orgId: string) {
    return this.integrationsService.findAll(orgId);
  }

  @Post()
  @UseGuards(AdminOrManagerGuard)
  create(@OrgId() orgId: string, @Body() body: CreateIntegrationDto) {
    return this.integrationsService.create(orgId, body);
  }

  @Delete(":id")
  @UseGuards(AdminOrManagerGuard)
  remove(@OrgId() orgId: string, @Param("id") id: string) {
    return this.integrationsService.disconnect(id, orgId);
  }

  @SkipOrgGuard()
  @Get("catalog")
  getCatalog() {
    return this.integrationsService.getCatalog();
  }

  // ── OAuth init: authenticated, orgId derived from JWT ───────────────────
  //
  // The legacy `/:provider/auth` route used `res.redirect(302, url)` so a
  // browser could navigate to it directly — but that pattern is incompatible
  // with `Authorization: Bearer …`, which a top-level navigation can't send.
  // `/:provider/auth-url` returns the provider URL as JSON so the SPA can
  // perform `window.location.href = authUrl` after a Bearer-authenticated XHR.

  @Get("gmail/auth-url")
  @UseGuards(AdminOrManagerGuard)
  async gmailAuthUrl(
    @OrgId() orgId: string,
    @ClerkUserId() clerkUserId: string | undefined,
  ) {
    if (!clerkUserId) {
      throw new ForbiddenException("A Clerk user is required for Gmail OAuth");
    }
    const attempt = await this.oauthAttempts.start({
      orgId,
      clerkUserId,
      provider: "gmail",
    });
    return {
      authUrl: this.integrationsService.getOAuthUrl("gmail", attempt.state),
    };
  }

  @Get("outlook/auth-url")
  @UseGuards(AdminOrManagerGuard)
  outlookAuthUrl(@OrgId() orgId: string) {
    void orgId;
    return { authUrl: this.integrationsService.getOAuthUrl("outlook", "") };
  }

  @Get("hubspot/auth-url")
  @UseGuards(AdminOrManagerGuard)
  hubspotAuthUrl(@OrgId() orgId: string) {
    void orgId;
    return { authUrl: this.integrationsService.getOAuthUrl("hubspot", "") };
  }

  // ── OAuth callbacks: no JWT (browser redirect from provider). A callback
  //    can only park an encrypted code against an opaque, actor-bound attempt.
  //    It cannot read or mutate Integration rows.

  @Get("gmail/callback")
  @SkipOrgGuard()
  gmailCallback(
    @Query("code") code: string,
    @Query("state") state: string,
    @Query("error") error: string | undefined,
    @Res() res: Response,
  ) {
    return this.handleProviderCallback("gmail", code, state, error, res);
  }

  @Get("outlook/callback")
  @SkipOrgGuard()
  outlookCallback(
    @Query("code") code: string,
    @Query("state") state: string,
    @Query("error") error: string | undefined,
    @Res() res: Response,
  ) {
    return this.handleProviderCallback("outlook", code, state, error, res);
  }

  @Get("hubspot/callback")
  @SkipOrgGuard()
  hubspotCallback(
    @Query("code") code: string,
    @Query("state") state: string,
    @Query("error") error: string | undefined,
    @Res() res: Response,
  ) {
    return this.handleProviderCallback("hubspot", code, state, error, res);
  }

  @Post("gmail/finalize")
  @UseGuards(AdminOrManagerGuard)
  async finalizeGmail(
    @OrgId() orgId: string,
    @ClerkUserId() clerkUserId: string | undefined,
    @Body() body: FinalizeGmailOAuthDto,
  ) {
    if (!clerkUserId) {
      throw new ForbiddenException("A Clerk user is required for Gmail OAuth");
    }
    const code = await this.oauthAttempts.consumeAuthorizationCode({
      attemptId: body.attemptId,
      orgId,
      clerkUserId,
      provider: "gmail",
    });

    // The one-time attempt is consumed before provider or Integration work.
    // A retry can never invoke canonical Gmail activation a second time.
    await this.gmailService.handleCallback(code, orgId);
    return this.integrationsService.findByProvider(orgId, "gmail");
  }

  @Get(":id/health")
  checkHealth(@OrgId() orgId: string, @Param("id") id: string) {
    return this.integrationsService.checkHealth(id, orgId);
  }

  /** Dev/demo helper — disabled in production by the service. */
  @Post("connect")
  @UseGuards(AdminOrManagerGuard)
  simulateConnect(@OrgId() orgId: string, @Body() body: ConnectIntegrationDto) {
    return this.integrationsService.simulateConnect(orgId, body.provider);
  }

  /**
   * API-key connect for providers like Apollo / ElevenLabs / Clay.
   * OAuth providers should use `/:provider/auth-url` instead.
   */
  @Post(":provider/connect")
  @UseGuards(AdminOrManagerGuard)
  connectApiKey(
    @OrgId() orgId: string,
    @Param("provider") provider: string,
    @Body() body: { apiKey?: string },
  ) {
    return this.integrationsService.connectApiKey(
      orgId,
      provider,
      body.apiKey ?? "",
    );
  }

  @Post(":provider/disconnect")
  @UseGuards(AdminOrManagerGuard)
  disconnectByProvider(
    @OrgId() orgId: string,
    @Param("provider") provider: string,
  ) {
    return this.integrationsService.disconnectByProvider(orgId, provider);
  }

  @Post(":provider/test")
  @UseGuards(AdminOrManagerGuard)
  testByProvider(@OrgId() orgId: string, @Param("provider") provider: string) {
    return this.integrationsService.testByProvider(orgId, provider);
  }

  // ────────────────────────────────────────────────────────────────────────

  private async handleProviderCallback(
    provider: string,
    code: string,
    state: string,
    error: string | undefined,
    res: Response,
  ) {
    const frontendUrl =
      process.env.FRONTEND_URL?.trim() || "http://localhost:3000";
    const returnPath = "/settings/integrations";
    if (provider !== "gmail") {
      return res.redirect(
        `${frontendUrl}${returnPath}?error=${encodeURIComponent(
          `${provider}_unavailable`,
        )}&provider=${encodeURIComponent(provider)}`,
      );
    }
    if (error) {
      return res.redirect(
        `${frontendUrl}${returnPath}?error=${encodeURIComponent(
          `${provider}_denied`,
        )}&provider=${encodeURIComponent(provider)}`,
      );
    }

    try {
      const parked = await this.oauthAttempts.parkAuthorizationCode({
        state,
        expectedProvider: provider,
        code,
      });
      return res.redirect(
        `${frontendUrl}${returnPath}?oauth_attempt=${encodeURIComponent(
          parked.attemptId,
        )}&provider=${encodeURIComponent(parked.provider)}`,
      );
    } catch (err) {
      this.logger.warn(
        `OAuth callback failed for ${provider}: ${
          err instanceof Error ? err.message : "unknown"
        }`,
      );
      return res.redirect(
        `${frontendUrl}${returnPath}?error=${encodeURIComponent(
          `${provider}_oauth`,
        )}&provider=${encodeURIComponent(provider)}`,
      );
    }
  }
}
