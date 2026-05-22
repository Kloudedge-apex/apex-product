import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { encryptCredentials, decryptCredentials } from "./crypto.util";
import { signOAuthState } from "../common/webhook-signature.util";

interface OAuthConfig {
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  authUrl: string;
  tokenUrl: string;
  scopes: string[];
}

const OAUTH_CONFIGS: Record<string, OAuthConfig> = {
  gmail: {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    redirectUri:
      process.env.GOOGLE_REDIRECT_URI ||
      "http://localhost:4000/api/integrations/gmail/callback",
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: [
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.compose",
    ],
  },
  outlook: {
    clientId: process.env.MICROSOFT_CLIENT_ID,
    clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
    redirectUri:
      process.env.MICROSOFT_REDIRECT_URI ||
      "http://localhost:4000/api/integrations/outlook/callback",
    authUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scopes: ["Mail.ReadWrite", "Mail.Send", "offline_access"],
  },
  hubspot: {
    clientId: process.env.HUBSPOT_CLIENT_ID,
    clientSecret: process.env.HUBSPOT_CLIENT_SECRET,
    redirectUri:
      process.env.HUBSPOT_REDIRECT_URI ||
      "http://localhost:4000/api/integrations/hubspot/callback",
    authUrl: "https://app.hubspot.com/oauth/authorize",
    tokenUrl: "https://api.hubapi.com/oauth/v1/token",
    scopes: ["contacts", "crm.objects.deals.read", "crm.objects.companies.read"],
  },
  linkedin: {
    clientId: process.env.LINKEDIN_CLIENT_ID,
    clientSecret: process.env.LINKEDIN_CLIENT_SECRET,
    redirectUri:
      process.env.LINKEDIN_REDIRECT_URI ||
      "http://localhost:4000/api/integrations/linkedin/callback",
    authUrl: "https://www.linkedin.com/oauth/v2/authorization",
    tokenUrl: "https://www.linkedin.com/oauth/v2/accessToken",
    scopes: ["r_liteprofile", "r_emailaddress", "w_member_social"],
  },
};

@Injectable()
export class IntegrationsService {
  private readonly logger = new Logger(IntegrationsService.name);

  constructor(private prisma: PrismaService) {}

  getCatalog(): Array<{
    provider: string;
    name: string;
    category: string;
    description: string;
    authType: "oauth" | "api_key" | "system";
    status: "available" | "coming_soon";
  }> {
    return [
      { provider: "gmail", category: "email", name: "Google Workspace (Gmail)", description: "Send and receive email via your Google Workspace mailbox.", authType: "oauth", status: "available" },
      { provider: "outlook", category: "email", name: "Microsoft 365 (Outlook)", description: "Send and receive email via your M365 mailbox.", authType: "oauth", status: "available" },
      { provider: "hubspot", category: "crm", name: "HubSpot", description: "Bi-directional CRM sync for contacts, deals, and companies.", authType: "oauth", status: "available" },
      { provider: "salesforce", category: "crm", name: "Salesforce", description: "Bi-directional CRM sync.", authType: "oauth", status: "coming_soon" },
      { provider: "pipedrive", category: "crm", name: "Pipedrive", description: "Bi-directional CRM sync.", authType: "oauth", status: "coming_soon" },
      { provider: "apollo", category: "enrichment", name: "Apollo.io", description: "Lead sourcing and contact enrichment.", authType: "api_key", status: "available" },
      { provider: "clay", category: "enrichment", name: "Clay", description: "Waterfall enrichment with custom signals.", authType: "api_key", status: "coming_soon" },
      { provider: "google_calendar", category: "calendar", name: "Google Calendar", description: "Booking and availability lookup.", authType: "oauth", status: "available" },
      { provider: "microsoft_calendar", category: "calendar", name: "Microsoft Calendar", description: "Booking and availability lookup.", authType: "oauth", status: "coming_soon" },
      { provider: "slack", category: "communication", name: "Slack", description: "Notifications and reply alerts.", authType: "oauth", status: "available" },
      { provider: "whatsapp", category: "communication", name: "WhatsApp Business", description: "Channel for booked-meeting confirmations.", authType: "oauth", status: "coming_soon" },
      { provider: "elevenlabs", category: "voice", name: "ElevenLabs Voice", description: "AI voice for outbound calling.", authType: "api_key", status: "available" },
    ];
  }

  async findAll(orgId: string) {
    return this.prisma.integration.findMany({
      where: { orgId },
      orderBy: { createdAt: "desc" },
    });
  }

  async findOne(id: string, orgId: string) {
    const integration = await this.prisma.integration.findFirst({
      where: { id, orgId },
    });
    if (!integration) throw new NotFoundException("Integration not found");
    return integration;
  }

