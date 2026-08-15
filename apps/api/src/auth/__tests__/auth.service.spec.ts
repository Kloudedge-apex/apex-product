import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AuthService,
  type ClerkWebhookDelivery,
} from "../auth.service";

const BASE_SECONDS = 1_800_000_000;

function delivery(
  id: string,
  timestampSeconds = BASE_SECONDS,
): ClerkWebhookDelivery {
  return { id, timestampSeconds };
}

function organizationData(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "org_clerk_1",
    name: "Acme",
    slug: "acme",
    updated_at: BASE_SECONDS * 1000,
    ...overrides,
  };
}

function membershipData(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "mem_1",
    role: "org:admin",
    created_at: BASE_SECONDS * 1000,
    updated_at: BASE_SECONDS * 1000,
    organization: {
      id: "org_clerk_1",
      slug: "acme",
      name: "Acme",
    },
    public_user_data: {
      user_id: "user_clerk_1",
      identifier: "owner@acme.example",
    },
    ...overrides,
  };
}

function makePrisma() {
  const state = {
    orgs: new Map<string, Record<string, unknown>>(),
    users: new Map<string, Record<string, unknown>>(),
    cutover: {
      id: 1,
      minimumEventVersion: BigInt(BASE_SECONDS * 1000 - 1),
      ready: true,
      inventoryEvidenceHash: `sha256:${"a".repeat(64)}`,
      expectedActiveOrganizationCount: 1,
      expectedActiveMembershipCount: 1,
      expectedActiveUserCount: 1,
      establishedAt: new Date(BASE_SECONDS * 1000),
    } as Record<string, unknown> | null,
    organizationLifecycles: new Map<string, Record<string, unknown>>(),
    membershipLifecycles: new Map<string, Record<string, unknown>>(),
    userLifecycles: new Map<string, Record<string, unknown>>(),
  };
  let userSequence = 0;

  const prisma: Record<string, unknown> = {};
  Object.assign(prisma, {
    $queryRaw: vi.fn().mockResolvedValue([]),
    $transaction: vi.fn(
      async (callback: (tx: typeof prisma) => Promise<unknown>) => {
        const snapshots = {
          orgs: new Map(state.orgs),
          users: new Map(state.users),
          organizationLifecycles: new Map(state.organizationLifecycles),
          membershipLifecycles: new Map(state.membershipLifecycles),
          userLifecycles: new Map(state.userLifecycles),
        };
        const sequenceSnapshot = userSequence;
        try {
          return await callback(prisma);
        } catch (error) {
          restoreMap(state.orgs, snapshots.orgs);
          restoreMap(state.users, snapshots.users);
          restoreMap(
            state.organizationLifecycles,
            snapshots.organizationLifecycles,
          );
          restoreMap(
            state.membershipLifecycles,
            snapshots.membershipLifecycles,
          );
          restoreMap(state.userLifecycles, snapshots.userLifecycles);
          userSequence = sequenceSnapshot;
          throw error;
        }
      },
    ),
    org: {
      findUnique: vi.fn(async ({ where }: { where: { clerkOrgId: string } }) =>
        state.orgs.get(where.clerkOrgId) ?? null,
      ),
      upsert: vi.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { clerkOrgId: string };
          create: Record<string, unknown>;
          update: Record<string, unknown>;
        }) => {
          const current = state.orgs.get(where.clerkOrgId);
          const next = current
            ? { ...current, ...update }
            : { id: `org_internal_${state.orgs.size + 1}`, ...create };
          state.orgs.set(where.clerkOrgId, next);
          return next;
        },
      ),
    },
    user: {
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn(async ({ where }: { where: { clerkId: string } }) =>
        state.users.get(where.clerkId) ?? null,
      ),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        userSequence += 1;
        const next = { id: `user_internal_${userSequence}`, ...data };
        state.users.set(String(data.clerkId), next);
        return next;
      }),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => {
          const entry = [...state.users.entries()].find(
            ([, user]) => user.id === where.id,
          );
          if (!entry) throw new Error(`Missing test user ${where.id}`);
          const next = { ...entry[1], ...data };
          state.users.set(entry[0], next);
          return next;
        },
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { clerkId?: string; orgId?: string };
          data: Record<string, unknown>;
        }) => {
          let count = 0;
          for (const [key, user] of state.users) {
            if (where.clerkId && user.clerkId !== where.clerkId) continue;
            if (where.orgId && user.orgId !== where.orgId) continue;
            state.users.set(key, { ...user, ...data });
            count += 1;
          }
          return { count };
        },
      ),
    },
    clerkOrganizationLifecycle: mapModel(
      state.organizationLifecycles,
      "clerkOrgId",
    ),
    clerkIdentityCutover: {
      findUnique: vi.fn(async () => state.cutover),
    },
    clerkMembershipLifecycle: mapModel(
      state.membershipLifecycles,
      "clerkMembershipId",
    ),
    clerkUserLifecycle: mapModel(state.userLifecycles, "clerkUserId"),
  });

  return { prisma, state };
}

