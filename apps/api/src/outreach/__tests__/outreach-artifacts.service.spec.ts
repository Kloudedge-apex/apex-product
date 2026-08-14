import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  OutreachArtifactStatus,
  OutreachArtifactPurpose,
  OutreachChannel,
  Prisma,
  type OutreachArtifact,
} from "@prisma/client";
import { OutreachArtifactsService } from "../outreach-artifacts.service";
import { OutreachSendQueueService } from "../outreach-send-queue.service";
import { PrismaService } from "../../prisma/prisma.service";
import { LangSmithService } from "../../observability/langsmith.service";

type LangSmithMock = Pick<LangSmithService, "addRunToDataset"> & {
  addRunToDataset: ReturnType<typeof vi.fn>;
};

function mockLangsmith(impl?: () => Promise<void>): LangSmithMock {
  return {
    addRunToDataset: vi.fn(impl ?? (() => Promise.resolve())),
  };
}

type SendQueueMock = Pick<OutreachSendQueueService, "enqueue"> & {
  enqueue: ReturnType<typeof vi.fn>;
};

function mockSendQueue(impl?: () => Promise<void>): SendQueueMock {
  return {
    enqueue: vi.fn(impl ?? (() => Promise.resolve())),
  };
}

/**
 * Lets the fire-and-forget LangSmith call settle so assertions can observe it
 * without forcing the service to await the dataset upload. One microtask flush
 * is enough since addRunToDataset is invoked synchronously inside reject().
 */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function approvablePayload(overrides: Record<string, unknown> = {}) {
  return {
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
      verifiedAt: "2026-05-21T12:00:00.000Z",
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
    ...overrides,
  };
}

function artifactRow(
  overrides: Partial<OutreachArtifact> = {},
): OutreachArtifact {
  const now = new Date("2026-05-22T12:00:00Z");
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
    payload: approvablePayload(),
    status: OutreachArtifactStatus.PENDING_REVIEW,
    reviewerNote: null,
    reviewedBy: null,
    reviewedAt: null,
    failureReason: null,
    failedAt: null,
    sentAt: null,
    sendReceiptId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function mockPrisma() {
  const prisma = {
    outreachArtifact: {
      create: vi.fn(),
      findUnique: vi.fn(),
      // findFirst added by the idempotency guard (audit P0 #9); default
      // returns null so the create path proceeds.
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
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
            verifiedAt: new Date("2026-05-21T12:00:00.000Z"),
            createdAt: new Date("2026-05-20T12:00:00.000Z"),
          },
        ],
      }),
    },
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation(
    (callback: (tx: typeof prisma) => Promise<unknown>) => callback(prisma),
  );
  return prisma as unknown as PrismaService & {
    outreachArtifact: {
      create: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
      findFirst: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
      count: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
    person: { findFirst: ReturnType<typeof vi.fn> };
    $transaction: ReturnType<typeof vi.fn>;
  };
}

