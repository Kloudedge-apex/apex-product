import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  Conversation,
  ConversationDirection,
  ConversationIntelligenceStatus,
  ConversationMessage,
  FollowUpSource,
  FollowUpStatus,
  OutreachArtifact,
  OutreachArtifactStatus,
  OutreachChannel,
  Prisma,
} from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { acquireOrgSendReservationLock } from "../outreach/outreach-send-reservation-lock";

const MAX_PROVIDER_ID_LENGTH = 1024;
const MAX_SUBJECT_LENGTH = 998;
const MAX_NAME_LENGTH = 320;
const MAX_PREVIEW_LENGTH = 500;
const MAX_BODY_LENGTH = 1_000_000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface GmailMessageFields {
  readonly orgId: string;
  readonly integrationId: string;
  readonly providerThreadId: string;
  readonly providerMessageId: string;
  /** RFC 5322 Message-ID header, not Gmail's API message id. */
  readonly internetMessageId?: string | null;
  readonly senderEmail: string;
  readonly senderName?: string | null;
  readonly toEmails: readonly string[];
  readonly ccEmails?: readonly string[];
  readonly subject?: string | null;
  readonly bodyText?: string | null;
  readonly bodyHtml?: string | null;
  readonly snippet?: string | null;
  readonly sentAt: Date;
}

export interface RecordInboundGmailMessageInput extends GmailMessageFields {
  /** Optional caller-resolved Person. Ownership is re-checked by this store. */
  readonly personId?: string | null;
  /** Defaults true because Gmail push is normally driven by an unread reply. */
  readonly isUnread?: boolean;
}

export type RecordInboundGmailMessageResult =
  | {
      readonly correlated: false;
      readonly reason: "UNMATCHED_THREAD";
    }
  | {
      readonly correlated: true;
      readonly created: boolean;
      readonly conversation: Conversation;
      readonly message: ConversationMessage;
    };

export interface RecordDeliveredGmailArtifactInput extends GmailMessageFields {
  readonly artifactId: string;
}

export interface RecordDeliveredGmailArtifactResult {
  readonly created: boolean;
  readonly conversation: Conversation;
  readonly message: ConversationMessage;
  readonly artifact: OutreachArtifact;
}

interface NormalizedGmailMessage {
  readonly orgId: string;
  readonly integrationId: string;
  readonly providerThreadId: string;
  readonly providerMessageId: string;
  readonly internetMessageId: string | null;
  readonly senderEmail: string;
  readonly senderName: string | null;
  readonly toEmails: string[];
  readonly ccEmails: string[];
  readonly subject: string;
  readonly bodyText: string | null;
  readonly bodyHtml: string | null;
  readonly preview: string;
  readonly sentAt: Date;
}

/**
 * Durable provider-event store; it performs no network calls and no sends.
 *
 * Inbound Gmail is materialized only when its thread already belongs to a
 * conversation or matches a SENT outreach artifact. A real reply stops the
 * sequence on Conversation and cancels OPEN AGENT follow-up tasks. It never
 * writes OutreachSuppression: a reply is engagement, not a legal opt-out.
 *
 * Outbound recording accepts only SENDING/SENT EMAIL artifacts. It cannot move
 * PENDING_REVIEW or APPROVED rows onto the delivered path, preserving the
 * existing approval, allowlist, suppression, cooldown, and worker-claim gates.
 */
@Injectable()
export class ConversationStoreService {
  constructor(private readonly prisma: PrismaService) {}

