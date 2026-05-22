import { describe, it, expect, beforeEach, vi } from "vitest";
import { NotFoundException } from "@nestjs/common";
import {
  WorkflowRunStatus,
  type GraphRun,
  type WorkflowRun,
  type WorkflowTemplate,
} from "@prisma/client";
import { WorkflowRunsService } from "../workflow-runs.service";
import { WorkflowTemplatesService } from "../workflow-templates.service";
import { PrismaService } from "../../prisma/prisma.service";
import { GraphService } from "../../graph/graph.service";

const TEMPLATE: WorkflowTemplate = {
  id: "tpl_1",
  slug: "tenant_zero_sdr_outreach_artifact_v1",
  name: "Tenant Zero SDR",
  description: "",
  version: 1,
  graphName: "pipeline-supervisor",
  config: {
    inputs: [{ name: "icpProfileIds", type: "string[]", required: true }],
  } as unknown as WorkflowTemplate["config"],
  requiresApproval: true,
  isActive: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function runRow(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: "wfr_1",
    orgId: "org_1",
    templateId: TEMPLATE.id,
    graphRunId: "graph_1",
    input: { icpProfileIds: ["icp_1"] },
    status: WorkflowRunStatus.RUNNING,
    output: null,
    error: null,
    startedBy: "user_1",
    startedAt: new Date("2026-05-22T00:00:00Z"),
    completedAt: null,
    ...overrides,
  };
}

function graphRow(overrides: Partial<GraphRun> = {}): GraphRun {
  return {
    id: "graph_1",
    orgId: "org_1",
    threadId: "graph_1",
    graphName: "pipeline-supervisor",
    status: "RUNNING",
    currentNode: "supervisor",
    state: null,
    error: null,
    needsApproval: false,
    approvedBy: null,
    approvedAt: null,
    startedAt: new Date("2026-05-22T00:00:00Z"),
    completedAt: null,
    ...overrides,
  } as GraphRun;
}

function mockPrisma() {
  return {
    workflowRun: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    graphRun: {
      findFirst: vi.fn(),
    },
  } as unknown as PrismaService;
}

