import { Module } from "@nestjs/common";
import { IntegrationsController } from "./integrations.controller";
import { IntegrationsService } from "./integrations.service";
import { GmailModule } from "./gmail/gmail.module";
import { AdminOrManagerGuard } from "../common/admin-or-manager.guard";
import { OAuthAttemptService } from "./oauth-attempt.service";

@Module({
  // The guarded release exposes and provides Gmail only. Deferred provider
  // implementations remain in source for later work, but neither their HTTP
  // controllers nor their live service transports are mounted here.
  imports: [GmailModule],
  controllers: [IntegrationsController],
  providers: [IntegrationsService, AdminOrManagerGuard, OAuthAttemptService],
  exports: [IntegrationsService, GmailModule],
})
export class IntegrationsModule {}
