import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  UnauthorizedException,
  BadRequestException,
  ForbiddenException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { google, gmail_v1, Auth } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import { OutreachSuppressionReason } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { isWorkerEnabled } from "../../runtime/worker.service";
import { SuppressionService } from "../../outreach/suppression.service";
import { ConversationStoreService } from "../../conversation-store/conversation-store.service";
import { encrypt, decrypt } from "../crypto.util";
import {
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
  cc: string;
  subject: string;
  date: string;
  sentAt: Date;
  internetMessageId: string;
  labelIds: string[];
  body?: string;
  bodyHtml?: string;
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

const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.modify",
];

// Gmail watches expire after ~7 days (see registerWatch). A daily sweep keeps
// every connected mailbox comfortably inside that window — losing the watch
// silently kills DSN auto-suppress AND reply→stop-outreach. GL7.
const WATCH_RENEWAL_INTERVAL_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class GmailService implements OnModuleInit, OnModuleDestroy {
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

  /** Daily watch-renewal sweep state (GL7). Worker-process only. */
  private watchRenewalHandle: ReturnType<typeof setInterval> | null = null;
  private watchRenewalInFlight = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly suppression: SuppressionService,
    private readonly conversationStore: ConversationStoreService,
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
   * GL7: Gmail watches expire after ~7 days. Until now registerWatch only ran
   * at OAuth callback + the manual backfill endpoint, so a week after connect
   * every mailbox silently stopped pushing — no DSN auto-suppress, no
   * reply→stop-outreach. This boot-time hook (mirroring SendOutreachWorker /
   * GraphRunWorker's onModuleInit registration pattern) schedules a daily
   * renewal sweep, gated to the worker process so the api pods don't all race
   * the same renewals.
   */
  async onModuleInit(): Promise<void> {
    if (!isWorkerEnabled()) {
      this.logger.log(
        "Gmail watch renewal sweep disabled in this process (set WORKER_ENABLED=true to enable)",
      );
      return;
    }
    this.watchRenewalHandle = setInterval(
      () => void this.runWatchRenewalSweep(),
      WATCH_RENEWAL_INTERVAL_MS,
    );
    // Run once at boot so a worker that was down across an expiry window
    // re-arms every mailbox immediately instead of waiting a full day.
    await this.runWatchRenewalSweep();
  }

  onModuleDestroy(): void {
    if (this.watchRenewalHandle) {
      clearInterval(this.watchRenewalHandle);
      this.watchRenewalHandle = null;
    }
  }

  /**
   * Single-flight wrapper: a slow sweep (many orgs × Gmail API latency) must
   * not stack with the next interval tick. Failures are logged, never thrown —
   * renewal is best-effort recovery, the next tick retries.
   */
  private async runWatchRenewalSweep(): Promise<void> {
    try {
      const { renewed, failed } = await this.renewWatchesForConnectedIntegrations();
      if (renewed > 0 || failed > 0) {
        this.logger.log("gmail.watch renewal sweep complete", { renewed, failed });
      }
    } catch (err) {
      this.logger.error("gmail.watch renewal sweep failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Re-registers the Pub/Sub watch for every CONNECTED gmail integration.
   * Per-org failures (revoked token, deleted mailbox, Gmail 5xx) are logged
   * and counted but never abort the loop — one broken org must not kill
   * inbound detection for the rest of the fleet. Public so tests can drive
   * the sweep deterministically (mirrors reconcileStuckArtifacts).
   */
  async renewWatchesForConnectedIntegrations(): Promise<{
    renewed: number;
    failed: number;
  }> {
    if (this.watchRenewalInFlight) return { renewed: 0, failed: 0 };
    this.watchRenewalInFlight = true;
    try {
      if (!this.pushPubsubTopic) {
        this.logger.debug(
          "gmail.watch renewal sweep skipped — GMAIL_PUBSUB_TOPIC unset",
        );
        return { renewed: 0, failed: 0 };
      }
      const integrations = await this.prisma.integration.findMany({
        where: { provider: "gmail", status: "CONNECTED" },
        select: { orgId: true },
      });
      let renewed = 0;
      let failed = 0;
      for (const integration of integrations) {
        try {
          await this.registerWatch(integration.orgId);
          renewed++;
        } catch (err) {
          failed++;
          this.logger.warn("gmail.watch renewal failed for org", {
            orgId: integration.orgId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return { renewed, failed };
    } finally {
      this.watchRenewalInFlight = false;
    }
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
   * fetches history since the last seen `historyId`, and durably materializes
   * each correlated inbound reply before acknowledging the notification.
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
      let pageToken: string | undefined;
      do {
        const history = await gmail.users.history.list({
          userId: "me",
          startHistoryId,
          historyTypes: ["messageAdded"],
          pageToken,
        });
        for (const record of history.data.history ?? []) {
          for (const added of record.messagesAdded ?? []) {
            if (added.message?.id) newMessageIds.push(added.message.id);
          }
        }
        pageToken = history.data.nextPageToken ?? undefined;
      } while (pageToken);
    } catch (err) {
      if (!isExpiredHistoryCursorError(err)) {
        // Auth, quota, network, and Gmail 5xx failures are retryable. Moving
        // the cursor here would acknowledge work that was never inspected.
        this.logger.warn("gmail.history.list failed; preserving watermark", {
          orgId,
          startHistoryId,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }

      // Gmail documents 404 for an out-of-retention startHistoryId. Those
      // changes are no longer retrievable, so establish the notification's
      // cursor as the new durable baseline instead of retrying forever.
      this.logger.warn("gmail.history cursor expired; resetting watermark", {
        orgId,
        startHistoryId,
        error: err instanceof Error ? err.message : String(err),
      });
      await this.advanceWatermark(
        orgId,
        latestHistoryId(startHistoryId, historyId),
      );
      return;
    }

    // De-duplicate (history can repeat ids across pages).
    newMessageIds = Array.from(new Set(newMessageIds));

    const failedMessageIds: string[] = [];
    for (const messageId of newMessageIds) {
      try {
        const message = await this.getMessage(orgId, messageId, gmail);
        await this.maybeMaterializeInboundMessage(
          orgId,
          integration.id,
          emailAddress,
          message,
        );
      } catch (err) {
        failedMessageIds.push(messageId);
        this.logger.warn("gmail.push message processing failed", {
          orgId,
          messageId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (failedMessageIds.length > 0) {
      // Do not advance the watermark beyond messages that failed durable
      // materialization. Pub/Sub receives a 5xx and retries; store-level
      // unique keys make already-processed messages no-op on replay.
      throw new Error(
        `Failed to persist ${failedMessageIds.length} Gmail message(s): ${failedMessageIds.join(",")}`,
      );
    }

    // Pub/Sub deliveries are not ordered. Never move a hot or persisted
    // cursor backwards when a delayed notification arrives.
    await this.advanceWatermark(
      orgId,
      latestHistoryId(startHistoryId, historyId),
    );
  }

  /**
   * Write-through watermark update: the in-memory map is the hot layer, the
   * Integration.lastHistoryId column is the durable layer restored on the
   * next cold start. The durable write must succeed before the hot cursor
   * advances and before the controller returns 2xx. On failure Pub/Sub retries
   * and store-level provider-message idempotency makes replay safe.
   */
  private async advanceWatermark(
    orgId: string,
    historyId: string,
  ): Promise<void> {
    // Compare-and-set prevents concurrent Pub/Sub requests handled by
    // different API processes from committing an older cursor after a newer
    // one. A bounded retry absorbs ordinary cursor contention.
    for (let attempt = 0; attempt < 4; attempt++) {
      const currentRow = await this.prisma.integration.findUnique({
        where: { orgId_provider: { orgId, provider: "gmail" } },
        select: { lastHistoryId: true },
      });
      if (!currentRow) {
        throw new UnauthorizedException(
          "Gmail integration disappeared while advancing history cursor",
        );
      }

      const currentHistoryId = currentRow.lastHistoryId ?? null;
      const nextHistoryId = currentHistoryId
        ? latestHistoryId(currentHistoryId, historyId)
        : historyId;
      if (currentHistoryId === nextHistoryId) {
        this.historyWatermark.set(orgId, nextHistoryId);
        return;
      }

      try {
        const updated = await this.prisma.integration.updateMany({
          where: {
            orgId,
            provider: "gmail",
            lastHistoryId: currentHistoryId,
          },
          data: { lastHistoryId: nextHistoryId },
        });
        if (updated.count === 1) {
          this.historyWatermark.set(orgId, nextHistoryId);
          return;
        }
      } catch (err) {
        this.logger.error("gmail.push failed to persist lastHistoryId", {
          orgId,
          historyId: nextHistoryId,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    }

    throw new Error("Gmail history cursor changed too often to advance safely");
  }

  private async maybeMaterializeInboundMessage(
    orgId: string,
    integrationId: string,
    integrationEmail: string,
    message: GmailMessage,
  ): Promise<void> {
    // Skip messages sent by us — Gmail surfaces SENT alongside INBOX changes.
    if (message.labelIds.includes("SENT")) return;
    if (!message.labelIds.includes("INBOX")) return;

    // Defense in depth: if the From header matches the integration owner,
    // it's our own outbound — don't loop.
    const integrationOwner = mailboxEmail(integrationEmail);
    if (
      integrationOwner &&
      mailboxEmail(message.from) === integrationOwner
    ) {
      return;
    }

    // Bounce/DSN guard (audit B8): mailer-daemon / postmaster notifications
    // are not prospect replies. Suppress the failed recipient instead of
    // materializing a customer conversation so the send worker never re-mails
    // a bouncing address.
    if (isDeliveryStatusNotification(message)) {
      await this.handleDeliveryStatusNotification(orgId, message);
      return;
    }

    const sender = mailboxEmail(message.from);
    if (!sender) {
      throw new BadRequestException(
        `Gmail message ${message.id} has no valid sender address`,
      );
    }
    const recipients = mailboxEmails(message.to);
    const ownerEmail = mailboxEmail(integrationEmail);
    const materialized = await this.conversationStore.recordInboundGmailMessage({
      orgId,
      integrationId,
      providerThreadId: message.threadId,
      providerMessageId: message.id,
      internetMessageId: message.internetMessageId || null,
      senderEmail: sender,
      senderName: mailboxName(message.from),
      toEmails:
        recipients.length > 0
          ? recipients
          : ownerEmail
            ? [ownerEmail]
            : [],
      ccEmails: mailboxEmails(message.cc),
      subject: message.subject,
      bodyText: message.body ?? null,
      bodyHtml: message.bodyHtml ?? null,
      snippet: message.snippet,
      sentAt: message.sentAt,
      isUnread: message.labelIds.includes("UNREAD"),
    });

    if (!materialized.correlated) {
      this.logger.debug("gmail.push ignored non-GTM inbox thread", {
        orgId,
        messageId: message.id,
        threadId: message.threadId,
      });
      return;
    }
    this.logger.log("gmail.push materialized prospect reply", {
      orgId,
      messageId: message.id,
      conversationId: materialized.conversation.id,
      created: materialized.created,
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
    id: string;
    orgId: string;
    lastHistoryId: string | null;
  } | null> {
    const normalizedEmail = emailAddress.trim().toLowerCase();
    // We stash the authenticated Gmail address inside the (non-secret)
    // `credentials` JSON column during handleCallback. Until a first-class
    // column lands, query via Prisma's Json `path` filter.
    //
    // TODO(schema): promote `accountEmail` to a first-class indexed column on
    // Integration (or split into a GmailIntegration sibling).
    const matches = await this.prisma.integration.findMany({
      where: {
        provider: "gmail",
        status: "CONNECTED",
        credentials: {
          path: ["accountEmail"],
          equals: normalizedEmail,
        },
      },
      select: { id: true, orgId: true, lastHistoryId: true },
      take: 2,
    });
    if (matches.length > 1) {
      // Gmail's notification identifies only the mailbox. Choosing an
      // arbitrary org here would cross a tenant boundary; fail closed until
      // the duplicate mailbox mapping is resolved.
      this.logger.error("gmail.push mailbox maps to multiple organizations", {
        matchCount: matches.length,
      });
      throw new Error("Gmail push mailbox mapping is ambiguous");
    }
    return matches[0] ?? null;
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
      accountEmail = (profile.data.emailAddress ?? "").trim().toLowerCase();
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
    if (response.data.historyId) {
      // Establish the initial cursor exactly once. Renewal must not overwrite
      // a cursor that may still have unprocessed pages between it and the new
      // watch response.
      await this.prisma.integration.updateMany({
        where: {
          orgId,
          provider: "gmail",
          status: "CONNECTED",
          lastHistoryId: null,
        },
        data: { lastHistoryId: response.data.historyId },
      });
    }
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

    const payload = response.data.payload;
    const bodies = decodeMessageBodies(payload);

    return {
      id: response.data.id!,
      threadId: response.data.threadId!,
      snippet: response.data.snippet ?? "",
      from: getHeader("From"),
      to: getHeader("To"),
      cc: getHeader("Cc"),
      subject: getHeader("Subject"),
      date: getHeader("Date"),
      sentAt: parseMessageDate(getHeader("Date"), response.data.internalDate),
      internetMessageId: getHeader("Message-ID"),
      labelIds: response.data.labelIds ?? [],
      body: bodies.text ?? bodies.html ?? "",
      bodyHtml: bodies.html,
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

      const bodies = decodeMessageBodies(msg.payload);

      return {
        id: msg.id!,
        threadId: msg.threadId!,
        snippet: msg.snippet ?? "",
        from: getHeader("From"),
        to: getHeader("To"),
        cc: getHeader("Cc"),
        subject: getHeader("Subject"),
        date: getHeader("Date"),
        sentAt: parseMessageDate(getHeader("Date"), msg.internalDate),
        internetMessageId: getHeader("Message-ID"),
        labelIds: msg.labelIds ?? [],
        body: bodies.text ?? bodies.html ?? "",
        bodyHtml: bodies.html,
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
      mimeLines.push(`List-Unsubscribe: <${url}>`);
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
    _orgId: string,
    _options: SendApprovedOutreachEmailOptions,
  ): Promise<never> {
    // Direct provider dispatch used to duplicate a subset of the worker's
    // approval checks while bypassing suppression, cooldown, daily caps,
    // compliance composition, CAS claiming, and ambiguous-delivery handling.
    // Keep the method as a fail-closed compatibility boundary; the only live
    // path is artifact approval -> outreach queue -> SendOutreachWorker.
    throw new ForbiddenException(
      "Direct Gmail dispatch is disabled; approve the artifact through the outreach queue",
    );
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

function latestHistoryId(first: string, second: string): string {
  if (/^\d+$/.test(first) && /^\d+$/.test(second)) {
    return BigInt(first) >= BigInt(second) ? first : second;
  }
  // Gmail history ids are decimal strings. If an invalid value reaches this
  // internal helper, prefer the notification value and let Gmail validate it
  // on the next history request instead of manufacturing an ordering.
  return second;
}

function isExpiredHistoryCursorError(error: unknown): boolean {
  if (!isRecord(error)) return false;

  if (httpStatus(error.code) === 404 || httpStatus(error.status) === 404) {
    return true;
  }

  const response = error.response;
  if (!isRecord(response)) return false;
  if (httpStatus(response.status) === 404) return true;

  const data = response.data;
  if (!isRecord(data)) return false;
  const nestedError = data.error;
  return isRecord(nestedError) && httpStatus(nestedError.code) === 404;
}

function httpStatus(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d{3}$/.test(value)) {
    return Number(value);
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function mailboxEmail(value: string): string | null {
  const match = value.match(EMAIL_PATTERN);
  return match ? match[0].toLowerCase() : null;
}

function mailboxEmails(value: string): string[] {
  const pattern = new RegExp(EMAIL_PATTERN.source, "g");
  return Array.from(
    new Set((value.match(pattern) ?? []).map((email) => email.toLowerCase())),
  );
}

function mailboxName(value: string): string | null {
  const email = mailboxEmail(value);
  if (!email) return null;
  const raw = value.replace(new RegExp(`<[^>]*${escapeRegExp(email)}[^>]*>`, "i"), "");
  const name = raw.replace(/^\s*["']|["']\s*$/g, "").trim();
  return name && name.toLowerCase() !== email ? name.slice(0, 320) : null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseMessageDate(header: string, internalDate: string | null | undefined): Date {
  const fromHeader = new Date(header);
  if (!Number.isNaN(fromHeader.getTime())) return fromHeader;
  if (internalDate && /^\d+$/.test(internalDate)) {
    const fromInternal = new Date(Number(internalDate));
    if (!Number.isNaN(fromInternal.getTime())) return fromInternal;
  }
  throw new BadRequestException("Gmail message has no valid delivery timestamp");
}

function decodeMessageBodies(
  payload: gmail_v1.Schema$MessagePart | null | undefined,
): { text?: string; html?: string } {
  let text: string | undefined;
  let html: string | undefined;

  const visit = (part: gmail_v1.Schema$MessagePart | null | undefined): void => {
    if (!part) return;
    const data = part.body?.data;
    if (data) {
      const decoded = Buffer.from(data, "base64url").toString("utf-8");
      if (part.mimeType === "text/html" && html === undefined) html = decoded;
      if (
        (part.mimeType === "text/plain" || !part.mimeType) &&
        text === undefined
      ) {
        text = decoded;
      }
    }
    for (const child of part.parts ?? []) visit(child);
  };

  visit(payload);
  return { ...(text !== undefined ? { text } : {}), ...(html !== undefined ? { html } : {}) };
}

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
