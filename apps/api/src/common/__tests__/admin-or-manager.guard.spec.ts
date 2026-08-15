import {
  ForbiddenException,
  type ExecutionContext,
} from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { AdminOrManagerGuard } from "../admin-or-manager.guard";
import type { PrismaService } from "../../prisma/prisma.service";

function executionContext(
  request: Record<string, unknown>,
): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;
}

function guardWithDbRole(
  role: "OWNER" | "ADMIN" | "MANAGER" | "MEMBER" | null,
  clerkOrgId: string | null = "org_clerk_1",
) {
  const findFirst = vi
    .fn()
    .mockResolvedValue(
      role === null
        ? null
        : {
            id: "user_internal_1",
            email: "owner@example.test",
            role,
            org: { clerkOrgId },
          },
    );
  const prisma = {
    user: { findFirst },
  } as unknown as PrismaService;
  return {
    guard: new AdminOrManagerGuard(prisma),
    findFirst,
  };
}

describe("AdminOrManagerGuard database authority", () => {
  it.each(["OWNER", "ADMIN", "MANAGER"] as const)(
    "allows the synchronized %s role in the current tenant",
    async (role) => {
      const { guard, findFirst } = guardWithDbRole(role);

      await expect(
        guard.canActivate(
          executionContext({
            clerkUserId: "user_1",
            orgId: "org_1",
            clerkOrgRole:
              role === "MANAGER" ? "org:manager" : "org:admin",
          }),
        ),
      ).resolves.toBe(true);
      expect(findFirst).toHaveBeenCalledWith({
        where: {
          clerkId: "user_1",
          orgId: "org_1",
          membershipActive: true,
        },
        select: {
          id: true,
          email: true,
          role: true,
          org: { select: { clerkOrgId: true } },
        },
      });
    },
  );

  it("denies a stale signed admin claim after the database role is demoted", async () => {
    const { guard, findFirst } = guardWithDbRole("MEMBER");

    await expect(
      guard.canActivate(
        executionContext({
          clerkOrgRole: "org:admin",
          clerkUserId: "user_1",
          orgId: "org_1",
        }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(findFirst).toHaveBeenCalledOnce();
  });

  it("lets a fresh signed demotion veto a stale privileged database role", async () => {
    const { guard, findFirst } = guardWithDbRole("MANAGER");

    await expect(
      guard.canActivate(
        executionContext({
          clerkOrgRole: "org:member",
          clerkUserId: "user_1",
          orgId: "org_1",
        }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("denies a removed membership even when the stale token says admin", async () => {
    const { guard } = guardWithDbRole(null);

    await expect(
      guard.canActivate(
        executionContext({
          clerkOrgRole: "org:admin",
          clerkUserId: "user_1",
          orgId: "org_1",
        }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("denies a privileged database role in a Clerk-bound tenant when org_role is absent", async () => {
    const { guard, findFirst } = guardWithDbRole("OWNER");

    await expect(
      guard.canActivate(
        executionContext({
          clerkUserId: "user_1",
          orgId: "org_1",
        }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(findFirst).toHaveBeenCalledOnce();
  });

  it("preserves database-role authorization for an unbound local tenant", async () => {
    const { guard } = guardWithDbRole("OWNER", null);

    await expect(
      guard.canActivate(
        executionContext({
          clerkUserId: "user_1",
          orgId: "org_1",
        }),
      ),
    ).resolves.toBe(true);
  });

  it("fails closed without tenant-scoped authenticated context", async () => {
    const { guard, findFirst } = guardWithDbRole("OWNER");

    await expect(
      guard.canActivate(executionContext({ clerkUserId: "user_1" })),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(findFirst).not.toHaveBeenCalled();
  });
});
