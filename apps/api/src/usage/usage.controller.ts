import { BadRequestException, Controller, Get, Query, UseGuards } from "@nestjs/common";
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from "class-validator";
import { OrgId } from "../common/org-context.decorator";
import { OrgScopeGuard } from "../common/org-scope.guard";
import { RateLimitGuard } from "../common/rate-limit.guard";
import { UsageService, type UsageGranularity } from "./usage.service";

class UsageRangeQueryDto {
  @IsIn(["hour", "day"])
  granularity!: UsageGranularity;

  @IsString()
  from!: string;

  @IsString()
  to!: string;
}

class UsageSummaryQueryDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  days: number = 30;
}

@UseGuards(OrgScopeGuard, RateLimitGuard)
@Controller("usage")
export class UsageController {
  constructor(private readonly usage: UsageService) {}

  @Get()
  async list(@OrgId() orgId: string, @Query() query: UsageRangeQueryDto) {
    const from = new Date(query.from);
    const to = new Date(query.to);
    if (Number.isNaN(from.getTime())) throw new BadRequestException("Invalid from");
    if (Number.isNaN(to.getTime())) throw new BadRequestException("Invalid to");

    const rows = await this.usage.getOrgUsage({
      orgId,
      granularity: query.granularity,
      from,
      to,
    });

    // Ensure JSON-safe serialization (no BigInt / Decimal leakage).
    return rows.map((r) => ({
      orgId: r.orgId,
      granularity: r.granularity,
      bucket: r.bucket.toISOString(),
      llmRequests: r.llmRequests,
      llmTokensIn: r.llmTokensIn,
      llmTokensOut: r.llmTokensOut,
      llmCachedTokensIn: r.llmCachedTokensIn,
      llmCostUsd: r.llmCostUsd,
      enrichmentCalls: r.enrichmentCalls,
      enrichmentCostUsd: r.enrichmentCostUsd,
      emailsSent: r.emailsSent,
      emailsBounced: r.emailsBounced,
      emailsReplied: r.emailsReplied,
      emailsSuppressed: r.emailsSuppressed,
      computedAt: r.computedAt?.toISOString(),
    }));
  }

  @Get("summary")
  async summary(@OrgId() orgId: string, @Query() query: UsageSummaryQueryDto) {
    const summary = await this.usage.getOrgUsageSummary({ orgId, days: query.days });
    return summary;
  }
}

