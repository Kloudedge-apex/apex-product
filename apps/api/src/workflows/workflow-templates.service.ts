import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { Prisma, WorkflowTemplate } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

/**
 * Shape of the `config` JSON column. Stored as Prisma.JsonValue at rest but
 * validated to this surface before any consumer reads it, so callers can
 * trust the field types without re-parsing.
 */
export interface WorkflowTemplateConfig {
  /** Names of inputs the caller must supply when starting a run. */
  readonly inputs: ReadonlyArray<{
    readonly name: string;
    readonly type: "string" | "string[]" | "number" | "boolean";
    readonly required: boolean;
  }>;
  /**
   * Default values merged over caller-supplied input. Keep narrow — anything
   * here lands in the WorkflowRun.input column verbatim.
   */
  readonly defaults?: Readonly<Record<string, unknown>>;
  /** Free-form notes for future maintainers. Not surfaced to clients. */
  readonly notes?: string;
}

export interface UpsertWorkflowTemplateInput {
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly version: number;
  readonly graphName: string;
  readonly config: WorkflowTemplateConfig;
  readonly requiresApproval: boolean;
  readonly isActive?: boolean;
}

@Injectable()
export class WorkflowTemplatesService {
  private readonly logger = new Logger(WorkflowTemplatesService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Upsert by slug. Used by the tenant-zero seed and any future seeds. */
  async upsert(input: UpsertWorkflowTemplateInput): Promise<WorkflowTemplate> {
    const data = {
      name: input.name,
      description: input.description,
      version: input.version,
      graphName: input.graphName,
      config: input.config as unknown as Prisma.InputJsonValue,
      requiresApproval: input.requiresApproval,
      isActive: input.isActive ?? true,
    };
    return this.prisma.workflowTemplate.upsert({
      where: { slug: input.slug },
      create: { ...data, slug: input.slug },
      update: data,
    });
  }

  async listActive(): Promise<WorkflowTemplate[]> {
    return this.prisma.workflowTemplate.findMany({
      where: { isActive: true },
      orderBy: { slug: "asc" },
    });
  }

  async getBySlug(slug: string): Promise<WorkflowTemplate> {
    const template = await this.prisma.workflowTemplate.findUnique({
      where: { slug },
    });
    if (!template) {
      throw new NotFoundException(`WorkflowTemplate not found: ${slug}`);
    }
    if (!template.isActive) {
      throw new BadRequestException(`WorkflowTemplate ${slug} is inactive`);
    }
    return template;
  }

  /**
   * Validate caller-supplied inputs against the template's declared schema
   * and merge defaults. Throws BadRequestException on the first mismatch so
   * the controller doesn't need a separate validator.
   */
  resolveInput(
    template: WorkflowTemplate,
    rawInput: Record<string, unknown>,
  ): Record<string, unknown> {
    const config = parseConfig(template);
    const merged: Record<string, unknown> = {
      ...(config.defaults ?? {}),
      ...rawInput,
    };
    for (const decl of config.inputs) {
      const value = merged[decl.name];
      if (value === undefined || value === null) {
        if (decl.required) {
          throw new BadRequestException(
            `Missing required input '${decl.name}' for template ${template.slug}`,
          );
        }
        continue;
      }
      if (!matchesType(value, decl.type)) {
        throw new BadRequestException(
          `Input '${decl.name}' expected ${decl.type}, got ${typeof value}`,
        );
      }
    }
    return merged;
  }
}

function parseConfig(template: WorkflowTemplate): WorkflowTemplateConfig {
  const raw = template.config as unknown;
  if (raw === null || typeof raw !== "object") {
    throw new BadRequestException(
      `WorkflowTemplate ${template.slug} has invalid config`,
    );
  }
  const config = raw as Partial<WorkflowTemplateConfig>;
  if (!Array.isArray(config.inputs)) {
    throw new BadRequestException(
      `WorkflowTemplate ${template.slug} config.inputs must be an array`,
    );
  }
  return {
    inputs: config.inputs,
    defaults: config.defaults,
    notes: config.notes,
  };
}

function matchesType(
  value: unknown,
  type: WorkflowTemplateConfig["inputs"][number]["type"],
): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "string[]":
      return Array.isArray(value) && value.every((v) => typeof v === "string");
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
  }
}
