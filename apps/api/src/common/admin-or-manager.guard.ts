import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { Request } from "express";
import { PrismaService } from "../prisma/prisma.service";
import {
  ADMIN_OR_MANAGER_ROLES,
  findAuthorizedOrgUser,
  readSignedClerkOrgRole,
} from "./org-role-authority";

/**
 * Enforces that the caller is an admin/manager in the current org.
 *
 * The synchronized tenant-scoped database role is required. Clerk-bound
 * tenants additionally require a privileged signed `org_role`; unbound local
 * tenants may rely on their database role. This closes both propagation
 * windows without breaking local/personal workspaces.
 */
@Injectable()
export class AdminOrManagerGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const reqAny = request as unknown as Record<string, unknown>;

    const clerkUserId = reqAny.clerkUserId;
    const orgId = reqAny.orgId;
    if (
      typeof clerkUserId === "string" &&
      clerkUserId.length > 0 &&
      typeof orgId === "string" &&
      orgId.length > 0
    ) {
      const user = await findAuthorizedOrgUser(this.prisma, {
        clerkUserId,
        orgId,
        clerkOrgRole: readSignedClerkOrgRole(request),
        allowedRoles: ADMIN_OR_MANAGER_ROLES,
      });
      if (user) return true;
    }

    throw new ForbiddenException("Requires admin or manager role");
  }
}
