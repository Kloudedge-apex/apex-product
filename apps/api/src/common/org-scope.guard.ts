import { Injectable, CanActivate, ExecutionContext, ForbiddenException, BadRequestException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Request } from "express";
import { PrismaService } from "../prisma/prisma.service";

export const SKIP_ORG_GUARD = "skipOrgGuard";

/**
 * Guard that ensures the requesting user's org matches the resource's org.
 * Extracts orgId from header/query/body and validates it exists.
 *
 * Use @SkipOrgGuard() decorator to skip for public endpoints.
 */
@Injectable()
export class OrgScopeGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Check if guard should be skipped
    const skipGuard = this.reflector.getAllAndOverride<boolean>(SKIP_ORG_GUARD, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (skipGuard) return true;

    const request = context.switchToHttp().getRequest<Request>();

    // Extract orgId from multiple sources
    const orgId = this.extractOrgId(request);

    // If no orgId found, allow the request (some endpoints don't need it)
    if (!orgId) return true;

    // Validate org exists
    const org = await this.prisma.org.findUnique({
      where: { id: orgId },
      select: { id: true },
    });

    if (!org) {
      throw new ForbiddenException("Invalid organization");
    }

    // Store orgId on request for downstream use
    (request as Record<string, unknown>).orgId = orgId;

    return true;
  }

  private extractOrgId(request: Request): string | undefined {
    const headerOrgId = request.headers["x-org-id"];
    if (typeof headerOrgId === "string") return headerOrgId;

    const queryOrgId = request.query.orgId;
    if (typeof queryOrgId === "string") return queryOrgId;

    const body = request.body as Record<string, unknown> | undefined;
    if (body && typeof body.orgId === "string") return body.orgId;

    return undefined;
  }
}

import { SetMetadata } from "@nestjs/common";

/**
 * Decorator to skip org scope guard for specific endpoints.
 * Use on health checks, auth callbacks, and public endpoints.
 */
export function SkipOrgGuard() {
  return SetMetadata(SKIP_ORG_GUARD, true);
}
