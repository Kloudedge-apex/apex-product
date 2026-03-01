import { describe, it, expect, beforeEach, vi } from "vitest";
import { UnauthorizedException } from "@nestjs/common";
import { HubspotService } from "../hubspot.service";
import { PrismaService } from "../../../prisma/prisma.service";
import { ConfigService } from "@nestjs/config";
import { encrypt } from "../../crypto.util";

// Mock @hubspot/api-client
const mockCreate = vi.fn();
const mockGetById = vi.fn();
const mockUpdate = vi.fn();
const mockDoSearch = vi.fn();

vi.mock("@hubspot/api-client", () => {
  return {
    Client: class MockClient {
      accessToken?: string;
      constructor(opts?: { accessToken?: string }) {
        this.accessToken = opts?.accessToken;
      }
      oauth = {
        tokensApi: {
          create: vi.fn().mockResolvedValue({
            accessToken: "new_access_token",
            refreshToken: "new_refresh_token",
            expiresIn: 3600,
          }),
        },
      };
      crm = {
        contacts: {
          basicApi: {
            create: mockCreate.mockResolvedValue({
              id: "contact_1",
              properties: { email: "john@example.com", firstname: "John", lastname: "Doe" },
              createdAt: new Date("2026-01-01"),
              updatedAt: new Date("2026-01-01"),
            }),
            getById: mockGetById.mockResolvedValue({
              id: "contact_1",
              properties: { email: "john@example.com", firstname: "John", lastname: "Doe" },
              createdAt: new Date("2026-01-01"),
              updatedAt: new Date("2026-01-01"),
            }),
            update: mockUpdate.mockResolvedValue({
              id: "contact_1",
              properties: { email: "john@example.com", firstname: "John", lastname: "Doe-Updated" },
              createdAt: new Date("2026-01-01"),
              updatedAt: new Date("2026-01-02"),
            }),
          },
          searchApi: {
            doSearch: mockDoSearch.mockResolvedValue({
              total: 1,
              results: [{
                id: "contact_1",
                properties: { email: "john@example.com", firstname: "John" },
                createdAt: new Date("2026-01-01"),
                updatedAt: new Date("2026-01-01"),
              }],
            }),
          },
        },
        deals: {
          basicApi: {
            create: mockCreate.mockResolvedValue({
              id: "deal_1",
              properties: { dealname: "Big Deal", amount: "10000", dealstage: "closedwon" },
              createdAt: new Date("2026-01-01"),
              updatedAt: new Date("2026-01-01"),
            }),
            getById: mockGetById.mockResolvedValue({
              id: "deal_1",
              properties: { dealname: "Big Deal", amount: "10000" },
              createdAt: new Date("2026-01-01"),
              updatedAt: new Date("2026-01-01"),
            }),
            update: mockUpdate.mockResolvedValue({
              id: "deal_1",
              properties: { dealname: "Big Deal", amount: "15000" },
              createdAt: new Date("2026-01-01"),
              updatedAt: new Date("2026-01-02"),
            }),
          },
          searchApi: {
            doSearch: mockDoSearch.mockResolvedValue({
              total: 1,
              results: [{
                id: "deal_1",
                properties: { dealname: "Big Deal", amount: "10000" },
                createdAt: new Date("2026-01-01"),
                updatedAt: new Date("2026-01-01"),
              }],
            }),
          },
        },
        companies: {
          basicApi: {
            create: mockCreate.mockResolvedValue({
              id: "company_1",
              properties: { name: "Acme Inc", domain: "acme.com" },
              createdAt: new Date("2026-01-01"),
              updatedAt: new Date("2026-01-01"),
            }),
            getById: mockGetById.mockResolvedValue({
              id: "company_1",
              properties: { name: "Acme Inc", domain: "acme.com" },
              createdAt: new Date("2026-01-01"),
              updatedAt: new Date("2026-01-01"),
            }),
          },
          searchApi: {
            doSearch: mockDoSearch.mockResolvedValue({
              total: 1,
              results: [{
                id: "company_1",
                properties: { name: "Acme Inc", domain: "acme.com" },
                createdAt: new Date("2026-01-01"),
                updatedAt: new Date("2026-01-01"),
              }],
            }),
          },
        },
      };
    },
  };
});

function createMockPrisma() {
  return {
    integration: {
      findUnique: vi.fn(),
      upsert: vi.fn().mockResolvedValue({ id: "int_1" }),
      update: vi.fn().mockResolvedValue({ id: "int_1" }),
    },
  } as unknown as PrismaService;
}

function createMockConfig() {
  const configMap: Record<string, string> = {
    HUBSPOT_CLIENT_ID: "mock_client_id",
    HUBSPOT_CLIENT_SECRET: "mock_client_secret",
    HUBSPOT_REDIRECT_URI: "http://localhost:4000/api/integrations/hubspot/callback",
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
    expires_at: Date.now() + 3600_000,
    token_type: "Bearer",
  };
  return {
    id: "int_1",
    orgId: "org_1",
    provider: "hubspot",
    status: "CONNECTED",
    encryptedCredentials: encrypt(JSON.stringify(tokens)),
    credentials: {},
  };
}

