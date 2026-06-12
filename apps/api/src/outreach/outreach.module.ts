import { Module } from "@nestjs/common";
import { OutreachArtifactsService } from "./outreach-artifacts.service";
import { OutreachArtifactsController } from "./outreach-artifacts.controller";
import { OutreachSendQueueService } from "./outreach-send-queue.service";
import { SendOutreachWorker } from "./send-outreach.worker";
import { SuppressionModule } from "./suppression.module";
import { SuppressionController } from "./suppression.controller";
import { UnsubscribeController } from "./unsubscribe.controller";
import { IntegrationsModule } from "../integrations/integrations.module";
import { ObservabilityModule } from "../observability/observability.module";

@Module({
  // ObservabilityModule is @Global so LangSmithService is already injectable,
  // but importing it here makes the dependency explicit and survives any
  // future de-globalization. SuppressionService lives in SuppressionModule
  // (re-exported below) so GmailModule can consume it without importing this
  // module — see suppression.module.ts for the boot-cycle rationale.
  imports: [IntegrationsModule, ObservabilityModule, SuppressionModule],
  controllers: [OutreachArtifactsController, UnsubscribeController, SuppressionController],
  providers: [
    OutreachArtifactsService,
    OutreachSendQueueService,
    SendOutreachWorker,
  ],
  exports: [OutreachArtifactsService, OutreachSendQueueService, SuppressionModule],
})
export class OutreachModule {}
