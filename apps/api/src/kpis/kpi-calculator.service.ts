import { Inject, Injectable } from "@nestjs/common";
import { OutreachArtifactStatus } from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import {
  HIGH_PRIORITY_THRESHOLD,
  LOW_PRIORITY_THRESHOLD,
  QUALIFIED_THRESHOLD,
} from "../common/qualification.constants";
import {
  whereEvidenceEventsInWindow,
  whereGraphRunsInWindow,
  whereLeadScores,
  whereOutreachArtifactsInWindow,
} from "./queries";
import {
  failedArtifactWhere,
  humanRejectedArtifactWhere,
  reviewedDecisionArtifactWhere,
} from "../outreach/outreach-artifact-failure";

export interface KpiPrismaClient {
  readonly evidenceEvent: {
    findMany(
      args: Prisma.EvidenceEventFindManyArgs,
    ): Promise<Array<{ payload: Prisma.JsonValue }>>;
  };
  readonly graphRun: {
    count(args: Prisma.GraphRunCountArgs): Promise<number>;
  };
  readonly outreachArtifact: {
    count(args: Prisma.OutreachArtifactCountArgs): Promise<number>;
  };
  readonly leadScore: {
    findMany(
      args: Prisma.LeadScoreFindManyArgs,
    ): Promise<Array<{ score: number }>>;
    count(args: Prisma.LeadScoreCountArgs): Promise<number>;
  };
}

export interface Percentiles {
  readonly p50_ms: number | null;
  readonly p95_ms: number | null;
}

export interface OperationalKpi {
  readonly windowDays: number;
  readonly graph_runs_total: number;
  readonly graph_runs_failed: number;
  readonly graph_error_rate: number | null;
  readonly durations_ms: {
    readonly lead_sourced: Percentiles;
    readonly lead_scored: Percentiles;
    readonly message_drafted: Percentiles;
    readonly qa: Percentiles;
  };
  /**
   * Counts of live agent-tool activity within the window. Sourced from
   * EvidenceEvent rows emitted by send_email and hubspot tool calls (refType
   * `outreach_tool_call` / `crm_object`) — independent of OutreachArtifact
   * status, so the dashboard reflects in-loop sends even when no artifact
   * was approved through the post-review pipeline.
   */
  readonly activity: {
    readonly messages_sent: number;
    readonly crm_syncs: number;
  };
}

export interface QualityKpi {
  readonly windowDays: number;
  readonly outreach_artifacts: {
    readonly pending_review: number;
    readonly approved: number;
    readonly rejected: number;
    readonly failed: number;
    readonly sent: number;
  };
  readonly lead_score_distribution: {
    readonly A: number;
    readonly B: number;
    readonly C: number;
  };
}

export interface CommercialKpi {
  readonly windowDays: number;
  readonly cost_usd: number;
  readonly qualified_leads: number;
  readonly cost_per_qualified_lead_usd: number | null;
}

export interface GuaranteeDefenseKpi {
  readonly windowDays: number;
  readonly rejected_artifacts: number;
  readonly reviewed_artifacts: number;
  readonly rejection_rate: number | null;
}

function windowSince(windowDays: number): Date {
  const clamped = Math.max(1, Math.min(90, windowDays));
  return new Date(Date.now() - clamped * 24 * 60 * 60 * 1000);
}

function percentiles(values: readonly number[]): Percentiles {
  if (values.length === 0) return { p50_ms: null, p95_ms: null };
  const sorted = [...values].sort((a, b) => a - b);

  const pick = (p: number): number => {
    const idx = Math.max(
      0,
      Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1),
    );
    return sorted[idx] ?? 0;
  };

  return {
    p50_ms: pick(0.5),
    p95_ms: pick(0.95),
  };
}

function durationsFromEvidenceEvents(
  events: ReadonlyArray<{ payload: Prisma.JsonValue }>,
): number[] {
  const durations: number[] = [];
  for (const ev of events) {
    const payload = ev.payload;
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      const maybeDuration = (payload as Record<string, unknown>).duration_ms;
      if (
        typeof maybeDuration === "number" &&
        Number.isFinite(maybeDuration) &&
        maybeDuration >= 0
      ) {
        durations.push(maybeDuration);
      }
    }
  }
  return durations;
}

function costUsdFromEvidenceEvents(
  events: ReadonlyArray<{ payload: Prisma.JsonValue }>,
): number {
  let total = 0;
  for (const ev of events) {
    const payload = ev.payload;
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      const maybeCost = (payload as Record<string, unknown>).cost_usd;
      if (
        typeof maybeCost === "number" &&
        Number.isFinite(maybeCost) &&
        maybeCost >= 0
      ) {
        total += maybeCost;
      }
    }
  }
  return total;
}

@Injectable()
export class KpiCalculatorService {
  constructor(
    @Inject(PrismaService) private readonly prisma: KpiPrismaClient,
  ) {}

