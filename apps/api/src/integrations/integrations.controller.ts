import {
  Controller,
  Get,
  Post,
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
import { FinalizeGmailOAuthDto } from "../common/dto/integrations.dto";
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
  // `/gmail/auth-url` returns the provider URL as JSON so the SPA can
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
    return this.handleGmailCallback(code, state, error, res);
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

  @Post("gmail/disconnect")
  @UseGuards(AdminOrManagerGuard)
  disconnectGmail(@OrgId() orgId: string) {
    return this.integrationsService.disconnectByProvider(orgId, "gmail");
  }

  private async handleGmailCallback(
    code: string,
    state: string,
    error: string | undefined,
    res: Response,
  ) {
    const frontendUrl =
      process.env.FRONTEND_URL?.trim() || "http://localhost:3000";
    const returnPath = "/settings/integrations";
    if (error) {
      return res.redirect(
        `${frontendUrl}${returnPath}?error=${encodeURIComponent(
          "gmail_denied",
        )}&provider=gmail`,
      );
    }

    try {
      const parked = await this.oauthAttempts.parkAuthorizationCode({
        state,
        expectedProvider: "gmail",
        code,
      });
      return res.redirect(
        `${frontendUrl}${returnPath}?oauth_attempt=${encodeURIComponent(
          parked.attemptId,
        )}&provider=${encodeURIComponent(parked.provider)}`,
      );
    } catch (err) {
      this.logger.warn(
        `OAuth callback failed for gmail: ${
          err instanceof Error ? err.message : "unknown"
        }`,
      );
      return res.redirect(
        `${frontendUrl}${returnPath}?error=${encodeURIComponent(
          "gmail_oauth",
        )}&provider=gmail`,
      );
    }
  }
}
