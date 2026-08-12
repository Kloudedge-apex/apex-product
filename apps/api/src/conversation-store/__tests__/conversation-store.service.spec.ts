import {
  ConversationDirection,
  ConversationIntelligenceStatus,
  FollowUpSource,
  FollowUpStatus,
  OutreachArtifactPurpose,
  OutreachArtifactStatus,
  OutreachChannel,
} from "@prisma/client";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaService } from "../../prisma/prisma.service";
import { ConversationStoreService } from "../conversation-store.service";

const SENT_AT = new Date("2026-08-12T09:30:00.000Z");
const CREATED_AT = new Date("2026-08-01T00:00:00.000Z");

function conversationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "conversation_1",
    orgId: "org_1",
    integrationId: "gmail_1",
    providerThreadId: "thread_1",
    personId: null,
    contactEmail: "prospect@example.com",
    contactName: "Prospect",
    subject: "Re: Intro",
    lastMessagePreview: "Earlier message",
    lastMessageAt: new Date("2026-08-11T09:30:00.000Z"),
    lastInboundAt: null,
    lastOutboundAt: new Date("2026-08-11T09:30:00.000Z"),
    unreadCount: 0,
    needsReply: false,
    archivedAt: null,
    sequenceStoppedAt: null,
    sequenceStopReason: null,
    sentiment: null,
    sentimentConfidence: null,
    nextBestAction: null,
    nextBestActionType: null,
    intelligenceStatus: ConversationIntelligenceStatus.PENDING,
    intelligenceError: null,
    intelligenceUpdatedAt: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

function messageRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "message_1",
    orgId: "org_1",
    conversationId: "conversation_1",
    direction: ConversationDirection.INBOUND,
    providerMessageId: "gmail_message_1",
    internetMessageId: "<reply@example.com>",
    senderEmail: "prospect@example.com",
    senderName: "Prospect",
    toEmails: ["seller@example.com"],
    ccEmails: [],
    subject: "Re: Intro",
    bodyText: "Interested - can you send details?",
    bodyHtml: null,
    sentAt: SENT_AT,
    readAt: null,
    outreachArtifactId: null,
    createdAt: CREATED_AT,
    ...overrides,
  };
}

function artifactRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "artifact_1",
    orgId: "org_1",
    graphRunId: null,
    purpose: OutreachArtifactPurpose.OUTBOUND,
    conversationId: null,
    providerThreadId: null,
    replyToMessageId: null,
    toolName: "send_email",
    channel: OutreachChannel.EMAIL,
    recipientRef: "prospect@example.com",
    subject: "Intro",
    bodyText: "Hello",
    bodyHtml: null,
    payload: {},
    status: OutreachArtifactStatus.SENDING,
    reviewerNote: null,
    reviewedBy: "user_1",
    reviewedAt: CREATED_AT,
    sentAt: null,
    sendReceiptId: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

function makePrisma() {
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    integration: { findFirst: vi.fn() },
    emailCandidate: { findMany: vi.fn() },
    person: { findFirst: vi.fn() },
    conversation: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    conversationMessage: {
      createMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    outreachArtifact: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      update: vi.fn(),
    },
    followUpTask: { updateMany: vi.fn() },
  };
  const prisma = {
    $transaction: vi.fn(async (operation: (client: typeof tx) => unknown) =>
      operation(tx),
    ),
  };
  return { prisma, tx };
}

const inboundInput = {
  orgId: "org_1",
  integrationId: "gmail_1",
  providerThreadId: "thread_1",
  providerMessageId: "gmail_message_1",
  internetMessageId: "<reply@example.com>",
  senderEmail: "Prospect@Example.com",
  senderName: "Prospect",
  toEmails: ["Seller@Example.com"],
  subject: "Re: Intro",
  bodyText: "Interested - can you send details?",
  sentAt: SENT_AT,
};

const outboundInput = {
  orgId: "org_1",
  integrationId: "gmail_1",
  artifactId: "artifact_1",
  providerThreadId: "thread_1",
  providerMessageId: "gmail_sent_1",
  internetMessageId: "<sent@example.com>",
  senderEmail: "seller@example.com",
  toEmails: ["prospect@example.com"],
  subject: "Intro",
  bodyText: "Hello",
  sentAt: SENT_AT,
};

