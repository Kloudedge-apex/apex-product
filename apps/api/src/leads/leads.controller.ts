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
} from "@nestjs/common";
import type { Response } from "express";
import { OrgId } from "../common/org-context.decorator";
import { LeadsService } from "./leads.service";
import type { Seniority, Department } from "@prisma/client";

@Controller("leads")
export class LeadsController {
  constructor(private readonly leads: LeadsService) {}

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
    return this.leads.createIcpProfile(orgId, body);
  }

  @Get("icp")
  listIcpProfiles(@OrgId() orgId: string | undefined) {
    if (!orgId) throw new BadRequestException("orgId required");
    return this.leads.listIcpProfiles(orgId);
  }

  // ─── Discovery ───────────────────────────────────────

  @Post("discover")
  @HttpCode(HttpStatus.ACCEPTED)
  discover(
    @OrgId() orgId: string | undefined,
    @Body() body: { icpProfileId: string },
  ) {
    if (!orgId) throw new BadRequestException("orgId required");
    if (!body.icpProfileId)
      throw new BadRequestException("icpProfileId required");
    return this.leads.triggerDiscovery(orgId, body.icpProfileId);
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
