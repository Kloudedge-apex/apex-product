import "reflect-metadata";
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  BadRequestException,
  ForbiddenException,
  RequestMethod,
  UnauthorizedException,
} from "@nestjs/common";
import { OutreachSuppressionReason } from "@prisma/client";
import type { Request } from "express";
import { SuppressionController } from "../suppression.controller";
import { SuppressionService } from "../suppression.service";
import { PrismaService } from "../../prisma/prisma.service";

/** Nest stores @Get/@Post route metadata under these keys (PATH_METADATA / METHOD_METADATA). */
const PATH_METADATA = "path";
const METHOD_METADATA = "method";

type ServiceMock = Pick<SuppressionService, "suppress" | "listForOrg" | "unsuppress"> & {
  suppress: ReturnType<typeof vi.fn>;
  listForOrg: ReturnType<typeof vi.fn>;
  unsuppress: ReturnType<typeof vi.fn>;
};

function mockService(): ServiceMock {
  return {
    suppress: vi.fn().mockResolvedValue({ created: true }),
    listForOrg: vi.fn().mockResolvedValue({ rows: [], nextCursor: null }),
    unsuppress: vi.fn().mockResolvedValue(true),
  };
}

function mockPrisma(
  user: { id: string; role: string; orgId: string } | null = {
    id: "user_1",
    role: "ADMIN",
    orgId: "org_1",
  },
) {
  return {
    user: {
      findUnique: vi.fn().mockResolvedValue(user),
    },
  } as unknown as PrismaService;
}

/**
 * Request double carrying the auth-middleware-set clerkUserId (same source as
 * :93). Pass null for an unauthenticated request (explicit `undefined` would
 * trigger the default parameter).
 */
function mockReq(clerkUserId: string | null = "clerk_admin_1"): Request {
  return { clerkUserId: clerkUserId ?? undefined } as unknown as Request;
}

describe("SuppressionController POST / (GL6b manual suppression)", () => {
  let service: ServiceMock;
  let prisma: PrismaService;
  let controller: SuppressionController;

  beforeEach(() => {
    vi.clearAllMocks();
    service = mockService();
    prisma = mockPrisma();
    controller = new SuppressionController(
      service as unknown as SuppressionService,
      prisma,
    );
  });

  it("registers a POST route on the controller root", () => {
    const handler = SuppressionController.prototype.create as object;
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe("/");
  });

  describe("guarding (same OWNER/ADMIN gate as list + unsuppress)", () => {
    it("rejects requests without an authenticated user context", async () => {
      await expect(
        controller.create("org_1", mockReq(null), { recipientRef: "a@b.co" }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(service.suppress).not.toHaveBeenCalled();
    });

    it("rejects unknown users", async () => {
      controller = new SuppressionController(
        service as unknown as SuppressionService,
        mockPrisma(null),
      );
      await expect(
        controller.create("org_1", mockReq(), { recipientRef: "a@b.co" }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(service.suppress).not.toHaveBeenCalled();
    });

    it("rejects cross-org callers", async () => {
      controller = new SuppressionController(
        service as unknown as SuppressionService,
        mockPrisma({ id: "user_2", role: "OWNER", orgId: "org_OTHER" }),
      );
      await expect(
        controller.create("org_1", mockReq(), { recipientRef: "a@b.co" }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(service.suppress).not.toHaveBeenCalled();
    });

    it("rejects MEMBER-role users", async () => {
      controller = new SuppressionController(
        service as unknown as SuppressionService,
        mockPrisma({ id: "user_3", role: "MEMBER", orgId: "org_1" }),
      );
      await expect(
        controller.create("org_1", mockReq(), { recipientRef: "a@b.co" }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(service.suppress).not.toHaveBeenCalled();
    });
  });

  describe("creation", () => {
    it("writes a MANUAL suppression with server-derived actor attribution", async () => {
      const result = await controller.create("org_1", mockReq("clerk_admin_1"), {
        recipientRef: "  Prospect@Acme.com ",
      });

      expect(service.suppress).toHaveBeenCalledTimes(1);
      expect(service.suppress).toHaveBeenCalledWith({
        orgId: "org_1",
        recipientRef: "prospect@acme.com",
        reason: OutreachSuppressionReason.MANUAL,
        source: "admin_manual",
        metadata: {
          actorUserId: "user_1",
          actorClerkId: "clerk_admin_1",
        },
      });
      expect(result).toEqual({
        created: true,
        recipientRef: "prospect@acme.com",
        reason: OutreachSuppressionReason.MANUAL,
      });
    });

    it("ignores body-supplied actor fields — attribution is server-derived only", async () => {
      await controller.create("org_1", mockReq("clerk_admin_1"), {
        recipientRef: "a@b.co",
        actorUserId: "spoofed_user",
        metadata: { actorClerkId: "spoofed_clerk" },
      });

      expect(service.suppress).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: {
            actorUserId: "user_1",
            actorClerkId: "clerk_admin_1",
          },
        }),
      );
    });

    it("accepts an explicit valid reason", async () => {
      const result = await controller.create("org_1", mockReq(), {
        recipientRef: "a@b.co",
        reason: "COMPLAINED",
      });

      expect(service.suppress).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: OutreachSuppressionReason.COMPLAINED,
        }),
      );
      expect(result.reason).toBe(OutreachSuppressionReason.COMPLAINED);
    });

    it("is idempotent: a repeat POST reports created=false without erroring", async () => {
      service.suppress.mockResolvedValue({ created: false });

      const result = await controller.create("org_1", mockReq(), {
        recipientRef: "a@b.co",
      });

      expect(result).toEqual({
        created: false,
        recipientRef: "a@b.co",
        reason: OutreachSuppressionReason.MANUAL,
      });
    });
  });

  describe("validation", () => {
    it.each([
      ["null body", null],
      ["array body", ["a@b.co"]],
      ["missing recipientRef", {}],
      ["empty recipientRef", { recipientRef: "   " }],
      ["non-string recipientRef", { recipientRef: 42 }],
      ["oversized recipientRef", { recipientRef: `${"x".repeat(513)}@b.co` }],
      ["invalid reason", { recipientRef: "a@b.co", reason: "REPLIED" }],
      ["non-string reason", { recipientRef: "a@b.co", reason: 7 }],
    ])("400s on %s", async (_label, body) => {
      await expect(
        controller.create("org_1", mockReq(), body),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(service.suppress).not.toHaveBeenCalled();
    });
  });
});
