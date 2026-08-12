import { beforeEach, describe, expect, it, vi } from "vitest";
import { OutreachSuppressionReason } from "@prisma/client";
import { GmailService } from "../gmail.service";
import { PrismaService } from "../../../prisma/prisma.service";
import { SuppressionService } from "../../../outreach/suppression.service";
import { ConversationStoreService } from "../../../conversation-store/conversation-store.service";
import { ConfigService } from "@nestjs/config";
import { encrypt } from "../../crypto.util";

vi.mock("google-auth-library", () => {
  class MockOAuth2Client {
    verifyIdToken = vi.fn();
  }
  return { OAuth2Client: MockOAuth2Client };
});

const { historyList, messagesGet } = vi.hoisted(() => ({
  historyList: vi.fn(),
  messagesGet: vi.fn(),
}));

vi.mock("googleapis", () => {
  class MockOAuth2 {
    generateAuthUrl = vi.fn();
    getToken = vi.fn();
    setCredentials = vi.fn();
    on = vi.fn();
  }
  return {
    google: {
      auth: { OAuth2: MockOAuth2 },
      gmail: vi.fn().mockReturnValue({
        users: {
          history: { list: historyList },
          messages: { get: messagesGet },
        },
      }),
    },
    gmail_v1: {},
  };
});

