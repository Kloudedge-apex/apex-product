/**
 * Lead Engine Module
 *
 * Required environment variables:
 * - A configured LLMService provider (OpenAI or Azure OpenAI) enables the
 *   unstructured team-page extraction fallback.
 * - THEIRSTACK_API_KEY    (optional - hiring-intent company discovery)
 * - HUNTER_API_KEY        (optional - fallback email finder via Hunter.io)
 * - COMPANIES_HOUSE_API_KEY (optional - UK Companies House registry)
 * - GITHUB_TOKEN          (optional - GitHub enrichment, higher rate limits)
 */
import { Module } from "@nestjs/common";
import { RuntimeModule } from "../runtime/runtime.module";
import { LeadsController } from "./leads.controller";
import { LeadsService } from "./leads.service";
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
import { AdminOrManagerGuard } from "../common/admin-or-manager.guard";

@Module({
  imports: [RuntimeModule],
  controllers: [LeadsController],
  providers: [
    LeadsService,
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
    AdminOrManagerGuard,
  ],
  exports: [LeadsService],
})
export class LeadsModule {}
