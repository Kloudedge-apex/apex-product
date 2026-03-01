import { createParamDecorator, ExecutionContext } from "@nestjs/common";
import { Request } from "express";

/**
 * Extracts orgId from the request. Checks (in order):
 * 1. x-org-id header
 * 2. query.orgId parameter
 * 3. body.orgId field
 *
 * Usage: @OrgId() orgId: string
 */
export const OrgId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string | undefined => {
    const request = ctx.switchToHttp().getRequest<Request>();

    // Check header first (set by auth middleware/clerk)
    const headerOrgId = request.headers["x-org-id"];
    if (typeof headerOrgId === "string" && headerOrgId.length > 0) {
      return headerOrgId;
    }

    // Check query params
    const queryOrgId = request.query.orgId;
    if (typeof queryOrgId === "string" && queryOrgId.length > 0) {
      return queryOrgId;
    }

    // Check body
    const body = request.body as Record<string, unknown> | undefined;
    if (body && typeof body.orgId === "string" && body.orgId.length > 0) {
      return body.orgId;
    }

    return undefined;
  },
);
