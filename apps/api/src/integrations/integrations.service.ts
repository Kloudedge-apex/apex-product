import {
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { encryptCredentials, decryptCredentials } from "./crypto.util";
import { fetchWithRetry, withCircuitBreaker } from "../common/http-retry.util";
import { gmailWatchFreshnessFloor } from "./gmail/gmail-watch-freshness";

interface OAuthConfig {
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  authUrl: string;
  tokenUrl: string;
  scopes: string[];
}

/**
 * Safety skew subtracted when converting a provider's relative `expires_in`
 * (seconds) into an absolute `expires_at` (ms epoch). Refreshing ~60s early
 * absorbs clock drift + request latency so we never present a token the
 * provider already considers dead.
 */
const EXPIRES_AT_SKEW_MS = 60_000;

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
      "https://www.googleapis.com/auth/gmail.modify",
    ],
  },
};

/**
 * Public Integration responses must never serialize either credential store.
 * Keep this allowlist next to the service boundary so new secret-bearing
 * columns fail closed until they are reviewed explicitly.
 */
const PUBLIC_INTEGRATION_SELECT = {
  id: true,
  provider: true,
  status: true,
  scopes: true,
  lastSyncAt: true,
  lastErrorAt: true,
  lastErrorMessage: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.IntegrationSelect;

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
      { provider: "outlook", category: "email", name: "Microsoft 365 (Outlook)", description: "Microsoft 365 mailbox support is not included in this release.", authType: "oauth", status: "coming_soon" },
      { provider: "hubspot", category: "crm", name: "HubSpot", description: "HubSpot sync is not included in this release.", authType: "oauth", status: "coming_soon" },
      { provider: "salesforce", category: "crm", name: "Salesforce", description: "Bi-directional CRM sync.", authType: "oauth", status: "coming_soon" },
      { provider: "pipedrive", category: "crm", name: "Pipedrive", description: "Bi-directional CRM sync.", authType: "oauth", status: "coming_soon" },
      { provider: "apollo", category: "enrichment", name: "Apollo.io", description: "Apollo enrichment is not included in this release.", authType: "api_key", status: "coming_soon" },
      { provider: "clay", category: "enrichment", name: "Clay", description: "Waterfall enrichment with custom signals.", authType: "api_key", status: "coming_soon" },
      { provider: "google_calendar", category: "calendar", name: "Google Calendar", description: "Calendar actions are not included in this release.", authType: "oauth", status: "coming_soon" },
      { provider: "microsoft_calendar", category: "calendar", name: "Microsoft Calendar", description: "Booking and availability lookup.", authType: "oauth", status: "coming_soon" },
      { provider: "slack", category: "communication", name: "Slack", description: "Slack notifications are not included in this release.", authType: "oauth", status: "coming_soon" },
      { provider: "whatsapp", category: "communication", name: "WhatsApp Business", description: "Channel for booked-meeting confirmations.", authType: "oauth", status: "coming_soon" },
      { provider: "elevenlabs", category: "voice", name: "ElevenLabs Voice", description: "Voice outreach is not included in this release.", authType: "api_key", status: "coming_soon" },
    ];
  }

  async findAll(orgId: string) {
    return this.prisma.integration.findMany({
      where: { orgId, provider: "gmail" },
      orderBy: { createdAt: "desc" },
      select: PUBLIC_INTEGRATION_SELECT,
    });
  }

  async findOne(id: string, orgId: string) {
    const integration = await this.prisma.integration.findFirst({
      where: { id, orgId, provider: "gmail" },
      select: PUBLIC_INTEGRATION_SELECT,
    });
    if (!integration) throw new NotFoundException("Integration not found");
    return integration;
  }

  async findByProvider(orgId: string, provider: string) {
    this.assertGmailProvider(provider);
    const integration = await this.prisma.integration.findFirst({
      where: { orgId, provider: "gmail" },
      select: PUBLIC_INTEGRATION_SELECT,
    });
    if (!integration) throw new NotFoundException("Integration not found");
    return integration;
  }

  async create(
    orgId: string,
    data: { provider: string; credentials: Record<string, unknown> },
  ) {
    void orgId;
    void data;
    throw new NotFoundException(
      "Direct integration creation is unavailable; use Gmail OAuth",
    );
  }

  async getDecryptedCredentials(
    orgId: string,
    provider: string,
  ): Promise<Record<string, unknown> | null> {
    this.assertGmailProvider(provider);
    const integration = await this.prisma.integration.findFirst({
      where: {
        orgId,
        provider: "gmail",
        status: "CONNECTED",
        encryptedCredentials: { not: null },
        credentials: {
          path: ["accountEmail"],
          string_contains: "@",
        },
        lastHistoryId: { not: null },
        lastSyncAt: { gte: gmailWatchFreshnessFloor() },
      },
    });
    if (!integration) return null;

    try {
      return this.decryptIntegrationRow(integration, provider);
    } catch (err) {
      this.logger.warn(
        `[Integration:${provider}] decrypt failed: ${
          err instanceof Error ? err.message : "unknown"
        }`,
      );
      return null;
    }
  }

  /**
   * Two credential storage shapes exist on the SAME Integration row
   * (split-brain flagged in the go-live readiness audit):
   *
   *   1. `credentials.encrypted` — written by this service's OAuth-callback,
   *      api-key, and refresh paths. Payload uses `expires_at` (ms epoch).
   *   2. `encryptedCredentials` column — written by gmail.service.ts
   *      (`handleCallback`/`saveTokens`) and hubspot.service.ts. Payload uses
   *      googleapis' `expiry_date` (ms epoch); the `credentials` JSON then
   *      only holds the plaintext `accountEmail` push-routing marker.
   *
   * We decrypt whichever shape is present; when BOTH decrypt we keep the one
   * with the LATER absolute expiry (the other writer may have refreshed more
   * recently — e.g. gmail.service's `tokens` listener only updates the
   * column). `expiry_date` is normalized into `expires_at` so callers see one
   * canonical field. Writers in this service persist both shapes (see
   * `handleOAuthCallback` / `refreshTokenIfNeeded`) so rows converge.
   */
  private decryptIntegrationRow(
    row: { credentials: unknown; encryptedCredentials: string | null },
    provider: string,
  ): Record<string, unknown> {
    const candidates: Array<Record<string, unknown>> = [];

    if (this.hasInlineEncrypted(row.credentials)) {
      const inline = (row.credentials as Record<string, unknown>)
        .encrypted as string;
      try {
        candidates.push(this.normalizeExpiry(decryptCredentials(inline)));
      } catch (err) {
        this.logger.warn(
          `[Integration:${provider}] credentials.encrypted blob failed to decrypt: ${
            err instanceof Error ? err.message : "unknown"
          }`,
        );
      }
    }

    if (row.encryptedCredentials) {
      try {
        candidates.push(
          this.normalizeExpiry(decryptCredentials(row.encryptedCredentials)),
        );
      } catch (err) {
        this.logger.warn(
          `[Integration:${provider}] encryptedCredentials column failed to decrypt: ${
            err instanceof Error ? err.message : "unknown"
          }`,
        );
      }
    }

    const [first, second] = candidates;
    if (!first) {
      throw new Error(
        `[Integration:${provider}] no decryptable credentials in either storage shape`,
      );
    }
    if (!second) return first;

    const firstExpiry = typeof first.expires_at === "number" ? first.expires_at : 0;
    const secondExpiry =
      typeof second.expires_at === "number" ? second.expires_at : 0;
    return secondExpiry > firstExpiry ? second : first;
  }

  private hasInlineEncrypted(credentials: unknown): boolean {
    return (
      !!credentials &&
      typeof credentials === "object" &&
      !Array.isArray(credentials) &&
      typeof (credentials as Record<string, unknown>).encrypted === "string" &&
      ((credentials as Record<string, unknown>).encrypted as string).length > 0
    );
  }

  /** gmail.service stores googleapis' `expiry_date`; canonicalize to `expires_at`. */
  private normalizeExpiry(creds: Record<string, unknown>): Record<string, unknown> {
    if (typeof creds.expires_at === "number") return creds;
    if (typeof creds.expiry_date === "number") {
      return { ...creds, expires_at: creds.expiry_date };
    }
    return creds;
  }

  /**
   * Absolute expiry (ms epoch) from a token endpoint's relative `expires_in`
   * (seconds), minus {@link EXPIRES_AT_SKEW_MS}. Returns undefined when the
   * provider sent no usable `expires_in`.
   */
  private computeExpiresAt(
    tokens: Record<string, unknown>,
    nowMs: number = Date.now(),
  ): number | undefined {
    const raw = tokens.expires_in;
    const seconds =
      typeof raw === "number"
        ? raw
        : typeof raw === "string" && raw.trim() !== ""
          ? Number(raw)
          : NaN;
    if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
    return nowMs + seconds * 1000 - EXPIRES_AT_SKEW_MS;
  }

  /**
   * Plaintext Gmail push-routing marker that gmail.service.ts stores in the
   * (non-secret) `credentials` JSON. Must survive token rewrites or inbound
   * push → orgId routing breaks (`findIntegrationByEmail`).
   */
  private extractAccountEmail(credentials: unknown): string | undefined {
    if (
      credentials &&
      typeof credentials === "object" &&
      !Array.isArray(credentials)
    ) {
      const value = (credentials as Record<string, unknown>).accountEmail;
      if (typeof value === "string" && value.length > 0) return value;
    }
    return undefined;
  }

  /**
   * Refresh an OAuth token if it's near expiry. Uses an update keyed on the
   * `(orgId, provider)` unique constraint so two concurrent refreshes can't
   * clobber each other's refresh_token.
   *
   * Returns null when the integration is missing/undecryptable OR when the
   * provider permanently rejected our refresh token (`invalid_grant`) — in
   * that case the row is flipped to ERROR so dashboards show "reconnect"
   * instead of sends silently 401-ing.
   */
  async refreshTokenIfNeeded(
    orgId: string,
    provider: string,
  ): Promise<Record<string, unknown> | null> {
    this.assertGmailProvider(provider);
    const integration = await this.prisma.integration.findFirst({
      where: {
        orgId,
        provider: "gmail",
        status: "CONNECTED",
        encryptedCredentials: { not: null },
        credentials: {
          path: ["accountEmail"],
          string_contains: "@",
        },
        lastHistoryId: { not: null },
        lastSyncAt: { gte: gmailWatchFreshnessFloor() },
      },
    });
    if (!integration) return null;

    let creds: Record<string, unknown>;
    try {
      creds = this.decryptIntegrationRow(integration, provider);
    } catch (err) {
      this.logger.warn(
        `[Integration:${provider}] decrypt failed: ${
          err instanceof Error ? err.message : "unknown"
        }`,
      );
      return null;
    }

    // A credential WITHOUT an absolute expiry is treated as EXPIRED, not
    // eternally fresh. Callback-stored tokens (pre-2026-06-12, including the
    // tenant-zero Gmail credential from 2026-05-20) only carried the raw
    // relative `expires_in`, so the old `!expiresAt → return creds` guard
    // meant they were NEVER refreshed and every send 401'd ~60 minutes after
    // connect. Credentials without a refresh_token (api-key providers) fall
    // through harmlessly below.
    const expiresAt =
      typeof creds.expires_at === "number" ? creds.expires_at : undefined;
    if (expiresAt !== undefined && Date.now() < expiresAt - 300_000) {
      return creds; // still fresh
    }

    const refreshToken =
      typeof creds.refresh_token === "string" && creds.refresh_token.length > 0
        ? creds.refresh_token
        : undefined;
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
      const response = await withCircuitBreaker(`oauth-${provider}`, () =>
        fetchWithRetry(
          config.tokenUrl,
          {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: body.toString(),
          },
          { provider: `oauth-${provider}` },
        ),
      );
      if (!response.ok) {
        const errorCode = await this.readOAuthErrorCode(response);
        if (errorCode === "invalid_grant") {
          // Permanent: the grant was revoked/expired upstream (revoked
          // consent, expired refresh token, changed password). Retrying
          // forever only hides the outage — surface it.
          await this.markRefreshFailedPermanently(orgId, provider, errorCode);
          return null;
        }
        this.logger.warn(
          `[Integration:${provider}] token refresh HTTP ${response.status}` +
            `${errorCode ? ` (${errorCode})` : ""} — keeping existing creds`,
        );
        return creds;
      }
      tokens = (await response.json()) as Record<string, unknown>;
    } catch (err) {
      this.logger.warn(
        `[Integration:${provider}] token refresh transport error — keeping existing creds: ${
          err instanceof Error ? err.message : "unknown"
        }`,
      );
      return creds;
    }

    const refreshedExpiresAt = this.computeExpiresAt(tokens);
    const newCreds: Record<string, unknown> = {
      ...creds,
      ...(typeof tokens.expires_in === "number" ||
      typeof tokens.expires_in === "string"
        ? { expires_in: tokens.expires_in }
        : {}),
      access_token: tokens.access_token || creds.access_token,
      refresh_token:
        typeof tokens.refresh_token === "string" &&
        tokens.refresh_token.length > 0
          ? tokens.refresh_token
          : refreshToken,
      ...(refreshedExpiresAt !== undefined
        ? { expires_at: refreshedExpiresAt, expiry_date: refreshedExpiresAt }
        : {}),
    };

    const encrypted = encryptCredentials(newCreds);
    const accountEmail = this.extractAccountEmail(integration.credentials);
    const credentialsJson = (
      accountEmail ? { encrypted, accountEmail } : { encrypted }
    ) as unknown as Prisma.InputJsonValue;
    try {
      await this.prisma.integration.update({
        where: { orgId_provider: { orgId, provider } },
        data: {
          credentials: credentialsJson,
          // Mirror into the column gmail.service.ts/hubspot.service.ts read
          // so both storage shapes stay in lock-step after every refresh.
          encryptedCredentials: encrypted,
        },
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

  /** Best-effort parse of an OAuth error body (`{"error":"invalid_grant",...}`). */
  private async readOAuthErrorCode(response: Response): Promise<string> {
    try {
      const body = (await response.json()) as Record<string, unknown>;
      return typeof body.error === "string" ? body.error : "";
    } catch {
      return "";
    }
  }

  /**
   * The provider told us the refresh token itself is dead. Flip the row out
   * of CONNECTED so the dashboard shows a reconnect prompt instead of every
   * send silently failing with 401s. Mirrors hubspot.service.ts's
   * refresh-failure handling (status ERROR + lastErrorAt/lastErrorMessage).
   */
  private async markRefreshFailedPermanently(
    orgId: string,
    provider: string,
    errorCode: string,
  ): Promise<void> {
    this.logger.error(
      `[Integration:${provider}] OAuth refresh PERMANENTLY rejected (${errorCode}) ` +
        `for org ${orgId} — marking integration ERROR; user must reconnect ${provider}`,
    );
    try {
      await this.prisma.integration.update({
        where: { orgId_provider: { orgId, provider } },
        data: {
          status: "ERROR",
          lastErrorAt: new Date(),
          lastErrorMessage: `OAuth token refresh failed: ${errorCode}. Reconnect required.`,
        },
      });
    } catch (err) {
      this.logger.error(
        `[Integration:${provider}] failed to persist ERROR status after ${errorCode}: ${
          err instanceof Error ? err.message : "unknown"
        }`,
      );
    }
  }

  /** Returns a provider's OAuth consent URL with a server-issued opaque state. */
  getOAuthUrl(provider: string, state: string): string {
    this.assertGmailProvider(provider);
    const config = OAUTH_CONFIGS[provider];
    if (!config) {
      throw new NotFoundException(`OAuth not supported for provider: ${provider}`);
    }

    if (!config.clientId) {
      // Mock flow for environments without real OAuth credentials.
      if (process.env.NODE_ENV === "production") {
        throw new ServiceUnavailableException(
          `${provider} OAuth is not configured`,
        );
      }
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
    this.assertGmailProvider(provider);
    void code;
    void orgId;
    throw new NotFoundException(
      "Generic OAuth callbacks are unavailable; use the canonical Gmail callback",
    );
  }

  async checkHealth(
    id: string,
    orgId: string,
  ): Promise<{ status: string; message: string }> {
    // This row stays inside the service. Only the derived status/message
    // below crosses the controller boundary.
    const integration = await this.prisma.integration.findFirst({
      where: { id, orgId, provider: "gmail" },
    });
    if (!integration) throw new NotFoundException("Integration not found");
    try {
      const hasAnyBlob =
        Boolean(integration.encryptedCredentials) ||
        this.hasInlineEncrypted(integration.credentials);
      if (hasAnyBlob) {
        // Dual-shape read: gmail.service-connected rows store tokens in the
        // `encryptedCredentials` column with `expiry_date` (normalized to
        // `expires_at` by decryptIntegrationRow).
        const decrypted = this.decryptIntegrationRow(
          integration,
          integration.provider,
        );
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
    void orgId;
    this.assertGmailProvider(provider);
    throw new NotFoundException(
      "Direct mock connect is unavailable; use the Gmail OAuth mock callback",
    );
  }

  async disconnect(id: string, orgId: string) {
    const integration = await this.findOne(id, orgId);
    return this.prisma.integration.delete({
      where: { id: integration.id },
      select: PUBLIC_INTEGRATION_SELECT,
    });
  }

  async disconnectByProvider(orgId: string, provider: string) {
    this.assertGmailProvider(provider);
    const integration = await this.prisma.integration.findFirst({
      where: { orgId, provider },
      select: { id: true },
    });
    if (!integration) throw new NotFoundException("Integration not found");
    return this.prisma.integration.delete({
      where: { id: integration.id },
      select: PUBLIC_INTEGRATION_SELECT,
    });
  }

  /**
   * API-key flow. Stores the key as encrypted credentials, mirroring how the
   * OAuth flow stores tokens. The FE's `connectIntegration(provider, {apiKey})`
   * lands here.
   */
  async connectApiKey(orgId: string, provider: string, apiKey: string) {
    void orgId;
    void apiKey;
    this.assertGmailProvider(provider);
    throw new NotFoundException(
      "API-key integrations are unavailable in this release",
    );
  }

  /**
   * Lightweight test: confirm we have stored, decryptable credentials and
   * (for OAuth) the access token hasn't expired. Doesn't call the provider.
   */
  async testByProvider(
    orgId: string,
    provider: string,
  ): Promise<{ ok: boolean; message: string }> {
    this.assertGmailProvider(provider);
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

  private assertGmailProvider(provider: string): void {
    if (provider !== "gmail") {
      throw new NotFoundException(
        `Provider is not available in this release: ${provider}`,
      );
    }
  }
}
