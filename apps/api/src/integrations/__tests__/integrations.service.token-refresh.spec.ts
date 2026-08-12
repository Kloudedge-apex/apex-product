import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { NotFoundException } from "@nestjs/common";
import type { IntegrationsService } from "../integrations.service";
import type { PrismaService } from "../../prisma/prisma.service";
import { encryptCredentials, decryptCredentials } from "../crypto.util";

/**
 * GL1 go-live blocker regression coverage.
 *
 * `handleOAuthCallback` used to store the provider's raw token JSON, which
 * carries only the relative `expires_in` (seconds). `refreshTokenIfNeeded`
 * then hit `if (!expiresAt) return creds; // still fresh` and NEVER refreshed
 * a callback-stored token — every real send 401'd ~60 minutes after connect
 * (broken since 2026-05-28; the tenant-zero Gmail credential stored
 * 2026-05-20 has a refresh_token but no expires_at).
 *
 * Required behavior under test:
 *   1. Missing `expires_at` is treated as EXPIRED → refresh attempt.
 *   2. Permanent refresh failure (`invalid_grant`) flips the row to ERROR.
 *   3. A successful refresh persists the new token with a new `expires_at`.
 *   4. Split-brain reconciliation: rows written by gmail.service.ts
 *      (`encryptedCredentials` column + `credentials.accountEmail` +
 *      googleapis' `expiry_date`) are readable, and writes keep both shapes
 *      in lock-step without dropping `accountEmail`.
 */

// `OAUTH_CONFIGS` snapshots env at module-eval time, so client ids/secrets
// must exist BEFORE the service module is imported. A static import would
// hoist above these assignments — hence the dynamic import in beforeAll.
let ServiceCtor: typeof import("../integrations.service").IntegrationsService;

beforeAll(async () => {
  process.env.GOOGLE_CLIENT_ID = "test-google-client-id";
  process.env.GOOGLE_CLIENT_SECRET = "test-google-client-secret";
  process.env.MICROSOFT_CLIENT_ID = "test-ms-client-id";
  process.env.MICROSOFT_CLIENT_SECRET = "test-ms-client-secret";
  ({ IntegrationsService: ServiceCtor } = await import("../integrations.service"));
});

type Fn = ReturnType<typeof vi.fn>;

interface PrismaMock {
  integration: {
    findFirst: Fn;
    findUnique: Fn;
    update: Fn;
    upsert: Fn;
  };
}

function mockPrisma(): PrismaMock {
  return {
    integration: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
      upsert: vi.fn().mockResolvedValue({}),
    },
  };
}