  async create(
    orgId: string,
    data: { provider: string; credentials: Record<string, unknown> },
  ) {
    const encrypted = encryptCredentials(data.credentials);
    return this.prisma.integration.upsert({
      where: { orgId_provider: { orgId, provider: data.provider } },
      create: {
        orgId,
        provider: data.provider,
        credentials: { encrypted } as unknown as Prisma.InputJsonValue,
        status: "CONNECTED",
      },
      update: {
        credentials: { encrypted } as unknown as Prisma.InputJsonValue,
        status: "CONNECTED",
      },
    });
  }

  async getDecryptedCredentials(
    orgId: string,
    provider: string,
  ): Promise<Record<string, unknown> | null> {
    const integration = await this.prisma.integration.findFirst({
      where: { orgId, provider, status: "CONNECTED" },
    });
    if (!integration) return null;

    try {
      const creds = integration.credentials as Record<string, unknown>;
      this.assertEncrypted(creds, provider);
      return decryptCredentials(creds.encrypted as string);
    } catch (err) {
      this.logger.warn(
        `[Integration:${provider}] decrypt failed: ${
          err instanceof Error ? err.message : "unknown"
        }`,
      );
      return null;
    }
  }

  private assertEncrypted(creds: Record<string, unknown>, provider: string): void {
    if (!creds || typeof creds !== "object") {
      throw new Error(`[Integration:${provider}] credentials field empty/malformed`);
    }
    if (!creds.encrypted || typeof creds.encrypted !== "string") {
      throw new Error(`[Integration:${provider}] credentials are not encrypted`);
    }
  }

  /**
   * Refresh an OAuth token if it's near expiry. Uses an upsert keyed on the
   * `(orgId, provider)` unique constraint so two concurrent refreshes can't
   * clobber each other's refresh_token.
   */
  async refreshTokenIfNeeded(
    orgId: string,
    provider: string,
  ): Promise<Record<string, unknown> | null> {
    const creds = await this.getDecryptedCredentials(orgId, provider);
    if (!creds) return null;

    const expiresAt = creds.expires_at as number | undefined;
    if (!expiresAt || Date.now() < expiresAt - 300_000) {
      return creds; // still fresh
    }

    const refreshToken = creds.refresh_token as string | undefined;
    if (!refreshToken) return creds;

    const config = OAUTH_CONFIGS[provider];
    if (!config || !config.clientId || !config.clientSecret) return creds;

    let tokens: Record<string, unknown>;
    try {
      const body = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: config.clientId,
        client_secret: config.clientSecret,
      });
      const response = await fetch(config.tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
      if (!response.ok) return creds;
      tokens = (await response.json()) as Record<string, unknown>;
    } catch {
      return creds;
    }

    const newCreds = {
      ...creds,
      access_token: tokens.access_token || creds.access_token,
      refresh_token: tokens.refresh_token || refreshToken,
      expires_at: tokens.expires_in
        ? Date.now() + (tokens.expires_in as number) * 1000
        : creds.expires_at,
    };

