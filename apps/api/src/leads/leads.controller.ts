import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  Res,
  HttpCode,
  HttpStatus,
  BadRequestException,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { OrgId } from "../common/org-context.decorator";
import { AdminOrManagerGuard } from "../common/admin-or-manager.guard";
import { LeadsService } from "./leads.service";
import type { Seniority, Department } from "@prisma/client";
import { normalizeIcpDomain } from "./icp-domain-exclusions";

type LeadsUiStage =
  | "sourced"
  | "enriched"
  | "qualified"
  | "in_crm"
  | "contacted"
  | "replied"
  | "meeting";

const LEAD_UI_STAGES: ReadonlySet<LeadsUiStage> = new Set([
  "sourced",
  "enriched",
  "qualified",
  "in_crm",
  "contacted",
  "replied",
  "meeting",
]);

interface IcpProfileBody {
  name: string;
  targetTitles?: string[];
  targetIndustries?: string[];
  targetGeos?: string[];
  minEmployees?: number | null;
  maxEmployees?: number | null;
  techStackSignals?: string[];
  intentKeywords?: string[];
  seedDomains?: string[];
  exclusionDomains?: string[];
}

@Controller("leads")
export class LeadsController {
  constructor(private readonly leads: LeadsService) {}

  // ─── Unified UI list ─────────────────────────────────

  @Get()
  listLeads(
    @OrgId() orgId: string | undefined,
    @Query("stage") stage?: string,
    @Query("min_score") minScore?: string,
    @Query("page") page?: string,
    @Query("per_page") perPage?: string,
    @Query("search") search?: string,
  ) {
    if (!orgId) throw new BadRequestException("orgId required");
    const stageNarrow: LeadsUiStage | undefined =
      stage && LEAD_UI_STAGES.has(stage as LeadsUiStage) ? (stage as LeadsUiStage) : undefined;
    return this.leads.listLeadsForUi(orgId, {
      stage: stageNarrow,
      minScore: minScore ? Math.max(0, parseInt(minScore, 10)) : undefined,
      page: Math.max(1, parseInt(page ?? "1", 10)),
      perPage: Math.min(100, Math.max(1, parseInt(perPage ?? "50", 10))),
      search: search?.trim() || undefined,
    });
  }

  // ─── ICP ─────────────────────────────────────────────

  @Post("icp")
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(AdminOrManagerGuard)
  createIcp(
    @OrgId() orgId: string | undefined,
    @Body()
    body: IcpProfileBody,
  ) {
    if (!orgId) throw new BadRequestException("orgId required");
    return this.leads.createIcpProfile(orgId, normalizeIcpProfileBody(body));
  }

  /**
   * Guided setup owns one current ICP. This endpoint updates the newest row
   * in place, or creates it once for a clean tenant, under an org-scoped lock.
   */
  @Patch("icp/current")
  @UseGuards(AdminOrManagerGuard)
  upsertCurrentIcp(
    @OrgId() orgId: string | undefined,
    @Body() body: IcpProfileBody,
  ) {
    if (!orgId) throw new BadRequestException("orgId required");
    return this.leads.upsertCurrentIcpProfile(
      orgId,
      normalizeIcpProfileBody(body, true),
    );
  }

  @Get("icp")
  listIcpProfiles(@OrgId() orgId: string | undefined) {
    if (!orgId) throw new BadRequestException("orgId required");
    return this.leads.listIcpProfiles(orgId);
  }

  // ─── Companies ───────────────────────────────────────

  @Get("companies")
  listCompanies(
    @OrgId() orgId: string | undefined,
    @Query("page") page?: string,
    @Query("limit") limit?: string,
    @Query("industry") industry?: string,
    @Query("country") country?: string,
  ) {
    if (!orgId) throw new BadRequestException("orgId required");
    return this.leads.listCompanies(orgId, {
      page: parseInt(page || "1", 10),
      limit: Math.min(parseInt(limit || "20", 10), 100),
      industry,
      country,
    });
  }

  @Get("companies/:companyId/people")
  listCompanyPeople(
    @OrgId() orgId: string | undefined,
    @Param("companyId") companyId: string,
  ) {
    if (!orgId) throw new BadRequestException("orgId required");
    return this.leads.listCompanyPeople(orgId, companyId);
  }

