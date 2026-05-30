import { describe, it, expect, beforeEach, vi } from "vitest";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import {
  OutreachArtifactStatus,
  OutreachChannel,
  type OutreachArtifact,
} from "@prisma/client";
import { OutreachArtifactsService } from "../outreach-artifacts.service";
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

/**
 * Lets the fire-and-forget LangSmith call settle so assertions can observe it
 * without forcing the service to await the dataset upload. One microtask flush
 * is enough since addRunToDataset is invoked synchronously inside reject().
 */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function artifactRow(overrides: Partial<OutreachArtifact> = {}): OutreachArtifact {
  const now = new Date("2026-05-22T12:00:00Z");
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
    payload: {},
    status: OutreachArtifactStatus.PENDING_REVIEW,
    reviewerNote: null,
    suppressionReason: null,
    reviewedBy: null,
    reviewedAt: null,
    sentAt: null,
    sendReceiptId: null,
    conversationId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function mockPrisma() {
  return {
    outreachArtifact: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
  } as unknown as PrismaService & {
    outreachArtifact: {
      create: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
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
      artifactRow({ toolName: "hubspot", channel: OutreachChannel.HUBSPOT_NOTE }),
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
    prisma.outreachArtifact.create.mockResolvedValue(artifactRow({ subject: null, bodyText: null }));
    await service.recordDryRun({
      orgId: "org_1",
      toolName: "send_email",
      toolArgs: { weirdShape: { nested: true } },
    });
    const callArg = prisma.outreachArtifact.create.mock.calls[0][0];
    expect(callArg.data.payload).toEqual({ weirdShape: { nested: true } });
    expect(callArg.data.subject).toBeNull();
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
      artifactRow({ status: OutreachArtifactStatus.APPROVED, reviewedBy: "user_x" }),
    );
    const out = await service.approve("org_1", "art_1", "user_x");
    expect(out.status).toBe(OutreachArtifactStatus.APPROVED);
    expect(prisma.outreachArtifact.update).toHaveBeenCalledWith({
      where: { id: "art_1" },
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
      where: { id: "art_1" },
      data: expect.objectContaining({
        status: OutreachArtifactStatus.REJECTED,
        reviewerNote: "Off-tone",
      }),
    });
  });

  it("throws NotFound when the artifact belongs to a different org", async () => {
    prisma.outreachArtifact.findUnique.mockResolvedValue(artifactRow({ orgId: "other" }));
    await expect(service.approve("org_1", "art_1", "user_x")).rejects.toThrow(NotFoundException);
  });

  it("refuses to approve an already-approved artifact", async () => {
    prisma.outreachArtifact.findUnique.mockResolvedValue(
      artifactRow({ status: OutreachArtifactStatus.APPROVED }),
    );
    await expect(service.approve("org_1", "art_1", "user_x")).rejects.toThrow(BadRequestException);
  });

  it("refuses to reject an already-sent artifact", async () => {
    prisma.outreachArtifact.findUnique.mockResolvedValue(
      artifactRow({ status: OutreachArtifactStatus.SENT }),
    );
    await expect(service.reject("org_1", "art_1", "user_x")).rejects.toThrow(BadRequestException);
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
    const [dataset, calledRunId, metadata] = langsmith.addRunToDataset.mock.calls[0];
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
      artifactRow({ payload: { to: "dest@example.com", subject: "Hi", body: "Hello" } }),
    );
    prisma.outreachArtifact.update.mockResolvedValue(
      artifactRow({ status: OutreachArtifactStatus.REJECTED, reviewedBy: "user_x" }),
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
    const langsmith = mockLangsmith(() => Promise.reject(new Error("LangSmith 500")));
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
      artifactRow({ status: OutreachArtifactStatus.REJECTED, reviewedBy: "user_x" }),
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
    await service.listForOrg("org_1", { status: OutreachArtifactStatus.PENDING_REVIEW });
    expect(prisma.outreachArtifact.findMany).toHaveBeenCalledWith({
      where: { orgId: "org_1", status: OutreachArtifactStatus.PENDING_REVIEW },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
  });
});
