import { describe, it, expect, beforeEach, vi } from "vitest";
import { GmailService } from "../gmail.service";
import { SuppressionService } from "../../../suppression/suppression.service";
import { ConfigService } from "@nestjs/config";
import { RuntimeService } from "../../../runtime/runtime.service";
import { OutreachArtifactStatus } from "@prisma/client";

function createMockConfig(): ConfigService {
  return {
    get: vi.fn().mockImplementation((_key: string, def?: string) => def ?? ""),
  } as unknown as ConfigService;
}

function createMockRuntime(): RuntimeService {
  return {
    triggerRun: vi.fn(),
  } as unknown as RuntimeService;
}

function createMockPrisma() {
  const prisma = {
    $transaction: vi.fn(),
    conversation: { upsert: vi.fn() },
    emailMessage: { findFirst: vi.fn(), create: vi.fn() },
    reply: { create: vi.fn() },
    emailEvent: { create: vi.fn() },
    outreachArtifact: { updateMany: vi.fn(), findUnique: vi.fn() },
  };
  prisma.$transaction.mockImplementation(async (fn: unknown) => {
    if (typeof fn === "function") return (fn as (tx: typeof prisma) => unknown)(prisma);
    return [];
  });
  return prisma;
}

function inboundMessage(overrides: Partial<Record<string, unknown>> = {}) {
  const headersRaw = [
    { name: "From", value: "Prospect <prospect@acme.com>" },
    { name: "To", value: "Owner <owner@example.com>" },
    { name: "Subject", value: "Re: Hello" },
    { name: "Date", value: "Mon, 1 Jan 2026 00:00:00 +0000" },
    { name: "Message-ID", value: "<reply_1@acme.com>" },
  ];
  return {
    id: "msg_in_1",
    threadId: "thread_1",
    snippet: "Thanks for reaching out",
    from: "Prospect <prospect@acme.com>",
    to: "Owner <owner@example.com>",
    subject: "Re: Hello",
    date: "Mon, 1 Jan 2026 00:00:00 +0000",
    labelIds: ["INBOX"],
    body: "Sure, let's talk.",
    headersRaw,
    mimeType: "text/plain",
    bodyText: "Sure, let's talk.",
    bodyHtml: null,
    ...overrides,
  };
}

