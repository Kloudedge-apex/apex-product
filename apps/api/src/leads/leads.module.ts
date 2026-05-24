/**
 * Lead Engine Module
 *
 * Required environment variables:
 * - OPENAI_API_KEY        (required - LLM extraction from team pages)
 * - HUNTER_API_KEY        (optional - fallback email finder via Hunter.io)
 * - COMPANIES_HOUSE_API_KEY (optional - UK Companies House registry)
 * - GITHUB_TOKEN          (optional - GitHub enrichment, higher rate limits)
 */
import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { RuntimeModule } from "../runtime/runtime.module";
import { LeadsController } from "./leads.controller";
import { LeadsService } from "./leads.service";
import { LeadsSchedulerService } from "./leads-scheduler.service";
import { AtsScraper } from "./sources/ats-scraper.service";
import { TeamPageScraper } from "./sources/team-page-scraper.service";
import { RegistryScraper } from "./sources/registry-scraper.service";
import { GithubEnrichment } from "./sources/github-enrichment.service";
import { JobSignalService } from "./sources/job-signal.service";
import { SerpDiscoveryService } from "./sources/serp-discovery.service";
import { TheirStackService } from "./sources/theirstack.service";
import { EmailPatternService } from "./enrichment/email-pattern.service";
import { IdentityResolver } from "./enrichment/identity-resolver.service";
import { LeadScorer } from "./scoring/lead-scorer.service";

@Module({
  imports: [ScheduleModule.forRoot(), RuntimeModule],
  controllers: [LeadsController],
  providers: [
    LeadsService,
    LeadsSchedulerService,
    AtsScraper,
    TeamPageScraper,
    RegistryScraper,
    GithubEnrichment,
    JobSignalService,
    SerpDiscoveryService,
    TheirStackService,
    EmailPatternService,
    IdentityResolver,
    LeadScorer,
  ],
  exports: [LeadsService],
})
export class LeadsModule {}
