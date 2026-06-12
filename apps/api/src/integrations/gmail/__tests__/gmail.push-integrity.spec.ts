import { describe, it, expect, beforeEach, vi } from "vitest";
import { OutreachSuppressionReason } from "@prisma/client";
import { GmailService } from "../gmail.service";
import { PrismaService } from "../../../prisma/prisma.service";
import { RuntimeService } from "../../../runtime/runtime.service";
import { SuppressionService } from "../../../outreach/suppression.service";
import { ConfigService } from "@nestjs/config";
import { encrypt } from "../../crypto.util";

// Mock google-auth-library (OAuth2Client used for OIDC verification)
vi.mock("google-auth-library", () => {
  class MockOAuth2Client {
    verifyIdToken = vi.fn();
  }
  return { OAuth2Client: MockOAuth2Client };
});

// Hoisted handles so individual tests can steer history.list / messages.get.
const { historyList, messagesGet } = vi.hoisted(() => ({
  historyList: vi.fn(),
  messagesGet: vi.fn(),
}));

// Mock googleapis
vi.mock("googleapis", () => {
  class MockOAuth2 {
    generateAuthUrl = vi.fn().mockReturnValue("https://accounts.google.com/o/oauth2/auth?mock=1");
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
      findFirst: vi.fn(),
      update: vi.fn().mockResolvedValue({ id: "int_1" }),
    },
    agent: {
      findFirst: vi.fn().mockResolvedValue({ id: "agent_reply", orgId: "org_1" }),
    },
    agentLog: {
      create: vi.fn().mockResolvedValue({ id: "log_1" }),
    },
  } as unknown as PrismaService;
}

