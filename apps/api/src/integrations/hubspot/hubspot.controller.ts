import {
  Controller,
  Get,
  Post,
  Put,
  Query,
  Body,
  Param,
  Res,
  HttpStatus,
  HttpCode,
} from "@nestjs/common";
import { Response } from "express";
import { ConfigService } from "@nestjs/config";
import { HubspotService } from "./hubspot.service";

@Controller("integrations/hubspot")
export class HubspotController {
  constructor(
    private readonly hubspotService: HubspotService,
    private readonly config: ConfigService,
  ) {}

  // ─── OAuth ────────────────────────────────────────────

  @Get("auth")
  auth(@Query("orgId") orgId: string, @Res() res: Response) {
    if (!orgId) {
      return res.status(HttpStatus.BAD_REQUEST).json({ error: "orgId is required" });
    }
    const url = this.hubspotService.getAuthUrl(orgId);
    return res.redirect(HttpStatus.FOUND, url);
  }

  @Get("callback")
  async callback(
    @Query("code") code: string,
    @Query("state") orgId: string,
    @Res() res: Response,
  ) {
    const frontendUrl = this.config.get<string>("FRONTEND_URL", "http://localhost:3000");
    try {
      await this.hubspotService.handleCallback(code, orgId);
      return res.redirect(`${frontendUrl}/integrations?connected=hubspot`);
    } catch {
      return res.redirect(`${frontendUrl}/integrations?error=hubspot`);
    }
  }

  // ─── Contacts ─────────────────────────────────────────

  @Post("contacts")
  @HttpCode(HttpStatus.CREATED)
  async createContact(
    @Query("orgId") orgId: string,
    @Body() body: Record<string, string>,
  ) {
    return this.hubspotService.createContact(orgId, body);
  }

  @Get("contacts/:contactId")
  async getContact(
    @Query("orgId") orgId: string,
    @Param("contactId") contactId: string,
  ) {
    return this.hubspotService.getContact(orgId, contactId);
  }

  @Put("contacts/:contactId")
  async updateContact(
    @Query("orgId") orgId: string,
    @Param("contactId") contactId: string,
    @Body() body: Record<string, string>,
  ) {
    return this.hubspotService.updateContact(orgId, contactId, body);
  }

  @Get("contacts/search")
  async searchContacts(
    @Query("orgId") orgId: string,
    @Query("q") query: string,
    @Query("limit") limit?: string,
  ) {
    return this.hubspotService.searchContacts(orgId, query, limit ? parseInt(limit, 10) : undefined);
  }

  // ─── Deals ────────────────────────────────────────────

  @Post("deals")
  @HttpCode(HttpStatus.CREATED)
  async createDeal(
    @Query("orgId") orgId: string,
    @Body() body: Record<string, string>,
  ) {
    return this.hubspotService.createDeal(orgId, body);
  }

  @Get("deals/:dealId")
  async getDeal(
    @Query("orgId") orgId: string,
    @Param("dealId") dealId: string,
  ) {
    return this.hubspotService.getDeal(orgId, dealId);
  }

  @Put("deals/:dealId")
  async updateDeal(
    @Query("orgId") orgId: string,
    @Param("dealId") dealId: string,
    @Body() body: Record<string, string>,
  ) {
    return this.hubspotService.updateDeal(orgId, dealId, body);
  }

  @Get("deals/search")
  async searchDeals(
    @Query("orgId") orgId: string,
    @Query("q") query: string,
    @Query("limit") limit?: string,
  ) {
    return this.hubspotService.searchDeals(orgId, query, limit ? parseInt(limit, 10) : undefined);
  }

  // ─── Companies ────────────────────────────────────────

  @Post("companies")
  @HttpCode(HttpStatus.CREATED)
  async createCompany(
    @Query("orgId") orgId: string,
    @Body() body: Record<string, string>,
  ) {
    return this.hubspotService.createCompany(orgId, body);
  }

  @Get("companies/:companyId")
  async getCompany(
    @Query("orgId") orgId: string,
    @Param("companyId") companyId: string,
  ) {
    return this.hubspotService.getCompany(orgId, companyId);
  }

  @Get("companies/search")
  async searchCompanies(
    @Query("orgId") orgId: string,
    @Query("q") query: string,
    @Query("limit") limit?: string,
  ) {
    return this.hubspotService.searchCompanies(orgId, query, limit ? parseInt(limit, 10) : undefined);
  }

  // ─── Webhooks ─────────────────────────────────────────

  @Post("webhook")
  @HttpCode(HttpStatus.OK)
  async handleWebhook(@Body() body: Array<Record<string, unknown>>) {
    return this.hubspotService.handleWebhook(body);
  }
}
