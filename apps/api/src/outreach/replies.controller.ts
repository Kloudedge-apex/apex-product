import { BadRequestException, Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { ReplyIntent10 } from "@prisma/client";
import { OrgId } from "../common/org-context.decorator";
import { RepliesService } from "./replies.service";

function parseBoolean(value: string | undefined): boolean | null {
  if (value === undefined) return null;
  const v = value.trim().toLowerCase();
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  return null;
}

function parseReplyIntent10(value: unknown): ReplyIntent10 {
  if (typeof value !== "string") {
    throw new BadRequestException("intentOverride must be a string");
  }
  const allowed = Object.values(ReplyIntent10) as string[];
  if (!allowed.includes(value)) {
    throw new BadRequestException(`intentOverride must be one of: ${allowed.join(", ")}`);
  }
  return value as ReplyIntent10;
}

interface ResolveHitlBody {
  intentOverride: ReplyIntent10;
  note?: string;
}

@Controller("replies")
export class RepliesController {
  constructor(private readonly replies: RepliesService) {}

  @Get()
  list(
    @OrgId() orgId: string | undefined,
    @Query("requiresHitl") requiresHitl?: string,
    @Query("limit") limit?: string,
  ) {
    if (!orgId) throw new BadRequestException("orgId required");
    const flag = parseBoolean(requiresHitl);
    if (flag !== true) {
      throw new BadRequestException("Only requiresHitl=true is supported");
    }
    const parsedLimit = limit ? Number.parseInt(limit, 10) : 50;
    return this.replies.listRequiresHitl(orgId, parsedLimit);
  }

  @Post(":id/resolve-hitl")
  async resolveHitl(
    @OrgId() orgId: string | undefined,
    @Param("id") replyId: string,
    @Body() body: ResolveHitlBody,
  ) {
    if (!orgId) throw new BadRequestException("orgId required");
    if (!replyId) throw new BadRequestException("replyId required");
    const intentOverride = parseReplyIntent10(body?.intentOverride);
    const note = typeof body?.note === "string" ? body.note : null;
    return this.replies.resolveHitl(orgId, replyId, { intentOverride, note });
  }
}

