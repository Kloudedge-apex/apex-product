import { Controller, Get, Query, Redirect, Res } from "@nestjs/common";
import { Response } from "express";
import { IntegrationsService } from "../integrations.service";
import { SkipOrgGuard } from "../../common/org-scope.guard";

@Controller("integrations/linkedin")
@SkipOrgGuard()
export class LinkedInController {
    constructor(private readonly integrationsService: IntegrationsService) { }

    /**
     * Step 1: Redirect user to LinkedIn OAuth consent screen.
     * Frontend calls: GET /api/integrations/linkedin/connect?orgId=<orgId>
     */
    @Get("connect")
    @Redirect()
    connect(@Query("orgId") orgId: string) {
        const url = this.integrationsService.getOAuthUrl("linkedin", orgId);
        return { url, statusCode: 302 };
    }

    /**
     * Step 2: LinkedIn redirects here after user grants consent.
     * Exchanges code for tokens and stores them encrypted.
     */
    @Get("callback")
    async callback(
        @Query("code") code: string,
        @Query("state") orgId: string,
        @Query("error") error: string,
        @Res() res: Response,
    ) {
        const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";

        if (error) {
            return res.redirect(`${frontendUrl}/dashboard/integrations?error=linkedin_denied`);
        }

        try {
            await this.integrationsService.handleOAuthCallback("linkedin", code, orgId);
            return res.redirect(`${frontendUrl}/dashboard/integrations?connected=linkedin`);
        } catch {
            return res.redirect(`${frontendUrl}/dashboard/integrations?error=linkedin_failed`);
        }
    }
}