  async recordInboundGmailMessage(
    raw: RecordInboundGmailMessageInput,
  ): Promise<RecordInboundGmailMessageResult> {
    const input = normalizeGmailMessage(raw);
    const isUnread = raw.isUnread !== false;

    return this.prisma.$transaction(async (tx) => {
      // Global lock order for inbound-vs-draft-vs-send races is always
      // org reservation -> reply scope (where applicable) -> tenant rows.
      // Acquire before the integration/conversation reads because upsert and
      // message insertion can take row locks; taking the org lock later could
      // deadlock with a reply-draft transaction that already owns it.
      await acquireOrgSendReservationLock(tx, input.orgId);

      await this.assertOwnedGmailIntegration(
        tx,
        input.orgId,
        input.integrationId,
      );

      let conversation = await tx.conversation.findUnique({
        where: {
          integrationId_providerThreadId: {
            integrationId: input.integrationId,
            providerThreadId: input.providerThreadId,
          },
        },
      });

      // Do not turn an arbitrary connected inbox into the GTM conversation
      // feed. A first inbound message must correlate to a delivered artifact.
      if (!conversation) {
        const artifact = await tx.outreachArtifact.findFirst({
          where: {
            orgId: input.orgId,
            channel: OutreachChannel.EMAIL,
            status: OutreachArtifactStatus.SENT,
            providerThreadId: input.providerThreadId,
          },
          orderBy: { sentAt: "desc" },
          select: { id: true },
        });
        if (!artifact) {
          return { correlated: false, reason: "UNMATCHED_THREAD" } as const;
        }
      }

      const personId = raw.personId
        ? await this.resolveOwnedPersonId(tx, input.orgId, raw.personId)
        : await this.resolvePersonIdByEmail(
            tx,
            input.orgId,
            input.senderEmail,
          );

      conversation = await tx.conversation.upsert({
        where: {
          integrationId_providerThreadId: {
            integrationId: input.integrationId,
            providerThreadId: input.providerThreadId,
          },
        },
        create: {
          orgId: input.orgId,
          integrationId: input.integrationId,
          providerThreadId: input.providerThreadId,
          personId,
          contactEmail: input.senderEmail,
          contactName: input.senderName,
          subject: input.subject,
          lastMessagePreview: input.preview,
          lastMessageAt: input.sentAt,
          lastInboundAt: input.sentAt,
          // Derived fields are applied only after the provider message wins its
          // unique insert below, so a duplicate push cannot increment unread.
          unreadCount: 0,
          needsReply: false,
        },
        update: {},
      });

      // Attach all delivered artifacts in this provider thread. updateMany is
      // idempotent and its orgId predicate is the application-level mirror of
      // the composite FK added by the migration.
      await tx.outreachArtifact.updateMany({
        where: {
          orgId: input.orgId,
          channel: OutreachChannel.EMAIL,
          status: OutreachArtifactStatus.SENT,
          providerThreadId: input.providerThreadId,
          conversationId: null,
        },
        data: { conversationId: conversation.id },
      });

      const inserted = await tx.conversationMessage.createMany({
        data: [
          {
            orgId: input.orgId,
            conversationId: conversation.id,
            direction: ConversationDirection.INBOUND,
            providerMessageId: input.providerMessageId,
            internetMessageId: input.internetMessageId,
            senderEmail: input.senderEmail,
            senderName: input.senderName,
            toEmails: input.toEmails,
            ccEmails: input.ccEmails,
            subject: input.subject,
            bodyText: input.bodyText,
            bodyHtml: input.bodyHtml,
            sentAt: input.sentAt,
          },
        ],
        skipDuplicates: true,
      });

      const message = await tx.conversationMessage.findUnique({
        where: {
          conversationId_providerMessageId: {
            conversationId: conversation.id,
            providerMessageId: input.providerMessageId,
          },
        },
      });
      if (!message) {
        throw new ConflictException(
          "Gmail message could not be materialized after idempotent insert",
        );
      }
      if (message.orgId !== input.orgId) {
        throw new ConflictException("Gmail message org ownership mismatch");
      }
      if (message.direction !== ConversationDirection.INBOUND) {
        throw new ConflictException(
          "Provider message id already belongs to an outbound message",
        );
      }

      if (inserted.count === 0) {
        // Duplicate Pub/Sub/history delivery: return the durable row without
        // changing unread, sequence-stop, intelligence, or follow-up state.
        return {
          correlated: true,
          created: false,
          conversation,
          message,
        } as const;
      }

      conversation = await this.applyInboundConversationState(
        tx,
        conversation.id,
        input,
        personId,
        isUnread,
      );

      // A reply stops only agent-scheduled sequence work. Human reminders stay
      // open, and no OutreachSuppression row is created or mutated here.
      await tx.followUpTask.updateMany({
        where: {
          orgId: input.orgId,
          conversationId: conversation.id,
          status: FollowUpStatus.OPEN,
          source: FollowUpSource.AGENT,
        },
        data: {
          status: FollowUpStatus.CANCELLED,
          cancelledAt: new Date(),
          cancellationReason: "gmail_reply_received",
        },
      });

      return {
        correlated: true,
        created: true,
        conversation,
        message,
      } as const;
    });
  }

