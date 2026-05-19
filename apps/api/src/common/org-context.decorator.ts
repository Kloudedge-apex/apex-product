import {
  createParamDecorator,
  ExecutionContext,
  InternalServerErrorException,
} from "@nestjs/common";
import { Request } from "express";

/**
 * Returns the authoritative orgId set by `OrgScopeGuard` after JWT verification.
 *
 * Never reads from headers, query, or body — those are client-controlled and
 * would defeat multi-tenant isolation. If the guard hasn't run (e.g. on a
 * `@SkipOrgGuard()` endpoint that mistakenly uses this decorator), throws.
 *
 * Usage: `@OrgId() orgId: string`
 */
export const OrgId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const request = ctx.switchToHttp().getRequest<Request>();
    const orgId = (request as unknown as Record<string, unknown>).orgId;
    if (typeof orgId !== "string" || orgId.length === 0) {
      throw new InternalServerErrorException(
        "@OrgId() used on a route that did not pass OrgScopeGuard",
      );
    }
    return orgId;
  },
);

/** Returns the Clerk user id set by `OrgScopeGuard`, or undefined if absent. */
export const ClerkUserId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string | undefined => {
    const request = ctx.switchToHttp().getRequest<Request>();
    const id = (request as unknown as Record<string, unknown>).clerkUserId;
    return typeof id === "string" ? id : undefined;
  },
);
