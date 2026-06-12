import { EvidenceLedgerService } from "../../observability/evidence-ledger.service";
import { Tool, ToolContext, ToolResult } from "./tool.interface";
import { fetchWithRetry, withCircuitBreaker } from "../../common/http-retry.util";
import {
  buildUnsubscribeMailto,
  buildUnsubscribeUrl,
} from "../../outreach/unsubscribe-token.util";

/**
 * Build CAN-SPAM / RFC 8058 List-Unsubscribe headers for outbound. Audit
 * P0 #3. Returns `null` when orgId is missing (system-level / mock sends).
 */
function buildUnsubscribeHeaders(orgId: string | undefined, recipient: string) {
  if (!orgId || !recipient) return null;
  return {
    listUnsubscribe: `<mailto:${buildUnsubscribeMailto(orgId, recipient)}>, <${buildUnsubscribeUrl(orgId, recipient)}>`,
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
 * for live sends — see send-outreach.worker). Detects whether the body is
 * HTML by looking for any common HTML tag; falls back to plain text.
 */
function appendComplianceFooter(
  body: string,
  orgId: string | undefined,
  recipient: string,
  senderOrg: ToolContext["senderOrg"],
): string {
  if (!senderOrg || !senderOrg.physicalAddress || !orgId) return body;

  const sender = senderOrg.senderName ?? senderOrg.orgName;
  const addressLine = [senderOrg.physicalAddress, senderOrg.country].filter(Boolean).join(", ");
  const unsubUrl = buildUnsubscribeUrl(orgId, recipient);

  const looksLikeHtml = /<\/?(html|body|p|div|br|a|span|table|h[1-6])\b/i.test(body);
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

export class SendEmailTool implements Tool {
  name = "send_email";
  description = "Send an email. Uses Microsoft Graph API when Outlook credentials are available, otherwise operates in mock mode.";
  parameters = {
    to: { type: "string", description: "Recipient email address", required: true },
    subject: { type: "string", description: "Email subject line", required: true },
    body: { type: "string", description: "Email body (plain text or HTML)", required: true },
    from: { type: "string", description: "Sender email address (optional, uses default)", required: false },
  };

  constructor(private readonly evidenceLedger?: EvidenceLedgerService) {}

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const to = params.to as string;
    const subject = params.subject as string;
    const body = params.body as string;

    if (!to || !subject || !body) {
      return { success: false, data: null, error: "to, subject, and body are required" };
    }

    // Check for Outlook/Gmail integration credentials
    const outlookCreds = context.integrations.get("outlook");
    const gmailCreds = context.integrations.get("gmail");

    const unsubscribeHeaders = buildUnsubscribeHeaders(context.orgId, to);
    // CAN-SPAM §7704(a)(5): when the worker passed senderOrg, append a
    // user-visible compliance footer (postal address + unsubscribe link) to
    // the body before dispatch. Mock and direct-executor paths leave this
    // alone — they never produce live sends.
    const composedBody = appendComplianceFooter(body, context.orgId, to, context.senderOrg);

    if (outlookCreds?.accessToken && !outlookCreds.accessToken.startsWith("mock_")) {
      const result = await this.sendViaGraph(to, subject, composedBody, outlookCreds.accessToken, unsubscribeHeaders);
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
      const result = await this.sendViaGmail(to, subject, composedBody, gmailCreds.accessToken, unsubscribeHeaders);
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
    return this.mockSend(to, subject, body, context);
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
  ): Promise<ToolResult> {
    try {
      const message: Record<string, unknown> = {
        subject,
        body: { contentType: "HTML", content: body },
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
          { provider: "graph" },
        ),
      );

      if (!response.ok) {
        const errorData = await response.text();
        throw new Error(`Graph API error ${response.status}: ${errorData}`);
      }

      return {
        success: true,
        data: { sent: true, provider: "outlook", to, subject },
      };
    } catch (error) {
      return {
        success: false,
        data: { sent: false, provider: "outlook" },
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
  ): Promise<ToolResult> {
    try {
      const headers: string[] = [
        `To: ${to}`,
        `Subject: ${subject}`,
        "Content-Type: text/html; charset=utf-8",
      ];
      if (unsubscribe) {
        headers.push(`List-Unsubscribe: ${unsubscribe.listUnsubscribe}`);
        headers.push(`List-Unsubscribe-Post: ${unsubscribe.listUnsubscribePost}`);
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
            body: JSON.stringify({ raw }),
          },
          { provider: "gmail" },
        ),
      );

      if (!response.ok) {
        throw new Error(`Gmail API error ${response.status}`);
      }

      const data = (await response.json()) as { id: string };
      return {
        success: true,
        data: { sent: true, provider: "gmail", messageId: data.id, to, subject },
      };
    } catch (error) {
      return {
        success: false,
        data: { sent: false, provider: "gmail" },
        error: error instanceof Error ? error.message : "Failed to send email via Gmail API",
      };
    }
  }

  private mockSend(to: string, subject: string, body: string, context: ToolContext): ToolResult {
    return {
      success: true,
      data: {
        sent: false,
        mock: true,
        provider: "mock",
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
