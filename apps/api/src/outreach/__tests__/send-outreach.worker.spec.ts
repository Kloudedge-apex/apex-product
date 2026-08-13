import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  OutreachArtifact,
  OutreachArtifactPurpose,
  OutreachArtifactStatus,
  OutreachChannel,
} from "@prisma/client";
import {
  SendOutreachWorker,
  isLiveSendAllowedForOrg,
  getDailySendCapPerOrg,
} from "../send-outreach.worker";
import { OutreachSendQueueService } from "../outreach-send-queue.service";
import { PrismaService } from "../../prisma/prisma.service";
import { IntegrationsService } from "../../integrations/integrations.service";
import { EvidenceLedgerService } from "../../observability/evidence-ledger.service";
import {
  EMAIL_DISPATCH_OUTCOME,
  SendEmailTool,
} from "../../runtime/tools/send-email.tool";
import { LinkedInSendMessageTool } from "../../runtime/tools/linkedin-send-message.tool";

function artifactRow(overrides: Partial<OutreachArtifact> = {}): OutreachArtifact {
  const now = new Date("2026-05-25T12:00:00Z");
  return {
    id: "art_1",
    orgId: "org_1",
    graphRunId: "graph_1",
    purpose: OutreachArtifactPurpose.OUTBOUND,
    conversationId: null,
    providerThreadId: null,
    replyToMessageId: null,
    toolName: "send_email",
    channel: OutreachChannel.EMAIL,
    recipientRef: "dest@example.com",
    subject: "Hi",
    bodyText: "Body",
    bodyHtml: null,
    payload: {
      to: "dest@example.com",
      subject: "Hi",
      body: "Body",
      bodyContentType: "text",
      personId: "person_1",
      recipient_provenance: {
        candidateId: "email_1",
        email: "dest@example.com",
        source: "PATTERN_GUESS",
        verified: true,
        verificationResult: "VALID",
        confidence: 0.9,
        verifiedAt: "2026-05-24T12:00:00.000Z",
        selectionBasis: "VERIFIED_VALID",
      },
      qaIssues: [],
      brief_facts: [
        {
          id: "S1",
          category: "signal",
          source: "https://example.com/source",
          text: "Acme launched a new product.",
        },
      ],
      groundedness_self_check: {
        citedFactIds: ["S1"],
        unsupportedClaims: [],
      },
    },
    status: OutreachArtifactStatus.APPROVED,
    reviewerNote: null,
    reviewedBy: "user_x",
    reviewedAt: now,
    sentAt: null,
    sendReceiptId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function mockPrisma() {
  const prisma = {
    // The reservation phase uses one short interactive transaction. Tests
    // run the callback against this same mock client and keep provider calls
    // observable after the callback resolves (the commit boundary).
    $transaction: vi.fn(),
    // First call acquires the advisory lock; a second call (when applicable)
    // performs the normalized recipient-risk lookup.
    $queryRaw: vi.fn().mockResolvedValue([]),
    outreachArtifact: {
      findUnique: vi.fn(),
      update: vi.fn(),
      // CAS claim/release path (audit B6). Default count=1 ("we won the
      // claim") so existing happy-path tests proceed without modification.
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findMany: vi.fn(),
      // Used by reconcile paths; send reservation recipient matching is raw
      // SQL so it can trim and case-fold both sides in PostgreSQL.
      findFirst: vi.fn().mockResolvedValue(null),
      // GL8a daily-cap count. Default 0 ("no sends today") — under cap.
      count: vi.fn().mockResolvedValue(0),
    },
    integration: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    conversation: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
    conversationMessage: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
    person: {
      findFirst: vi.fn().mockResolvedValue({
        emails: [
          {
            id: "email_1",
            email: "dest@example.com",
            source: "PATTERN_GUESS",
            verified: true,
            verificationResult: "VALID",
            confidence: 0.9,
            verifiedAt: new Date("2026-05-24T12:00:00.000Z"),
            createdAt: new Date("2026-05-23T12:00:00.000Z"),
          },
        ],
      }),
    },
    // CAN-SPAM postal-address fetch added by audit P0 #2. Default to an
    // org with a configured physicalAddress so existing happy-path tests
    // proceed without modification.
    org: {
      findUnique: vi.fn().mockResolvedValue({
        id: "org_1",
        name: "Acme Inc",
        physicalAddress: "123 Main St, Springfield IL 62704",
        country: "US",
        senderName: "Acme Sales",
      }),
    },
  } as unknown as PrismaService & {
    $transaction: ReturnType<typeof vi.fn>;
    $queryRaw: ReturnType<typeof vi.fn>;
    outreachArtifact: {
      findUnique: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
      findFirst: ReturnType<typeof vi.fn>;
      count: ReturnType<typeof vi.fn>;
    };
    integration: {
      findMany: ReturnType<typeof vi.fn>;
      findFirst: ReturnType<typeof vi.fn>;
    };
    conversation: { findFirst: ReturnType<typeof vi.fn> };
    conversationMessage: { findFirst: ReturnType<typeof vi.fn> };
    person: { findFirst: ReturnType<typeof vi.fn> };
    org: { findUnique: ReturnType<typeof vi.fn> };
  };
  prisma.$transaction.mockImplementation(
    async (callback: (tx: typeof prisma) => Promise<unknown>) =>
      callback(prisma),
  );
  return prisma;
}

/**
 * Minimal stand-in for the BullMQ Queue surface requeueArtifact touches.
 * Tests inject it through mockQueue(bullQueue) to exercise the completed-
 * jobId cleanup (GL8a deferred-send interplay).
 */
interface FakeBullQueue {
  getJob: ReturnType<typeof vi.fn>;
}

function fakeBullJob(completed: boolean) {
  return {
    isCompleted: vi.fn(async () => completed),
    remove: vi.fn(async () => undefined),
  };
}

function mockQueue(bullQueue: FakeBullQueue | null = null): OutreachSendQueueService & {
  enqueue: ReturnType<typeof vi.fn>;
} {
  return {
    isBullMode: () => bullQueue !== null,
    getBullQueue: () => bullQueue,
    getConnection: () => null,
    enqueue: vi.fn().mockResolvedValue(undefined),
    onModuleDestroy: vi.fn(),
  } as unknown as OutreachSendQueueService & {
    enqueue: ReturnType<typeof vi.fn>;
  };
}

function mockIntegrations(): IntegrationsService {
  return {
    refreshTokenIfNeeded: vi.fn().mockResolvedValue(null),
  } as unknown as IntegrationsService;
}

function mockLedger() {
  return {
    messageSent: vi.fn().mockResolvedValue(undefined),
  } as unknown as EvidenceLedgerService & {
    messageSent: ReturnType<typeof vi.fn>;
  };
}

function mockConversationStore() {
  return {
    recordDeliveredGmailArtifact: vi.fn().mockResolvedValue({
      conversationId: "conv_1",
      messageId: "msg_1",
      created: true,
    }),
  };
}

describe("SendOutreachWorker.processArtifact", () => {
  let prisma: ReturnType<typeof mockPrisma>;
  let queue: ReturnType<typeof mockQueue>;
  let integrations: IntegrationsService;
  let ledger: ReturnType<typeof mockLedger>;
  let worker: SendOutreachWorker;

  beforeEach(() => {
    // Reset prototype spies between tests — otherwise a previous test's spy
    // remains active and intercepts subsequent .execute() calls, defeating
    // the "should not be called" assertions in idempotency / org-mismatch
    // tests where we explicitly want the real method path.
    vi.restoreAllMocks();
    prisma = mockPrisma();
    queue = mockQueue();
    integrations = mockIntegrations();
    ledger = mockLedger();
    // Suppression service stub: by default no recipient is suppressed, so
    // the worker proceeds to dispatch. The suppression check was added in
    // audit P0 #3 (CAN-SPAM List-Unsubscribe + Suppression table).
    const suppression = {
      isSuppressed: vi.fn(async () => false),
      isSuppressedInTransaction: vi.fn(async () => false),
    } as unknown as Parameters<typeof SendOutreachWorker>[3];
    worker = new SendOutreachWorker(
      prisma as unknown as PrismaService,
      queue,
      integrations,
      suppression,
      ledger,
    );
  });

  it("sends an APPROVED EMAIL artifact (allowlisted org) and flips it to SENT with a receipt", async () => {
    process.env.OUTREACH_LIVE_FOR_ORGS = "org_1";
    try {
      prisma.outreachArtifact.findUnique.mockResolvedValue(artifactRow());
      prisma.outreachArtifact.update.mockResolvedValue(
        artifactRow({ status: OutreachArtifactStatus.SENT }),
      );
      const sendSpy = vi
        .spyOn(SendEmailTool.prototype, "execute")
        .mockResolvedValueOnce({
          success: true,
          data: {
            sent: true,
            provider: "gmail",
            dispatchOutcome: EMAIL_DISPATCH_OUTCOME.CONFIRMED_SENT,
            messageId: "gmail_123",
            to: "dest@example.com",
            subject: "Hi",
          },
        });

      await worker.processArtifact("art_1", "org_1");

      // CAS claim must precede dispatch (audit B6): updateMany flips
      // APPROVED → SENDING so concurrent workers can't double-send.
      expect(prisma.outreachArtifact.updateMany).toHaveBeenCalledWith({
        where: {
          id: "art_1",
          orgId: "org_1",
          status: OutreachArtifactStatus.APPROVED,
        },
        data: { status: OutreachArtifactStatus.SENDING },
      });
      const claimOrder =
        prisma.outreachArtifact.updateMany.mock.invocationCallOrder[0];
      const dispatchOrder = sendSpy.mock.invocationCallOrder[0];
      expect(claimOrder).toBeLessThan(dispatchOrder);
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
      const lockCall = prisma.$queryRaw.mock.calls[0] as unknown[];
      expect((lockCall[0] as readonly string[]).join("?")).toContain(
        "pg_advisory_xact_lock",
      );
      expect(lockCall[1]).toBe("outreach-send-reservation:org_1");
      expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        prisma.outreachArtifact.count.mock.invocationCallOrder[0] ??
          Number.POSITIVE_INFINITY,
      );
      expect(prisma.outreachArtifact.count.mock.invocationCallOrder[0]).toBeLessThan(
        claimOrder,
      );

      expect(prisma.outreachArtifact.update).toHaveBeenCalledWith({
        where: { id: "art_1" },
        data: expect.objectContaining({
          status: OutreachArtifactStatus.SENT,
          sendReceiptId: "gmail_123",
          sentAt: expect.any(Date),
        }),
      });
      expect(ledger.messageSent).toHaveBeenCalledWith(
        expect.objectContaining({
          artifactId: "art_1",
          orgId: "org_1",
          channel: OutreachChannel.EMAIL,
          recipientRef: "dest@example.com",
          subject: "Hi",
          sendReceiptId: "gmail_123",
          provider: "gmail",
        }),
      );
    } finally {
      delete process.env.OUTREACH_LIVE_FOR_ORGS;
    }
  });

  it("releases the claim without dispatch when the exact recipient became invalid", async () => {
    process.env.OUTREACH_LIVE_FOR_ORGS = "org_1";
    try {
      prisma.outreachArtifact.findUnique.mockResolvedValue(artifactRow());
      prisma.person.findFirst.mockResolvedValue({
        emails: [
          {
            id: "email_1",
            email: "dest@example.com",
            source: "PATTERN_GUESS",
            verified: false,
            verificationResult: "INVALID",
            confidence: 0.05,
            verifiedAt: null,
            createdAt: new Date("2026-05-23T12:00:00.000Z"),
          },
        ],
      });
      const sendSpy = vi.spyOn(SendEmailTool.prototype, "execute");

      await expect(worker.processArtifact("art_1", "org_1")).rejects.toThrow(
        "exact recipient snapshot is no longer current and eligible",
      );

      expect(sendSpy).not.toHaveBeenCalled();
      expect(prisma.outreachArtifact.updateMany).toHaveBeenLastCalledWith({
        where: {
          id: "art_1",
          status: OutreachArtifactStatus.SENDING,
        },
        data: { status: OutreachArtifactStatus.APPROVED },
      });
    } finally {
      delete process.env.OUTREACH_LIVE_FOR_ORGS;
    }
  });

  it.each([
    [
      {
        id: "org_1",
        name: "Acme Inc",
        physicalAddress: "  ",
        country: "US",
        senderName: "Acme Sales",
      },
      "missing physicalAddress",
    ],
    [
      {
        id: "org_1",
        name: "Acme Inc",
        physicalAddress: "123 Main St, Springfield IL 62704",
        country: "US",
        senderName: "   ",
      },
      "missing senderName",
    ],
    [
      {
        id: "org_1",
        name: "Acme Inc",
        physicalAddress: "123 Main St, Springfield IL 62704",
        country: "ZZ",
        senderName: "Acme Sales",
      },
      "missing a valid two-letter country",
    ],
  ])("fails closed before a live provider call when sender identity is incomplete: %s", async (org, message) => {
    process.env.OUTREACH_LIVE_FOR_ORGS = "org_1";
    try {
      prisma.outreachArtifact.findUnique.mockResolvedValue(artifactRow());
      prisma.org.findUnique.mockResolvedValue(org);
      const sendSpy = vi.spyOn(SendEmailTool.prototype, "execute");

      await expect(worker.processArtifact("art_1", "org_1")).rejects.toThrow(message);

      expect(sendSpy).not.toHaveBeenCalled();
      expect(prisma.outreachArtifact.update).not.toHaveBeenCalled();
    } finally {
      delete process.env.OUTREACH_LIVE_FOR_ORGS;
    }
  });

  it("refuses a legacy APPROVED email that fails the dispatch eligibility check", async () => {
    const unsafe = artifactRow();
    prisma.outreachArtifact.findUnique.mockResolvedValue({
      ...unsafe,
      payload: {
        ...(unsafe.payload as Record<string, unknown>),
        qaIssues: ["unsupported_claims(1)"],
      },
    });
    const sendSpy = vi.spyOn(SendEmailTool.prototype, "execute");

    await expect(worker.processArtifact("art_1", "org_1")).rejects.toThrow(
      "until all draft quality checks pass",
    );

    expect(sendSpy).not.toHaveBeenCalled();
    expect(prisma.outreachArtifact.updateMany).toHaveBeenLastCalledWith({
      where: { id: "art_1", status: OutreachArtifactStatus.SENDING },
      data: { status: OutreachArtifactStatus.APPROVED },
    });
    expect(prisma.outreachArtifact.update).not.toHaveBeenCalled();
  });

  it("commits the reservation transaction before provider I/O begins", async () => {
    process.env.OUTREACH_LIVE_FOR_ORGS = "org_1";
    try {
      prisma.outreachArtifact.findUnique.mockResolvedValue(artifactRow());
      prisma.outreachArtifact.update.mockResolvedValue(
        artifactRow({ status: OutreachArtifactStatus.SENT }),
      );
      const transactionCommitted = vi.fn();
      prisma.$transaction.mockImplementationOnce(
        async (
          callback: (tx: typeof prisma) => Promise<unknown>,
        ): Promise<unknown> => {
          const result = await callback(prisma);
          transactionCommitted();
          return result;
        },
      );
      const sendSpy = vi
        .spyOn(SendEmailTool.prototype, "execute")
        .mockResolvedValueOnce({
          success: true,
          data: {
            sent: true,
            provider: "gmail",
            dispatchOutcome: EMAIL_DISPATCH_OUTCOME.CONFIRMED_SENT,
            messageId: "gmail_after_commit",
          },
        });

      await worker.processArtifact("art_1", "org_1");

      expect(transactionCommitted).toHaveBeenCalledTimes(1);
      expect(transactionCommitted.mock.invocationCallOrder[0]).toBeLessThan(
        sendSpy.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
      );
    } finally {
      delete process.env.OUTREACH_LIVE_FOR_ORGS;
    }
  });

  it("marks forced-mock sends SIMULATED (not SENT) and keeps the mock receipt", async () => {
    // org_1 is NOT in OUTREACH_LIVE_FOR_ORGS (env unset) → forced-mock path.
    prisma.outreachArtifact.findUnique.mockResolvedValue(artifactRow());
    prisma.outreachArtifact.update.mockResolvedValue(
      artifactRow({ status: OutreachArtifactStatus.SIMULATED }),
    );
    vi.spyOn(SendEmailTool.prototype, "execute").mockResolvedValueOnce({
      success: true,
      data: {
        sent: false,
        mock: true,
        provider: "mock",
        messageId: "mock_123",
        to: "dest@example.com",
        subject: "Hi",
      },
    });

    await worker.processArtifact("art_1", "org_1");

    expect(prisma.outreachArtifact.update).toHaveBeenCalledWith({
      where: { id: "art_1" },
      data: expect.objectContaining({
        status: OutreachArtifactStatus.SIMULATED,
        sendReceiptId: "mock_123",
      }),
    });
    // sentAt must stay null for simulated sends — nothing was delivered, and
    // DashboardService.stats counts emailsSent via sentAt != null.
    const simulatedUpdate = prisma.outreachArtifact.update.mock
      .calls[0]?.[0] as { data: Record<string, unknown> };
    expect(simulatedUpdate.data).not.toHaveProperty("sentAt");
    // The audit trail still records the attempt — with the mock provider so
    // nothing downstream mistakes it for delivered mail.
    expect(ledger.messageSent).toHaveBeenCalledWith(
      expect.objectContaining({
        artifactId: "art_1",
        sendReceiptId: "mock_123",
        provider: "mock",
      }),
    );
  });

  it("skips cleanly when another worker already claimed the artifact (CAS count 0)", async () => {
    prisma.outreachArtifact.findUnique.mockResolvedValue(artifactRow());
    // The CAS lost the race: between the findUnique and the claim, another
    // worker flipped the row to SENDING.
    prisma.outreachArtifact.updateMany.mockResolvedValueOnce({ count: 0 });
    const sendSpy = vi.spyOn(SendEmailTool.prototype, "execute");

    await expect(
      worker.processArtifact("art_1", "org_1"),
    ).resolves.toBeUndefined();

    expect(sendSpy).not.toHaveBeenCalled();
    expect(prisma.outreachArtifact.update).not.toHaveBeenCalled();
    expect(ledger.messageSent).not.toHaveBeenCalled();
  });

  it("is idempotent: a row already in SENT status is a no-op", async () => {
    prisma.outreachArtifact.findUnique.mockResolvedValue(
      artifactRow({
        status: OutreachArtifactStatus.SENT,
        sentAt: new Date(),
        sendReceiptId: "prev_id",
      }),
    );
    const sendSpy = vi.spyOn(SendEmailTool.prototype, "execute");

    await worker.processArtifact("art_1", "org_1");

    expect(sendSpy).not.toHaveBeenCalled();
    expect(prisma.outreachArtifact.update).not.toHaveBeenCalled();
    expect(ledger.messageSent).not.toHaveBeenCalled();
  });

  it("never re-dispatches a terminal DELIVERY_UNKNOWN artifact", async () => {
    prisma.outreachArtifact.findUnique.mockResolvedValue(
      artifactRow({
        status: OutreachArtifactStatus.DELIVERY_UNKNOWN,
        reviewerNote: "delivery-unknown: response lost",
      }),
    );
    const sendSpy = vi.spyOn(SendEmailTool.prototype, "execute");

    await worker.processArtifact("art_1", "org_1");

    expect(sendSpy).not.toHaveBeenCalled();
    expect(prisma.outreachArtifact.updateMany).not.toHaveBeenCalled();
    expect(prisma.outreachArtifact.update).not.toHaveBeenCalled();
  });

  it("aborts when the artifact belongs to a different org", async () => {
    prisma.outreachArtifact.findUnique.mockResolvedValue(
      artifactRow({ orgId: "other_org" }),
    );
    const sendSpy = vi.spyOn(SendEmailTool.prototype, "execute");

    await worker.processArtifact("art_1", "org_1");

    expect(sendSpy).not.toHaveBeenCalled();
    expect(prisma.outreachArtifact.update).not.toHaveBeenCalled();
  });

  it("retries after a provider response confirms the message was not sent", async () => {
    process.env.OUTREACH_LIVE_FOR_ORGS = "org_1";
    try {
      prisma.outreachArtifact.findUnique.mockResolvedValue(artifactRow());
      vi.spyOn(SendEmailTool.prototype, "execute").mockResolvedValueOnce({
        success: false,
        data: {
          sent: false,
          provider: "outlook",
          dispatchOutcome: EMAIL_DISPATCH_OUTCOME.CONFIRMED_NOT_SENT,
        },
        error: "Graph API error 503: upstream down",
      });

      await expect(worker.processArtifact("art_1", "org_1")).rejects.toThrow(
        /upstream down/,
      );

      // Critically: the SENDING claim is released back to APPROVED on a
      // confirmed rejection so BullMQ's next attempt can safely re-claim it.
      expect(prisma.outreachArtifact.updateMany).toHaveBeenCalledWith({
        where: { id: "art_1", status: OutreachArtifactStatus.SENDING },
        data: { status: OutreachArtifactStatus.APPROVED },
      });
      expect(prisma.outreachArtifact.update).not.toHaveBeenCalled();
      expect(ledger.messageSent).not.toHaveBeenCalled();
    } finally {
      delete process.env.OUTREACH_LIVE_FOR_ORGS;
    }
  });

  it("moves an ambiguous live-provider result to terminal DELIVERY_UNKNOWN without throwing", async () => {
    process.env.OUTREACH_LIVE_FOR_ORGS = "org_1";
    try {
      prisma.outreachArtifact.findUnique.mockResolvedValue(artifactRow());
      vi.spyOn(SendEmailTool.prototype, "execute").mockResolvedValueOnce({
        success: false,
        data: {
          sent: false,
          provider: "gmail",
          dispatchOutcome: EMAIL_DISPATCH_OUTCOME.DELIVERY_UNKNOWN,
        },
        error: "socket closed before response",
      });

      await expect(
        worker.processArtifact("art_1", "org_1"),
      ).resolves.toBeUndefined();

      expect(prisma.outreachArtifact.updateMany).toHaveBeenLastCalledWith({
        where: { id: "art_1", status: OutreachArtifactStatus.SENDING },
        data: expect.objectContaining({
          status: OutreachArtifactStatus.DELIVERY_UNKNOWN,
          reviewerNote: expect.stringContaining("automatic retry disabled"),
        }),
      });
      expect(prisma.outreachArtifact.update).not.toHaveBeenCalled();
      expect(ledger.messageSent).not.toHaveBeenCalled();
    } finally {
      delete process.env.OUTREACH_LIVE_FOR_ORGS;
    }
  });

  it("fails closed to DELIVERY_UNKNOWN for an unclassified live email failure", async () => {
    process.env.OUTREACH_LIVE_FOR_ORGS = "org_1";
    try {
      prisma.outreachArtifact.findUnique.mockResolvedValue(artifactRow());
      vi.spyOn(SendEmailTool.prototype, "execute").mockResolvedValueOnce({
        success: false,
        data: { sent: false, provider: "gmail" },
        error: "legacy tool failure",
      });

      await worker.processArtifact("art_1", "org_1");

      expect(prisma.outreachArtifact.updateMany).toHaveBeenLastCalledWith({
        where: { id: "art_1", status: OutreachArtifactStatus.SENDING },
        data: expect.objectContaining({
          status: OutreachArtifactStatus.DELIVERY_UNKNOWN,
        }),
      });
    } finally {
      delete process.env.OUTREACH_LIVE_FOR_ORGS;
    }
  });

  it("quarantines a thrown live-provider invocation instead of retrying it", async () => {
    process.env.OUTREACH_LIVE_FOR_ORGS = "org_1";
    try {
      prisma.outreachArtifact.findUnique.mockResolvedValue(artifactRow());
      vi.spyOn(SendEmailTool.prototype, "execute").mockRejectedValueOnce(
        new Error("socket hang up"),
      );

      await expect(
        worker.processArtifact("art_1", "org_1"),
      ).resolves.toBeUndefined();

      expect(prisma.outreachArtifact.updateMany).toHaveBeenCalledWith({
        where: { id: "art_1", status: OutreachArtifactStatus.SENDING },
        data: expect.objectContaining({
          status: OutreachArtifactStatus.DELIVERY_UNKNOWN,
          reviewerNote: expect.stringContaining("delivery-unknown:"),
        }),
      });
      expect(prisma.outreachArtifact.update).not.toHaveBeenCalled();
    } finally {
      delete process.env.OUTREACH_LIVE_FOR_ORGS;
    }
  });

  it("releases and retries a failure proven to occur before provider invocation", async () => {
    process.env.OUTREACH_LIVE_FOR_ORGS = "org_1";
    try {
      prisma.outreachArtifact.findUnique.mockResolvedValue(artifactRow());
      prisma.org.findUnique.mockRejectedValueOnce(new Error("database unavailable"));
      const sendSpy = vi.spyOn(SendEmailTool.prototype, "execute");

      await expect(worker.processArtifact("art_1", "org_1")).rejects.toThrow(
        "database unavailable",
      );

      expect(sendSpy).not.toHaveBeenCalled();
      expect(prisma.outreachArtifact.updateMany).toHaveBeenLastCalledWith({
        where: { id: "art_1", status: OutreachArtifactStatus.SENDING },
        data: { status: OutreachArtifactStatus.APPROVED },
      });
    } finally {
      delete process.env.OUTREACH_LIVE_FOR_ORGS;
    }
  });

  it("dispatches LINKEDIN artifacts via LinkedInSendMessageTool and flips to SENT on success", async () => {
    process.env.OUTREACH_LIVE_FOR_ORGS = "org_1";
    try {
      prisma.outreachArtifact.findUnique.mockResolvedValue(
        artifactRow({
          channel: OutreachChannel.LINKEDIN,
          recipientRef: "urn:li:person:abc",
          bodyText: "hi from apex",
          payload: { recipient_urn: "urn:li:person:abc", body: "hi from apex" },
        }),
      );
      prisma.outreachArtifact.update.mockResolvedValue(
        artifactRow({ status: OutreachArtifactStatus.SENT }),
      );
      vi.spyOn(LinkedInSendMessageTool.prototype, "execute").mockResolvedValueOnce({
        success: true,
        data: {
          sent: true,
          provider: "linkedin",
          messageId: "linkedin_msg_42",
          recipient_urn: "urn:li:person:abc",
        },
      });

      await worker.processArtifact("art_1", "org_1");

      expect(prisma.outreachArtifact.update).toHaveBeenCalledWith({
        where: { id: "art_1" },
        data: expect.objectContaining({
          status: OutreachArtifactStatus.SENT,
          sendReceiptId: "linkedin_msg_42",
          sentAt: expect.any(Date),
        }),
      });
      expect(ledger.messageSent).toHaveBeenCalledWith(
        expect.objectContaining({
          artifactId: "art_1",
          channel: OutreachChannel.LINKEDIN,
          recipientRef: "urn:li:person:abc",
          sendReceiptId: "linkedin_msg_42",
          provider: "linkedin",
        }),
      );
    } finally {
      delete process.env.OUTREACH_LIVE_FOR_ORGS;
    }
  });

  it("rethrows when LinkedIn tool reports failure (e.g. 403 api_not_available)", async () => {
    process.env.OUTREACH_LIVE_FOR_ORGS = "org_1";
    try {
      prisma.outreachArtifact.findUnique.mockResolvedValue(
        artifactRow({
          channel: OutreachChannel.LINKEDIN,
          recipientRef: "urn:li:person:abc",
          bodyText: "hi",
          payload: { recipient_urn: "urn:li:person:abc", body: "hi" },
        }),
      );
      vi.spyOn(LinkedInSendMessageTool.prototype, "execute").mockResolvedValueOnce({
        success: false,
        data: {
          sent: false,
          provider: "linkedin",
          error: "linkedin_api_not_available",
          status: 403,
        },
        error: "linkedin_api_not_available",
      });

      await expect(worker.processArtifact("art_1", "org_1")).rejects.toThrow(
        /linkedin_api_not_available/,
      );
      expect(prisma.outreachArtifact.updateMany).toHaveBeenLastCalledWith({
        where: { id: "art_1", status: OutreachArtifactStatus.SENDING },
        data: { status: OutreachArtifactStatus.APPROVED },
      });
      expect(prisma.outreachArtifact.update).not.toHaveBeenCalled();
      expect(ledger.messageSent).not.toHaveBeenCalled();
    } finally {
      delete process.env.OUTREACH_LIVE_FOR_ORGS;
    }
  });

  it("quarantines a status-less LinkedIn transport failure", async () => {
    process.env.OUTREACH_LIVE_FOR_ORGS = "org_1";
    try {
      prisma.outreachArtifact.findUnique.mockResolvedValue(
        artifactRow({
          channel: OutreachChannel.LINKEDIN,
          recipientRef: "urn:li:person:abc",
          bodyText: "hi",
          payload: { recipient_urn: "urn:li:person:abc", body: "hi" },
        }),
      );
      vi.spyOn(LinkedInSendMessageTool.prototype, "execute").mockResolvedValueOnce({
        success: false,
        data: {
          sent: false,
          provider: "linkedin",
          error: "linkedin_send_failed",
        },
        error: "ECONNRESET",
      });

      await worker.processArtifact("art_1", "org_1");

      expect(prisma.outreachArtifact.updateMany).toHaveBeenLastCalledWith({
        where: { id: "art_1", status: OutreachArtifactStatus.SENDING },
        data: expect.objectContaining({
          status: OutreachArtifactStatus.DELIVERY_UNKNOWN,
        }),
      });
    } finally {
      delete process.env.OUTREACH_LIVE_FOR_ORGS;
    }
  });

  it("falls back to artifact.recipientRef/bodyText when payload lacks the LinkedIn fields", async () => {
    prisma.outreachArtifact.findUnique.mockResolvedValue(
      artifactRow({
        channel: OutreachChannel.LINKEDIN,
        recipientRef: "urn:li:person:legacy",
        bodyText: "legacy body",
        // payload was authored for the old EMAIL shape — no recipient_urn/body.
        payload: { to: "ignored@example.com" },
      }),
    );
    prisma.outreachArtifact.update.mockResolvedValue(
      artifactRow({ status: OutreachArtifactStatus.SENT }),
    );
    const spy = vi
      .spyOn(LinkedInSendMessageTool.prototype, "execute")
      .mockResolvedValueOnce({
        success: true,
        data: {
          sent: true,
          provider: "linkedin",
          messageId: "id_1",
          recipient_urn: "urn:li:person:legacy",
        },
      });

    await worker.processArtifact("art_1", "org_1");

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        recipient_urn: "urn:li:person:legacy",
        body: "legacy body",
      }),
      expect.any(Object),
    );
  });

  it("strips integrations when orgId is not in OUTREACH_LIVE_FOR_ORGS (forces mock branch)", async () => {
    process.env.OUTREACH_LIVE_FOR_ORGS = "org_live_a,org_live_b";
    try {
      prisma.outreachArtifact.findUnique.mockResolvedValue(
        artifactRow({ orgId: "org_blocked" }),
      );
      prisma.outreachArtifact.update.mockResolvedValue(
        artifactRow({ status: OutreachArtifactStatus.SENT }),
      );
      // Don't let prisma.integration.findMany even be called — but tolerate it
      // returning [] if it is. The contract under test is that the tool sees
      // an empty integrations Map.
      const sendSpy = vi
        .spyOn(SendEmailTool.prototype, "execute")
        .mockResolvedValueOnce({
          success: true,
          data: {
            sent: false,
            mock: true,
            provider: "mock",
            messageId: "mock_xyz",
            to: "dest@example.com",
            subject: "Hi",
          },
        });

      await worker.processArtifact("art_1", "org_blocked");

      const ctxArg = sendSpy.mock.calls[0]?.[1] as { integrations: Map<string, unknown> };
      expect(ctxArg.integrations.size).toBe(0);
      // loadIntegrations() must NOT run for blocked orgs — confirms we skipped
      // the prisma query path entirely rather than just emptying the Map.
      expect(prisma.integration.findMany).not.toHaveBeenCalled();
    } finally {
      delete process.env.OUTREACH_LIVE_FOR_ORGS;
    }
  });

  it("loads integrations when orgId IS in OUTREACH_LIVE_FOR_ORGS", async () => {
    process.env.OUTREACH_LIVE_FOR_ORGS = "org_1,org_2";
    try {
      prisma.outreachArtifact.findUnique.mockResolvedValue(artifactRow());
      prisma.outreachArtifact.update.mockResolvedValue(
        artifactRow({ status: OutreachArtifactStatus.SENT }),
      );
      vi.spyOn(SendEmailTool.prototype, "execute").mockResolvedValueOnce({
        success: true,
        data: {
          sent: true,
          provider: "gmail",
          dispatchOutcome: EMAIL_DISPATCH_OUTCOME.CONFIRMED_SENT,
          messageId: "real_1",
        },
      });

      await worker.processArtifact("art_1", "org_1");

      // Allowlisted org → loadIntegrations() runs → prisma.integration.findMany
      // is queried. We only assert the side-effect, not the result.
      expect(prisma.integration.findMany).toHaveBeenCalledWith({
        where: {
          orgId: "org_1",
          provider: "gmail",
          status: "CONNECTED",
          encryptedCredentials: { not: null },
          credentials: {
            path: ["accountEmail"],
            string_contains: "@",
          },
          lastHistoryId: { not: null },
          lastSyncAt: { gte: expect.any(Date) },
        },
      });
    } finally {
      delete process.env.OUTREACH_LIVE_FOR_ORGS;
    }
  });

  it("ignores an arbitrary provider row even if a mocked database returns it", async () => {
    process.env.OUTREACH_LIVE_FOR_ORGS = "org_1";
    try {
      prisma.outreachArtifact.findUnique.mockResolvedValue(artifactRow());
      prisma.integration.findMany.mockResolvedValue([
        { provider: "outlook" },
      ]);
      const refresh = integrations.refreshTokenIfNeeded as ReturnType<
        typeof vi.fn
      >;
      vi.spyOn(SendEmailTool.prototype, "execute").mockResolvedValueOnce({
        success: true,
        data: {
          sent: false,
          mock: true,
          provider: "mock",
          messageId: "mock_1",
        },
      });

      await expect(worker.processArtifact("art_1", "org_1")).rejects.toThrow(
        /mock mode/,
      );

      expect(refresh).not.toHaveBeenCalled();
    } finally {
      delete process.env.OUTREACH_LIVE_FOR_ORGS;
    }
  });

  it("emits messageSent EvidenceEvent on success", async () => {
    prisma.outreachArtifact.findUnique.mockResolvedValue(
      artifactRow({ graphRunId: "graph_42" }),
    );
    prisma.outreachArtifact.update.mockResolvedValue(
      artifactRow({ status: OutreachArtifactStatus.SENT }),
    );
    vi.spyOn(SendEmailTool.prototype, "execute").mockResolvedValueOnce({
      success: true,
      data: {
        sent: true,
        provider: "gmail",
        dispatchOutcome: EMAIL_DISPATCH_OUTCOME.CONFIRMED_SENT,
        messageId: "gmail_msg_99",
        to: "dest@example.com",
        subject: "Hi",
      },
    });

    await worker.processArtifact("art_1", "org_1");

    expect(ledger.messageSent).toHaveBeenCalledTimes(1);
    expect(ledger.messageSent).toHaveBeenCalledWith({
      orgId: "org_1",
      runId: "graph_42",
      artifactId: "art_1",
      channel: OutreachChannel.EMAIL,
      recipientRef: "dest@example.com",
      subject: "Hi",
      sendReceiptId: "gmail_msg_99",
      provider: "gmail",
    });
  });
});

