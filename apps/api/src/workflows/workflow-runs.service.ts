import {
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import {
  Prisma,
  WorkflowRun,
  WorkflowRunStatus,
} from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { GraphService } from "../graph/graph.service";
import { WorkflowTemplatesService } from "./workflow-templates.service";

export interface StartWorkflowInput {
  readonly orgId: string;
  readonly slug: string;
  readonly input: Record<string, unknown>;
  readonly startedBy?: string;
}

@Injectable()
export class WorkflowRunsService {
  private readonly logger = new Logger(WorkflowRunsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly templates: WorkflowTemplatesService,
    private readonly graphs: GraphService,
  ) {}

  /**
   * Resolve the template by slug, validate input, kick off the underlying
   * GraphRun, and persist the WorkflowRun row tying the two together. The
   * GraphRun handles its own AWAITING_APPROVAL / COMPLETED state; we mirror
   * those transitions onto the WorkflowRun via `syncStatusFromGraph`.
   */
  async start(input: StartWorkflowInput): Promise<WorkflowRun> {
    const template = await this.templates.getBySlug(input.slug);
    const resolvedInput = this.templates.resolveInput(template, input.input);

    // For Phase 2.5 every active template targets pipeline-supervisor and
    // requires icpProfileIds. Branch here when a new graph is introduced.
    const icpProfileIds = resolvedInput.icpProfileIds;
    if (!Array.isArray(icpProfileIds) || icpProfileIds.length === 0) {
      // resolveInput already enforced presence + type — defensive guard.
      throw new NotFoundException(
        `Template ${template.slug} resolved to empty icpProfileIds`,
      );
    }

    const { runId: graphRunId } = await this.graphs.runPipelineGraph(
      input.orgId,
      icpProfileIds as string[],
    );

    return this.prisma.workflowRun.create({
      data: {
        orgId: input.orgId,
        templateId: template.id,
        graphRunId,
        input: resolvedInput as unknown as Prisma.InputJsonValue,
        status: WorkflowRunStatus.RUNNING,
        startedBy: input.startedBy ?? null,
      },
    });
  }

  async get(orgId: string, id: string): Promise<WorkflowRun> {
    const run = await this.prisma.workflowRun.findUnique({ where: { id } });
    if (!run || run.orgId !== orgId) {
      throw new NotFoundException(`WorkflowRun ${id} not found`);
    }
    return run;
  }

  async list(orgId: string, opts: { status?: WorkflowRunStatus; limit?: number } = {}) {
    return this.prisma.workflowRun.findMany({
      where: {
        orgId,
        ...(opts.status ? { status: opts.status } : {}),
      },
      orderBy: { startedAt: "desc" },
      take: opts.limit ?? 50,
    });
  }

  /**
   * Re-read the underlying GraphRun and project its status onto the
   * WorkflowRun. Idempotent — callers can poll without mutating state.
   * Returns the (possibly updated) WorkflowRun.
   */
  async syncStatusFromGraph(orgId: string, id: string): Promise<WorkflowRun> {
    const run = await this.get(orgId, id);
    if (!run.graphRunId) return run;

    const graphRun = await this.prisma.graphRun.findFirst({
      where: { id: run.graphRunId, orgId },
    });
    if (!graphRun) return run;

    const next = mapGraphStatusToWorkflow(graphRun.status);
    const reachedTerminal =
      next === WorkflowRunStatus.COMPLETED || next === WorkflowRunStatus.FAILED;

    if (run.status === next && !reachedTerminal) return run;

    return this.prisma.workflowRun.update({
      where: { id: run.id },
      data: {
        status: next,
        output: reachedTerminal
          ? ((graphRun.state ?? Prisma.JsonNull) as Prisma.InputJsonValue)
          : undefined,
        error: graphRun.error ?? undefined,
        completedAt: reachedTerminal ? graphRun.completedAt ?? new Date() : undefined,
      },
    });
  }
}

/**
 * GraphRun.status is a string column populated by GraphService; map it to
 * the WorkflowRunStatus enum. Unknown values default to RUNNING so we don't
 * accidentally mark a live run terminal because of a typo elsewhere.
 */
function mapGraphStatusToWorkflow(status: string): WorkflowRunStatus {
  switch (status) {
    case "RUNNING":
      return WorkflowRunStatus.RUNNING;
    case "AWAITING_APPROVAL":
      return WorkflowRunStatus.AWAITING_APPROVAL;
    case "COMPLETED":
      return WorkflowRunStatus.COMPLETED;
    case "FAILED":
      return WorkflowRunStatus.FAILED;
    case "CANCELLED":
      return WorkflowRunStatus.CANCELLED;
    default:
      return WorkflowRunStatus.RUNNING;
  }
}