describe("OutreachArtifactsService.recordDryRun", () => {
  let prisma: ReturnType<typeof mockPrisma>;
  let service: OutreachArtifactsService;

  beforeEach(() => {
    prisma = mockPrisma();
    service = new OutreachArtifactsService(prisma);
  });

  it("persists send_email args as an EMAIL channel artifact in PENDING_REVIEW", async () => {
    prisma.outreachArtifact.create.mockResolvedValue(artifactRow());
    const result = await service.recordDryRun({
      orgId: "org_1",
      graphRunId: "graph_1",
      toolName: "send_email",
      toolArgs: { to: "dest@example.com", subject: "Hi", body: "Hello" },
    });
    expect(result).not.toBeNull();
    expect(prisma.outreachArtifact.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orgId: "org_1",
        graphRunId: "graph_1",
        toolName: "send_email",
        channel: OutreachChannel.EMAIL,
        recipientRef: "dest@example.com",
        subject: "Hi",
        bodyText: "Hello",
        status: OutreachArtifactStatus.PENDING_REVIEW,
      }),
    });
  });

  it("persists hubspot args as a HUBSPOT_NOTE channel artifact", async () => {
    prisma.outreachArtifact.create.mockResolvedValue(
      artifactRow({
        toolName: "hubspot",
        channel: OutreachChannel.HUBSPOT_NOTE,
      }),
    );
    await service.recordDryRun({
      orgId: "org_1",
      toolName: "hubspot",
      toolArgs: { contactEmail: "x@y.z", note: "Followed up" },
    });
    expect(prisma.outreachArtifact.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        channel: OutreachChannel.HUBSPOT_NOTE,
        recipientRef: "x@y.z",
        bodyText: "Followed up",
      }),
    });
  });

  it("returns null for tools that do not map to a channel", async () => {
    const result = await service.recordDryRun({
      orgId: "org_1",
      toolName: "web_search",
      toolArgs: { q: "anything" },
    });
    expect(result).toBeNull();
    expect(prisma.outreachArtifact.create).not.toHaveBeenCalled();
  });

  it("preserves the verbatim payload even when extraction misses fields", async () => {
    prisma.outreachArtifact.create.mockResolvedValue(
      artifactRow({ subject: null, bodyText: null }),
    );
    await service.recordDryRun({
      orgId: "org_1",
      toolName: "send_email",
      toolArgs: { weirdShape: { nested: true } },
    });
    const callArg = prisma.outreachArtifact.create.mock.calls[0][0];
    expect(callArg.data.payload).toEqual({ weirdShape: { nested: true } });
    expect(callArg.data.subject).toBeNull();
  });

  it("does not reuse a same-recipient artifact for a different person", async () => {
    prisma.outreachArtifact.findFirst.mockResolvedValue(artifactRow());

    await expect(
      service.recordDryRun({
        orgId: "org_1",
        graphRunId: "graph_1",
        toolName: "send_email",
        toolArgs: {
          to: "dest@example.com",
          subject: "Hi",
          body: "Body",
          personId: "person_2",
        },
      }),
    ).rejects.toThrow(
      "Recipient dest@example.com is already bound to a different person",
    );
    expect(prisma.outreachArtifact.create).not.toHaveBeenCalled();
  });

  it("normalizes a reused delivery-unknown marker and prevents a duplicate graph artifact", async () => {
    prisma.outreachArtifact.findFirst.mockResolvedValue(
      artifactRow({
        status: OutreachArtifactStatus.REJECTED,
        reviewerNote: "delivery-unknown: provider response was ambiguous",
      }),
    );

    const result = await service.recordDryRun({
      orgId: "org_1",
      graphRunId: "graph_1",
      toolName: "send_email",
      toolArgs: {
        to: "dest@example.com",
        subject: "Hi",
        body: "Body",
        personId: "person_1",
      },
    });

    expect(result?.status).toBe(OutreachArtifactStatus.DELIVERY_UNKNOWN);
    expect(prisma.outreachArtifact.create).not.toHaveBeenCalled();
  });
});

