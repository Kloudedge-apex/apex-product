import { Injectable, UnauthorizedException, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Client } from "@hubspot/api-client";
import { PrismaService } from "../../prisma/prisma.service";
import { encrypt, decrypt } from "../crypto.util";

interface HubSpotTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  token_type: string;
}

interface ContactProperties {
  email?: string;
  firstname?: string;
  lastname?: string;
  phone?: string;
  company?: string;
  jobtitle?: string;
  lifecyclestage?: string;
  [key: string]: string | undefined;
}

interface DealProperties {
  dealname?: string;
  amount?: string;
  dealstage?: string;
  pipeline?: string;
  closedate?: string;
  hubspot_owner_id?: string;
  [key: string]: string | undefined;
}

interface CompanyProperties {
  name?: string;
  domain?: string;
  industry?: string;
  phone?: string;
  city?: string;
  state?: string;
  country?: string;
  numberofemployees?: string;
  annualrevenue?: string;
  [key: string]: string | undefined;
}

interface CrmRecord {
  id: string;
  properties: Record<string, string | null>;
  createdAt: string;
  updatedAt: string;
}

interface SearchResult {
  total: number;
  results: CrmRecord[];
}

const HUBSPOT_SCOPES = [
  "crm.objects.contacts.read",
  "crm.objects.contacts.write",
  "crm.objects.deals.read",
  "crm.objects.deals.write",
  "crm.objects.companies.read",
  "crm.objects.companies.write",
];