function restoreMap(
  target: Map<string, Record<string, unknown>>,
  snapshot: Map<string, Record<string, unknown>>,
): void {
  target.clear();
  for (const [key, value] of snapshot) target.set(key, value);
}

function mapModel(
  rows: Map<string, Record<string, unknown>>,
  idField: string,
) {
  return {
    findUnique: vi.fn(
      async ({ where }: { where: Record<string, string> }) =>
        rows.get(where[idField]) ?? null,
    ),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      rows.set(String(data[idField]), { ...data });
      return data;
    }),
    update: vi.fn(
      async ({
        where,
        data,
      }: {
        where: Record<string, string>;
        data: Record<string, unknown>;
      }) => {
        const current = rows.get(where[idField]);
        if (!current) throw new Error(`Missing test lifecycle ${where[idField]}`);
        const next = { ...current, ...data };
        rows.set(where[idField], next);
        return next;
      },
    ),
  };
}

describe("AuthService Clerk identity lifecycle", () => {
  let harness: ReturnType<typeof makePrisma>;
  let service: AuthService;

  beforeEach(() => {
    harness = makePrisma();
    service = new AuthService(harness.prisma as never);
  });

  async function syncOrganization(): Promise<void> {
    await service.handleWebhook(
      { type: "organization.created", data: organizationData() },
      delivery("evt_org_created"),
    );
  }

  it("returns /auth/me through an explicit credential-free projection", async () => {
    const safeUser = {
      id: "user_internal_1",
      email: "owner@acme.example",
      name: "Owner",
      role: UserRole.OWNER,
      createdAt: new Date("2026-08-13T00:00:00.000Z"),
      org: {
        id: "org_internal_1",
        name: "Acme",
        slug: "acme",
        plan: "TRIAL",
      },
    };
    const user = harness.prisma.user as {
      findFirst: ReturnType<typeof vi.fn>;
    };
    user.findFirst.mockResolvedValueOnce(safeUser);

    const result = await service.getUserByClerkId("user_clerk_1");
    expect(result).toEqual(safeUser);
    expect(user.findFirst).toHaveBeenCalledWith({
      where: { clerkId: "user_clerk_1", membershipActive: true },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        createdAt: true,
        org: {
          select: {
            id: true,
            name: true,
            slug: true,
            plan: true,
            clerkOrgId: true,
          },
        },
      },
    });
    const query = user.findFirst.mock.calls[0]?.[0];
    expect(JSON.stringify(query)).not.toMatch(/apiKey|passwordHash|clerkMembershipId/);
    expect(JSON.stringify(result)).not.toMatch(/clerkOrgId|apiKey|passwordHash/);
  });

  it("requires matching organization claims for a Clerk-bound /auth/me", async () => {
    const user = harness.prisma.user as {
      findFirst: ReturnType<typeof vi.fn>;
    };
    user.findFirst.mockResolvedValue({
      id: "user_internal_1",
      email: "owner@acme.example",
      name: "Owner",
      role: UserRole.ADMIN,
      createdAt: new Date("2026-08-13T00:00:00.000Z"),
      org: {
        id: "org_internal_1",
        name: "Acme",
        slug: "acme",
        plan: "TRIAL",
        clerkOrgId: "org_clerk_1",
      },
    });

    await expect(
      service.getUserByClerkId("user_clerk_1"),
    ).rejects.toMatchObject({
      message: "Active Clerk organization session required",
    });
    await expect(
      service.getUserByClerkId("user_clerk_1", {
        clerkOrgId: "org_clerk_1",
        clerkOrgRole: "org:member",
      }),
    ).resolves.toMatchObject({ id: "user_internal_1" });
  });

  it("does not return an inactive user through /auth/me", async () => {
    await expect(
      service.getUserByClerkId("user_clerk_removed"),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("binds organization events only by immutable id and ignores stale updates", async () => {
    await syncOrganization();
    await service.handleWebhook(
      {
        type: "organization.updated",
        data: organizationData({
          name: "Acme Current",
          slug: "acme-current",
          updated_at: BASE_SECONDS * 1000 + 200,
        }),
      },
      delivery("evt_org_current"),
    );
    await service.handleWebhook(
      {
        type: "organization.updated",
        data: organizationData({
          name: "Acme Stale",
          slug: "acme-stale",
          updated_at: BASE_SECONDS * 1000 + 100,
        }),
      },
      delivery("evt_org_stale"),
    );

    expect(harness.state.orgs.get("org_clerk_1")).toMatchObject({
      clerkOrgId: "org_clerk_1",
      name: "Acme Current",
      slug: "acme-current",
    });
  });

  it("creates a manager membership without granting owner authority", async () => {
    await syncOrganization();
    await service.handleWebhook(
      {
        type: "organizationMembership.created",
        data: membershipData({ role: "org:manager" }),
      },
      delivery("evt_membership_created"),
    );

    expect(harness.state.users.get("user_clerk_1")).toMatchObject({
      clerkMembershipId: "mem_1",
      membershipActive: true,
      role: UserRole.MANAGER,
      orgId: "org_internal_1",
    });
  });

  it("keeps a demotion authoritative when an older admin update arrives later", async () => {
    await syncOrganization();
    await service.handleWebhook(
      { type: "organizationMembership.created", data: membershipData() },
      delivery("evt_membership_created"),
    );
    await service.handleWebhook(
      {
        type: "organizationMembership.updated",
        data: membershipData({
          role: "org:member",
          updated_at: BASE_SECONDS * 1000 + 300,
        }),
      },
      delivery("evt_member_current"),
    );
    await service.handleWebhook(
      {
        type: "organizationMembership.updated",
        data: membershipData({
          role: "org:admin",
          updated_at: BASE_SECONDS * 1000 + 200,
        }),
      },
      delivery("evt_admin_stale"),
    );

    expect(harness.state.users.get("user_clerk_1")).toMatchObject({
      membershipActive: true,
      role: UserRole.MEMBER,
    });
    expect(harness.state.membershipLifecycles.get("mem_1")).toMatchObject({
      eventVersion: BigInt(BASE_SECONDS * 1000 + 300),
      role: UserRole.MEMBER,
    });
  });

  it("records delete-before-create and only a new membership id can reactivate", async () => {
    await syncOrganization();
    await service.handleWebhook(
      {
        type: "organizationMembership.deleted",
        data: membershipData({ updated_at: BASE_SECONDS * 1000 + 300 }),
      },
      delivery("evt_mem_deleted"),
    );
    await service.handleWebhook(
      {
        type: "organizationMembership.created",
        data: membershipData({ updated_at: BASE_SECONDS * 1000 + 400 }),
      },
      delivery("evt_mem_replayed_create"),
    );
    expect(harness.state.users.has("user_clerk_1")).toBe(false);

    await service.handleWebhook(
      {
        type: "organizationMembership.created",
        data: membershipData({
          id: "mem_2",
          updated_at: BASE_SECONDS * 1000 + 500,
        }),
      },
      delivery("evt_mem_readded"),
    );
    expect(harness.state.users.get("user_clerk_1")).toMatchObject({
      clerkMembershipId: "mem_2",
      membershipActive: true,
    });
  });

  it("does not let an older membership delete revoke a newer re-add", async () => {
    await syncOrganization();
    await service.handleWebhook(
      { type: "organizationMembership.created", data: membershipData() },
      delivery("evt_mem_a_created"),
    );
    await service.handleWebhook(
      {
        type: "organizationMembership.created",
        data: membershipData({
          id: "mem_2",
          updated_at: BASE_SECONDS * 1000 + 300,
        }),
      },
      delivery("evt_mem_b_created"),
    );
    await service.handleWebhook(
      {
        type: "organizationMembership.deleted",
        data: membershipData({ updated_at: BASE_SECONDS * 1000 + 400 }),
      },
      delivery("evt_mem_a_deleted"),
    );

    expect(harness.state.users.get("user_clerk_1")).toMatchObject({
      clerkMembershipId: "mem_2",
      membershipActive: true,
    });
    expect(harness.state.membershipLifecycles.get("mem_1")).toMatchObject({
      deleted: true,
    });
  });

  it("rejects a membership id replayed with a different immutable user tuple", async () => {
    await syncOrganization();
    await service.handleWebhook(
      { type: "organizationMembership.created", data: membershipData() },
      delivery("evt_tuple_created"),
    );

    await service.handleWebhook(
      {
        type: "organizationMembership.deleted",
        data: membershipData({
          updated_at: BASE_SECONDS * 1000 + 500,
          public_user_data: {
            user_id: "user_clerk_2",
            identifier: "other@acme.example",
          },
        }),
      },
      delivery("evt_tuple_changed"),
    );

    expect(harness.state.users.get("user_clerk_1")).toMatchObject({
      membershipActive: false,
      clerkMembershipId: "mem_1",
      role: UserRole.MEMBER,
    });
    expect(harness.state.membershipLifecycles.get("mem_1")).toMatchObject({
      clerkUserId: "user_clerk_1",
      clerkOrgId: "org_clerk_1",
      deleted: true,
    });
  });

  it("persists an absent-user tombstone that blocks later membership grants", async () => {
    await syncOrganization();
    await service.handleWebhook(
      { type: "user.deleted", data: { id: "user_clerk_1" } },
      delivery("evt_user_deleted", BASE_SECONDS + 1),
    );
    await service.handleWebhook(
      {
        type: "organizationMembership.created",
        data: membershipData({ updated_at: BASE_SECONDS * 1000 + 2_000 }),
      },
      delivery("evt_membership_after_user_delete", BASE_SECONDS + 2),
    );

    expect(harness.state.users.has("user_clerk_1")).toBe(false);
    expect(harness.state.userLifecycles.get("user_clerk_1")).toMatchObject({
      deleted: true,
      membershipActive: false,
    });
  });

  it("persists an absent-organization tombstone and never recreates that id", async () => {
    await service.handleWebhook(
      { type: "organization.deleted", data: { id: "org_clerk_1" } },
      delivery("evt_org_deleted", BASE_SECONDS + 1),
    );
    await service.handleWebhook(
      {
        type: "organization.created",
        data: organizationData({ updated_at: BASE_SECONDS * 1000 + 2_000 }),
      },
      delivery("evt_org_replayed_create", BASE_SECONDS + 2),
    );

    expect(harness.state.orgs.has("org_clerk_1")).toBe(false);
    expect(
      harness.state.organizationLifecycles.get("org_clerk_1"),
    ).toMatchObject({ deleted: true });
  });

  it("does not let an update create authority when the create was never seen", async () => {
    await syncOrganization();
    await expect(
      service.handleWebhook(
        {
          type: "organizationMembership.updated",
          data: membershipData({ updated_at: BASE_SECONDS * 1000 + 200 }),
        },
        delivery("evt_update_without_create"),
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(harness.state.users.has("user_clerk_1")).toBe(false);
  });

  it("retries a membership create that arrives before its organization", async () => {
    const event = {
      type: "organizationMembership.created",
      data: membershipData({ updated_at: BASE_SECONDS * 1000 + 200 }),
    };
    await expect(
      service.handleWebhook(event, delivery("evt_membership_early")),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(harness.state.membershipLifecycles.has("mem_1")).toBe(false);

    await syncOrganization();
    await service.handleWebhook(event, delivery("evt_membership_early"));
    expect(harness.state.users.get("user_clerk_1")).toMatchObject({
      membershipActive: true,
      clerkMembershipId: "mem_1",
    });
  });

  it("blocks grants until cutover evidence is ready and ignores pre-cutover replays", async () => {
    harness.state.cutover = {
      id: 1,
      minimumEventVersion: BigInt(BASE_SECONDS * 1000 + 500),
      ready: false,
      inventoryEvidenceHash: null,
      expectedActiveOrganizationCount: -1,
      expectedActiveMembershipCount: -1,
      expectedActiveUserCount: -1,
      establishedAt: new Date(BASE_SECONDS * 1000),
    };
    await expect(
      service.handleWebhook(
        { type: "organization.created", data: organizationData() },
        delivery("evt_before_ready"),
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(harness.state.orgs.has("org_clerk_1")).toBe(false);

    harness.state.cutover = {
      id: 1,
      minimumEventVersion: BigInt(BASE_SECONDS * 1000 + 500),
      ready: true,
      inventoryEvidenceHash: `sha256:${"b".repeat(64)}`,
      expectedActiveOrganizationCount: 0,
      expectedActiveMembershipCount: 0,
      expectedActiveUserCount: 0,
      establishedAt: new Date(BASE_SECONDS * 1000),
    };
    await service.handleWebhook(
      { type: "organization.created", data: organizationData() },
      delivery("evt_stale_before_cutover"),
    );
    expect(harness.state.orgs.has("org_clerk_1")).toBe(false);

    harness.state.cutover = {
      id: 1,
      minimumEventVersion: 1_800_000_000_000_000n,
      ready: true,
      inventoryEvidenceHash: `sha256:${"c".repeat(64)}`,
      expectedActiveOrganizationCount: 0,
      expectedActiveMembershipCount: 0,
      expectedActiveUserCount: 0,
      establishedAt: new Date(BASE_SECONDS * 1000),
    };
    await expect(
      service.handleWebhook(
        {
          type: "organization.created",
          data: organizationData({ updated_at: BASE_SECONDS * 1000 + 1_000 }),
        },
        delivery("evt_bad_cutover_units"),
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it("requires signed delivery metadata and provider event versions", async () => {
    await expect(
      service.handleWebhook({
        type: "organizationMembership.deleted",
        data: membershipData(),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    await expect(
      service.handleWebhook(
        {
          type: "organizationMembership.deleted",
          data: membershipData({ updated_at: undefined }),
        },
        delivery("evt_malformed"),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
