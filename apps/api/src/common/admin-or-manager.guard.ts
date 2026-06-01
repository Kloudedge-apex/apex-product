import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { Request } from "express";
import { PrismaService } from "../prisma/prisma.service";

function isAdminOrManagerRole(role: string): boolean {
  const normalized = role.trim().toUpperCase();
  return (
    normalized === "ORG:ADMIN" ||
    normalized === "ORG:MANAGER" ||
    normalized === "ADMIN" ||
    normalized === "MANAGER"
  );
}

/**
 * Enforces that the caller is an admin/manager in the current org.
 *
 * Prefers the signed Clerk `org_role` claim when present. Falls back to the
 * internal User.role for flows that have clerkUserId but no org_role claim.
 */
@Injectable()
export class AdminOrManagerGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const reqAny = request as unknown as Record<string, unknown>;

    const rawOrgRole = reqAny.clerkOrgRole;
    if (typeof rawOrgRole === "string" && rawOrgRole.length > 0) {
      if (isAdminOrManagerRole(rawOrgRole)) return true;
      throw new ForbiddenException("Requires admin or manager role");
    }

    const clerkUserId = reqAny.clerkUserId;
    if (typeof clerkUserId === "string" && clerkUserId.length > 0) {
      const user = await this.prisma.user.findUnique({
        where: { clerkId: clerkUserId },
        select: { role: true },
      });
      if (user?.role === "OWNER" || user?.role === "ADMIN") return true;
    }

    throw new ForbiddenException("Requires admin or manager role");
  }
}

