import type { Request } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const jwtMocks = vi.hoisted(() => ({
  verifyClerkToken: vi.fn(),
}));

vi.mock("../../common/jwt.util", () => ({
  verifyClerkToken: jwtMocks.verifyClerkToken,
}));

import { OrgsController } from "../orgs.controller";
import { OrgsService } from "../orgs.service";
import type { PrismaService } from "../../prisma/prisma.service";

const NOW = new Date("2026-08-13T00:00:00.000Z");

const fullOrgRow = {
  id: "org_1",
  name: "Acme",
  slug: "acme",
  website: "https://acme.example",
  physicalAddress: "1 Main Street",
  country: "US",
  senderName: "Ava",
  plan: "GROWTH",
  trialEndsAt: null,
  billingId: "subscription_operational_id",
  createdAt: NOW,
  updatedAt: NOW,
  users: [
    {
      id: "user_1",
      orgId: "org_1",
      email: "owner@acme.example",
      name: "Owner",
      role: "OWNER",
      clerkId: "clerk_secret_identifier",
      apiKey: "api_secret",
      passwordHash: "password_hash_secret",
      createdAt: NOW,
    },
  ],
  integrations: [
    {
      id: "integration_1",
      orgId: "org_1",
      provider: "gmail",
      credentials: { accessToken: "oauth_secret" },
      encryptedCredentials: "encrypted_oauth_secret",
      status: "CONNECTED",
      scopes: ["gmail.send"],
      lastSyncAt: NOW,
      lastErrorAt: null,
      lastErrorMessage: null,
      lastHistoryId: "history_1",
      createdAt: NOW,
      updatedAt: NOW,
    },
  ],
  agents: [
    {
      id: "agent_1",
      name: "SDR",
      config: { providerToken: "agent_secret" },
    },
  ],
};

const fullUserRow = {
  ...fullOrgRow.users[0],
  org: fullOrgRow,
};

const forbiddenResponseKeys = new Set([
  "apiKey",
  "billingId",
  "passwordHash",
  "clerkId",
  "credentials",
  "encryptedCredentials",
  "lastHistoryId",
  "orgId",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function projectRecord(
  source: Record<string, unknown>,
  select: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, selection] of Object.entries(select)) {
    if (selection === true) {
      result[key] = source[key];
      continue;
    }
    const relationSelection = asRecord(selection);
    const nestedSelect = asRecord(relationSelection?.select);
    if (!nestedSelect) continue;
    const relation = source[key];
    result[key] = Array.isArray(relation)
      ? relation.map((item) =>
          projectRecord(item as Record<string, unknown>, nestedSelect),
        )
      : asRecord(relation)
        ? projectRecord(relation as Record<string, unknown>, nestedSelect)
        : relation;
  }
  return result;
}

function collectForbiddenKeys(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectForbiddenKeys(item, found);
    return found;
  }
  const record = asRecord(value);
  if (!record) return found;
  for (const [key, nested] of Object.entries(record)) {
    if (forbiddenResponseKeys.has(key)) found.push(key);
    collectForbiddenKeys(nested, found);
  }
  return found;
}

function buildController() {
  const orgFindUnique = vi.fn(async (args: Record<string, unknown>) => {
    const select = asRecord(args.select);
    return select ? projectRecord(fullOrgRow, select) : fullOrgRow;
  });
  const orgCreate = vi.fn(async (args: Record<string, unknown>) => {
    const select = asRecord(args.select);
    return select ? projectRecord(fullOrgRow, select) : fullOrgRow;
  });
  const userFindUnique = vi.fn(async (args: Record<string, unknown>) => {
    const select = asRecord(args.select);
    return select ? projectRecord(fullUserRow, select) : fullUserRow;
  });
  const prisma = {
    org: { findUnique: orgFindUnique, create: orgCreate },
    user: { findUnique: userFindUnique },
    integration: { count: vi.fn().mockResolvedValue(1) },
    outreachArtifact: { count: vi.fn().mockResolvedValue(0) },
  };
  const service = new OrgsService(prisma as unknown as PrismaService);
  const controller = new OrgsController(
    service,
    prisma as unknown as PrismaService,
  );
  return {
    controller,
    service,
    orgCreate,
    orgFindUnique,
    userFindUnique,
  };
}

