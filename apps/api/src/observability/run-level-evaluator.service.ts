import { Inject, Injectable, Logger } from "@nestjs/common";
import { GraphRunStatus } from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { QUALIFIED_THRESHOLD } from "../common/qualification.constants";
import { LangSmithService } from "./langsmith.service";
import { EVIDENCE_EVENT_KIND } from "./evidence-event.types";
import {
  approvedOutcomeArtifactWhere,
  failedArtifactWhere,
  humanRejectedArtifactWhere,
} from "../outreach/outreach-artifact-failure";

/**
 * Minimal Prisma surface this service depends on. Lets specs hand-roll a fake
 * client without dragging in the full PrismaService.
 */
export interface RunLevelEvaluatorPrisma {
  readonly graphRun: {
    findUnique(args: Prisma.GraphRunFindUniqueArgs): Promise<{
      readonly id: string;
      readonly orgId: string;
      readonly status: GraphRunStatus;
      readonly startedAt: Date;
      readonly completedAt: Date | null;
      readonly langsmithRootRunId: string | null;
    } | null>;
    update(args: Prisma.GraphRunUpdateArgs): Promise<unknown>;
  };
  readonly leadScore: {
    count(args: Prisma.LeadScoreCountArgs): Promise<number>;
  };
  readonly evidenceEvent: {
    count(args: Prisma.EvidenceEventCountArgs): Promise<number>;
  };
  readonly outreachArtifact: {
    count(args: Prisma.OutreachArtifactCountArgs): Promise<number>;
  };
}

export interface RunLevelSubScores {
  readonly pipeline_completed: number;
  readonly qualified_leads_produced: number;
  readonly messages_reached_send: number;
  readonly approval_drop_off_rate: number;
}

export interface RunLevelScore {
  readonly graphRunId: string;
  readonly orgId: string;
  readonly status: GraphRunStatus;
  readonly subScores: RunLevelSubScores;
  readonly composite_score: number;
  readonly verdict: "pass" | "partial" | "fail";
  readonly breakdown: string;
  /** Raw counts for traceability — useful for tests and downstream KPIs. */
  readonly counts: {
    readonly qualified_leads: number;
    readonly messages_sent: number;
    readonly approved_artifacts: number;
    readonly rejected_artifacts: number;
    readonly failed_artifacts: number;
    readonly total_artifacts: number;
  };
}

const QUALIFIED_TARGET = 5;
const PASS_THRESHOLD = 0.75;
const PARTIAL_THRESHOLD = 0.4;

/**
 * Run-level (i.e. per-pipeline-execution) evaluator. Unlike the per-LLM-call
 * evaluators wired through EvaluatorRunnerService, this one fires exactly once
 * per terminal GraphRun and produces a single composite "did this run produce
 * business value?" score, then posts that to LangSmith as feedback on the
 * GraphRun's root trace.
 *
 * The root LangSmith trace id is captured opportunistically via
 * `recordLangSmithRunId(graphRunId, runId)` — typically by whichever node
 * makes the first traced LLM call. Older runs (and environments without
 * LANGSMITH_API_KEY) silently skip the feedback post but the evaluation still
 * runs and its result is available to callers.
 *
 * Persistence: the LangSmith root run id is written through to
 * `GraphRun.langsmithRootRunId` so a graph that crashes and resumes on a
 * fresh pod can still post run-level feedback for its earlier legs. We keep
 * an in-memory Map as a write-through cache to skip the DB read on the
 * common same-pod path; on a cache miss we fall back to the row's column.
 */
@Injectable()
export class RunLevelEvaluatorService {
  private readonly logger = new Logger(RunLevelEvaluatorService.name);
  private readonly langsmithRunIds = new Map<string, string>();

  constructor(
    @Inject(PrismaService) private readonly prisma: RunLevelEvaluatorPrisma,
    private readonly langsmith: LangSmithService,
  ) {}

