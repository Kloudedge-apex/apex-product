import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  OutreachArtifact,
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
import { SendEmailTool } from "../../runtime/tools/send-email.tool";
import { LinkedInSendMessageTool } from "../../runtime/tools/linkedin-send-message.tool";

function artifactRow(overrides: Partial<OutreachArtifact> = {}): OutreachArtifact {
  const now = new Date("2026-05-25T12:00:00Z");
  return {
    id: "art_1",
    orgId: "org_1",
    graphRunId: "graph_1",
    toolName: "send_email",
    channel: OutreachChannel.EMAIL,
    recipientRef: "dest@example.com",
    subject: "Hi",
    bodyText: "Body",
    bodyHtml: null,
    payload: { to: "dest@example.com", subject: "Hi", body: "Body" },
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
  return {
    outreachArtifact: {
      findUnique: vi.fn(),
      update: vi.fn(),
      // CAS claim/release path (audit B6). Default count=1 ("we won the
      // claim") so existing happy-path tests proceed without modification.
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findMany: vi.fn(),
      // GL8b recipient-cooldown lookup. Default null ("no recent send") so
      // existing happy-path tests proceed without modification.
      findFirst: vi.fn().mockResolvedValue(null),
      // GL8a daily-cap count. Default 0 ("no sends today") — under cap.
      count: vi.fn().mockResolvedValue(0),
    },
    integration: {
      findMany: vi.fn().mockResolvedValue([]),
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
        senderName: null,
      }),
    },
  } as unknown as PrismaService & {
    outreachArtifact: {
      findUnique: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
      findFirst: ReturnType<typeof vi.fn>;
      count: ReturnType<typeof vi.fn>;
    };
    integration: { findMany: ReturnType<typeof vi.fn> };
    org: { findUnique: ReturnType<typeof vi.fn> };
  };
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
    const suppression = { isSuppressed: vi.fn(async () => false) } as unknown as Parameters<typeof SendOutreachWorker>[3];
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
            messageId: "gmail_123",
            to: "dest@example.com",
            subject: "Hi",
          },
        });

      await worker.processArtifact("art_1", "org_1");

      // CAS claim must precede dispatch (audit B6): updateMany flips
      // APPROVED → SENDING so concurrent workers can't double-send.
      expect(prisma.outreachArtifact.updateMany).toHaveBeenCalledWith({
        where: { id: "art_1", status: OutreachArtifactStatus.APPROVED },
        data: { status: OutreachArtifactStatus.SENDING },
      });
      const claimOrder =
        prisma.outreachArtifact.updateMany.mock.invocationCallOrder[0];
      const dispatchOrder = sendSpy.mock.invocationCallOrder[0];
      expect(claimOrder).toBeLessThan(dispatchOrder);

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

  it("aborts when the artifact belongs to a different org", async () => {
    prisma.outreachArtifact.findUnique.mockResolvedValue(
      artifactRow({ orgId: "other_org" }),
    );
    const sendSpy = vi.spyOn(SendEmailTool.prototype, "execute");

    await worker.processArtifact("art_1", "org_1");

    expect(sendSpy).not.toHaveBeenCalled();
    expect(prisma.outreachArtifact.update).not.toHaveBeenCalled();
  });

  it("rethrows on transient failure so BullMQ retries and releases the claim back to APPROVED", async () => {
    prisma.outreachArtifact.findUnique.mockResolvedValue(artifactRow());
    vi.spyOn(SendEmailTool.prototype, "execute").mockResolvedValueOnce({
      success: false,
      data: { sent: false },
      error: "Graph API error 503: upstream down",
    });

    await expect(worker.processArtifact("art_1", "org_1")).rejects.toThrow(
      /upstream down/,
    );

    // Critically: the SENDING claim is released back to APPROVED on failure
    // so BullMQ's next attempt re-claims it; no terminal update happens.
    expect(prisma.outreachArtifact.updateMany).toHaveBeenCalledWith({
      where: { id: "art_1", status: OutreachArtifactStatus.SENDING },
      data: { status: OutreachArtifactStatus.APPROVED },
    });
    expect(prisma.outreachArtifact.update).not.toHaveBeenCalled();
    expect(ledger.messageSent).not.toHaveBeenCalled();
  });

  it("releases the claim when dispatch throws (not just on success:false results)", async () => {
    prisma.outreachArtifact.findUnique.mockResolvedValue(artifactRow());
    vi.spyOn(SendEmailTool.prototype, "execute").mockRejectedValueOnce(
      new Error("socket hang up"),
    );

    await expect(worker.processArtifact("art_1", "org_1")).rejects.toThrow(
      /socket hang up/,
    );

    expect(prisma.outreachArtifact.updateMany).toHaveBeenCalledWith({
      where: { id: "art_1", status: OutreachArtifactStatus.SENDING },
      data: { status: OutreachArtifactStatus.APPROVED },
    });
    expect(prisma.outreachArtifact.update).not.toHaveBeenCalled();
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
    // Same idempotency contract as EMAIL: failures leave the row in APPROVED
    // so BullMQ's next attempt re-picks it up, and markTerminalFailure flips
    // it to REJECTED only after retries are exhausted.
    expect(prisma.outreachArtifact.update).not.toHaveBeenCalled();
    expect(ledger.messageSent).not.toHaveBeenCalled();
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
        data: { sent: true, provider: "gmail", messageId: "real_1" },
      });

      await worker.processArtifact("art_1", "org_1");

      // Allowlisted org → loadIntegrations() runs → prisma.integration.findMany
      // is queried. We only assert the side-effect, not the result.
      expect(prisma.integration.findMany).toHaveBeenCalledWith({
        where: { orgId: "org_1", status: "CONNECTED" },
      });
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
    const suppression = { isSuppressed: vi.fn(async () => false) } as unknown as Parameters<typeof SendOutreachWorker>[3];
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
    const suppression = { isSuppressed: vi.fn(async () => false) } as unknown as Parameters<typeof SendOutreachWorker>[3];
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

  it("counts org-scoped SENT artifacts with sentAt >= start of the current UTC day", async () => {
    process.env.OUTREACH_LIVE_FOR_ORGS = "org_1";
    prisma.outreachArtifact.findUnique.mockResolvedValue(artifactRow());
    prisma.outreachArtifact.count.mockResolvedValue(99);

    await worker.processArtifact("art_1", "org_1");

    expect(prisma.outreachArtifact.count).toHaveBeenCalledTimes(1);
    const arg = prisma.outreachArtifact.count.mock.calls[0]?.[0] as {
      where: {
        orgId: string;
        status: OutreachArtifactStatus;
        sentAt: { gte: Date };
      };
    };
    expect(arg.where.orgId).toBe("org_1");
    expect(arg.where.status).toBe(OutreachArtifactStatus.SENT);
    const cutoff = arg.where.sentAt.gte;
    // Must be exactly midnight UTC of today.
    expect(cutoff.getUTCHours()).toBe(0);
    expect(cutoff.getUTCMinutes()).toBe(0);
    expect(cutoff.getUTCSeconds()).toBe(0);
    expect(cutoff.getUTCMilliseconds()).toBe(0);
    const age = Date.now() - cutoff.getTime();
    expect(age).toBeGreaterThanOrEqual(0);
    expect(age).toBeLessThan(24 * 60 * 60 * 1000);
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
        data: { sent: true, provider: "gmail", messageId: "g_1" },
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
    const suppression = { isSuppressed: vi.fn(async () => false) } as unknown as Parameters<typeof SendOutreachWorker>[3];
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
    prisma.outreachArtifact.findFirst.mockResolvedValue({
      id: "art_prev",
      sentAt: new Date("2026-06-10T08:00:00Z"),
    });
    const sendSpy = vi.spyOn(SendEmailTool.prototype, "execute");

    await expect(worker.processArtifact("art_1", "org_1")).resolves.toBeUndefined();

    expect(prisma.outreachArtifact.update).toHaveBeenCalledWith({
      where: { id: "art_1" },
      data: expect.objectContaining({
        status: OutreachArtifactStatus.SUPPRESSED,
        reviewerNote: expect.stringContaining("policy-skip:"),
      }),
    });
    const note = (
      prisma.outreachArtifact.update.mock.calls[0]?.[0] as {
        data: { reviewerNote: string };
      }
    ).data.reviewerNote;
    expect(note).toContain("art_prev");
    // No claim, no dispatch, no cap query (cooldown runs first), no evidence.
    expect(prisma.outreachArtifact.updateMany).not.toHaveBeenCalled();
    expect(sendSpy).not.toHaveBeenCalled();
    expect(prisma.outreachArtifact.count).not.toHaveBeenCalled();
    expect(ledger.messageSent).not.toHaveBeenCalled();
  });

  it("queries org-scoped SENT artifacts for the same recipientRef within the last 14 days", async () => {
    prisma.outreachArtifact.findUnique.mockResolvedValue(artifactRow());
    prisma.outreachArtifact.update.mockResolvedValue(
      artifactRow({ status: OutreachArtifactStatus.SIMULATED }),
    );
    vi.spyOn(SendEmailTool.prototype, "execute").mockResolvedValueOnce({
      success: true,
      data: { sent: false, mock: true, provider: "mock", messageId: "m_1" },
    });
    const before = Date.now();

    await worker.processArtifact("art_1", "org_1");

    expect(prisma.outreachArtifact.findFirst).toHaveBeenCalledTimes(1);
    const arg = prisma.outreachArtifact.findFirst.mock.calls[0]?.[0] as {
      where: {
        orgId: string;
        recipientRef: string;
        status: OutreachArtifactStatus;
        sentAt: { gte: Date };
      };
    };
    expect(arg.where.orgId).toBe("org_1");
    expect(arg.where.recipientRef).toBe("dest@example.com");
    expect(arg.where.status).toBe(OutreachArtifactStatus.SENT);
    const windowMs = before - arg.where.sentAt.gte.getTime();
    expect(windowMs).toBeGreaterThanOrEqual(14 * 24 * 60 * 60 * 1000 - 1_000);
    expect(windowMs).toBeLessThan(14 * 24 * 60 * 60 * 1000 + 5_000);
  });

  it("proceeds normally when there is no recent send to that recipient", async () => {
    process.env.OUTREACH_LIVE_FOR_ORGS = "org_1";
    prisma.outreachArtifact.findUnique.mockResolvedValue(artifactRow());
    prisma.outreachArtifact.findFirst.mockResolvedValue(null);
    prisma.outreachArtifact.update.mockResolvedValue(
      artifactRow({ status: OutreachArtifactStatus.SENT }),
    );
    const sendSpy = vi
      .spyOn(SendEmailTool.prototype, "execute")
      .mockResolvedValueOnce({
        success: true,
        data: { sent: true, provider: "gmail", messageId: "g_2" },
      });

    await worker.processArtifact("art_1", "org_1");

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(prisma.outreachArtifact.update).toHaveBeenCalledWith({
      where: { id: "art_1" },
      data: expect.objectContaining({ status: OutreachArtifactStatus.SENT }),
    });
  });

  it("skips the cooldown query when the artifact has no recipientRef", async () => {
    prisma.outreachArtifact.findUnique.mockResolvedValue(
      artifactRow({ recipientRef: null }),
    );
    prisma.outreachArtifact.update.mockResolvedValue(
      artifactRow({ status: OutreachArtifactStatus.SIMULATED }),
    );
    vi.spyOn(SendEmailTool.prototype, "execute").mockResolvedValueOnce({
      success: true,
      data: { sent: false, mock: true, provider: "mock", messageId: "m_2" },
    });

    await worker.processArtifact("art_1", "org_1");

    expect(prisma.outreachArtifact.findFirst).not.toHaveBeenCalled();
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
    const suppression = { isSuppressed: vi.fn(async () => false) } as unknown as Parameters<typeof SendOutreachWorker>[3];
    worker = new SendOutreachWorker(
      prisma as unknown as PrismaService,
      queue,
      mockIntegrations(),
      suppression,
      mockLedger(),
    );
  });

  it("releases stale SENDING claims back to APPROVED and re-enqueues them", async () => {
    const stale = [
      artifactRow({ id: "art_a", orgId: "org_a", status: OutreachArtifactStatus.SENDING }),
      artifactRow({ id: "art_b", orgId: "org_b", status: OutreachArtifactStatus.SENDING }),
    ];
    prisma.outreachArtifact.findMany
      .mockResolvedValueOnce(stale) // SENDING pass
      .mockResolvedValueOnce([]); // APPROVED pass

    const result = await worker.reconcileStuckArtifacts();

    expect(result).toEqual({ released: 2, requeued: 2 });
    expect(prisma.outreachArtifact.updateMany).toHaveBeenCalledWith({
      where: { id: "art_a", status: OutreachArtifactStatus.SENDING },
      data: { status: OutreachArtifactStatus.APPROVED },
    });
    expect(prisma.outreachArtifact.updateMany).toHaveBeenCalledWith({
      where: { id: "art_b", status: OutreachArtifactStatus.SENDING },
      data: { status: OutreachArtifactStatus.APPROVED },
    });
    expect(queue.enqueue).toHaveBeenCalledWith({ artifactId: "art_a", orgId: "org_a" });
    expect(queue.enqueue).toHaveBeenCalledWith({ artifactId: "art_b", orgId: "org_b" });
  });

  it("re-enqueues stranded APPROVED rows (jobId dedup makes duplicates a no-op)", async () => {
    prisma.outreachArtifact.findMany
      .mockResolvedValueOnce([]) // SENDING pass
      .mockResolvedValueOnce([
        artifactRow({ id: "art_old", orgId: "org_1" }),
      ]);

    const result = await worker.reconcileStuckArtifacts();

    expect(result).toEqual({ released: 0, requeued: 1 });
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
    expect(queue.enqueue).toHaveBeenCalledWith({ artifactId: "art_old", orgId: "org_1" });
    // No claim/release churn on the APPROVED pass — enqueue only.
    expect(prisma.outreachArtifact.updateMany).not.toHaveBeenCalled();
  });

  it("skips a stale claim that resolved between the findMany and the guarded release", async () => {
    prisma.outreachArtifact.findMany
      .mockResolvedValueOnce([
        artifactRow({ id: "art_won", orgId: "org_1", status: OutreachArtifactStatus.SENDING }),
      ])
      .mockResolvedValueOnce([]);
    // The guarded updateMany finds the row no longer SENDING (raced to SENT).
    prisma.outreachArtifact.updateMany.mockResolvedValueOnce({ count: 0 });

    const result = await worker.reconcileStuckArtifacts();

    expect(result).toEqual({ released: 0, requeued: 0 });
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it("returns zero counts when nothing is stale", async () => {
    prisma.outreachArtifact.findMany.mockResolvedValue([]);

    const result = await worker.reconcileStuckArtifacts();

    expect(result).toEqual({ released: 0, requeued: 0 });
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
    const suppression = { isSuppressed: vi.fn(async () => false) } as unknown as Parameters<typeof SendOutreachWorker>[3];
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

    expect(result).toEqual({ released: 0, requeued: 1 });
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

    expect(result).toEqual({ released: 0, requeued: 1 });
    expect(queue.enqueue).toHaveBeenCalledWith({
      artifactId: "art_blip",
      orgId: "org_1",
    });
  });

  it("also clears completed jobs on the stale-SENDING release path", async () => {
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

    expect(result).toEqual({ released: 1, requeued: 1 });
    expect(job.remove).toHaveBeenCalledTimes(1);
    expect(queue.enqueue).toHaveBeenCalledWith({
      artifactId: "art_stale",
      orgId: "org_1",
    });
  });
});

