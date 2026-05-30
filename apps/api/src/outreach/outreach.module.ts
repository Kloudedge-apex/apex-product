import { Module } from "@nestjs/common";
import { OutreachArtifactsService } from "./outreach-artifacts.service";
import { OutreachArtifactsController } from "./outreach-artifacts.controller";
import { OutreachSendQueueService } from "./outreach-send-queue.service";
import { SendOutreachWorker } from "./send-outreach.worker";
import { IntegrationsModule } from "../integrations/integrations.module";
import { ObservabilityModule } from "../observability/observability.module";
import { SuppressionModule } from "../suppression/suppression.module";
import { RepliesController } from "./replies.controller";
import { RepliesService } from "./replies.service";
import { ReplyIntentEffectsService } from "../inbox/reply-intent-effects.service";

@Module({
  // ObservabilityModule is @Global so LangSmithService is already injectable,
  // but importing it here makes the dependency explicit and survives any
  // future de-globalization.
  imports: [IntegrationsModule, ObservabilityModule, SuppressionModule],
  controllers: [OutreachArtifactsController, RepliesController],
  providers: [
    OutreachArtifactsService,
    OutreachSendQueueService,
    SendOutreachWorker,
    RepliesService,
    ReplyIntentEffectsService,
  ],
  exports: [OutreachArtifactsService, OutreachSendQueueService],
})
export class OutreachModule {}
