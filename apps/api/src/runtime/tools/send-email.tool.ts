import { EvidenceLedgerService } from "../../observability/evidence-ledger.service";
import { Tool, ToolContext, ToolResult } from "./tool.interface";
import {
  CircuitOpenError,
  RateLimitedError,
  fetchWithRetry,
  withCircuitBreaker,
} from "../../common/http-retry.util";
import { buildUnsubscribeUrl } from "../../outreach/unsubscribe-token.util";
import {
  inferEmailBodyContentType,
  isEmailBodyContentType,
  type EmailBodyContentType,
} from "./email-body-content-type";

/**
 * Build CAN-SPAM / RFC 8058 List-Unsubscribe headers for outbound. Audit
 * P0 #3. Returns `null` when orgId is missing (system-level / mock sends).
 */
function buildUnsubscribeHeaders(orgId: string | undefined, recipient: string) {
  if (!orgId || !recipient) return null;
  return {
    listUnsubscribe: `<${buildUnsubscribeUrl(orgId, recipient)}>`,
    listUnsubscribePost: "List-Unsubscribe=One-Click",
  };
}

/**
 * Append a CAN-SPAM §7704(a)(5)-compliant footer to the email body. The
 * physical postal address and a visible Unsubscribe link satisfy the
 * "must be visible to the recipient" half of CAN-SPAM (the headers cover
 * the machine-readable RFC 8058 half).
 *
 * No-op when senderOrg is undefined (direct-executor path) or when the
 * physical address is null (worker enforces the gate before reaching here
 * for live sends — see send-outreach.worker). The caller passes the resolved
 * body format so the footer and provider MIME type can never disagree.
 */
