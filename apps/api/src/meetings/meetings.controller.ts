import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Query,
  BadRequestException,
  UnauthorizedException,
} from "@nestjs/common";
import { MeetingSource, MeetingStatus } from "@prisma/client";
import { OrgId, ClerkUserId } from "../common/org-context.decorator";
import { MeetingsService } from "./meetings.service";

interface CreateBody {
  title?: string;
  scheduledFor?: string;
  attendeeEmails?: string[];
  durationMinutes?: number;
  description?: string;
  notes?: string;
  outreachArtifactId?: string;
  personId?: string;
}

interface UpdateBody {
  title?: string;
  scheduledFor?: string;
  attendeeEmails?: string[];
  durationMinutes?: number;
  description?: string | null;
  notes?: string | null;
}

@Controller("meetings")
export class MeetingsController {
  constructor(private readonly meetings: MeetingsService) {}

  @Get()
  list(
    @OrgId() orgId: string,
    @Query("status") status?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("limit") limit?: string,
  ) {
    return this.meetings.list(orgId, {
      status: parseStatus(status),
      from: parseDate(from, "from"),
      to: parseDate(to, "to"),
      limit: limit ? parseLimit(limit) : undefined,
    });
  }

  @Get(":id")
  get(@OrgId() orgId: string, @Param("id") id: string) {
    return this.meetings.get(orgId, id);
  }

  @Post()
  create(
    @OrgId() orgId: string,
    @ClerkUserId() clerkUserId: string | undefined,
    @Body() body: CreateBody,
  ) {
    if (!body || typeof body.title !== "string") {
      throw new BadRequestException("title is required");
    }
    const scheduledFor = parseDate(body.scheduledFor, "scheduledFor");
    if (!scheduledFor) {
      throw new BadRequestException("scheduledFor is required");
    }
    if (!Array.isArray(body.attendeeEmails)) {
      throw new BadRequestException("attendeeEmails must be an array");
    }
    return this.meetings.create({
      orgId,
      title: body.title,
      scheduledFor,
      attendeeEmails: body.attendeeEmails,
      durationMinutes: body.durationMinutes,
      description: body.description,
      notes: body.notes,
      outreachArtifactId: body.outreachArtifactId,
      personId: body.personId,
      // Public callers cannot spoof an agent-created proposal.
      source: MeetingSource.HUMAN_LOGGED,
      createdBy: clerkUserId ?? null,
    });
  }

  @Patch(":id")
  update(
    @OrgId() orgId: string,
    @Param("id") id: string,
    @Body() body: UpdateBody,
  ) {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new BadRequestException("meeting update body is required");
    }
    if (
      body.title === undefined &&
      body.scheduledFor === undefined &&
      body.attendeeEmails === undefined &&
      body.durationMinutes === undefined &&
      body.description === undefined &&
      body.notes === undefined
    ) {
      throw new BadRequestException("meeting update must include a supported field");
    }
    if (body.title !== undefined && typeof body.title !== "string") {
      throw new BadRequestException("title must be a string");
    }
    if (
      body.scheduledFor !== undefined &&
      typeof body.scheduledFor !== "string"
    ) {
      throw new BadRequestException("scheduledFor must be an ISO-8601 datetime");
    }
    if (
      body.attendeeEmails !== undefined &&
      (!Array.isArray(body.attendeeEmails) ||
        body.attendeeEmails.some((email) => typeof email !== "string"))
    ) {
      throw new BadRequestException("attendeeEmails must be an array of strings");
    }
    if (
      body.durationMinutes !== undefined &&
      typeof body.durationMinutes !== "number"
    ) {
      throw new BadRequestException("durationMinutes must be a number");
    }
    if (
      body.description !== undefined &&
      body.description !== null &&
      typeof body.description !== "string"
    ) {
      throw new BadRequestException("description must be a string or null");
    }
    if (
      body.notes !== undefined &&
      body.notes !== null &&
      typeof body.notes !== "string"
    ) {
      throw new BadRequestException("notes must be a string or null");
    }
    return this.meetings.update(orgId, id, {
      title: body.title,
      description: body.description,
      notes: body.notes,
      scheduledFor: body.scheduledFor ? parseDate(body.scheduledFor, "scheduledFor") : undefined,
      durationMinutes: body.durationMinutes,
      attendeeEmails: body.attendeeEmails,
    });
  }

  @Post(":id/confirm")
  confirm(
    @OrgId() orgId: string,
    @ClerkUserId() clerkUserId: string | undefined,
    @Param("id") id: string,
    @Body() _body: { confirmedBy?: string } | undefined,
  ) {
    if (!clerkUserId) {
      throw new UnauthorizedException("Authenticated user is required");
    }
    return this.meetings.confirm(orgId, id, clerkUserId);
  }

  @Post(":id/cancel")
  cancel(
    @OrgId() orgId: string,
    @Param("id") id: string,
    @Body() body: { reason?: string } | undefined,
  ) {
    return this.meetings.cancel(orgId, id, body?.reason);
  }

  @Post(":id/complete")
  complete(@OrgId() orgId: string, @Param("id") id: string) {
    return this.meetings.markCompleted(orgId, id);
  }

  @Post(":id/no-show")
  noShow(@OrgId() orgId: string, @Param("id") id: string) {
    return this.meetings.markNoShow(orgId, id);
  }
}

function parseStatus(s: string | undefined): MeetingStatus | undefined {
  if (!s) return undefined;
  if (s in MeetingStatus) return s as MeetingStatus;
  throw new BadRequestException(`Unknown meeting status: ${s}`);
}

function parseDate(s: string | undefined, field: string): Date | undefined {
  if (s === undefined) return undefined;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) {
    throw new BadRequestException(`${field} must be an ISO-8601 datetime`);
  }
  return d;
}

function parseLimit(s: string): number {
  const n = Number.parseInt(s, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new BadRequestException("limit must be a positive integer");
  }
  return n;
}
