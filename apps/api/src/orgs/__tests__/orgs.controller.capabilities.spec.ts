import { describe, it, expect, beforeEach, vi } from "vitest";
import { UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import { OrgsController } from "../orgs.controller";
import { OrgsService } from "../orgs.service";
import { PrismaService } from "../../prisma/prisma.service";

describe("OrgsController GET /orgs/me/capabilities", () => {
  const ORG_ID = "org_self";
  const CLERK_USER_ID = "user_clerk_caller";

  let prisma: { user: { findFirst: ReturnType<typeof vi.fn> } };
  let controller: OrgsController;

  function makeReq(
    clerkUserId?: string,
    clerkOrgRole?: string,
  ): Request {
    const req: Record<string, unknown> = { headers: {} };
    if (clerkUserId !== undefined) req.clerkUserId = clerkUserId;
    if (clerkOrgRole !== undefined) req.clerkOrgRole = clerkOrgRole;
    return req as unknown as Request;
  }

  function user(
    role: "OWNER" | "ADMIN" | "MANAGER" | "MEMBER",
    clerkOrgId: string | null = "org_clerk_1",
  ) {
    return {
      id: "user_internal",
      email: "operator@acme.test",
      role,
      org: { clerkOrgId },
    };
  }

  beforeEach(() => {
    prisma = { user: { findFirst: vi.fn() } };
    controller = new OrgsController(
      {} as OrgsService,
      prisma as unknown as PrismaService,
    );
  });

  it.each(["OWNER", "ADMIN"] as const)(
    "grants every capability to an aligned %s",
    async (role) => {
      prisma.user.findFirst.mockResolvedValue(user(role));

      await expect(
        controller.getCapabilities(
          ORG_ID,
          makeReq(CLERK_USER_ID, `org:${role.toLowerCase()}`),
        ),
      ).resolves.toEqual({
        canReviewArtifacts: true,
        canManageWorkflow: true,
        canManageMailbox: true,
        canManageOrg: true,
        canManageSuppressions: true,
      });
      expect(prisma.user.findFirst).toHaveBeenCalledTimes(1);
    },
  );

  it("lets an aligned MANAGER review work and manage mailboxes only", async () => {
    prisma.user.findFirst.mockResolvedValue(user("MANAGER"));

    await expect(
      controller.getCapabilities(
        ORG_ID,
        makeReq(CLERK_USER_ID, "org:manager"),
      ),
    ).resolves.toEqual({
      canReviewArtifacts: true,
      canManageWorkflow: true,
      canManageMailbox: true,
      canManageOrg: false,
      canManageSuppressions: false,
    });
    expect(prisma.user.findFirst).toHaveBeenCalledTimes(1);
  });

  it("grants no capability to a signed MEMBER without querying stale database privilege", async () => {
    prisma.user.findFirst.mockResolvedValue(user("OWNER"));

    await expect(
      controller.getCapabilities(
        ORG_ID,
        makeReq(CLERK_USER_ID, "org:member"),
      ),
    ).resolves.toEqual({
      canReviewArtifacts: false,
      canManageWorkflow: false,
      canManageMailbox: false,
      canManageOrg: false,
      canManageSuppressions: false,
    });
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
  });

  it("intersects signed and synchronized roles conservatively", async () => {
    prisma.user.findFirst.mockResolvedValue(user("OWNER"));

    await expect(
      controller.getCapabilities(
        ORG_ID,
        makeReq(CLERK_USER_ID, "org:manager"),
      ),
    ).resolves.toEqual({
      canReviewArtifacts: true,
      canManageWorkflow: true,
      canManageMailbox: true,
      canManageOrg: false,
      canManageSuppressions: false,
    });
    expect(prisma.user.findFirst).toHaveBeenCalledTimes(1);
  });

  it("supports an unbound local OWNER from synchronized membership", async () => {
    prisma.user.findFirst.mockResolvedValue(user("OWNER", null));

    await expect(
      controller.getCapabilities(ORG_ID, makeReq(CLERK_USER_ID)),
    ).resolves.toEqual({
      canReviewArtifacts: true,
      canManageWorkflow: true,
      canManageMailbox: true,
      canManageOrg: true,
      canManageSuppressions: true,
    });
  });

  it("uses an active tenant-scoped membership lookup", async () => {
    prisma.user.findFirst.mockResolvedValue(user("OWNER"));

    await controller.getCapabilities(
      ORG_ID,
      makeReq(CLERK_USER_ID, "org:admin"),
    );

    expect(prisma.user.findFirst).toHaveBeenCalledWith({
      where: {
        clerkId: CLERK_USER_ID,
        orgId: ORG_ID,
        membershipActive: true,
      },
      select: {
        id: true,
        email: true,
        role: true,
        org: { select: { clerkOrgId: true } },
      },
    });
  });

  it("rejects missing authenticated user context before querying", async () => {
    await expect(
      controller.getCapabilities(ORG_ID, makeReq()),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
  });
});