describe("SendOutreachWorker GL2 — mock-mode result while live send is required", () => {
  let prisma: ReturnType<typeof mockPrisma>;
  let ledger: ReturnType<typeof mockLedger>;
  let worker: SendOutreachWorker;

  beforeEach(() => {
    vi.restoreAllMocks();
    prisma = mockPrisma();
    ledger = mockLedger();
    const suppression = {
      isSuppressed: vi.fn(async () => false),
      isSuppressedInTransaction: vi.fn(async () => false),
    } as unknown as Parameters<typeof SendOutreachWorker>[3];
    worker = new SendOutreachWorker(
      prisma as unknown as PrismaService,
      mockQueue(),
      mockIntegrations(),
      suppression,
      ledger,
    );
  });

  afterEach(() => {
    delete process.env.OUTREACH_LIVE_FOR_ORGS;
  });

  it("treats a mock-mode 'success' as a FAILURE for an allowlisted org — never SENT", async () => {
    process.env.OUTREACH_LIVE_FOR_ORGS = "org_1";
    prisma.outreachArtifact.findUnique.mockResolvedValue(artifactRow());
    // loadIntegrations yielded nothing usable (catch-skip path) → the tool
    // silently fell back to mockSend and reported success.
    vi.spyOn(SendEmailTool.prototype, "execute").mockResolvedValueOnce({
      success: true,
      data: {
        sent: false,
        mock: true,
        provider: "mock",
        messageId: "mock_outage_1",
        to: "dest@example.com",
        subject: "Hi",
      },
    });

    await expect(worker.processArtifact("art_1", "org_1")).rejects.toThrow(
      /mock mode.*refusing to record SENT/,
    );

    // Claim released back to APPROVED so the BullMQ retry envelope (and at
    // exhaustion the auto-failed terminal handler) owns the outcome.
    expect(prisma.outreachArtifact.updateMany).toHaveBeenCalledWith({
      where: { id: "art_1", status: OutreachArtifactStatus.SENDING },
      data: { status: OutreachArtifactStatus.APPROVED },
    });
    // No terminal SENT/SIMULATED write, no sentAt, no evidence.
    expect(prisma.outreachArtifact.update).not.toHaveBeenCalled();
    expect(ledger.messageSent).not.toHaveBeenCalled();
  });

  it("detects mock mode via provider==='mock' even without the mock flag", async () => {
    process.env.OUTREACH_LIVE_FOR_ORGS = "org_1";
    prisma.outreachArtifact.findUnique.mockResolvedValue(artifactRow());
    vi.spyOn(SendEmailTool.prototype, "execute").mockResolvedValueOnce({
      success: true,
      data: { sent: false, provider: "mock", messageId: "mock_2" },
    });

    await expect(worker.processArtifact("art_1", "org_1")).rejects.toThrow(
      /mock mode/,
    );
    expect(prisma.outreachArtifact.update).not.toHaveBeenCalled();
  });

  it("also refuses a LinkedIn mock receipt (mock:true, provider:'linkedin') for a liveAllowed org", async () => {
    process.env.OUTREACH_LIVE_FOR_ORGS = "org_1";
    prisma.outreachArtifact.findUnique.mockResolvedValue(
      artifactRow({
        channel: OutreachChannel.LINKEDIN,
        recipientRef: "urn:li:person:abc",
        bodyText: "hi",
        payload: { recipient_urn: "urn:li:person:abc", body: "hi" },
      }),
    );
    vi.spyOn(LinkedInSendMessageTool.prototype, "execute").mockResolvedValueOnce({
      success: true,
      data: {
        sent: false,
        mock: true,
        provider: "linkedin",
        messageId: "mock_linkedin_1",
      },
    });

    await expect(worker.processArtifact("art_1", "org_1")).rejects.toThrow(
      /mock mode/,
    );
    expect(prisma.outreachArtifact.update).not.toHaveBeenCalled();
    expect(ledger.messageSent).not.toHaveBeenCalled();
  });

  it("keeps the honest SIMULATED path for non-allowlisted orgs (mock result, no throw)", async () => {
    // env unset → org_1 not allowlisted.
    prisma.outreachArtifact.findUnique.mockResolvedValue(artifactRow());
    prisma.outreachArtifact.update.mockResolvedValue(
      artifactRow({ status: OutreachArtifactStatus.SIMULATED }),
    );
    vi.spyOn(SendEmailTool.prototype, "execute").mockResolvedValueOnce({
      success: true,
      data: { sent: false, mock: true, provider: "mock", messageId: "mock_3" },
    });

    await expect(worker.processArtifact("art_1", "org_1")).resolves.toBeUndefined();

    expect(prisma.outreachArtifact.update).toHaveBeenCalledWith({
      where: { id: "art_1" },
      data: expect.objectContaining({
        status: OutreachArtifactStatus.SIMULATED,
        sendReceiptId: "mock_3",
      }),
    });
  });
});