  // ─── People ──────────────────────────────────────────

  @Get("people")
  listPeople(
    @OrgId() orgId: string | undefined,
    @Query("page") page?: string,
    @Query("limit") limit?: string,
    @Query("seniority") seniority?: Seniority,
    @Query("department") department?: Department,
    @Query("minScore") minScore?: string,
  ) {
    if (!orgId) throw new BadRequestException("orgId required");
    return this.leads.listPeople(orgId, {
      page: parseInt(page || "1", 10),
      limit: Math.min(parseInt(limit || "20", 10), 100),
      seniority,
      department,
      minScore: minScore ? parseInt(minScore, 10) : undefined,
    });
  }

  @Get('export/csv')
  async exportCsv(
    @OrgId() orgId: string | undefined,
    @Res() res: Response,
  ) {
    if (!orgId) throw new BadRequestException('orgId required');
    const csv = await this.leads.exportCsv(orgId);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=leads.csv');
    res.send(csv);
  }

  @Get("people/:id")
  getPersonDetail(
    @OrgId() orgId: string | undefined,
    @Param("id") id: string,
  ) {
    if (!orgId) throw new BadRequestException("orgId required");
    return this.leads.getPersonDetail(orgId, id);
  }

  // ─── Jobs ────────────────────────────────────────────

  @Get("jobs")
  listJobs(@OrgId() orgId: string | undefined) {
    if (!orgId) throw new BadRequestException("orgId required");
    return this.leads.listJobs(orgId);
  }

  @Get("jobs/:id")
  getJob(
    @OrgId() orgId: string | undefined,
    @Param("id") id: string,
  ) {
    if (!orgId) throw new BadRequestException("orgId required");
    return this.leads.getJob(orgId, id);
  }

  // ─── Stats ───────────────────────────────────────────

  @Get("stats")
  getStats(@OrgId() orgId: string | undefined) {
    if (!orgId) throw new BadRequestException("orgId required");
    return this.leads.getStats(orgId);
  }
}

function normalizeIcpProfileBody(body: IcpProfileBody, preserveOmitted = false) {
  if (!body.name || typeof body.name !== "string" || body.name.length > 200) {
    throw new BadRequestException("name is required (max 200 chars)");
  }
  const cap = (arr: string[] | undefined, max: number, field: string) => {
    if (arr === undefined) return preserveOmitted ? undefined : [];
    if (!Array.isArray(arr) || arr.some((item) => typeof item !== "string")) {
      throw new BadRequestException(`${field} must be an array of strings`);
    }
    return arr.slice(0, max).map((s) => s.trim().slice(0, 200)).filter(Boolean);
  };
  const bound = (value: number | null | undefined, field: string) => {
    if (value === undefined) return undefined;
    if (value === null) return null;
    if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000) {
      throw new BadRequestException(`${field} must be an integer from 0 to 1000000 or null`);
    }
    return value;
  };
  const minEmployees = bound(body.minEmployees, "minEmployees");
  const maxEmployees = bound(body.maxEmployees, "maxEmployees");
  if (typeof minEmployees === "number" && typeof maxEmployees === "number" && minEmployees > maxEmployees) {
    throw new BadRequestException("minEmployees must not exceed maxEmployees");
  }
  const rawExclusionDomains = cap(body.exclusionDomains, 50, "exclusionDomains");
  const exclusionDomains = rawExclusionDomains?.map((value) => {
    const normalized = normalizeIcpDomain(value);
    if (!normalized) {
      throw new BadRequestException(
        `exclusionDomains contains an invalid web domain: ${value}`,
      );
    }
    return normalized;
  });
  return {
    name: body.name.slice(0, 200),
    targetTitles: cap(body.targetTitles, 20, "targetTitles"),
    targetIndustries: cap(body.targetIndustries, 10, "targetIndustries"),
    targetGeos: cap(body.targetGeos, 10, "targetGeos"),
    techStackSignals: cap(body.techStackSignals, 20, "techStackSignals"),
    intentKeywords: cap(body.intentKeywords, 30, "intentKeywords"),
    seedDomains: cap(body.seedDomains, 50, "seedDomains"),
    exclusionDomains:
      exclusionDomains === undefined
        ? undefined
        : [...new Set(exclusionDomains)],
    minEmployees,
    maxEmployees,
  };
}
