import { Controller, Get, Post, Delete, Param, Body, Query, Res, HttpStatus } from "@nestjs/common";
import { Response } from "express";
import { IntegrationsService } from "./integrations.service";
import { CreateIntegrationDto, ConnectIntegrationDto } from "../common/dto/integrations.dto";

@Controller("integrations")
export class IntegrationsController {
  constructor(private readonly integrationsService: IntegrationsService) {}

  @Get()
  findAll(@Query("orgId") orgId: string) {
    return this.integrationsService.findAll(orgId);
  }

  @Post()
  create(@Body() body: CreateIntegrationDto) {
    return this.integrationsService.create(body);
  }

  @Delete(":id")
  remove(@Param("id") id: string) {
    return this.integrationsService.disconnect(id);
  }

  // OAuth flow endpoints
  @Get("gmail/auth")
  gmailAuth(@Query("orgId") orgId: string, @Res() res: Response) {
    const url = this.integrationsService.getOAuthUrl("gmail", orgId);
    return res.redirect(HttpStatus.FOUND, url);
  }

  @Get("gmail/callback")
  async gmailCallback(@Query("code") code: string, @Query("state") orgId: string, @Res() res: Response) {
    try {
      await this.integrationsService.handleOAuthCallback("gmail", code, orgId);
      const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
      return res.redirect(`${frontendUrl}/integrations?connected=gmail`);
    } catch {
      const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
      return res.redirect(`${frontendUrl}/integrations?error=gmail`);
    }
  }

  @Get("outlook/auth")
  outlookAuth(@Query("orgId") orgId: string, @Res() res: Response) {
    const url = this.integrationsService.getOAuthUrl("outlook", orgId);
    return res.redirect(HttpStatus.FOUND, url);
  }

  @Get("outlook/callback")
  async outlookCallback(@Query("code") code: string, @Query("state") orgId: string, @Res() res: Response) {
    try {
      await this.integrationsService.handleOAuthCallback("outlook", code, orgId);
      const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
      return res.redirect(`${frontendUrl}/integrations?connected=outlook`);
    } catch {
      const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
      return res.redirect(`${frontendUrl}/integrations?error=outlook`);
    }
  }

  @Get("hubspot/auth")
  hubspotAuth(@Query("orgId") orgId: string, @Res() res: Response) {
    const url = this.integrationsService.getOAuthUrl("hubspot", orgId);
    return res.redirect(HttpStatus.FOUND, url);
  }

  @Get("hubspot/callback")
  async hubspotCallback(@Query("code") code: string, @Query("state") orgId: string, @Res() res: Response) {
    try {
      await this.integrationsService.handleOAuthCallback("hubspot", code, orgId);
      const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
      return res.redirect(`${frontendUrl}/integrations?connected=hubspot`);
    } catch {
      const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
      return res.redirect(`${frontendUrl}/integrations?error=hubspot`);
    }
  }

  // Health check for an integration
  @Get(":id/health")
  checkHealth(@Param("id") id: string) {
    return this.integrationsService.checkHealth(id);
  }

  // Simulate connect (MVP: creates mock integration record)
  @Post("connect")
  simulateConnect(@Body() body: ConnectIntegrationDto) {
    return this.integrationsService.simulateConnect(body.orgId, body.provider);
  }
}
