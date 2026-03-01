import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { encryptCredentials, decryptCredentials } from "./crypto.util";

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
    redirectUri: process.env.GOOGLE_REDIRECT_URI || "http://localhost:4000/api/integrations/gmail/callback",
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: ["https://www.googleapis.com/auth/gmail.send", "https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.compose"],
  },
  outlook: {
    clientId: process.env.MICROSOFT_CLIENT_ID,
    clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
    redirectUri: process.env.MICROSOFT_REDIRECT_URI || "http://localhost:4000/api/integrations/outlook/callback",
    authUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scopes: ["Mail.ReadWrite", "Mail.Send", "offline_access"],
  },
  hubspot: {
    clientId: process.env.HUBSPOT_CLIENT_ID,
    clientSecret: process.env.HUBSPOT_CLIENT_SECRET,
    redirectUri: process.env.HUBSPOT_REDIRECT_URI || "http://localhost:4000/api/integrations/hubspot/callback",
    authUrl: "https://app.hubspot.com/oauth/authorize",
    tokenUrl: "https://api.hubapi.com/oauth/v1/token",
    scopes: ["contacts", "crm.objects.deals.read", "crm.objects.companies.read"],
  },
  linkedin: {
    clientId: process.env.LINKEDIN_CLIENT_ID,
    clientSecret: process.env.LINKEDIN_CLIENT_SECRET,
    redirectUri: process.env.LINKEDIN_REDIRECT_URI || "http://localhost:4000/api/integrations/linkedin/callback",
    authUrl: "https://www.linkedin.com/oauth/v2/authorization",
    tokenUrl: "https://www.linkedin.com/oauth/v2/accessToken",
    scopes: ["r_liteprofile", "r_emailaddress", "w_member_social"],
  },
};

@Injectable()
export class IntegrationsService {
  constructor(private prisma: PrismaService) { }

  async findAll(orgId: string) {
    return this.prisma.integration.findMany({
      where: { orgId },
      orderBy: { createdAt: "desc" },
    });
  }

  async getDecryptedCredentials(orgId: string, provider: string): Promise<Record<string, unknown> | null> {
    const integration = await this.prisma.integration.findFirst({
      where: { orgId, provider, status: "CONNECTED" },
    });

    if (!integration) return null;

    try {
      const creds = integration.credentials as Record<string, unknown>;
      this.assertEncrypted(creds, provider);
      return decryptCredentials(creds.encrypted as string);
    } catch {
      return null;
    }
  }

  /**
   * Assert that stored credentials use the encrypted wrapper format.
   * Throws if plaintext credentials are detected — this is a configuration bug.
   */
  private assertEncrypted(creds: Record<string, unknown>, provider: string): void {
    if (!creds || typeof creds !== "object") {
      throw new Error(`[Integration:${provider}] credentials field is empty or malformed`);
    }
    if (!creds.encrypted || typeof creds.encrypted !== "string") {
      throw new Error(
        `[Integration:${provider}] credentials are not encrypted. ` +
        `Expected { encrypted: string }, got keys: [${Object.keys(creds).join(", ")}]. ` +
        `Re-connecting the integration will fix this.`,
      );
    }
  }

