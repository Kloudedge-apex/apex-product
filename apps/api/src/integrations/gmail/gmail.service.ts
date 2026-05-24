import {
  Injectable,
  Logger,
  UnauthorizedException,
  BadRequestException,
  Inject,
  forwardRef,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { google, gmail_v1, Auth } from "googleapis";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { RuntimeService } from "../../runtime/runtime.service";
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

interface GmailPushPayload {
  emailAddress: string;
  historyId: string;
}

interface ReplyDispatchContext {
  gmailMessageId: string;
  threadId: string;
  from: string;
  subject: string;
  bodyPreview: string;
}

// Phase 1 watermark: the GmailIntegration row in the Prisma schema does NOT yet
// have a `lastHistoryId` column. Until that field is added + migrated, we keep
// the watermark in-memory keyed by orgId. This is lossy across process
// restarts; the dispatcher tolerates that by falling back to "scan from the
// supplied historyId" when there's no stored value.
// TODO(schema): add `lastHistoryId String?` to Integration (or a sibling
// GmailIntegration table) and migrate; then replace this in-memory map.
const HISTORY_WATERMARK = new Map<string, string>();

const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.modify",
];

@Injectable()
export class GmailService {
  private readonly logger = new Logger(GmailService.name);
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly redirectUri: string;
  private readonly pushVerificationToken: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Inject(forwardRef(() => RuntimeService))
    private readonly runtime: RuntimeService,
  ) {
    this.clientId = this.config.get<string>("GOOGLE_CLIENT_ID", "");
    this.clientSecret = this.config.get<string>("GOOGLE_CLIENT_SECRET", "");
    this.redirectUri = this.config.get<string>(
      "GOOGLE_REDIRECT_URI",
      "http://localhost:4000/api/integrations/gmail/callback",
    );
    this.pushVerificationToken = this.config.get<string>(
      "GMAIL_PUSH_VERIFICATION_TOKEN",
      "",
    );
  }

  /**
   * Verifies that an inbound push request came from Google.
   *
   * Phase 1 — simple shared bearer token sent in the `Authorization` header.
   * Configure Google Pub/Sub to attach this token via the subscription's
   * `pushConfig.attributes` or `authentication_method.token`.
   *
   * TODO(security): upgrade to OIDC JWT verification — Google signs each push
   * with a Google-issued JWT; we should verify the signature against
   * https://www.googleapis.com/oauth2/v1/certs and check `aud` matches our
   * push endpoint. The bearer approach is acceptable for hackathon timeline
   * but MUST be hardened before production traffic.
   */
  verifyPushAuth(authorizationHeader: string | undefined): boolean {
    if (!this.pushVerificationToken) {
      // Fail-closed: if no token is configured, refuse all push traffic.
      return false;
    }
    if (!authorizationHeader) return false;
    const expected = `Bearer ${this.pushVerificationToken}`;
    return authorizationHeader === expected;
  }

  /**
   * Entry point for Gmail Pub/Sub push notifications. Decodes the watermark,
   * fetches history since the last seen `historyId`, and dispatches each new
   * inbound reply to the org's Reply Handler agent.
   *
   * Idempotency: the History API is monotonic and we update the watermark
   * after processing. Duplicate deliveries from Pub/Sub will produce an empty
   * history page and no-op.
   */
  async handlePushNotification(payload: GmailPushPayload): Promise<void> {
    const { emailAddress, historyId } = payload;
    if (!emailAddress || !historyId) {
      this.logger.warn("gmail.push missing emailAddress/historyId", { payload });
      return;
    }

    const integration = await this.findIntegrationByEmail(emailAddress);
    if (!integration) {
      this.logger.warn("gmail.push no integration for emailAddress", {
        emailAddress,
      });
      return;
    }

    const orgId = integration.orgId;
    const gmail = await this.getGmailClient(orgId);

    const startHistoryId = HISTORY_WATERMARK.get(orgId) ?? historyId;

    let newMessageIds: string[] = [];
    try {
      const history = await gmail.users.history.list({
        userId: "me",
        startHistoryId,
        historyTypes: ["messageAdded"],
      });
      for (const record of history.data.history ?? []) {
        for (const added of record.messagesAdded ?? []) {
          if (added.message?.id) newMessageIds.push(added.message.id);
        }
      }
    } catch (err) {
      // Common case: startHistoryId is too old → Gmail returns 404. Skip and
      // reset the watermark to the latest so we don't refetch forever.
      this.logger.warn("gmail.history.list failed; resetting watermark", {
        orgId,
        startHistoryId,
        error: err instanceof Error ? err.message : String(err),
      });
      HISTORY_WATERMARK.set(orgId, historyId);
      return;
    }

    // De-duplicate (history can repeat ids across pages).
    newMessageIds = Array.from(new Set(newMessageIds));

    for (const messageId of newMessageIds) {
      try {
        const message = await this.getMessage(orgId, messageId, gmail);
        await this.maybeDispatchReply(orgId, emailAddress, message);
      } catch (err) {
        this.logger.warn("gmail.push message processing failed", {
          orgId,
          messageId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    HISTORY_WATERMARK.set(orgId, historyId);
  }

  private async maybeDispatchReply(
    orgId: string,
    integrationEmail: string,
    message: GmailMessage,
  ): Promise<void> {
    // Skip messages sent by us — Gmail surfaces SENT alongside INBOX changes.
    if (message.labelIds.includes("SENT")) return;
    if (!message.labelIds.includes("INBOX")) return;

    // Defense in depth: if the From header matches the integration owner,
    // it's our own outbound — don't loop.
    if (
      integrationEmail &&
      message.from.toLowerCase().includes(integrationEmail.toLowerCase())
    ) {
      return;
    }

    // Look up the Reply Handler agent for this org. Template slug is
    // "reply-handler"; the seeded AgentTemplate row has name "Reply Handler".
    const agent = await this.prisma.agent.findFirst({
      where: {
        orgId,
        template: { name: "Reply Handler" },
      },
      select: { id: true, orgId: true },
    });

    if (!agent) {
      this.logger.log("gmail.push no Reply Handler configured — skipping", {
        orgId,
        messageId: message.id,
      });
      return;
    }

    const context: ReplyDispatchContext = {
      gmailMessageId: message.id,
      threadId: message.threadId,
      from: message.from,
      subject: message.subject,
      bodyPreview: (message.body ?? message.snippet).slice(0, 280),
    };

    const run = await this.runtime.triggerRun(agent.id, agent.orgId);

    // RuntimeService.triggerRun does not accept a payload today; log the
    // inbound context against the new run so the executor can pick it up.
    await this.prisma.agentLog.create({
      data: {
        runId: run.id,
        level: "INFO",
        message: "Reply Handler triggered by Gmail push notification",
        metadata: context as unknown as Prisma.InputJsonValue,
      },
    });
  }

  private async findIntegrationByEmail(emailAddress: string): Promise<{
    orgId: string;
  } | null> {
    // We stash the authenticated Gmail address inside the (non-secret)
    // `credentials` JSON column during handleCallback. Until a first-class
    // column lands, query via Prisma's Json `path` filter.
    //
    // TODO(schema): promote `accountEmail` to a first-class indexed column on
    // Integration (or split into a GmailIntegration sibling). Same migration
    // should add `lastHistoryId` for durable watermarking.
    const match = await this.prisma.integration.findFirst({
      where: {
        provider: "gmail",
        status: "CONNECTED",
        credentials: {
          path: ["accountEmail"],
          equals: emailAddress,
        },
      },
      select: { orgId: true },
    });
    return match;
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

    // Resolve the authenticated Gmail address so push deliveries can map
    // `emailAddress` → orgId without a schema migration. We stash it in the
    // (non-secret) `credentials` JSON column.
    let accountEmail = "";
    try {
      const oauthForProfile = this.createOAuth2Client();
      oauthForProfile.setCredentials({
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        expiry_date: tokenData.expiry_date,
      });
      const gmail = google.gmail({ version: "v1", auth: oauthForProfile });
      const profile = await gmail.users.getProfile({ userId: "me" });
      accountEmail = profile.data.emailAddress ?? "";
    } catch {
      // Non-fatal — push routing will degrade but OAuth still succeeds.
    }

    await this.prisma.integration.upsert({
      where: { orgId_provider: { orgId, provider: "gmail" } },
      create: {
        orgId,
        provider: "gmail",
        credentials: { accountEmail },
        encryptedCredentials: encryptedCreds,
        status: "CONNECTED",
        scopes: GMAIL_SCOPES,
      },
      update: {
        encryptedCredentials: encryptedCreds,
        credentials: { accountEmail },
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
    mimeLines.push("MIME-Version: 1.0");

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

  private createOAuth2Client(): Auth.OAuth2Client {
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
    oauth2Client.on("tokens", async (newTokens: Auth.Credentials) => {
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