@Injectable()
export class HubspotService {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly redirectUri: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    this.clientId = this.config.get<string>("HUBSPOT_CLIENT_ID", "");
    this.clientSecret = this.config.get<string>("HUBSPOT_CLIENT_SECRET", "");
    this.redirectUri = this.config.get<string>(
      "HUBSPOT_REDIRECT_URI",
      "http://localhost:4000/api/integrations/hubspot/callback",
    );
  }

  getAuthUrl(orgId: string): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      scope: HUBSPOT_SCOPES.join(" "),
      state: orgId,
    });
    return `https://app.hubspot.com/oauth/authorize?${params.toString()}`;
  }

  async handleCallback(code: string, orgId: string): Promise<void> {
    const client = new Client();
    const tokenResponse = await client.oauth.tokensApi.create(
      "authorization_code",
      code,
      this.redirectUri,
      this.clientId,
      this.clientSecret,
    );

    const tokens: HubSpotTokens = {
      access_token: tokenResponse.accessToken,
      refresh_token: tokenResponse.refreshToken,
      expires_at: Date.now() + tokenResponse.expiresIn * 1000,
      token_type: "Bearer",
    };

    const encryptedCreds = encrypt(JSON.stringify(tokens));

    await this.prisma.integration.upsert({
      where: { orgId_provider: { orgId, provider: "hubspot" } },
      create: {
        orgId,
        provider: "hubspot",
        credentials: {},
        encryptedCredentials: encryptedCreds,
        status: "CONNECTED",
        scopes: HUBSPOT_SCOPES,
      },
      update: {
        encryptedCredentials: encryptedCreds,
        credentials: {},
        status: "CONNECTED",
        scopes: HUBSPOT_SCOPES,
        lastSyncAt: new Date(),
      },
    });
  }

  // ─── Contacts ─────────────────────────────────────────

  async createContact(orgId: string, properties: ContactProperties): Promise<CrmRecord> {
    const client = await this.getClient(orgId);
    const response = await client.crm.contacts.basicApi.create({
      associations: [],
      properties: this.cleanProperties(properties),
    });
    return this.toCrmRecord(response);
  }

  async getContact(orgId: string, contactId: string): Promise<CrmRecord> {
    const client = await this.getClient(orgId);
    const response = await client.crm.contacts.basicApi.getById(contactId, [
      "email", "firstname", "lastname", "phone", "company", "jobtitle", "lifecyclestage",
    ]);
    return this.toCrmRecord(response);
  }

  async updateContact(orgId: string, contactId: string, properties: ContactProperties): Promise<CrmRecord> {
    const client = await this.getClient(orgId);
    const response = await client.crm.contacts.basicApi.update(contactId, {
      properties: this.cleanProperties(properties),
    });
    return this.toCrmRecord(response);
  }

  async searchContacts(orgId: string, query: string, limit: number = 10): Promise<SearchResult> {
    const client = await this.getClient(orgId);
    const response = await client.crm.contacts.searchApi.doSearch({
      query,
      limit,
      after: "0",
      sorts: [],
      properties: ["email", "firstname", "lastname", "phone", "company"],
      filterGroups: [],
    });
    return {
      total: response.total,
      results: response.results.map((r) => this.toCrmRecord(r)),
    };
  }

  // ─── Deals ────────────────────────────────────────────

  async createDeal(orgId: string, properties: DealProperties): Promise<CrmRecord> {
    const client = await this.getClient(orgId);
    const response = await client.crm.deals.basicApi.create({
      associations: [],
      properties: this.cleanProperties(properties),
    });
    return this.toCrmRecord(response);
  }

  async getDeal(orgId: string, dealId: string): Promise<CrmRecord> {
    const client = await this.getClient(orgId);
    const response = await client.crm.deals.basicApi.getById(dealId, [
      "dealname", "amount", "dealstage", "pipeline", "closedate",
    ]);
    return this.toCrmRecord(response);
  }

  async updateDeal(orgId: string, dealId: string, properties: DealProperties): Promise<CrmRecord> {
    const client = await this.getClient(orgId);
    const response = await client.crm.deals.basicApi.update(dealId, {
      properties: this.cleanProperties(properties),
    });
    return this.toCrmRecord(response);
  }

  async searchDeals(orgId: string, query: string, limit: number = 10): Promise<SearchResult> {
    const client = await this.getClient(orgId);
    const response = await client.crm.deals.searchApi.doSearch({
      query,
      limit,
      after: "0",
      sorts: [],
      properties: ["dealname", "amount", "dealstage", "pipeline", "closedate"],
      filterGroups: [],
    });
    return {
      total: response.total,
      results: response.results.map((r) => this.toCrmRecord(r)),
    };
  }

  // ─── Companies ────────────────────────────────────────

  async createCompany(orgId: string, properties: CompanyProperties): Promise<CrmRecord> {
    const client = await this.getClient(orgId);
    const response = await client.crm.companies.basicApi.create({
      associations: [],
      properties: this.cleanProperties(properties),
    });
    return this.toCrmRecord(response);
  }

  async getCompany(orgId: string, companyId: string): Promise<CrmRecord> {
    const client = await this.getClient(orgId);
    const response = await client.crm.companies.basicApi.getById(companyId, [
      "name", "domain", "industry", "phone", "city", "numberofemployees",
    ]);
    return this.toCrmRecord(response);
  }

  async searchCompanies(orgId: string, query: string, limit: number = 10): Promise<SearchResult> {
    const client = await this.getClient(orgId);
    const response = await client.crm.companies.searchApi.doSearch({
      query,
      limit,
      after: "0",
      sorts: [],
      properties: ["name", "domain", "industry", "numberofemployees"],
      filterGroups: [],
    });
    return {
      total: response.total,
      results: response.results.map((r) => this.toCrmRecord(r)),
    };
  }

  // ─── Webhooks ─────────────────────────────────────────

  async handleWebhook(events: Array<Record<string, unknown>>): Promise<{ processed: number }> {
    let processed = 0;

    for (const event of events) {
      const portalId = event.portalId as number | undefined;
      const objectType = event.objectType as string | undefined;
      const eventType = event.subscriptionType as string | undefined;
      const objectId = event.objectId as number | undefined;

      if (!portalId || !objectType || !eventType || !objectId) continue;

      // Log the webhook event for any org listening
      // In production, we'd map portalId to orgId
      processed++;
    }

    return { processed };
  }

  // ─── Private helpers ──────────────────────────────────

  private async getClient(orgId: string): Promise<Client> {
    const tokens = await this.getTokens(orgId);

    // Check if token needs refresh
    if (Date.now() >= tokens.expires_at - 300_000) {
      const refreshedTokens = await this.refreshTokens(orgId, tokens);
      const client = new Client({ accessToken: refreshedTokens.access_token });
      return client;
    }

    return new Client({ accessToken: tokens.access_token });
  }

  private async getTokens(orgId: string): Promise<HubSpotTokens> {
    const integration = await this.prisma.integration.findUnique({
      where: { orgId_provider: { orgId, provider: "hubspot" } },
    });

    if (!integration || integration.status !== "CONNECTED") {
      throw new UnauthorizedException("HubSpot not connected for this organization");
    }

    if (!integration.encryptedCredentials) {
      throw new UnauthorizedException("No credentials stored for HubSpot integration");
    }

    try {
      const decrypted = decrypt(integration.encryptedCredentials);
      return JSON.parse(decrypted) as HubSpotTokens;
    } catch {
      throw new UnauthorizedException("Failed to decrypt HubSpot credentials");
    }
  }

  private async refreshTokens(orgId: string, tokens: HubSpotTokens): Promise<HubSpotTokens> {
    try {
      const client = new Client();
      const tokenResponse = await client.oauth.tokensApi.create(
        "refresh_token",
        undefined as unknown as string,
        this.redirectUri,
        this.clientId,
        this.clientSecret,
      );

      const newTokens: HubSpotTokens = {
        access_token: tokenResponse.accessToken,
        refresh_token: tokenResponse.refreshToken || tokens.refresh_token,
        expires_at: Date.now() + tokenResponse.expiresIn * 1000,
        token_type: "Bearer",
      };

      const encryptedCreds = encrypt(JSON.stringify(newTokens));
      await this.prisma.integration.update({
        where: { orgId_provider: { orgId, provider: "hubspot" } },
        data: {
          encryptedCredentials: encryptedCreds,
          lastSyncAt: new Date(),
        },
      });

      return newTokens;
    } catch {
      // If refresh fails, update status and throw
      await this.prisma.integration.update({
        where: { orgId_provider: { orgId, provider: "hubspot" } },
        data: {
          status: "ERROR",
          lastErrorAt: new Date(),
          lastErrorMessage: "Token refresh failed",
        },
      });
      throw new UnauthorizedException("HubSpot token refresh failed. Please reconnect.");
    }
  }

  private cleanProperties(props: Record<string, string | undefined>): Record<string, string> {
    const cleaned: Record<string, string> = {};
    for (const [key, value] of Object.entries(props)) {
      if (value !== undefined && value !== null) {
        cleaned[key] = value;
      }
    }
    return cleaned;
  }

  private toCrmRecord(response: { id: string; properties: Record<string, string | null>; createdAt: Date; updatedAt: Date }): CrmRecord {
    return {
      id: response.id,
      properties: response.properties,
      createdAt: response.createdAt.toISOString(),
      updatedAt: response.updatedAt.toISOString(),
    };
  }
}