function createMockPrisma() {
  return {
    integration: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn().mockResolvedValue({ id: "int_1" }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  } as unknown as PrismaService & {
    integration: {
      findUnique: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
    };
  };
}

function createMockSuppression() {
  return {
    suppress: vi.fn().mockResolvedValue({ created: true }),
  } as unknown as SuppressionService & {
    suppress: ReturnType<typeof vi.fn>;
  };
}

function createMockConversationStore() {
  return {
    recordInboundGmailMessage: vi.fn().mockResolvedValue({
      correlated: true,
      created: true,
      conversation: { id: "conv_1" },
      message: { id: "cmsg_1" },
    }),
  } as unknown as ConversationStoreService & {
    recordInboundGmailMessage: ReturnType<typeof vi.fn>;
  };
}

function createMockConfig() {
  const values: Record<string, string> = {
    GOOGLE_CLIENT_ID: "mock_client_id",
    GOOGLE_CLIENT_SECRET: "mock_client_secret",
    GOOGLE_REDIRECT_URI: "http://localhost:4000/api/integrations/gmail/callback",
    GMAIL_PUSH_AUDIENCE: "https://api.example.com/api/integrations/gmail/push",
    GMAIL_PUSH_PUBLISHER_SA:
      "gmail-push-publisher@example.iam.gserviceaccount.com",
    GMAIL_PUBSUB_TOPIC: "projects/example/topics/gmail-inbound",
  };
  return {
    get: vi.fn((key: string, fallback?: string) => values[key] ?? fallback ?? ""),
  } as unknown as ConfigService;
}

function connectedIntegration() {
  return {
    id: "int_1",
    orgId: "org_1",
    provider: "gmail",
    status: "CONNECTED",
    encryptedCredentials: encrypt(
      JSON.stringify({
        access_token: "mock_access_token",
        refresh_token: "mock_refresh_token",
        expiry_date: Date.now() + 3_600_000,
        token_type: "Bearer",
        scope: "https://www.googleapis.com/auth/gmail.send",
      }),
    ),
    credentials: { accountEmail: "owner@example.com" },
  };
}

function messageResponse(options: {
  id?: string;
  from: string;
  subject?: string;
  labelIds?: string[];
  body?: string;
  extraHeaders?: Array<{ name: string; value: string }>;
}) {
  return {
    data: {
      id: options.id ?? "msg_1",
      threadId: "thread_1",
      internalDate: "1767225600000",
      snippet: "reply snippet",
      labelIds: options.labelIds ?? ["INBOX", "UNREAD"],
      payload: {
        mimeType: "text/plain",
        headers: [
          { name: "From", value: options.from },
          { name: "To", value: "Owner <owner@example.com>" },
          { name: "Cc", value: "Sales <sales@example.com>" },
          { name: "Subject", value: options.subject ?? "Re: quick question" },
          { name: "Date", value: "Thu, 1 Jan 2026 00:00:00 +0000" },
          { name: "Message-ID", value: "<reply-1@example.com>" },
          ...(options.extraHeaders ?? []),
        ],
        body: {
          data: Buffer.from(options.body ?? "Sure, let's talk.").toString(
            "base64url",
          ),
        },
      },
    },
  };
}

describe("GmailService durable push handling", () => {
  let prisma: ReturnType<typeof createMockPrisma>;
  let suppression: ReturnType<typeof createMockSuppression>;
  let store: ReturnType<typeof createMockConversationStore>;
  let service: GmailService;

  function connect(lastHistoryId: string | null = "100") {
    let durableHistoryId = lastHistoryId;
    prisma.integration.findMany.mockImplementation(async () => [
      {
        id: "int_1",
        orgId: "org_1",
        lastHistoryId: durableHistoryId,
      },
    ]);
    prisma.integration.findUnique.mockImplementation(async () => ({
      ...connectedIntegration(),
      lastHistoryId: durableHistoryId,
    }));
    prisma.integration.updateMany.mockImplementation(async (args) => {
      const input = args as {
        where: { lastHistoryId?: string | null };
        data: { lastHistoryId?: string | null };
      };
      if (input.where.lastHistoryId !== durableHistoryId) return { count: 0 };
      durableHistoryId = input.data.lastHistoryId ?? null;
      return { count: 1 };
    });
  }

  function pushOne(response: ReturnType<typeof messageResponse>) {
    historyList.mockResolvedValue({
      data: {
        history: [{ messagesAdded: [{ message: { id: response.data.id } }] }],
      },
    });
    messagesGet.mockResolvedValue(response);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    historyList.mockReset();
    messagesGet.mockReset();
    historyList.mockResolvedValue({ data: { history: [] } });
    prisma = createMockPrisma();
    suppression = createMockSuppression();
    store = createMockConversationStore();
    service = new GmailService(
      prisma,
      createMockConfig(),
      suppression,
      store,
    );
  });

  it("restores and advances the durable history watermark", async () => {
    connect("100");
    await service.handlePushNotification({
      emailAddress: "owner@example.com",
      historyId: "200",
    });
    expect(historyList).toHaveBeenCalledWith(
      expect.objectContaining({ startHistoryId: "100" }),
    );
    expect(prisma.integration.updateMany).toHaveBeenCalledWith({
      where: {
        orgId: "org_1",
        provider: "gmail",
        lastHistoryId: "100",
      },
      data: { lastHistoryId: "200" },
    });

    await service.handlePushNotification({
      emailAddress: "owner@example.com",
      historyId: "300",
    });
    expect(historyList.mock.calls[1][0]).toMatchObject({ startHistoryId: "200" });
  });

  it("does not regress the watermark for a delayed Pub/Sub notification", async () => {
    connect("100");
    await service.handlePushNotification({
      emailAddress: "owner@example.com",
      historyId: "300",
    });
    await service.handlePushNotification({
      emailAddress: "owner@example.com",
      historyId: "200",
    });

    expect(historyList.mock.calls[1][0]).toMatchObject({ startHistoryId: "300" });
    expect(prisma.integration.updateMany).toHaveBeenLastCalledWith({
      where: {
        orgId: "org_1",
        provider: "gmail",
        lastHistoryId: "100",
      },
      data: { lastHistoryId: "300" },
    });
  });

  it("does not overwrite a newer cursor committed by another API process", async () => {
    connect("100");
    prisma.integration.findUnique
      .mockResolvedValueOnce({ ...connectedIntegration(), lastHistoryId: "100" })
      .mockResolvedValueOnce({ ...connectedIntegration(), lastHistoryId: "100" })
      .mockResolvedValueOnce({ ...connectedIntegration(), lastHistoryId: "250" });
    prisma.integration.updateMany.mockResolvedValueOnce({ count: 0 });

    await service.handlePushNotification({
      emailAddress: "owner@example.com",
      historyId: "200",
    });

    expect(prisma.integration.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.integration.updateMany).toHaveBeenCalledWith({
      where: {
        orgId: "org_1",
        provider: "gmail",
        lastHistoryId: "100",
      },
      data: { lastHistoryId: "200" },
    });
    const state = service as unknown as {
      historyWatermark: Map<string, string>;
    };
    expect(state.historyWatermark.get("org_1")).toBe("250");
  });

  it("paginates Gmail history and de-duplicates provider message ids", async () => {
    connect();
    const response = messageResponse({ from: "Pat <prospect@acme.com>" });
    historyList
      .mockResolvedValueOnce({
        data: {
          history: [{ messagesAdded: [{ message: { id: "msg_1" } }] }],
          nextPageToken: "page_2",
        },
      })
      .mockResolvedValueOnce({
        data: {
          history: [{ messagesAdded: [{ message: { id: "msg_1" } }] }],
        },
      });
    messagesGet.mockResolvedValue(response);

    await service.handlePushNotification({
      emailAddress: "owner@example.com",
      historyId: "200",
    });

    expect(historyList).toHaveBeenCalledTimes(2);
    expect(historyList.mock.calls[1][0]).toMatchObject({ pageToken: "page_2" });
    expect(messagesGet).toHaveBeenCalledTimes(1);
  });

  it("fails closed when one mailbox maps to multiple organizations", async () => {
    prisma.integration.findMany.mockResolvedValue([
      { id: "int_1", orgId: "org_1", lastHistoryId: "100" },
      { id: "int_2", orgId: "org_2", lastHistoryId: "100" },
    ]);

    await expect(
      service.handlePushNotification({
        emailAddress: "shared@example.com",
        historyId: "200",
      }),
    ).rejects.toThrow("mailbox mapping is ambiguous");
    expect(historyList).not.toHaveBeenCalled();
    expect(store.recordInboundGmailMessage).not.toHaveBeenCalled();
    expect(suppression.suppress).not.toHaveBeenCalled();
  });

  it("materializes a correlated reply and never legal-suppresses engagement", async () => {
    connect();
    pushOne(
      messageResponse({
        id: "msg_reply_1",
        from: '"Pat Prospect" <Prospect@Acme.com>',
      }),
    );

    await service.handlePushNotification({
      emailAddress: "owner@example.com",
      historyId: "200",
    });

    expect(store.recordInboundGmailMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org_1",
        integrationId: "int_1",
        providerMessageId: "msg_reply_1",
        providerThreadId: "thread_1",
        internetMessageId: "<reply-1@example.com>",
        senderEmail: "prospect@acme.com",
        senderName: "Pat Prospect",
        toEmails: ["owner@example.com"],
        ccEmails: ["sales@example.com"],
        isUnread: true,
      }),
    );
    expect(suppression.suppress).not.toHaveBeenCalled();
  });

  it("ignores self/SENT messages before conversation materialization", async () => {
    connect();
    pushOne(
      messageResponse({
        from: "Owner <owner@example.com>",
        labelIds: ["SENT"],
      }),
    );
    await service.handlePushNotification({
      emailAddress: "owner@example.com",
      historyId: "200",
    });
    expect(store.recordInboundGmailMessage).not.toHaveBeenCalled();
    expect(suppression.suppress).not.toHaveBeenCalled();
  });

  it("ignores an exact owner sender even when Gmail omits the SENT label", async () => {
    connect();
    pushOne(
      messageResponse({
        from: "Owner <OWNER@example.com>",
        labelIds: ["INBOX"],
      }),
    );

    await service.handlePushNotification({
      emailAddress: "owner@example.com",
      historyId: "200",
    });

    expect(store.recordInboundGmailMessage).not.toHaveBeenCalled();
  });

  it("does not treat an address containing the owner address as self", async () => {
    connect();
    pushOne(
      messageResponse({
        from: "Attacker <owner@example.com.attacker.test>",
      }),
    );

    await service.handlePushNotification({
      emailAddress: "owner@example.com",
      historyId: "200",
    });

    expect(store.recordInboundGmailMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        senderEmail: "owner@example.com.attacker.test",
      }),
    );
  });

  it("keeps DSNs on the legal bounce-suppression path", async () => {
    connect();
    pushOne(
      messageResponse({
        from: "Mail Delivery <mailer-daemon@googlemail.com>",
        subject: "Delivery Status Notification (Failure)",
        extraHeaders: [
          { name: "X-Failed-Recipients", value: "Prospect@Acme.com" },
        ],
      }),
    );
    await service.handlePushNotification({
      emailAddress: "owner@example.com",
      historyId: "200",
    });
    expect(suppression.suppress).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientRef: "prospect@acme.com",
        reason: OutreachSuppressionReason.BOUNCED,
        source: "gmail_dsn",
      }),
    );
    expect(store.recordInboundGmailMessage).not.toHaveBeenCalled();
  });

  it("does not advance the watermark when durable materialization fails", async () => {
    connect();
    pushOne(messageResponse({ from: "prospect@acme.com" }));
    store.recordInboundGmailMessage.mockRejectedValue(new Error("db down"));

    await expect(
      service.handlePushNotification({
        emailAddress: "owner@example.com",
        historyId: "200",
      }),
    ).rejects.toThrow(/Failed to persist 1 Gmail message/);
    expect(prisma.integration.updateMany).not.toHaveBeenCalled();
  });

  it("returns a retryable failure and leaves the hot cursor when watermark persistence fails", async () => {
    connect("100");
    prisma.integration.updateMany
      .mockRejectedValueOnce(new Error("watermark db down"))
      .mockResolvedValueOnce({ count: 1 });

    await expect(
      service.handlePushNotification({
        emailAddress: "owner@example.com",
        historyId: "200",
      }),
    ).rejects.toThrow("watermark db down");

    await service.handlePushNotification({
      emailAddress: "owner@example.com",
      historyId: "200",
    });
    expect(historyList.mock.calls[1][0]).toMatchObject({ startHistoryId: "100" });
  });

  it("preserves the cursor and rethrows transient Gmail history failures", async () => {
    connect("100");
    const transient = Object.assign(new Error("backend unavailable"), {
      response: { status: 503 },
    });
    historyList.mockRejectedValue(transient);

    await expect(
      service.handlePushNotification({
        emailAddress: "owner@example.com",
        historyId: "200",
      }),
    ).rejects.toBe(transient);
    expect(prisma.integration.updateMany).not.toHaveBeenCalled();
  });

  it("resets an expired history cursor without fabricating message work", async () => {
    connect("1");
    historyList.mockRejectedValue(
      Object.assign(new Error("Requested entity was not found"), {
        response: { status: 404 },
      }),
    );
    await expect(
      service.handlePushNotification({
        emailAddress: "owner@example.com",
        historyId: "500",
      }),
    ).resolves.toBeUndefined();
    expect(prisma.integration.updateMany).toHaveBeenCalledWith({
      where: {
        orgId: "org_1",
        provider: "gmail",
        lastHistoryId: "1",
      },
      data: { lastHistoryId: "500" },
    });
    expect(store.recordInboundGmailMessage).not.toHaveBeenCalled();
  });
});