describe("OutreachArtifactsService.approve / reject", () => {
  let prisma: ReturnType<typeof mockPrisma>;
  let service: OutreachArtifactsService;

  beforeEach(() => {
    prisma = mockPrisma();
    service = new OutreachArtifactsService(prisma);
  });

  it("approves a PENDING_REVIEW artifact", async () => {
    prisma.outreachArtifact.findUnique.mockResolvedValue(artifactRow());
    prisma.outreachArtifact.update.mockResolvedValue(
      artifactRow({
        status: OutreachArtifactStatus.APPROVED,
        reviewedBy: "user_x",
      }),
    );
    const out = await service.approve("org_1", "art_1", "user_x");
    expect(out.status).toBe(OutreachArtifactStatus.APPROVED);
    expect(prisma.outreachArtifact.update).toHaveBeenCalledWith({
      where: {
        id_orgId: { id: "art_1", orgId: "org_1" },
        status: OutreachArtifactStatus.PENDING_REVIEW,
      },
      data: expect.objectContaining({
        status: OutreachArtifactStatus.APPROVED,
        reviewedBy: "user_x",
      }),
    });
  });

  it("rejects a PENDING_REVIEW artifact with a note", async () => {
    prisma.outreachArtifact.findUnique.mockResolvedValue(artifactRow());
    prisma.outreachArtifact.update.mockResolvedValue(
      artifactRow({
        status: OutreachArtifactStatus.REJECTED,
        reviewerNote: "Off-tone",
        reviewedBy: "user_x",
      }),
    );
    await service.reject("org_1", "art_1", "user_x", "Off-tone");
    expect(prisma.outreachArtifact.update).toHaveBeenCalledWith({
      where: {
        id_orgId: { id: "art_1", orgId: "org_1" },
        status: OutreachArtifactStatus.PENDING_REVIEW,
      },
      data: expect.objectContaining({
        status: OutreachArtifactStatus.REJECTED,
        reviewerNote: "Off-tone",
      }),
    });
  });

  it("reserves the legacy auto-failed prefix for rolling-deploy compatibility", async () => {
    await expect(
      service.reject(
        "org_1",
        "art_1",
        "user_x",
        "auto-failed: typed by a reviewer",
      ),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.outreachArtifact.findUnique).not.toHaveBeenCalled();
    expect(prisma.outreachArtifact.update).not.toHaveBeenCalled();
  });

  it("reserves the delivery-unknown prefix for system compatibility outcomes", async () => {
    await expect(
      service.reject(
        "org_1",
        "art_1",
        "user_x",
        "delivery-unknown: typed by a reviewer",
      ),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.outreachArtifact.findUnique).not.toHaveBeenCalled();
    expect(prisma.outreachArtifact.update).not.toHaveBeenCalled();
  });

  it("throws NotFound when the artifact belongs to a different org", async () => {
    prisma.outreachArtifact.findUnique.mockResolvedValue(
      artifactRow({ orgId: "other" }),
    );
    await expect(service.approve("org_1", "art_1", "user_x")).rejects.toThrow(
      NotFoundException,
    );
  });

  it("refuses to approve an already-approved artifact", async () => {
    prisma.outreachArtifact.findUnique.mockResolvedValue(
      artifactRow({ status: OutreachArtifactStatus.APPROVED }),
    );
    await expect(service.approve("org_1", "art_1", "user_x")).rejects.toThrow(
      ConflictException,
    );
  });

  it("refuses HubSpot-note approval while dispatch is unwired", async () => {
    prisma.outreachArtifact.findUnique.mockResolvedValue(
      artifactRow({ channel: OutreachChannel.HUBSPOT_NOTE }),
    );
    await expect(service.approve("org_1", "art_1", "user_x")).rejects.toThrow(
      "HubSpot note approval is unavailable because dispatch is not implemented",
    );
    expect(prisma.outreachArtifact.update).not.toHaveBeenCalled();
  });

  it("refuses a draft whose final QA pass still has issues", async () => {
    prisma.outreachArtifact.findUnique.mockResolvedValue(
      artifactRow({
        payload: approvablePayload({
          qaIssues: ["placeholder_leak({{first_name}})"],
        }),
      }),
    );

    await expect(service.approve("org_1", "art_1", "user_x")).rejects.toThrow(
      "until all draft quality checks pass",
    );
    expect(prisma.outreachArtifact.update).not.toHaveBeenCalled();
  });

  it("refuses an agent refusal instead of treating it as sendable content", async () => {
    prisma.outreachArtifact.findUnique.mockResolvedValue(
      artifactRow({
        payload: approvablePayload({
          refusal: { reason: "insufficient_grounding", missing: ["signals"] },
        }),
      }),
    );

    await expect(service.approve("org_1", "art_1", "user_x")).rejects.toThrow(
      "agent refused to produce a grounded draft",
    );
    expect(prisma.outreachArtifact.update).not.toHaveBeenCalled();
  });

  it("refuses missing or unsupported grounding metadata", async () => {
    prisma.outreachArtifact.findUnique.mockResolvedValue(
      artifactRow({
        payload: approvablePayload({
          groundedness_self_check: {
            citedFactIds: [],
            unsupportedClaims: ["Unverified revenue claim"],
          },
        }),
      }),
    );

    await expect(service.approve("org_1", "art_1", "user_x")).rejects.toThrow(
      "reviewer-visible grounding check",
    );
    expect(prisma.outreachArtifact.update).not.toHaveBeenCalled();
  });

  it("refuses when reviewed fields differ from the payload the worker will send", async () => {
    prisma.outreachArtifact.findUnique.mockResolvedValue(
      artifactRow({
        payload: approvablePayload({ body: "Hidden replacement body" }),
      }),
    );

    await expect(service.approve("org_1", "art_1", "user_x")).rejects.toThrow(
      "reviewed content does not match the send payload",
    );
    expect(prisma.outreachArtifact.update).not.toHaveBeenCalled();
  });

  it("refuses approval when the snapshotted recipient is no longer eligible", async () => {
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
          createdAt: new Date("2026-05-20T12:00:00.000Z"),
        },
      ],
    });

    await expect(service.approve("org_1", "art_1", "user_x")).rejects.toThrow(
      "exact recipient snapshot is no longer current and eligible",
    );
    expect(prisma.outreachArtifact.update).not.toHaveBeenCalled();
  });

  it("lets one opposite review decision win and blocks approval effects after rejection", async () => {
    const runId = "run_review_race";
    let state = artifactRow({
      payload: approvablePayload({ langsmith_run_id: runId }),
    });
    let releaseApproval!: () => void;
    const rejectionCommitted = new Promise<void>((resolve) => {
      releaseApproval = resolve;
    });

    prisma.outreachArtifact.findUnique.mockImplementation(async () => state);
    prisma.outreachArtifact.update.mockImplementation(
      async (args: {
        where: {
          id_orgId: { id: string; orgId: string };
          status: OutreachArtifactStatus;
        };
        data: Partial<OutreachArtifact>;
      }) => {
        if (args.data.status === OutreachArtifactStatus.APPROVED) {
          await rejectionCommitted;
        }
        if (
          args.where.id_orgId.id !== state.id ||
          args.where.id_orgId.orgId !== state.orgId ||
          state.status !== args.where.status
        ) {
          throw new Prisma.PrismaClientKnownRequestError(
            "No record was found for a conditional update",
            { code: "P2025", clientVersion: "6.19.2" },
          );
        }
        state = { ...state, ...args.data };
        if (args.data.status === OutreachArtifactStatus.REJECTED) {
          releaseApproval();
        }
        return state;
      },
    );

    const sendQueue = mockSendQueue();
    const langsmith = mockLangsmith();
    const raceService = new OutreachArtifactsService(
      prisma,
      undefined,
      sendQueue as unknown as OutreachSendQueueService,
      langsmith as unknown as LangSmithService,
    );

    const approval = raceService.approve("org_1", "art_1", "approver");
    const rejection = raceService.reject(
      "org_1",
      "art_1",
      "rejecter",
      "Not suitable",
    );

    await expect(rejection).resolves.toMatchObject({
      status: OutreachArtifactStatus.REJECTED,
      reviewedBy: "rejecter",
    });
    await expect(approval).rejects.toThrow(
      "Artifact art_1 is REJECTED; only PENDING_REVIEW can be approved",
    );
    await flushMicrotasks();

    expect(state.status).toBe(OutreachArtifactStatus.REJECTED);
    expect(prisma.outreachArtifact.update).toHaveBeenCalledTimes(2);
    expect(sendQueue.enqueue).not.toHaveBeenCalled();
    expect(langsmith.addRunToDataset).toHaveBeenCalledTimes(1);
    expect(langsmith.addRunToDataset.mock.calls[0][0]).toBe(
      "apex-bad-sdr-drafts",
    );
  });

  it("refuses to reject an already-sent artifact", async () => {
    prisma.outreachArtifact.findUnique.mockResolvedValue(
      artifactRow({ status: OutreachArtifactStatus.SENT }),
    );
    await expect(service.reject("org_1", "art_1", "user_x")).rejects.toThrow(
      ConflictException,
    );
  });
});

