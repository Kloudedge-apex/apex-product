import { Logger } from "@nestjs/common";
import { EvidenceLedgerService } from "../../observability/evidence-ledger.service";
import { LinkedInService } from "../../integrations/linkedin/linkedin.service";
import { Tool, ToolContext, ToolResult } from "./tool.interface";

const MAX_BODY_LENGTH = 2_000;

/**
 * Agent-callable tool for delivering a LinkedIn message to a connected
 * prospect.
 *
 * The actual transport is provided by {@link LinkedInService}, which is a thin
 * wrapper over LinkedIn's gated `/v2/messages` endpoint. See that file for the
 * (substantial) caveats about LinkedIn's restrictive scopes. The contract
 * here:
 *   - Mock receipt is returned when no LinkedInService is injected OR the org
 *     has no live LinkedIn credentials. The mock branch mirrors send_email's
 *     behavior so dry-runs and credential-less local dev still surface a
 *     reviewable payload.
 *   - Real-credentials path is invoked when the worker has loaded live
 *     LinkedIn credentials into `context.integrations` (see
 *     SendOutreachWorker.loadIntegrations).
 *   - On any non-retryable LinkedIn error (most commonly 401/403 because the
 *     OAuth scopes don't permit messaging), the tool returns success=false
 *     with a stable `error` code. It does NOT pretend the send happened.
 *   - Evidence is emitted only on real-send success — never on mock receipts
 *     or failure paths.
 *
 * SideEffectPolicy: registered as EXTERNAL_WRITE in `side-effect.ts`. The
 * executor's dry-run path captures the artifact before this tool is invoked,
 * so reaching `execute()` already implies "execute" mode.
 */
export class LinkedInSendMessageTool implements Tool {
  private readonly logger = new Logger(LinkedInSendMessageTool.name);
  name = "linkedin_send_message";
  description =
    "Send a personalized LinkedIn message to a connected prospect. Requires the recipient's LinkedIn member URN (urn:li:person:<id>). The message will be sent from the OAuth-connected LinkedIn account. SUBJECT to LinkedIn's strict rate limits - do not call more than a few times per agent run. If the recipient is not a 1st-degree connection, the send will fail.";
  parameters = {
    recipient_urn: {
      type: "string",
      description:
        "Recipient's LinkedIn member URN (e.g. 'urn:li:person:abc123'). Required.",
      required: true,
    },
    body: {
      type: "string",
      description: `Message body. Plain text. Max ${MAX_BODY_LENGTH} characters. Required.`,
      required: true,
    },
    integration_id: {
      type: "string",
      description:
        "Optional LinkedIn integration id to send from. Defaults to the org's primary LinkedIn integration when omitted.",
      required: false,
    },
  };

  constructor(
    private readonly linkedinService?: LinkedInService,
    private readonly evidenceLedger?: EvidenceLedgerService,
  ) {}

  async execute(
    params: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    const recipientUrn = params.recipient_urn;
    const body = params.body;
    const integrationIdParam = params.integration_id;

    if (typeof recipientUrn !== "string" || recipientUrn.length === 0) {
      return {
        success: false,
        data: null,
        error: "recipient_urn is required and must be a string",
      };
    }
    if (typeof body !== "string" || body.length === 0) {
      return {
        success: false,
        data: null,
        error: "body is required and must be a string",
      };
    }
    if (body.length > MAX_BODY_LENGTH) {
      return {
        success: false,
        data: null,
        error: `body exceeds max length of ${MAX_BODY_LENGTH} characters`,
      };
    }
    const integrationId =
      typeof integrationIdParam === "string" && integrationIdParam.length > 0
        ? integrationIdParam
        : null;

    // No live integration credentials AND no service injected => mock path.
    // This mirrors send-email's "mock when nothing real to call" semantics so
    // local dev / fixtures still surface a reviewable preview.
    const liveCreds = context.integrations.get("linkedin");
    const hasLiveCreds = !!(
      liveCreds?.accessToken && !liveCreds.accessToken.startsWith("mock_")
    );

    if (!this.linkedinService || !hasLiveCreds) {
      return this.mockSend(recipientUrn, body);
    }

    const sendResult = await this.linkedinService.sendMessage(
      context.orgId,
      integrationId,
      { recipientUrn, body },
    );

    if (!sendResult.ok) {
      return {
        success: false,
        data: {
          sent: false,
          provider: "linkedin",
          error: sendResult.error,
          status: sendResult.status,
          details: sendResult.details,
        },
        error: sendResult.error ?? "linkedin send failed",
      };
    }

    const messageId =
      sendResult.messageId ?? `linkedin:${Date.now()}`;
    await this.emitMessageSent(context, {
      recipientUrn,
      messageId,
    });

    return {
      success: true,
      data: {
        sent: true,
        provider: "linkedin",
        messageId,
        recipient_urn: recipientUrn,
      },
    };
  }

  /**
   * Best-effort evidence emission for a real LinkedIn send. Mirrors
   * send-email's `outreach_tool_call` reference convention so the audit ledger
   * can distinguish artifact-driven sends from in-loop agent tool calls.
   */
  private async emitMessageSent(
    context: ToolContext,
    payload: { readonly recipientUrn: string; readonly messageId: string },
  ): Promise<void> {
    if (!this.evidenceLedger) return;
    try {
      await this.evidenceLedger.messageSent({
        orgId: context.orgId,
        runId: context.runId ?? null,
        artifactId: null,
        channel: "LINKEDIN",
        recipientRef: payload.recipientUrn,
        sendReceiptId: payload.messageId,
        provider: "linkedin",
        refType: "outreach_tool_call",
        refId: payload.messageId,
      });
    } catch {
      this.logger.warn(
        "Evidence ledger append failed after a successful LinkedIn send",
      );
    }
  }

  private mockSend(recipientUrn: string, body: string): ToolResult {
    return {
      success: true,
      data: {
        sent: false,
        mock: true,
        provider: "linkedin",
        messageId: `mock_linkedin_${Date.now()}_${Math.random()
          .toString(36)
          .slice(2, 8)}`,
        would_send_to: recipientUrn,
        body,
        note: "LinkedIn message not actually sent - no real LinkedIn integration credentials configured. This is a preview of what would be sent.",
      },
    };
  }
}
