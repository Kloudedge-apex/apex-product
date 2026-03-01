import { Injectable, UnauthorizedException, BadRequestException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { google, gmail_v1 } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import { PrismaService } from "../../prisma/prisma.service";
import { encrypt, decrypt } from "../crypto.util";

interface GmailTokens {
  access_token: string;
  refresh_token: string;
  expiry_date: number;
  token_type: string;
  scope: string;
}

interface SendEmailOptions {
  to: string;
  subject: string;
  body: string;
  html?: string;
  cc?: string;
  bcc?: string;
  replyTo?: string;
  inReplyTo?: string;
  threadId?: string;
}

interface GmailMessage {
  id: string;
  threadId: string;
  snippet: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  labelIds: string[];
  body?: string;
}

interface GmailThread {
  id: string;
  snippet: string;
  messages: GmailMessage[];
}

const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.modify",
];

@Injectable()
export class GmailService {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly redirectUri: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    this.clientId = this.config.get<string>("GOOGLE_CLIENT_ID", "");
    this.clientSecret = this.config.get<string>("GOOGLE_CLIENT_SECRET", "");
    this.redirectUri = this.config.get<string>(
      "GOOGLE_REDIRECT_URI",
      "http://localhost:4000/api/integrations/gmail/callback",
    );
  }

  getAuthUrl(orgId: string): string {
    const oauth2Client = this.createOAuth2Client();
    return oauth2Client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: GMAIL_SCOPES,
      state: orgId,
    });
  }

  async handleCallback(code: string, orgId: string): Promise<void> {
    const oauth2Client = this.createOAuth2Client();
    const { tokens } = await oauth2Client.getToken(code);

    if (!tokens.access_token || !tokens.refresh_token) {
      throw new BadRequestException("Failed to obtain tokens from Google");
    }

    const tokenData: GmailTokens = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expiry_date: tokens.expiry_date ?? Date.now() + 3600 * 1000,
      token_type: tokens.token_type ?? "Bearer",
      scope: tokens.scope ?? GMAIL_SCOPES.join(" "),
    };

    const encryptedCreds = encrypt(JSON.stringify(tokenData));

    await this.prisma.integration.upsert({
      where: { orgId_provider: { orgId, provider: "gmail" } },
      create: {
        orgId,
        provider: "gmail",
        credentials: {},
        encryptedCredentials: encryptedCreds,
        status: "CONNECTED",
        scopes: GMAIL_SCOPES,
      },
      update: {
        encryptedCredentials: encryptedCreds,
        credentials: {},
        status: "CONNECTED",
        scopes: GMAIL_SCOPES,
        lastSyncAt: new Date(),
      },
    });
  }

  async listMessages(
    orgId: string,
    options: { maxResults?: number; labelIds?: string[]; pageToken?: string } = {},
  ): Promise<{ messages: GmailMessage[]; nextPageToken?: string }> {
    const gmail = await this.getGmailClient(orgId);
    const { maxResults = 20, labelIds, pageToken } = options;

    const response = await gmail.users.messages.list({
      userId: "me",
      maxResults,
      labelIds,
      pageToken,
    });

    if (!response.data.messages) {
      return { messages: [] };
    }

    const messages = await Promise.all(
      response.data.messages.map((msg) => this.getMessage(orgId, msg.id!, gmail)),
    );

    return {
      messages,
      nextPageToken: response.data.nextPageToken ?? undefined,
    };
  }

  async getMessage(
    orgId: string,
    messageId: string,
    existingClient?: gmail_v1.Gmail,
  ): Promise<GmailMessage> {
    const gmail = existingClient ?? (await this.getGmailClient(orgId));

    const response = await gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "full",
    });

    const headers = response.data.payload?.headers ?? [];
    const getHeader = (name: string): string =>
      headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";

    let body = "";
    const payload = response.data.payload;
    if (payload?.body?.data) {
      body = Buffer.from(payload.body.data, "base64url").toString("utf-8");
    } else if (payload?.parts) {
      const textPart = payload.parts.find((p) => p.mimeType === "text/plain");
      const htmlPart = payload.parts.find((p) => p.mimeType === "text/html");
      const part = textPart ?? htmlPart;
      if (part?.body?.data) {
        body = Buffer.from(part.body.data, "base64url").toString("utf-8");
      }
    }

    return {
      id: response.data.id!,
      threadId: response.data.threadId!,
      snippet: response.data.snippet ?? "",
      from: getHeader("From"),
      to: getHeader("To"),
      subject: getHeader("Subject"),
      date: getHeader("Date"),
      labelIds: response.data.labelIds ?? [],
      body,
    };
  }

  async getThread(orgId: string, threadId: string): Promise<GmailThread> {
    const gmail = await this.getGmailClient(orgId);

    const response = await gmail.users.threads.get({
      userId: "me",
      id: threadId,
      format: "full",
    });

    const messages: GmailMessage[] = (response.data.messages ?? []).map((msg) => {
      const headers = msg.payload?.headers ?? [];
      const getHeader = (name: string): string =>
        headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";

      let body = "";
      if (msg.payload?.body?.data) {
        body = Buffer.from(msg.payload.body.data, "base64url").toString("utf-8");
      } else if (msg.payload?.parts) {
        const textPart = msg.payload.parts.find((p) => p.mimeType === "text/plain");
        if (textPart?.body?.data) {
          body = Buffer.from(textPart.body.data, "base64url").toString("utf-8");
        }
      }

      return {
        id: msg.id!,
        threadId: msg.threadId!,
        snippet: msg.snippet ?? "",
        from: getHeader("From"),
        to: getHeader("To"),
        subject: getHeader("Subject"),
        date: getHeader("Date"),
        labelIds: msg.labelIds ?? [],
        body,
      };
    });

    return {
      id: response.data.id!,
      snippet: response.data.snippet ?? "",
      messages,
    };
  }

  async sendEmail(orgId: string, options: SendEmailOptions): Promise<{ id: string; threadId: string }> {
    const gmail = await this.getGmailClient(orgId);

    const mimeLines: string[] = [];

    if (options.inReplyTo) {
      mimeLines.push(`In-Reply-To: ${options.inReplyTo}`);
      mimeLines.push(`References: ${options.inReplyTo}`);
    }
    mimeLines.push(`To: ${options.to}`);
    if (options.cc) mimeLines.push(`Cc: ${options.cc}`);
    if (options.bcc) mimeLines.push(`Bcc: ${options.bcc}`);
    if (options.replyTo) mimeLines.push(`Reply-To: ${options.replyTo}`);
    mimeLines.push(`Subject: ${options.subject}`);

    if (options.html) {
      const boundary = `boundary_${Date.now()}`;
      mimeLines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
      mimeLines.push("");
      mimeLines.push(`--${boundary}`);
      mimeLines.push("Content-Type: text/plain; charset=UTF-8");
      mimeLines.push("");
      mimeLines.push(options.body);
      mimeLines.push(`--${boundary}`);
      mimeLines.push("Content-Type: text/html; charset=UTF-8");
      mimeLines.push("");
      mimeLines.push(options.html);
      mimeLines.push(`--${boundary}--`);
    } else {
      mimeLines.push("Content-Type: text/plain; charset=UTF-8");
      mimeLines.push("");
      mimeLines.push(options.body);
    }

    const raw = Buffer.from(mimeLines.join("\r\n")).toString("base64url");

    const response = await gmail.users.messages.send({
      userId: "me",
      requestBody: {
        raw,
        threadId: options.threadId,
      },
    });

    return {
      id: response.data.id!,
      threadId: response.data.threadId!,
    };
  }

  async searchMessages(
    orgId: string,
    query: string,
    maxResults: number = 20,
  ): Promise<GmailMessage[]> {
    const gmail = await this.getGmailClient(orgId);

    const response = await gmail.users.messages.list({
      userId: "me",
      q: query,
      maxResults,
    });

    if (!response.data.messages) {
      return [];
    }

    return Promise.all(
      response.data.messages.map((msg) => this.getMessage(orgId, msg.id!, gmail)),
    );
  }

  // ─── Private helpers ──────────────────────────────────

  private createOAuth2Client(): OAuth2Client {
    return new google.auth.OAuth2(
      this.clientId,
      this.clientSecret,
      this.redirectUri,
    );
  }

  private async getGmailClient(orgId: string): Promise<gmail_v1.Gmail> {
    const tokens = await this.getTokens(orgId);
    const oauth2Client = this.createOAuth2Client();
    oauth2Client.setCredentials({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expiry_date: tokens.expiry_date,
    });

    // Set up automatic token refresh
    oauth2Client.on("tokens", async (newTokens) => {
      const updated: GmailTokens = {
        ...tokens,
        access_token: newTokens.access_token ?? tokens.access_token,
        expiry_date: newTokens.expiry_date ?? tokens.expiry_date,
      };
      if (newTokens.refresh_token) {
        updated.refresh_token = newTokens.refresh_token;
      }
      await this.saveTokens(orgId, updated);
    });

    return google.gmail({ version: "v1", auth: oauth2Client });
  }

  private async getTokens(orgId: string): Promise<GmailTokens> {
    const integration = await this.prisma.integration.findUnique({
      where: { orgId_provider: { orgId, provider: "gmail" } },
    });

    if (!integration || integration.status !== "CONNECTED") {
      throw new UnauthorizedException("Gmail not connected for this organization");
    }

    if (!integration.encryptedCredentials) {
      throw new UnauthorizedException("No credentials stored for Gmail integration");
    }

    try {
      const decrypted = decrypt(integration.encryptedCredentials);
      return JSON.parse(decrypted) as GmailTokens;
    } catch {
      throw new UnauthorizedException("Failed to decrypt Gmail credentials");
    }
  }

  private async saveTokens(orgId: string, tokens: GmailTokens): Promise<void> {
    const encryptedCreds = encrypt(JSON.stringify(tokens));
    await this.prisma.integration.update({
      where: { orgId_provider: { orgId, provider: "gmail" } },
      data: {
        encryptedCredentials: encryptedCreds,
        lastSyncAt: new Date(),
      },
    });
  }
}
