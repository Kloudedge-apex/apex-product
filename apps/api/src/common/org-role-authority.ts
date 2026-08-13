import type { Request } from "express";
import { PrismaService } from "../prisma/prisma.service";

export type PrivilegedOrgRole = "OWNER" | "ADMIN" | "MANAGER";

export const ADMIN_OR_MANAGER_ROLES = [
  "OWNER",
  "ADMIN",
  "MANAGER",
] as const satisfies readonly PrivilegedOrgRole[];
export const OWNER_OR_ADMIN_ROLES = [
  "OWNER",
  "ADMIN",
] as const satisfies readonly PrivilegedOrgRole[];
export const OWNER_ONLY_ROLES = [
  "OWNER",
] as const satisfies readonly PrivilegedOrgRole[];

interface AuthorizedOrgUser {
  id: string;
  email: string;
  role: PrivilegedOrgRole;
}

function normalizeOrgRole(role: unknown): PrivilegedOrgRole | null {
  if (typeof role !== "string") return null;
  const normalized = role.trim().toUpperCase().replace(/^ORG:/, "");
  return normalized === "OWNER" ||
    normalized === "ADMIN" ||
    normalized === "MANAGER"
    ? normalized
    : null;
}

function roleIsAllowed(
  role: unknown,
  allowedRoles: readonly PrivilegedOrgRole[],
): boolean {
  const normalized = normalizeOrgRole(role);
  return normalized !== null && allowedRoles.includes(normalized);
}

export function readSignedClerkOrgRole(request: Request): unknown {
  return (request as unknown as Record<string, unknown>).clerkOrgRole;
}

/**
 * Mirrors OrgScopeGuard for endpoints that must verify a token inline before
 * an org context exists. Bound tenants require matching signed org claims;
 * unbound local workspaces require a personal session with no org claims.
 */
export function hasRequiredClerkOrgSession(
  boundClerkOrgId: string | null,
  claims: { clerkOrgId?: string; clerkOrgRole?: string },
): boolean {
  const claimOrgId = claims.clerkOrgId?.trim() ?? "";
  const claimOrgRole = claims.clerkOrgRole?.trim() ?? "";
  if (boundClerkOrgId) {
    return claimOrgId === boundClerkOrgId && claimOrgRole.length > 0;
  }
  return claimOrgId.length === 0 && claimOrgRole.length === 0;
}

/**
 * Resolves an active user inside the authoritative tenant and applies the
 * dual role authority used by privileged routes:
 *
 * - the synchronized database role must satisfy the route's allowed roles;
 * - a nonempty signed Clerk org_role can veto that database role immediately;
 * - a Clerk-bound tenant requires an allowed signed org_role, while an
 *   unbound local/personal tenant may rely on its database role alone.
 */
export async function findAuthorizedOrgUser(
  prisma: PrismaService,
  input: {
    clerkUserId: string;
    orgId: string;
    clerkOrgRole: unknown;
    allowedRoles: readonly PrivilegedOrgRole[];
  },
): Promise<AuthorizedOrgUser | null> {
  const signedRolePresent =
    typeof input.clerkOrgRole === "string" &&
    input.clerkOrgRole.length > 0;
  if (
    signedRolePresent &&
    !roleIsAllowed(input.clerkOrgRole, input.allowedRoles)
  ) {
    return null;
  }

  const user = await prisma.user.findFirst({
    where: {
      clerkId: input.clerkUserId,
      orgId: input.orgId,
      membershipActive: true,
    },
    select: {
      id: true,
      email: true,
      role: true,
      org: { select: { clerkOrgId: true } },
    },
  });
  if (!user || !roleIsAllowed(user.role, input.allowedRoles)) return null;
  if (
    user.org.clerkOrgId &&
    !roleIsAllowed(input.clerkOrgRole, input.allowedRoles)
  ) {
    return null;
  }

  return {
    id: user.id,
    email: user.email,
    role: user.role as PrivilegedOrgRole,
  };
}