  async operational(
    orgId: string,
    window: { readonly windowDays: number },
  ): Promise<OperationalKpi> {
    const since = windowSince(window.windowDays);

    const [graphRunsTotal, graphRunsFailed] = await Promise.all([
      this.prisma.graphRun.count({
        where: whereGraphRunsInWindow(orgId, since),
      }),
      this.prisma.graphRun.count({
        where: { ...whereGraphRunsInWindow(orgId, since), status: "FAILED" },
      }),
    ]);

    const [
      leadSourced,
      leadScored,
      messageDrafted,
      qa,
      messageSent,
      crmSynced,
    ] = await Promise.all([
      this.prisma.evidenceEvent.findMany({
        where: whereEvidenceEventsInWindow(orgId, since, ["lead.sourced"]),
        select: { payload: true },
      }),
      this.prisma.evidenceEvent.findMany({
        where: whereEvidenceEventsInWindow(orgId, since, ["lead.scored"]),
        select: { payload: true },
      }),
      this.prisma.evidenceEvent.findMany({
        where: whereEvidenceEventsInWindow(orgId, since, ["message.drafted"]),
        select: { payload: true },
      }),
      this.prisma.evidenceEvent.findMany({
        where: whereEvidenceEventsInWindow(orgId, since, [
          "qa.pass",
          "qa.fail",
        ]),
        select: { payload: true },
      }),
      this.prisma.evidenceEvent.findMany({
        where: whereEvidenceEventsInWindow(orgId, since, ["message.sent"]),
        select: { payload: true },
      }),
      this.prisma.evidenceEvent.findMany({
        where: whereEvidenceEventsInWindow(orgId, since, ["crm.synced"]),
        select: { payload: true },
      }),
    ]);

    const errorRate =
      graphRunsTotal > 0 ? graphRunsFailed / graphRunsTotal : null;

    return {
      windowDays: window.windowDays,
      graph_runs_total: graphRunsTotal,
      graph_runs_failed: graphRunsFailed,
      graph_error_rate: errorRate,
      durations_ms: {
        lead_sourced: percentiles(durationsFromEvidenceEvents(leadSourced)),
        lead_scored: percentiles(durationsFromEvidenceEvents(leadScored)),
        message_drafted: percentiles(
          durationsFromEvidenceEvents(messageDrafted),
        ),
        qa: percentiles(durationsFromEvidenceEvents(qa)),
      },
      activity: {
        messages_sent: messageSent.length,
        crm_syncs: crmSynced.length,
      },
    };
  }

  async quality(
    orgId: string,
    window: { readonly windowDays: number },
  ): Promise<QualityKpi> {
    const since = windowSince(window.windowDays);

    const [pendingReview, approved, rejected, failed, sent, scores] =
      await Promise.all([
        this.prisma.outreachArtifact.count({
          where: whereOutreachArtifactsInWindow(
            orgId,
            since,
            OutreachArtifactStatus.PENDING_REVIEW,
          ),
        }),
        this.prisma.outreachArtifact.count({
          where: whereOutreachArtifactsInWindow(
            orgId,
            since,
            OutreachArtifactStatus.APPROVED,
          ),
        }),
        this.prisma.outreachArtifact.count({
          where: {
            ...whereOutreachArtifactsInWindow(orgId, since),
            ...humanRejectedArtifactWhere(),
          },
        }),
        this.prisma.outreachArtifact.count({
          where: {
            ...whereOutreachArtifactsInWindow(orgId, since),
            ...failedArtifactWhere(),
          },
        }),
        this.prisma.outreachArtifact.count({
          where: whereOutreachArtifactsInWindow(
            orgId,
            since,
            OutreachArtifactStatus.SENT,
          ),
        }),
        this.prisma.leadScore.findMany({
          where: whereLeadScores(orgId),
          select: { score: true },
        }),
      ]);

    let a = 0;
    let b = 0;
    let c = 0;
    for (const s of scores) {
      if (s.score >= HIGH_PRIORITY_THRESHOLD) a += 1;
      else if (s.score >= LOW_PRIORITY_THRESHOLD) b += 1;
      else c += 1;
    }

    return {
      windowDays: window.windowDays,
      outreach_artifacts: {
        pending_review: pendingReview,
        approved,
        rejected,
        failed,
        sent,
      },
      lead_score_distribution: { A: a, B: b, C: c },
    };
  }

  async commercial(
    orgId: string,
    window: { readonly windowDays: number },
  ): Promise<CommercialKpi> {
    const since = windowSince(window.windowDays);

    const [draftEvents, qualifiedLeads] = await Promise.all([
      this.prisma.evidenceEvent.findMany({
        where: whereEvidenceEventsInWindow(orgId, since, ["message.drafted"]),
        select: { payload: true },
      }),
      this.prisma.leadScore.count({
        where: {
          ...whereLeadScores(orgId),
          score: { gte: QUALIFIED_THRESHOLD },
          updatedAt: { gte: since },
        },
      }),
    ]);

    const costUsd = costUsdFromEvidenceEvents(draftEvents);
    const costPer = qualifiedLeads > 0 ? costUsd / qualifiedLeads : null;

    return {
      windowDays: window.windowDays,
      cost_usd: costUsd,
      qualified_leads: qualifiedLeads,
      cost_per_qualified_lead_usd: costPer,
    };
  }

  async guaranteeDefense(
    orgId: string,
    window: { readonly windowDays: number },
  ): Promise<GuaranteeDefenseKpi> {
    const since = windowSince(window.windowDays);

    const [rejected, reviewed] = await Promise.all([
      this.prisma.outreachArtifact.count({
        where: {
          orgId,
          reviewedAt: { gte: since },
          ...humanRejectedArtifactWhere(),
        },
      }),
      this.prisma.outreachArtifact.count({
        where: {
          orgId,
          reviewedAt: { gte: since },
          ...reviewedDecisionArtifactWhere(),
        },
      }),
    ]);

    const rate = reviewed > 0 ? rejected / reviewed : null;

    return {
      windowDays: window.windowDays,
      rejected_artifacts: rejected,
      reviewed_artifacts: reviewed,
      rejection_rate: rate,
    };
  }

}
