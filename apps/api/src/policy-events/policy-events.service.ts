import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { OutreachArtifactStatus, type Prisma } from "@prisma/client";
import {
  artifactFailedAt,
  artifactFailureReason,
  deliveryUnknownArtifactWhere,
  effectiveArtifactStatus,
  failedArtifactWhere,
  hasLegacyAutoFailedMarker,
  humanRejectedArtifactWhere,
  isFailedArtifact,
  LEGACY_AUTO_FAILED_PREFIX,
} from "../outreach/outreach-artifact-failure";

export type PolicyDecision =
  | "allowed"
  | "blocked"
  | "dry_run"
  | "delivery_unknown"
  | "failed"
  | "reconciliation_required";
export type SideEffectLevel =
  | "read_only"
  | "internal_write"
  | "external_write"
  | "destructive";

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

function policyDecisionWhere(
  decision: PolicyDecision,
): Prisma.OutreachArtifactWhereInput {
  switch (decision) {
    case "failed":
      return failedArtifactWhere();
    case "reconciliation_required":
      return {
        status: OutreachArtifactStatus.REJECTED,
        reviewerNote: { startsWith: LEGACY_AUTO_FAILED_PREFIX },
        failedAt: null,
      };
    case "delivery_unknown":
      return deliveryUnknownArtifactWhere();
    case "blocked":
      return {
        OR: [
          { status: OutreachArtifactStatus.SUPPRESSED },
          humanRejectedArtifactWhere(),
        ],
      };
    case "allowed":
      return {
        status: {
          in: [
            OutreachArtifactStatus.APPROVED,
            OutreachArtifactStatus.SENDING,
            OutreachArtifactStatus.SENT,
          ],
        },
      };
    case "dry_run":
      return {
        status: {
          in: [
            OutreachArtifactStatus.DRAFT,
            OutreachArtifactStatus.PENDING_REVIEW,
            OutreachArtifactStatus.SIMULATED,
          ],
        },
      };
  }
}

@Injectable()
export class PolicyEventsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    orgId: string,
    opts: ListOpts,
  ): Promise<{ events: PolicyEvent[] }> {
    const where: Prisma.OutreachArtifactWhereInput = { orgId };
    if (opts.graphRunId) where.graphRunId = opts.graphRunId;
    if (opts.decision) Object.assign(where, policyDecisionWhere(opts.decision));

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
        failureReason: true,
        failedAt: true,
        sentAt: true,
        reviewedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    const events: PolicyEvent[] = artifacts.map((a) => {
      const reconciliationRequired =
        hasLegacyAutoFailedMarker(a) && a.failedAt == null;
      const failed = isFailedArtifact(a);
      const effectiveStatus = effectiveArtifactStatus(a);
      const deliveryUnknown =
        effectiveStatus === OutreachArtifactStatus.DELIVERY_UNKNOWN;
      const decision: PolicyDecision = reconciliationRequired
        ? "reconciliation_required"
        : failed
          ? "failed"
          : deliveryUnknown
            ? "delivery_unknown"
            : effectiveStatus === OutreachArtifactStatus.REJECTED ||
                effectiveStatus === OutreachArtifactStatus.SUPPRESSED
              ? "blocked"
              : effectiveStatus === OutreachArtifactStatus.SENT ||
                  effectiveStatus === OutreachArtifactStatus.SENDING ||
                  effectiveStatus === OutreachArtifactStatus.APPROVED
                ? "allowed"
                : "dry_run";
      const at = reconciliationRequired
        ? a.updatedAt
        : failed
          ? (artifactFailedAt(a) ?? a.updatedAt)
          : effectiveStatus === OutreachArtifactStatus.SENT && a.sentAt
            ? a.sentAt
            : deliveryUnknown
              ? a.updatedAt
              : (a.reviewedAt ?? a.createdAt);
      return {
        id: a.id,
        graphRunId: a.graphRunId ?? undefined,
        toolName: a.toolName,
        sideEffectLevel: "external_write",
        decision,
        reason: reconciliationRequired
          ? "Historical system marker lacks trusted failure evidence; reconcile before classifying this artifact as a reviewer rejection or send failure"
          : failed
            ? (artifactFailureReason(a) ?? undefined)
            : (a.reviewerNote ?? undefined),
        createdAt: at.toISOString(),
      };
    });

    return { events };
  }
}