describe("Gmail correlator (persistInboundCorrelation)", () => {
  let prisma: ReturnType<typeof createMockPrisma>;
  let service: GmailService;
  let suppression: SuppressionService;

  beforeEach(() => {
    prisma = createMockPrisma();
    const replyClassifierQueue = { enqueue: vi.fn().mockResolvedValue(undefined) } as any;
    suppression = { add: vi.fn().mockResolvedValue(undefined) } as unknown as SuppressionService;
    service = new GmailService(
      prisma as unknown as any,
      createMockConfig(),
      createMockRuntime(),
      replyClassifierQueue,
      suppression,
      undefined,
    );
    vi.clearAllMocks();
    (prisma.conversation.upsert as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "conv_1",
    });
    (prisma.emailMessage.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "em_in_1",
      providerMessageId: "msg_in_1",
      rfcMessageId: "<reply_1@acme.com>",
    });
    (prisma.reply.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "reply_1",
    });
    (prisma.emailEvent.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "evt_1",
    });
    (prisma.outreachArtifact.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({
      count: 1,
    });
    (prisma.outreachArtifact.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      orgId: "org_1",
      status: OutreachArtifactStatus.SENT,
      graphRunId: "graph_1",
    });
  });

  it("matches by In-Reply-To and updates the artifact to REPLIED", async () => {
    const msg = inboundMessage({
      headersRaw: [
        { name: "From", value: "prospect@acme.com" },
        { name: "To", value: "owner@example.com" },
        { name: "Subject", value: "Re: Hello" },
        { name: "Date", value: "Mon, 1 Jan 2026 00:00:00 +0000" },
        { name: "Message-ID", value: "<reply_1@acme.com>" },
        { name: "In-Reply-To", value: "<out_1@acme.com>" },
      ],
    });

    const findFirst = prisma.emailMessage.findFirst as ReturnType<typeof vi.fn>;
    findFirst
      .mockResolvedValueOnce(null) // references.hasSome
      .mockResolvedValueOnce({
        id: "em_out_1",
        artifactId: "art_1",
        providerMessageId: "gmail_out_1",
        rfcMessageId: "<out_1@acme.com>",
      });

    await (service as unknown as { persistInboundCorrelation: Function }).persistInboundCorrelation(
      "org_1",
      "owner@example.com",
      msg,
    );

    expect(prisma.reply.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          artifactId: "art_1",
          isOrphan: false,
        }),
      }),
    );
    expect(prisma.outreachArtifact.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "art_1",
          orgId: "org_1",
          status: { in: [OutreachArtifactStatus.SENT, OutreachArtifactStatus.QUEUED] },
        }),
        data: { status: OutreachArtifactStatus.REPLIED },
      }),
    );
  });

  it("creates an orphan Reply when no outbound match exists", async () => {
    const findFirst = prisma.emailMessage.findFirst as ReturnType<typeof vi.fn>;
    findFirst.mockResolvedValue(null);

    await (service as unknown as { persistInboundCorrelation: Function }).persistInboundCorrelation(
      "org_1",
      "owner@example.com",
      inboundMessage(),
    );

    expect(prisma.reply.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          artifactId: null,
          isOrphan: true,
        }),
      }),
    );
    expect(prisma.outreachArtifact.updateMany).not.toHaveBeenCalled();
  });

  it("adds a BOUNCED EmailEvent and flips artifact to BOUNCED for NDR", async () => {
    const msg = inboundMessage({
      headersRaw: [
        { name: "From", value: "mailer-daemon@googlemail.com" },
        { name: "To", value: "owner@example.com" },
        { name: "Subject", value: "Delivery Status Notification (Failure)" },
        { name: "Date", value: "Mon, 1 Jan 2026 00:00:00 +0000" },
        { name: "Message-ID", value: "<ndr_1@acme.com>" },
        { name: "In-Reply-To", value: "<out_1@acme.com>" },
        { name: "Content-Type", value: "multipart/report; report-type=delivery-status" },
      ],
      mimeType: "multipart/report",
    });

    const findFirst = prisma.emailMessage.findFirst as ReturnType<typeof vi.fn>;
    findFirst
      .mockResolvedValueOnce(null) // references.hasSome
      .mockResolvedValueOnce({
        id: "em_out_1",
        artifactId: "art_1",
        providerMessageId: "gmail_out_1",
        rfcMessageId: "<out_1@acme.com>",
      });

    await (service as unknown as { persistInboundCorrelation: Function }).persistInboundCorrelation(
      "org_1",
      "owner@example.com",
      msg,
    );

    // REPLIED event + additional BOUNCED event.
    expect(prisma.emailEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ kind: "BOUNCED", artifactId: "art_1" }),
      }),
    );
    expect(prisma.outreachArtifact.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: OutreachArtifactStatus.BOUNCED },
      }),
    );
  });

  it("is idempotent on re-delivery (P2002 is swallowed)", async () => {
    (prisma.emailMessage.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
      null,
    );
    (prisma.emailMessage.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: "P2002",
    });

    await expect(
      (service as unknown as { persistInboundCorrelation: Function }).persistInboundCorrelation(
        "org_1",
        "owner@example.com",
        inboundMessage(),
      ),
    ).resolves.not.toThrow();

    expect(prisma.reply.create).not.toHaveBeenCalled();
    expect(prisma.outreachArtifact.updateMany).not.toHaveBeenCalled();
  });

  it("enforces tenant isolation: orgB cannot match orgA outbound", async () => {
    const msg = inboundMessage({
      headersRaw: [
        { name: "From", value: "prospect@acme.com" },
        { name: "To", value: "owner@example.com" },
        { name: "Subject", value: "Re: Hello" },
        { name: "Date", value: "Mon, 1 Jan 2026 00:00:00 +0000" },
        { name: "Message-ID", value: "<reply_1@acme.com>" },
        { name: "In-Reply-To", value: "<out_1@acme.com>" },
      ],
    });

    (prisma.emailMessage.findFirst as ReturnType<typeof vi.fn>).mockImplementation(
      async (args: { where: { orgId: string } }) => {
        if (args.where.orgId !== "org_a") return null;
        return {
          id: "em_out_1",
          artifactId: "art_1",
          providerMessageId: "gmail_out_1",
          rfcMessageId: "<out_1@acme.com>",
        };
      },
    );

    await (service as unknown as { persistInboundCorrelation: Function }).persistInboundCorrelation(
      "org_a",
      "owner@example.com",
      msg,
    );
    await (service as unknown as { persistInboundCorrelation: Function }).persistInboundCorrelation(
      "org_b",
      "owner@example.com",
      msg,
    );

    expect(prisma.outreachArtifact.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ orgId: "org_a", id: "art_1" }),
      }),
    );
    expect(prisma.outreachArtifact.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ orgId: "org_b", id: "art_1" }),
      }),
    );
  });
});