  async refreshTokenIfNeeded(orgId: string, provider: string): Promise<Record<string, unknown> | null> {
    const creds = await this.getDecryptedCredentials(orgId, provider);
    if (!creds) return null;

    const expiresAt = creds.expires_at as number | undefined;
    if (!expiresAt || Date.now() < expiresAt - 300000) {
      // Token still valid (with 5 min buffer)
      return creds;
    }

    // Token expired or about to expire - attempt refresh
    const refreshToken = creds.refresh_token as string | undefined;
    if (!refreshToken) return creds; // No refresh token, return as-is

    const config = OAUTH_CONFIGS[provider];
    if (!config || !config.clientId || !config.clientSecret) return creds;

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

      const tokens = await response.json() as Record<string, unknown>;
      const newCreds = {
        ...creds,
        access_token: tokens.access_token || creds.access_token,
        refresh_token: tokens.refresh_token || refreshToken,
        expires_at: tokens.expires_in
          ? Date.now() + (tokens.expires_in as number) * 1000
          : creds.expires_at,
      };

      // Save refreshed credentials
      const integration = await this.prisma.integration.findFirst({
        where: { orgId, provider },
      });
      if (integration) {
        const encrypted = encryptCredentials(newCreds);
        await this.prisma.integration.update({
          where: { id: integration.id },
          data: { credentials: { encrypted } as any },
        });
      }

      return newCreds;
    } catch {
      return creds;
    }
  }

  async findOne(id: string) {
    const integration = await this.prisma.integration.findUnique({ where: { id } });
    if (!integration) throw new NotFoundException("Integration not found");
    return integration;
  }

  async create(data: { orgId: string; provider: string; credentials: Record<string, unknown> }) {
    const encrypted = encryptCredentials(data.credentials);
    return this.prisma.integration.create({
      data: {
        orgId: data.orgId,
        provider: data.provider,
        credentials: { encrypted } as any,
        status: "CONNECTED",
      },
    });
  }

  async remove(id: string) {
    return this.prisma.integration.delete({ where: { id } });
  }

  async updateStatus(id: string, status: "PENDING" | "CONNECTED" | "ERROR" | "REVOKED") {
    return this.prisma.integration.update({
      where: { id },
      data: { status },
    });
  }

  // OAuth: get auth URL for a provider
  getOAuthUrl(provider: string, orgId: string): string {
    const config = OAUTH_CONFIGS[provider];
    if (!config) {
      throw new NotFoundException(`OAuth not supported for provider: ${provider}`);
    }

    // If no real client ID, return a mock flow URL
    if (!config.clientId) {
      return `/api/integrations/${provider}/callback?code=mock_code&state=${orgId}`;
    }

    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.redirectUri || "",
      response_type: "code",
      scope: config.scopes.join(" "),
      state: orgId,
      access_type: "offline",
      prompt: "consent",
    });

    return `${config.authUrl}?${params.toString()}`;
  }

  // OAuth: handle callback, exchange code for tokens
  async handleOAuthCallback(provider: string, code: string, orgId: string) {
    const config = OAUTH_CONFIGS[provider];
    if (!config) {
      throw new NotFoundException(`OAuth not supported for provider: ${provider}`);
    }

    let tokens: Record<string, unknown>;

    if (!config.clientId || code === "mock_code") {
      // Mock token exchange for demo
      tokens = {
        access_token: `mock_${provider}_access_token_${Date.now()}`,
        refresh_token: `mock_${provider}_refresh_token_${Date.now()}`,
        token_type: "Bearer",
        expires_in: 3600,
        expires_at: Date.now() + 3600 * 1000,
        scope: config.scopes.join(" "),
      };
    } else {
      // Real token exchange
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
        throw new Error(`Token exchange failed: ${response.statusText}`);
      }
      tokens = await response.json() as Record<string, unknown>;
    }

    const encrypted = encryptCredentials(tokens);

    // Upsert: if integration exists for this org+provider, update; otherwise create
    const existing = await this.prisma.integration.findFirst({
      where: { orgId, provider },
    });

    if (existing) {
      return this.prisma.integration.update({
        where: { id: existing.id },
        data: {
          credentials: { encrypted } as any,
          status: "CONNECTED",
        },
      });
    }

    return this.prisma.integration.create({
      data: {
        orgId,
        provider,
        credentials: { encrypted } as any,
        status: "CONNECTED",
      },
    });
  }

  // Check if integration tokens are still valid
  async checkHealth(id: string): Promise<{ status: string; message: string }> {
    const integration = await this.findOne(id);

    // Try to decrypt credentials
    try {
      const creds = integration.credentials as Record<string, unknown>;
      if (creds.encrypted && typeof creds.encrypted === "string") {
        const decrypted = decryptCredentials(creds.encrypted);
        const expiresAt = decrypted.expires_at as number | undefined;
        if (expiresAt && Date.now() > expiresAt) {
          // Token expired - attempt refresh
          return { status: "expired", message: "Token expired. Reconnect required." };
        }
      }
      if (integration.status === "CONNECTED") {
        return { status: "healthy", message: "Integration is connected and tokens are valid." };
      }
      return { status: integration.status.toLowerCase(), message: `Integration status: ${integration.status}` };
    } catch {
      return { status: "error", message: "Could not verify integration health." };
    }
  }

  // Simulate connect for MVP (creates integration record directly)
  async simulateConnect(orgId: string, provider: string) {
    const existing = await this.prisma.integration.findFirst({
      where: { orgId, provider },
    });

    const mockCredentials = {
      access_token: `mock_${provider}_token_${Date.now()}`,
      refresh_token: `mock_${provider}_refresh_${Date.now()}`,
      token_type: "Bearer",
      expires_at: Date.now() + 3600 * 1000 * 24 * 30, // 30 days
      scope: OAUTH_CONFIGS[provider]?.scopes.join(" ") || "",
    };

    const encrypted = encryptCredentials(mockCredentials);

    if (existing) {
      return this.prisma.integration.update({
        where: { id: existing.id },
        data: {
          credentials: { encrypted } as any,
          status: "CONNECTED",
        },
      });
    }

    return this.prisma.integration.create({
      data: {
        orgId,
        provider,
        credentials: { encrypted } as any,
        status: "CONNECTED",
      },
    });
  }

  // Disconnect and revoke
  async disconnect(id: string) {
    const integration = await this.findOne(id);
    // In real flow, we'd revoke the token with the provider here
    return this.prisma.integration.delete({ where: { id: integration.id } });
  }
}
