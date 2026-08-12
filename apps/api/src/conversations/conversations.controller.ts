import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import {
  ConversationSentiment,
  FollowUpStatus,
} from "@prisma/client";
import { ClerkUserId, OrgId } from "../common/org-context.decorator";
import { ConversationsService } from "./conversations.service";

interface CreateReplyBody {
  readonly subject?: string;
  readonly body?: string;
}

interface CreateFollowUpBody {
  readonly dueAt?: string;
  readonly note?: string;
}

interface ProposeMeetingBody {
  readonly title?: string;
  readonly scheduledFor?: string;
  readonly durationMinutes?: number;
  readonly notes?: string;
}

@Controller("conversations")
export class ConversationsController {
  constructor(private readonly conversations: ConversationsService) {}

  @Get()
  list(
    @OrgId() orgId: string,
    @Query("sentiment") sentiment?: string,
    @Query("unread") unread?: string,
    @Query("needsReply") needsReply?: string,
    @Query("archived") archived?: string,
    @Query("leadId") leadId?: string,
    @Query("page") page?: string,
    @Query("limit") limit?: string,
    @Query("search") search?: string,
  ) {
    return this.conversations.list(orgId, {
      sentiment: parseSentiment(sentiment),
      unread: parseBoolean(unread, "unread"),
      needsReply: parseBoolean(needsReply, "needsReply"),
      archived: parseBoolean(archived, "archived"),
      leadId,
      page: parsePositiveInt(page, "page", 1),
      limit: parsePositiveInt(limit, "limit", 20),
      search: parseSearch(search),
    });
  }

  @Get(":id")
  get(@OrgId() orgId: string, @Param("id") id: string) {
    return this.conversations.get(orgId, id);
  }

  @Post(":id/read")
  markRead(@OrgId() orgId: string, @Param("id") id: string) {
    return this.conversations.markRead(orgId, id);
  }

  @Post(":id/archive")
  archive(@OrgId() orgId: string, @Param("id") id: string) {
    return this.conversations.archive(orgId, id);
  }

  @Post(":id/draft-reply")
  draftReply(@OrgId() orgId: string, @Param("id") id: string) {
    return this.conversations.generateReplyDraft(orgId, id);
  }

  @Post(":id/replies")
  createReply(
    @OrgId() orgId: string,
    @Param("id") id: string,
    @Body() body: CreateReplyBody,
  ) {
    if (!body || typeof body.body !== "string") {
      throw new BadRequestException("body is required");
    }
    assertOptionalString(body.subject, "subject");
    return this.conversations.createHumanReplyDraft(orgId, id, {
      subject: body.subject,
      body: body.body,
    });
  }

  @Post(":id/follow-ups")
  createFollowUp(
    @OrgId() orgId: string,
    @ClerkUserId() clerkUserId: string | undefined,
    @Param("id") id: string,
    @Body() body: CreateFollowUpBody,
  ) {
    if (!body || typeof body.dueAt !== "string") {
      throw new BadRequestException("dueAt is required");
    }
    assertOptionalString(body.note, "note");
    return this.conversations.createFollowUp(orgId, id, {
      dueAt: parseDate(body.dueAt, "dueAt"),
      note: body.note,
      createdBy: clerkUserId ?? null,
    });
  }

  @Patch(":id/follow-ups/:followUpId")
  updateFollowUp(
    @OrgId() orgId: string,
    @ClerkUserId() clerkUserId: string | undefined,
    @Param("id") id: string,
    @Param("followUpId") followUpId: string,
    @Body() body: { status?: string },
  ) {
    if (!body || body.status === undefined) {
      throw new BadRequestException("status is required");
    }
    const status = parseFollowUpStatus(body.status);
    return this.conversations.updateFollowUp(
      orgId,
      id,
      followUpId,
      status,
      clerkUserId ?? null,
    );
  }

  @Post(":id/meetings")
  proposeMeeting(
    @OrgId() orgId: string,
    @ClerkUserId() clerkUserId: string | undefined,
    @Param("id") id: string,
    @Body() body: ProposeMeetingBody,
  ) {
    if (!body || typeof body.scheduledFor !== "string") {
      throw new BadRequestException("scheduledFor is required");
    }
    assertOptionalString(body.title, "title");
    assertOptionalString(body.notes, "notes");
    if (
      body.durationMinutes !== undefined &&
      (!Number.isInteger(body.durationMinutes) ||
        body.durationMinutes <= 0 ||
        body.durationMinutes > 24 * 60)
    ) {
      throw new BadRequestException(
        "durationMinutes must be a positive integer no greater than 1440",
      );
    }
    return this.conversations.proposeMeeting(orgId, id, {
      title: body.title,
      scheduledFor: parseDate(body.scheduledFor, "scheduledFor"),
      durationMinutes: body.durationMinutes,
      notes: body.notes,
      createdBy: clerkUserId ?? null,
    });
  }
}

function parseBoolean(
  value: string | undefined,
  field: string,
): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new BadRequestException(`${field} must be true or false`);
}

function parsePositiveInt(
  value: string | undefined,
  field: string,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) {
    throw new BadRequestException(`${field} must be a positive integer`);
  }
  const parsed = Number.parseInt(value, 10);
  if (parsed < 1) {
    throw new BadRequestException(`${field} must be a positive integer`);
  }
  return parsed;
}

function parseSentiment(
  value: string | undefined,
): ConversationSentiment | undefined {
  if (value === undefined) return undefined;
  const normalized = value.toUpperCase();
  if (normalized in ConversationSentiment) {
    return normalized as ConversationSentiment;
  }
  throw new BadRequestException(`Unknown sentiment: ${value}`);
}

function parseSearch(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new BadRequestException("search must be a string");
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new BadRequestException("search must not be blank");
  }
  if (normalized.length > 200) {
    throw new BadRequestException("search must be 200 characters or fewer");
  }
  return normalized;
}

function parseFollowUpStatus(value: string): FollowUpStatus {
  const normalized = value.toUpperCase();
  if (normalized === FollowUpStatus.DONE) return FollowUpStatus.DONE;
  if (normalized === FollowUpStatus.CANCELLED) return FollowUpStatus.CANCELLED;
  throw new BadRequestException("status must be DONE or CANCELLED");
}

function parseDate(value: string, field: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestException(`${field} must be an ISO-8601 datetime`);
  }
  return parsed;
}

function assertOptionalString(
  value: unknown,
  field: string,
): asserts value is string | undefined {
  if (value !== undefined && typeof value !== "string") {
    throw new BadRequestException(`${field} must be a string`);
  }
}
