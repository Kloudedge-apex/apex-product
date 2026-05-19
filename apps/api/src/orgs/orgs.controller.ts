import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Req,
  ForbiddenException,
  UnauthorizedException,
} from "@nestjs/common";
import { Request } from "express";
import { OrgsService } from "./orgs.service";
import { OrgId } from "../common/org-context.decorator";
import { SkipOrgGuard } from "../common/org-scope.guard";
import { CreateOrgDto, UpdateOrgDto } from "../common/dto/orgs.dto";
import { verifyClerkToken } from "../common/jwt.util";

@Controller("orgs")
export class OrgsController {
  constructor(private readonly orgsService: OrgsService) {}

  /**
   * Org bootstrap. The user has a Clerk session but is not yet a member of
   * any org, so the JWT has no `org_id` claim — we skip the global guard and
   * verify the bearer token inline. The user identity comes from the verified
   * `sub` claim, NEVER from the request body.
   */
  @Post()
  @SkipOrgGuard()
  async create(@Req() req: Request, @Body() body: CreateOrgDto) {
    const { clerkUserId, email } = await verifyAuth(req);
    return this.orgsService.create({
      name: body.name,
      slug: body.slug,
      clerkUserId,
      email,
      userName: body.userName,
    });
  }

  /**
   * Returns the authenticated user's org (chicken-and-egg safe: this works
   * even before an `org_id` claim exists on the JWT).
   */
  @Get("me")
  @SkipOrgGuard()
  async findMe(@Req() req: Request) {
    const { clerkUserId } = await verifyAuth(req);
    return this.orgsService.findByClerkUser(clerkUserId);
  }

  @Get(":id")
  findOne(@OrgId() orgId: string, @Param("id") id: string) {
    if (id !== orgId) throw new ForbiddenException("Cross-org access denied");
    return this.orgsService.findOne(orgId);
  }

  @Patch(":id")
  update(
    @OrgId() orgId: string,
    @Param("id") id: string,
    @Body() body: UpdateOrgDto,
  ) {
    if (id !== orgId) throw new ForbiddenException("Cross-org access denied");
    return this.orgsService.update(orgId, body);
  }

  @Get(":id/stats")
  getStats(@OrgId() orgId: string, @Param("id") id: string) {
    if (id !== orgId) throw new ForbiddenException("Cross-org access denied");
    return this.orgsService.getStats(orgId);
  }
}

async function verifyAuth(
  req: Request,
): Promise<{ clerkUserId: string; email: string }> {
  const authHeader = req.headers["authorization"];
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new UnauthorizedException("Missing Authorization header");
  }
  try {
    const payload = await verifyClerkToken(authHeader.slice(7).trim());
    return { clerkUserId: payload.sub, email: payload.email ?? "" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Invalid token";
    throw new UnauthorizedException(msg);
  }
}
