import { EvidenceLedgerService } from "../../observability/evidence-ledger.service";
import { Tool, ToolContext, ToolResult } from "./tool.interface";
import { fetchWithRetry, withCircuitBreaker } from "../../common/http-retry.util";
import { randomUUID } from "crypto";
import { ConfigService } from "@nestjs/config";
import { Logger } from "@nestjs/common";
import { signToken } from "../../suppression/unsubscribe-token.util";

export class SendEmailTool implements Tool {
  private readonly logger = new Logger(SendEmailTool.name);
  private warnedMissingPublicBaseUrl = false;
  name = "send_email";
  description = "Send an email. Uses Microsoft Graph API when Outlook credentials are available, otherwise operates in mock mode.";
  parameters = {
    to: { type: "string", description: "Recipient email address", required: true },
    subject: { type: "string", description: "Email subject line", required: true },
    body: { type: "string", description: "Email body (plain text or HTML)", required: true },
    from: { type: "string", description: "Sender email address (optional, uses default)", required: false },
    cc: { type: "string", description: "CC recipients (comma-separated)", required: false },
    bcc: { type: "string", description: "BCC recipients (comma-separated)", required: false },
    replyTo: { type: "string", description: "Reply-To email address", required: false },
    inReplyTo: { type: "string", description: "RFC 5322 In-Reply-To Message-ID", required: false },
    references: { type: "array", description: "RFC 5322 References Message-ID list", required: false },
    threadId: { type: "string", description: "Provider thread id (Gmail threadId)", required: false },
    artifactId: { type: "string", description: "Optional: OutreachArtifact id for unsubscribe headers", required: false },
  };

  constructor(
    private readonly evidenceLedger?: EvidenceLedgerService,
    private readonly config?: ConfigService,
  ) {}

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const to = params.to as string;
    const subject = params.subject as string;
    const body = params.body as string;
    const from = typeof params.from === "string" ? params.from : undefined;
    const cc = typeof params.cc === "string" ? params.cc : undefined;
    const bcc = typeof params.bcc === "string" ? params.bcc : undefined;
    const replyTo = typeof params.replyTo === "string" ? params.replyTo : undefined;
    const inReplyTo = typeof params.inReplyTo === "string" ? params.inReplyTo : undefined;
    const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
    const references = parseReferencesParam(params.references);
    const artifactId = typeof params.artifactId === "string" ? params.artifactId : undefined;

    if (!to || !subject || !body) {
      return { success: false, data: null, error: "to, subject, and body are required" };
    }

    const unsubscribeToken = this.signUnsubscribeToken({
      orgId: context.orgId,
      recipientEmail: to,
      artifactId,
    });

    // Check for Outlook/Gmail integration credentials
    const outlookCreds = context.integrations.get("outlook");
    const gmailCreds = context.integrations.get("gmail");