describe("SendOutreachWorker GL8a — per-org daily send cap", () => {
  let prisma: ReturnType<typeof mockPrisma>;
  let ledger: ReturnType<typeof mockLedger>;
  let worker: SendOutreachWorker;

  beforeEach(() => {
    vi.restoreAllMocks();
    prisma = mockPrisma();
    ledger = mockLedger();
    const suppression = {
      isSuppressed: vi.fn(async () => false),
      isSuppressedInTransaction: vi.fn(async () => false),
    } as unknown as Parameters<typeof SendOutreachWorker>[3];
    worker = new SendOutreachWorker(
      prisma as unknown as PrismaService,
      mockQueue(),
      mockIntegrations(),
      suppression,
      ledger,
    );
  });

  afterEach(() => {
    delete process.env.OUTREACH_LIVE_FOR_ORGS;
    delete process.env.OUTREACH_DAILY_CAP_PER_ORG;
  });

  it("defers (returns cleanly, row stays APPROVED, no claim) when today's SENT count reaches the cap", async () => {
    process.env.OUTREACH_LIVE_FOR_ORGS = "org_1";
    prisma.outreachArtifact.findUnique.mockResolvedValue(artifactRow());
    prisma.outreachArtifact.count.mockResolvedValue(40); // default cap
    const sendSpy = vi.spyOn(SendEmailTool.prototype, "execute");

    await expect(worker.processArtifact("art_1", "org_1")).resolves.toBeUndefined();

    // No CAS claim, no dispatch, no terminal write — the row stays APPROVED
    // with its old updatedAt so the reconcile sweep retries it tomorrow.
    expect(prisma.outreachArtifact.updateMany).not.toHaveBeenCalled();
    expect(prisma.outreachArtifact.update).not.toHaveBeenCalled();
    expect(sendSpy).not.toHaveBeenCalled();
    expect(ledger.messageSent).not.toHaveBeenCalled();
  });

  it("counts org-scoped SENT, fresh SENDING, and today's DELIVERY_UNKNOWN capacity risk", async () => {
    process.env.OUTREACH_LIVE_FOR_ORGS = "org_1";
    prisma.outreachArtifact.findUnique.mockResolvedValue(artifactRow());
    prisma.outreachArtifact.count.mockResolvedValue(99);

    await worker.processArtifact("art_1", "org_1");

    expect(prisma.outreachArtifact.count).toHaveBeenCalledTimes(1);
    const arg = prisma.outreachArtifact.count.mock.calls[0]?.[0] as {
      where: {
        orgId: string;
        OR: Array<{
          status: OutreachArtifactStatus;
          sentAt?: { gte: Date };
          updatedAt?: { gte: Date };
        }>;
      };
    };
    expect(arg.where.orgId).toBe("org_1");
    expect(arg.where.OR.map((entry) => entry.status)).toEqual([
      OutreachArtifactStatus.SENT,
      OutreachArtifactStatus.SENDING,
      OutreachArtifactStatus.DELIVERY_UNKNOWN,
    ]);
    const cutoff = arg.where.OR[0]?.sentAt?.gte;
    expect(cutoff).toBeInstanceOf(Date);
    // Must be exactly midnight UTC of today.
    expect(cutoff?.getUTCHours()).toBe(0);
    expect(cutoff?.getUTCMinutes()).toBe(0);
    expect(cutoff?.getUTCSeconds()).toBe(0);
    expect(cutoff?.getUTCMilliseconds()).toBe(0);
    const age = Date.now() - (cutoff?.getTime() ?? 0);
    expect(age).toBeGreaterThanOrEqual(0);
    expect(age).toBeLessThan(24 * 60 * 60 * 1000);
    const sendingFloor = arg.where.OR[1]?.updatedAt?.gte;
    expect(sendingFloor).toBeInstanceOf(Date);
    expect(Date.now() - (sendingFloor?.getTime() ?? 0)).toBeLessThanOrEqual(
      15 * 60 * 1000 + 1_000,
    );
    expect(arg.where.OR[2]?.updatedAt?.gte).toEqual(cutoff);
  });

  it("honors the OUTREACH_DAILY_CAP_PER_ORG override", async () => {
    process.env.OUTREACH_LIVE_FOR_ORGS = "org_1";
    process.env.OUTREACH_DAILY_CAP_PER_ORG = "2";
    prisma.outreachArtifact.findUnique.mockResolvedValue(artifactRow());
    prisma.outreachArtifact.count.mockResolvedValue(2);
    const sendSpy = vi.spyOn(SendEmailTool.prototype, "execute");

    await worker.processArtifact("art_1", "org_1");

    expect(sendSpy).not.toHaveBeenCalled();
    expect(prisma.outreachArtifact.updateMany).not.toHaveBeenCalled();
  });

  it("proceeds to dispatch when under the cap", async () => {
    process.env.OUTREACH_LIVE_FOR_ORGS = "org_1";
    process.env.OUTREACH_DAILY_CAP_PER_ORG = "2";
    prisma.outreachArtifact.findUnique.mockResolvedValue(artifactRow());
    prisma.outreachArtifact.count.mockResolvedValue(1);
    prisma.outreachArtifact.update.mockResolvedValue(
      artifactRow({ status: OutreachArtifactStatus.SENT }),
    );
    const sendSpy = vi
      .spyOn(SendEmailTool.prototype, "execute")
      .mockResolvedValueOnce({
        success: true,
        data: {
          sent: true,
          provider: "gmail",
          dispatchOutcome: EMAIL_DISPATCH_OUTCOME.CONFIRMED_SENT,
          messageId: "g_1",
        },
      });

    await worker.processArtifact("art_1", "org_1");

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(prisma.outreachArtifact.update).toHaveBeenCalledWith({
      where: { id: "art_1" },
      data: expect.objectContaining({ status: OutreachArtifactStatus.SENT }),
    });
  });

  it("does not run the cap query for non-allowlisted orgs (SIMULATED traffic is uncapped)", async () => {
    // env unset → forced-mock path.
    prisma.outreachArtifact.findUnique.mockResolvedValue(artifactRow());
    prisma.outreachArtifact.update.mockResolvedValue(
      artifactRow({ status: OutreachArtifactStatus.SIMULATED }),
    );
    vi.spyOn(SendEmailTool.prototype, "execute").mockResolvedValueOnce({
      success: true,
      data: { sent: false, mock: true, provider: "mock", messageId: "m_1" },
    });

    await worker.processArtifact("art_1", "org_1");

    expect(prisma.outreachArtifact.count).not.toHaveBeenCalled();
  });
});

