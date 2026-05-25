import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LinkedInService } from "../linkedin.service";
import { circuitBreakerRegistry } from "../../../common/http-retry.util";
import type { PrismaService } from "../../../prisma/prisma.service";
import type { IntegrationsService } from "../../integrations.service";

const ORIGINAL_FETCH = globalThis.fetch;

function mockResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockPrisma(integrationRow: { id: string } | null = { id: "int_1" }) {
  return {
    integration: {
      findFirst: vi.fn().mockResolvedValue(integrationRow),
    },
  } as unknown as PrismaService & {
    integration: { findFirst: ReturnType<typeof vi.fn> };
  };
}

function mockIntegrations(
  creds: Record<string, unknown> | null = { access_token: "real_li_token" },
) {
  return {
    refreshTokenIfNeeded: vi.fn().mockResolvedValue(creds),
  } as unknown as IntegrationsService & {
    refreshTokenIfNeeded: ReturnType<typeof vi.fn>;
  };
}

beforeEach(() => {
  circuitBreakerRegistry._resetForTests();
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

describe("LinkedInService.sendMessage", () => {
  describe("integration resolution", () => {
    it("returns linkedin_not_connected when no integration found", async () => {
      const prisma = mockPrisma(null);
      const integrations = mockIntegrations();
      const svc = new LinkedInService(prisma, integrations);

      const result = await svc.sendMessage("org_1", null, {
        recipientUrn: "urn:li:person:abc",
        body: "hi",
      });

      expect(result.ok).toBe(false);
      expect(result.error).toBe("linkedin_not_connected");
      expect(prisma.integration.findFirst).toHaveBeenCalledWith({
        where: { orgId: "org_1", provider: "linkedin", status: "CONNECTED" },
        orderBy: { createdAt: "asc" },
        select: { id: true },
      });
    });

    it("scopes findFirst by integrationId+orgId+provider when integrationId supplied", async () => {
      const prisma = mockPrisma({ id: "int_xyz" });
      const integrations = mockIntegrations();
      const svc = new LinkedInService(prisma, integrations);
      // Stub fetch so the API call resolves cleanly — we only care about
      // the integration-lookup shape here.
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(mockResponse(200, { id: "msg_1" })) as unknown as typeof fetch;

      await svc.sendMessage("org_1", "int_xyz", {
        recipientUrn: "urn:li:person:abc",
        body: "hi",
      });

      expect(prisma.integration.findFirst).toHaveBeenCalledWith({
        where: {
          id: "int_xyz",
          orgId: "org_1",
          provider: "linkedin",
          status: "CONNECTED",
        },
        select: { id: true },
      });
    });

    it("returns linkedin_not_connected when refreshTokenIfNeeded yields no token", async () => {
      const prisma = mockPrisma({ id: "int_1" });
      const integrations = mockIntegrations(null);
      const svc = new LinkedInService(prisma, integrations);

      const result = await svc.sendMessage("org_1", null, {
        recipientUrn: "urn:li:person:abc",
        body: "hi",
      });

      expect(result.ok).toBe(false);
      expect(result.error).toBe("linkedin_not_connected");
    });

    it("refuses to call live API when stored token is a mock_ value", async () => {
      const prisma = mockPrisma({ id: "int_1" });
      const integrations = mockIntegrations({ access_token: "mock_linkedin_xyz" });
      const svc = new LinkedInService(prisma, integrations);
      globalThis.fetch = vi.fn() as unknown as typeof fetch;

      const result = await svc.sendMessage("org_1", null, {
        recipientUrn: "urn:li:person:abc",
        body: "hi",
      });

      expect(result.ok).toBe(false);
      expect(result.error).toBe("linkedin_mock_credentials");
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });
  });

  describe("API call shape", () => {
    it("posts to /v2/messages with Bearer token and LinkedIn protocol headers", async () => {
      const prisma = mockPrisma();
      const integrations = mockIntegrations();
      const fetchMock = vi
        .fn()
        .mockResolvedValue(mockResponse(200, { id: "msg_99" }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const svc = new LinkedInService(prisma, integrations);
      await svc.sendMessage("org_1", null, {
        recipientUrn: "urn:li:person:abc",
        body: "hello world",
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe("https://api.linkedin.com/v2/messages");
      expect((init as RequestInit).method).toBe("POST");
      const headers = (init as RequestInit).headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer real_li_token");
      expect(headers["Content-Type"]).toBe("application/json");
      expect(headers["X-Restli-Protocol-Version"]).toBe("2.0.0");

      const body = JSON.parse((init as RequestInit).body as string) as {
        message: { body: string };
        recipients: string[];
      };
      expect(body.message.body).toBe("hello world");
      expect(body.recipients).toEqual(["urn:li:person:abc"]);
    });

    it("returns ok:true with messageId from response body", async () => {
      const prisma = mockPrisma();
      const integrations = mockIntegrations();
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(mockResponse(201, { id: "linkedin_msg_xyz" })) as unknown as typeof fetch;

      const svc = new LinkedInService(prisma, integrations);
      const result = await svc.sendMessage("org_1", null, {
        recipientUrn: "urn:li:person:abc",
        body: "hi",
      });

      expect(result.ok).toBe(true);
      expect(result.messageId).toBe("linkedin_msg_xyz");
      expect(result.status).toBe(201);
    });
  });

  describe("error handling", () => {
    it("retries on 429 then succeeds", async () => {
      const prisma = mockPrisma();
      const integrations = mockIntegrations();
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(mockResponse(429, {}))
        .mockResolvedValueOnce(mockResponse(200, { id: "msg_1" }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const svc = new LinkedInService(prisma, integrations);
      const result = await svc.sendMessage("org_1", null, {
        recipientUrn: "urn:li:person:abc",
        body: "hi",
      });

      expect(result.ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    }, 15000);

    it("classifies 403 as linkedin_api_not_available", async () => {
      const prisma = mockPrisma();
      const integrations = mockIntegrations();
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(
          new Response("permission denied", { status: 403 }),
        ) as unknown as typeof fetch;

      const svc = new LinkedInService(prisma, integrations);
      const result = await svc.sendMessage("org_1", null, {
        recipientUrn: "urn:li:person:abc",
        body: "hi",
      });

      expect(result.ok).toBe(false);
      expect(result.error).toBe("linkedin_api_not_available");
      expect(result.status).toBe(403);
      expect(result.details).toContain("permission denied");
    });

    it("classifies 401 as linkedin_api_not_available", async () => {
      const prisma = mockPrisma();
      const integrations = mockIntegrations();
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(new Response("unauthorized", { status: 401 })) as unknown as typeof fetch;

      const svc = new LinkedInService(prisma, integrations);
      const result = await svc.sendMessage("org_1", null, {
        recipientUrn: "urn:li:person:abc",
        body: "hi",
      });

      expect(result.ok).toBe(false);
      expect(result.error).toBe("linkedin_api_not_available");
    });

    it("classifies 422 as linkedin_invalid_request", async () => {
      const prisma = mockPrisma();
      const integrations = mockIntegrations();
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(new Response("bad urn", { status: 422 })) as unknown as typeof fetch;

      const svc = new LinkedInService(prisma, integrations);
      const result = await svc.sendMessage("org_1", null, {
        recipientUrn: "urn:li:person:abc",
        body: "hi",
      });

      expect(result.ok).toBe(false);
      expect(result.error).toBe("linkedin_invalid_request");
    });

    it("returns linkedin_send_failed when network error escapes retry loop", async () => {
      const prisma = mockPrisma();
      const integrations = mockIntegrations();
      globalThis.fetch = vi
        .fn()
        .mockRejectedValue(new Error("ECONNRESET")) as unknown as typeof fetch;

      const svc = new LinkedInService(prisma, integrations);
      const result = await svc.sendMessage("org_1", null, {
        recipientUrn: "urn:li:person:abc",
        body: "hi",
      });

      expect(result.ok).toBe(false);
      expect(result.error).toBe("linkedin_send_failed");
      expect(result.details).toContain("ECONNRESET");
    }, 20000);
  });
});