  /**
   * Capture the LangSmith root run id for a GraphRun. Called by the graph
   * runtime when the first traced LLM call returns its run id. The DB write
   * remains best-effort so a transient DB hiccup never breaks tracing, but is
   * awaited so its writer lease cannot be released while the write is live.
   */
  async recordLangSmithRunId(graphRunId: string, runId: string): Promise<void> {
    if (!graphRunId || !runId) return;
    this.langsmithRunIds.set(graphRunId, runId);
    await this.prisma.graphRun
      .update({
        where: { id: graphRunId },
        data: { langsmithRootRunId: runId },
      })
      .catch((err) => {
        this.logger.warn(
          `failed to persist langsmithRootRunId for graphRun=${graphRunId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
  }

  /** Read-back, mostly for tests. Returns only the in-memory cache. */
  getLangSmithRunId(graphRunId: string): string | undefined {
    return this.langsmithRunIds.get(graphRunId);
  }

  /**
   * Compute the four sub-scores + composite for a GraphRun. Never throws —
   * a missing GraphRun row returns a zeroed result so the caller can keep
   * its terminal-state path moving.
   */
  async evaluateGraphRun(graphRunId: string): Promise<RunLevelScore | null> {
    const run = await this.prisma.graphRun.findUnique({
      where: { id: graphRunId },
    });
    if (!run) {
      this.logger.warn(
        `evaluateGraphRun called for missing GraphRun ${graphRunId} — skipping`,
      );
      return null;
    }

    const since = run.startedAt;
    const until = run.completedAt ?? new Date();

    const [
      qualifiedLeads,
      messagesSent,
      approvedCount,
      rejectedCount,
      failedCount,
      totalArtifacts,
    ] = await Promise.all([
      this.prisma.leadScore.count({
        where: {
          orgId: run.orgId,
          score: { gte: QUALIFIED_THRESHOLD },
          updatedAt: { gte: since, lte: until },
        },
      }),
      this.prisma.evidenceEvent.count({
        where: {
          orgId: run.orgId,
          runId: graphRunId,
          kind: EVIDENCE_EVENT_KIND.messageSent,
        },
      }),
      this.prisma.outreachArtifact.count({
        where: {
          orgId: run.orgId,
          graphRunId,
          ...approvedOutcomeArtifactWhere(),
        },
      }),
      this.prisma.outreachArtifact.count({
        where: {
          orgId: run.orgId,
          graphRunId,
          ...humanRejectedArtifactWhere(),
        },
      }),
      this.prisma.outreachArtifact.count({
        where: {
          orgId: run.orgId,
          graphRunId,
          ...failedArtifactWhere(),
        },
      }),
      this.prisma.outreachArtifact.count({
        where: { orgId: run.orgId, graphRunId },
      }),
    ]);

    const pipeline_completed =
      run.status === GraphRunStatus.COMPLETED
        ? 1
        : run.status === GraphRunStatus.AWAITING_APPROVAL
          ? 0.5
          : 0;

    const qualified_leads_produced = Math.min(
      qualifiedLeads / QUALIFIED_TARGET,
      1,
    );

    // approvedCount includes every current state proving human approval,
    // including terminal FAILED and post-approval SUPPRESSED. The denominator
    // is max(approvedCount, 1) so
    // a run with zero approvals
    // doesn't divide-by-zero; the resulting 0/1 == 0 reflects the reality
    // that nothing reached send. We also clamp at 1 because in-loop tool
    // calls can produce sends without an artifact, which would otherwise
    // push this above 1.
    const messages_reached_send = Math.min(
      messagesSent / Math.max(approvedCount, 1),
      1,
    );

    const reviewedDecisions = approvedCount + rejectedCount;
    const approval_drop_off_rate =
      reviewedDecisions > 0 ? approvedCount / reviewedDecisions : 1;

    const subScores: RunLevelSubScores = {
      pipeline_completed,
      qualified_leads_produced,
      messages_reached_send,
      approval_drop_off_rate,
    };

    const composite_score =
      (subScores.pipeline_completed +
        subScores.qualified_leads_produced +
        subScores.messages_reached_send +
        subScores.approval_drop_off_rate) /
      4;

    const verdict: "pass" | "partial" | "fail" =
      composite_score >= PASS_THRESHOLD
        ? "pass"
        : composite_score >= PARTIAL_THRESHOLD
          ? "partial"
          : "fail";

    const breakdown =
      `status=${run.status} qualified=${qualifiedLeads}/${QUALIFIED_TARGET} ` +
      `sent=${messagesSent} approved=${approvedCount} rejected=${rejectedCount} ` +
      `failed=${failedCount}/${totalArtifacts} ` +
      `composite=${composite_score.toFixed(3)}`;

    const score: RunLevelScore = {
      graphRunId,
      orgId: run.orgId,
      status: run.status,
      subScores,
      composite_score,
      verdict,
      breakdown,
      counts: {
        qualified_leads: qualifiedLeads,
        messages_sent: messagesSent,
        approved_artifacts: approvedCount,
        rejected_artifacts: rejectedCount,
        failed_artifacts: failedCount,
        total_artifacts: totalArtifacts,
      },
    };

    await this.postFeedback(score, run.langsmithRootRunId);
    return score;
  }

  private async postFeedback(
    score: RunLevelScore,
    persistedRunId: string | null,
  ): Promise<void> {
    // Prefer the in-memory cache (same-pod hot path); fall back to the
    // persisted column when the pod that captured the id has since rolled.
    const runId =
      this.langsmithRunIds.get(score.graphRunId) ?? persistedRunId ?? undefined;
    if (!runId) {
      this.logger.log(
        `no langsmith root run for graphRun=${score.graphRunId} — skipping run-level feedback`,
      );
      return;
    }

    // Fire all feedback posts in parallel; LangSmithService.createFeedback
    // swallows its own errors so one failure can't take down the others.
    await Promise.all([
      this.langsmith.createFeedback({
        runId,
        key: "run_outcome_composite",
        score: score.composite_score,
        value: score.verdict,
        comment: score.breakdown,
      }),
      this.langsmith.createFeedback({
        runId,
        key: "run_completion",
        score: score.subScores.pipeline_completed,
        value: score.status,
      }),
      this.langsmith.createFeedback({
        runId,
        key: "run_qualified_leads",
        score: score.subScores.qualified_leads_produced,
        value: score.counts.qualified_leads,
      }),
      this.langsmith.createFeedback({
        runId,
        key: "run_send_rate",
        score: score.subScores.messages_reached_send,
        value: score.counts.messages_sent,
      }),
      this.langsmith.createFeedback({
        runId,
        key: "run_approval_drop_off",
        score: score.subScores.approval_drop_off_rate,
        value: score.counts.rejected_artifacts,
      }),
      this.langsmith.createFeedback({
        runId,
        key: "run_dispatch_failures",
        value: score.counts.failed_artifacts,
        comment: `failed=${score.counts.failed_artifacts} approved=${score.counts.approved_artifacts}`,
      }),
    ]);
  }
}
