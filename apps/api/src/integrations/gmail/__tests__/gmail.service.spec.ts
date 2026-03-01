import { describe, it, expect, beforeEach, vi } from "vitest";
import { UnauthorizedException, BadRequestException } from "@nestjs/common";
import { GmailService } from "../gmail.service";
import { PrismaService } from "../../../prisma/prisma.service";
import { ConfigService } from "@nestjs/config";
import { encrypt } from "../../crypto.util";

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
      findFirst: vi.fn(),
      upsert: vi.fn().mockResolvedValue({ id: "int_1" }),
      update: vi.fn().mockResolvedValue({ id: "int_1" }),
      create: vi.fn().mockResolvedValue({ id: "int_1" }),
    },
  } as unknown as PrismaService;
}

function createMockConfig() {
  const configMap: Record<string, string> = {
    GOOGLE_CLIENT_ID: "mock_client_id",
    GOOGLE_CLIENT_SECRET: "mock_client_secret",
    GOOGLE_REDIRECT_URI: "http://localhost:4000/api/integrations/gmail/callback",
    FRONTEND_URL: "http://localhost:3000",
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

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma = createMockPrisma();
    mockConfig = createMockConfig();
    service = new GmailService(mockPrisma, mockConfig);
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
  });

  describe("searchMessages", () => {
    it("should search messages using Gmail query syntax", async () => {
      const integration = createConnectedIntegration();
      (mockPrisma.integration.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(integration);

      const results = await service.searchMessages("org_1", "from:sender@example.com subject:test");

      expect(results).toHaveLength(2);
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