describe("getDailySendCapPerOrg", () => {
  it("defaults to 40 when the env var is unset or empty", () => {
    expect(getDailySendCapPerOrg({})).toBe(40);
    expect(getDailySendCapPerOrg({ OUTREACH_DAILY_CAP_PER_ORG: "" })).toBe(40);
    expect(getDailySendCapPerOrg({ OUTREACH_DAILY_CAP_PER_ORG: "  " })).toBe(40);
  });

  it("parses a positive integer override", () => {
    expect(getDailySendCapPerOrg({ OUTREACH_DAILY_CAP_PER_ORG: "5" })).toBe(5);
    expect(getDailySendCapPerOrg({ OUTREACH_DAILY_CAP_PER_ORG: " 100 " })).toBe(100);
  });

  it("falls back to the default on zero, negative, or garbage (typo cannot disable the cap)", () => {
    expect(getDailySendCapPerOrg({ OUTREACH_DAILY_CAP_PER_ORG: "0" })).toBe(40);
    expect(getDailySendCapPerOrg({ OUTREACH_DAILY_CAP_PER_ORG: "-3" })).toBe(40);
    expect(getDailySendCapPerOrg({ OUTREACH_DAILY_CAP_PER_ORG: "lots" })).toBe(40);
  });
});

describe("SendOutreachWorker GL8b — recipient cooldown", () => {
  let prisma: ReturnType<typeof mockPrisma>;
  let ledger: ReturnType<typeof mockLedger>;
  let worker: SendOutreachWorker;

  beforeEach(() => {
    vi.restoreAllMocks();
    prisma = mockPrisma();
    ledger = mockLedger();
    const suppression = {
      isSuppressed: vi.fn(async () => false),
      isSuppressedInTransaction: vi.fn(async () => false),
    } as unknown as Parameters<typeof SendOutreachWorker>[3];
    worker = new SendOutreachWorker(
      prisma as unknown as PrismaService,
      mockQueue(),
      mockIntegrations(),
      suppression,
      ledger,
    );
  });

  afterEach(() => {
    delete process.env.OUTREACH_LIVE_FOR_ORGS;
  });

  it("flips to SUPPRESSED with a policy-skip reviewerNote when the recipient was SENT to within 14 days", async () => {
    process.env.OUTREACH_LIVE_FOR_ORGS = "org_1";
    prisma.outreachArtifact.findUnique.mockResolvedValue(artifactRow());
    prisma.$queryRaw
      .mockResolvedValueOnce([]) // advisory-lock SELECT
      .mockResolvedValueOnce([
        {
          id: "art_prev",
          status: OutreachArtifactStatus.SENT,
          sentAt: new Date("2026-08-10T08:00:00Z"),
          updatedAt: new Date("2026-08-10T08:00:00Z"),
        },
      ]);
    const sendSpy = vi.spyOn(SendEmailTool.prototype, "execute");

    await expect(worker.processArtifact("art_1", "org_1")).resolves.toBeUndefined();

    expect(prisma.outreachArtifact.updateMany).toHaveBeenCalledWith({
      where: {
        id: "art_1",
        orgId: "org_1",
        status: OutreachArtifactStatus.APPROVED,
      },
      data: expect.objectContaining({
        status: OutreachArtifactStatus.SUPPRESSED,
        reviewerNote: expect.stringContaining("policy-skip:"),
      }),
    });
    const note = (
      prisma.outreachArtifact.updateMany.mock.calls[0]?.[0] as {
        data: { reviewerNote: string };
      }
    ).data.reviewerNote;
    expect(note).toContain("art_prev");
    // No claim, no dispatch, no cap query (cooldown runs first), no evidence.
    expect(prisma.outreachArtifact.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.outreachArtifact.update).not.toHaveBeenCalled();
    expect(sendSpy).not.toHaveBeenCalled();
    expect(prisma.outreachArtifact.count).not.toHaveBeenCalled();
    expect(ledger.messageSent).not.toHaveBeenCalled();
  });

  it("queries org-scoped delivery risk using a trimmed, case-folded recipient", async () => {
    const artifact = artifactRow();
    prisma.outreachArtifact.findUnique.mockResolvedValue(
      {
        ...artifact,
        recipientRef: "  Dest@Example.COM  ",
        payload: {
          ...(artifact.payload as Record<string, unknown>),
          to: "  Dest@Example.COM  ",
        },
      },
    );
    prisma.outreachArtifact.update.mockResolvedValue(
      artifactRow({ status: OutreachArtifactStatus.SIMULATED }),
    );
    vi.spyOn(SendEmailTool.prototype, "execute").mockResolvedValueOnce({
      success: true,
      data: { sent: false, mock: true, provider: "mock", messageId: "m_1" },
    });
    const before = Date.now();

    await worker.processArtifact("art_1", "org_1");

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    const riskCall = prisma.$queryRaw.mock.calls[1] as unknown[];
    const sql = (riskCall[0] as readonly string[]).join("?");
    expect(sql).toContain('lower(btrim("recipientRef"))');
    expect(sql).toContain("DELIVERY_UNKNOWN");
    expect(riskCall[1]).toBe("org_1");
    expect(riskCall[2]).toBe("art_1");
    expect(riskCall[3]).toBe(OutreachChannel.EMAIL);
    expect(riskCall[4]).toBe("dest@example.com");
    const windowMs = before - (riskCall[5] as Date).getTime();
    expect(windowMs).toBeGreaterThanOrEqual(14 * 24 * 60 * 60 * 1000 - 1_000);
    expect(windowMs).toBeLessThan(14 * 24 * 60 * 60 * 1000 + 5_000);
  });

  it("suppresses a normalized recipient after a recent DELIVERY_UNKNOWN outcome", async () => {
    prisma.outreachArtifact.findUnique.mockResolvedValue(
      artifactRow({ recipientRef: "  DEST@example.com " }),
    );
    prisma.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: "art_unknown",
          status: OutreachArtifactStatus.DELIVERY_UNKNOWN,
          sentAt: null,
          updatedAt: new Date("2026-08-12T05:00:00.000Z"),
        },
      ]);
    const sendSpy = vi.spyOn(SendEmailTool.prototype, "execute");

    await worker.processArtifact("art_1", "org_1");

    expect(prisma.outreachArtifact.updateMany).toHaveBeenCalledWith({
      where: {
        id: "art_1",
        orgId: "org_1",
        status: OutreachArtifactStatus.APPROVED,
      },
      data: expect.objectContaining({
        status: OutreachArtifactStatus.SUPPRESSED,
        reviewerNote: expect.stringContaining("DELIVERY_UNKNOWN"),
      }),
    });
    expect(prisma.$queryRaw.mock.calls[1]?.[4]).toBe("dest@example.com");
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("defers without suppressing when the same recipient has a fresh SENDING claim", async () => {
    prisma.outreachArtifact.findUnique.mockResolvedValue(artifactRow());
    prisma.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: "art_in_flight",
          status: OutreachArtifactStatus.SENDING,
          sentAt: null,
          updatedAt: new Date(),
        },
      ]);
    const sendSpy = vi.spyOn(SendEmailTool.prototype, "execute");

    await worker.processArtifact("art_1", "org_1");

    expect(prisma.outreachArtifact.updateMany).not.toHaveBeenCalled();
    expect(prisma.outreachArtifact.update).not.toHaveBeenCalled();
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("proceeds normally when there is no recent send to that recipient", async () => {
    process.env.OUTREACH_LIVE_FOR_ORGS = "org_1";
    prisma.outreachArtifact.findUnique.mockResolvedValue(artifactRow());
    prisma.outreachArtifact.update.mockResolvedValue(
      artifactRow({ status: OutreachArtifactStatus.SENT }),
    );
    const sendSpy = vi
      .spyOn(SendEmailTool.prototype, "execute")
      .mockResolvedValueOnce({
        success: true,
        data: {
          sent: true,
          provider: "gmail",
          dispatchOutcome: EMAIL_DISPATCH_OUTCOME.CONFIRMED_SENT,
          messageId: "g_2",
        },
      });

    await worker.processArtifact("art_1", "org_1");

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(prisma.outreachArtifact.update).toHaveBeenCalledWith({
      where: { id: "art_1" },
      data: expect.objectContaining({ status: OutreachArtifactStatus.SENT }),
    });
  });

  it("skips the cooldown query and rejects an email with no recipientRef", async () => {
    prisma.outreachArtifact.findUnique.mockResolvedValue(
      artifactRow({ recipientRef: null }),
    );
    const sendSpy = vi.spyOn(SendEmailTool.prototype, "execute");

    await expect(worker.processArtifact("art_1", "org_1")).rejects.toThrow(
      "reviewed content does not match the send payload",
    );

    // Only the advisory-lock SELECT runs; no recipient-risk SELECT follows.
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(sendSpy).not.toHaveBeenCalled();
  });
});

