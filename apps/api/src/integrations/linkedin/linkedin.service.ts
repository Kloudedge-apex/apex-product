import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { IntegrationsService } from "../integrations.service";
import {
  CircuitOpenError,
  RateLimitedError,
  fetchWithRetry,
  withCircuitBreaker,
} from "../../common/http-retry.util";

/**
 * Result shape for any LinkedIn message send attempt. Distinct from a plain
 * `ToolResult` so call sites (the LinkedIn tool, the outreach worker) can
 * pattern-match on `ok` + a typed `error` string without re-parsing nested
 * JSON.
 *
 * `error` is a stable machine-readable code (e.g. `linkedin_not_connected`,
 * `linkedin_api_not_available`, `linkedin_send_failed`). `details` carries the
 * upstream body when present, useful for surfacing to ops without leaking the
 * raw access token.
 */
export interface LinkedInSendResult {
  readonly ok: boolean;
  readonly messageId?: string;
  readonly error?: string;
  readonly status?: number;
  readonly details?: string;
}

interface SendMessageInput {
  readonly recipientUrn: string;
  readonly body: string;
}

/**
 * Thin abstraction over LinkedIn's gated Messages API.
 *
 * Reality check: LinkedIn's official Messages API is heavily restricted —
 * `/v2/messages` is gated to apps with specific partnership scopes (mostly
 * Sales Navigator and approved Marketing Developer Platform partners). A
 * standard `w_member_social` OAuth token (what our IntegrationsService grants)
 * is generally NOT sufficient to deliver 1:1 DMs. Expected outcomes when this
 * code actually runs against LinkedIn:
 *   - 403 with `permission_denied` / `not_authorized` → most likely
 *   - 401 if the token is expired or never had the right scopes
 *   - 200/201 only if the workspace has been granted access by LinkedIn
 *
 * Production deployments will almost certainly need to route LinkedIn DMs
 * through a vendor (Unipile, Apollo, Octopus CRM, HeyReach) that performs the
 * automation server-side. This class deliberately does NOT take a vendor
 * dependency — it stays thin and returns a structured failure when LinkedIn's
 * native endpoint rejects the call, so the caller can decide whether to fail
 * the artifact or route via another channel.
 */
@Injectable()
export class LinkedInService {
  private readonly logger = new Logger(LinkedInService.name);
  private static readonly MESSAGES_ENDPOINT =
    "https://api.linkedin.com/v2/messages";

  constructor(
    private readonly prisma: PrismaService,
    private readonly integrations: IntegrationsService,
  ) {}

  /**
   * Send a 1:1 LinkedIn message from the OAuth-connected account to a
   * recipient identified by their member URN (`urn:li:person:<id>`).
   *
   * Resolution rules:
   *   1. If `integrationId` is supplied, look it up directly and assert it
   *      belongs to `orgId` and `provider === "linkedin"`.
   *   2. Otherwise, fall back to the org's primary LinkedIn integration (the
   *      first CONNECTED row).
   *   3. If no integration is found, return `{ ok: false, error:
   *      "linkedin_not_connected" }` — the caller decides whether to surface
   *      that as a tool error or fall back to mock.
   *
   * Network failures and non-2xx responses are surfaced as `ok: false` with a
   * stable `error` string. We do NOT throw on 4xx so the caller can record a
   * meaningful artifact rejection rather than a generic exception.
   */
  async sendMessage(
    orgId: string,
    integrationId: string | null,
    input: SendMessageInput,
  ): Promise<LinkedInSendResult> {
    const integration = await this.resolveIntegration(orgId, integrationId);
    if (!integration) {
      return {
        ok: false,
        error: "linkedin_not_connected",
        details: "No connected LinkedIn integration for this org",
      };
    }

    const creds = await this.integrations.refreshTokenIfNeeded(
      orgId,
      "linkedin",
    );
    const accessToken =
      typeof creds?.access_token === "string" ? creds.access_token : "";

    if (!accessToken) {
      return {
        ok: false,
        error: "linkedin_not_connected",
        details: "No access token available for LinkedIn integration",
      };
    }

    // Mock-mode credentials (set by simulateConnect / mock_code OAuth flow)
    // must not be used to hit the real endpoint. Return a stable error so the
    // tool can decide whether to fall back to a mock receipt.
    if (accessToken.startsWith("mock_")) {
      return {
        ok: false,
        error: "linkedin_mock_credentials",
        details: "Stored LinkedIn token is a mock; refusing to call live API",
      };
    }

    return this.callMessagesApi(accessToken, input);
  }

