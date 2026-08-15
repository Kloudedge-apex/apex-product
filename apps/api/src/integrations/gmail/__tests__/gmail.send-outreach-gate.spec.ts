import { describe, it, expect, vi } from "vitest";
import { ForbiddenException, type ExecutionContext } from "@nestjs/common";
import { GmailService } from "../gmail.service";
import { AdminOrManagerGuard } from "../../../common/admin-or-manager.guard";
import type { PrismaService } from "../../../prisma/prisma.service";
import type { ConfigService } from "@nestjs/config";
import type { SuppressionService } from "../../../outreach/suppression.service";
import type { ConversationStoreService } from "../../../conversation-store/conversation-store.service";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { GmailController } from "../gmail.controller";

function createMockPrisma() {
  return {
    outreachArtifact: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
  } as unknown as PrismaService;
}

function createMockConfig() {
  return {
    get: vi.fn().mockImplementation((_key: string, defaultValue?: string) => {
      return defaultValue ?? "";
    }),
  } as unknown as ConfigService;
}

function createMockSuppression() {
  return {} as unknown as SuppressionService;
}

function createMockConversationStore() {
  return {} as unknown as ConversationStoreService;
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

describe("Gmail send outreach gating", () => {
  function guardsOn(method: keyof GmailController): unknown[] {
    const handler = GmailController.prototype[method];
    return Reflect.getMetadata(GUARDS_METADATA, handler) ?? [];
  }

  it.each([
    "sendEmail",
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

  it("always rejects direct provider dispatch without reading or mutating an artifact", async () => {
    const prisma = createMockPrisma();
    const service = new GmailService(
      prisma,
      createMockConfig(),
      createMockSuppression(),
      createMockConversationStore(),
    );

    await expect(
      service.sendApprovedOutreachEmail("org_1", {
        outreachArtifactId: "art_1",
        to: "to@example.com",
        subject: "Hello",
        body: "Body",
      }),
    ).rejects.toThrow(
      "Direct Gmail dispatch is disabled; approve the artifact through the outreach queue",
    );

    expect(prisma.outreachArtifact.findUnique).not.toHaveBeenCalled();
    expect(prisma.outreachArtifact.update).not.toHaveBeenCalled();
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
