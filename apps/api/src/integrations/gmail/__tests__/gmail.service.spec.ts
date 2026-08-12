import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { UnauthorizedException, BadRequestException } from "@nestjs/common";
import { google } from "googleapis";
import { GmailService } from "../gmail.service";
import { PrismaService } from "../../../prisma/prisma.service";
import { SuppressionService } from "../../../outreach/suppression.service";
import { ConversationStoreService } from "../../../conversation-store/conversation-store.service";
import { ConfigService } from "@nestjs/config";
import { encrypt } from "../../crypto.util";

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_API_PUBLIC_URL = process.env.API_PUBLIC_URL;

// Mock google-auth-library (OAuth2Client used for OIDC verification)
vi.mock("google-auth-library", () => {
  class MockOAuth2Client {
    verifyIdToken = vi.fn();
  }
  return { OAuth2Client: MockOAuth2Client };
});

// Mock googleapis
vi.mock("googleapis", () => {
  class MockOAuth2 {
    generateAuthUrl = vi.fn().mockReturnValue("https://accounts.google.com/o/oauth2/auth?mock=1");
    getToken = vi.fn().mockResolvedValue({
      tokens: {
        access_token: "mock_access_token",
        refresh_token: "mock_refresh_token",
        expiry_date: Date.now() + 3600_000,
        token_type: "Bearer",
        scope: "https://www.googleapis.com/auth/gmail.send",
      },
    });
    setCredentials = vi.fn();
    on = vi.fn();
  }

  const mockGmail = {
    users: {
      getProfile: vi.fn().mockResolvedValue({
        data: { emailAddress: "owner@example.com" },
      }),
      watch: vi.fn().mockResolvedValue({
        data: { historyId: "12345", expiration: "1234567890" },
      }),
      history: {
        list: vi.fn().mockResolvedValue({
          data: {
            history: [
              {
                messagesAdded: [
                  { message: { id: "msg_new_1", threadId: "thread_new" } },
                ],
              },
            ],
          },
        }),
      },
      messages: {
        list: vi.fn().mockResolvedValue({
          data: {
            messages: [
              { id: "msg_1", threadId: "thread_1" },
              { id: "msg_2", threadId: "thread_2" },
            ],
            nextPageToken: "next_token",
          },
        }),
        get: vi.fn().mockResolvedValue({
          data: {
            id: "msg_1",
            threadId: "thread_1",
            snippet: "Hello world",
            labelIds: ["INBOX"],
            payload: {
              headers: [
                { name: "From", value: "sender@example.com" },
                { name: "To", value: "recipient@example.com" },
                { name: "Subject", value: "Test Subject" },
                { name: "Date", value: "Mon, 1 Jan 2026 00:00:00 +0000" },
              ],
              body: {
                data: Buffer.from("Hello, this is a test email.").toString("base64url"),
              },
            },
          },
        }),
        send: vi.fn().mockResolvedValue({
          data: {
            id: "sent_msg_1",
            threadId: "thread_1",
          },
        }),
      },
      threads: {
        get: vi.fn().mockResolvedValue({
          data: {
            id: "thread_1",
            snippet: "Thread snippet",
            messages: [
              {
                id: "msg_1",
                threadId: "thread_1",
                snippet: "First message",
                labelIds: ["INBOX"],
                payload: {
                  headers: [
                    { name: "From", value: "sender@example.com" },
                    { name: "To", value: "recipient@example.com" },
                    { name: "Subject", value: "Thread Subject" },
                    { name: "Date", value: "Mon, 1 Jan 2026 00:00:00 +0000" },
                  ],
                  body: {
                    data: Buffer.from("Thread message body").toString("base64url"),
                  },
                },
              },
            ],
          },
        }),
      },
    },
  };

  return {
    google: {
      auth: { OAuth2: MockOAuth2 },
      gmail: vi.fn().mockReturnValue(mockGmail),
    },
    gmail_v1: {},
  };
});

