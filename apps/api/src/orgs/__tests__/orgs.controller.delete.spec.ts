import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { createHmac } from "node:crypto";
import type { Request, Response } from "express";
import { OrgsController } from "../orgs.controller";
import { OrgsService } from "../orgs.service";
import { PrismaService } from "../../prisma/prisma.service";
import { verifyClerkToken } from "../../common/jwt.util";

vi.mock("../../common/jwt.util", () => ({
  verifyClerkToken: vi.fn(),
}));

const verifyClerkTokenMock = vi.mocked(verifyClerkToken);

/**
 * GDPR Art. 17 / CCPA §1798.105 erasure endpoint — DELETE /orgs/:id.
 *
 * Covers the layered auth gates added on top of OrgScopeGuard's path-param
 * cross-org check:
 *   1. The caller must resolve to a User row in the target org with role OWNER.
 *   2. A re-auth challenge (X-Reauth-Token / X-Reauth-Exp headers) must
 *      validate against an HMAC-SHA256 keyed on env.ENCRYPTION_KEY, with the
 *      exp falling inside a ±5-minute window.
 *   3. Only on success is OrgsService.deleteOrg invoked; the controller then
 *      replies with HTTP 204.
 */
describe("OrgsController DELETE /orgs/:id (GDPR erasure)", () => {
  const ORG_ID = "org_self";
  const OTHER_ORG_ID = "org_someone_else";
  const CLERK_USER_ID = "user_clerk_owner";
  const INTERNAL_USER_ID = "user_internal_owner";
  const SECRET = "test-encryption-key-must-be-long-enough";

  let prevSecret: string | undefined;

  let service: {
    deleteOrg: ReturnType<typeof vi.fn>;
  };
  let prisma: {
    user: { findFirst: ReturnType<typeof vi.fn> };
  };
  let controller: OrgsController;

  function makeReq(overrides: {
    clerkUserId?: string | null;
    clerkOrgRole?: string | null;
    headers?: Record<string, string | undefined>;
  } = {}): Request {
    const headers: Record<string, string> = {};
    if (overrides.headers) {
      for (const [k, v] of Object.entries(overrides.headers)) {
        if (typeof v === "string") headers[k.toLowerCase()] = v;
      }
    }
    const req: Record<string, unknown> = { headers };
    if (overrides.clerkUserId !== null && overrides.clerkUserId !== undefined) {
      req.clerkUserId = overrides.clerkUserId;
    }
    const clerkOrgRole =
      overrides.clerkOrgRole === undefined
        ? "org:owner"
        : overrides.clerkOrgRole;
    if (clerkOrgRole !== null) req.clerkOrgRole = clerkOrgRole;
    return req as unknown as Request;
  }

  function makeRes(): Response & {
    statusCode: number;
    sent: boolean;
  } {
    const res: Record<string, unknown> & {
      statusCode: number;
      sent: boolean;
    } = {
      statusCode: 0,
      sent: false,
      status(code: number) {
        res.statusCode = code;
        return res;
      },
      send() {
        res.sent = true;
        return res;
      },
    };
    return res as unknown as Response & { statusCode: number; sent: boolean };
  }

  function validToken(orgId: string, userId: string, exp: number): string {
    return createHmac("sha256", SECRET)
      .update(`${orgId}:${userId}:${exp}`)
      .digest("hex");
  }

  beforeEach(() => {
    verifyClerkTokenMock.mockReset();
    prevSecret = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = SECRET;

    service = {
      deleteOrg: vi.fn().mockResolvedValue({
        orgId: ORG_ID,
        orgName: "Acme",
        childCounts: {
          users: 1,
          agents: 2,
          integrations: 3,
          agentRuns: 4,
          graphRuns: 5,
        },
      }),
    };
    prisma = {
      user: {
        findFirst: vi.fn().mockResolvedValue({
          id: INTERNAL_USER_ID,
          email: "owner@acme.test",
          role: "OWNER",
          org: { clerkOrgId: "org_clerk_1" },
        }),
      },
    };
    controller = new OrgsController(
      service as unknown as OrgsService,
      prisma as unknown as PrismaService,
    );
  });

  afterEach(() => {
    if (prevSecret === undefined) {
      delete process.env.ENCRYPTION_KEY;
    } else {
      process.env.ENCRYPTION_KEY = prevSecret;
    }
  });

  it("owner with valid re-auth token + exp inside window → 204", async () => {
    const exp = Math.floor(Date.now() / 1000) + 120;
    const token = validToken(ORG_ID, INTERNAL_USER_ID, exp);
    const req = makeReq({
      clerkUserId: CLERK_USER_ID,
      headers: { "x-reauth-token": token, "x-reauth-exp": String(exp) },
    });
    const res = makeRes();

    await controller.remove(ORG_ID, ORG_ID, req, res);

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
    expect(service.deleteOrg).toHaveBeenCalledTimes(1);
    expect(service.deleteOrg).toHaveBeenCalledWith(ORG_ID, {
      userId: INTERNAL_USER_ID,
      email: "owner@acme.test",
    });
    expect(res.statusCode).toBe(204);
    expect(res.sent).toBe(true);
  });

  it("rejects when the :id param targets a different org (Forbidden)", async () => {
    const exp = Math.floor(Date.now() / 1000) + 60;
    const token = validToken(OTHER_ORG_ID, INTERNAL_USER_ID, exp);
    const req = makeReq({
      clerkUserId: CLERK_USER_ID,
      headers: { "x-reauth-token": token, "x-reauth-exp": String(exp) },
    });
    const res = makeRes();

    await expect(
      controller.remove(ORG_ID, OTHER_ORG_ID, req, res),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
    expect(service.deleteOrg).not.toHaveBeenCalled();
  });

  it("non-owner (role=ADMIN) → 403", async () => {
    prisma.user.findFirst.mockResolvedValueOnce({
      id: INTERNAL_USER_ID,
      email: "admin@acme.test",
      role: "ADMIN",
      org: { clerkOrgId: "org_clerk_1" },
    });
    const exp = Math.floor(Date.now() / 1000) + 60;
    const token = validToken(ORG_ID, INTERNAL_USER_ID, exp);
    const req = makeReq({
      clerkUserId: CLERK_USER_ID,
      headers: { "x-reauth-token": token, "x-reauth-exp": String(exp) },
    });
    const res = makeRes();

    await expect(
      controller.remove(ORG_ID, ORG_ID, req, res),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(service.deleteOrg).not.toHaveBeenCalled();
  });

  it("lets a fresh signed MEMBER veto a stale database OWNER", async () => {
    const exp = Math.floor(Date.now() / 1000) + 60;
    const token = validToken(ORG_ID, INTERNAL_USER_ID, exp);
    const req = makeReq({
      clerkUserId: CLERK_USER_ID,
      clerkOrgRole: "org:member",
      headers: { "x-reauth-token": token, "x-reauth-exp": String(exp) },
    });

    await expect(
      controller.remove(ORG_ID, ORG_ID, req, makeRes()),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
    expect(service.deleteOrg).not.toHaveBeenCalled();
  });

  it("user not found in target org → 403", async () => {
    prisma.user.findFirst.mockResolvedValueOnce(null);
    const exp = Math.floor(Date.now() / 1000) + 60;
    const token = validToken(ORG_ID, INTERNAL_USER_ID, exp);
    const req = makeReq({
      clerkUserId: CLERK_USER_ID,
      headers: { "x-reauth-token": token, "x-reauth-exp": String(exp) },
    });
    const res = makeRes();

    await expect(
      controller.remove(ORG_ID, ORG_ID, req, res),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(service.deleteOrg).not.toHaveBeenCalled();
  });

  it("user belongs to a different org → 403", async () => {
    prisma.user.findFirst.mockResolvedValueOnce(null);
    const exp = Math.floor(Date.now() / 1000) + 60;
    const token = validToken(ORG_ID, INTERNAL_USER_ID, exp);
    const req = makeReq({
      clerkUserId: CLERK_USER_ID,
      headers: { "x-reauth-token": token, "x-reauth-exp": String(exp) },
    });
    const res = makeRes();

    await expect(
      controller.remove(ORG_ID, ORG_ID, req, res),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(service.deleteOrg).not.toHaveBeenCalled();
  });

  it("missing clerkUserId on the request → 401", async () => {
    const exp = Math.floor(Date.now() / 1000) + 60;
    const token = validToken(ORG_ID, INTERNAL_USER_ID, exp);
    const req = makeReq({
      clerkUserId: null,
      headers: { "x-reauth-token": token, "x-reauth-exp": String(exp) },
    });
    const res = makeRes();

    await expect(
      controller.remove(ORG_ID, ORG_ID, req, res),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
    expect(service.deleteOrg).not.toHaveBeenCalled();
  });

  it("missing X-Reauth-Token header → 401", async () => {
    const exp = Math.floor(Date.now() / 1000) + 60;
    const req = makeReq({
      clerkUserId: CLERK_USER_ID,
      headers: { "x-reauth-exp": String(exp) },
    });
    const res = makeRes();

    await expect(
      controller.remove(ORG_ID, ORG_ID, req, res),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(service.deleteOrg).not.toHaveBeenCalled();
  });

  it("missing X-Reauth-Exp header → 401", async () => {
    const exp = Math.floor(Date.now() / 1000) + 60;
    const token = validToken(ORG_ID, INTERNAL_USER_ID, exp);
    const req = makeReq({
      clerkUserId: CLERK_USER_ID,
      headers: { "x-reauth-token": token },
    });
    const res = makeRes();

    await expect(
      controller.remove(ORG_ID, ORG_ID, req, res),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(service.deleteOrg).not.toHaveBeenCalled();
  });

  it("tampered token (one byte flipped) → 401", async () => {
    const exp = Math.floor(Date.now() / 1000) + 60;
    const valid = validToken(ORG_ID, INTERNAL_USER_ID, exp);
    const flipped =
      valid.slice(0, -1) + (valid.endsWith("a") ? "b" : "a");
    const req = makeReq({
      clerkUserId: CLERK_USER_ID,
      headers: { "x-reauth-token": flipped, "x-reauth-exp": String(exp) },
    });
    const res = makeRes();

    await expect(
      controller.remove(ORG_ID, ORG_ID, req, res),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(service.deleteOrg).not.toHaveBeenCalled();
  });

  it("token signed for a different user → 401", async () => {
    const exp = Math.floor(Date.now() / 1000) + 60;
    const token = validToken(ORG_ID, "different-user-id", exp);
    const req = makeReq({
      clerkUserId: CLERK_USER_ID,
      headers: { "x-reauth-token": token, "x-reauth-exp": String(exp) },
    });
    const res = makeRes();

    await expect(
      controller.remove(ORG_ID, ORG_ID, req, res),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(service.deleteOrg).not.toHaveBeenCalled();
  });

  it("expired token (exp in the past) → 401", async () => {
    const exp = Math.floor(Date.now() / 1000) - 30;
    const token = validToken(ORG_ID, INTERNAL_USER_ID, exp);
    const req = makeReq({
      clerkUserId: CLERK_USER_ID,
      headers: { "x-reauth-token": token, "x-reauth-exp": String(exp) },
    });
    const res = makeRes();

    await expect(
      controller.remove(ORG_ID, ORG_ID, req, res),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(service.deleteOrg).not.toHaveBeenCalled();
  });

  it("future-skew token (exp > now + 300s) → 401", async () => {
    const exp = Math.floor(Date.now() / 1000) + 600;
    const token = validToken(ORG_ID, INTERNAL_USER_ID, exp);
    const req = makeReq({
      clerkUserId: CLERK_USER_ID,
      headers: { "x-reauth-token": token, "x-reauth-exp": String(exp) },
    });
    const res = makeRes();

    await expect(
      controller.remove(ORG_ID, ORG_ID, req, res),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(service.deleteOrg).not.toHaveBeenCalled();
  });

  it("non-numeric X-Reauth-Exp header → 401", async () => {
    const exp = Math.floor(Date.now() / 1000) + 60;
    const token = validToken(ORG_ID, INTERNAL_USER_ID, exp);
    const req = makeReq({
      clerkUserId: CLERK_USER_ID,
      headers: { "x-reauth-token": token, "x-reauth-exp": "not-a-number" },
    });
    const res = makeRes();

    await expect(
      controller.remove(ORG_ID, ORG_ID, req, res),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(service.deleteOrg).not.toHaveBeenCalled();
  });

  it("server-side ENCRYPTION_KEY unset → 401", async () => {
    delete process.env.ENCRYPTION_KEY;
    const exp = Math.floor(Date.now() / 1000) + 60;
    // Token computed with empty secret; controller should still refuse.
    const token = createHmac("sha256", "")
      .update(`${ORG_ID}:${INTERNAL_USER_ID}:${exp}`)
      .digest("hex");
    const req = makeReq({
      clerkUserId: CLERK_USER_ID,
      headers: { "x-reauth-token": token, "x-reauth-exp": String(exp) },
    });
    const res = makeRes();

    await expect(
      controller.remove(ORG_ID, ORG_ID, req, res),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(service.deleteOrg).not.toHaveBeenCalled();
  });

  it("issues a delete challenge to a fresh signed Clerk OWNER", async () => {
    const now = Math.floor(Date.now() / 1000);
    verifyClerkTokenMock.mockResolvedValue({
      sub: CLERK_USER_ID,
      org_id: "org_clerk_1",
      org_role: "org:owner",
      iss: "https://clerk.example.test",
      exp: now + 300,
      iat: now,
    });

    const result = await controller.issueReauthChallenge(
      ORG_ID,
      ORG_ID,
      makeReq({ headers: { authorization: "Bearer fresh-token" } }),
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
    expect(result.expiresInSeconds).toBe(300);
    expect(result.token).toMatch(/^[a-f0-9]{64}$/);
  });

  it("does not mint a challenge when signed MEMBER vetoes stale database OWNER", async () => {
    const now = Math.floor(Date.now() / 1000);
    verifyClerkTokenMock.mockResolvedValue({
      sub: CLERK_USER_ID,
      org_id: "org_clerk_1",
      org_role: "org:member",
      iss: "https://clerk.example.test",
      exp: now + 300,
      iat: now,
    });

    await expect(
      controller.issueReauthChallenge(
        ORG_ID,
        ORG_ID,
        makeReq({ headers: { authorization: "Bearer fresh-token" } }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
  });
});
