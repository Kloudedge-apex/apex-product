import { Module } from "@nestjs/common";
import { IntegrationsController } from "./integrations.controller";
import { IntegrationsService } from "./integrations.service";
import { GmailModule } from "./gmail/gmail.module";
import { HubspotModule } from "./hubspot/hubspot.module";
import { LinkedInController } from "./linkedin/linkedin.controller";

@Module({
  imports: [GmailModule, HubspotModule],
  controllers: [IntegrationsController, LinkedInController],
  providers: [IntegrationsService],
  exports: [IntegrationsService, GmailModule, HubspotModule],
})
export class IntegrationsModule { }
