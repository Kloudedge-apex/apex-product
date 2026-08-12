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

function guardWithDbRole(role: "OWNER" | "ADMIN" | "MEMBER" | null) {
  const findUnique = vi
    .fn()
    .mockResolvedValue(role === null ? null : { role });
  const prisma = {
    user: { findUnique },
  } as unknown as PrismaService;
  return {
    guard: new AdminOrManagerGuard(prisma),
    findUnique,
  };
}

describe("AdminOrManagerGuard role precedence", () => {
  it.each(["org:admin", "org:manager", "ADMIN", "manager"])(
    "allows signed Clerk role %s without consulting the database",
    async (clerkOrgRole) => {
      const { guard, findUnique } = guardWithDbRole("MEMBER");

      await expect(
        guard.canActivate(executionContext({ clerkOrgRole })),
      ).resolves.toBe(true);
      expect(findUnique).not.toHaveBeenCalled();
    },
  );

  it("denies a signed member claim without falling back to a privileged DB row", async () => {
    const { guard, findUnique } = guardWithDbRole("OWNER");

    await expect(
      guard.canActivate(
        executionContext({
          clerkOrgRole: "org:member",
          clerkUserId: "user_1",
        }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it.each(["OWNER", "ADMIN"] as const)(
    "falls back to DB role %s only when the signed org role is absent",
    async (role) => {
      const { guard, findUnique } = guardWithDbRole(role);

      await expect(
        guard.canActivate(
          executionContext({ clerkUserId: "user_1" }),
        ),
      ).resolves.toBe(true);
      expect(findUnique).toHaveBeenCalledWith({
        where: { clerkId: "user_1" },
        select: { role: true },
      });
    },
  );

  it("denies an unprivileged DB fallback", async () => {
    const { guard } = guardWithDbRole("MEMBER");

    await expect(
      guard.canActivate(executionContext({ clerkUserId: "user_1" })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
