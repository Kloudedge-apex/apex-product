import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  Inject,
  forwardRef,
} from "@nestjs/common";
import { Command, isInterrupted } from "@langchain/langgraph";
import { randomUUID } from "node:crypto";
import { GraphRunStatus, Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { LeadsService } from "../leads/leads.service";
import { RuntimeService } from "../runtime/runtime.service";
import { LLMService } from "../runtime/llm.service";
import { OutreachArtifactsService } from "../outreach/outreach-artifacts.service";
import { EvidenceLedgerService } from "../observability/evidence-ledger.service";
import { LangSmithService } from "../observability/langsmith.service";
import { RunLevelEvaluatorService } from "../observability/run-level-evaluator.service";
import { PrismaCheckpointSaver } from "./prisma-checkpointer";
import { buildPipelineGraph } from "./pipeline-graph";
import { SignalExtractionService } from "./nodes/research/signal-extraction.service";
import { WebSearchTool } from "../runtime/tools/web-search.tool";
import { NODE, PipelineState } from "./state";
import { GraphRunQueueService } from "./graph-run-queue.service";

const GRAPH_NAME = "pipeline-supervisor";

@Injectable()
export class GraphService {
  private readonly logger = new Logger(GraphService.name);
  private readonly checkpointer: PrismaCheckpointSaver;
  // Constructed once — stateless, keyed off process.env, no per-run state. Was
  // previously rebuilt on every processGraphRun call (cheap, but needless).
  private readonly signalExtraction = new SignalExtractionService(new WebSearchTool());

  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => LeadsService))
    private readonly leads: LeadsService,
    private readonly runtime: RuntimeService,
    private readonly llm: LLMService,
    private readonly outreachArtifacts: OutreachArtifactsService,
    private readonly evidenceLedger: EvidenceLedgerService,
    private readonly graphRunQueue: GraphRunQueueService,
    private readonly runLevelEvaluator: RunLevelEvaluatorService,
    private readonly langsmith: LangSmithService,
  ) {
    this.checkpointer = new PrismaCheckpointSaver(prisma);
  }

  /**
   * Kick off a new pipeline graph run for an org. Returns the runId
   * immediately; the graph executes in the background until completion or
   * the HITL interrupt.
   */
  async runPipelineGraph(
    orgId: string,
    icpProfileIds: string[],
  ): Promise<{ runId: string; threadId: string }> {
    const canonicalIcpProfileIds = [
      ...new Set(icpProfileIds.map((id) => id.trim()).filter(Boolean)),
    ];
    if (canonicalIcpProfileIds.length === 0) {
      throw new ConflictException("No ICP profiles provided to graph run");
    }

    let run: { id: string; dispatchGeneration: number };
    try {
      run = await this.prisma.$transaction(async (tx) => {
        // The advisory lock closes the find-then-create race across API pods.
        // The review-only migration also adds a partial unique index as a
        // durable backstop for mixed-version deploys and future callers.
        await tx.$queryRaw`
          SELECT pg_advisory_xact_lock(
            hashtextextended(${`graph-run-single-flight:${orgId}`}, 0::bigint)
          )
        `;

        // Treat every ICP id as a tenant-owned resource reference, not merely
        // an opaque graph input. Reject the whole start when even one id is
        // absent or belongs to another org; accepting the owned subset would
        // let a mixed request create downstream ScrapeJob rows whose org and
        // icpProfile relation disagree.
        const ownedIcpProfiles = await tx.icpProfile.findMany({
          where: {
            orgId,
            id: { in: canonicalIcpProfileIds },
          },
          select: { id: true },
        });
        const ownedIcpProfileIds = new Set(
          ownedIcpProfiles.map((profile) => profile.id),
        );
        if (
          canonicalIcpProfileIds.some(
            (profileId) => !ownedIcpProfileIds.has(profileId),
          )
        ) {
          // Keep missing and foreign ids indistinguishable to callers.
          throw new NotFoundException("One or more ICP profiles were not found");
        }

        const inflight = await tx.graphRun.findFirst({
          where: {
            orgId,
            status: {
              in: [
                GraphRunStatus.RUNNING,
                GraphRunStatus.AWAITING_APPROVAL,
              ],
            },
          },
          select: { id: true, status: true },
        });
        if (inflight) {
          throw new ConflictException(
            `A pipeline graph is already ${inflight.status.toLowerCase()} for this org (runId=${inflight.id})`,
          );
        }

        // Generate the id before insert so id and LangGraph threadId are
        // written together. There is never an observable threadId="" row.
        const runId = randomUUID();
        return tx.graphRun.create({
          data: {
            id: runId,
            orgId,
            threadId: runId,
            graphName: GRAPH_NAME,
            status: GraphRunStatus.RUNNING,
            currentNode: NODE.SUPERVISOR,
            startIcpProfileIds: canonicalIcpProfileIds,
            dispatchGeneration: 0,
          },
          select: { id: true, dispatchGeneration: true },
        });
      });
    } catch (err) {
      // A partial-unique violation is possible during a mixed-version deploy
      // even though this version takes the advisory lock. Keep it a truthful
      // 409 instead of leaking a database error.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        const inflight = await this.prisma.graphRun.findFirst({
          where: {
            orgId,
            status: {
              in: [
                GraphRunStatus.RUNNING,
                GraphRunStatus.AWAITING_APPROVAL,
              ],
            },
          },
          select: { id: true, status: true },
        });
        throw new ConflictException(
          inflight
            ? `A pipeline graph is already ${inflight.status.toLowerCase()} for this org (runId=${inflight.id})`
            : "A pipeline graph is already active for this org",
        );
      }
      throw err;
    }

    // Persisted execution: hand off to the graph-runs queue so the worker
    // pod owns the run. Pod restart mid-flight no longer abandons the run —
    // the boot-time crash-recovery sweep re-enqueues orphans, and BullMQ /
    // PrismaCheckpointSaver between them guarantee resumption from the last
    // checkpoint. HTTP response semantics are unchanged: this returns the
    // runId immediately and execution happens out-of-band.
    await this.enqueueDispatchOrLeaveForRecovery({
      graphRunId: run.id,
      orgId,
      dispatchGeneration: run.dispatchGeneration,
    });

    return { runId: run.id, threadId: run.id };
  }

  /**
   * Resume a graph that's paused at the human_approval interrupt with the
   * user's approve/reject decision.
   */
  async resumePipelineGraph(
    runId: string,
    orgId: string,
    decision: { approved: boolean; approvedBy?: string },
  ): Promise<{ status: string }> {
    // Transition to RUNNING for BOTH approve and reject paths so the worker
    // (which short-circuits when status !== RUNNING) actually dequeues and
    // drives the graph to END. Audit P0 #6: previously the reject branch
    // skipped the status update, leaving runs stuck in AWAITING_APPROVAL
    // forever and silently dropping the user's reject decision.
    //
    // Refresh the mutable activity clock so the boot-time orphan sweep does
    // not race a freshly resumed run. startedAt deliberately remains the
    // original run start time; overwriting it corrupted dates and duration.
    //
    // The status predicate is also the decision claim: only one concurrent
    // reviewer can transition this tenant-owned run out of AWAITING_APPROVAL.
    // Evidence and queue side effects happen only after that compare-and-swap
    // succeeds, so an approve/reject race cannot record or enqueue both choices.
    const resumedAt = new Date();
    const claim = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.graphRun.updateMany({
        where: {
          id: runId,
          orgId,
          status: GraphRunStatus.AWAITING_APPROVAL,
        },
        data: {
          status: GraphRunStatus.RUNNING,
          lastActivityAt: resumedAt,
          approvedAt: decision.approved ? resumedAt : null,
          approvedBy: decision.approved
            ? (decision.approvedBy ?? null)
            : null,
          needsApproval: false,
          pendingResumeApproved: decision.approved,
          pendingResumeApprovedBy: decision.approvedBy ?? null,
          dispatchGeneration: { increment: 1 },
        },
      });

      // Read inside the same transaction so the generation paired with the
      // winning CAS is the one used for the dispatch job id.
      const current = await tx.graphRun.findFirst({
        where: { id: runId, orgId },
        select: { status: true, dispatchGeneration: true },
      });
      return { won: claimed.count === 1, current };
    });

    if (!claim.current) {
      throw new NotFoundException(`Graph run not found: ${runId}`);
    }
    if (!claim.won) {
      throw new ConflictException(
        `Graph run is ${claim.current.status}, not AWAITING_APPROVAL`,
      );
    }

    if (decision.approved) {
      await this.evidenceLedger.approvalGranted({
        orgId,
        runId,
        approvedBy: decision.approvedBy,
      });
    } else {
      await this.evidenceLedger.approvalDenied({
        orgId,
        runId,
        deniedBy: decision.approvedBy,
      });
    }

    await this.enqueueDispatchOrLeaveForRecovery({
      graphRunId: runId,
      orgId,
      dispatchGeneration: claim.current.dispatchGeneration,
    });

    return { status: "resuming" };
  }

  /**
   * Queue publication is not the source of truth. If Redis rejects the add or
   * its acknowledgement is lost after accepting it, leave the durable RUNNING
   * row untouched. The recurrent orphan sweep will publish a newer fenced job
   * once the activity lease expires; an accepted job keeps that lease fresh.
   */
  private async enqueueDispatchOrLeaveForRecovery(input: {
    graphRunId: string;
    orgId: string;
    dispatchGeneration: number;
  }): Promise<void> {
    try {
      await this.graphRunQueue.enqueueGraphRun(input);
    } catch (err) {
      this.logger.error(
        `GraphRun ${input.graphRunId} dispatch ${input.dispatchGeneration} enqueue failed; durable recovery remains pending: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  async getGraphRun(orgId: string, runId: string) {
    const run = await this.prisma.graphRun.findFirst({
      where: { id: runId, orgId },
    });
    if (!run) throw new NotFoundException(`Graph run not found: ${runId}`);
    return run;
  }

  async listGraphRuns(
    orgId: string,
    pagination?: { page: number; limit: number; status?: GraphRunStatus },
  ) {
    const where = {
      orgId,
      ...(pagination?.status ? { status: pagination.status } : {}),
    };

    // Preserve the historical bare-array response for callers that have not
    // opted into pagination. The id tie-breaker makes equal timestamps stable.
    if (!pagination) {
      return this.prisma.graphRun.findMany({
        where,
        orderBy: [{ startedAt: "desc" }, { id: "desc" }],
        take: 20,
      });
    }

    const { page, limit } = pagination;
    const [items, total] = await this.prisma.$transaction([
      this.prisma.graphRun.findMany({
        where,
        orderBy: [{ startedAt: "desc" }, { id: "desc" }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.graphRun.count({ where }),
    ]);

    return {
      items,
      total,
      page,
      limit,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    };
  }

  // ── Worker-facing API ────────────────────────────────────────────────────

  /**
   * Drive the compiled LangGraph until it either completes or hits the next
   * checkpoint (typically the human_approval interrupt). Called by
   * GraphRunWorker after dequeuing a job — NOT by the HTTP controller path.
   *
   * Idempotency: the LangGraph thread_id is `runId`, and PrismaCheckpointSaver
   * persists every checkpoint, so re-invoking with the same runId picks up
   * from the last successful checkpoint. For a brand-new run the partial
   * PipelineState input seeds the entry state; for a resume the caller
   * supplies a Command({ resume }) and LangGraph hydrates from the saved
   * checkpoint. The worker is responsible for not re-invoking runs that are
   * already in a terminal status (see GraphRunWorker.processGraphRun).
   *
   * Audit P0 #12: per call we resolve the GraphRun's root LangSmith run id
   * (creating one on `start`, reusing the persisted one on `resume`), thread
   * it through the compiled graph's deps as `parentRunId`, and rebuild +
   * compile the graph for this invocation. Rebuild cost is trivial relative
   * to LLM latency (~1ms vs ~1s+) and is the cleanest way to inject the
   * parent into closures inside every node without leaking it through
   * `config.configurable` or per-node state.
   */
  async processGraphRun(
    runId: string,
    input: Partial<PipelineState> | Command,
    dispatchGeneration: number,
  ): Promise<void> {
    const config = { configurable: { thread_id: runId } };

    // Resolve the LangSmith root run id for this GraphRun. Resume reuses the
    // persisted id; start mints a fresh one and persists it.
    const parentRunId = await this.resolveParentRunId(
      runId,
      input,
      dispatchGeneration,
    );

    const compiled = buildPipelineGraph({
      leads: this.leads,
      prisma: this.prisma,
      runtime: this.runtime,
      llm: this.llm,
      outreachArtifacts: this.outreachArtifacts,
      evidenceLedger: this.evidenceLedger,
      signalExtraction: this.signalExtraction,
      runLevelEvaluator: this.runLevelEvaluator,
      parentRunId: parentRunId ?? undefined,
    }).compile({ checkpointer: this.checkpointer });

    try {
      const result = (await compiled.invoke(input as never, config)) as PipelineState & {
        __interrupt__?: unknown;
      };

      // Did the graph pause at an interrupt? Check checkpointer state.
      const snapshot = await compiled.getState(config);
      const pending = snapshot.tasks?.some((t) => t.interrupts?.length);

      if (pending || isInterrupted(result)) {
        const candidateCount = (result.scoredLeads ?? [])
          .filter((s) => s.tier === "A" || s.tier === "B")
          .slice(0, 10).length;
        const transition = await this.prisma.graphRun.updateMany({
          where: {
            id: runId,
            status: GraphRunStatus.RUNNING,
            dispatchGeneration,
          },
          data: {
            status: GraphRunStatus.AWAITING_APPROVAL,
            currentNode: NODE.APPROVAL,
            needsApproval: true,
            state: this.snapshotPublicState(result),
          },
        });
        if (transition.count !== 1) {
          this.logger.warn(
            `Graph ${runId} dispatch ${dispatchGeneration} was superseded before approval transition`,
          );
          return;
        }
        await this.evidenceLedger.approvalRequested({
          orgId: result.orgId,
          runId,
          candidateCount,
        });
        this.logger.log(`Graph ${runId} paused at human_approval`);
        return;
      }

      const failedStages = Object.entries(result.stageStatuses ?? {})
        .filter(([, status]) => status === "FAILED")
        .map(([stage]) => stage)
        .sort();
      if (failedStages.length > 0) {
        const failedOutreach = (result.outreachResults ?? []).filter(
          (outcome) => outcome.status === "failed",
        ).length;
        const error = `pipeline_failed:${failedStages.join(",")}${
          failedOutreach > 0 ? ` (outreach_failures=${failedOutreach})` : ""
        }`;
        const transition = await this.prisma.graphRun.updateMany({
          where: {
            id: runId,
            status: GraphRunStatus.RUNNING,
            dispatchGeneration,
          },
          data: {
            status: GraphRunStatus.FAILED,
            currentNode: null,
            completedAt: new Date(),
            error,
            state: this.snapshotPublicState(result),
          },
        });
        if (transition.count !== 1) {
          this.logger.warn(
            `Graph ${runId} dispatch ${dispatchGeneration} was superseded before failure transition`,
          );
          return;
        }
        this.logger.warn(`Graph ${runId} failed: ${error}`);
        await this.fireRunLevelEvaluator(runId);
        return;
      }

      // Graph ran to completion
      const transition = await this.prisma.graphRun.updateMany({
        where: {
          id: runId,
          status: GraphRunStatus.RUNNING,
          dispatchGeneration,
        },
        data: {
          status: GraphRunStatus.COMPLETED,
          currentNode: null,
          completedAt: new Date(),
          state: this.snapshotPublicState(result),
        },
      });
      if (transition.count !== 1) {
        this.logger.warn(
          `Graph ${runId} dispatch ${dispatchGeneration} was superseded before completion transition`,
        );
        return;
      }
      this.logger.log(`Graph ${runId} completed`);
      await this.fireRunLevelEvaluator(runId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const transition = await this.prisma.graphRun.updateMany({
        where: {
          id: runId,
          status: GraphRunStatus.RUNNING,
          dispatchGeneration,
        },
        data: {
          status: GraphRunStatus.FAILED,
          completedAt: new Date(),
          error: msg.slice(0, 1000),
        },
      });
      if (transition.count === 1) {
        await this.fireRunLevelEvaluator(runId);
      } else {
        this.logger.warn(
          `Graph ${runId} dispatch ${dispatchGeneration} failure was superseded; lifecycle row left unchanged`,
        );
      }
      throw err;
    }
  }

  /**
   * Resolve the LangSmith root run id for this invocation of a GraphRun.
   *
   *  - Resume (Command kind === "resume"): use the persisted column. If the
   *    row was created before this code shipped (legacy), mint a fresh root
   *    so post-HITL LLM calls still attach to *something* with parent
   *    semantics. This is best-effort — a null result is acceptable and
   *    downstream tracing falls back to top-level runs.
   *
   *  - Start (partial state): always mint a fresh root and persist it on
   *    the GraphRun row so subsequent resumes can find it.
   *
   * Never throws. LangSmith outage MUST NOT take down a GraphRun.
   */
  private async resolveParentRunId(
    runId: string,
    input: Partial<PipelineState> | Command,
    dispatchGeneration: number,
  ): Promise<string | null> {
    let row: { id: string; orgId: string; langsmithRootRunId: string | null } | null = null;
    try {
      row = await this.prisma.graphRun.findUnique({
        where: { id: runId },
        select: { id: true, orgId: true, langsmithRootRunId: true },
      });
    } catch (err) {
      this.logger.warn(
        `resolveParentRunId: graphRun lookup failed for ${runId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    const isResume = input instanceof Command;
    if (isResume && row?.langsmithRootRunId) {
      return row.langsmithRootRunId;
    }

    // Either a fresh start, or a resume of a legacy row with no persisted
    // root — mint a new one. `createRootRun` is fail-soft and returns null
    // on any SDK / network error.
    const orgId = row?.orgId ?? "";
    const created = await this.langsmith.createRootRun({
      name: "graph_run",
      inputs: { runId, orgId },
      tags: [
        `org:${orgId}`,
        `graphRunId:${runId}`,
        `graph:${GRAPH_NAME}`,
      ],
      metadata: {
        graphRunId: runId,
        orgId,
        kind: isResume ? "resume_legacy" : "start",
      },
      runType: "chain",
    });

    if (created) {
      try {
        await this.prisma.graphRun.updateMany({
          where: { id: runId, dispatchGeneration },
          data: { langsmithRootRunId: created },
        });
      } catch (err) {
        // Persistence is best-effort. A pod restart mid-run will simply mint
        // a second root rather than reattaching to the first — annoying but
        // not catastrophic.
        this.logger.warn(
          `resolveParentRunId: failed to persist langsmithRootRunId for ${runId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    return created;
  }

  /**
   * Best-effort run-level evaluator. Await settlement so a production writer
   * scope cannot release while LangSmith feedback is still mutating; failures
   * remain fail-soft and never change the durable GraphRun outcome.
   */
  private async fireRunLevelEvaluator(runId: string): Promise<void> {
    try {
      await this.runLevelEvaluator.evaluateGraphRun(runId);
    } catch {
      this.logger.warn(
        `Run-level evaluator failed for graphRun=${runId}`,
      );
    }
  }

  private snapshotPublicState(state: PipelineState): object {
    // Drop noisy fields; keep what the UI needs for the run dashboard.
    // Count generated drafts independently of their current lifecycle status.
    // A retry may find the same artifact after it was approved, rejected, sent,
    // or suppressed; those are no longer "queued", but the draft still exists.
    const outreachGenerated = new Set(
      (state.outreachResults ?? [])
        .map((outcome) => outcome.agentRunId)
        .filter((artifactId): artifactId is string => !!artifactId),
    ).size;
    const outreachFailures = (state.outreachResults ?? [])
      .filter((outcome) => outcome.status === "failed")
      .map((outcome) => ({
        personId: outcome.personId,
        error: outcome.error ?? "unknown",
      }));

    return {
      orgId: state.orgId,
      icpProfileIds: state.icpProfileIds,
      stagesCompleted: state.stagesCompleted,
      stageStatuses: state.stageStatuses ?? {},
      counts: {
        companies: state.sourcedCompanies?.length ?? 0,
        people: state.enrichedPeople?.length ?? 0,
        scored: state.scoredLeads?.length ?? 0,
        outreach: outreachGenerated,
        outreachFailed: outreachFailures.length,
      },
      outreachFailures,
      approved: state.approved,
      approvedBy: state.approvedBy,
      messages: (state.messages ?? []).slice(-50),
      errors: state.errors ?? [],
    };
  }
}