function appendComplianceFooter(
  body: string,
  orgId: string | undefined,
  recipient: string,
  senderOrg: ToolContext["senderOrg"],
  contentType: EmailBodyContentType,
): string {
  if (!senderOrg || !senderOrg.physicalAddress || !orgId) return body;

  const sender = senderOrg.senderName ?? senderOrg.orgName;
  const addressLine = [senderOrg.physicalAddress, senderOrg.country].filter(Boolean).join(", ");
  const unsubUrl = buildUnsubscribeUrl(orgId, recipient);

  const looksLikeHtml = contentType === "html";
  if (looksLikeHtml) {
    const footer =
      `<hr style="margin-top:24px;border:none;border-top:1px solid #ddd"/>` +
      `<p style="font-size:12px;color:#666;line-height:1.5">` +
      `${escapeHtml(sender)}<br/>` +
      `${escapeHtml(addressLine)}<br/>` +
      `<a href="${escapeHtml(unsubUrl)}">Unsubscribe</a>` +
      `</p>`;
    return `${body}\n${footer}`;
  }
  return `${body}\n\n--\n${sender}\n${addressLine}\nUnsubscribe: ${unsubUrl}`;
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Truthful outcome of one email-tool invocation at the provider boundary.
 *
 * Gmail `messages.send` and Microsoft Graph `sendMail` do not expose a
 * caller-supplied idempotency key. Once a POST may have left this process, a
 * missing response is therefore not safely retryable: the provider may have
 * accepted the message. Callers must persist DELIVERY_UNKNOWN and reconcile
 * the provider manually instead of dispatching the artifact again.
 */
export const EMAIL_DISPATCH_OUTCOME = {
  NOT_ATTEMPTED: "NOT_ATTEMPTED",
  CONFIRMED_NOT_SENT: "CONFIRMED_NOT_SENT",
  CONFIRMED_SENT: "CONFIRMED_SENT",
  DELIVERY_UNKNOWN: "DELIVERY_UNKNOWN",
} as const;

export type EmailDispatchOutcome =
  (typeof EMAIL_DISPATCH_OUTCOME)[keyof typeof EMAIL_DISPATCH_OUTCOME];

export function getEmailDispatchOutcome(
  result: ToolResult,
): EmailDispatchOutcome | null {
  if (!result.data || typeof result.data !== "object" || Array.isArray(result.data)) {
    return null;
  }
  const outcome = (result.data as Record<string, unknown>).dispatchOutcome;
  return Object.values(EMAIL_DISPATCH_OUTCOME).includes(
    outcome as EmailDispatchOutcome,
  )
    ? (outcome as EmailDispatchOutcome)
    : null;
}

export class SendEmailTool implements Tool {
  name = "send_email";
  description =
    "Send an email through a connected Outlook or Gmail mailbox; otherwise operate in mock mode.";
  parameters = {
    to: { type: "string", description: "Recipient email address", required: true },
    subject: { type: "string", description: "Email subject line", required: true },
    body: { type: "string", description: "Email body (plain text or HTML)", required: true },
    bodyContentType: {
      type: "string",
      description: "Optional body format: text or html (inferred for legacy callers)",
      required: false,
    },
    from: { type: "string", description: "Sender email address (optional, uses default)", required: false },
    provider: {
      type: "string",
      description: "Preferred provider for a provider-bound reply (gmail or outlook)",
      required: false,
    },
    threadId: {
      type: "string",
      description: "Provider thread id for an in-thread reply",
      required: false,
    },
    inReplyTo: {
      type: "string",
      description: "RFC Message-ID being replied to",
      required: false,
    },
  };

  constructor(private readonly evidenceLedger?: EvidenceLedgerService) {}

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const to = params.to as string;
    const subject = params.subject as string;
    const body = params.body as string;
    const bodyContentType = params.bodyContentType;
    const preferredProvider =
      params.provider === "gmail" || params.provider === "outlook"
        ? params.provider
        : undefined;
    const threadId =
      typeof params.threadId === "string" && params.threadId.trim().length > 0
        ? params.threadId.trim()
        : undefined;
    const inReplyTo =
      typeof params.inReplyTo === "string" && params.inReplyTo.trim().length > 0
        ? params.inReplyTo.trim()
        : undefined;

    if (!to || !subject || !body) {
      return {
        success: false,
        data: {
          sent: false,
          dispatchOutcome: EMAIL_DISPATCH_OUTCOME.NOT_ATTEMPTED,
        },
        error: "to, subject, and body are required",
      };
    }
    if (bodyContentType !== undefined && !isEmailBodyContentType(bodyContentType)) {
      return {
        success: false,
        data: {
          sent: false,
          dispatchOutcome: EMAIL_DISPATCH_OUTCOME.NOT_ATTEMPTED,
        },
        error: "bodyContentType must be text or html",
      };
    }
    const resolvedBodyContentType = isEmailBodyContentType(bodyContentType)
      ? bodyContentType
      : inferEmailBodyContentType(body);
    if (
      hasHeaderBreak(to) ||
      hasHeaderBreak(subject) ||
      (inReplyTo !== undefined && hasHeaderBreak(inReplyTo))
    ) {
      return {
        success: false,
        data: {
          sent: false,
          dispatchOutcome: EMAIL_DISPATCH_OUTCOME.NOT_ATTEMPTED,
        },
        error: "email headers contain invalid line breaks",
      };
    }

    // Check for Outlook/Gmail integration credentials
    const outlookCreds = context.integrations.get("outlook");
    const gmailCreds = context.integrations.get("gmail");

    const unsubscribeHeaders = buildUnsubscribeHeaders(context.orgId, to);
    // CAN-SPAM §7704(a)(5): when the worker passed senderOrg, append a
    // user-visible compliance footer (postal address + unsubscribe link) to
    // the body before dispatch. Mock and direct-executor paths leave this
    // alone — they never produce live sends.
    const composedBody = appendComplianceFooter(
      body,
      context.orgId,
      to,
      context.senderOrg,
      resolvedBodyContentType,
    );

    if (
      preferredProvider !== "gmail" &&
      !threadId &&
      outlookCreds?.accessToken &&
      !outlookCreds.accessToken.startsWith("mock_")
    ) {
      const result = await this.sendViaGraph(
        to,
        subject,
        composedBody,
        outlookCreds.accessToken,
        unsubscribeHeaders,
        resolvedBodyContentType,
      );
      if (result.success) {
        this.emitMessageSent(context, {
          to,
          subject,
          provider: "outlook",
          messageId: extractMessageId(result),
        });
      }
      return result;
    }

    if (gmailCreds?.accessToken && !gmailCreds.accessToken.startsWith("mock_")) {
      const result = await this.sendViaGmail(
        to,
        subject,
        composedBody,
        gmailCreds.accessToken,
        unsubscribeHeaders,
        { threadId, inReplyTo },
        resolvedBodyContentType,
      );
      if (result.success) {
        this.emitMessageSent(context, {
          to,
          subject,
          provider: "gmail",
          messageId: extractMessageId(result),
        });
      }
      return result;
    }

    // Mock mode — no real send occurred, no evidence emitted.
    return this.mockSend(to, subject, body);
  }

  /**
   * Fire-and-forget append to the evidence ledger. Only invoked on the
   * real-provider success path — mock sends do not produce evidence because
   * no message actually left the building.
   */
  private emitMessageSent(
    context: ToolContext,
    payload: {
      readonly to: string;
      readonly subject: string;
      readonly provider: "outlook" | "gmail";
      readonly messageId: string | null;
    },
  ): void {
    if (!this.evidenceLedger) return;
    const refId = payload.messageId ?? `${payload.provider}:${Date.now()}`;
    void this.evidenceLedger.messageSent({
      orgId: context.orgId,
      runId: context.runId ?? null,
      artifactId: null,
      channel: "EMAIL",
      recipientRef: payload.to,
      subject: payload.subject,
      sendReceiptId: payload.messageId ?? null,
      provider: payload.provider,
      refType: "outreach_tool_call",
      refId,
    });
  }

  private async sendViaGraph(
    to: string,
    subject: string,
    body: string,
    accessToken: string,
    unsubscribe: { listUnsubscribe: string; listUnsubscribePost: string } | null,
    bodyContentType: EmailBodyContentType,
  ): Promise<ToolResult> {
    try {
      const message: Record<string, unknown> = {
        subject,
        body: {
          contentType: bodyContentType === "text" ? "Text" : "HTML",
          content: body,
        },
        toRecipients: [{ emailAddress: { address: to } }],
      };
      if (unsubscribe) {
        message.internetMessageHeaders = [
          { name: "List-Unsubscribe", value: unsubscribe.listUnsubscribe },
          { name: "List-Unsubscribe-Post", value: unsubscribe.listUnsubscribePost },
        ];
      }
      const response = await withCircuitBreaker("graph", () =>
        fetchWithRetry(
          "https://graph.microsoft.com/v1.0/me/sendMail",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              message,
              saveToSentItems: true,
            }),
          },
          // Graph sendMail has no caller idempotency key. Never retry the
          // POST inside the tool after a transport failure.
          { provider: "graph", maxAttempts: 1 },
        ),
      );

      if (!response.ok) {
        const errorData = await response.text().catch(() => "<response body unavailable>");
        return {
          success: false,
          data: {
            sent: false,
            provider: "outlook",
            dispatchOutcome: EMAIL_DISPATCH_OUTCOME.CONFIRMED_NOT_SENT,
          },
          error: `Graph API error ${response.status}: ${errorData}`,
        };
      }

      return {
        success: true,
        data: {
          sent: true,
          provider: "outlook",
          dispatchOutcome: EMAIL_DISPATCH_OUTCOME.CONFIRMED_SENT,
          to,
          subject,
        },
      };
    } catch (error) {
      return {
        success: false,
        data: {
          sent: false,
          provider: "outlook",
          dispatchOutcome: classifyProviderError(error),
        },
        error: error instanceof Error ? error.message : "Failed to send email via Graph API",
      };
    }
  }

  private async sendViaGmail(
    to: string,
    subject: string,
    body: string,
    accessToken: string,
    unsubscribe: { listUnsubscribe: string; listUnsubscribePost: string } | null,
    reply: { threadId?: string; inReplyTo?: string },
    bodyContentType: EmailBodyContentType,
  ): Promise<ToolResult> {
    try {
      const headers: string[] = [
        `To: ${to}`,
        `Subject: ${subject}`,
        `Content-Type: ${bodyContentType === "text" ? "text/plain" : "text/html"}; charset=utf-8`,
      ];
      if (unsubscribe) {
        headers.push(`List-Unsubscribe: ${unsubscribe.listUnsubscribe}`);
        headers.push(`List-Unsubscribe-Post: ${unsubscribe.listUnsubscribePost}`);
      }
      if (reply.inReplyTo) {
        headers.push(`In-Reply-To: ${reply.inReplyTo}`);
        headers.push(`References: ${reply.inReplyTo}`);
      }
      const raw = Buffer.from(`${headers.join("\r\n")}\r\n\r\n${body}`)
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");

      const response = await withCircuitBreaker("gmail", () =>
        fetchWithRetry(
          "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              raw,
              ...(reply.threadId ? { threadId: reply.threadId } : {}),
            }),
          },
          // These provider POSTs have no idempotency key. A network retry
          // after response loss could send twice, so the send tool makes one
          // wire attempt and lets the worker distinguish a provider response
          // from an ambiguous transport failure.
          { provider: "gmail", maxAttempts: 1 },
        ),
      );

      if (!response.ok) {
        return {
          success: false,
          data: {
            sent: false,
            provider: "gmail",
            dispatchOutcome: EMAIL_DISPATCH_OUTCOME.CONFIRMED_NOT_SENT,
          },
          error: `Gmail API error ${response.status}`,
        };
      }

      const data = (await response.json()) as { id?: unknown; threadId?: unknown };
      if (typeof data.id !== "string" || data.id.length === 0) {
        return {
          success: false,
          data: {
            sent: false,
            provider: "gmail",
            dispatchOutcome: EMAIL_DISPATCH_OUTCOME.DELIVERY_UNKNOWN,
          },
          error: "Gmail accepted the request but returned no message id",
        };
      }
      return {
        success: true,
        data: {
          sent: true,
          provider: "gmail",
          messageId: data.id,
          threadId:
            typeof data.threadId === "string"
              ? data.threadId
              : reply.threadId ?? null,
          dispatchOutcome: EMAIL_DISPATCH_OUTCOME.CONFIRMED_SENT,
          to,
          subject,
        },
      };
    } catch (error) {
      return {
        success: false,
        data: {
          sent: false,
          provider: "gmail",
          dispatchOutcome: classifyProviderError(error),
        },
        error: error instanceof Error ? error.message : "Failed to send email via Gmail API",
      };
    }
  }

  private mockSend(to: string, subject: string, body: string): ToolResult {
    return {
      success: true,
      data: {
        sent: false,
        mock: true,
        provider: "mock",
        dispatchOutcome: EMAIL_DISPATCH_OUTCOME.NOT_ATTEMPTED,
        messageId: `mock_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        to,
        subject,
        body,
        note: "Email not actually sent - no real email integration credentials configured. This is a preview of what would be sent.",
      },
    };
  }
}

/**
 * Circuit-open means the provider callback was never invoked. A received
 * 429/503 response (represented by RateLimitedError.lastStatus) also proves
 * this attempt was rejected. Every other thrown transport outcome is
 * ambiguous once fetch was invoked and must not be retried automatically.
 */
function classifyProviderError(error: unknown): EmailDispatchOutcome {
  if (error instanceof CircuitOpenError) {
    return EMAIL_DISPATCH_OUTCOME.NOT_ATTEMPTED;
  }
  if (error instanceof RateLimitedError && error.lastStatus !== null) {
    return EMAIL_DISPATCH_OUTCOME.CONFIRMED_NOT_SENT;
  }
  return EMAIL_DISPATCH_OUTCOME.DELIVERY_UNKNOWN;
}

function hasHeaderBreak(value: string): boolean {
  return value.includes("\r") || value.includes("\n");
}

/**
 * True when a send-tool result reports MOCK mode — i.e. no real provider call
 * happened and the receipt is synthetic. Every send tool stamps its result
 * data with the provider it actually used (`provider: "outlook" | "gmail" |
 * "linkedin" | "mock"`) and mock branches additionally set `mock: true`, so
 * consumers that REQUIRE a live send (SendOutreachWorker for allowlisted
 * orgs — GL2) can detect a silent mock fallback and refuse to record SENT.
 *
 * Conservative on malformed data: a result without an object payload is NOT
 * treated as mock (the worker's separate success/receipt checks own that).
 */
export function isMockModeResult(result: ToolResult): boolean {
  if (!result.data || typeof result.data !== "object" || Array.isArray(result.data)) {
    return false;
  }
  const data = result.data as Record<string, unknown>;
  return data.mock === true || data.provider === "mock";
}

/**
 * Pulls a provider message id off a successful send result. Outlook's
 * sendMail endpoint returns 202 with no body, so the id may be absent;
 * Gmail returns `{id: string}`. Returns null when no id is recoverable.
 */
function extractMessageId(result: ToolResult): string | null {
  const data = result.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const maybeId = (data as Record<string, unknown>).messageId;
    if (typeof maybeId === "string" && maybeId.length > 0) return maybeId;
  }
  return null;
}