describe("SendOutreachWorker terminal-failure handler", () => {
  let prisma: ReturnType<typeof mockPrisma>;
  let worker: SendOutreachWorker;

  beforeEach(() => {
    vi.restoreAllMocks();
    prisma = mockPrisma();
    const suppression = { isSuppressed: vi.fn(async () => false) } as unknown as Parameters<typeof SendOutreachWorker>[3];
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

    expect(prisma.outreachArtifact.update).toHaveBeenCalledWith({
      where: { id: "art_1" },
      data: expect.objectContaining({
        status: OutreachArtifactStatus.REJECTED,
        reviewerNote: expect.stringContaining("auto-failed:"),
        reviewedAt: expect.any(Date),
      }),
    });
  });

  it("also owns a stuck SENDING claim (release failed mid-crash) and flips it to REJECTED", async () => {
    prisma.outreachArtifact.findUnique.mockResolvedValue(
      artifactRow({ status: OutreachArtifactStatus.SENDING }),
    );
    prisma.outreachArtifact.update.mockResolvedValue(
      artifactRow({ status: OutreachArtifactStatus.REJECTED }),
    );

    await markTerminal("art_1", "org_1", "claim release failed");

    expect(prisma.outreachArtifact.update).toHaveBeenCalledWith({
      where: { id: "art_1" },
      data: expect.objectContaining({
        status: OutreachArtifactStatus.REJECTED,
        reviewerNote: expect.stringContaining("auto-failed:"),
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