  private async resolveIntegration(
    orgId: string,
    integrationId: string | null,
  ): Promise<{ readonly id: string } | null> {
    if (integrationId) {
      const row = await this.prisma.integration.findFirst({
        where: {
          id: integrationId,
          orgId,
          provider: "linkedin",
          status: "CONNECTED",
        },
        select: { id: true },
      });
      return row;
    }

    const row = await this.prisma.integration.findFirst({
      where: { orgId, provider: "linkedin", status: "CONNECTED" },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    return row;
  }

  /**
   * Issues the actual `POST /v2/messages` call through the shared retry +
   * circuit-breaker primitive. The request shape follows LinkedIn's documented
   * Messages API contract; if the org's app does not have the right scopes,
   * LinkedIn will respond 401/403 and we surface that verbatim.
   */
  private async callMessagesApi(
    accessToken: string,
    input: SendMessageInput,
  ): Promise<LinkedInSendResult> {
    const body = {
      // LinkedIn expects a sender URN; the access token resolves to "me", but
      // the API still wants the field. We use the literal "me" placeholder
      // which the Messages API resolves to the authenticated member on the
      // server side. If the app's scopes don't permit messaging, the request
      // will reject before sender resolution matters.
      message: {
        body: input.body,
      },
      recipients: [input.recipientUrn],
    };

    let response: Response;
    try {
      response = await withCircuitBreaker("linkedin", () =>
        fetchWithRetry(
          LinkedInService.MESSAGES_ENDPOINT,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
              "X-Restli-Protocol-Version": "2.0.0",
            },
            body: JSON.stringify(body),
          },
          // POST /messages has no caller-supplied idempotency key. One wire
          // attempt only: a lost response is ambiguous and the outreach
          // worker must quarantine its SENDING claim instead of retrying.
          { provider: "linkedin", maxAttempts: 1 },
        ),
      );
    } catch (err) {
      // Circuit-open proves no request was attempted. A RateLimitedError with
      // lastStatus proves the provider returned a rejection. A status-less
      // transport error is intentionally left ambiguous; the outreach worker
      // recognizes that shape and persists DELIVERY_UNKNOWN.
      if (err instanceof CircuitOpenError) {
        return {
          ok: false,
          error: "linkedin_circuit_open",
          details: err.message,
        };
      }
      return {
        ok: false,
        error: "linkedin_send_failed",
        ...(err instanceof RateLimitedError && err.lastStatus !== null
          ? { status: err.lastStatus }
          : {}),
        details: err instanceof Error ? err.message : String(err),
      };
    }

    if (response.ok) {
      const messageId = await this.extractMessageId(response);
      return {
        ok: true,
        messageId: messageId ?? `linkedin:${Date.now()}`,
        status: response.status,
      };
    }

    // Non-2xx. Most likely 401/403 because the app's scopes don't permit
    // 1:1 messaging. Surface the body and a stable code so the caller can
    // distinguish "feature not available" from "transient send failure".
    const detailsText = await safeText(response);
    const code = this.classifyFailure(response.status);
    this.logger.warn(
      `LinkedIn send rejected status=${response.status} code=${code} body=${detailsText.slice(0, 200)}`,
    );
    return {
      ok: false,
      error: code,
      status: response.status,
      details: detailsText.slice(0, 500),
    };
  }

  private async extractMessageId(response: Response): Promise<string | null> {
    // LinkedIn's response shape varies by endpoint version. Try to read an id
    // from a JSON body; tolerate empty bodies (201 Created with no body) by
    // returning null so the caller can fall back to a synthetic receipt.
    try {
      const data = (await response.json()) as Record<string, unknown>;
      if (typeof data.id === "string") return data.id;
      if (typeof data.value === "string") return data.value;
      return null;
    } catch {
      return null;
    }
  }

  private classifyFailure(status: number): string {
    if (status === 401 || status === 403) {
      // The most common case: app doesn't have the messaging scope.
      return "linkedin_api_not_available";
    }
    if (status === 404) {
      return "linkedin_recipient_not_found";
    }
    if (status === 422) {
      return "linkedin_invalid_request";
    }
    return "linkedin_send_failed";
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
