import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import {
  MeetingLedger,
  MeetingSource,
  MeetingStatus,
} from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

export interface CreateMeetingInput {
  readonly orgId: string;
  readonly title: string;
  readonly scheduledFor: Date;
  readonly attendeeEmails: ReadonlyArray<string>;
  readonly description?: string;
  readonly notes?: string;
  readonly durationMinutes?: number;
  readonly outreachArtifactId?: string | null;
  readonly personId?: string | null;
  readonly conversationId?: string | null;
  readonly sourceMessageId?: string | null;
  readonly source?: MeetingSource;
  readonly createdBy?: string | null;
}

export interface UpdateMeetingInput {
  readonly title?: string;
  readonly description?: string | null;
  readonly notes?: string | null;
  readonly scheduledFor?: Date;
  readonly durationMinutes?: number;
  readonly attendeeEmails?: ReadonlyArray<string>;
}

export interface ListMeetingsOptions {
  readonly status?: MeetingStatus;
  readonly from?: Date;
  readonly to?: Date;
  readonly limit?: number;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_LIMIT = 200;

@Injectable()
export class MeetingsService {
  private readonly logger = new Logger(MeetingsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async create(input: CreateMeetingInput): Promise<MeetingLedger> {
    if (input.title.trim().length === 0) {
      throw new BadRequestException("title cannot be empty");
    }
    if (Number.isNaN(input.scheduledFor.getTime())) {
      throw new BadRequestException("scheduledFor must be a valid Date");
    }
    const duration = input.durationMinutes ?? 30;
    if (!Number.isInteger(duration) || duration <= 0 || duration > 24 * 60) {
      throw new BadRequestException(
        "durationMinutes must be a positive integer ≤ 1440",
      );
    }
    const attendees = normalizeAttendees(input.attendeeEmails);

    // Optional FKs: validate they belong to this org so we never link a
    // meeting to another tenant's artifact / person.
    if (input.outreachArtifactId) {
      const artifact = await this.prisma.outreachArtifact.findUnique({
        where: { id: input.outreachArtifactId },
        select: { orgId: true },
      });
      if (!artifact || artifact.orgId !== input.orgId) {
        throw new NotFoundException(
          `OutreachArtifact ${input.outreachArtifactId} not found`,
        );
      }
    }
    if (input.personId) {
      const person = await this.prisma.person.findUnique({
        where: { id: input.personId },
        select: { company: { select: { orgId: true } } },
      });
      if (!person || person.company.orgId !== input.orgId) {
        throw new NotFoundException(`Person ${input.personId} not found`);
      }
    }
    if (input.conversationId) {
      const conversation = await this.prisma.conversation.findFirst({
        where: { id: input.conversationId, orgId: input.orgId },
        select: { id: true },
      });
      if (!conversation) {
        throw new NotFoundException(
          `Conversation ${input.conversationId} not found`,
        );
      }
    }
    if (input.sourceMessageId) {
      const message = await this.prisma.conversationMessage.findFirst({
        where: {
          id: input.sourceMessageId,
          orgId: input.orgId,
          ...(input.conversationId
            ? { conversationId: input.conversationId }
            : {}),
        },
        select: { id: true },
      });
      if (!message) {
        throw new NotFoundException(
          `ConversationMessage ${input.sourceMessageId} not found`,
        );
      }
    }

    return this.prisma.meetingLedger.create({
      data: {
        orgId: input.orgId,
        title: input.title.trim(),
        description: input.description ?? null,
        notes: input.notes ?? null,
        scheduledFor: input.scheduledFor,
        durationMinutes: duration,
        attendeeEmails: attendees,
        outreachArtifactId: input.outreachArtifactId ?? null,
        personId: input.personId ?? null,
        conversationId: input.conversationId ?? null,
        sourceMessageId: input.sourceMessageId ?? null,
        source: input.source ?? MeetingSource.AGENT_PROPOSED,
        createdBy: input.createdBy ?? null,
      },
    });
  }

  async list(orgId: string, opts: ListMeetingsOptions = {}): Promise<MeetingLedger[]> {
    const take = clamp(opts.limit ?? 50, 1, MAX_LIMIT);
    return this.prisma.meetingLedger.findMany({
      where: {
        orgId,
        ...(opts.status ? { status: opts.status } : {}),
        ...(opts.from || opts.to
          ? {
              scheduledFor: {
                ...(opts.from ? { gte: opts.from } : {}),
                ...(opts.to ? { lte: opts.to } : {}),
              },
            }
          : {}),
      },
      orderBy: { scheduledFor: "asc" },
      take,
    });
  }

  async get(orgId: string, id: string): Promise<MeetingLedger> {
    const meeting = await this.prisma.meetingLedger.findUnique({ where: { id } });
    if (!meeting || meeting.orgId !== orgId) {
      throw new NotFoundException(`Meeting ${id} not found`);
    }
    return meeting;
  }

  async update(
    orgId: string,
    id: string,
    patch: UpdateMeetingInput,
  ): Promise<MeetingLedger> {
    const meeting = await this.get(orgId, id);
    if (
      meeting.status === MeetingStatus.CANCELLED ||
      meeting.status === MeetingStatus.COMPLETED
    ) {
      throw new BadRequestException(
        `Cannot update ${meeting.status.toLowerCase()} meeting`,
      );
    }

    if (patch.title !== undefined && patch.title.trim().length === 0) {
      throw new BadRequestException("title cannot be empty");
    }
    if (patch.scheduledFor !== undefined && Number.isNaN(patch.scheduledFor.getTime())) {
      throw new BadRequestException("scheduledFor must be a valid Date");
    }
    if (
      patch.durationMinutes !== undefined &&
      (!Number.isInteger(patch.durationMinutes) ||
        patch.durationMinutes <= 0 ||
        patch.durationMinutes > 24 * 60)
    ) {
      throw new BadRequestException(
        "durationMinutes must be a positive integer ≤ 1440",
      );
    }

    return this.prisma.meetingLedger.update({
      where: { id },
      data: {
        ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
        ...(patch.scheduledFor !== undefined ? { scheduledFor: patch.scheduledFor } : {}),
        ...(patch.durationMinutes !== undefined
          ? { durationMinutes: patch.durationMinutes }
          : {}),
        ...(patch.attendeeEmails !== undefined
          ? { attendeeEmails: normalizeAttendees(patch.attendeeEmails) }
          : {}),
      },
    });
  }

  async confirm(
    orgId: string,
    id: string,
    confirmedBy: string,
  ): Promise<MeetingLedger> {
    const meeting = await this.get(orgId, id);
    if (meeting.status !== MeetingStatus.PROPOSED) {
      throw new BadRequestException(
        `Meeting ${id} is ${meeting.status}; only PROPOSED meetings can be confirmed`,
      );
    }
    return this.prisma.meetingLedger.update({
      where: { id },
      data: {
        status: MeetingStatus.CONFIRMED,
        confirmedBy,
        confirmedAt: new Date(),
      },
    });
  }

  async cancel(
    orgId: string,
    id: string,
    reason?: string,
  ): Promise<MeetingLedger> {
    const meeting = await this.get(orgId, id);
    if (
      meeting.status === MeetingStatus.CANCELLED ||
      meeting.status === MeetingStatus.COMPLETED
    ) {
      throw new BadRequestException(
        `Meeting ${id} is already ${meeting.status.toLowerCase()}`,
      );
    }
    return this.prisma.meetingLedger.update({
      where: { id },
      data: {
        status: MeetingStatus.CANCELLED,
        cancelledReason: reason ?? null,
        cancelledAt: new Date(),
      },
    });
  }

  async markCompleted(orgId: string, id: string): Promise<MeetingLedger> {
    const meeting = await this.get(orgId, id);
    if (meeting.status !== MeetingStatus.CONFIRMED) {
      throw new BadRequestException(
        `Meeting ${id} is ${meeting.status}; only CONFIRMED meetings can be marked completed`,
      );
    }
    return this.prisma.meetingLedger.update({
      where: { id },
      data: { status: MeetingStatus.COMPLETED },
    });
  }
}

function normalizeAttendees(emails: ReadonlyArray<string>): string[] {
  const cleaned: string[] = [];
  for (const raw of emails) {
    const trimmed = raw.trim().toLowerCase();
    if (!EMAIL_RE.test(trimmed)) {
      throw new BadRequestException(`Invalid attendee email: ${raw}`);
    }
    if (!cleaned.includes(trimmed)) cleaned.push(trimmed);
  }
  return cleaned;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}