  async recordDeliveredGmailArtifact(
    raw: RecordDeliveredGmailArtifactInput,
  ): Promise<RecordDeliveredGmailArtifactResult> {
    const input = normalizeGmailMessage(raw);
    const artifactId = requireIdentifier(raw.artifactId, "artifactId");

    return this.prisma.$transaction(async (tx) => {
      await this.assertOwnedGmailIntegration(
        tx,
        input.orgId,
        input.integrationId,
      );

      const artifact = await tx.outreachArtifact.findFirst({
        where: { id: artifactId, orgId: input.orgId },
      });
      if (!artifact) {
        throw new NotFoundException("Outreach artifact not found");
      }
      this.assertRecordableDeliveredArtifact(
        artifact,
        input.providerMessageId,
        input.providerThreadId,
      );

      const contactEmail = resolveArtifactContactEmail(
        artifact.recipientRef,
        input.toEmails,
      );

      let conversation = await tx.conversation.upsert({
        where: {
          integrationId_providerThreadId: {
            integrationId: input.integrationId,
            providerThreadId: input.providerThreadId,
          },
        },
        create: {
          orgId: input.orgId,
          integrationId: input.integrationId,
          providerThreadId: input.providerThreadId,
          contactEmail,
          subject: input.subject,
          lastMessagePreview: input.preview,
          lastMessageAt: input.sentAt,
          lastOutboundAt: input.sentAt,
          needsReply: false,
        },
        update: {},
      });

      if (
        artifact.conversationId &&
        artifact.conversationId !== conversation.id
      ) {
        throw new ConflictException(
          "Artifact is already linked to a different conversation",
        );
      }

      if (artifact.replyToMessageId) {
        const replyTo = await tx.conversationMessage.findFirst({
          where: {
            id: artifact.replyToMessageId,
            orgId: input.orgId,
            conversationId: conversation.id,
          },
          select: { id: true },
        });
        if (!replyTo) {
          throw new ConflictException(
            "Artifact reply target is not in the delivered Gmail thread",
          );
        }
      }

      // SENDING proves the existing worker passed approval, allowlist,
      // suppression, cooldown, and CAS-claim gates. SENT is accepted for
      // replay. The status and provenance predicates are re-checked in the
      // UPDATE itself so a concurrent claim release cannot be promoted.
      const recordedArtifact = await tx.outreachArtifact.updateMany({
        where: {
          id: artifact.id,
          orgId: input.orgId,
          channel: OutreachChannel.EMAIL,
          toolName: "send_email",
          status: {
            in: [
              OutreachArtifactStatus.SENDING,
              OutreachArtifactStatus.SENT,
            ],
          },
          AND: [
            {
              OR: [
                { sendReceiptId: null },
                { sendReceiptId: input.providerMessageId },
              ],
            },
            {
              OR: [
                { providerThreadId: null },
                { providerThreadId: input.providerThreadId },
              ],
            },
            {
              OR: [
                { conversationId: null },
                { conversationId: conversation.id },
              ],
            },
            {
              OR: [{ sentAt: null }, { sentAt: input.sentAt }],
            },
          ],
        },
        data: {
          status: OutreachArtifactStatus.SENT,
          sentAt: input.sentAt,
          sendReceiptId: input.providerMessageId,
          providerThreadId: input.providerThreadId,
          conversationId: conversation.id,
        },
      });
      if (recordedArtifact.count !== 1) {
        throw new ConflictException(
          "Artifact delivery state changed before it could be recorded",
        );
      }
      const updatedArtifact = await tx.outreachArtifact.findUnique({
        where: { id_orgId: { id: artifact.id, orgId: input.orgId } },
      });
      if (!updatedArtifact) {
        throw new ConflictException(
          "Artifact disappeared after delivery was recorded",
        );
      }

      const inserted = await tx.conversationMessage.createMany({
        data: [
          {
            orgId: input.orgId,
            conversationId: conversation.id,
            direction: ConversationDirection.OUTBOUND,
            providerMessageId: input.providerMessageId,
            internetMessageId: input.internetMessageId,
            senderEmail: input.senderEmail,
            senderName: input.senderName,
            toEmails: input.toEmails,
            ccEmails: input.ccEmails,
            subject: input.subject,
            bodyText: input.bodyText,
            bodyHtml: input.bodyHtml,
            sentAt: input.sentAt,
            outreachArtifactId: artifact.id,
          },
        ],
        skipDuplicates: true,
      });

      const message = await tx.conversationMessage.findUnique({
        where: {
          orgId_outreachArtifactId: {
            orgId: input.orgId,
            outreachArtifactId: artifact.id,
          },
        },
      });
      if (!message) {
        const providerCollision = await tx.conversationMessage.findUnique({
          where: {
            conversationId_providerMessageId: {
              conversationId: conversation.id,
              providerMessageId: input.providerMessageId,
            },
          },
        });
        if (providerCollision) {
          throw new ConflictException(
            "Provider message id is already linked to another artifact",
          );
        }
        throw new ConflictException(
          "Delivered Gmail message could not be materialized",
        );
      }
      this.assertSameDeliveredMessage(
        message,
        conversation.id,
        input.providerMessageId,
      );
      if (inserted.count === 0) {
        return {
          created: false,
          conversation,
          message,
          artifact: updatedArtifact,
        };
      }

      conversation = await this.applyOutboundConversationState(
        tx,
        conversation.id,
        input,
        contactEmail,
      );

      return {
        created: true,
        conversation,
        message,
        artifact: updatedArtifact,
      };
    });
  }