describe("OutreachArtifactsService.approve — enqueue failure surfacing (audit B11)", () => {
  let prisma: ReturnType<typeof mockPrisma>;

  beforeEach(() => {
    prisma = mockPrisma();
    prisma.outreachArtifact.findUnique.mockResolvedValue(artifactRow());
    prisma.outreachArtifact.update.mockResolvedValue(
      artifactRow({
        status: OutreachArtifactStatus.APPROVED,
        reviewedBy: "user_x",
      }),
    );
  });

  it("returns the updated artifact when enqueue succeeds", async () => {
    const sendQueue = mockSendQueue();
    const service = new OutreachArtifactsService(
      prisma,
      undefined,
      sendQueue as unknown as OutreachSendQueueService,
    );
    const out = await service.approve("org_1", "art_1", "user_x");
    expect(out.status).toBe(OutreachArtifactStatus.APPROVED);
    expect(sendQueue.enqueue).toHaveBeenCalledWith({
      artifactId: "art_1",
      orgId: "org_1",
    });
  });

  it("rethrows as 503 when enqueue fails — no silent swallow", async () => {
    const sendQueue = mockSendQueue(() =>
      Promise.reject(new Error("Redis down")),
    );
    const service = new OutreachArtifactsService(
      prisma,
      undefined,
      sendQueue as unknown as OutreachSendQueueService,
    );
    const failure = await service
      .approve("org_1", "art_1", "user_x")
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ServiceUnavailableException);
    expect((failure as ServiceUnavailableException).getResponse()).toEqual({
      message: expect.stringContaining("approved but could not be queued"),
      approvalSaved: true,
      artifactId: "art_1",
    });
  });

  it("persists APPROVED before the enqueue failure surfaces (sweep can recover)", async () => {
    const sendQueue = mockSendQueue(() =>
      Promise.reject(new Error("Redis down")),
    );
    const service = new OutreachArtifactsService(
      prisma,
      undefined,
      sendQueue as unknown as OutreachSendQueueService,
    );
    await expect(service.approve("org_1", "art_1", "user_x")).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(prisma.outreachArtifact.update).toHaveBeenCalledWith({
      where: {
        id_orgId: { id: "art_1", orgId: "org_1" },
        status: OutreachArtifactStatus.PENDING_REVIEW,
      },
      data: expect.objectContaining({
        status: OutreachArtifactStatus.APPROVED,
        reviewedBy: "user_x",
      }),
    });
    expect(sendQueue.enqueue).toHaveBeenCalledTimes(1);
  });
});

