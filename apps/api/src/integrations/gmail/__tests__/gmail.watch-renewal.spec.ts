import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { GmailService } from "../gmail.service";
import { PrismaService } from "../../../prisma/prisma.service";
import { SuppressionService } from "../../../outreach/suppression.service";
import { ConversationStoreService } from "../../../conversation-store/conversation-store.service";
import { ConfigService } from "@nestjs/config";
import { encrypt } from "../../crypto.util";

// Mock google-auth-library (OAuth2Client used for OIDC verification)
vi.mock("google-auth-library", () => {
  class MockOAuth2Client {
    verifyIdToken = vi.fn();
  }
  return { OAuth2Client: MockOAuth2Client };
});

// Hoisted handle so individual tests can steer gmail.users.watch.
const { watchFn } = vi.hoisted(() => ({
  watchFn: vi.fn(),
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
          watch: watchFn,
        },
      }),
    },
    gmail_v1: {},
  };
});

const DAY_MS = 24 * 60 * 60 * 1000;

function createMockPrisma() {
  return {
    integration: {
      findUnique: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({ id: "int_1" }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  } as unknown as PrismaService;
}

function createMockConfig(overrides: Record<string, string> = {}) {
  const configMap: Record<string, string> = {
    GOOGLE_CLIENT_ID: "mock_client_id",
    GOOGLE_CLIENT_SECRET: "mock_client_secret",
    GOOGLE_REDIRECT_URI: "http://localhost:4000/api/integrations/gmail/callback",
    GMAIL_PUSH_AUDIENCE: "https://api.example.com/api/integrations/gmail/push",
    GMAIL_PUSH_PUBLISHER_SA: "gmail-push-publisher@example.iam.gserviceaccount.com",
    GMAIL_PUBSUB_TOPIC: "projects/example/topics/gmail-inbound",
    ...overrides,
  };
  return {
    get: vi.fn().mockImplementation((key: string, defaultValue?: string) => {
      return configMap[key] ?? defaultValue ?? "";
    }),
  } as unknown as ConfigService;
}

function connectedIntegrationRow(orgId: string) {
  const tokens = {
    access_token: "mock_access_token",
    refresh_token: "mock_refresh_token",
    expiry_date: Date.now() + 3600_000,
    token_type: "Bearer",
    scope: "https://www.googleapis.com/auth/gmail.send",
  };
  return {
    id: `int_${orgId}`,
    orgId,
    provider: "gmail",
    status: "CONNECTED",
    encryptedCredentials: encrypt(JSON.stringify(tokens)),
    credentials: { accountEmail: `${orgId}@example.com` },
    lastHistoryId: "900",
    lastSyncAt: new Date(),
  };
}

function buildService(
  mockPrisma: PrismaService,
  config: ConfigService = createMockConfig(),
): GmailService {
  return new GmailService(
    mockPrisma,
    config,
    { suppress: vi.fn() } as unknown as SuppressionService,
    {} as unknown as ConversationStoreService,
  );
}

describe("GmailService watch auto-renewal (GL7)", () => {
  let mockPrisma: ReturnType<typeof createMockPrisma>;
  let service: GmailService;
  const originalWorkerEnabled = process.env.WORKER_ENABLED;

  beforeEach(() => {
    vi.clearAllMocks();
    watchFn.mockReset();
    watchFn.mockResolvedValue({
      data: { historyId: "1000", expiration: String(Date.now() + 7 * DAY_MS) },
    });
    mockPrisma = createMockPrisma();
    service = buildService(mockPrisma);
  });

  afterEach(() => {
    // Always tear down any interval onModuleInit scheduled.
    service.onModuleDestroy();
    if (originalWorkerEnabled === undefined) delete process.env.WORKER_ENABLED;
    else process.env.WORKER_ENABLED = originalWorkerEnabled;
    vi.useRealTimers();
  });

  function enableWorker(): void {
    process.env.WORKER_ENABLED = "true";
  }

  function setConnectedIntegrations(orgIds: string[]): void {
    (mockPrisma.integration.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(
      orgIds.map((orgId) => ({ orgId })),
    );
    (mockPrisma.integration.findUnique as ReturnType<typeof vi.fn>).mockImplementation(
      (args: { where: { orgId_provider: { orgId: string } } }) =>
        Promise.resolve(connectedIntegrationRow(args.where.orgId_provider.orgId)),
    );
  }

  describe("worker gating (onModuleInit)", () => {
    it("does nothing when WORKER_ENABLED is not 'true' (api process must not sweep)", async () => {
      delete process.env.WORKER_ENABLED;

      await service.onModuleInit();

      expect(mockPrisma.integration.findMany).not.toHaveBeenCalled();
      expect(watchFn).not.toHaveBeenCalled();
    });

    it("runs the boot sweep immediately in the worker process", async () => {
      enableWorker();
      setConnectedIntegrations(["org_1"]);

      await service.onModuleInit();

      expect(mockPrisma.integration.findMany).toHaveBeenCalledTimes(1);
      expect(watchFn).toHaveBeenCalledTimes(1);
    });

    it("re-sweeps daily, and onModuleDestroy stops the interval", async () => {
      vi.useFakeTimers();
      enableWorker();
      setConnectedIntegrations(["org_1"]);

      await service.onModuleInit();
      expect(mockPrisma.integration.findMany).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(DAY_MS);
      expect(mockPrisma.integration.findMany).toHaveBeenCalledTimes(2);

      service.onModuleDestroy();
      await vi.advanceTimersByTimeAsync(3 * DAY_MS);
      expect(mockPrisma.integration.findMany).toHaveBeenCalledTimes(2);
    });
  });

  describe("renewWatchesForConnectedIntegrations", () => {
    it("queries only CONNECTED gmail integrations and registers a watch per org", async () => {
      setConnectedIntegrations(["org_1", "org_2"]);

      const result = await service.renewWatchesForConnectedIntegrations();

      expect(mockPrisma.integration.findMany).toHaveBeenCalledWith({
        where: { provider: "gmail", status: "CONNECTED" },
        select: { orgId: true },
      });
      expect(watchFn).toHaveBeenCalledTimes(2);
      expect(watchFn).toHaveBeenCalledWith({
        userId: "me",
        requestBody: {
          topicName: "projects/example/topics/gmail-inbound",
          labelIds: ["INBOX"],
          labelFilterBehavior: "INCLUDE",
        },
      });
      expect(result).toEqual({ renewed: 2, failed: 0 });
    });

    it("survives a per-org Gmail API failure and keeps renewing the rest", async () => {
      setConnectedIntegrations(["org_bad", "org_good"]);
      watchFn
        .mockRejectedValueOnce(new Error("invalid_grant: token revoked"))
        .mockResolvedValueOnce({ data: { historyId: "2000" } });

      const result = await service.renewWatchesForConnectedIntegrations();

      expect(watchFn).toHaveBeenCalledTimes(2);
      expect(result).toEqual({ renewed: 1, failed: 1 });
      expect(mockPrisma.integration.updateMany).toHaveBeenCalledWith({
        where: {
          orgId: "org_bad",
          provider: "gmail",
          status: "CONNECTED",
        },
        data: {
          lastErrorAt: expect.any(Date),
          lastErrorMessage: expect.stringContaining("invalid_grant"),
        },
      });
      const failureWrite = (
        mockPrisma.integration.updateMany as ReturnType<typeof vi.fn>
      ).mock.calls.find((call) =>
        String(call[0]?.data?.lastErrorMessage ?? "").includes(
          "invalid_grant",
        ),
      )?.[0];
      expect(failureWrite?.data).not.toHaveProperty("status");
      expect(failureWrite?.data).not.toHaveProperty("lastSyncAt");
    });

    it("survives a per-org credential failure (disconnected mid-sweep) without aborting", async () => {
      (mockPrisma.integration.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        { orgId: "org_revoked" },
        { orgId: "org_good" },
      ]);
      (mockPrisma.integration.findUnique as ReturnType<typeof vi.fn>).mockImplementation(
        (args: { where: { orgId_provider: { orgId: string } } }) => {
          const orgId = args.where.orgId_provider.orgId;
          // org_revoked disconnected between findMany and the token load.
          if (orgId === "org_revoked") return Promise.resolve(null);
          return Promise.resolve(connectedIntegrationRow(orgId));
        },
      );

      const result = await service.renewWatchesForConnectedIntegrations();

      expect(result).toEqual({ renewed: 1, failed: 1 });
      expect(watchFn).toHaveBeenCalledTimes(1);
    });

    it("no-ops when GMAIL_PUBSUB_TOPIC is unset (dev without push infra)", async () => {
      service.onModuleDestroy();
      service = buildService(mockPrisma, createMockConfig({ GMAIL_PUBSUB_TOPIC: "" }));

      const result = await service.renewWatchesForConnectedIntegrations();

      expect(result).toEqual({ renewed: 0, failed: 0 });
      expect(mockPrisma.integration.findMany).not.toHaveBeenCalled();
      expect(watchFn).not.toHaveBeenCalled();
    });

    it("is single-flight: an overlapping call returns immediately without a second query", async () => {
      let resolveFindMany: (rows: Array<{ orgId: string }>) => void = () => undefined;
      (mockPrisma.integration.findMany as ReturnType<typeof vi.fn>).mockReturnValue(
        new Promise<Array<{ orgId: string }>>((resolve) => {
          resolveFindMany = resolve;
        }),
      );

      const first = service.renewWatchesForConnectedIntegrations();
      const second = await service.renewWatchesForConnectedIntegrations();

      expect(second).toEqual({ renewed: 0, failed: 0 });
      expect(mockPrisma.integration.findMany).toHaveBeenCalledTimes(1);

      resolveFindMany([]);
      await expect(first).resolves.toEqual({ renewed: 0, failed: 0 });
    });
  });

  describe("registerWatch cursor initialization", () => {
    it("initializes only a connected integration with no existing cursor", async () => {
      setConnectedIntegrations(["org_1"]);

      await service.registerWatch("org_1");

      expect(mockPrisma.integration.updateMany).toHaveBeenCalledWith({
        where: {
          orgId: "org_1",
          provider: "gmail",
          status: "CONNECTED",
          lastHistoryId: null,
        },
        data: { lastHistoryId: "1000" },
      });
      expect(mockPrisma.integration.updateMany).toHaveBeenCalledWith({
        where: {
          orgId: "org_1",
          provider: "gmail",
          status: "CONNECTED",
        },
        data: {
          lastSyncAt: expect.any(Date),
          lastErrorAt: null,
          lastErrorMessage: null,
        },
      });
    });
  });
});