  private async assertOwnedGmailIntegration(
    tx: Prisma.TransactionClient,
    orgId: string,
    integrationId: string,
  ): Promise<void> {
    const integration = await tx.integration.findFirst({
      where: { id: integrationId, orgId, provider: "gmail" },
      select: { id: true },
    });
    if (!integration) {
      // Same response for missing and cross-org rows: do not leak identifiers.
      throw new NotFoundException("Gmail integration not found");
    }
  }

  private async resolveOwnedPersonId(
    tx: Prisma.TransactionClient,
    orgId: string,
    personId: string | null,
  ): Promise<string | null> {
    if (!personId) return null;
    const person = await tx.person.findFirst({
      where: { id: personId, company: { orgId } },
      select: { id: true },
    });
    if (!person) throw new NotFoundException("Person not found");
    return person.id;
  }

  private async resolvePersonIdByEmail(
    tx: Prisma.TransactionClient,
    orgId: string,
    senderEmail: string,
  ): Promise<string | null> {
    const matches = await tx.emailCandidate.findMany({
      where: {
        email: { equals: senderEmail, mode: "insensitive" },
        person: { company: { orgId } },
      },
      select: { personId: true },
    });
    const personIds = new Set(matches.map((match) => match.personId));

    // EmailCandidate is unique only per person, so the same address can still
    // belong to multiple leads. Do not guess when the tenant's data conflicts.
    return personIds.size === 1 ? [...personIds][0] : null;
  }