describe("SendOutreachWorker conversation safety gates", () => {
  let prisma: ReturnType<typeof mockPrisma>;
  let ledger: ReturnType<typeof mockLedger>;
  let suppression: {
    isSuppressed: ReturnType<typeof vi.fn>;
    isSuppressedInTransaction: ReturnType<typeof vi.fn>;
  };
  let conversationStore: ReturnType<typeof mockConversationStore>;
  let worker: SendOutreachWorker;

  beforeEach(() => {
    vi.restoreAllMocks();
    prisma = mockPrisma();
    ledger = mockLedger();
    suppression = {
      isSuppressed: vi.fn().mockResolvedValue(false),
      isSuppressedInTransaction: vi.fn().mockResolvedValue(false),
    };
    conversationStore = mockConversationStore();
    worker = new SendOutreachWorker(
      prisma as unknown as PrismaService,
      mockQueue(),
      mockIntegrations(),
      suppression as unknown as ConstructorParameters<
        typeof SendOutreachWorker
      >[3],
      ledger,
      undefined,
      conversationStore as unknown as ConstructorParameters<
        typeof SendOutreachWorker
      >[6],
    );
  });

  afterEach(() => {
    delete process.env.OUTREACH_LIVE_FOR_ORGS;
  });

  it.each([
    OutreachArtifactPurpose.OUTBOUND,
    OutreachArtifactPurpose.FOLLOW_UP,
  ])("never requests the legacy suppression bypass for %s", async (purpose) => {
    suppression.isSuppressedInTransaction.mockResolvedValue(true);
    prisma.outreachArtifact.findUnique.mockResolvedValue(
      artifactRow({ purpose }),
    );

    await worker.processArtifact("art_1", "org_1");

    expect(suppression.isSuppressed).not.toHaveBeenCalled();
    expect(suppression.isSuppressedInTransaction).toHaveBeenCalledWith(
      prisma,
      "org_1",
      "dest@example.com",
      { allowLegacyReplyStop: false },
    );
    expect(prisma.outreachArtifact.updateMany).toHaveBeenCalledWith({
      where: {
        id: "art_1",
        orgId: "org_1",
        status: OutreachArtifactStatus.APPROVED,
      },
      data: { status: OutreachArtifactStatus.SUPPRESSED },
    });
  });

  it("keeps REPLY subject to a real suppression while requesting only the legacy bypass", async () => {
    suppression.isSuppressedInTransaction.mockResolvedValue(true);
    prisma.outreachArtifact.findUnique.mockResolvedValue(
      artifactRow({ purpose: OutreachArtifactPurpose.REPLY }),
    );
    const sendSpy = vi.spyOn(SendEmailTool.prototype, "execute");

    await worker.processArtifact("art_1", "org_1");

    expect(suppression.isSuppressedInTransaction).toHaveBeenCalledWith(
      prisma,
      "org_1",
      "dest@example.com",
      { allowLegacyReplyStop: true },
    );
    expect(prisma.outreachArtifact.updateMany).toHaveBeenCalledWith({
      where: {
        id: "art_1",
        orgId: "org_1",
        status: OutreachArtifactStatus.APPROVED,
      },
      data: { status: OutreachArtifactStatus.SUPPRESSED },
    });
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("rechecks persisted suppression under the org lock before cooldown, cap, or claim", async () => {
    process.env.OUTREACH_LIVE_FOR_ORGS = "org_1";
    prisma.outreachArtifact.findUnique.mockResolvedValue(artifactRow());
    // A suppression writer committed before this reservation acquired the
    // shared org lock.
    suppression.isSuppressedInTransaction.mockResolvedValue(true);
    const sendSpy = vi.spyOn(SendEmailTool.prototype, "execute");

    await worker.processArtifact("art_1", "org_1");

    expect(suppression.isSuppressedInTransaction).toHaveBeenCalledWith(
      prisma,
      "org_1",
      "dest@example.com",
      { allowLegacyReplyStop: false },
    );
    expect(prisma.outreachArtifact.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.outreachArtifact.updateMany).toHaveBeenCalledWith({
      where: {
        id: "art_1",
        orgId: "org_1",
        status: OutreachArtifactStatus.APPROVED,
      },
      data: { status: OutreachArtifactStatus.SUPPRESSED },
    });
    expect(prisma.outreachArtifact.count).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(sendSpy).not.toHaveBeenCalled();

    const lockOrder = prisma.$queryRaw.mock.invocationCallOrder[0];
    const suppressionReadOrder =
      suppression.isSuppressedInTransaction.mock.invocationCallOrder[0];
    const suppressionWriteOrder =
      prisma.outreachArtifact.updateMany.mock.invocationCallOrder[0];
    expect(lockOrder).toBeLessThan(suppressionReadOrder);
    expect(suppressionReadOrder).toBeLessThan(suppressionWriteOrder);
  });

  it("rechecks sequence-stop under the org lock before claiming", async () => {
    prisma.outreachArtifact.findUnique.mockResolvedValue(
      artifactRow({ conversationId: "conv_1" }),
    );
    const stoppedAt = new Date("2026-08-12T01:00:00.000Z");
    prisma.conversation.findFirst.mockResolvedValue({
      id: "conv_1",
      sequenceStoppedAt: stoppedAt,
    });
    const sendSpy = vi.spyOn(SendEmailTool.prototype, "execute");

    await worker.processArtifact("art_1", "org_1");

    expect(prisma.conversation.findFirst).toHaveBeenCalledTimes(1);
    expect(prisma.outreachArtifact.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.outreachArtifact.updateMany).toHaveBeenCalledWith({
      where: {
        id: "art_1",
        orgId: "org_1",
        status: OutreachArtifactStatus.APPROVED,
      },
      data: {
        status: OutreachArtifactStatus.SUPPRESSED,
        reviewerNote: expect.stringContaining("sequence stopped"),
      },
    });
    expect(sendSpy).not.toHaveBeenCalled();
    expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.conversation.findFirst.mock.invocationCallOrder[0],
    );
  });

  it.each([
    OutreachArtifactPurpose.OUTBOUND,
    OutreachArtifactPurpose.FOLLOW_UP,
  ])("stops %s after a recipient reply", async (purpose) => {
    const stoppedAt = new Date("2026-08-12T01:00:00.000Z");
    prisma.outreachArtifact.findUnique.mockResolvedValue(
      artifactRow({ purpose, conversationId: "conv_1" }),
    );
    prisma.conversation.findFirst.mockResolvedValue({
      id: "conv_1",
      sequenceStoppedAt: stoppedAt,
    });
    const sendSpy = vi.spyOn(SendEmailTool.prototype, "execute");

    await worker.processArtifact("art_1", "org_1");

    expect(prisma.conversation.findFirst).toHaveBeenCalledWith({
      where: {
        orgId: "org_1",
        sequenceStoppedAt: { not: null },
        OR: [{ id: "conv_1" }, { contactEmail: "dest@example.com" }],
      },
      select: { id: true, sequenceStoppedAt: true },
    });
    expect(prisma.outreachArtifact.updateMany).toHaveBeenCalledWith({
      where: {
        id: "art_1",
        orgId: "org_1",
        status: OutreachArtifactStatus.APPROVED,
      },
      data: {
        status: OutreachArtifactStatus.SUPPRESSED,
        reviewerNote: expect.stringContaining("sequence stopped"),
      },
    });
    expect(prisma.outreachArtifact.findFirst).not.toHaveBeenCalled();
    expect(prisma.outreachArtifact.updateMany).toHaveBeenCalledTimes(1);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("still enforces a conversation-id sequence stop when recipientRef is absent", async () => {
    prisma.outreachArtifact.findUnique.mockResolvedValue(
      artifactRow({
        purpose: OutreachArtifactPurpose.FOLLOW_UP,
        conversationId: "conv_1",
        recipientRef: null,
      }),
    );
    prisma.conversation.findFirst.mockResolvedValue({
      id: "conv_1",
      sequenceStoppedAt: new Date("2026-08-12T01:00:00.000Z"),
    });
    await worker.processArtifact("art_1", "org_1");

    expect(prisma.conversation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ OR: [{ id: "conv_1" }] }),
      }),
    );
    expect(prisma.outreachArtifact.updateMany).toHaveBeenCalledWith({
      where: {
        id: "art_1",
        orgId: "org_1",
        status: OutreachArtifactStatus.APPROVED,
      },
      data: expect.objectContaining({
        status: OutreachArtifactStatus.SUPPRESSED,
      }),
    });
  });

  it("keeps FOLLOW_UP behind the recipient cooldown", async () => {
    prisma.outreachArtifact.findUnique.mockResolvedValue(
      artifactRow({ purpose: OutreachArtifactPurpose.FOLLOW_UP }),
    );
    prisma.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: "art_previous",
          status: OutreachArtifactStatus.SENT,
          sentAt: new Date("2026-08-11T12:00:00.000Z"),
          updatedAt: new Date("2026-08-11T12:00:00.000Z"),
        },
      ]);

    await worker.processArtifact("art_1", "org_1");

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    expect(prisma.outreachArtifact.updateMany).toHaveBeenCalledWith({
      where: {
        id: "art_1",
        orgId: "org_1",
        status: OutreachArtifactStatus.APPROVED,
      },
      data: expect.objectContaining({
        status: OutreachArtifactStatus.SUPPRESSED,
        reviewerNote: expect.stringContaining("cooldown"),
      }),
    });
  });

  it("lets an unsuppressed REPLY bypass sequence-stop and cooldown gates", async () => {
    prisma.outreachArtifact.findUnique.mockResolvedValue(
      artifactRow({
        purpose: OutreachArtifactPurpose.REPLY,
        conversationId: "conv_1",
      }),
    );
    prisma.conversation.findFirst.mockResolvedValue({
      id: "conv_1",
      sequenceStoppedAt: new Date("2026-08-12T01:00:00.000Z"),
    });
    prisma.outreachArtifact.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "art_1",
        status: OutreachArtifactStatus.APPROVED,
      });
    vi.spyOn(SendEmailTool.prototype, "execute").mockResolvedValueOnce({
      success: true,
      data: {
        sent: false,
        mock: true,
        provider: "mock",
        messageId: "mock_reply_1",
      },
    });

    await worker.processArtifact("art_1", "org_1");

    expect(prisma.conversation.findFirst).not.toHaveBeenCalled();
    expect(suppression.isSuppressedInTransaction).toHaveBeenCalledWith(
      prisma,
      "org_1",
      "dest@example.com",
      { allowLegacyReplyStop: true },
    );
    expect(prisma.outreachArtifact.findFirst).toHaveBeenCalledTimes(3);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    expect(prisma.outreachArtifact.update).toHaveBeenCalledWith({
      where: { id: "art_1" },
      data: {
        status: OutreachArtifactStatus.SIMULATED,
        sendReceiptId: "mock_reply_1",
      },
    });
  });

  it("suppresses a reply whose source is no longer the latest inbound message", async () => {
    prisma.outreachArtifact.findUnique.mockResolvedValue(
      artifactRow({
        purpose: OutreachArtifactPurpose.REPLY,
        conversationId: "conv_1",
        providerThreadId: "gmail-thread-1",
        replyToMessageId: "msg_old",
      }),
    );
    prisma.conversationMessage.findFirst.mockResolvedValue({ id: "msg_new" });
    const sendSpy = vi.spyOn(SendEmailTool.prototype, "execute");

    await worker.processArtifact("art_1", "org_1");

    expect(prisma.outreachArtifact.updateMany).toHaveBeenCalledWith({
      where: {
        id: "art_1",
        orgId: "org_1",
        status: OutreachArtifactStatus.APPROVED,
      },
      data: {
        status: OutreachArtifactStatus.SUPPRESSED,
        reviewerNote: expect.stringContaining("newer inbound message"),
      },
    });
    expect(prisma.outreachArtifact.findFirst).not.toHaveBeenCalled();
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("blocks a second reply when the same inbound source already has SENT truth", async () => {
    prisma.outreachArtifact.findUnique.mockResolvedValue(
      artifactRow({
        purpose: OutreachArtifactPurpose.REPLY,
        conversationId: "conv_1",
        providerThreadId: "gmail-thread-1",
        replyToMessageId: "msg_1",
      }),
    );
    prisma.conversationMessage.findFirst.mockResolvedValue({ id: "msg_1" });
    prisma.outreachArtifact.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "reply_sent",
        status: OutreachArtifactStatus.SENT,
      });
    const sendSpy = vi.spyOn(SendEmailTool.prototype, "execute");

    await worker.processArtifact("art_1", "org_1");

    expect(prisma.outreachArtifact.updateMany).toHaveBeenCalledWith({
      where: {
        id: "art_1",
        orgId: "org_1",
        status: OutreachArtifactStatus.APPROVED,
      },
      data: expect.objectContaining({
        status: OutreachArtifactStatus.SUPPRESSED,
        reviewerNote: expect.stringContaining("reply_sent"),
      }),
    });
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("blocks a newer-source reply while another reply in the thread is DELIVERY_UNKNOWN", async () => {
    prisma.outreachArtifact.findUnique.mockResolvedValue(
      artifactRow({
        purpose: OutreachArtifactPurpose.REPLY,
        conversationId: "conv_1",
        providerThreadId: "gmail-thread-1",
        replyToMessageId: "msg_new",
      }),
    );
    prisma.conversationMessage.findFirst.mockResolvedValue({ id: "msg_new" });
    prisma.outreachArtifact.findFirst.mockResolvedValueOnce({
      id: "reply_unknown_old_source",
      status: OutreachArtifactStatus.DELIVERY_UNKNOWN,
    });
    const sendSpy = vi.spyOn(SendEmailTool.prototype, "execute");

    await worker.processArtifact("art_1", "org_1");

    expect(prisma.outreachArtifact.updateMany).toHaveBeenCalledWith({
      where: {
        id: "art_1",
        orgId: "org_1",
        status: OutreachArtifactStatus.APPROVED,
      },
      data: expect.objectContaining({
        status: OutreachArtifactStatus.SUPPRESSED,
        reviewerNote: expect.stringContaining("DELIVERY_UNKNOWN"),
      }),
    });
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("sees provider-only legacy replies when reserving a modern conversation-linked reply", async () => {
    prisma.outreachArtifact.findUnique.mockResolvedValue(
      artifactRow({
        purpose: OutreachArtifactPurpose.REPLY,
        conversationId: "conv_1",
        providerThreadId: "gmail-thread-1",
        replyToMessageId: "msg_1",
      }),
    );
    prisma.conversationMessage.findFirst.mockResolvedValue({ id: "msg_1" });
    prisma.outreachArtifact.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "legacy_provider_only_sent",
        status: OutreachArtifactStatus.SENT,
      });

    await worker.processArtifact("art_1", "org_1");

    const sentBlockerQuery = prisma.outreachArtifact.findFirst.mock
      .calls[1]?.[0] as { where: { AND: Array<Record<string, unknown>> } };
    expect(sentBlockerQuery.where.AND[0]).toEqual({
      OR: [
        { conversationId: "conv_1" },
        { providerThreadId: "gmail-thread-1" },
      ],
    });
    expect(prisma.$queryRaw.mock.calls.map((call) => call[1])).toEqual(
      expect.arrayContaining([
        "outreach-reply-thread:org_1:conversation:conv_1",
        "outreach-reply-thread:org_1:provider-thread:gmail-thread-1",
      ]),
    );
    expect(prisma.outreachArtifact.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: OutreachArtifactStatus.SUPPRESSED,
          reviewerNote: expect.stringContaining("legacy_provider_only_sent"),
        }),
      }),
    );
  });

  it("allows the next inbound turn after a prior source was SENT", async () => {
    prisma.outreachArtifact.findUnique.mockResolvedValue(
      artifactRow({
        purpose: OutreachArtifactPurpose.REPLY,
        conversationId: "conv_1",
        providerThreadId: "gmail-thread-1",
        replyToMessageId: "msg_new",
      }),
    );
    prisma.conversationMessage.findFirst.mockResolvedValue({ id: "msg_new" });
    prisma.outreachArtifact.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "art_1",
        status: OutreachArtifactStatus.APPROVED,
      });
    vi.spyOn(SendEmailTool.prototype, "execute").mockResolvedValueOnce({
      success: true,
      data: {
        sent: false,
        mock: true,
        provider: "mock",
        messageId: "mock_new_turn",
      },
    });

    await worker.processArtifact("art_1", "org_1");

    const sentSourceQuery = prisma.outreachArtifact.findFirst.mock
      .calls[1]?.[0] as { where: { AND: Array<Record<string, unknown>> } };
    expect(sentSourceQuery.where.AND[1]).toEqual({
      OR: [
        { replyToMessageId: "msg_new" },
        { replyToMessageId: null },
      ],
    });
    expect(prisma.outreachArtifact.update).toHaveBeenCalledWith({
      where: { id: "art_1" },
      data: {
        status: OutreachArtifactStatus.SIMULATED,
        sendReceiptId: "mock_new_turn",
      },
    });
  });

  it("serializes distinct approved reply artifacts so concurrent workers dispatch only one", async () => {
    const early = artifactRow({
      id: "reply_early",
      graphRunId: null,
      purpose: OutreachArtifactPurpose.REPLY,
      conversationId: "conv_1",
      providerThreadId: "gmail-thread-1",
      replyToMessageId: "msg_1",
      createdAt: new Date("2026-08-12T07:00:00.000Z"),
    });
    const late = artifactRow({
      id: "reply_late",
      graphRunId: null,
      purpose: OutreachArtifactPurpose.REPLY,
      conversationId: "conv_1",
      providerThreadId: "gmail-thread-1",
      replyToMessageId: "msg_1",
      createdAt: new Date("2026-08-12T07:01:00.000Z"),
    });
    const rows = new Map<string, OutreachArtifact>([
      [early.id, early],
      [late.id, late],
    ]);

    prisma.outreachArtifact.findUnique.mockImplementation(
      async (args: { where: { id: string } }) => rows.get(args.where.id) ?? null,
    );
    prisma.conversationMessage.findFirst.mockResolvedValue({ id: "msg_1" });
    prisma.outreachArtifact.findFirst.mockImplementation(
      async (args: {
        where: {
          id?: { not?: string };
          status?:
            | OutreachArtifactStatus
            | { in?: OutreachArtifactStatus[] };
        };
      }) => {
        const statusFilter =
          typeof args.where.status === "string"
            ? [args.where.status]
            : (args.where.status?.in ?? []);
        return (
          [...rows.values()]
            .filter(
              (row) =>
                row.id !== args.where.id?.not &&
                statusFilter.includes(row.status),
            )
            .sort(
              (left, right) =>
                left.createdAt.getTime() - right.createdAt.getTime() ||
                left.id.localeCompare(right.id),
            )[0] ?? null
        );
      },
    );
    prisma.outreachArtifact.updateMany.mockImplementation(
      async (args: {
        where: { id: string; status: OutreachArtifactStatus };
        data: Partial<OutreachArtifact>;
      }) => {
        const row = rows.get(args.where.id);
        if (!row || row.status !== args.where.status) return { count: 0 };
        Object.assign(row, args.data);
        return { count: 1 };
      },
    );
    prisma.outreachArtifact.update.mockImplementation(
      async (args: {
        where: { id: string };
        data: Partial<OutreachArtifact>;
      }) => {
        const row = rows.get(args.where.id);
        if (!row) throw new Error("missing test artifact");
        Object.assign(row, args.data);
        return row;
      },
    );

    let transactionTail: Promise<unknown> = Promise.resolve();
    prisma.$transaction.mockImplementation(
      (callback: (tx: typeof prisma) => Promise<unknown>) => {
        const result = transactionTail.then(() => callback(prisma));
        transactionTail = result.then(
          () => undefined,
          () => undefined,
        );
        return result;
      },
    );

    let releaseProvider!: () => void;
    const sendSpy = vi
      .spyOn(SendEmailTool.prototype, "execute")
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            releaseProvider = () =>
              resolve({
                success: true,
                data: {
                  sent: false,
                  mock: true,
                  provider: "mock",
                  messageId: "mock_single_flight",
                },
              });
          }),
      );

    const processing = Promise.all([
      worker.processArtifact("reply_early", "org_1"),
      worker.processArtifact("reply_late", "org_1"),
    ]);
    await vi.waitFor(() =>
      expect(rows.get("reply_late")?.status).toBe(
        OutreachArtifactStatus.SUPPRESSED,
      ),
    );
    releaseProvider();
    await processing;

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(rows.get("reply_early")?.status).toBe(
      OutreachArtifactStatus.SIMULATED,
    );
    expect(rows.get("reply_late")?.status).toBe(
      OutreachArtifactStatus.SUPPRESSED,
    );
  });

  it("commits SENT before projecting a real Gmail delivery", async () => {
    process.env.OUTREACH_LIVE_FOR_ORGS = "org_1";
    prisma.outreachArtifact.findUnique.mockResolvedValue(artifactRow());
    prisma.integration.findFirst.mockResolvedValue({
      id: "gmail_integration_1",
      credentials: { accountEmail: "Sender@Acme.com" },
    });
    vi.spyOn(SendEmailTool.prototype, "execute").mockResolvedValueOnce({
      success: true,
      data: {
        sent: true,
        provider: "gmail",
        dispatchOutcome: EMAIL_DISPATCH_OUTCOME.CONFIRMED_SENT,
        messageId: "gmail_message_1",
        threadId: "gmail_thread_1",
      },
    });

    await worker.processArtifact("art_1", "org_1");

    const sentWriteOrder = prisma.outreachArtifact.update.mock.invocationCallOrder[0];
    const projectionOrder =
      conversationStore.recordDeliveredGmailArtifact.mock.invocationCallOrder[0];
    expect(sentWriteOrder).toBeLessThan(projectionOrder);
    expect(prisma.outreachArtifact.update).toHaveBeenCalledWith({
      where: { id: "art_1" },
      data: {
        status: OutreachArtifactStatus.SENT,
        sentAt: expect.any(Date),
        sendReceiptId: "gmail_message_1",
        providerThreadId: "gmail_thread_1",
      },
    });
    expect(
      conversationStore.recordDeliveredGmailArtifact,
    ).toHaveBeenCalledWith({
      orgId: "org_1",
      integrationId: "gmail_integration_1",
      artifactId: "art_1",
      providerThreadId: "gmail_thread_1",
      providerMessageId: "gmail_message_1",
      senderEmail: "sender@acme.com",
      toEmails: ["dest@example.com"],
      subject: "Hi",
      bodyText: "Body",
      bodyHtml: null,
      snippet: "Body",
      sentAt: expect.any(Date),
    });
  });

  it("does not release the claim or re-dispatch when post-SENT projection fails", async () => {
    process.env.OUTREACH_LIVE_FOR_ORGS = "org_1";
    prisma.outreachArtifact.findUnique.mockResolvedValue(artifactRow());
    prisma.integration.findFirst.mockResolvedValue({
      id: "gmail_integration_1",
      credentials: { accountEmail: "sender@acme.com" },
    });
    conversationStore.recordDeliveredGmailArtifact.mockRejectedValue(
      new Error("projection unavailable"),
    );
    const sendSpy = vi
      .spyOn(SendEmailTool.prototype, "execute")
      .mockResolvedValueOnce({
        success: true,
        data: {
          sent: true,
          provider: "gmail",
          dispatchOutcome: EMAIL_DISPATCH_OUTCOME.CONFIRMED_SENT,
          messageId: "gmail_message_1",
          threadId: "gmail_thread_1",
        },
      });

    await expect(
      worker.processArtifact("art_1", "org_1"),
    ).resolves.toBeUndefined();

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(prisma.outreachArtifact.update).toHaveBeenCalledWith({
      where: { id: "art_1" },
      data: expect.objectContaining({
        status: OutreachArtifactStatus.SENT,
        sendReceiptId: "gmail_message_1",
        providerThreadId: "gmail_thread_1",
      }),
    });
    expect(prisma.outreachArtifact.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.outreachArtifact.updateMany).toHaveBeenCalledWith({
      where: {
        id: "art_1",
        orgId: "org_1",
        status: OutreachArtifactStatus.APPROVED,
      },
      data: { status: OutreachArtifactStatus.SENDING },
    });
    expect(ledger.messageSent).toHaveBeenCalledTimes(1);
  });
});

