import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  Inject,
  forwardRef,
} from "@nestjs/common";
import { Command, isInterrupted } from "@langchain/langgraph";
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
import { NODE, PipelineState } from "./state";
import { GraphRunQueueService } from "./graph-run-queue.service";

const GRAPH_NAME = "pipeline-supervisor";

@Injectable()
export class GraphService {
  private readonly logger = new Logger(GraphService.name);
  private readonly checkpointer: PrismaCheckpointSaver;

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
    if (icpProfileIds.length === 0) {
      throw new ConflictException("No ICP profiles provided to graph run");
    }

    // Reject if a graph is already in-flight for this org (mirrors the
    // ScrapeJob single-flight check in LeadsService.triggerDiscovery).
    const inflight = await this.prisma.graphRun.findFirst({
      where: {
        orgId,
        status: { in: ["RUNNING", "AWAITING_APPROVAL"] },
      },
    });
    if (inflight) {
      throw new ConflictException(
        `A pipeline graph is already ${inflight.status.toLowerCase()} for this org (runId=${inflight.id})`,
      );
    }

    const run = await this.prisma.graphRun.create({
      data: {
        orgId,
        threadId: "", // filled below — Prisma needs a default; we update with the row id
        graphName: GRAPH_NAME,
        status: "RUNNING",
        currentNode: NODE.SUPERVISOR,
      },
    });

    // Use the run id as the thread id — 1:1 mapping, easy to look up
    await this.prisma.graphRun.update({
      where: { id: run.id },
      data: { threadId: run.id },
    });

    // Persisted execution: hand off to the graph-runs queue so the worker
    // pod owns the run. Pod restart mid-flight no longer abandons the run —
    // the boot-time crash-recovery sweep re-enqueues orphans, and BullMQ /
    // PrismaCheckpointSaver between them guarantee resumption from the last
    // checkpoint. HTTP response semantics are unchanged: this returns the
    // runId immediately and execution happens out-of-band.
    await this.graphRunQueue.enqueueGraphRun({
      kind: "start",
      graphRunId: run.id,
      orgId,
      icpProfileIds,
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
    const run = await this.prisma.graphRun.findFirst({
      where: { id: runId, orgId },
    });
    if (!run) throw new NotFoundException(`Graph run not found: ${runId}`);
    if (run.status !== "AWAITING_APPROVAL") {
      throw new ConflictException(
        `Graph run is ${run.status}, not AWAITING_APPROVAL`,
      );
    }

    if (decision.approved) {
      void this.evidenceLedger.approvalGranted({
        orgId,
        runId,
        approvedBy: decision.approvedBy,
      });
    } else {
      void this.evidenceLedger.approvalDenied({
        orgId,
        runId,
        deniedBy: decision.approvedBy,
      });
    }

    // Transition to RUNNING for BOTH approve and reject paths so the worker
    // (which short-circuits when status !== RUNNING) actually dequeues and
    // drives the graph to END. Audit P0 #6: previously the reject branch
    // skipped the status update, leaving runs stuck in AWAITING_APPROVAL
    // forever and silently dropping the user's reject decision.
    //
    // Also refresh startedAt so the boot-time orphan sweep (which filters on
    // startedAt < now - BOOT_ORPHAN_AGE_MS) does NOT pick up a freshly-resumed
    // run and re-enqueue a duplicate start job mid-resume. Audit P0 #8.
    const resumeStartedAt = new Date();
    await this.prisma.graphRun.update({
      where: { id: runId },
      data: decision.approved
        ? {
            status: "RUNNING",
            startedAt: resumeStartedAt,
            approvedAt: resumeStartedAt,
            approvedBy: decision.approvedBy ?? null,
            needsApproval: false,
          }
        : {
            status: "RUNNING",
            startedAt: resumeStartedAt,
            needsApproval: false,
          },
    });

    await this.graphRunQueue.enqueueGraphRun({
      kind: "resume",
      graphRunId: runId,
      orgId,
      resume: decision,
    });

    return { status: "resuming" };
  }

  async getGraphRun(orgId: string, runId: string) {
    const run = await this.prisma.graphRun.findFirst({
      where: { id: runId, orgId },
    });
    if (!run) throw new NotFoundException(`Graph run not found: ${runId}`);
    return run;
  }

  async listGraphRuns(orgId: string, limit = 20) {
    return this.prisma.graphRun.findMany({
      where: { orgId },
      orderBy: { startedAt: "desc" },
      take: limit,
    });
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
  ): Promise<void> {
    const config = { configurable: { thread_id: runId } };

    // Resolve the LangSmith root run id for this GraphRun. Resume reuses the
    // persisted id; start mints a fresh one and persists it.
    const parentRunId = await this.resolveParentRunId(runId, input);

    const compiled = buildPipelineGraph({
      leads: this.leads,
      prisma: this.prisma,
      runtime: this.runtime,
      llm: this.llm,
      outreachArtifacts: this.outreachArtifacts,
      evidenceLedger: this.evidenceLedger,
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
        void this.evidenceLedger.approvalRequested({
          orgId: result.orgId,
          runId,
          candidateCount,
        });

        await this.prisma.graphRun.update({
          where: { id: runId },
          data: {
            status: "AWAITING_APPROVAL",
            currentNode: NODE.APPROVAL,
            needsApproval: true,
            state: this.snapshotPublicState(result),
          },
        });
        this.logger.log(`Graph ${runId} paused at human_approval`);
        return;
      }

      // Graph ran to completion
      await this.prisma.graphRun.update({
        where: { id: runId },
        data: {
          status: "COMPLETED",
          currentNode: null,
          completedAt: new Date(),
          state: this.snapshotPublicState(result),
        },
      });
      this.logger.log(`Graph ${runId} completed`);
      this.fireRunLevelEvaluator(runId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.prisma.graphRun.update({
        where: { id: runId },
        data: {
          status: "FAILED",
          completedAt: new Date(),
          error: msg.slice(0, 1000),
        },
      });
      this.fireRunLevelEvaluator(runId);
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
        await this.prisma.graphRun.update({
          where: { id: runId },
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
   * Fire-and-forget run-level evaluator. MUST NOT block the GraphRun's main
   * path — failures log a warning and otherwise vanish, mirroring the
   * per-LLM-call evaluator runner's contract.
   */
  private fireRunLevelEvaluator(runId: string): void {
    void this.runLevelEvaluator.evaluateGraphRun(runId).catch((err) => {
      this.logger.warn(
        `Run-level evaluator threw for graphRun=${runId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  }

  private snapshotPublicState(state: PipelineState): object {
    // Drop noisy fields; keep what the UI needs for the run dashboard.
    return {
      orgId: state.orgId,
      icpProfileIds: state.icpProfileIds,
      stagesCompleted: state.stagesCompleted,
      counts: {
        companies: state.sourcedCompanies?.length ?? 0,
        people: state.enrichedPeople?.length ?? 0,
        scored: state.scoredLeads?.length ?? 0,
        outreach: state.outreachResults?.length ?? 0,
      },
      approved: state.approved,
      approvedBy: state.approvedBy,
      messages: (state.messages ?? []).slice(-50),
      errors: state.errors ?? [],
    };
  }
}