  private async applyInboundConversationState(
    tx: Prisma.TransactionClient,
    conversationId: string,
    input: NormalizedGmailMessage,
    personId: string | null,
    isUnread: boolean,
  ): Promise<Conversation> {
    const scope = { id: conversationId, orgId: input.orgId };

    if (personId) {
      await tx.conversation.updateMany({
        where: { ...scope, personId: null },
        data: { personId },
      });
    }
    await tx.conversation.update({
      where: { id_orgId: scope },
      data: {
        archivedAt: null,
        ...(isUnread ? { unreadCount: { increment: 1 } } : {}),
      },
    });
    await tx.conversation.updateMany({
      where: {
        ...scope,
        OR: [
          { lastInboundAt: null },
          { lastInboundAt: { lt: input.sentAt } },
        ],
      },
      data: { lastInboundAt: input.sentAt },
    });
    await tx.conversation.updateMany({
      where: {
        ...scope,
        OR: [
          { sequenceStoppedAt: null },
          { sequenceStoppedAt: { gt: input.sentAt } },
        ],
      },
      data: { sequenceStoppedAt: input.sentAt },
    });
    await tx.conversation.updateMany({
      where: { ...scope, sequenceStopReason: null },
      data: { sequenceStopReason: "gmail_reply_received" },
    });

    const latestMessageData: Prisma.ConversationUpdateManyMutationInput = {
      contactEmail: input.senderEmail,
      ...(input.senderName ? { contactName: input.senderName } : {}),
      ...(input.subject ? { subject: input.subject } : {}),
      lastMessagePreview: input.preview,
      lastMessageAt: input.sentAt,
      sentiment: null,
      sentimentConfidence: null,
      nextBestAction: null,
      nextBestActionType: null,
      intelligenceStatus: ConversationIntelligenceStatus.PENDING,
      intelligenceError: null,
      intelligenceUpdatedAt: null,
    };
    await tx.conversation.updateMany({
      where: {
        ...scope,
        lastMessageAt: { lte: input.sentAt },
        OR: [
          { lastOutboundAt: null },
          { lastOutboundAt: { lte: input.sentAt } },
        ],
      },
      data: { ...latestMessageData, needsReply: true },
    });
    await tx.conversation.updateMany({
      where: {
        ...scope,
        lastMessageAt: { lte: input.sentAt },
        lastOutboundAt: { gt: input.sentAt },
      },
      data: { ...latestMessageData, needsReply: false },
    });

    const conversation = await tx.conversation.findUnique({
      where: { id_orgId: scope },
    });
    if (!conversation) {
      throw new ConflictException("Conversation disappeared during reply update");
    }
    return conversation;
  }

  private async applyOutboundConversationState(
    tx: Prisma.TransactionClient,
    conversationId: string,
    input: NormalizedGmailMessage,
    contactEmail: string,
  ): Promise<Conversation> {
    const scope = { id: conversationId, orgId: input.orgId };
    await tx.conversation.updateMany({
      where: {
        ...scope,
        OR: [
          { lastOutboundAt: null },
          { lastOutboundAt: { lt: input.sentAt } },
        ],
      },
      data: { lastOutboundAt: input.sentAt },
    });
    await tx.conversation.updateMany({
      where: { ...scope, lastMessageAt: { lte: input.sentAt } },
      data: {
        contactEmail,
        ...(input.subject ? { subject: input.subject } : {}),
        lastMessagePreview: input.preview,
        lastMessageAt: input.sentAt,
        needsReply: false,
      },
    });
    const conversation = await tx.conversation.findUnique({
      where: { id_orgId: scope },
    });
    if (!conversation) {
      throw new ConflictException(
        "Conversation disappeared during delivery update",
      );
    }
    return conversation;
  }

  private assertRecordableDeliveredArtifact(
    artifact: OutreachArtifact,
    providerMessageId: string,
    providerThreadId: string,
  ): void {
    if (
      artifact.channel !== OutreachChannel.EMAIL ||
      artifact.toolName !== "send_email"
    ) {
      throw new ConflictException("Artifact is not a Gmail-compatible email");
    }
    if (
      artifact.status !== OutreachArtifactStatus.SENDING &&
      artifact.status !== OutreachArtifactStatus.SENT
    ) {
      throw new ConflictException(
        `Artifact ${artifact.id} is ${artifact.status}; only SENDING or SENT can be recorded as delivered`,
      );
    }
    if (
      artifact.sendReceiptId &&
      artifact.sendReceiptId !== providerMessageId
    ) {
      throw new ConflictException(
        "Artifact is already linked to a different provider message",
      );
    }
    if (
      artifact.providerThreadId &&
      artifact.providerThreadId !== providerThreadId
    ) {
      throw new ConflictException(
        "Artifact is already linked to a different provider thread",
      );
    }
  }

  private assertSameDeliveredMessage(
    message: ConversationMessage,
    conversationId: string,
    providerMessageId: string,
  ): void {
    if (
      message.direction !== ConversationDirection.OUTBOUND ||
      message.conversationId !== conversationId ||
      message.providerMessageId !== providerMessageId
    ) {
      throw new ConflictException(
        "Artifact delivery is already recorded with different provider data",
      );
    }
  }
}

