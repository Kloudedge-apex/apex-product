import { Module } from "@nestjs/common";
import { IntegrationsController } from "./integrations.controller";
import { IntegrationsService } from "./integrations.service";
import { GmailModule } from "./gmail/gmail.module";
import { HubspotModule } from "./hubspot/hubspot.module";

@Module({
  imports: [GmailModule, HubspotModule],
  controllers: [IntegrationsController],
  providers: [IntegrationsService],
  exports: [IntegrationsService, GmailModule, HubspotModule],
})
export class IntegrationsModule {}