describe("SendOutreachWorker.reconcileStuckArtifacts (recovery sweep)", () => {
  let prisma: ReturnType<typeof mockPrisma>;
  let queue: ReturnType<typeof mockQueue>;
  let worker: SendOutreachWorker;

  beforeEach(() => {
    vi.restoreAllMocks();
    prisma = mockPrisma();
    queue = mockQueue();
    const suppression = {
      isSuppressed: vi.fn(async () => false),
      isSuppressedInTransaction: vi.fn(async () => false),
    } as unknown as Parameters<typeof SendOutreachWorker>[3];
    worker = new SendOutreachWorker(
      prisma as unknown as PrismaService,
      queue,
      mockIntegrations(),
      suppression,
      mockLedger(),
    );
  });

  it("quarantines stale SENDING claims as DELIVERY_UNKNOWN without re-enqueueing", async () => {
    const stale = [
      artifactRow({ id: "art_a", orgId: "org_a", status: OutreachArtifactStatus.SENDING }),
      artifactRow({ id: "art_b", orgId: "org_b", status: OutreachArtifactStatus.SENDING }),
    ];
    prisma.outreachArtifact.findMany
      .mockResolvedValueOnce(stale) // SENDING pass
      .mockResolvedValueOnce([]); // APPROVED pass

    const result = await worker.reconcileStuckArtifacts();

    expect(result).toEqual({ deliveryUnknown: 2, requeued: 0 });
    expect(prisma.outreachArtifact.updateMany).toHaveBeenCalledWith({
      where: { id: "art_a", status: OutreachArtifactStatus.SENDING },
      data: expect.objectContaining({
        status: OutreachArtifactStatus.DELIVERY_UNKNOWN,
        reviewerNote: expect.stringContaining("automatic retry disabled"),
      }),
    });
    expect(prisma.outreachArtifact.updateMany).toHaveBeenCalledWith({
      where: { id: "art_b", status: OutreachArtifactStatus.SENDING },
      data: expect.objectContaining({
        status: OutreachArtifactStatus.DELIVERY_UNKNOWN,
        reviewerNote: expect.stringContaining("automatic retry disabled"),
      }),
    });
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it("re-enqueues stranded APPROVED rows (jobId dedup makes duplicates a no-op)", async () => {
    prisma.outreachArtifact.findMany
      .mockResolvedValueOnce([]) // SENDING pass
      .mockResolvedValueOnce([
        artifactRow({ id: "art_old", orgId: "org_1" }),
      ]);

    const result = await worker.reconcileStuckArtifacts();

    expect(result).toEqual({ deliveryUnknown: 0, requeued: 1 });
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
    expect(queue.enqueue).toHaveBeenCalledWith({ artifactId: "art_old", orgId: "org_1" });
    // No claim/release churn on the APPROVED pass — enqueue only.
    expect(prisma.outreachArtifact.updateMany).not.toHaveBeenCalled();
  });

  it("skips a stale claim that resolved between findMany and quarantine", async () => {
    prisma.outreachArtifact.findMany
      .mockResolvedValueOnce([
        artifactRow({ id: "art_won", orgId: "org_1", status: OutreachArtifactStatus.SENDING }),
      ])
      .mockResolvedValueOnce([]);
    // The guarded updateMany finds the row no longer SENDING (raced to SENT).
    prisma.outreachArtifact.updateMany.mockResolvedValueOnce({ count: 0 });

    const result = await worker.reconcileStuckArtifacts();

    expect(result).toEqual({ deliveryUnknown: 0, requeued: 0 });
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it("returns zero counts when nothing is stale", async () => {
    prisma.outreachArtifact.findMany.mockResolvedValue([]);

    const result = await worker.reconcileStuckArtifacts();

    expect(result).toEqual({ deliveryUnknown: 0, requeued: 0 });
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it("filters SENDING by updatedAt < now()-15m and APPROVED by updatedAt < now()-10m, capped at 100", async () => {
    prisma.outreachArtifact.findMany.mockResolvedValue([]);
    const before = Date.now();

    await worker.reconcileStuckArtifacts();

    const [sendingCall, approvedCall] =
      prisma.outreachArtifact.findMany.mock.calls.map(
        ([arg]) =>
          arg as {
            where: { status: OutreachArtifactStatus; updatedAt: { lt: Date } };
            take: number;
          },
      );

    expect(sendingCall.where.status).toBe(OutreachArtifactStatus.SENDING);
    const sendingCutoff = sendingCall.where.updatedAt.lt.getTime();
    // Cutoff should be ~15m before "now" — accept a small slop for the test
    // executor itself.
    expect(before - sendingCutoff).toBeGreaterThanOrEqual(15 * 60_000 - 100);
    expect(before - sendingCutoff).toBeLessThan(15 * 60_000 + 1_000);
    expect(sendingCall.take).toBe(100);

    expect(approvedCall.where.status).toBe(OutreachArtifactStatus.APPROVED);
    const approvedCutoff = approvedCall.where.updatedAt.lt.getTime();
    expect(before - approvedCutoff).toBeGreaterThanOrEqual(10 * 60_000 - 100);
    expect(before - approvedCutoff).toBeLessThan(10 * 60_000 + 1_000);
    expect(approvedCall.take).toBe(100);
  });
});

describe("SendOutreachWorker reconcile sweep — completed-jobId cleanup (GL8a deferred sends)", () => {
  let prisma: ReturnType<typeof mockPrisma>;

  beforeEach(() => {
    vi.restoreAllMocks();
    prisma = mockPrisma();
  });

  function buildWorker(queue: ReturnType<typeof mockQueue>): SendOutreachWorker {
    const suppression = {
      isSuppressed: vi.fn(async () => false),
      isSuppressedInTransaction: vi.fn(async () => false),
    } as unknown as Parameters<typeof SendOutreachWorker>[3];
    return new SendOutreachWorker(
      prisma as unknown as PrismaService,
      queue,
      mockIntegrations(),
      suppression,
      mockLedger(),
    );
  }

  it("removes a COMPLETED job under the artifact id before re-enqueueing a stranded APPROVED row", async () => {
    const job = fakeBullJob(true);
    const bullQueue: FakeBullQueue = { getJob: vi.fn(async () => job) };
    const queue = mockQueue(bullQueue);
    const worker = buildWorker(queue);
    prisma.outreachArtifact.findMany
      .mockResolvedValueOnce([]) // SENDING pass
      .mockResolvedValueOnce([artifactRow({ id: "art_deferred", orgId: "org_1" })]);

    const result = await worker.reconcileStuckArtifacts();

    expect(result).toEqual({ deliveryUnknown: 0, requeued: 1 });
    expect(bullQueue.getJob).toHaveBeenCalledWith("art_deferred");
    expect(job.remove).toHaveBeenCalledTimes(1);
    expect(queue.enqueue).toHaveBeenCalledWith({
      artifactId: "art_deferred",
      orgId: "org_1",
    });
    // Removal must happen before the re-enqueue, or add() dedups against the
    // completed job and the deferred send starves until removeOnComplete.
    const removeOrder = job.remove.mock.invocationCallOrder[0];
    const enqueueOrder = queue.enqueue.mock.invocationCallOrder[0];
    expect(removeOrder).toBeLessThan(enqueueOrder);
  });

  it("leaves non-completed jobs alone (BullMQ owns active/failed/delayed lifecycles)", async () => {
    const job = fakeBullJob(false);
    const bullQueue: FakeBullQueue = { getJob: vi.fn(async () => job) };
    const queue = mockQueue(bullQueue);
    const worker = buildWorker(queue);
    prisma.outreachArtifact.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([artifactRow({ id: "art_live_job", orgId: "org_1" })]);

    await worker.reconcileStuckArtifacts();

    expect(job.remove).not.toHaveBeenCalled();
    expect(queue.enqueue).toHaveBeenCalledWith({
      artifactId: "art_live_job",
      orgId: "org_1",
    });
  });

  it("just enqueues when no job exists under the id", async () => {
    const bullQueue: FakeBullQueue = { getJob: vi.fn(async () => undefined) };
    const queue = mockQueue(bullQueue);
    const worker = buildWorker(queue);
    prisma.outreachArtifact.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([artifactRow({ id: "art_no_job", orgId: "org_1" })]);

    await worker.reconcileStuckArtifacts();

    expect(queue.enqueue).toHaveBeenCalledWith({
      artifactId: "art_no_job",
      orgId: "org_1",
    });
  });

  it("a getJob failure does not block the re-enqueue (cleanup is best-effort)", async () => {
    const bullQueue: FakeBullQueue = {
      getJob: vi.fn(async () => {
        throw new Error("redis blip");
      }),
    };
    const queue = mockQueue(bullQueue);
    const worker = buildWorker(queue);
    prisma.outreachArtifact.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([artifactRow({ id: "art_blip", orgId: "org_1" })]);

    const result = await worker.reconcileStuckArtifacts();

    expect(result).toEqual({ deliveryUnknown: 0, requeued: 1 });
    expect(queue.enqueue).toHaveBeenCalledWith({
      artifactId: "art_blip",
      orgId: "org_1",
    });
  });

  it("does not touch or re-enqueue a completed job for stale SENDING", async () => {
    const job = fakeBullJob(true);
    const bullQueue: FakeBullQueue = { getJob: vi.fn(async () => job) };
    const queue = mockQueue(bullQueue);
    const worker = buildWorker(queue);
    prisma.outreachArtifact.findMany
      .mockResolvedValueOnce([
        artifactRow({ id: "art_stale", orgId: "org_1", status: OutreachArtifactStatus.SENDING }),
      ])
      .mockResolvedValueOnce([]);

    const result = await worker.reconcileStuckArtifacts();

    expect(result).toEqual({ deliveryUnknown: 1, requeued: 0 });
    expect(job.remove).not.toHaveBeenCalled();
    expect(queue.enqueue).not.toHaveBeenCalled();
  });
});

describe("SendOutreachWorker terminal-failure handler", () => {
  let prisma: ReturnType<typeof mockPrisma>;
  let worker: SendOutreachWorker;

  beforeEach(() => {
    vi.restoreAllMocks();
    prisma = mockPrisma();
    const suppression = {
      isSuppressed: vi.fn(async () => false),
      isSuppressedInTransaction: vi.fn(async () => false),
    } as unknown as Parameters<typeof SendOutreachWorker>[3];
    worker = new SendOutreachWorker(
      prisma as unknown as PrismaService,
      mockQueue(),
      mockIntegrations(),
      suppression,
      mockLedger(),
    );
  });

  function markTerminal(artifactId: string, orgId: string, reason: string) {
    // Drive markTerminalFailure via a private cast — the BullMQ "failed"
    // event wiring calls this method when all attempts have been consumed.
    return (
      worker as unknown as {
        markTerminalFailure: (
          artifactId: string,
          orgId: string,
          reason: string,
        ) => Promise<void>;
      }
    ).markTerminalFailure(artifactId, orgId, reason);
  }

  it("flips an APPROVED row to REJECTED with the auto-failed marker when retries exhaust", async () => {
    prisma.outreachArtifact.findUnique.mockResolvedValue(artifactRow());
    prisma.outreachArtifact.update.mockResolvedValue(
      artifactRow({ status: OutreachArtifactStatus.REJECTED }),
    );

    await markTerminal("art_1", "org_1", "gmail 500 after 3 attempts");

    expect(prisma.outreachArtifact.updateMany).toHaveBeenCalledWith({
      where: {
        id: "art_1",
        status: OutreachArtifactStatus.APPROVED,
      },
      data: expect.objectContaining({
        status: OutreachArtifactStatus.REJECTED,
        reviewerNote: expect.stringContaining("auto-failed:"),
        reviewedAt: expect.any(Date),
      }),
    });
  });

  it("quarantines a SENDING claim at retry exhaustion as DELIVERY_UNKNOWN", async () => {
    prisma.outreachArtifact.findUnique.mockResolvedValue(
      artifactRow({ status: OutreachArtifactStatus.SENDING }),
    );
    await markTerminal("art_1", "org_1", "claim release failed");

    expect(prisma.outreachArtifact.updateMany).toHaveBeenCalledWith({
      where: { id: "art_1", status: OutreachArtifactStatus.SENDING },
      data: expect.objectContaining({
        status: OutreachArtifactStatus.DELIVERY_UNKNOWN,
        reviewerNote: expect.stringContaining("delivery-unknown:"),
      }),
    });
  });

  it("leaves SENT rows alone (race with success)", async () => {
    prisma.outreachArtifact.findUnique.mockResolvedValue(
      artifactRow({ status: OutreachArtifactStatus.SENT, sentAt: new Date() }),
    );

    await markTerminal("art_1", "org_1", "stale failure event");

    expect(prisma.outreachArtifact.update).not.toHaveBeenCalled();
  });
});

describe("isLiveSendAllowedForOrg", () => {
  it("returns false when OUTREACH_LIVE_FOR_ORGS is unset (fail-closed)", () => {
    expect(isLiveSendAllowedForOrg("org_x", {})).toBe(false);
  });

  it("returns false when env var is empty string", () => {
    expect(isLiveSendAllowedForOrg("org_x", { OUTREACH_LIVE_FOR_ORGS: "" })).toBe(false);
  });

  it("returns false when env var is whitespace only", () => {
    expect(isLiveSendAllowedForOrg("org_x", { OUTREACH_LIVE_FOR_ORGS: "   " })).toBe(false);
  });

  it("returns true for org listed in comma-separated allowlist", () => {
    expect(
      isLiveSendAllowedForOrg("org_b", { OUTREACH_LIVE_FOR_ORGS: "org_a,org_b,org_c" }),
    ).toBe(true);
  });

  it("returns false for org not in allowlist", () => {
    expect(
      isLiveSendAllowedForOrg("org_z", { OUTREACH_LIVE_FOR_ORGS: "org_a,org_b" }),
    ).toBe(false);
  });

  it("tolerates whitespace around comma-separated entries", () => {
    expect(
      isLiveSendAllowedForOrg("org_b", { OUTREACH_LIVE_FOR_ORGS: " org_a , org_b , org_c " }),
    ).toBe(true);
  });

  it("wildcard '*' permits any org (dev only)", () => {
    expect(isLiveSendAllowedForOrg("any_org", { OUTREACH_LIVE_FOR_ORGS: "*" })).toBe(true);
  });
});
