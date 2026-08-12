import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrgScopeGuard } from "../org-scope.guard";
import { verifyClerkToken } from "../jwt.util";

vi.mock("../jwt.util", () => ({
  verifyClerkToken: vi.fn(),
}));

const verifyClerkTokenMock = vi.mocked(verifyClerkToken);

interface GuardPrismaMock {
  user: { findUnique: ReturnType<typeof vi.fn> };
  org: {
    create: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
  };
}

function requestContext(request: Request): ExecutionContext {
  return {
    getClass: () => class TestController {},
    getHandler: () => function testHandler() {},
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;
}

function buildGuard(prisma: GuardPrismaMock): OrgScopeGuard {
  const reflector = {
    getAllAndOverride: vi.fn().mockReturnValue(undefined),
  };
  return new OrgScopeGuard(reflector as never, prisma as never);
}

function authenticatedRequest(extraHeaders?: Record<string, string>): Request {
  return {
    headers: {
      authorization: "Bearer verified-token",
      ...extraHeaders,
    },
  } as unknown as Request;
}

describe("OrgScopeGuard clean-tenant bootstrap", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CLERK_JWKS_URL", "https://clerk.example.test/jwks");
    vi.stubEnv("CLERK_DOMAIN", "");
    vi.stubEnv("CLERK_ISSUER", "");
    vi.stubEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "");
    vi.stubEnv("ALLOW_DEV_ORG_HEADER", "true");
    verifyClerkTokenMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("provisions one TRIAL Org/User for concurrent verified requests without org_id", async () => {
    const orgId = "org_internal_trial";
    verifyClerkTokenMock.mockResolvedValue({
      sub: "user_clerk_new",
      email: "owner@acme.example",
      iss: "https://clerk.example.test",
      exp: 2_000_000_000,
      iat: 1_900_000_000,
    });

    let initialReads = 0;
    let releaseInitialReads: (() => void) | undefined;
    const bothInitialReadsStarted = new Promise<void>((resolve) => {
      releaseInitialReads = resolve;
    });
    let persistedOrgRows = 0;
    let persistedUserRows = 0;
    let createAttempts = 0;

    const prisma: GuardPrismaMock = {
      user: {
        findUnique: vi.fn().mockImplementation(async () => {
          if (initialReads < 2) {
            initialReads += 1;
            if (initialReads === 2) releaseInitialReads?.();
            await bothInitialReadsStarted;
            return null;
          }
          return { orgId };
        }),
      },
      org: {
        create: vi.fn().mockImplementation(async () => {
          createAttempts += 1;
          if (createAttempts === 1) {
            persistedOrgRows += 1;
            persistedUserRows += 1;
            return { id: orgId };
          }
          throw new Error("unique constraint");
        }),
        findUnique: vi.fn().mockImplementation(async (args: unknown) => {
          const where = (args as { where?: { id?: string } }).where;
          return where?.id === orgId ? { id: orgId } : null;
        }),
      },
    };
    const guard = buildGuard(prisma);
    const firstRequest = authenticatedRequest();
    const secondRequest = authenticatedRequest({
      "x-org-id": "attacker_selected_org",
    });

    await expect(
      Promise.all([
        guard.canActivate(requestContext(firstRequest)),
        guard.canActivate(requestContext(secondRequest)),
      ]),
    ).resolves.toEqual([true, true]);

    expect(prisma.org.create).toHaveBeenCalledTimes(2);
    expect(persistedOrgRows).toBe(1);
    expect(persistedUserRows).toBe(1);
    for (const call of prisma.org.create.mock.calls) {
      expect(call[0]).toMatchObject({
        data: {
          name: "Acme",
          plan: "TRIAL",
          users: {
            create: {
              clerkId: "user_clerk_new",
              email: "owner@acme.example",
              role: "OWNER",
            },
          },
        },
      });
    }
    const attemptedSlugs = prisma.org.create.mock.calls.map(
      (call) => (call[0] as { data: { slug: string } }).data.slug,
    );
    expect(new Set(attemptedSlugs)).toEqual(
      new Set(["acme-3dffcd7483577f59"]),
    );
    expect(firstRequest).toMatchObject({
      orgId,
      clerkUserId: "user_clerk_new",
    });
    expect(secondRequest).toMatchObject({
      orgId,
      clerkUserId: "user_clerk_new",
    });
  });

  it("ignores x-org-id and rejects a production request without a bearer token", async () => {
    const prisma: GuardPrismaMock = {
      user: { findUnique: vi.fn() },
      org: { create: vi.fn(), findUnique: vi.fn() },
    };
    const guard = buildGuard(prisma);
    const request = {
      headers: { "x-org-id": "attacker_selected_org" },
    } as unknown as Request;

    await expect(
      guard.canActivate(requestContext(request)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(verifyClerkTokenMock).not.toHaveBeenCalled();
    expect(prisma.org.findUnique).not.toHaveBeenCalled();
  });

  it("does not fall back to x-org-id when Clerk rejects the bearer token", async () => {
    verifyClerkTokenMock.mockRejectedValue(new Error("bad signature"));
    const prisma: GuardPrismaMock = {
      user: { findUnique: vi.fn() },
      org: { create: vi.fn(), findUnique: vi.fn() },
    };
    const guard = buildGuard(prisma);

    await expect(
      guard.canActivate(
        requestContext(
          authenticatedRequest({ "x-org-id": "attacker_selected_org" }),
        ),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(prisma.org.findUnique).not.toHaveBeenCalled();
  });

  it("rejects a valid Clerk org claim that is not the user's internal tenant", async () => {
    verifyClerkTokenMock.mockResolvedValue({
      sub: "user_clerk_member",
      org_id: "org_foreign",
      iss: "https://clerk.example.test",
      exp: 2_000_000_000,
      iat: 1_900_000_000,
    });
    const prisma: GuardPrismaMock = {
      user: {
        findUnique: vi.fn().mockResolvedValue({ orgId: "org_owned" }),
      },
      org: {
        create: vi.fn(),
        findUnique: vi.fn().mockResolvedValue({ id: "org_foreign" }),
      },
    };
    const guard = buildGuard(prisma);

    await expect(
      guard.canActivate(requestContext(authenticatedRequest())),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("rejects a subjectless token before resolving its org claim", async () => {
    verifyClerkTokenMock.mockResolvedValue({
      org_id: "org_victim",
      iss: "https://clerk.example.test",
      exp: 2_000_000_000,
      iat: 1_900_000_000,
    } as never);
    const prisma: GuardPrismaMock = {
      user: { findUnique: vi.fn() },
      org: { create: vi.fn(), findUnique: vi.fn() },
    };
    const guard = buildGuard(prisma);

    await expect(
      guard.canActivate(requestContext(authenticatedRequest())),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(prisma.org.findUnique).not.toHaveBeenCalled();
  });

  it("refuses to construct in production when Clerk verification is unconfigured", () => {
    vi.stubEnv("CLERK_JWKS_URL", "");
    vi.stubEnv("CLERK_DOMAIN", "");
    vi.stubEnv("CLERK_ISSUER", "");
    vi.stubEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "");
    const prisma: GuardPrismaMock = {
      user: { findUnique: vi.fn() },
      org: { create: vi.fn(), findUnique: vi.fn() },
    };

    expect(() => buildGuard(prisma)).toThrow(
      "Clerk issuer/JWKS configuration must be set in production",
    );
  });
});
