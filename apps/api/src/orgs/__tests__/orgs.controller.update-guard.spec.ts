import { describe, it, expect, beforeEach, vi } from "vitest";
import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import { OrgsController } from "../orgs.controller";
import { OrgsService } from "../orgs.service";
import { PrismaService } from "../../prisma/prisma.service";
import { UpdateOrgDto } from "../../common/dto/orgs.dto";

/**
 * Role guard on PATCH /orgs/:id (audit B1 follow-through).
 *
 * The update route writes sender identity (CAN-SPAM §7704(a)(5) fields) and
 * `plan` — org-level settings a regular MEMBER must not be able to change.
 * Same OWNER/ADMIN gate as the suppression endpoints (commit e61b3cb):
 *   1. OrgScopeGuard attaches `clerkUserId` and signed `clerkOrgRole`.
 *   2. The clerk user must have an active tenant-scoped User row.
 *   3. Both synchronized and signed roles must allow OWNER or ADMIN.
 */
describe("OrgsController PATCH /orgs/:id role guard", () => {
  const ORG_ID = "org_self";
  const OTHER_ORG_ID = "org_someone_else";
  const CLERK_USER_ID = "user_clerk_caller";

  let service: { update: ReturnType<typeof vi.fn> };
  let prisma: { user: { findFirst: ReturnType<typeof vi.fn> } };
  let controller: OrgsController;

  const body: UpdateOrgDto = {
    physicalAddress: "548 Market St, San Francisco, CA 94104, USA",
    senderName: "Jane Doe",
    country: "US",
  };

  function makeReq(
    clerkUserId?: string,
    clerkOrgRole: string = "org:admin",
  ): Request {
    const req: Record<string, unknown> = { headers: {} };
    if (clerkUserId !== undefined) req.clerkUserId = clerkUserId;
    req.clerkOrgRole = clerkOrgRole;
    return req as unknown as Request;
  }

  function authorizedUser(
    role: "OWNER" | "ADMIN" | "MEMBER",
  ) {
    return {
      id: "user_internal",
      email: "owner@acme.test",
      role,
      org: { clerkOrgId: "org_clerk_1" },
    };
  }

  beforeEach(() => {
    service = {
      update: vi.fn().mockResolvedValue({ id: ORG_ID, name: "Acme" }),
    };
    prisma = { user: { findFirst: vi.fn() } };
    controller = new OrgsController(
      service as unknown as OrgsService,
      prisma as unknown as PrismaService,
    );
  });

  it("allows an OWNER to update", async () => {
    prisma.user.findFirst.mockResolvedValue(authorizedUser("OWNER"));
    const result = await controller.update(ORG_ID, ORG_ID, body, makeReq(CLERK_USER_ID));
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
    expect(service.update).toHaveBeenCalledTimes(1);
    expect(service.update).toHaveBeenCalledWith(ORG_ID, body);
    expect(result).toEqual({ id: ORG_ID, name: "Acme" });
  });

  it("allows an ADMIN to update", async () => {
    prisma.user.findFirst.mockResolvedValue(authorizedUser("ADMIN"));
    await controller.update(ORG_ID, ORG_ID, body, makeReq(CLERK_USER_ID));
    expect(service.update).toHaveBeenCalledTimes(1);
  });

  it("rejects a MEMBER with 403", async () => {
    prisma.user.findFirst.mockResolvedValue(authorizedUser("MEMBER"));
    await expect(
      controller.update(ORG_ID, ORG_ID, body, makeReq(CLERK_USER_ID)),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(service.update).not.toHaveBeenCalled();
  });

  it("lets a fresh signed MEMBER veto a stale database OWNER", async () => {
    prisma.user.findFirst.mockResolvedValue(authorizedUser("OWNER"));

    await expect(
      controller.update(
        ORG_ID,
        ORG_ID,
        body,
        makeReq(CLERK_USER_ID, "org:member"),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
    expect(service.update).not.toHaveBeenCalled();
  });

  it("rejects when the request has no authenticated user context (401)", async () => {
    await expect(
      controller.update(ORG_ID, ORG_ID, body, makeReq()),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
    expect(service.update).not.toHaveBeenCalled();
  });

  it("rejects when the clerk user resolves to no User row (403)", async () => {
    prisma.user.findFirst.mockResolvedValue(null);
    await expect(
      controller.update(ORG_ID, ORG_ID, body, makeReq(CLERK_USER_ID)),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(service.update).not.toHaveBeenCalled();
  });

  it("rejects when the user belongs to a different org (403)", async () => {
    // A tenant-scoped query cannot return a row from OTHER_ORG_ID.
    prisma.user.findFirst.mockResolvedValue(null);
    await expect(
      controller.update(ORG_ID, ORG_ID, body, makeReq(CLERK_USER_ID)),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(service.update).not.toHaveBeenCalled();
  });

  it("still rejects a cross-org :id before any role lookup (IDOR check stays first)", async () => {
    await expect(
      controller.update(ORG_ID, OTHER_ORG_ID, body, makeReq(CLERK_USER_ID)),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
    expect(service.update).not.toHaveBeenCalled();
  });
});