describe("OutreachArtifactsService.approve — LangSmith good-drafts dataset", () => {
  let prisma: ReturnType<typeof mockPrisma>;

  beforeEach(() => {
    prisma = mockPrisma();
  });

  it("appends to apex-good-sdr-drafts when the artifact carries a langsmith_run_id", async () => {
    const runId = "run_good_1";
    prisma.outreachArtifact.findUnique.mockResolvedValue(
      artifactRow({ payload: approvablePayload({ langsmith_run_id: runId }) }),
    );
    prisma.outreachArtifact.update.mockResolvedValue(
      artifactRow({
        status: OutreachArtifactStatus.APPROVED,
        reviewedBy: "user_x",
        payload: { langsmith_run_id: runId },
      }),
    );
    const langsmith = mockLangsmith();
    const service = new OutreachArtifactsService(
      prisma,
      undefined,
      undefined,
      langsmith as unknown as LangSmithService,
    );

    const out = await service.approve("org_1", "art_1", "user_x");
    expect(out.status).toBe(OutreachArtifactStatus.APPROVED);

    await flushMicrotasks();
    expect(langsmith.addRunToDataset).toHaveBeenCalledTimes(1);
    const [dataset, calledRunId, metadata] =
      langsmith.addRunToDataset.mock.calls[0];
    expect(dataset).toBe("apex-good-sdr-drafts");
    expect(calledRunId).toBe(runId);
    expect(metadata).toEqual(
      expect.objectContaining({
        label: "approved",
        artifact_id: "art_1",
        reviewer_note: null,
        reviewed_by: "user_x",
        channel: OutreachChannel.EMAIL,
        recipient_ref: "dest@example.com",
      }),
    );
  });

  it("skips dataset append (and does not throw) for artifacts without a langsmith_run_id", async () => {
    prisma.outreachArtifact.findUnique.mockResolvedValue(artifactRow());
    prisma.outreachArtifact.update.mockResolvedValue(
      artifactRow({
        status: OutreachArtifactStatus.APPROVED,
        reviewedBy: "user_x",
      }),
    );
    const langsmith = mockLangsmith();
    const service = new OutreachArtifactsService(
      prisma,
      undefined,
      undefined,
      langsmith as unknown as LangSmithService,
    );

    const out = await service.approve("org_1", "art_1", "user_x");
    expect(out.status).toBe(OutreachArtifactStatus.APPROVED);

    await flushMicrotasks();
    expect(langsmith.addRunToDataset).not.toHaveBeenCalled();
  });

  it("flips status and does not throw when addRunToDataset rejects", async () => {
    const runId = "run_good_fails";
    prisma.outreachArtifact.findUnique.mockResolvedValue(
      artifactRow({ payload: approvablePayload({ langsmith_run_id: runId }) }),
    );
    prisma.outreachArtifact.update.mockResolvedValue(
      artifactRow({
        status: OutreachArtifactStatus.APPROVED,
        reviewedBy: "user_x",
        payload: { langsmith_run_id: runId },
      }),
    );
    const langsmith = mockLangsmith(() =>
      Promise.reject(new Error("LangSmith 500")),
    );
    const service = new OutreachArtifactsService(
      prisma,
      undefined,
      undefined,
      langsmith as unknown as LangSmithService,
    );

    const out = await service.approve("org_1", "art_1", "user_x");
    expect(out.status).toBe(OutreachArtifactStatus.APPROVED);

    // Let the rejected promise settle; the service must swallow it.
    await flushMicrotasks();
    expect(langsmith.addRunToDataset).toHaveBeenCalledTimes(1);
  });

  it("still records the human judgment when the enqueue hand-off fails", async () => {
    const runId = "run_good_enqueue_down";
    prisma.outreachArtifact.findUnique.mockResolvedValue(
      artifactRow({ payload: approvablePayload({ langsmith_run_id: runId }) }),
    );
    prisma.outreachArtifact.update.mockResolvedValue(
      artifactRow({
        status: OutreachArtifactStatus.APPROVED,
        reviewedBy: "user_x",
        payload: { langsmith_run_id: runId },
      }),
    );
    const langsmith = mockLangsmith();
    const sendQueue = mockSendQueue(() =>
      Promise.reject(new Error("Redis down")),
    );
    const service = new OutreachArtifactsService(
      prisma,
      undefined,
      sendQueue as unknown as OutreachSendQueueService,
      langsmith as unknown as LangSmithService,
    );

    await expect(service.approve("org_1", "art_1", "user_x")).rejects.toThrow(
      ServiceUnavailableException,
    );

    await flushMicrotasks();
    expect(langsmith.addRunToDataset).toHaveBeenCalledTimes(1);
    expect(langsmith.addRunToDataset.mock.calls[0][0]).toBe(
      "apex-good-sdr-drafts",
    );
  });

  it("no-ops when LangSmithService is not injected (e.g. tracing disabled)", async () => {
    prisma.outreachArtifact.findUnique.mockResolvedValue(
      artifactRow({
        payload: approvablePayload({ langsmith_run_id: "run_x" }),
      }),
    );
    prisma.outreachArtifact.update.mockResolvedValue(
      artifactRow({
        status: OutreachArtifactStatus.APPROVED,
        reviewedBy: "user_x",
      }),
    );
    const service = new OutreachArtifactsService(prisma);

    const out = await service.approve("org_1", "art_1", "user_x");
    expect(out.status).toBe(OutreachArtifactStatus.APPROVED);
  });
});