describe("ConversationStoreService", () => {
  let prisma: ReturnType<typeof makePrisma>["prisma"];
  let tx: ReturnType<typeof makePrisma>["tx"];
  let service: ConversationStoreService;

  beforeEach(() => {
    ({ prisma, tx } = makePrisma());
    service = new ConversationStoreService(
      prisma as unknown as PrismaService,
    );
    tx.integration.findFirst.mockResolvedValue({ id: "gmail_1" });
    tx.emailCandidate.findMany.mockResolvedValue([]);
  });

  describe("recordInboundGmailMessage", () => {
    it("ignores an unrelated inbox thread instead of creating a conversation", async () => {
      tx.conversation.findUnique.mockResolvedValue(null);
      tx.outreachArtifact.findFirst.mockResolvedValue(null);

      await expect(
        service.recordInboundGmailMessage(inboundInput),
      ).resolves.toEqual({
        correlated: false,
        reason: "UNMATCHED_THREAD",
      });

      expect(tx.outreachArtifact.findFirst).toHaveBeenCalledWith({
        where: {
          orgId: "org_1",
          channel: OutreachChannel.EMAIL,
          status: OutreachArtifactStatus.SENT,
          providerThreadId: "thread_1",
        },
        orderBy: { sentAt: "desc" },
        select: { id: true },
      });
      expect(tx.conversation.upsert).not.toHaveBeenCalled();
      expect(tx.followUpTask.updateMany).not.toHaveBeenCalled();
    });

    it("materializes a correlated reply and stops agent sequence work", async () => {
      const before = conversationRow();
      const after = conversationRow({
        contactEmail: "prospect@example.com",
        lastInboundAt: SENT_AT,
        lastMessageAt: SENT_AT,
        unreadCount: 1,
        needsReply: true,
        sequenceStoppedAt: SENT_AT,
        sequenceStopReason: "gmail_reply_received",
      });
      const message = messageRow();
      tx.conversation.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(after);
      tx.outreachArtifact.findFirst.mockResolvedValue({ id: "artifact_1" });
      tx.conversation.upsert.mockResolvedValue(before);
      tx.outreachArtifact.updateMany.mockResolvedValue({ count: 1 });
      tx.conversationMessage.createMany.mockResolvedValue({ count: 1 });
      tx.conversationMessage.findUnique.mockResolvedValue(message);
      tx.conversation.update.mockResolvedValue(after);
      tx.followUpTask.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.recordInboundGmailMessage(inboundInput);

      expect(result).toEqual({
        correlated: true,
        created: true,
        conversation: after,
        message,
      });
      expect(tx.conversationMessage.createMany).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({
            orgId: "org_1",
            conversationId: "conversation_1",
            direction: ConversationDirection.INBOUND,
            senderEmail: "prospect@example.com",
            toEmails: ["seller@example.com"],
          }),
        ],
        skipDuplicates: true,
      });
      expect(tx.conversation.update).toHaveBeenCalledWith({
        where: {
          id_orgId: { id: "conversation_1", orgId: "org_1" },
        },
        data: {
          archivedAt: null,
          unreadCount: { increment: 1 },
        },
      });
      expect(tx.conversation.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: "conversation_1",
            orgId: "org_1",
            lastMessageAt: { lte: SENT_AT },
          }),
          data: expect.objectContaining({
            needsReply: true,
            intelligenceStatus: ConversationIntelligenceStatus.PENDING,
          }),
        }),
      );
      expect(tx.followUpTask.updateMany).toHaveBeenCalledWith({
        where: {
          orgId: "org_1",
          conversationId: "conversation_1",
          status: FollowUpStatus.OPEN,
          source: FollowUpSource.AGENT,
        },
        data: expect.objectContaining({
          status: FollowUpStatus.CANCELLED,
          cancellationReason: "gmail_reply_received",
        }),
      });
      expect("outreachSuppression" in tx).toBe(false);
      expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
      const lockCall = tx.$queryRaw.mock.calls[0] as unknown[];
      expect((lockCall[0] as readonly string[]).join("?")).toContain(
        "pg_advisory_xact_lock",
      );
      expect(lockCall[1]).toBe("outreach-send-reservation:org_1");
      expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        tx.conversation.update.mock.invocationCallOrder[0],
      );
    });

    it("returns a duplicate provider message without changing derived state", async () => {
      const conversation = conversationRow({
        lastInboundAt: SENT_AT,
        lastMessageAt: SENT_AT,
        unreadCount: 1,
        needsReply: true,
      });
      const message = messageRow();
      tx.conversation.findUnique.mockResolvedValue(conversation);
      tx.conversation.upsert.mockResolvedValue(conversation);
      tx.outreachArtifact.updateMany.mockResolvedValue({ count: 0 });
      tx.conversationMessage.createMany.mockResolvedValue({ count: 0 });
      tx.conversationMessage.findUnique.mockResolvedValue(message);

      await expect(
        service.recordInboundGmailMessage(inboundInput),
      ).resolves.toEqual({
        correlated: true,
        created: false,
        conversation,
        message,
      });
      expect(tx.conversation.update).not.toHaveBeenCalled();
      expect(tx.conversation.updateMany).not.toHaveBeenCalled();
      expect(tx.followUpTask.updateMany).not.toHaveBeenCalled();
      expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
      expect(tx.$queryRaw.mock.calls[0]?.[1]).toBe(
        "outreach-send-reservation:org_1",
      );
    });

    it("fails closed when the Gmail integration is not owned by the org", async () => {
      tx.integration.findFirst.mockResolvedValue(null);

      await expect(
        service.recordInboundGmailMessage({
          ...inboundInput,
          integrationId: "other_org_gmail",
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(tx.integration.findFirst).toHaveBeenCalledWith({
        where: {
          id: "other_org_gmail",
          orgId: "org_1",
          provider: "gmail",
        },
        select: { id: true },
      });
      expect(tx.conversation.findUnique).not.toHaveBeenCalled();
    });

    it("links an exact case-insensitive email candidate from the same org", async () => {
      const before = conversationRow({ personId: null });
      const after = conversationRow({
        personId: "person_1",
        lastInboundAt: SENT_AT,
        lastMessageAt: SENT_AT,
      });
      tx.conversation.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(after);
      tx.outreachArtifact.findFirst.mockResolvedValue({ id: "artifact_1" });
      tx.emailCandidate.findMany.mockResolvedValue([{ personId: "person_1" }]);
      tx.conversation.upsert.mockResolvedValue(before);
      tx.outreachArtifact.updateMany.mockResolvedValue({ count: 1 });
      tx.conversationMessage.createMany.mockResolvedValue({ count: 1 });
      tx.conversationMessage.findUnique.mockResolvedValue(messageRow());
      tx.conversation.updateMany.mockResolvedValue({ count: 1 });
      tx.followUpTask.updateMany.mockResolvedValue({ count: 0 });

      await service.recordInboundGmailMessage(inboundInput);

      expect(tx.emailCandidate.findMany).toHaveBeenCalledWith({
        where: {
          email: {
            equals: "prospect@example.com",
            mode: "insensitive",
          },
          person: { company: { orgId: "org_1" } },
        },
        select: { personId: true },
      });
      expect(tx.conversation.updateMany).toHaveBeenCalledWith({
        where: {
          id: "conversation_1",
          orgId: "org_1",
          personId: null,
        },
        data: { personId: "person_1" },
      });
    });
  });

  describe("recordDeliveredGmailArtifact", () => {
    it("does not promote an artifact that has not passed the send gates", async () => {
      tx.outreachArtifact.findFirst.mockResolvedValue(
        artifactRow({ status: OutreachArtifactStatus.PENDING_REVIEW }),
      );

      await expect(
        service.recordDeliveredGmailArtifact(outboundInput),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(tx.conversation.upsert).not.toHaveBeenCalled();
      expect(tx.outreachArtifact.updateMany).not.toHaveBeenCalled();
      expect(tx.conversationMessage.create).not.toHaveBeenCalled();
    });

    it("fails if a SENDING claim changes before the guarded delivery update", async () => {
      tx.outreachArtifact.findFirst.mockResolvedValue(artifactRow());
      tx.conversation.upsert.mockResolvedValue(conversationRow());
      tx.outreachArtifact.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.recordDeliveredGmailArtifact(outboundInput),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(tx.outreachArtifact.findUnique).not.toHaveBeenCalled();
      expect(tx.conversationMessage.createMany).not.toHaveBeenCalled();
    });

    it("rejects a delivered recipient that differs from the reviewed email", async () => {
      tx.outreachArtifact.findFirst.mockResolvedValue(
        artifactRow({ recipientRef: "reviewed@example.com" }),
      );

      await expect(
        service.recordDeliveredGmailArtifact(outboundInput),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(tx.conversation.upsert).not.toHaveBeenCalled();
      expect(tx.outreachArtifact.updateMany).not.toHaveBeenCalled();
    });

    it("records a delivered SENDING artifact and its outbound Gmail message", async () => {
      const artifact = artifactRow();
      const sentArtifact = artifactRow({
        status: OutreachArtifactStatus.SENT,
        sentAt: SENT_AT,
        sendReceiptId: "gmail_sent_1",
        providerThreadId: "thread_1",
        conversationId: "conversation_1",
      });
      const before = conversationRow({
        lastMessageAt: new Date("2026-08-11T09:30:00.000Z"),
      });
      const after = conversationRow({
        lastMessageAt: SENT_AT,
        lastOutboundAt: SENT_AT,
        lastMessagePreview: "Hello",
      });
      const message = messageRow({
        direction: ConversationDirection.OUTBOUND,
        providerMessageId: "gmail_sent_1",
        internetMessageId: "<sent@example.com>",
        senderEmail: "seller@example.com",
        senderName: null,
        toEmails: ["prospect@example.com"],
        subject: "Intro",
        bodyText: "Hello",
        outreachArtifactId: "artifact_1",
      });
      tx.outreachArtifact.findFirst.mockResolvedValue(artifact);
      tx.conversation.upsert.mockResolvedValue(before);
      tx.outreachArtifact.updateMany.mockResolvedValue({ count: 1 });
      tx.outreachArtifact.findUnique.mockResolvedValue(sentArtifact);
      tx.conversationMessage.createMany.mockResolvedValue({ count: 1 });
      tx.conversationMessage.findUnique.mockResolvedValue(message);
      tx.conversation.findUnique.mockResolvedValue(after);
      tx.conversation.updateMany.mockResolvedValue({ count: 1 });

      await expect(
        service.recordDeliveredGmailArtifact(outboundInput),
      ).resolves.toEqual({
        created: true,
        conversation: after,
        message,
        artifact: sentArtifact,
      });
      expect(tx.outreachArtifact.updateMany).toHaveBeenCalledWith({
        where: expect.objectContaining({
          id: "artifact_1",
          orgId: "org_1",
          status: {
            in: [
              OutreachArtifactStatus.SENDING,
              OutreachArtifactStatus.SENT,
            ],
          },
        }),
        data: {
          status: OutreachArtifactStatus.SENT,
          sentAt: SENT_AT,
          sendReceiptId: "gmail_sent_1",
          providerThreadId: "thread_1",
          conversationId: "conversation_1",
        },
      });
      expect(tx.conversationMessage.createMany).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({
            orgId: "org_1",
            direction: ConversationDirection.OUTBOUND,
            outreachArtifactId: "artifact_1",
          }),
        ],
        skipDuplicates: true,
      });
      expect(tx.conversation.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ needsReply: false }),
        }),
      );
    });

    it("replays an already-recorded delivery without creating another message", async () => {
      const artifact = artifactRow({
        status: OutreachArtifactStatus.SENT,
        sentAt: SENT_AT,
        sendReceiptId: "gmail_sent_1",
        providerThreadId: "thread_1",
        conversationId: "conversation_1",
      });
      const conversation = conversationRow({
        lastMessageAt: SENT_AT,
        lastOutboundAt: SENT_AT,
      });
      const message = messageRow({
        direction: ConversationDirection.OUTBOUND,
        providerMessageId: "gmail_sent_1",
        outreachArtifactId: "artifact_1",
      });
      tx.outreachArtifact.findFirst.mockResolvedValue(artifact);
      tx.conversation.upsert.mockResolvedValue(conversation);
      tx.outreachArtifact.updateMany.mockResolvedValue({ count: 1 });
      tx.outreachArtifact.findUnique.mockResolvedValue(artifact);
      tx.conversationMessage.createMany.mockResolvedValue({ count: 0 });
      tx.conversationMessage.findUnique.mockResolvedValue(message);

      await expect(
        service.recordDeliveredGmailArtifact(outboundInput),
      ).resolves.toEqual({
        created: false,
        conversation,
        message,
        artifact,
      });
      expect(tx.conversationMessage.createMany).toHaveBeenCalledOnce();
      expect(tx.conversation.update).not.toHaveBeenCalled();
      expect(tx.conversation.updateMany).not.toHaveBeenCalled();
    });
  });
});
