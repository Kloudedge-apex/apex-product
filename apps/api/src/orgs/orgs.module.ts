import { Module } from "@nestjs/common";
import { OrgsController } from "./orgs.controller";
import { OrgsService } from "./orgs.service";

/**
 * OrgsModule
 *
 * PrismaService is provided by PrismaModule (@Global) and
 * EvidenceLedgerService by ObservabilityModule (@Global), so neither needs
 * an explicit import here. The optional LangSmithPurgeClient and
 * GraphRunQueueScrubber dependencies on OrgsService are injected via
 * @Optional() — when the host app registers concrete providers for the
 * LANGSMITH_PURGE_CLIENT / GRAPH_RUN_QUEUE_SCRUBBER tokens (typically from
 * the LangSmith and Graph modules at composition root), best-effort purge
 * will run; otherwise tenant deletion still succeeds without them.
 */
@Module({
  controllers: [OrgsController],
  providers: [OrgsService],
  exports: [OrgsService],
})
export class OrgsModule {}
