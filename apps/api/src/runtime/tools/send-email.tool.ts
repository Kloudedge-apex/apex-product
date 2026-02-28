import { Tool, ToolContext, ToolResult } from "./tool.interface";

export class SendEmailTool implements Tool {
  name = "send_email";
  description = "Send an email. Uses Microsoft Graph API when Outlook credentials are available, otherwise operates in mock mode.";
  parameters = {
    to: { type: "string", description: "Recipient email address", required: true },
    subject: { type: "string", description: "Email subject line", required: true },
    body: { type: "string", description: "Email body (plain text or HTML)", required: true },
    from: { type: "string", description: "Sender email address (optional, uses default)", required: false },
  };

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

    if (outlookCreds?.accessToken && !outlookCreds.accessToken.startsWith("mock_")) {
      return this.sendViaGraph(to, subject, body, outlookCreds.accessToken);
    }

    if (gmailCreds?.accessToken && !gmailCreds.accessToken.startsWith("mock_")) {
      return this.sendViaGmail(to, subject, body, gmailCreds.accessToken);
    }

    // Mock mode
    return this.mockSend(to, subject, body, context);
  }

  private async sendViaGraph(to: string, subject: string, body: string, accessToken: string): Promise<ToolResult> {
    try {
      const response = await fetch("https://graph.microsoft.com/v1.0/me/sendMail", {
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
          },
          saveToSentItems: true,
        }),
      });

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

  private async sendViaGmail(to: string, subject: string, body: string, accessToken: string): Promise<ToolResult> {
    try {
      const raw = Buffer.from(
        `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${body}`,
      )
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");

      const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ raw }),
      });

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
        data: { sent: false },
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
