import { describe, it, expect, beforeEach, vi } from "vitest";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import type { WorkflowTemplate } from "@prisma/client";
import {
  WorkflowTemplatesService,
  type WorkflowTemplateConfig,
} from "../workflow-templates.service";
import { PrismaService } from "../../prisma/prisma.service";

function makeTemplate(overrides: Partial<WorkflowTemplate> = {}): WorkflowTemplate {
  const config: WorkflowTemplateConfig = {
    inputs: [
      { name: "icpProfileIds", type: "string[]", required: true },
      { name: "label", type: "string", required: false },
    ],
    defaults: { label: "default-label" },
  };
  return {
    id: "tpl_1",
    slug: "tenant_zero_sdr_outreach_artifact_v1",
    name: "Tenant Zero SDR",
    description: "Dry-run only",
    version: 1,
    graphName: "pipeline-supervisor",
    config: config as unknown as WorkflowTemplate["config"],
    requiresApproval: true,
    isActive: true,
    createdAt: new Date("2026-05-22T00:00:00Z"),
    updatedAt: new Date("2026-05-22T00:00:00Z"),
    ...overrides,
  };
}

function mockPrisma() {
  return {
    workflowTemplate: {
      upsert: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
  } as unknown as PrismaService;
}

describe("WorkflowTemplatesService", () => {
  let prisma: ReturnType<typeof mockPrisma>;
  let service: WorkflowTemplatesService;

  beforeEach(() => {
    prisma = mockPrisma();
    service = new WorkflowTemplatesService(prisma as unknown as PrismaService);
  });

  describe("upsert", () => {
    it("creates or updates a template row by slug", async () => {
      const tpl = makeTemplate();
      (prisma.workflowTemplate.upsert as ReturnType<typeof vi.fn>).mockResolvedValue(tpl);

      const config: WorkflowTemplateConfig = {
        inputs: [{ name: "icpProfileIds", type: "string[]", required: true }],
      };
      const result = await service.upsert({
        slug: tpl.slug,
        name: tpl.name,
        description: tpl.description,
        version: tpl.version,
        graphName: tpl.graphName,
        config,
        requiresApproval: true,
      });

      expect(result).toBe(tpl);
      expect(prisma.workflowTemplate.upsert).toHaveBeenCalledWith({
        where: { slug: tpl.slug },
        create: expect.objectContaining({ slug: tpl.slug, requiresApproval: true }),
        update: expect.objectContaining({ requiresApproval: true }),
      });
    });
  });

  describe("getBySlug", () => {
    it("throws NotFound when slug missing", async () => {
      (prisma.workflowTemplate.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(service.getBySlug("missing")).rejects.toBeInstanceOf(NotFoundException);
    });

    it("throws BadRequest when template is inactive", async () => {
      (prisma.workflowTemplate.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeTemplate({ isActive: false }),
      );
      await expect(service.getBySlug("tenant_zero_sdr_outreach_artifact_v1")).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it("returns the row for an active template", async () => {
      const tpl = makeTemplate();
      (prisma.workflowTemplate.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(tpl);
      await expect(service.getBySlug(tpl.slug)).resolves.toBe(tpl);
    });
  });

  describe("resolveInput", () => {
    it("merges defaults under caller input", () => {
      const tpl = makeTemplate();
      const resolved = service.resolveInput(tpl, { icpProfileIds: ["a", "b"] });
      expect(resolved).toEqual({ label: "default-label", icpProfileIds: ["a", "b"] });
    });

    it("lets caller input override defaults", () => {
      const tpl = makeTemplate();
      const resolved = service.resolveInput(tpl, {
        icpProfileIds: ["a"],
        label: "custom",
      });
      expect(resolved.label).toBe("custom");
    });

    it("throws when a required input is missing", () => {
      const tpl = makeTemplate();
      expect(() => service.resolveInput(tpl, {})).toThrowError(BadRequestException);
    });

    it("throws when input type mismatches", () => {
      const tpl = makeTemplate();
      expect(() =>
        service.resolveInput(tpl, { icpProfileIds: "not-an-array" }),
      ).toThrowError(BadRequestException);
    });

    it("rejects string arrays with non-string elements", () => {
      const tpl = makeTemplate();
      expect(() =>
        service.resolveInput(tpl, { icpProfileIds: ["ok", 5] }),
      ).toThrowError(BadRequestException);
    });

    it("ignores absent optional inputs", () => {
      const tpl = makeTemplate({
        config: {
          inputs: [{ name: "icpProfileIds", type: "string[]", required: true }],
        } as unknown as WorkflowTemplate["config"],
      });
      const resolved = service.resolveInput(tpl, { icpProfileIds: ["a"] });
      expect(resolved).toEqual({ icpProfileIds: ["a"] });
    });

    it("throws BadRequest when config is missing inputs array", () => {
      const tpl = makeTemplate({
        config: { defaults: {} } as unknown as WorkflowTemplate["config"],
      });
      expect(() => service.resolveInput(tpl, {})).toThrowError(BadRequestException);
    });
  });
});