    if (outlookCreds?.accessToken && !outlookCreds.accessToken.startsWith("mock_")) {
      const senderEmailForDomain =
        from ??
        (typeof outlookCreds.accountEmail === "string" ? (outlookCreds.accountEmail as string) : undefined);
      const unsubscribeHeaders = unsubscribeToken
        ? this.buildListUnsubscribeHeaders(unsubscribeToken, senderEmailForDomain)
        : null;
      const result = await this.sendViaGraph(
        to,
        subject,
        body,
        outlookCreds.accessToken,
        unsubscribeHeaders ?? undefined,
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
      const fromEmail = from ?? (gmailCreds.accountEmail as string | undefined);
      const messageId = ensureMessageIdHeader(fromEmail);
      const unsubscribeHeaders = unsubscribeToken
        ? this.buildListUnsubscribeHeaders(unsubscribeToken, fromEmail)
        : null;
      const result = await this.sendViaGmail(
        {
          to,
          subject,
          bodyText: body,
          from: fromEmail,
          cc,
          bcc,
          replyTo,
          inReplyTo,
          references,
          threadId,
          rfcMessageId: messageId,
          listUnsubscribe: unsubscribeHeaders ?? undefined,
        },
        gmailCreds.accessToken,
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
    const mockFrom =
      from ??
      (gmailCreds?.accountEmail as string | undefined) ??
      (outlookCreds?.accountEmail as string | undefined);
    const rfcMessageId = ensureMessageIdHeader(mockFrom);
    return this.mockSend(
      { to, subject, bodyText: body, from: mockFrom, cc, bcc, replyTo, inReplyTo, references, threadId, rfcMessageId },
      context,
    );
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

  private signUnsubscribeToken(input: {
    readonly orgId: string;
    readonly recipientEmail: string;
    readonly artifactId?: string;
  }): string | null {
    if (!input.artifactId) return null;
    try {
      return signToken({
        orgId: input.orgId,
        recipientEmail: input.recipientEmail,
        artifactId: input.artifactId,
      });
    } catch (err) {
      this.logger.warn(
        `Unsubscribe token signing failed (OUTREACH_UNSUBSCRIBE_SECRET missing?): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  private resolvePublicBaseUrl(): string {
    const configured =
      this.config?.get<string>("APEX_PUBLIC_BASE_URL") ??
      process.env.APEX_PUBLIC_BASE_URL ??
      "";
    if (!configured) {
      if (!this.warnedMissingPublicBaseUrl) {
        this.warnedMissingPublicBaseUrl = true;
        this.logger.warn(
          "APEX_PUBLIC_BASE_URL unset; defaulting to https://api.apex.local",
        );
      }
      return "https://api.apex.local";
    }
    return configured;
  }

  private buildListUnsubscribeHeaders(
    token: string,
    senderEmailForDomain: string | undefined,
  ): ListUnsubscribeHeaders {
    const baseUrl = normalizeBaseUrl(this.resolvePublicBaseUrl());
    const senderDomain = extractSenderDomain(senderEmailForDomain) ?? "send.apex";
    return {
      listUnsubscribe: `<${baseUrl}/unsubscribe/${token}>, <mailto:unsubscribe+${token}@${senderDomain}>`,
      listUnsubscribePost: "List-Unsubscribe=One-Click",
    };
  }

  private async sendViaGraph(
    to: string,
    subject: string,
    body: string,
    accessToken: string,
    unsubscribeHeaders?: ListUnsubscribeHeaders,
  ): Promise<ToolResult> {
    try {
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
              message: {
                subject,
                body: { contentType: "HTML", content: body },
                toRecipients: [{ emailAddress: { address: to } }],
                ...(unsubscribeHeaders
                  ? {
                      internetMessageHeaders: [
                        { name: "List-Unsubscribe", value: unsubscribeHeaders.listUnsubscribe },
                        { name: "List-Unsubscribe-Post", value: unsubscribeHeaders.listUnsubscribePost },
                      ],
                    }
                  : {}),
              },
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
        data: { sent: false },
        error: error instanceof Error ? error.message : "Failed to send email via Graph API",
      };
    }
  }

  private async sendViaGmail(
    input: {
      readonly to: string;
      readonly subject: string;
      readonly bodyText: string;
      readonly from?: string;
      readonly cc?: string;
      readonly bcc?: string;
      readonly replyTo?: string;
      readonly inReplyTo?: string;
      readonly references: string[];
      readonly threadId?: string;
      readonly rfcMessageId: string;
      readonly listUnsubscribe?: {
        readonly listUnsubscribe: string;
        readonly listUnsubscribePost: string;
      };
    },
    accessToken: string,
  ): Promise<ToolResult> {
    try {
      const mimeLines: string[] = [];
      mimeLines.push(`Message-ID: ${input.rfcMessageId}`);
      if (input.from) mimeLines.push(`From: ${input.from}`);
      mimeLines.push(`To: ${input.to}`);
      if (input.cc) mimeLines.push(`Cc: ${input.cc}`);
      if (input.bcc) mimeLines.push(`Bcc: ${input.bcc}`);
      if (input.replyTo) mimeLines.push(`Reply-To: ${input.replyTo}`);
      if (input.inReplyTo) mimeLines.push(`In-Reply-To: ${normalizeMessageId(input.inReplyTo)}`);
      const refs =
        input.references.length > 0
          ? input.references
          : input.inReplyTo
            ? [normalizeMessageId(input.inReplyTo)]
            : [];
      if (refs.length > 0) mimeLines.push(`References: ${refs.join(" ")}`);
      if (input.listUnsubscribe) {
        mimeLines.push(`List-Unsubscribe: ${input.listUnsubscribe.listUnsubscribe}`);
        mimeLines.push(`List-Unsubscribe-Post: ${input.listUnsubscribe.listUnsubscribePost}`);
      }
      mimeLines.push(`Subject: ${input.subject}`);
      mimeLines.push("MIME-Version: 1.0");
      mimeLines.push("Content-Type: text/html; charset=utf-8");
      mimeLines.push("");
      mimeLines.push(input.bodyText);

      const raw = Buffer.from(mimeLines.join("\r\n"))
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
              ...(input.threadId ? { threadId: input.threadId } : {}),
            }),
          },
          { provider: "gmail" },
        ),
      );

      if (!response.ok) {
        throw new Error(`Gmail API error ${response.status}`);
      }

      const data = (await response.json()) as { id: string; threadId?: string };
      return {
        success: true,
        data: {
          sent: true,
          provider: "gmail",
          messageId: data.id,
          threadId: data.threadId ?? null,
          rfcMessageId: input.rfcMessageId,
          inReplyTo: input.inReplyTo ? normalizeMessageId(input.inReplyTo) : null,
          references: refs,
          to: input.to,
          subject: input.subject,
        },
      };
    } catch (error) {
      return {
        success: false,
        data: { sent: false },
        error: error instanceof Error ? error.message : "Failed to send email via Gmail API",
      };
    }
  }

  private mockSend(
    input: {
      readonly to: string;
      readonly subject: string;
      readonly bodyText: string;
      readonly from?: string;
      readonly cc?: string;
      readonly bcc?: string;
      readonly replyTo?: string;
      readonly inReplyTo?: string;
      readonly references: string[];
      readonly threadId?: string;
      readonly rfcMessageId: string;
    },
    context: ToolContext,
  ): ToolResult {
    const refs =
      input.references.length > 0
        ? input.references
        : input.inReplyTo
          ? [normalizeMessageId(input.inReplyTo)]
          : [];
    return {
      success: true,
      data: {
        sent: false,
        mock: true,
        provider: "mock",
        messageId: `mock_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        threadId: input.threadId ?? `mock_thread_${Date.now()}`,
        rfcMessageId: input.rfcMessageId,
        inReplyTo: input.inReplyTo ? normalizeMessageId(input.inReplyTo) : null,
        references: refs,
        to: input.to,
        subject: input.subject,
        body: input.bodyText,
        note: "Email not actually sent - no real email integration credentials configured. This is a preview of what would be sent.",
      },
    };
  }
}

type ListUnsubscribeHeaders = {
  readonly listUnsubscribe: string;
  readonly listUnsubscribePost: string;
};

function normalizeBaseUrl(input: string): string {
  return input.replace(/\/+$/, "");
}

function extractSenderDomain(raw: string | undefined): string | null {
  if (!raw) return null;
  const match = raw.match(/<([^>]+)>/);
  const email = (match?.[1] ?? raw).trim();
  return extractDomain(email)?.toLowerCase() ?? null;
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

function ensureMessageIdHeader(fromEmail: string | undefined): string {
  const domain = extractDomain(fromEmail) ?? "send.apex";
  return `<${randomUUID()}@${domain}>`;
}

function extractDomain(email: string | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at === -1 || at === email.length - 1) return null;
  return email.slice(at + 1).trim() || null;
}

function normalizeMessageId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith("<") && trimmed.endsWith(">")) return trimmed;
  return `<${trimmed.replace(/^<|>$/g, "")}>`;
}

function parseReferencesParam(raw: unknown): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw
      .filter((v): v is string => typeof v === "string")
      .map((v) => v.trim())
      .filter(Boolean)
      .map(normalizeMessageId);
  }
  if (typeof raw === "string") {
    return raw
      .split(/\s+/)
      .map((v) => v.trim())
      .filter(Boolean)
      .map(normalizeMessageId);
  }
  return [];
}
