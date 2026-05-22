import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
} from "@nestjs/common";
import { Command, isInterrupted } from "@langchain/langgraph";
import { PrismaService } from "../prisma/prisma.service";
import { LeadsService } from "../leads/leads.service";
import { RuntimeService } from "../runtime/runtime.service";
import { LLMService } from "../runtime/llm.service";
import { OutreachArtifactsService } from "../outreach/outreach-artifacts.service";
import { PrismaCheckpointSaver } from "./prisma-checkpointer";
import { buildPipelineGraph } from "./pipeline-graph";
import { NODE, PipelineState } from "./state";

const GRAPH_NAME = "pipeline-supervisor";

@Injectable()
export class GraphService {
  private readonly logger = new Logger(GraphService.name);
  private readonly checkpointer: PrismaCheckpointSaver;
  private readonly compiled: ReturnType<
    ReturnType<typeof buildPipelineGraph>["compile"]
  >;

  constructor(
    private readonly prisma: PrismaService,
    private readonly leads: LeadsService,
    private readonly runtime: RuntimeService,
    private readonly llm: LLMService,
    private readonly outreachArtifacts: OutreachArtifactsService,
  ) {
    this.checkpointer = new PrismaCheckpointSaver(prisma);
    this.compiled = buildPipelineGraph({
      leads: this.leads,
      prisma: this.prisma,
      runtime: this.runtime,
      llm: this.llm,
      outreachArtifacts: this.outreachArtifacts,
    }).compile({ checkpointer: this.checkpointer });
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

    // Fire-and-forget. Errors land in GraphRun.error / status=FAILED.
    void this.invokeUntilCheckpoint(run.id, {
      orgId,
      runId: run.id,
      icpProfileIds,
    }).catch((err) =>
      this.logger.error(
        `Graph run ${run.id} crashed: ${err instanceof Error ? err.message : err}`,
      ),
    );

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
      await this.prisma.graphRun.update({
        where: { id: runId },
        data: {
          status: "RUNNING",
          approvedAt: new Date(),
          approvedBy: decision.approvedBy ?? null,
          needsApproval: false,
        },
      });
    }

    void this.invokeUntilCheckpoint(
      runId,
      new Command({ resume: decision }),
    ).catch((err) =>
      this.logger.error(
        `Graph resume ${runId} crashed: ${err instanceof Error ? err.message : err}`,
      ),
    );

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

  // ── Internal ─────────────────────────────────────────────────────────────

  private async invokeUntilCheckpoint(
    runId: string,
    input: Partial<PipelineState> | Command,
  ): Promise<void> {
    const config = { configurable: { thread_id: runId } };

    try {
      const result = (await this.compiled.invoke(input as never, config)) as PipelineState & {
        __interrupt__?: unknown;
      };

      // Did the graph pause at an interrupt? Check checkpointer state.
      const snapshot = await this.compiled.getState(config);
      const pending = snapshot.tasks?.some((t) => t.interrupts?.length);

      if (pending || isInterrupted(result)) {
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
      throw err;
    }
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
