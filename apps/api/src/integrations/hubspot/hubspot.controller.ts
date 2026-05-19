import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  Post,
  Put,
  Query,
  Req,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Request } from "express";
import { ConfigService } from "@nestjs/config";
import { HubspotService } from "./hubspot.service";
import { OrgId } from "../../common/org-context.decorator";
import { SkipOrgGuard } from "../../common/org-scope.guard";
import { verifyHubspotWebhookSignature } from "../../common/webhook-signature.util";

/**
 * Note: OAuth init (`auth`) and callback (`callback`) for HubSpot live in
 * `IntegrationsController` so the signed-state flow is shared across providers.
 * This controller only exposes CRM operations and the webhook receiver.
 */
@Controller("integrations/hubspot")
export class HubspotController {
  private readonly logger = new Logger(HubspotController.name);

  constructor(
    private readonly hubspotService: HubspotService,
    private readonly config: ConfigService,
  ) {}

  // ─── Contacts ─────────────────────────────────────────

  @Post("contacts")
  @HttpCode(HttpStatus.CREATED)
  createContact(@OrgId() orgId: string, @Body() body: Record<string, string>) {
    return this.hubspotService.createContact(orgId, body);
  }

  @Get("contacts/search")
  searchContacts(
    @OrgId() orgId: string,
    @Query("q") query: string,
    @Query("limit") limit?: string,
  ) {
    return this.hubspotService.searchContacts(
      orgId,
      query,
      limit ? parseInt(limit, 10) : undefined,
    );
  }

  @Get("contacts/:contactId")
  getContact(@OrgId() orgId: string, @Param("contactId") contactId: string) {
    return this.hubspotService.getContact(orgId, contactId);
  }

  @Put("contacts/:contactId")
  updateContact(
    @OrgId() orgId: string,
    @Param("contactId") contactId: string,
    @Body() body: Record<string, string>,
  ) {
    return this.hubspotService.updateContact(orgId, contactId, body);
  }

  // ─── Deals ────────────────────────────────────────────

  @Post("deals")
  @HttpCode(HttpStatus.CREATED)
  createDeal(@OrgId() orgId: string, @Body() body: Record<string, string>) {
    return this.hubspotService.createDeal(orgId, body);
  }

  @Get("deals/search")
  searchDeals(
    @OrgId() orgId: string,
    @Query("q") query: string,
    @Query("limit") limit?: string,
  ) {
    return this.hubspotService.searchDeals(
      orgId,
      query,
      limit ? parseInt(limit, 10) : undefined,
    );
  }

  @Get("deals/:dealId")
  getDeal(@OrgId() orgId: string, @Param("dealId") dealId: string) {
    return this.hubspotService.getDeal(orgId, dealId);
  }

  @Put("deals/:dealId")
  updateDeal(
    @OrgId() orgId: string,
    @Param("dealId") dealId: string,
    @Body() body: Record<string, string>,
  ) {
    return this.hubspotService.updateDeal(orgId, dealId, body);
  }

  // ─── Companies ────────────────────────────────────────

  @Post("companies")
  @HttpCode(HttpStatus.CREATED)
  createCompany(@OrgId() orgId: string, @Body() body: Record<string, string>) {
    return this.hubspotService.createCompany(orgId, body);
  }

  @Get("companies/search")
  searchCompanies(
    @OrgId() orgId: string,
    @Query("q") query: string,
    @Query("limit") limit?: string,
  ) {
    return this.hubspotService.searchCompanies(
      orgId,
      query,
      limit ? parseInt(limit, 10) : undefined,
    );
  }

  @Get("companies/:companyId")
  getCompany(@OrgId() orgId: string, @Param("companyId") companyId: string) {
    return this.hubspotService.getCompany(orgId, companyId);
  }

  // ─── Webhook ──────────────────────────────────────────

  /**
   * HubSpot v3 webhook. No JWT (HubSpot calls us). The body+headers are
   * HMAC-signed; we reject anything that doesn't verify.
   */
  @Post("webhook")
  @SkipOrgGuard()
  @HttpCode(HttpStatus.OK)
  async handleWebhook(@Req() req: Request, @Body() body: unknown) {
    const secret = this.config.get<string>("HUBSPOT_CLIENT_SECRET");
    if (!secret) {
      this.logger.error("HUBSPOT_CLIENT_SECRET not configured");
      throw new ServiceUnavailableException("Webhook not configured");
    }

    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
    if (!rawBody) {
      throw new BadRequestException("Missing raw body");
    }

    const sig = req.headers["x-hubspot-signature-v3"];
    const ts = req.headers["x-hubspot-request-timestamp"];
    const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol;
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const uri = `${proto}://${host}${req.originalUrl}`;

    try {
      verifyHubspotWebhookSignature({
        method: req.method,
        uri,
        rawBody,
        signatureHeader: Array.isArray(sig) ? sig[0] : sig,
        timestampHeader: Array.isArray(ts) ? ts[0] : ts,
        secret,
      });
    } catch (err) {
      this.logger.warn(
        `HubSpot webhook signature verification failed: ${
          err instanceof Error ? err.message : "unknown"
        }`,
      );
      throw new BadRequestException("Invalid signature");
    }

    const events = Array.isArray(body)
      ? (body as Array<Record<string, unknown>>)
      : [];
    return this.hubspotService.handleWebhook(events);
  }
}
