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
      findMany: ReturnType<typeof vi.fn>;
    };
    integration: { findMany: ReturnType<typeof vi.fn> };
    org: { findUnique: ReturnType<typeof vi.fn> };
  };
}

function mockQueue(): OutreachSendQueueService {
  return {
    isBullMode: () => false,
    getBullQueue: () => null,
    getConnection: () => null,
    enqueue: vi.fn(),
    onModuleDestroy: vi.fn(),
  } as unknown as OutreachSendQueueService;
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
  let queue: OutreachSendQueueService;
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

  it("sends an APPROVED EMAIL artifact and flips it to SENT with a receipt", async () => {
    prisma.outreachArtifact.findUnique.mockResolvedValue(artifactRow());
    prisma.outreachArtifact.update.mockResolvedValue(
      artifactRow({ status: OutreachArtifactStatus.SENT }),
    );
    // Force mock mode in SendEmailTool — no integration creds loaded — so it
    // returns success with a synthetic messageId.
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
        status: OutreachArtifactStatus.SENT,
        sendReceiptId: "mock_123",
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
        sendReceiptId: "mock_123",
        provider: "mock",
      }),
    );
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

  it("rethrows on transient failure so BullMQ retries and leaves status as APPROVED", async () => {
    prisma.outreachArtifact.findUnique.mockResolvedValue(artifactRow());
    vi.spyOn(SendEmailTool.prototype, "execute").mockResolvedValueOnce({
      success: false,
      data: { sent: false },
      error: "Graph API error 503: upstream down",
    });

    await expect(worker.processArtifact("art_1", "org_1")).rejects.toThrow(
      /upstream down/,
    );

    // Critically: the artifact status is NOT updated on failure — it stays
    // APPROVED so BullMQ's next attempt picks it up.
    expect(prisma.outreachArtifact.update).not.toHaveBeenCalled();
    expect(ledger.messageSent).not.toHaveBeenCalled();
  });

  it("dispatches LINKEDIN artifacts via LinkedInSendMessageTool and flips to SENT on success", async () => {
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
