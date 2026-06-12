import {
  Injectable,
  Logger,
  UnauthorizedException,
  BadRequestException,
  ForbiddenException,
  Inject,
  forwardRef,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { google, gmail_v1, Auth } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import {
  OutreachArtifactStatus,
  OutreachSuppressionReason,
  Prisma,
} from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { RuntimeService } from "../../runtime/runtime.service";
import { SuppressionService } from "../../outreach/suppression.service";
import { encrypt, decrypt } from "../crypto.util";
import { isLiveSendAllowedForOrg } from "../../outreach/outreach-allowlist.util";
import {
  buildUnsubscribeMailto,
  buildUnsubscribeUrl,
} from "../../outreach/unsubscribe-token.util";

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
  /**
   * When set, the send injects RFC 8058 / CAN-SPAM List-Unsubscribe +
   * List-Unsubscribe-Post: One-Click headers, with the URL signed via
   * unsubscribe-token.util so the public /u/:token endpoint can verify and
   * record the suppression. Audit P0 #3.
   *
   * Required for any outbound that should be CAN-SPAM compliant — the send
   * worker passes this on every approved-artifact dispatch.
   */
  unsubscribeContext?: {
    readonly orgId: string;
    readonly recipientRef: string;
  };
}

export interface SendApprovedOutreachEmailOptions extends SendEmailOptions {
  readonly outreachArtifactId: string;
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
  /** Raw Content-Type header value — used to spot multipart/report DSNs. */
  contentType: string;
  /** X-Failed-Recipients header — set by Gmail's mailer-daemon on bounces. */
  failedRecipients: string;
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
  private readonly pushAudience: string;
  private readonly pushPublisherSa: string;
  private readonly pushPubsubTopic: string;
  private readonly oidcClient = new OAuth2Client();

