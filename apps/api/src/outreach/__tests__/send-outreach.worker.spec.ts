import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  OutreachArtifact,
  OutreachArtifactStatus,
  OutreachChannel,
} from "@prisma/client";
import {
  SendOutreachWorker,
  isLiveSendAllowedForOrg,
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
    };
    integration: { findMany: ReturnType<typeof vi.fn> };
    org: { findUnique: ReturnType<typeof vi.fn> };
  };
}

function mockQueue(): OutreachSendQueueService & {
  enqueue: ReturnType<typeof vi.fn>;
} {
  return {
    isBullMode: () => false,
    getBullQueue: () => null,
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
