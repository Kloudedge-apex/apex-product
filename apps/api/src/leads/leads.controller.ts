import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  Res,
  HttpCode,
  HttpStatus,
  BadRequestException,
  Logger,
} from "@nestjs/common";
import type { Response } from "express";
import { OrgId } from "../common/org-context.decorator";
import { LeadsService } from "./leads.service";
import type { Seniority, Department } from "@prisma/client";

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

@Controller("leads")
export class LeadsController {
  private readonly logger = new Logger(LeadsController.name);

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
  createIcp(
    @OrgId() orgId: string | undefined,
    @Body()
    body: {
      name: string;
      targetTitles?: string[];
      targetIndustries?: string[];
      targetGeos?: string[];
      minEmployees?: number;
      maxEmployees?: number;
      techStackSignals?: string[];
      intentKeywords?: string[];
      seedDomains?: string[];
    },
  ) {
    if (!orgId) throw new BadRequestException("orgId required");
    if (!body.name || typeof body.name !== "string" || body.name.length > 200)
      throw new BadRequestException("name is required (max 200 chars)");

    // Cap array sizes to prevent abuse
    const cap = (arr: string[] | undefined, max: number) =>
      arr ? arr.slice(0, max).map((s) => String(s).slice(0, 200)) : [];

    return this.leads.createIcpProfile(orgId, {
      ...body,
      name: body.name.slice(0, 200),
      targetTitles: cap(body.targetTitles, 20),
      targetIndustries: cap(body.targetIndustries, 10),
      targetGeos: cap(body.targetGeos, 10),
      techStackSignals: cap(body.techStackSignals, 20),
      intentKeywords: cap(body.intentKeywords, 30),
      seedDomains: cap(body.seedDomains, 50),
      minEmployees: body.minEmployees ? Math.max(0, Math.min(body.minEmployees, 1000000)) : undefined,
      maxEmployees: body.maxEmployees ? Math.max(0, Math.min(body.maxEmployees, 1000000)) : undefined,
    });
  }

  @Get("icp")
  listIcpProfiles(@OrgId() orgId: string | undefined) {
    if (!orgId) throw new BadRequestException("orgId required");
    return this.leads.listIcpProfiles(orgId);
  }

  @Post("icp/:id/schedule")
  @HttpCode(HttpStatus.OK)
  updateIcpSchedule(
    @OrgId() orgId: string | undefined,
    @Param("id") id: string,
    @Body() body: { enabled: boolean; intervalHours?: number },
  ) {
    if (!orgId) throw new BadRequestException("orgId required");
    const interval = body.intervalHours ? Math.max(1, Math.min(body.intervalHours, 168)) : undefined; // 1h to 7 days
    return this.leads.updateIcpSchedule(orgId, id, body.enabled, interval);
  }

  // ─── Discovery ───────────────────────────────────────

  @Post("discover")
  @HttpCode(HttpStatus.ACCEPTED)
  discover(
    @OrgId() orgId: string | undefined,
    @Body() body: { icpProfileId?: string; icpId?: string },
  ) {
    if (!orgId) throw new BadRequestException("orgId required");
    const profileId = body.icpProfileId ?? body.icpId;
    if (!profileId)
      throw new BadRequestException("icpProfileId or icpId required");
    if (process.env.LEGACY_TRIGGER_DISCOVERY_ENABLED !== "true") {
      this.logger.warn(
        "triggerDiscovery is deprecated — set LEGACY_TRIGGER_DISCOVERY_ENABLED=true to opt back in; graph supervisor is now the single entry point",
      );
    }
    return this.leads.triggerDiscovery(orgId, profileId);
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
