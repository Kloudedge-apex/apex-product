import { Module } from "@nestjs/common";
import { IntegrationsController } from "./integrations.controller";
import { IntegrationsService } from "./integrations.service";
import { GmailModule } from "./gmail/gmail.module";
import { LinkedInService } from "./linkedin/linkedin.service";

@Module({
  // The guarded release exposes Gmail only. Deferred provider services remain
  // in source for later work, but their HTTP controllers must not be mounted.
  imports: [GmailModule],
  controllers: [IntegrationsController],
  providers: [IntegrationsService, LinkedInService],
  exports: [IntegrationsService, LinkedInService, GmailModule],
})
export class IntegrationsModule {}