function normalizeGmailMessage(input: GmailMessageFields): NormalizedGmailMessage {
  const sentAt = input.sentAt;
  if (!(sentAt instanceof Date) || Number.isNaN(sentAt.getTime())) {
    throw new BadRequestException("sentAt must be a valid Date");
  }

  const bodyText = normalizeBody(input.bodyText);
  const bodyHtml = normalizeBody(input.bodyHtml);
  const subject = normalizeLimitedText(
    input.subject,
    MAX_SUBJECT_LENGTH,
  );
  const snippet = normalizeLimitedText(input.snippet, MAX_PREVIEW_LENGTH);

  return {
    orgId: requireIdentifier(input.orgId, "orgId"),
    integrationId: requireIdentifier(input.integrationId, "integrationId"),
    providerThreadId: requireIdentifier(
      input.providerThreadId,
      "providerThreadId",
    ),
    providerMessageId: requireIdentifier(
      input.providerMessageId,
      "providerMessageId",
    ),
    internetMessageId: normalizeOptionalIdentifier(input.internetMessageId),
    senderEmail: normalizeEmail(input.senderEmail, "senderEmail"),
    senderName: normalizeOptionalName(input.senderName),
    toEmails: normalizeEmailList(input.toEmails, "toEmails", true),
    ccEmails: normalizeEmailList(input.ccEmails ?? [], "ccEmails", false),
    subject,
    bodyText,
    bodyHtml,
    preview: buildPreview(snippet, bodyText, bodyHtml),
    sentAt,
  };
}

function requireIdentifier(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new BadRequestException(`${field} is required`);
  }
  const normalized = value.trim();
  if (normalized.length > MAX_PROVIDER_ID_LENGTH) {
    throw new BadRequestException(
      `${field} must be at most ${MAX_PROVIDER_ID_LENGTH} characters`,
    );
  }
  return normalized;
}

function normalizeOptionalIdentifier(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value.trim().length === 0) {
    return null;
  }
  return requireIdentifier(value, "internetMessageId");
}

function normalizeEmail(value: string, field: string): string {
  if (typeof value !== "string") {
    throw new BadRequestException(`${field} must be an email address`);
  }
  const normalized = value.trim().toLowerCase();
  if (!EMAIL_RE.test(normalized) || normalized.length > 320) {
    throw new BadRequestException(`${field} must be a valid email address`);
  }
  return normalized;
}

function normalizeEmailList(
  values: readonly string[],
  field: string,
  requireOne: boolean,
): string[] {
  if (!Array.isArray(values)) {
    throw new BadRequestException(`${field} must be an array`);
  }
  const normalized = Array.from(
    new Set(values.map((value) => normalizeEmail(value, field))),
  );
  if (requireOne && normalized.length === 0) {
    throw new BadRequestException(`${field} must contain at least one email`);
  }
  return normalized;
}

function normalizeOptionalName(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value.trim().length === 0) {
    return null;
  }
  return value.trim().slice(0, MAX_NAME_LENGTH);
}

function normalizeLimitedText(
  value: string | null | undefined,
  maxLength: number,
): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function normalizeBody(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return value.slice(0, MAX_BODY_LENGTH);
}

function buildPreview(
  snippet: string,
  bodyText: string | null,
  bodyHtml: string | null,
): string {
  const candidate = snippet || bodyText || stripHtml(bodyHtml ?? "");
  return candidate.replace(/\s+/g, " ").trim().slice(0, MAX_PREVIEW_LENGTH);
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]*>/g, " ");
}

function resolveArtifactContactEmail(
  recipientRef: string | null,
  toEmails: readonly string[],
): string {
  if (recipientRef) {
    const candidate = recipientRef.trim().toLowerCase();
    if (EMAIL_RE.test(candidate)) {
      if (toEmails.includes(candidate)) return candidate;
      throw new ConflictException(
        "Delivered Gmail recipient does not match the reviewed artifact",
      );
    }
  }
  const first = toEmails[0];
  if (!first) {
    throw new BadRequestException("Delivered Gmail message has no recipient");
  }
  return first;
}