function createMockPrisma() {
  return {
    integration: {
      findUnique: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      upsert: vi.fn().mockResolvedValue({ id: "int_1" }),
      update: vi.fn().mockResolvedValue({ id: "int_1" }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      create: vi.fn().mockResolvedValue({ id: "int_1" }),
    },
  } as unknown as PrismaService;
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

function createMockSuppression() {
  return {
    suppress: vi.fn().mockResolvedValue({ created: true }),
  } as unknown as SuppressionService;
}

function createMockConfig() {
  const configMap: Record<string, string> = {
    GOOGLE_CLIENT_ID: "mock_client_id",
    GOOGLE_CLIENT_SECRET: "mock_client_secret",
    GOOGLE_REDIRECT_URI: "http://localhost:4000/api/integrations/gmail/callback",
    FRONTEND_URL: "http://localhost:3000",
    GMAIL_PUSH_AUDIENCE: "https://api.example.com/api/integrations/gmail/push",
    GMAIL_PUSH_PUBLISHER_SA: "gmail-push-publisher@example.iam.gserviceaccount.com",
    GMAIL_PUBSUB_TOPIC: "projects/example/topics/gmail-inbound",
  };
  return {
    get: vi.fn().mockImplementation((key: string, defaultValue?: string) => {
      return configMap[key] ?? defaultValue ?? "";
    }),
  } as unknown as ConfigService;
}

function createConnectedIntegration() {
  const tokens = {
    access_token: "mock_access_token",
    refresh_token: "mock_refresh_token",
    expiry_date: Date.now() + 3600_000,
    token_type: "Bearer",
    scope: "https://www.googleapis.com/auth/gmail.send",
  };
  return {
    id: "int_1",
    orgId: "org_1",
    provider: "gmail",
    status: "CONNECTED",
    encryptedCredentials: encrypt(JSON.stringify(tokens)),
    credentials: {},
  };
}

describe("GmailService", () => {
  let service: GmailService;
  let mockPrisma: ReturnType<typeof createMockPrisma>;
  let mockConfig: ReturnType<typeof createMockConfig>;
  let mockConversationStore: ReturnType<typeof createMockConversationStore>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma = createMockPrisma();
    mockConfig = createMockConfig();
    mockConversationStore = createMockConversationStore();
    service = new GmailService(
      mockPrisma,
      mockConfig,
      createMockSuppression(),
      mockConversationStore,
    );
  });

  afterEach(() => {
    if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    if (ORIGINAL_API_PUBLIC_URL === undefined) delete process.env.API_PUBLIC_URL;
    else process.env.API_PUBLIC_URL = ORIGINAL_API_PUBLIC_URL;
  });

  describe("getAuthUrl", () => {
    it("should return a Google OAuth URL", () => {
      const url = service.getAuthUrl("org_1");
      expect(url).toContain("accounts.google.com");
    });
  });

  describe("handleCallback", () => {
    it("should exchange code for tokens and upsert integration", async () => {
      await service.handleCallback("auth_code_123", "org_1");

      expect(mockPrisma.integration.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { orgId_provider: { orgId: "org_1", provider: "gmail" } },
          create: expect.objectContaining({
            orgId: "org_1",
            provider: "gmail",
            status: "CONNECTED",
          }),
        }),
      );
    });
  });

  describe("listMessages", () => {
    it("should list messages for connected integration", async () => {
      const integration = createConnectedIntegration();
      (mockPrisma.integration.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(integration);

      const result = await service.listMessages("org_1", { maxResults: 10 });

      expect(result.messages).toHaveLength(2);
      expect(result.nextPageToken).toBe("next_token");
      expect(result.messages[0].id).toBe("msg_1");
      expect(result.messages[0].from).toBe("sender@example.com");
      expect(result.messages[0].subject).toBe("Test Subject");
    });

    it("should throw UnauthorizedException if not connected", async () => {
      (mockPrisma.integration.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      await expect(service.listMessages("org_1")).rejects.toThrow(UnauthorizedException);
    });
  });

  describe("getMessage", () => {
    it("should get a single message with decoded body", async () => {
      const integration = createConnectedIntegration();
      (mockPrisma.integration.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(integration);

      const msg = await service.getMessage("org_1", "msg_1");

      expect(msg.id).toBe("msg_1");
      expect(msg.from).toBe("sender@example.com");
      expect(msg.body).toBe("Hello, this is a test email.");
    });
  });

  describe("getThread", () => {
    it("should return a thread with all messages", async () => {
      const integration = createConnectedIntegration();
      (mockPrisma.integration.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(integration);

      const thread = await service.getThread("org_1", "thread_1");

      expect(thread.id).toBe("thread_1");
      expect(thread.messages).toHaveLength(1);
      expect(thread.messages[0].body).toBe("Thread message body");
    });
  });

  describe("sendEmail", () => {
    it("should send a plain text email", async () => {
      const integration = createConnectedIntegration();
      (mockPrisma.integration.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(integration);

      const result = await service.sendEmail("org_1", {
        to: "recipient@example.com",
        subject: "Test Email",
        body: "Hello, this is a test.",
      });

      expect(result.id).toBe("sent_msg_1");
      expect(result.threadId).toBe("thread_1");
    });

    it("should send an HTML email with multipart body", async () => {
      const integration = createConnectedIntegration();
      (mockPrisma.integration.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(integration);

      const result = await service.sendEmail("org_1", {
        to: "recipient@example.com",
        subject: "HTML Test",
        body: "Plain text version",
        html: "<h1>HTML version</h1>",
      });

      expect(result.id).toBe("sent_msg_1");
    });

    it("advertises only the public HTTPS one-click unsubscribe URL", async () => {
      process.env.NODE_ENV = "production";
      process.env.API_PUBLIC_URL = "https://api.workforceos.xyz";
      const integration = createConnectedIntegration();
      (mockPrisma.integration.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(integration);

      await service.sendEmail("org_1", {
        to: "recipient@example.com",
        subject: "Test Email",
        body: "Hello, this is a test.",
        unsubscribeContext: {
          orgId: "org_1",
          recipientRef: "recipient@example.com",
        },
      });

      const gmailFactory = google.gmail as unknown as ReturnType<typeof vi.fn>;
      const gmailClient = gmailFactory.mock.results.at(-1)?.value as {
        users: {
          messages: { send: ReturnType<typeof vi.fn> };
        };
      };
      const request = gmailClient.users.messages.send.mock.calls.at(-1)?.[0] as {
        requestBody?: { raw?: string };
      };
      const decoded = Buffer.from(
        request.requestBody?.raw ?? "",
        "base64url",
      ).toString("utf8");
      expect(decoded).toMatch(
        /List-Unsubscribe: <https:\/\/api\.workforceos\.xyz\/api\/u\/[A-Za-z0-9_.~%-]+>/,
      );
      expect(decoded).toContain(
        "List-Unsubscribe-Post: List-Unsubscribe=One-Click",
      );
      expect(decoded).not.toContain("mailto:");
    });
  });

  describe("searchMessages", () => {
    it("should search messages using Gmail query syntax", async () => {
      const integration = createConnectedIntegration();
      (mockPrisma.integration.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(integration);

      const results = await service.searchMessages("org_1", "from:sender@example.com subject:test");

      expect(results).toHaveLength(2);
    });
  });

  describe("verifyPushAuth", () => {
    function mockOidcPayload(payload: Record<string, unknown> | null) {
      const oidcClient = (service as unknown as { oidcClient: { verifyIdToken: ReturnType<typeof vi.fn> } })
        .oidcClient;
      oidcClient.verifyIdToken = vi.fn().mockResolvedValue({
        getPayload: () => payload,
      });
    }

    it("rejects when no Authorization header is sent", async () => {
      expect(await service.verifyPushAuth(undefined)).toBe(false);
    });

    it("rejects when Authorization header doesn't start with Bearer", async () => {
      expect(await service.verifyPushAuth("Basic xxx")).toBe(false);
    });

    it("accepts a valid OIDC token signed by the configured publisher SA", async () => {
      mockOidcPayload({
        email: "gmail-push-publisher@example.iam.gserviceaccount.com",
        email_verified: true,
        aud: "https://api.example.com/api/integrations/gmail/push",
      });
      expect(await service.verifyPushAuth("Bearer valid.jwt.token")).toBe(true);
    });

    it("rejects an OIDC token signed by an unexpected SA", async () => {
      mockOidcPayload({
        email: "imposter@evil.iam.gserviceaccount.com",
        email_verified: true,
      });
      expect(await service.verifyPushAuth("Bearer valid.jwt.token")).toBe(false);
    });

    it("rejects when email_verified is false", async () => {
      mockOidcPayload({
        email: "gmail-push-publisher@example.iam.gserviceaccount.com",
        email_verified: false,
      });
      expect(await service.verifyPushAuth("Bearer valid.jwt.token")).toBe(false);
    });

    it("rejects when verifyIdToken throws (bad signature / wrong audience)", async () => {
      const oidcClient = (service as unknown as { oidcClient: { verifyIdToken: ReturnType<typeof vi.fn> } })
        .oidcClient;
      oidcClient.verifyIdToken = vi.fn().mockRejectedValue(new Error("Invalid token"));
      expect(await service.verifyPushAuth("Bearer bogus.jwt")).toBe(false);
    });

    it("fails closed when audience or publisher SA env is empty", async () => {
      const blankConfig = {
        get: vi.fn().mockImplementation((_key: string, def?: string) => def ?? ""),
      } as unknown as ConfigService;
      const blankService = new GmailService(
        createMockPrisma(),
        blankConfig,
        createMockSuppression(),
        createMockConversationStore(),
      );
      expect(await blankService.verifyPushAuth("Bearer anything")).toBe(false);
    });
  });

  describe("handlePushNotification", () => {
    function setupConnectedIntegration() {
      const integration = createConnectedIntegration();
      // findIntegrationByEmail
      (mockPrisma.integration.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "int_1",
          orgId: "org_1",
          lastHistoryId: null,
        },
      ]);
      // getTokens
      (mockPrisma.integration.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
        integration,
      );
    }

    it("materializes a correlated new inbound message", async () => {
      setupConnectedIntegration();

      // Override message metadata: inbound, not sent by us.
      const { google } = await import("googleapis");
      const gmailMock = (google.gmail as ReturnType<typeof vi.fn>).mock.results[0]
        ?.value ?? (google.gmail as unknown as () => unknown)();
      type GmailMockShape = {
        users: { messages: { get: ReturnType<typeof vi.fn> } };
      };
      const typed = gmailMock as GmailMockShape;
      typed.users.messages.get.mockResolvedValueOnce({
        data: {
          id: "msg_new_1",
          threadId: "thread_new",
          snippet: "thanks for reaching out",
          labelIds: ["INBOX", "UNREAD"],
          payload: {
            headers: [
              { name: "From", value: "prospect@acme.com" },
              { name: "To", value: "owner@example.com" },
              { name: "Subject", value: "Re: quick question" },
              { name: "Date", value: "Mon, 1 Jan 2026 00:00:00 +0000" },
            ],
            body: {
              data: Buffer.from("Sure, let's chat next week.").toString("base64url"),
            },
          },
        },
      });

      await service.handlePushNotification({
        emailAddress: "owner@example.com",
        historyId: "12345",
      });

      expect(mockConversationStore.recordInboundGmailMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          orgId: "org_1",
          integrationId: "int_1",
          providerMessageId: "msg_new_1",
          providerThreadId: "thread_new",
          senderEmail: "prospect@acme.com",
          subject: "Re: quick question",
        }),
      );
    });

    it("materializes without any agent lookup or runtime trigger", async () => {
      setupConnectedIntegration();

      const { google } = await import("googleapis");
      type GmailMockShape = {
        users: { messages: { get: ReturnType<typeof vi.fn> } };
      };
      const typed = (google.gmail as unknown as () => GmailMockShape)();
      typed.users.messages.get.mockResolvedValueOnce({
        data: {
          id: "msg_new_1",
          threadId: "thread_new",
          snippet: "snippet",
          labelIds: ["INBOX"],
          payload: {
            headers: [
              { name: "From", value: "prospect@acme.com" },
              { name: "Subject", value: "Re: ping" },
              { name: "Date", value: "Mon, 1 Jan 2026 00:00:00 +0000" },
            ],
            body: {
              data: Buffer.from("hi").toString("base64url"),
            },
          },
        },
      });

      await expect(
        service.handlePushNotification({
          emailAddress: "owner@example.com",
          historyId: "67890",
        }),
      ).resolves.not.toThrow();

      expect(mockConversationStore.recordInboundGmailMessage).toHaveBeenCalledOnce();
    });

    it("skips messages sent by us (SENT label)", async () => {
      setupConnectedIntegration();

      const { google } = await import("googleapis");
      type GmailMockShape = {
        users: { messages: { get: ReturnType<typeof vi.fn> } };
      };
      const typed = (google.gmail as unknown as () => GmailMockShape)();
      typed.users.messages.get.mockResolvedValueOnce({
        data: {
          id: "msg_outbound",
          threadId: "thread_x",
          snippet: "our outbound",
          labelIds: ["SENT"],
          payload: {
            headers: [
              { name: "From", value: "owner@example.com" },
              { name: "Subject", value: "Outbound" },
              { name: "Date", value: "Mon, 1 Jan 2026 00:00:00 +0000" },
            ],
            body: { data: Buffer.from("hi").toString("base64url") },
          },
        },
      });

      await service.handlePushNotification({
        emailAddress: "owner@example.com",
        historyId: "55555",
      });

      expect(mockConversationStore.recordInboundGmailMessage).not.toHaveBeenCalled();
    });

    it("returns silently when no integration matches the emailAddress", async () => {
      (mockPrisma.integration.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(
        [],
      );

      await expect(
        service.handlePushNotification({
          emailAddress: "unknown@example.com",
          historyId: "1",
        }),
      ).resolves.not.toThrow();

      expect(mockConversationStore.recordInboundGmailMessage).not.toHaveBeenCalled();
    });
  });

  describe("token management", () => {
    it("should throw if integration has no encrypted credentials", async () => {
      (mockPrisma.integration.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "int_1",
        orgId: "org_1",
        provider: "gmail",
        status: "CONNECTED",
        encryptedCredentials: null,
        credentials: {},
      });

      await expect(service.listMessages("org_1")).rejects.toThrow(UnauthorizedException);
    });

    it("should throw if integration status is not CONNECTED", async () => {
      (mockPrisma.integration.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "int_1",
        orgId: "org_1",
        provider: "gmail",
        status: "REVOKED",
        encryptedCredentials: "some_data",
        credentials: {},
      });

      await expect(service.listMessages("org_1")).rejects.toThrow(UnauthorizedException);
    });
  });
});