describe("organization response sanitization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    jwtMocks.verifyClerkToken.mockResolvedValue({
      sub: "clerk_user_1",
      email: "owner@acme.example",
    });
  });

  it("GET /orgs/:id exposes only allowlisted user and integration fields", async () => {
    const { controller, orgFindUnique } = buildController();

    const result = await controller.findOne("org_1", "org_1");

    expect(collectForbiddenKeys(result)).toEqual([]);
    expect(result).not.toHaveProperty("agents");
    expect(result).not.toHaveProperty("billingId");
    expect(result.users[0]).toEqual({
      id: "user_1",
      email: "owner@acme.example",
      name: "Owner",
      role: "OWNER",
      createdAt: NOW,
    });
    expect(result.integrations[0]).toEqual({
      id: "integration_1",
      provider: "gmail",
      status: "CONNECTED",
      scopes: ["gmail.send"],
      lastSyncAt: NOW,
      lastErrorAt: null,
      lastErrorMessage: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const query = orgFindUnique.mock.calls[0]?.[0];
    expect(query).not.toHaveProperty("include");
    expect(collectForbiddenKeys(query?.select)).toEqual([]);
  });

  it("GET /orgs/me cannot return user auth fields or provider credentials", async () => {
    const { controller, userFindUnique } = buildController();
    const req = {
      headers: { authorization: "Bearer signed-clerk-token" },
    } as unknown as Request;

    const result = await controller.findMe(req);

    expect(result).not.toBeNull();
    expect(collectForbiddenKeys(result)).toEqual([]);
    expect(result).not.toHaveProperty("agents");
    expect(result).not.toHaveProperty("users");
    expect(result).not.toHaveProperty("billingId");
    expect(result?.integrations[0]).not.toHaveProperty("orgId");
    expect(result?.integrations[0]).not.toHaveProperty("lastHistoryId");
    expect(result?.integrations[0]).not.toHaveProperty("credentials");
    expect(result?.integrations[0]).not.toHaveProperty(
      "encryptedCredentials",
    );
    expect(result?.sendReadiness).toEqual(
      expect.objectContaining({ mailboxConnected: true }),
    );
    const query = userFindUnique.mock.calls[0]?.[0];
    expect(query).not.toHaveProperty("include");
    expect(collectForbiddenKeys(query?.select)).toEqual([]);
  });

  it("POST /orgs existing-user path returns only allowlisted user fields", async () => {
    const { service, orgFindUnique, userFindUnique } = buildController();

    const result = await service.create({
      name: "Acme",
      clerkUserId: "clerk_user_1",
      email: "owner@acme.example",
    });

    expect(collectForbiddenKeys(result)).toEqual([]);
    expect(result?.users[0]).toEqual({
      id: "user_1",
      email: "owner@acme.example",
      name: "Owner",
      role: "OWNER",
      createdAt: NOW,
    });
    expect(userFindUnique).toHaveBeenCalledWith({
      where: { clerkId: "clerk_user_1" },
      select: { orgId: true },
    });
    expect(collectForbiddenKeys(orgFindUnique.mock.calls[0]?.[0]?.select)).toEqual(
      [],
    );
  });

  it("POST /orgs new-org path applies the same safe response projection", async () => {
    const { service, orgCreate, userFindUnique } = buildController();
    userFindUnique.mockResolvedValueOnce(null);

    const result = await service.create({
      name: "Acme",
      clerkUserId: "clerk_user_new",
      email: "new-owner@acme.example",
    });

    expect(collectForbiddenKeys(result)).toEqual([]);
    expect(result).not.toHaveProperty("agents");
    expect(result).not.toHaveProperty("integrations");
    const query = orgCreate.mock.calls[0]?.[0];
    expect(query).not.toHaveProperty("include");
    expect(collectForbiddenKeys(query?.select)).toEqual([]);
  });
});