/** Stub global fetch to return a fresh JSON Response per call. */
function stubFetch(status: number, body: Record<string, unknown>): Fn {
  const fetchMock = vi.fn().mockImplementation(() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

interface RowOverrides {
  credentials?: unknown;
  encryptedCredentials?: string | null;
  provider?: string;
}

function connectedRow(overrides: RowOverrides = {}) {
  return {
    id: "int_1",
    orgId: "org_a",
    provider: "gmail",
    status: "CONNECTED",
    credentials: { encrypted: "" },
    encryptedCredentials: null,
    ...overrides,
  };
}

function decryptUpdatePayload(prisma: PrismaMock): {
  data: Record<string, unknown>;
  credentialsJson: Record<string, unknown>;
  stored: Record<string, unknown>;
} {
  expect(prisma.integration.update).toHaveBeenCalledTimes(1);
  const arg = prisma.integration.update.mock.calls[0][0] as {
    data: Record<string, unknown>;
  };
  const credentialsJson = arg.data.credentials as Record<string, unknown>;
  const stored = decryptCredentials(credentialsJson.encrypted as string);
  return { data: arg.data, credentialsJson, stored };
}

describe("IntegrationsService GL1 — OAuth token expiry + refresh", () => {
  let prisma: PrismaMock;
  let service: IntegrationsService;

  beforeEach(() => {
    prisma = mockPrisma();
    service = new ServiceCtor(prisma as unknown as PrismaService);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("refreshTokenIfNeeded — missing expires_at means EXPIRED", () => {
    it("refreshes a callback-stored legacy credential that has refresh_token but no expires_at", async () => {
      // Exact shape of the tenant-zero Gmail credential stored 2026-05-20:
      // raw provider JSON, relative expires_in only.
      const legacy = {
        access_token: "stale-access-token",
        refresh_token: "rt-legacy",
        token_type: "Bearer",
        expires_in: 3599,
        scope: "send",
      };
      prisma.integration.findFirst.mockResolvedValue(
        connectedRow({ credentials: { encrypted: encryptCredentials(legacy) } }),
      );
      const fetchMock = stubFetch(200, {
        access_token: "fresh-access-token",
        expires_in: 3600,
        token_type: "Bearer",
      });

      const before = Date.now();
      const result = await service.refreshTokenIfNeeded("org_a", "gmail");
      const after = Date.now();

      // The refresh HTTP call actually happened, with the stored refresh_token.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const init = fetchMock.mock.calls[0][1] as RequestInit;
      const body = String(init.body ?? "");
      expect(body).toContain("grant_type=refresh_token");
      expect(body).toContain("refresh_token=rt-legacy");

      expect(result).not.toBeNull();
      expect(result?.access_token).toBe("fresh-access-token");
      expect(result?.refresh_token).toBe("rt-legacy"); // kept when not rotated
      const expiresAt = result?.expires_at as number;
      expect(expiresAt).toBeGreaterThanOrEqual(before + 3600_000 - 60_000);
      expect(expiresAt).toBeLessThanOrEqual(after + 3600_000 - 60_000);
      expect(result?.expiry_date).toBe(expiresAt);

      // Persisted with the new expires_at, mirrored into both shapes.
      const { data, credentialsJson, stored } = decryptUpdatePayload(prisma);
      expect(stored.access_token).toBe("fresh-access-token");
      expect(stored.expires_at).toBe(expiresAt);
      expect(data.encryptedCredentials).toBe(credentialsJson.encrypted);
      expect(data).not.toHaveProperty("lastSyncAt");
    });

    it("does not refresh a still-fresh token", async () => {
      const fresh = {
        access_token: "fresh",
        refresh_token: "rt",
        expires_at: Date.now() + 3_600_000,
      };
      prisma.integration.findFirst.mockResolvedValue(
        connectedRow({ credentials: { encrypted: encryptCredentials(fresh) } }),
      );
      const fetchMock = stubFetch(200, {});

      const result = await service.refreshTokenIfNeeded("org_a", "gmail");

      expect(result?.access_token).toBe("fresh");
      expect(fetchMock).not.toHaveBeenCalled();
      expect(prisma.integration.update).not.toHaveBeenCalled();
    });

    it("rejects non-Gmail rows before reading provider credentials", async () => {
      await expect(
        service.refreshTokenIfNeeded("org_a", "apollo"),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.integration.findFirst).not.toHaveBeenCalled();
    });
  });

  describe("refreshTokenIfNeeded — failure handling", () => {
    it("flips status to ERROR and returns null on invalid_grant (permanent)", async () => {
      const expired = {
        access_token: "dead",
        refresh_token: "rt-revoked",
        expires_at: Date.now() - 1_000,
      };
      prisma.integration.findFirst.mockResolvedValue(
        connectedRow({ credentials: { encrypted: encryptCredentials(expired) } }),
      );
      stubFetch(400, {
        error: "invalid_grant",
        error_description: "Token has been expired or revoked.",
      });

      const result = await service.refreshTokenIfNeeded("org_a", "gmail");

      expect(result).toBeNull();
      expect(prisma.integration.update).toHaveBeenCalledTimes(1);
      const arg = prisma.integration.update.mock.calls[0][0] as {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      };
      expect(arg.where).toEqual({
        orgId_provider: { orgId: "org_a", provider: "gmail" },
      });
      expect(arg.data.status).toBe("ERROR");
      expect(arg.data.lastErrorAt).toBeInstanceOf(Date);
      expect(String(arg.data.lastErrorMessage)).toContain("invalid_grant");
    });

    it("keeps existing creds and does NOT flip status on a transient 5xx", async () => {
      const expired = {
        access_token: "maybe-still-works",
        refresh_token: "rt",
        expires_at: Date.now() - 1_000,
      };
      prisma.integration.findFirst.mockResolvedValue(
        connectedRow({ credentials: { encrypted: encryptCredentials(expired) } }),
      );
      stubFetch(500, { error: "server_error" });

      const result = await service.refreshTokenIfNeeded("org_a", "gmail");

      expect(result).toEqual(expired);
      expect(prisma.integration.update).not.toHaveBeenCalled();
    });
  });

  describe("split-brain reconciliation with gmail.service.ts row shape", () => {
    const gmailServiceTokens = (expiryDate: number) => ({
      access_token: "column-access-token",
      refresh_token: "rt-column",
      expiry_date: expiryDate,
      token_type: "Bearer",
      scope: "send",
    });

    it("reads the encryptedCredentials column shape and normalizes expiry_date → expires_at", async () => {
      const expiryDate = Date.now() + 3_600_000;
      prisma.integration.findFirst.mockResolvedValue(
        connectedRow({
          credentials: { accountEmail: "founder@tenantzero.com" },
          encryptedCredentials: encryptCredentials(gmailServiceTokens(expiryDate)),
        }),
      );
      const fetchMock = stubFetch(200, {});

      const creds = await service.getDecryptedCredentials("org_a", "gmail");
      expect(creds?.access_token).toBe("column-access-token");
      expect(creds?.expires_at).toBe(expiryDate);

      // Fresh per expiry_date → no refresh attempt.
      const refreshed = await service.refreshTokenIfNeeded("org_a", "gmail");
      expect(refreshed?.access_token).toBe("column-access-token");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("refreshes an expired column-shape row, preserving accountEmail and dual-writing", async () => {
      prisma.integration.findFirst.mockResolvedValue(
        connectedRow({
          credentials: { accountEmail: "founder@tenantzero.com" },
          encryptedCredentials: encryptCredentials(
            gmailServiceTokens(Date.now() - 1_000),
          ),
        }),
      );
      stubFetch(200, { access_token: "fresh", expires_in: 3600 });

      const result = await service.refreshTokenIfNeeded("org_a", "gmail");

      expect(result?.access_token).toBe("fresh");
      const { data, credentialsJson, stored } = decryptUpdatePayload(prisma);
      expect(credentialsJson.accountEmail).toBe("founder@tenantzero.com");
      expect(stored.access_token).toBe("fresh");
      expect(typeof stored.expires_at).toBe("number");
      expect(data.encryptedCredentials).toBe(credentialsJson.encrypted);
    });

    it("prefers the storage shape with the later expiry when both decrypt", async () => {
      const older = {
        access_token: "older-token",
        expires_at: Date.now() + 1_000,
      };
      const newer = gmailServiceTokens(Date.now() + 3_600_000);
      prisma.integration.findFirst.mockResolvedValue(
        connectedRow({
          credentials: { encrypted: encryptCredentials(older) },
          encryptedCredentials: encryptCredentials(newer),
        }),
      );

      const creds = await service.getDecryptedCredentials("org_a", "gmail");
      expect(creds?.access_token).toBe("column-access-token");
    });
  });

  describe("checkHealth — dual-shape read", () => {
    it("reports expired for a gmail.service-shape row whose expiry_date is past", async () => {
      prisma.integration.findFirst.mockResolvedValue(
        connectedRow({
          credentials: { accountEmail: "founder@tenantzero.com" },
          encryptedCredentials: encryptCredentials({
            access_token: "a",
            refresh_token: "rt",
            expiry_date: Date.now() - 1_000,
          }),
        }),
      );

      const health = await service.checkHealth("int_1", "org_a");
      expect(health.status).toBe("expired");
    });
  });
});
