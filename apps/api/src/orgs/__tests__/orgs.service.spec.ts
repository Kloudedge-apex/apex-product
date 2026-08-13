import { describe, expect, it, vi } from "vitest";
import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { OrgsService } from "../orgs.service";

describe("OrgsService website validation", () => {
  function buildService() {
    const prisma = {
      org: {
        update: vi.fn().mockResolvedValue({ id: "org_test" }),
      },
    };
    const service = new OrgsService(prisma as never);
    return { service, prisma };
  }

  it("rejects non-https URLs", async () => {
    const { service, prisma } = buildService();
    await expect(
      service.update("org_test", { website: "http://example.com" }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.org.update).not.toHaveBeenCalled();
  });

  it("rejects IP literal hostnames", async () => {
    const { service, prisma } = buildService();
    await expect(
      service.update("org_test", { website: "https://127.0.0.1" }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.org.update).not.toHaveBeenCalled();
  });

  it("rejects non-public domains (missing TLD)", async () => {
    const { service, prisma } = buildService();
    await expect(
      service.update("org_test", { website: "https://localhost" }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.org.update).not.toHaveBeenCalled();
  });

  it("accepts https public domains", async () => {
    const { service, prisma } = buildService();
    await service.update("org_test", { website: "https://acme.com" });
    expect(prisma.org.update).toHaveBeenCalledTimes(1);
    expect(prisma.org.update.mock.calls[0]?.[0]?.data?.website).toBe("https://acme.com/");
  });

  it("clears website when empty string provided", async () => {
    const { service, prisma } = buildService();
    await service.update("org_test", { website: "   " });
    expect(prisma.org.update).toHaveBeenCalledTimes(1);
    expect(prisma.org.update.mock.calls[0]?.[0]?.data?.website).toBeNull();
  });
});

describe("OrgsService concurrent bootstrap", () => {
  it("rejects bootstrap for a deactivated membership instead of returning the old tenant", async () => {
    const transaction = vi.fn();
    const prisma = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      $transaction: transaction,
      clerkUserLifecycle: {
        findUnique: vi.fn().mockResolvedValue(null),
      },
      user: {
        findUnique: vi.fn().mockResolvedValue({
          orgId: "org_old",
          membershipActive: false,
          org: { clerkOrgId: null },
        }),
      },
      org: { create: vi.fn(), findUnique: vi.fn() },
    };
    transaction.mockImplementation(
      async (callback: (tx: typeof prisma) => Promise<unknown>) =>
        callback(prisma),
    );
    const service = new OrgsService(prisma as never);

    await expect(
      service.create({
        name: "New workspace",
        clerkUserId: "clerk_removed",
        email: "removed@acme.example",
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.org.findUnique).not.toHaveBeenCalled();
    expect(prisma.org.create).not.toHaveBeenCalled();
  });

  it("serializes concurrent bootstrap and returns the workspace created by the winner", async () => {
    const org = {
      id: "org_trial",
      users: [
        {
          id: "user_owner",
          email: "owner@acme.example",
          name: "Owner",
          role: "OWNER",
          createdAt: new Date("2026-08-13T00:00:00.000Z"),
        },
      ],
    };
    let persistedUser: {
      orgId: string;
      membershipActive: boolean;
      org: { clerkOrgId: null };
    } | null = null;
    let transactionTail = Promise.resolve();
    const transaction = vi.fn();
    const prisma = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      $transaction: transaction,
      clerkUserLifecycle: {
        findUnique: vi.fn().mockResolvedValue(null),
      },
      user: {
        findUnique: vi.fn(async () => persistedUser),
      },
      org: {
        create: vi.fn().mockImplementation(async () => {
          persistedUser = {
            orgId: org.id,
            membershipActive: true,
            org: { clerkOrgId: null },
          };
          return org;
        }),
        findUnique: vi.fn().mockResolvedValue(org),
      },
    };
    transaction.mockImplementation(
      (callback: (tx: typeof prisma) => Promise<unknown>) => {
        const current = transactionTail.then(() => callback(prisma));
        transactionTail = current.then(
          () => undefined,
          () => undefined,
        );
        return current;
      },
    );
    const service = new OrgsService(prisma as never);

    await expect(
      Promise.all([
        service.create({
          name: "Acme",
          clerkUserId: "clerk_new",
          email: "owner@acme.example",
        }),
        service.create({
          name: "Acme",
          clerkUserId: "clerk_new",
          email: "owner@acme.example",
        }),
      ]),
    ).resolves.toEqual([org, org]);

    expect(prisma.org.create).toHaveBeenCalledTimes(1);
    expect(prisma.org.findUnique).toHaveBeenCalledWith({
      where: { id: org.id },
      select: expect.objectContaining({
        id: true,
        users: {
          select: {
            id: true,
            email: true,
            name: true,
            role: true,
            createdAt: true,
          },
        },
      }),
    });
    expect(prisma.user.findUnique).toHaveBeenCalledTimes(2);
    expect(prisma.user.findUnique).toHaveBeenLastCalledWith({
      where: { clerkId: "clerk_new" },
      select: {
        orgId: true,
        membershipActive: true,
        org: { select: { clerkOrgId: true } },
      },
    });
  });

  it("rejects a delete-before-create tombstone without creating OWNER authority", async () => {
    const transaction = vi.fn();
    const prisma = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      $transaction: transaction,
      clerkUserLifecycle: {
        findUnique: vi.fn().mockResolvedValue({ deleted: true }),
      },
      user: { findUnique: vi.fn() },
      org: { create: vi.fn(), findUnique: vi.fn() },
    };
    transaction.mockImplementation(
      async (callback: (tx: typeof prisma) => Promise<unknown>) =>
        callback(prisma),
    );
    const service = new OrgsService(prisma as never);

    await expect(
      service.create({
        name: "Blocked workspace",
        clerkUserId: "clerk_deleted",
        email: "deleted@acme.example",
      }),
    ).rejects.toThrow("Clerk user is permanently deleted");
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(prisma.org.create).not.toHaveBeenCalled();
  });
});
