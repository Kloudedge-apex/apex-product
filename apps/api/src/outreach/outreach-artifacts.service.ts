import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import {
  OutreachArtifact,
  OutreachArtifactStatus,
  OutreachChannel,
  Prisma,
} from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

/**
 * Maps the tool name reported by the executor to the channel enum we store
 * on the artifact. Keep this in sync with TOOL_POLICY_METADATA — every tool
 * whose dry-run produces an artifact must map to a channel here.
 */
function channelForTool(toolName: string): OutreachChannel | null {
  switch (toolName) {
    case "send_email":
      return OutreachChannel.EMAIL;
    case "hubspot":
      return OutreachChannel.HUBSPOT_NOTE;
    default:
      return null;
  }
}

export interface CreateDryRunArtifactInput {
  readonly orgId: string;
  readonly graphRunId?: string | null;
  readonly toolName: string;
  readonly toolArgs: Record<string, unknown>;
}

@Injectable()
export class OutreachArtifactsService {
  private readonly logger = new Logger(OutreachArtifactsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Persist a dry-run capture of what would have been sent. Returns null
   * for tools that do not map to a channel — those calls produce no
   * reviewable artifact (e.g. read-only tools should never reach here).
   */
  async recordDryRun(input: CreateDryRunArtifactInput): Promise<OutreachArtifact | null> {
    const channel = channelForTool(input.toolName);
    if (!channel) {
      this.logger.warn(
        `Skipping artifact for ${input.toolName} — no channel mapping`,
      );
      return null;
    }

    const { subject, bodyText, bodyHtml, recipientRef } = extractFromArgs(
      input.toolName,
      input.toolArgs,
    );

    return this.prisma.outreachArtifact.create({
      data: {
        orgId: input.orgId,
        graphRunId: input.graphRunId ?? null,
        toolName: input.toolName,
        channel,
        recipientRef,
        subject,
        bodyText,
        bodyHtml,
        payload: input.toolArgs as Prisma.InputJsonValue,
        status: OutreachArtifactStatus.PENDING_REVIEW,
      },
    });
  }

  async listForOrg(orgId: string, opts: { status?: OutreachArtifactStatus } = {}) {
    return this.prisma.outreachArtifact.findMany({
      where: {
        orgId,
        ...(opts.status ? { status: opts.status } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
  }

  async listForGraphRun(orgId: string, graphRunId: string) {
    return this.prisma.outreachArtifact.findMany({
      where: { orgId, graphRunId },
      orderBy: { createdAt: "asc" },
    });
  }

  async get(orgId: string, id: string): Promise<OutreachArtifact> {
    const artifact = await this.prisma.outreachArtifact.findUnique({ where: { id } });
    if (!artifact || artifact.orgId !== orgId) {
      throw new NotFoundException(`OutreachArtifact ${id} not found`);
    }
    return artifact;
  }

  async approve(
    orgId: string,
    id: string,
    reviewedBy: string,
  ): Promise<OutreachArtifact> {
    const artifact = await this.get(orgId, id);
    if (artifact.status !== OutreachArtifactStatus.PENDING_REVIEW) {
      throw new BadRequestException(
        `Artifact ${id} is ${artifact.status}; only PENDING_REVIEW can be approved`,
      );
    }
    return this.prisma.outreachArtifact.update({
      where: { id },
      data: {
        status: OutreachArtifactStatus.APPROVED,
        reviewedBy,
        reviewedAt: new Date(),
      },
    });
  }

  async reject(
    orgId: string,
    id: string,
    reviewedBy: string,
    reviewerNote?: string,
  ): Promise<OutreachArtifact> {
    const artifact = await this.get(orgId, id);
    if (artifact.status !== OutreachArtifactStatus.PENDING_REVIEW) {
      throw new BadRequestException(
        `Artifact ${id} is ${artifact.status}; only PENDING_REVIEW can be rejected`,
      );
    }
    return this.prisma.outreachArtifact.update({
      where: { id },
      data: {
        status: OutreachArtifactStatus.REJECTED,
        reviewedBy,
        reviewedAt: new Date(),
        reviewerNote: reviewerNote ?? null,
      },
    });
  }
}

/**
 * Best-effort extraction of human-readable fields from the tool args.
 * The payload column always stores the verbatim args, so missing/empty
 * extracted fields are not fatal — they just degrade the reviewer UI.
 */
function extractFromArgs(
  toolName: string,
  args: Record<string, unknown>,
): {
  subject: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  recipientRef: string | null;
} {
  const str = (v: unknown): string | null =>
    typeof v === "string" && v.length > 0 ? v : null;

  if (toolName === "send_email") {
    return {
      subject: str(args.subject),
      bodyText: str(args.body) ?? str(args.bodyText) ?? str(args.text),
      bodyHtml: str(args.html) ?? str(args.bodyHtml),
      recipientRef: str(args.to) ?? str(args.recipient) ?? str(args.email),
    };
  }
  if (toolName === "hubspot") {
    return {
      subject: str(args.summary) ?? str(args.title),
      bodyText: str(args.note) ?? str(args.body),
      bodyHtml: null,
      recipientRef:
        str(args.contactEmail) ?? str(args.contactId) ?? str(args.companyId),
    };
  }
  return { subject: null, bodyText: null, bodyHtml: null, recipientRef: null };
}
