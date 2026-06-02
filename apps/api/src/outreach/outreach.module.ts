import { Module } from "@nestjs/common";
import { OutreachArtifactsService } from "./outreach-artifacts.service";
import { OutreachArtifactsController } from "./outreach-artifacts.controller";
import { OutreachSendQueueService } from "./outreach-send-queue.service";
import { SendOutreachWorker } from "./send-outreach.worker";
import { SuppressionService } from "./suppression.service";
import { SuppressionController } from "./suppression.controller";
import { UnsubscribeController } from "./unsubscribe.controller";
import { IntegrationsModule } from "../integrations/integrations.module";
import { ObservabilityModule } from "../observability/observability.module";

@Module({
  // ObservabilityModule is @Global so LangSmithService is already injectable,
  // but importing it here makes the dependency explicit and survives any
  // future de-globalization.
  imports: [IntegrationsModule, ObservabilityModule],
  controllers: [OutreachArtifactsController, UnsubscribeController, SuppressionController],
  providers: [
    OutreachArtifactsService,
    OutreachSendQueueService,
    SendOutreachWorker,
    SuppressionService,
  ],
  exports: [OutreachArtifactsService, OutreachSendQueueService, SuppressionService],
})
export class OutreachModule {}
