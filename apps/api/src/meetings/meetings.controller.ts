import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Query,
  BadRequestException,
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
  source?: MeetingSource;
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
      source: body.source ?? MeetingSource.HUMAN_LOGGED,
      createdBy: clerkUserId ?? null,
    });
  }

  @Patch(":id")
  update(
    @OrgId() orgId: string,
    @Param("id") id: string,
    @Body() body: UpdateBody,
  ) {
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
    @Body() body: { confirmedBy?: string } | undefined,
  ) {
    const confirmedBy = body?.confirmedBy ?? clerkUserId;
    if (!confirmedBy) {
      throw new BadRequestException("confirmedBy is required");
    }
    return this.meetings.confirm(orgId, id, confirmedBy);
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