describe("HubspotService", () => {
  let service: HubspotService;
  let mockPrisma: ReturnType<typeof createMockPrisma>;
  let mockConfig: ReturnType<typeof createMockConfig>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma = createMockPrisma();
    mockConfig = createMockConfig();
    service = new HubspotService(mockPrisma, mockConfig);
  });

  describe("getAuthUrl", () => {
    it("should return a HubSpot OAuth URL", () => {
      const url = service.getAuthUrl("org_1");
      expect(url).toContain("app.hubspot.com/oauth/authorize");
      expect(url).toContain("client_id=mock_client_id");
      expect(url).toContain("state=org_1");
    });
  });

  describe("handleCallback", () => {
    it("should exchange code for tokens and upsert integration", async () => {
      await service.handleCallback("auth_code_123", "org_1");

      expect(mockPrisma.integration.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { orgId_provider: { orgId: "org_1", provider: "hubspot" } },
          create: expect.objectContaining({
            orgId: "org_1",
            provider: "hubspot",
            status: "CONNECTED",
          }),
        }),
      );
    });
  });

  describe("contacts", () => {
    it("should create a contact", async () => {
      const integration = createConnectedIntegration();
      (mockPrisma.integration.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(integration);

      const result = await service.createContact("org_1", {
        email: "john@example.com",
        firstname: "John",
        lastname: "Doe",
      });

      expect(result.id).toBeDefined();
      expect(mockCreate).toHaveBeenCalled();
    });

    it("should get a contact by ID", async () => {
      const integration = createConnectedIntegration();
      (mockPrisma.integration.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(integration);

      const result = await service.getContact("org_1", "contact_1");

      expect(result.id).toBeDefined();
      expect(mockGetById).toHaveBeenCalledWith("contact_1", expect.any(Array));
    });

    it("should update a contact", async () => {
      const integration = createConnectedIntegration();
      (mockPrisma.integration.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(integration);

      const result = await service.updateContact("org_1", "contact_1", { lastname: "Doe-Updated" });

      expect(result.id).toBeDefined();
      expect(mockUpdate).toHaveBeenCalled();
    });

    it("should search contacts", async () => {
      const integration = createConnectedIntegration();
      (mockPrisma.integration.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(integration);

      const result = await service.searchContacts("org_1", "john");

      expect(result.total).toBeGreaterThanOrEqual(0);
      expect(result.results).toBeDefined();
      expect(mockDoSearch).toHaveBeenCalled();
    });
  });

  describe("deals", () => {
    it("should create a deal", async () => {
      const integration = createConnectedIntegration();
      (mockPrisma.integration.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(integration);

      const result = await service.createDeal("org_1", {
        dealname: "Big Deal",
        amount: "10000",
      });

      expect(result.id).toBeDefined();
    });

    it("should get a deal by ID", async () => {
      const integration = createConnectedIntegration();
      (mockPrisma.integration.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(integration);

      const result = await service.getDeal("org_1", "deal_1");

      expect(result.id).toBeDefined();
    });

    it("should search deals", async () => {
      const integration = createConnectedIntegration();
      (mockPrisma.integration.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(integration);

      const result = await service.searchDeals("org_1", "big deal");

      expect(result.total).toBeGreaterThanOrEqual(0);
    });
  });

  describe("companies", () => {
    it("should create a company", async () => {
      const integration = createConnectedIntegration();
      (mockPrisma.integration.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(integration);

      const result = await service.createCompany("org_1", {
        name: "Acme Inc",
        domain: "acme.com",
      });

      expect(result.id).toBeDefined();
    });

    it("should search companies", async () => {
      const integration = createConnectedIntegration();
      (mockPrisma.integration.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(integration);

      const result = await service.searchCompanies("org_1", "acme");

      expect(result.total).toBeGreaterThanOrEqual(0);
    });
  });

  describe("webhook handler", () => {
    it("should process webhook events", async () => {
      const events = [
        {
          portalId: 123456,
          objectType: "CONTACT",
          subscriptionType: "contact.creation",
          objectId: 789,
        },
        {
          portalId: 123456,
          objectType: "DEAL",
          subscriptionType: "deal.propertyChange",
          objectId: 101,
        },
      ];

      const result = await service.handleWebhook(events);
      expect(result.processed).toBe(2);
    });

    it("should skip malformed webhook events", async () => {
      const events = [
        { portalId: 123456 }, // missing required fields
        {}, // empty event
      ];

      const result = await service.handleWebhook(events);
      expect(result.processed).toBe(0);
    });
  });

  describe("token management", () => {
    it("should throw if HubSpot not connected", async () => {
      (mockPrisma.integration.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      await expect(service.getContact("org_1", "contact_1")).rejects.toThrow(UnauthorizedException);
    });

    it("should throw if no encrypted credentials", async () => {
      (mockPrisma.integration.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "int_1",
        orgId: "org_1",
        provider: "hubspot",
        status: "CONNECTED",
        encryptedCredentials: null,
      });

      await expect(service.getContact("org_1", "contact_1")).rejects.toThrow(UnauthorizedException);
    });
  });
});
