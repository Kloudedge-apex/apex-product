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
import { LeadsController } from "./leads.controller";
import { LeadsService } from "./leads.service";
import { AtsScraper } from "./sources/ats-scraper.service";
import { TeamPageScraper } from "./sources/team-page-scraper.service";
import { RegistryScraper } from "./sources/registry-scraper.service";
import { GithubEnrichment } from "./sources/github-enrichment.service";
import { JobSignalService } from "./sources/job-signal.service";
import { EmailPatternService } from "./enrichment/email-pattern.service";
import { IdentityResolver } from "./enrichment/identity-resolver.service";
import { LeadScorer } from "./scoring/lead-scorer.service";

@Module({
  controllers: [LeadsController],
  providers: [
    LeadsService,
    AtsScraper,
    TeamPageScraper,
    RegistryScraper,
    GithubEnrichment,
    JobSignalService,
    EmailPatternService,
    IdentityResolver,
    LeadScorer,
  ],
  exports: [LeadsService],
})
export class LeadsModule {}
