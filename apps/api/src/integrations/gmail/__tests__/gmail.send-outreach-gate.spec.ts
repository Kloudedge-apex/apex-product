import { describe, it, expect, vi } from "vitest";
import {
  ForbiddenException,
  RequestMethod,
  type ExecutionContext,
} from "@nestjs/common";
import { AdminOrManagerGuard } from "../../../common/admin-or-manager.guard";
import type { PrismaService } from "../../../prisma/prisma.service";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { GmailController } from "../gmail.controller";

const PATH_METADATA = "path";
const METHOD_METADATA = "method";

function createMockPrisma() {
  return {
    user: {
      findUnique: vi.fn(),
    },
  } as unknown as PrismaService;
}

function createExecutionContext(
  request: Record<string, unknown>,
): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;
}

function exposedRoutes() {
  return Object.getOwnPropertyNames(GmailController.prototype)
    .filter((name) => name !== "constructor")
    .flatMap((name) => {
      const handler = (
        GmailController.prototype as unknown as Record<string, unknown>
      )[name];
      if (typeof handler !== "function") return [];
      const path = Reflect.getMetadata(PATH_METADATA, handler) as unknown;
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as unknown;
      return path === undefined || method === undefined
        ? []
        : [{ name, path, method }];
    });
}

describe("Gmail release surface", () => {
  function guardsOn(method: keyof GmailController): unknown[] {
    const handler = GmailController.prototype[method];
    return Reflect.getMetadata(GUARDS_METADATA, handler) ?? [];
  }

  it.each([
    "registerWatch",
    "listMessages",
    "searchMessages",
    "getMessage",
    "getThread",
  ] as const)("attaches AdminOrManagerGuard to %s", (method) => {
    expect(guardsOn(method)).toContain(AdminOrManagerGuard);
  });

  it("keeps the authenticated Pub/Sub push endpoint outside the user-role guard", () => {
    expect(guardsOn("handlePush")).not.toContain(AdminOrManagerGuard);
  });

  it("publishes only reply synchronization and provider-read operations", () => {
    expect(exposedRoutes()).toEqual([
      { name: "handlePush", path: "push", method: RequestMethod.POST },
      { name: "registerWatch", path: "watch", method: RequestMethod.POST },
      { name: "listMessages", path: "messages", method: RequestMethod.GET },
      { name: "searchMessages", path: "search", method: RequestMethod.GET },
      {
        name: "getMessage",
        path: "messages/:messageId",
        method: RequestMethod.GET,
      },
      {
        name: "getThread",
        path: "threads/:threadId",
        method: RequestMethod.GET,
      },
    ]);
  });

  it("returns 403 when caller role is denied (member)", async () => {
    const prisma = createMockPrisma();
    const guard = new AdminOrManagerGuard(prisma);
    const ctx = createExecutionContext({ clerkOrgRole: "org:member" });

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