describe("OutreachArtifactsService.reject — LangSmith bad-drafts dataset", () => {
  let prisma: ReturnType<typeof mockPrisma>;

  beforeEach(() => {
    prisma = mockPrisma();
  });

  it("appends to apex-bad-sdr-drafts when the artifact carries a langsmith_run_id", async () => {
    const runId = "run_abc123";
    prisma.outreachArtifact.findUnique.mockResolvedValue(
      artifactRow({
        payload: {
          to: "dest@example.com",
          subject: "Hi",
          body: "Hello",
          langsmith_run_id: runId,
        },
      }),
    );
    prisma.outreachArtifact.update.mockResolvedValue(
      artifactRow({
        status: OutreachArtifactStatus.REJECTED,
        reviewerNote: "off-tone",
        reviewedBy: "user_x",
        payload: { langsmith_run_id: runId },
      }),
    );
    const langsmith = mockLangsmith();
    const service = new OutreachArtifactsService(
      prisma,
      undefined,
      undefined,
      langsmith as unknown as LangSmithService,
    );

    const out = await service.reject("org_1", "art_1", "user_x", "off-tone");
    expect(out.status).toBe(OutreachArtifactStatus.REJECTED);

    await flushMicrotasks();
    expect(langsmith.addRunToDataset).toHaveBeenCalledTimes(1);
    const [dataset, calledRunId, metadata] =
      langsmith.addRunToDataset.mock.calls[0];
    expect(dataset).toBe("apex-bad-sdr-drafts");
    expect(calledRunId).toBe(runId);
    expect(metadata).toEqual(
      expect.objectContaining({
        artifact_id: "art_1",
        reviewer_note: "off-tone",
        reviewed_by: "user_x",
        channel: OutreachChannel.EMAIL,
        recipient_ref: "dest@example.com",
      }),
    );
  });

  it("skips dataset append (and does not throw) for artifacts without a langsmith_run_id", async () => {
    prisma.outreachArtifact.findUnique.mockResolvedValue(
      artifactRow({
        payload: { to: "dest@example.com", subject: "Hi", body: "Hello" },
      }),
    );
    prisma.outreachArtifact.update.mockResolvedValue(
      artifactRow({
        status: OutreachArtifactStatus.REJECTED,
        reviewedBy: "user_x",
      }),
    );
    const langsmith = mockLangsmith();
    const service = new OutreachArtifactsService(
      prisma,
      undefined,
      undefined,
      langsmith as unknown as LangSmithService,
    );

    const out = await service.reject("org_1", "art_1", "user_x");
    expect(out.status).toBe(OutreachArtifactStatus.REJECTED);

    await flushMicrotasks();
    expect(langsmith.addRunToDataset).not.toHaveBeenCalled();
  });

  it("flips status and does not throw when addRunToDataset rejects", async () => {
    const runId = "run_fails";
    prisma.outreachArtifact.findUnique.mockResolvedValue(
      artifactRow({ payload: { langsmith_run_id: runId } }),
    );
    prisma.outreachArtifact.update.mockResolvedValue(
      artifactRow({
        status: OutreachArtifactStatus.REJECTED,
        reviewedBy: "user_x",
        payload: { langsmith_run_id: runId },
      }),
    );
    const langsmith = mockLangsmith(() =>
      Promise.reject(new Error("LangSmith 500")),
    );
    const service = new OutreachArtifactsService(
      prisma,
      undefined,
      undefined,
      langsmith as unknown as LangSmithService,
    );

    const out = await service.reject("org_1", "art_1", "user_x");
    expect(out.status).toBe(OutreachArtifactStatus.REJECTED);

    // Let the rejected promise settle; the service must swallow it.
    await flushMicrotasks();
    expect(langsmith.addRunToDataset).toHaveBeenCalledTimes(1);
  });

  it("no-ops when LangSmithService is not injected (e.g. tracing disabled)", async () => {
    prisma.outreachArtifact.findUnique.mockResolvedValue(
      artifactRow({ payload: { langsmith_run_id: "run_x" } }),
    );
    prisma.outreachArtifact.update.mockResolvedValue(
      artifactRow({
        status: OutreachArtifactStatus.REJECTED,
        reviewedBy: "user_x",
      }),
    );
    const service = new OutreachArtifactsService(prisma);

    const out = await service.reject("org_1", "art_1", "user_x");
    expect(out.status).toBe(OutreachArtifactStatus.REJECTED);
  });
});

