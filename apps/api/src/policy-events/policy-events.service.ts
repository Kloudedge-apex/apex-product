import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { OutreachArtifactStatus } from "@prisma/client";

export type PolicyDecision = "allowed" | "blocked" | "dry_run" | "delivery_unknown";
export type SideEffectLevel = "read_only" | "internal_write" | "external_write" | "destructive";

export interface PolicyEvent {
  id: string;
  graphRunId?: string;
  agentRunId?: string;
  toolName: string;
  sideEffectLevel: SideEffectLevel;
  decision: PolicyDecision;
  reason?: string;
  createdAt: string;
}

interface ListOpts {
  graphRunId?: string;
  decision?: PolicyDecision;
  limit: number;
}

@Injectable()
export class PolicyEventsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(orgId: string, opts: ListOpts): Promise<{ events: PolicyEvent[] }> {
    const where: {
      orgId: string;
      graphRunId?: string;
    } = { orgId };
    if (opts.graphRunId) where.graphRunId = opts.graphRunId;

    const artifacts = await this.prisma.outreachArtifact.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      take: opts.limit,
      select: {
        id: true,
        graphRunId: true,
        toolName: true,
        status: true,
        reviewerNote: true,
        sentAt: true,
        reviewedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    const events: PolicyEvent[] = artifacts.map((a) => {
      const decision: PolicyDecision =
        a.status === OutreachArtifactStatus.DELIVERY_UNKNOWN
          ? "delivery_unknown"
          : a.status === OutreachArtifactStatus.REJECTED ||
              a.status === OutreachArtifactStatus.SUPPRESSED
          ? "blocked"
          : a.status === OutreachArtifactStatus.SENT ||
              a.status === OutreachArtifactStatus.SENDING ||
              a.status === OutreachArtifactStatus.APPROVED
            ? "allowed"
            : "dry_run";
      const at =
        a.status === OutreachArtifactStatus.SENT && a.sentAt
          ? a.sentAt
          : a.status === OutreachArtifactStatus.DELIVERY_UNKNOWN
            ? a.updatedAt
          : a.reviewedAt ?? a.createdAt;
      return {
        id: a.id,
        graphRunId: a.graphRunId ?? undefined,
        toolName: a.toolName,
        sideEffectLevel: "external_write",
        decision,
        reason: a.reviewerNote ?? undefined,
        createdAt: at.toISOString(),
      };
    });

    const filtered = opts.decision ? events.filter((e) => e.decision === opts.decision) : events;
    return { events: filtered };
  }
}
