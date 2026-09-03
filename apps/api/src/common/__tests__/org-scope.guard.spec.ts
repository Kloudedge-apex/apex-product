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
  $queryRaw?: ReturnType<typeof vi.fn>;
  $transaction?: ReturnType<typeof vi.fn>;
  clerkUserLifecycle?: { findUnique: ReturnType<typeof vi.fn> };
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
  prisma.$queryRaw ??= vi.fn().mockResolvedValue([]);
  prisma.clerkUserLifecycle ??= {
    findUnique: vi.fn().mockResolvedValue(null),
  };
  prisma.$transaction ??= vi.fn(
    async (callback: (tx: GuardPrismaMock) => Promise<unknown>) =>
      callback(prisma),
  );
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

  it("provisions one enterprise design-partner Org/User for concurrent verified requests without org_id", async () => {
    const orgId = "org_internal_trial";
    verifyClerkTokenMock.mockResolvedValue({
      sub: "user_clerk_new",
      email: "owner@acme.example",
      iss: "https://clerk.example.test",
      exp: 2_000_000_000,
      iat: 1_900_000_000,
    });

    let persisted = false;
    let persistedOrgRows = 0;
    let persistedUserRows = 0;
    let transactionTail = Promise.resolve();

    const prisma = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      clerkUserLifecycle: {
        findUnique: vi.fn().mockResolvedValue(null),
      },
      user: {
        findUnique: vi.fn().mockImplementation(async () =>
          persisted ? { orgId, membershipActive: true } : null,
        ),
      },
      org: {
        create: vi.fn().mockImplementation(async () => {
          persisted = true;
          persistedOrgRows += 1;
          persistedUserRows += 1;
          return { id: orgId };
        }),
        findUnique: vi.fn().mockImplementation(async (args: unknown) => {
          const where = (args as { where?: { id?: string } }).where;
          return where?.id === orgId
            ? { id: orgId, clerkOrgId: null }
            : null;
        }),
      },
    } as GuardPrismaMock;
    prisma.$transaction = vi.fn(
      (callback: (tx: GuardPrismaMock) => Promise<unknown>) => {
        const current = transactionTail.then(() => callback(prisma));
        transactionTail = current.then(
          () => undefined,
          () => undefined,
        );
        return current;
      },
    );
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

    expect(prisma.org.create).toHaveBeenCalledTimes(1);
    expect(persistedOrgRows).toBe(1);
    expect(persistedUserRows).toBe(1);
    for (const call of prisma.org.create.mock.calls) {
      expect(call[0]).toMatchObject({
        data: {
          name: "Acme",
          plan: "ENTERPRISE",
          designPartner: true,
          users: {
            create: {
              clerkId: "user_clerk_new",
              email: "owner@acme.example",
              membershipActive: true,
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

  it("rejects auto-provision when user.deleted arrived before any local User", async () => {
    verifyClerkTokenMock.mockResolvedValue({
      sub: "user_clerk_deleted",
      iss: "https://clerk.example.test",
      exp: 2_000_000_000,
      iat: 1_900_000_000,
    });
    const prisma: GuardPrismaMock = {
      clerkUserLifecycle: {
        findUnique: vi.fn().mockResolvedValue({ deleted: true }),
      },
      user: { findUnique: vi.fn().mockResolvedValue(null) },
      org: { create: vi.fn(), findUnique: vi.fn() },
    };
    const guard = buildGuard(prisma);

    await expect(
      guard.canActivate(requestContext(authenticatedRequest())),
    ).rejects.toThrow("Clerk user is permanently deleted");
    expect(prisma.org.create).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
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
      org_role: "org:member",
      iss: "https://clerk.example.test",
      exp: 2_000_000_000,
      iat: 1_900_000_000,
    });
    const prisma: GuardPrismaMock = {
      user: {
        findUnique: vi.fn().mockResolvedValue({
          orgId: "org_owned",
          membershipActive: true,
        }),
      },
      org: {
        create: vi.fn(),
        findUnique: vi.fn().mockResolvedValue({
          id: "org_foreign",
          clerkOrgId: "org_foreign",
        }),
      },
    };
    const guard = buildGuard(prisma);

    await expect(
      guard.canActivate(requestContext(authenticatedRequest())),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("resolves a standard Clerk org_id only through the immutable external id", async () => {
    verifyClerkTokenMock.mockResolvedValue({
      sub: "user_clerk_member",
      org_id: "org_clerk_123",
      org_role: "org:member",
      iss: "https://clerk.example.test",
      exp: 2_000_000_000,
      iat: 1_900_000_000,
    });
    const prisma: GuardPrismaMock = {
      user: {
        findUnique: vi.fn().mockResolvedValue({
          orgId: "org_internal_123",
          membershipActive: true,
        }),
      },
      org: {
        create: vi.fn(),
        findUnique: vi.fn().mockResolvedValue({
          id: "org_internal_123",
          clerkOrgId: "org_clerk_123",
        }),
      },
    };
    const guard = buildGuard(prisma);
    const request = authenticatedRequest();

    await expect(
      guard.canActivate(requestContext(request)),
    ).resolves.toBe(true);
    expect(prisma.org.findUnique).toHaveBeenCalledWith({
      where: { clerkOrgId: "org_clerk_123" },
      select: { id: true, clerkOrgId: true },
    });
    expect(request).toMatchObject({
      orgId: "org_internal_123",
      clerkUserId: "user_clerk_member",
      clerkOrgRole: "org:member",
    });
  });

  it("rejects a personal session for an existing Clerk-bound tenant", async () => {
    verifyClerkTokenMock.mockResolvedValue({
      sub: "user_clerk_member",
      iss: "https://clerk.example.test",
      exp: 2_000_000_000,
      iat: 1_900_000_000,
    });
    const prisma: GuardPrismaMock = {
      user: {
        findUnique: vi.fn().mockResolvedValue({
          orgId: "org_internal_123",
          membershipActive: true,
        }),
      },
      org: {
        create: vi.fn(),
        findUnique: vi.fn().mockResolvedValue({
          id: "org_internal_123",
          clerkOrgId: "org_clerk_123",
        }),
      },
    };
    const guard = buildGuard(prisma);
    const request = authenticatedRequest();

    await expect(
      guard.canActivate(requestContext(request)),
    ).rejects.toThrow("Active Clerk organization session required");
    expect(prisma.org.findUnique).toHaveBeenCalledWith({
      where: { id: "org_internal_123" },
      select: { id: true, clerkOrgId: true },
    });
    expect(prisma.org.create).not.toHaveBeenCalled();
    expect(request).not.toHaveProperty("orgId");
  });

  it("rejects org_id without org_role before tenant resolution", async () => {
    verifyClerkTokenMock.mockResolvedValue({
      sub: "user_clerk_member",
      org_id: "org_clerk_123",
      iss: "https://clerk.example.test",
      exp: 2_000_000_000,
      iat: 1_900_000_000,
    });
    const prisma: GuardPrismaMock = {
      user: {
        findUnique: vi.fn().mockResolvedValue({
          orgId: "org_internal_123",
          membershipActive: true,
        }),
      },
      org: {
        create: vi.fn(),
        findUnique: vi.fn().mockResolvedValue({
          id: "org_internal_123",
          clerkOrgId: "org_clerk_123",
        }),
      },
    };
    const guard = buildGuard(prisma);

    await expect(
      guard.canActivate(requestContext(authenticatedRequest())),
    ).rejects.toThrow("JWT organization claims are inconsistent");
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(prisma.org.findUnique).not.toHaveBeenCalled();
  });

  it("preserves a personal session for an existing unbound local tenant", async () => {
    verifyClerkTokenMock.mockResolvedValue({
      sub: "user_clerk_local",
      iss: "https://clerk.example.test",
      exp: 2_000_000_000,
      iat: 1_900_000_000,
    });
    const prisma: GuardPrismaMock = {
      user: {
        findUnique: vi.fn().mockResolvedValue({
          orgId: "org_internal_local",
          membershipActive: true,
        }),
      },
      org: {
        create: vi.fn(),
        findUnique: vi.fn().mockResolvedValue({
          id: "org_internal_local",
          clerkOrgId: null,
        }),
      },
    };
    const guard = buildGuard(prisma);
    const request = authenticatedRequest();

    await expect(
      guard.canActivate(requestContext(request)),
    ).resolves.toBe(true);
    expect(request).toMatchObject({
      orgId: "org_internal_local",
      clerkUserId: "user_clerk_local",
    });
  });

  it("rejects an inactive personal-session membership instead of reprovisioning it", async () => {
    verifyClerkTokenMock.mockResolvedValue({
      sub: "user_clerk_removed",
      iss: "https://clerk.example.test",
      exp: 2_000_000_000,
      iat: 1_900_000_000,
    });
    const prisma: GuardPrismaMock = {
      user: {
        findUnique: vi.fn().mockResolvedValue({
          orgId: "org_removed",
          membershipActive: false,
        }),
      },
      org: { create: vi.fn(), findUnique: vi.fn() },
    };
    const guard = buildGuard(prisma);

    await expect(
      guard.canActivate(requestContext(authenticatedRequest())),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.org.create).not.toHaveBeenCalled();
    expect(prisma.org.findUnique).not.toHaveBeenCalled();
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

  it("rejects org_role without org_id before local OWNER auto-provision", async () => {
    verifyClerkTokenMock.mockResolvedValue({
      sub: "user_clerk_inconsistent",
      org_role: "org:admin",
      iss: "https://clerk.example.test",
      exp: 2_000_000_000,
      iat: 1_900_000_000,
    });
    const prisma: GuardPrismaMock = {
      user: { findUnique: vi.fn() },
      org: { create: vi.fn(), findUnique: vi.fn() },
    };
    const guard = buildGuard(prisma);

    await expect(
      guard.canActivate(requestContext(authenticatedRequest())),
    ).rejects.toThrow("JWT organization claims are inconsistent");
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(prisma.org.create).not.toHaveBeenCalled();
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