function createMockRuntime() {
  return {
    triggerRun: vi.fn().mockResolvedValue({ id: "run_1" }),
  } as unknown as RuntimeService;
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

/** Builds a gmail.users.messages.get response for an inbound message. */
function gmailMessageResponse(opts: {
  id?: string;
  from: string;
  subject?: string;
  labelIds?: string[];
  extraHeaders?: Array<{ name: string; value: string }>;
  bodyText?: string;
}) {
  return {
    data: {
      id: opts.id ?? "msg_new_1",
      threadId: "thread_new",
      snippet: "snippet",
      labelIds: opts.labelIds ?? ["INBOX", "UNREAD"],
      payload: {
        headers: [
          { name: "From", value: opts.from },
          { name: "To", value: "owner@example.com" },
          { name: "Subject", value: opts.subject ?? "Re: quick question" },
          { name: "Date", value: "Mon, 1 Jan 2026 00:00:00 +0000" },
          ...(opts.extraHeaders ?? []),
        ],
        body: {
          data: Buffer.from(opts.bodyText ?? "Sure, let's chat.").toString("base64url"),
        },
      },
    },
  };
}

describe("GmailService push integrity (audit B8)", () => {
  let service: GmailService;
  let mockPrisma: ReturnType<typeof createMockPrisma>;
  let mockRuntime: ReturnType<typeof createMockRuntime>;
  let mockSuppression: ReturnType<typeof createMockSuppression>;

  function setupConnectedIntegration(lastHistoryId: string | null = null) {
    (mockPrisma.integration.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      orgId: "org_1",
      lastHistoryId,
    });
    (mockPrisma.integration.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      createConnectedIntegration(),
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    historyList.mockReset();
    messagesGet.mockReset();
    // Default: no new messages — individual tests override.
    historyList.mockResolvedValue({ data: { history: [] } });
    mockPrisma = createMockPrisma();
    mockRuntime = createMockRuntime();
    mockSuppression = createMockSuppression();
    service = new GmailService(
      mockPrisma,
      createMockConfig(),
      mockRuntime,
      mockSuppression,
    );
  });

  describe("durable history watermark", () => {
    it("restores the watermark from Integration.lastHistoryId on a cold cache", async () => {
      setupConnectedIntegration("100");

      await service.handlePushNotification({
        emailAddress: "owner@example.com",
        historyId: "200",
      });

      expect(historyList).toHaveBeenCalledWith(
        expect.objectContaining({ startHistoryId: "100" }),
      );
    });

    it("falls back to the pushed historyId when nothing is persisted", async () => {
      setupConnectedIntegration(null);

      await service.handlePushNotification({
        emailAddress: "owner@example.com",
        historyId: "200",
      });

      expect(historyList).toHaveBeenCalledWith(
        expect.objectContaining({ startHistoryId: "200" }),
      );
    });

    it("persists the new watermark write-through after a processed push", async () => {
      setupConnectedIntegration("100");

      await service.handlePushNotification({
        emailAddress: "owner@example.com",
        historyId: "200",
      });

      expect(mockPrisma.integration.update).toHaveBeenCalledWith({
        where: { orgId_provider: { orgId: "org_1", provider: "gmail" } },
        data: { lastHistoryId: "200" },
      });
    });

    it("prefers the in-memory hot layer over a stale persisted value", async () => {
      setupConnectedIntegration("100");

      await service.handlePushNotification({
        emailAddress: "owner@example.com",
        historyId: "200",
      });
      // DB read still reports the stale "100" — the hot layer has "200".
      await service.handlePushNotification({
        emailAddress: "owner@example.com",
        historyId: "300",
      });

      expect(historyList).toHaveBeenCalledTimes(2);
      expect(historyList.mock.calls[1][0]).toMatchObject({ startHistoryId: "200" });
    });

    it("persists the reset watermark when history.list rejects (too-old watermark)", async () => {
      setupConnectedIntegration("1");
      historyList.mockRejectedValueOnce(new Error("Requested entity was not found."));

      await expect(
        service.handlePushNotification({
          emailAddress: "owner@example.com",
          historyId: "500",
        }),
      ).resolves.not.toThrow();

      expect(mockPrisma.integration.update).toHaveBeenCalledWith({
        where: { orgId_provider: { orgId: "org_1", provider: "gmail" } },
        data: { lastHistoryId: "500" },
      });
      expect(mockRuntime.triggerRun).not.toHaveBeenCalled();
    });

    it("does not throw when watermark persistence fails (hot layer still advances)", async () => {
      setupConnectedIntegration("100");
      (mockPrisma.integration.update as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("db down"),
      );

      await expect(
        service.handlePushNotification({
          emailAddress: "owner@example.com",
          historyId: "200",
        }),
      ).resolves.not.toThrow();

      // Hot layer advanced despite the persistence failure.
      await service.handlePushNotification({
        emailAddress: "owner@example.com",
        historyId: "300",
      });
      expect(historyList.mock.calls[1][0]).toMatchObject({ startHistoryId: "200" });
    });
  });

  describe("DSN / bounce handling", () => {
    function pushOneMessage(response: ReturnType<typeof gmailMessageResponse>) {
      historyList.mockResolvedValue({
        data: {
          history: [
            { messagesAdded: [{ message: { id: response.data.id } }] },
          ],
        },
      });
      messagesGet.mockResolvedValue(response);
    }

    it("suppresses the X-Failed-Recipients address and skips reply dispatch for mailer-daemon DSNs", async () => {
      setupConnectedIntegration();
      pushOneMessage(
        gmailMessageResponse({
          from: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>",
          subject: "Delivery Status Notification (Failure)",
          extraHeaders: [
            { name: "X-Failed-Recipients", value: "Prospect@Acme.com" },
          ],
          bodyText: "Your message wasn't delivered because the address couldn't be found.",
        }),
      );

      await service.handlePushNotification({
        emailAddress: "owner@example.com",
        historyId: "200",
      });

      expect(mockSuppression.suppress).toHaveBeenCalledWith(
        expect.objectContaining({
          orgId: "org_1",
          recipientRef: "prospect@acme.com",
          reason: OutreachSuppressionReason.BOUNCED,
          source: "gmail_dsn",
        }),
      );
      expect(mockRuntime.triggerRun).not.toHaveBeenCalled();
      expect(mockPrisma.agentLog.create).not.toHaveBeenCalled();
    });

    it("treats postmaster senders as DSNs", async () => {
      setupConnectedIntegration();
      pushOneMessage(
        gmailMessageResponse({
          from: "postmaster@partner-mta.example",
          subject: "Undeliverable: hello",
          bodyText: "Delivery has failed.\nFinal-Recipient: rfc822; bounce@target.io\nAction: failed",
        }),
      );

      await service.handlePushNotification({
        emailAddress: "owner@example.com",
        historyId: "200",
      });

      expect(mockSuppression.suppress).toHaveBeenCalledWith(
        expect.objectContaining({ recipientRef: "bounce@target.io" }),
      );
      expect(mockRuntime.triggerRun).not.toHaveBeenCalled();
    });

    it("detects multipart/report delivery-status content and extracts Final-Recipient from the body", async () => {
      setupConnectedIntegration();
      pushOneMessage(
        gmailMessageResponse({
          from: "Bounce Notifier <bounces@mta.example>",
          subject: "Undelivered Mail Returned to Sender",
          extraHeaders: [
            {
              name: "Content-Type",
              value: 'multipart/report; report-type=delivery-status; boundary="b1"',
            },
          ],
          bodyText:
            "Reporting-MTA: dns; mta.example\nFinal-Recipient: rfc822; Prospect@Acme.com\nAction: failed\nStatus: 5.1.1",
        }),
      );

      await service.handlePushNotification({
        emailAddress: "owner@example.com",
        historyId: "200",
      });

      expect(mockSuppression.suppress).toHaveBeenCalledWith(
        expect.objectContaining({
          recipientRef: "prospect@acme.com",
          reason: OutreachSuppressionReason.BOUNCED,
        }),
      );
      expect(mockRuntime.triggerRun).not.toHaveBeenCalled();
    });

    it("extracts the recipient from Gmail's human-readable phrasing when no machine fields exist", async () => {
      setupConnectedIntegration();
      pushOneMessage(
        gmailMessageResponse({
          from: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>",
          subject: "Delivery Status Notification (Failure)",
          bodyText:
            "Your message wasn't delivered to bob@gone-startup.io because the address couldn't be found, or is unable to receive mail.",
        }),
      );

      await service.handlePushNotification({
        emailAddress: "owner@example.com",
        historyId: "200",
      });

      expect(mockSuppression.suppress).toHaveBeenCalledWith(
        expect.objectContaining({ recipientRef: "bob@gone-startup.io" }),
      );
    });

    it("drops a DSN with no extractable recipient without dispatch or suppression", async () => {
      setupConnectedIntegration();
      pushOneMessage(
        gmailMessageResponse({
          from: "mailer-daemon@googlemail.com",
          subject: "Delivery Status Notification (Failure)",
          bodyText: "Delivery incomplete. There was a temporary problem.",
        }),
      );

      await expect(
        service.handlePushNotification({
          emailAddress: "owner@example.com",
          historyId: "200",
        }),
      ).resolves.not.toThrow();

      expect(mockSuppression.suppress).not.toHaveBeenCalled();
      expect(mockRuntime.triggerRun).not.toHaveBeenCalled();
    });

    it("still dispatches the Reply Handler for a regular prospect reply", async () => {
      setupConnectedIntegration();
      pushOneMessage(
        gmailMessageResponse({
          from: "Pat Prospect <prospect@acme.com>",
          subject: "Re: quick question",
          bodyText: "Sure, let's chat next week.",
        }),
      );

      await service.handlePushNotification({
        emailAddress: "owner@example.com",
        historyId: "200",
      });

      expect(mockRuntime.triggerRun).toHaveBeenCalledWith("agent_reply", "org_1");
      expect(mockSuppression.suppress).not.toHaveBeenCalled();
    });
  });
});