describe("WorkflowRunsService", () => {
  let prisma: ReturnType<typeof mockPrisma>;
  let templates: WorkflowTemplatesService;
  let graphs: GraphService;
  let service: WorkflowRunsService;

  beforeEach(() => {
    prisma = mockPrisma();
    templates = {
      getBySlug: vi.fn().mockResolvedValue(TEMPLATE),
      resolveInput: vi.fn().mockImplementation((_t, raw: Record<string, unknown>) => ({
        ...raw,
      })),
    } as unknown as WorkflowTemplatesService;
    graphs = {
      runPipelineGraph: vi
        .fn()
        .mockResolvedValue({ runId: "graph_1", threadId: "graph_1" }),
    } as unknown as GraphService;
    service = new WorkflowRunsService(
      prisma as unknown as PrismaService,
      templates,
      graphs,
    );
  });

  describe("start", () => {
    it("starts the graph and persists a RUNNING WorkflowRun", async () => {
      (prisma.workflowRun.create as ReturnType<typeof vi.fn>).mockResolvedValue(
        runRow(),
      );

      const run = await service.start({
        orgId: "org_1",
        slug: TEMPLATE.slug,
        input: { icpProfileIds: ["icp_1"] },
        startedBy: "user_1",
      });

      expect(graphs.runPipelineGraph).toHaveBeenCalledWith("org_1", ["icp_1"]);
      expect(prisma.workflowRun.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          orgId: "org_1",
          templateId: TEMPLATE.id,
          graphRunId: "graph_1",
          status: WorkflowRunStatus.RUNNING,
          startedBy: "user_1",
        }),
      });
      expect(run.status).toBe(WorkflowRunStatus.RUNNING);
    });

    it("rejects input that resolves to empty icpProfileIds", async () => {
      (templates.resolveInput as ReturnType<typeof vi.fn>).mockReturnValue({
        icpProfileIds: [],
      });
      await expect(
        service.start({
          orgId: "org_1",
          slug: TEMPLATE.slug,
          input: { icpProfileIds: [] },
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("get", () => {
    it("returns the row when found and owned by org", async () => {
      const row = runRow();
      (prisma.workflowRun.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(row);
      await expect(service.get("org_1", row.id)).resolves.toEqual(row);
    });

    it("throws NotFound when row missing", async () => {
      (prisma.workflowRun.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(service.get("org_1", "wfr_x")).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it("throws NotFound when row belongs to a different org", async () => {
      (prisma.workflowRun.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
        runRow({ orgId: "org_other" }),
      );
      await expect(service.get("org_1", "wfr_1")).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe("syncStatusFromGraph", () => {
    it("promotes RUNNING → AWAITING_APPROVAL when graph is paused", async () => {
      const row = runRow({ status: WorkflowRunStatus.RUNNING });
      (prisma.workflowRun.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(row);
      (prisma.graphRun.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
        graphRow({ status: "AWAITING_APPROVAL" }),
      );
      (prisma.workflowRun.update as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...row,
        status: WorkflowRunStatus.AWAITING_APPROVAL,
      });

      const result = await service.syncStatusFromGraph("org_1", row.id);
      expect(result.status).toBe(WorkflowRunStatus.AWAITING_APPROVAL);
      expect(prisma.workflowRun.update).toHaveBeenCalled();
    });

    it("captures output and completedAt when graph is COMPLETED", async () => {
      const row = runRow({ status: WorkflowRunStatus.AWAITING_APPROVAL });
      (prisma.workflowRun.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(row);
      const completedAt = new Date("2026-05-22T01:00:00Z");
      (prisma.graphRun.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
        graphRow({ status: "COMPLETED", state: { stagesCompleted: ["outreach"] }, completedAt }),
      );
      (prisma.workflowRun.update as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...row,
        status: WorkflowRunStatus.COMPLETED,
        output: { stagesCompleted: ["outreach"] },
        completedAt,
      });

      await service.syncStatusFromGraph("org_1", row.id);
      const updateArg = (prisma.workflowRun.update as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
      expect(updateArg.data.status).toBe(WorkflowRunStatus.COMPLETED);
      expect(updateArg.data.completedAt).toBe(completedAt);
      expect(updateArg.data.output).toEqual({ stagesCompleted: ["outreach"] });
    });

    it("is idempotent — no update when graph and workflow already RUNNING", async () => {
      const row = runRow({ status: WorkflowRunStatus.RUNNING });
      (prisma.workflowRun.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(row);
      (prisma.graphRun.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
        graphRow({ status: "RUNNING" }),
      );

      const result = await service.syncStatusFromGraph("org_1", row.id);
      expect(result).toBe(row);
      expect(prisma.workflowRun.update).not.toHaveBeenCalled();
    });

    it("returns the row untouched when no graphRunId attached", async () => {
      const row = runRow({ graphRunId: null });
      (prisma.workflowRun.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(row);
      const result = await service.syncStatusFromGraph("org_1", row.id);
      expect(result).toBe(row);
      expect(prisma.graphRun.findFirst).not.toHaveBeenCalled();
    });

    it("maps FAILED graph status and stores error", async () => {
      const row = runRow({ status: WorkflowRunStatus.RUNNING });
      (prisma.workflowRun.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(row);
      (prisma.graphRun.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
        graphRow({ status: "FAILED", error: "boom" }),
      );
      (prisma.workflowRun.update as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...row,
        status: WorkflowRunStatus.FAILED,
        error: "boom",
      });

      await service.syncStatusFromGraph("org_1", row.id);
      const updateArg = (prisma.workflowRun.update as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
      expect(updateArg.data.status).toBe(WorkflowRunStatus.FAILED);
      expect(updateArg.data.error).toBe("boom");
    });
  });
});
