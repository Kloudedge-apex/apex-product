import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { ObservabilityModule } from "../observability/observability.module";
import { SuppressionService } from "./suppression.service";
import { SuppressionController } from "./suppression.controller";
import { UnsubscribeController } from "./unsubscribe.controller";

@Module({
  imports: [PrismaModule, ObservabilityModule],
  providers: [SuppressionService],
  controllers: [SuppressionController, UnsubscribeController],
  exports: [SuppressionService],
})
export class SuppressionModule {}
