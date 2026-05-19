import {
  Controller,
  Get,
  HttpStatus,
  Logger,
  Query,
  Res,
} from "@nestjs/common";
import { Response } from "express";
import { IntegrationsService } from "../integrations.service";
import { OrgId } from "../../common/org-context.decorator";
import { SkipOrgGuard } from "../../common/org-scope.guard";
import { verifyOAuthState } from "../../common/webhook-signature.util";

@Controller("integrations/linkedin")
export class LinkedInController {
  private readonly logger = new Logger(LinkedInController.name);

  constructor(private readonly integrationsService: IntegrationsService) {}

  /**
   * Step 1: Redirect to LinkedIn OAuth consent screen. Authenticated; orgId
   * comes from the verified JWT, not from a client-supplied query param.
   */
  @Get("connect")
  connect(@OrgId() orgId: string, @Res() res: Response) {
    const url = this.integrationsService.getOAuthUrl("linkedin", orgId);
    return res.redirect(HttpStatus.FOUND, url);
  }

  /**
   * Step 2: LinkedIn redirects here after consent. There's no JWT (browser
   * redirect from LinkedIn), but `state` is HMAC-signed so the orgId can be
   * trusted. Without this check, anyone could mount a LinkedIn callback
   * against any tenant.
   */
  @Get("callback")
  @SkipOrgGuard()
  async callback(
    @Query("code") code: string,
    @Query("state") state: string,
    @Query("error") error: string,
    @Res() res: Response,
  ) {
    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";

    if (error) {
      return res.redirect(
        `${frontendUrl}/dashboard/integrations?error=linkedin_denied`,
      );
    }

    let orgId: string;
    try {
      ({ orgId } = verifyOAuthState(state));
    } catch (err) {
      this.logger.warn(
        `LinkedIn OAuth state verification failed: ${
          err instanceof Error ? err.message : "unknown"
        }`,
      );
      return res.redirect(
        `${frontendUrl}/dashboard/integrations?error=linkedin_state`,
      );
    }

    try {
      await this.integrationsService.handleOAuthCallback("linkedin", code, orgId);
      return res.redirect(
        `${frontendUrl}/dashboard/integrations?connected=linkedin`,
      );
    } catch (err) {
      this.logger.warn(
        `LinkedIn OAuth callback failed: ${
          err instanceof Error ? err.message : "unknown"
        }`,
      );
      return res.redirect(
        `${frontendUrl}/dashboard/integrations?error=linkedin_failed`,
      );
    }
  }
}