describe("OutreachArtifactsService.list / get", () => {
  let prisma: ReturnType<typeof mockPrisma>;
  let service: OutreachArtifactsService;

  beforeEach(() => {
    prisma = mockPrisma();
    service = new OutreachArtifactsService(prisma);
  });

  it("scopes listForGraphRun to the caller's org", async () => {
    prisma.outreachArtifact.findMany.mockResolvedValue([artifactRow()]);
    await service.listForGraphRun("org_1", "graph_1");
    expect(prisma.outreachArtifact.findMany).toHaveBeenCalledWith({
      where: { orgId: "org_1", graphRunId: "graph_1" },
      orderBy: { createdAt: "asc" },
    });
  });

  it("filters listForOrg by status when provided", async () => {
    prisma.outreachArtifact.findMany.mockResolvedValue([]);
    await service.listForOrg("org_1", {
      status: OutreachArtifactStatus.PENDING_REVIEW,
    });
    expect(prisma.outreachArtifact.findMany).toHaveBeenCalledWith({
      where: { orgId: "org_1", status: OutreachArtifactStatus.PENDING_REVIEW },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
  });

  it("lists first-class and attested compatibility failures through the effective FAILED filter", async () => {
    prisma.outreachArtifact.findMany.mockResolvedValue([]);
    await service.listForOrg("org_1", {
      status: OutreachArtifactStatus.FAILED,
    });
    expect(prisma.outreachArtifact.findMany).toHaveBeenCalledWith({
      where: {
        orgId: "org_1",
        OR: [
          { status: OutreachArtifactStatus.FAILED },
          {
            status: OutreachArtifactStatus.REJECTED,
            reviewerNote: { startsWith: "auto-failed:" },
            failedAt: { not: null },
          },
        ],
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
  });

  it("returns FAILED for an attested compatibility row from list, page, graph-run list, and get", async () => {
    const compatibilityFailure = artifactRow({
      status: OutreachArtifactStatus.REJECTED,
      reviewerNote: "auto-failed: provider rejected after retry exhaustion",
      failureReason: "provider rejected after retry exhaustion",
      failedAt: new Date("2026-05-22T13:00:00.000Z"),
    });
    prisma.outreachArtifact.findMany.mockResolvedValue([
      compatibilityFailure,
    ]);
    prisma.outreachArtifact.count.mockResolvedValue(1);
    prisma.outreachArtifact.findUnique.mockResolvedValue(compatibilityFailure);

    const list = await service.listForOrg("org_1", {
      status: OutreachArtifactStatus.FAILED,
    });
    const page = await service.listPageForOrg("org_1", {
      status: OutreachArtifactStatus.FAILED,
      page: 1,
      limit: 20,
    });
    const graphRunList = await service.listForGraphRun("org_1", "graph_1");
    const detail = await service.get("org_1", "art_1");

    expect(list[0]?.status).toBe(OutreachArtifactStatus.FAILED);
    expect(page.items[0]?.status).toBe(OutreachArtifactStatus.FAILED);
    expect(graphRunList[0]?.status).toBe(OutreachArtifactStatus.FAILED);
    expect(detail.status).toBe(OutreachArtifactStatus.FAILED);
    expect(detail).not.toHaveProperty("persistedStatus");
  });

  it("filters and exposes legacy-safe delivery-unknown markers as DELIVERY_UNKNOWN", async () => {
    const compatibilityOutcome = artifactRow({
      status: OutreachArtifactStatus.REJECTED,
      reviewerNote:
        "delivery-unknown: provider response was ambiguous; automatic retry disabled",
    });
    prisma.outreachArtifact.findMany.mockResolvedValue([
      compatibilityOutcome,
    ]);
    prisma.outreachArtifact.count.mockResolvedValue(1);
    prisma.outreachArtifact.findUnique.mockResolvedValue(compatibilityOutcome);

    const list = await service.listForOrg("org_1", {
      status: OutreachArtifactStatus.DELIVERY_UNKNOWN,
    });
    const page = await service.listPageForOrg("org_1", {
      status: OutreachArtifactStatus.DELIVERY_UNKNOWN,
      page: 1,
      limit: 20,
    });
    const graphRunList = await service.listForGraphRun("org_1", "graph_1");
    const detail = await service.get("org_1", "art_1");

    expect(prisma.outreachArtifact.findMany).toHaveBeenCalledWith({
      where: {
        orgId: "org_1",
        OR: [
          { status: OutreachArtifactStatus.DELIVERY_UNKNOWN },
          {
            status: OutreachArtifactStatus.REJECTED,
            reviewerNote: { startsWith: "delivery-unknown:" },
          },
        ],
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    expect(list[0]?.status).toBe(OutreachArtifactStatus.DELIVERY_UNKNOWN);
    expect(page.items[0]?.status).toBe(
      OutreachArtifactStatus.DELIVERY_UNKNOWN,
    );
    expect(graphRunList[0]?.status).toBe(
      OutreachArtifactStatus.DELIVERY_UNKNOWN,
    );
    expect(detail.status).toBe(OutreachArtifactStatus.DELIVERY_UNKNOWN);
  });

  it("returns RECONCILIATION_REQUIRED for an unattested historical marker from list and get", async () => {
    const historicalMarker = artifactRow({
      status: OutreachArtifactStatus.REJECTED,
      reviewerNote: "auto-failed: historical retry exhaustion",
      failedAt: null,
    });
    prisma.outreachArtifact.findMany.mockResolvedValue([historicalMarker]);
    prisma.outreachArtifact.findUnique.mockResolvedValue(historicalMarker);

    const list = await service.listForOrg("org_1");
    const detail = await service.get("org_1", "art_1");

    expect(list[0]?.status).toBe("RECONCILIATION_REQUIRED");
    expect(detail.status).toBe("RECONCILIATION_REQUIRED");
  });

  it("keeps legacy failures out of the effective REJECTED filter", async () => {
    prisma.outreachArtifact.findMany.mockResolvedValue([]);
    await service.listForOrg("org_1", {
      status: OutreachArtifactStatus.REJECTED,
    });
    expect(prisma.outreachArtifact.findMany).toHaveBeenCalledWith({
      where: {
        orgId: "org_1",
        status: OutreachArtifactStatus.REJECTED,
        OR: [
          { reviewerNote: null },
          {
            AND: [
              {
                NOT: {
                  reviewerNote: { startsWith: "auto-failed:" },
                },
              },
              {
                NOT: {
                  reviewerNote: { startsWith: "delivery-unknown:" },
                },
              },
            ],
          },
        ],
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
  });

  it("returns a stable, tenant-scoped page and real total", async () => {
    prisma.outreachArtifact.findMany.mockResolvedValue([
      artifactRow({ id: "art_2" }),
    ]);
    prisma.outreachArtifact.count.mockResolvedValue(41);

    const out = await service.listPageForOrg("org_1", {
      status: OutreachArtifactStatus.PENDING_REVIEW,
      page: 3,
      limit: 20,
    });

    const where = {
      orgId: "org_1",
      status: OutreachArtifactStatus.PENDING_REVIEW,
    };
    expect(prisma.outreachArtifact.findMany).toHaveBeenCalledWith({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: 40,
      take: 20,
    });
    expect(prisma.outreachArtifact.count).toHaveBeenCalledWith({ where });
    expect(out).toMatchObject({ total: 41, page: 3, limit: 20 });
    expect(out.items).toHaveLength(1);
  });
});