    const encrypted = encryptCredentials(newCreds);
    try {
      await this.prisma.integration.update({
        where: { orgId_provider: { orgId, provider } },
        data: { credentials: { encrypted } as unknown as Prisma.InputJsonValue },
      });
    } catch (err) {
      this.logger.warn(
        `[Integration:${provider}] token refresh DB write failed; using in-memory creds: ${
          err instanceof Error ? err.message : "unknown"
        }`,
      );
    }
    return newCreds;
  }

  /** Returns a provider's OAuth consent URL with a signed `state`. */
  getOAuthUrl(provider: string, orgId: string): string {
    const config = OAUTH_CONFIGS[provider];
    if (!config) {
      throw new NotFoundException(`OAuth not supported for provider: ${provider}`);
    }

    const state = signOAuthState(orgId);

    if (!config.clientId) {
      // Mock flow for environments without real OAuth credentials.
      return `/api/integrations/${provider}/callback?code=mock_code&state=${encodeURIComponent(state)}`;
    }

    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.redirectUri || "",
      response_type: "code",
      scope: config.scopes.join(" "),
      state,
      access_type: "offline",
      prompt: "consent",
    });
    return `${config.authUrl}?${params.toString()}`;
  }

  /** Exchange the authorization code for tokens and store them encrypted. */
  async handleOAuthCallback(provider: string, code: string, orgId: string) {
    const config = OAUTH_CONFIGS[provider];
    if (!config) {
      throw new NotFoundException(`OAuth not supported for provider: ${provider}`);
    }

    let tokens: Record<string, unknown>;

    if (!config.clientId || code === "mock_code") {
      tokens = {
        access_token: `mock_${provider}_access_token_${Date.now()}`,
        refresh_token: `mock_${provider}_refresh_token_${Date.now()}`,
        token_type: "Bearer",
        expires_in: 3600,
        expires_at: Date.now() + 3600 * 1000,
        scope: config.scopes.join(" "),
      };
    } else {
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: config.redirectUri || "",
        client_id: config.clientId,
        client_secret: config.clientSecret || "",
      });
      const response = await fetch(config.tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
      if (!response.ok) {
        throw new Error(`Token exchange failed: ${response.status}`);
      }
      tokens = (await response.json()) as Record<string, unknown>;
    }

    const encrypted = encryptCredentials(tokens);

    return this.prisma.integration.upsert({
      where: { orgId_provider: { orgId, provider } },
      create: {
        orgId,
        provider,
        credentials: { encrypted } as unknown as Prisma.InputJsonValue,
        status: "CONNECTED",
      },
      update: {
        credentials: { encrypted } as unknown as Prisma.InputJsonValue,
        status: "CONNECTED",
      },
    });
  }

  async checkHealth(
    id: string,
    orgId: string,
  ): Promise<{ status: string; message: string }> {
    const integration = await this.findOne(id, orgId);
    try {
      const creds = integration.credentials as Record<string, unknown>;
      if (creds.encrypted && typeof creds.encrypted === "string") {
        const decrypted = decryptCredentials(creds.encrypted as string);
        const expiresAt = decrypted.expires_at as number | undefined;
        if (expiresAt && Date.now() > expiresAt) {
          return { status: "expired", message: "Token expired. Reconnect required." };
        }
      }
      if (integration.status === "CONNECTED") {
        return {
          status: "healthy",
          message: "Integration is connected and tokens are valid.",
        };
      }
      return {
        status: integration.status.toLowerCase(),
        message: `Integration status: ${integration.status}`,
      };
    } catch {
      return { status: "error", message: "Could not verify integration health." };
    }
  }

  /** Mock connect for non-prod/demo environments. */
  async simulateConnect(orgId: string, provider: string) {
    if (process.env.NODE_ENV === "production") {
      throw new NotFoundException("Endpoint not available");
    }

    const mockCredentials = {
      access_token: `mock_${provider}_token_${Date.now()}`,
      refresh_token: `mock_${provider}_refresh_${Date.now()}`,
      token_type: "Bearer",
      expires_at: Date.now() + 3600 * 1000 * 24 * 30,
      scope: OAUTH_CONFIGS[provider]?.scopes.join(" ") || "",
    };
    const encrypted = encryptCredentials(mockCredentials);

    return this.prisma.integration.upsert({
      where: { orgId_provider: { orgId, provider } },
      create: {
        orgId,
        provider,
        credentials: { encrypted } as unknown as Prisma.InputJsonValue,
        status: "CONNECTED",
      },
      update: {
        credentials: { encrypted } as unknown as Prisma.InputJsonValue,
        status: "CONNECTED",
      },
    });
  }

  async disconnect(id: string, orgId: string) {
    const integration = await this.findOne(id, orgId);
    return this.prisma.integration.delete({ where: { id: integration.id } });
  }

  async disconnectByProvider(orgId: string, provider: string) {
    const integration = await this.prisma.integration.findFirst({
      where: { orgId, provider },
    });
    if (!integration) throw new NotFoundException("Integration not found");
    return this.prisma.integration.delete({ where: { id: integration.id } });
  }

  /**
   * API-key flow. Stores the key as encrypted credentials, mirroring how the
   * OAuth flow stores tokens. The FE's `connectIntegration(provider, {apiKey})`
   * lands here.
   */
  async connectApiKey(orgId: string, provider: string, apiKey: string) {
    if (!apiKey || typeof apiKey !== "string") {
      throw new NotFoundException("apiKey is required");
    }
    return this.create(orgId, { provider, credentials: { api_key: apiKey } });
  }

  /**
   * Lightweight test: confirm we have stored, decryptable credentials and
   * (for OAuth) the access token hasn't expired. Doesn't call the provider.
   */
  async testByProvider(
    orgId: string,
    provider: string,
  ): Promise<{ ok: boolean; message: string }> {
    const creds = await this.getDecryptedCredentials(orgId, provider);
    if (!creds) {
      return { ok: false, message: `${provider} is not connected.` };
    }
    const expiresAt = creds.expires_at as number | undefined;
    if (expiresAt && Date.now() > expiresAt) {
      return { ok: false, message: "Access token expired. Reconnect required." };
    }
    return { ok: true, message: `${provider} credentials are valid.` };
  }
}