  /**
   * Hot layer over Integration.lastHistoryId: last Gmail historyId processed
   * per org. Cold reads fall back to the persisted column (see
   * handlePushNotification); writes go through advanceWatermark, which
   * persists write-through so the reply window survives deploys. Audit B8.
   */
  private readonly historyWatermark = new Map<string, string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Inject(forwardRef(() => RuntimeService))
    private readonly runtime: RuntimeService,
    private readonly suppression: SuppressionService,
  ) {
    this.clientId = this.config.get<string>("GOOGLE_CLIENT_ID", "");
    this.clientSecret = this.config.get<string>("GOOGLE_CLIENT_SECRET", "");
    this.redirectUri = this.config.get<string>(
      "GOOGLE_REDIRECT_URI",
      "http://localhost:4000/api/integrations/gmail/callback",
    );
    this.pushAudience = this.config.get<string>("GMAIL_PUSH_AUDIENCE", "");
    this.pushPublisherSa = this.config.get<string>(
      "GMAIL_PUSH_PUBLISHER_SA",
      "",
    );
    this.pushPubsubTopic = this.config.get<string>("GMAIL_PUBSUB_TOPIC", "");
  }

  /**
   * Verifies an inbound push request was signed by the configured Google
   * Pub/Sub publisher service account. Fail-closed if config is incomplete.
   *
   * Pub/Sub push with OIDC: Google signs a short-lived JWT with the publisher
   * SA's identity. We verify the signature against Google's public certs,
   * pin `aud` to our exact push URL, and pin `email` to the publisher SA.
   */
  async verifyPushAuth(
    authorizationHeader: string | undefined,
  ): Promise<boolean> {
    if (!this.pushAudience || !this.pushPublisherSa) return false;
    if (!authorizationHeader?.startsWith("Bearer ")) return false;

    const idToken = authorizationHeader.slice(7);
    try {
      const ticket = await this.oidcClient.verifyIdToken({
        idToken,
        audience: this.pushAudience,
      });
      const payload = ticket.getPayload();
      if (!payload) return false;
      if (payload.email !== this.pushPublisherSa) return false;
      if (payload.email_verified !== true) return false;
      return true;
    } catch (err) {
      this.logger.warn("gmail.push OIDC verification failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
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

    // Watermark precedence: in-memory hot layer → persisted
    // Integration.lastHistoryId (survives restarts) → the pushed historyId.
    const startHistoryId =
      this.historyWatermark.get(orgId) ??
      integration.lastHistoryId ??
      historyId;

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
      await this.advanceWatermark(orgId, historyId);
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

    await this.advanceWatermark(orgId, historyId);
  }

  /**
   * Write-through watermark update: the in-memory map is the hot layer, the
   * Integration.lastHistoryId column is the durable layer restored on the
   * next cold start. A persistence failure is non-fatal — the hot layer has
   * already advanced so this process won't rescan; worst case after a crash
   * we replay from the previous persisted watermark, which the dispatcher
   * tolerates (duplicate history pages no-op).
   */
  private async advanceWatermark(
    orgId: string,
    historyId: string,
  ): Promise<void> {
    this.historyWatermark.set(orgId, historyId);
    try {
      await this.prisma.integration.update({
        where: { orgId_provider: { orgId, provider: "gmail" } },
        data: { lastHistoryId: historyId },
      });
    } catch (err) {
      this.logger.warn("gmail.push failed to persist lastHistoryId", {
        orgId,
        historyId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
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

    // Bounce/DSN guard (audit B8): mailer-daemon / postmaster notifications
    // are not prospect replies — dispatching the Reply Handler on them would
    // have an agent "reply" to a robot. Suppress the failed recipient instead
    // so the send worker never re-mails a bouncing address.
    if (isDeliveryStatusNotification(message)) {
      await this.handleDeliveryStatusNotification(orgId, message);
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

  /**
   * Auto-suppress the bounced recipient from a delivery-status notification.
   * Extraction is conservative (X-Failed-Recipients header, then RFC 3464
   * fields, then Gmail's human-readable phrasing) — when nothing matches we
   * log and drop rather than risk suppressing the wrong address.
   */
  private async handleDeliveryStatusNotification(
    orgId: string,
    message: GmailMessage,
  ): Promise<void> {
    const failedRecipient = extractFailedRecipient(message);
    if (!failedRecipient) {
      this.logger.warn("gmail.push DSN without extractable failed recipient", {
        orgId,
        messageId: message.id,
        from: message.from,
      });
      return;
    }

    const { created } = await this.suppression.suppress({
      orgId,
      recipientRef: failedRecipient,
      reason: OutreachSuppressionReason.BOUNCED,
      source: "gmail_dsn",
      metadata: {
        gmailMessageId: message.id,
        threadId: message.threadId,
        from: message.from,
        subject: message.subject,
      },
    });

    this.logger.log("gmail.push DSN detected — recipient auto-suppressed", {
      orgId,
      messageId: message.id,
      recipientRef: failedRecipient,
      created,
    });
  }

  private async findIntegrationByEmail(emailAddress: string): Promise<{
    orgId: string;
    lastHistoryId: string | null;
  } | null> {
    // We stash the authenticated Gmail address inside the (non-secret)
    // `credentials` JSON column during handleCallback. Until a first-class
    // column lands, query via Prisma's Json `path` filter.
    //
    // TODO(schema): promote `accountEmail` to a first-class indexed column on
    // Integration (or split into a GmailIntegration sibling).
    const match = await this.prisma.integration.findFirst({
      where: {
        provider: "gmail",
        status: "CONNECTED",
        credentials: {
          path: ["accountEmail"],
          equals: emailAddress,
        },
      },
      select: { orgId: true, lastHistoryId: true },
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

    // Subscribe this mailbox to our Pub/Sub topic so inbound replies push to
    // /integrations/gmail/push. Non-fatal — OAuth succeeds even if watch fails
    // (e.g., topic env not configured in dev), the mailbox just won't get
    // realtime pushes until backfilled.
    await this.registerWatch(orgId).catch((err) => {
      this.logger.warn("gmail.users.watch registration failed", {
        orgId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  /**
   * Calls `gmail.users.watch` for the org's mailbox, subscribing it to the
   * configured Pub/Sub topic. Idempotent: Gmail accepts repeat calls; watches
   * expire after ~7 days so this should be re-run periodically.
   */
  async registerWatch(orgId: string): Promise<{
    historyId?: string;
    expiration?: string;
  } | null> {
    if (!this.pushPubsubTopic) {
      this.logger.debug("gmail.users.watch skipped — GMAIL_PUBSUB_TOPIC unset", {
        orgId,
      });
      return null;
    }
    const gmail = await this.getGmailClient(orgId);
    const response = await gmail.users.watch({
      userId: "me",
      requestBody: {
        topicName: this.pushPubsubTopic,
        labelIds: ["INBOX"],
        labelFilterBehavior: "INCLUDE",
      },
    });
    this.logger.log("gmail.users.watch registered", {
      orgId,
      historyId: response.data.historyId,
      expiration: response.data.expiration,
    });
    return {
      historyId: response.data.historyId ?? undefined,
      expiration: response.data.expiration ?? undefined,
    };
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
      contentType: getHeader("Content-Type"),
      failedRecipients: getHeader("X-Failed-Recipients"),
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
        contentType: getHeader("Content-Type"),
        failedRecipients: getHeader("X-Failed-Recipients"),
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
    if (options.unsubscribeContext) {
      const url = buildUnsubscribeUrl(
        options.unsubscribeContext.orgId,
        options.unsubscribeContext.recipientRef,
      );
      const mailto = buildUnsubscribeMailto(
        options.unsubscribeContext.orgId,
        options.unsubscribeContext.recipientRef,
      );
      mimeLines.push(`List-Unsubscribe: <mailto:${mailto}>, <${url}>`);
      mimeLines.push("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
    }

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

  async sendApprovedOutreachEmail(
    orgId: string,
    options: SendApprovedOutreachEmailOptions,
  ): Promise<{ id: string; threadId: string }> {
    if (!isLiveSendAllowedForOrg(orgId)) {
      throw new ForbiddenException("Live send not enabled for this org");
    }

    const artifactId = options.outreachArtifactId;
    if (typeof artifactId !== "string" || artifactId.trim().length === 0) {
      throw new ForbiddenException("Missing approved outreach artifact");
    }

    const artifact = await this.prisma.outreachArtifact.findUnique({
      where: { id: artifactId },
      select: {
        id: true,
        orgId: true,
        status: true,
        toolName: true,
        payload: true,
      },
    });

    if (!artifact || artifact.orgId !== orgId) {
      throw new ForbiddenException("Missing approved outreach artifact");
    }
    if (artifact.status !== OutreachArtifactStatus.APPROVED) {
      throw new ForbiddenException("Missing approved outreach artifact");
    }
    if (artifact.toolName !== "send_email") {
      throw new ForbiddenException("Outreach artifact does not authorize this send");
    }

    const approvedPayload = extractApprovedEmailPayload(artifact.payload);
    if (!approvedPayload || !payloadMatchesApproved(approvedPayload, options)) {
      throw new ForbiddenException("Outreach artifact payload mismatch");
    }

    const result = await this.sendEmail(orgId, options);

    await this.prisma.outreachArtifact.update({
      where: { id: artifact.id },
      data: {
        status: OutreachArtifactStatus.SENT,
        sentAt: new Date(),
        sendReceiptId: result.id,
      },
    });

    return result;
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

// ─── DSN / bounce detection (audit B8) ──────────────────────────────────

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

// Left-bounded so an address like "not-postmaster@..." doesn't false-positive.
const DAEMON_SENDER_PATTERN =
  /(?:^|[^a-z0-9._%+-])(?:mailer-daemon|postmaster)@/i;

/**
 * A message is a delivery-status notification when it comes from a mail
 * daemon (Gmail's bounces are From: mailer-daemon@googlemail.com) or carries
 * an RFC 6522 multipart/report body with report-type=delivery-status (other
 * MTAs bouncing back to the connected mailbox).
 */
function isDeliveryStatusNotification(message: GmailMessage): boolean {
  if (DAEMON_SENDER_PATTERN.test(message.from)) return true;
  const contentType = message.contentType.toLowerCase();
  return (
    contentType.includes("multipart/report") &&
    contentType.includes("delivery-status")
  );
}

/**
 * Pulls the bounced address out of a DSN, most-reliable source first:
 *   1. X-Failed-Recipients header (Gmail's mailer-daemon sets this).
 *   2. RFC 3464 Final-Recipient / Original-Recipient fields — getMessage only
 *      decodes text parts, but several MTAs echo these into the text body.
 *   3. Gmail's human-readable "wasn't delivered to <addr>" phrasing.
 * Deliberately NO "first email in body" fallback — a quoted original message
 * could make us suppress an innocent address. Null means "give up".
 */
function extractFailedRecipient(message: GmailMessage): string | null {
  const headerMatch = message.failedRecipients.match(EMAIL_PATTERN);
  if (headerMatch) return headerMatch[0].toLowerCase();

  const body = message.body ?? "";
  for (const field of ["Final-Recipient", "Original-Recipient"]) {
    const match = body.match(
      new RegExp(
        `${field}:\\s*(?:rfc822;)?\\s*<?(${EMAIL_PATTERN.source})>?`,
        "i",
      ),
    );
    if (match) return match[1].toLowerCase();
  }

  const phrased = body.match(
    new RegExp(
      `(?:wasn't|was not|couldn't be|could not be)\\s+delivered\\s+to\\s+<?(${EMAIL_PATTERN.source})>?`,
      "i",
    ),
  );
  if (phrased) return phrased[1].toLowerCase();

  return null;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function extractApprovedEmailPayload(
  payload: unknown,
): {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  readonly html?: string;
  readonly cc?: string;
  readonly bcc?: string;
  readonly replyTo?: string;
  readonly inReplyTo?: string;
  readonly threadId?: string;
} | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const obj = payload as Record<string, unknown>;

  const to =
    asNonEmptyString(obj.to) ??
    asNonEmptyString(obj.recipient) ??
    asNonEmptyString(obj.email);
  const subject = asNonEmptyString(obj.subject);
  const body =
    asNonEmptyString(obj.body) ??
    asNonEmptyString(obj.bodyText) ??
    asNonEmptyString(obj.text);

  if (!to || !subject || !body) return null;

  const html = asNonEmptyString(obj.html) ?? asNonEmptyString(obj.bodyHtml);
  const cc = asNonEmptyString(obj.cc);
  const bcc = asNonEmptyString(obj.bcc);
  const replyTo = asNonEmptyString(obj.replyTo);
  const inReplyTo = asNonEmptyString(obj.inReplyTo);
  const threadId = asNonEmptyString(obj.threadId);

  return {
    to,
    subject,
    body,
    ...(html ? { html } : {}),
    ...(cc ? { cc } : {}),
    ...(bcc ? { bcc } : {}),
    ...(replyTo ? { replyTo } : {}),
    ...(inReplyTo ? { inReplyTo } : {}),
    ...(threadId ? { threadId } : {}),
  };
}

function payloadMatchesApproved(
  approved: Exclude<ReturnType<typeof extractApprovedEmailPayload>, null>,
  requested: SendApprovedOutreachEmailOptions,
): boolean {
  if (approved.to !== requested.to) return false;
  if (approved.subject !== requested.subject) return false;
  if (approved.body !== requested.body) return false;

  const normalizeOptional = (value: unknown): string | undefined =>
    typeof value === "string" && value.length > 0 ? value : undefined;

  if (normalizeOptional(approved.html) !== normalizeOptional(requested.html)) return false;
  if (normalizeOptional(approved.cc) !== normalizeOptional(requested.cc)) return false;
  if (normalizeOptional(approved.bcc) !== normalizeOptional(requested.bcc)) return false;
  if (normalizeOptional(approved.replyTo) !== normalizeOptional(requested.replyTo)) return false;
  if (normalizeOptional(approved.inReplyTo) !== normalizeOptional(requested.inReplyTo)) return false;
  if (normalizeOptional(approved.threadId) !== normalizeOptional(requested.threadId)) return false;

  return true;
}
