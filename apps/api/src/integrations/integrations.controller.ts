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
} from "@nestjs/common";
import { Response } from "express";
import { IntegrationsService } from "./integrations.service";
import { OrgId } from "../common/org-context.decorator";
import { SkipOrgGuard } from "../common/org-scope.guard";
import { verifyOAuthState } from "../common/webhook-signature.util";
import {
  CreateIntegrationDto,
  ConnectIntegrationDto,
} from "../common/dto/integrations.dto";

@Controller("integrations")
export class IntegrationsController {
  private readonly logger = new Logger(IntegrationsController.name);

  constructor(private readonly integrationsService: IntegrationsService) {}

  @Get()
  findAll(@OrgId() orgId: string) {
    return this.integrationsService.findAll(orgId);
  }

  @Post()
  create(@OrgId() orgId: string, @Body() body: CreateIntegrationDto) {
    return this.integrationsService.create(orgId, body);
  }

  @Delete(":id")
  remove(@OrgId() orgId: string, @Param("id") id: string) {
    return this.integrationsService.disconnect(id, orgId);
  }

  // ── OAuth init: authenticated, orgId derived from JWT ───────────────────
  //
  // The legacy `/:provider/auth` route used `res.redirect(302, url)` so a
  // browser could navigate to it directly — but that pattern is incompatible
  // with `Authorization: Bearer …`, which a top-level navigation can't send.
  // `/:provider/auth-url` returns the provider URL as JSON so the SPA can
  // perform `window.location.href = authUrl` after a Bearer-authenticated XHR.

  @Get("gmail/auth-url")
  gmailAuthUrl(@OrgId() orgId: string) {
    return { authUrl: this.integrationsService.getOAuthUrl("gmail", orgId) };
  }

  @Get("outlook/auth-url")
  outlookAuthUrl(@OrgId() orgId: string) {
    return { authUrl: this.integrationsService.getOAuthUrl("outlook", orgId) };
  }

  @Get("hubspot/auth-url")
  hubspotAuthUrl(@OrgId() orgId: string) {
    return { authUrl: this.integrationsService.getOAuthUrl("hubspot", orgId) };
  }

  // ── OAuth callbacks: no JWT (browser redirect from provider), but the
  //    `state` parameter is HMAC-signed so the orgId can be trusted.

  @Get("gmail/callback")
  @SkipOrgGuard()
  gmailCallback(
    @Query("code") code: string,
    @Query("state") state: string,
    @Res() res: Response,
  ) {
    return this.handleProviderCallback("gmail", code, state, res);
  }

  @Get("outlook/callback")
  @SkipOrgGuard()
  outlookCallback(
    @Query("code") code: string,
    @Query("state") state: string,
    @Res() res: Response,
  ) {
    return this.handleProviderCallback("outlook", code, state, res);
  }

  @Get("hubspot/callback")
  @SkipOrgGuard()
  hubspotCallback(
    @Query("code") code: string,
    @Query("state") state: string,
    @Res() res: Response,
  ) {
    return this.handleProviderCallback("hubspot", code, state, res);
  }

  @Get(":id/health")
  checkHealth(@OrgId() orgId: string, @Param("id") id: string) {
    return this.integrationsService.checkHealth(id, orgId);
  }

  /** Dev/demo helper — disabled in production by the service. */
  @Post("connect")
  simulateConnect(@OrgId() orgId: string, @Body() body: ConnectIntegrationDto) {
    return this.integrationsService.simulateConnect(orgId, body.provider);
  }

  // ────────────────────────────────────────────────────────────────────────

  private async handleProviderCallback(
    provider: string,
    code: string,
    state: string,
    res: Response,
  ) {
    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
    let orgId: string;
    try {
      ({ orgId } = verifyOAuthState(state));
    } catch (err) {
      this.logger.warn(
        `OAuth state verification failed for ${provider}: ${
          err instanceof Error ? err.message : "unknown"
        }`,
      );
      return res.redirect(`${frontendUrl}/integrations?error=${provider}_state`);
    }

    try {
      await this.integrationsService.handleOAuthCallback(provider, code, orgId);
      return res.redirect(`${frontendUrl}/integrations?connected=${provider}`);
    } catch (err) {
      this.logger.warn(
        `OAuth callback failed for ${provider}: ${
          err instanceof Error ? err.message : "unknown"
        }`,
      );
      return res.redirect(`${frontendUrl}/integrations?error=${provider}`);
    }
  }
}
