import { Module } from "@nestjs/common";
import { UsageService } from "./usage.service";
import { UsageController } from "./usage.controller";
import { UsageRollupQueue } from "./usage-rollup.queue";
import { UsageRollupProcessor } from "./usage-rollup.processor";
import { UsageRollupScheduler } from "./usage-rollup.scheduler";

@Module({
  controllers: [UsageController],
  providers: [
    UsageService,
    UsageRollupQueue,
    UsageRollupProcessor,
    UsageRollupScheduler,
  ],
  exports: [UsageService, UsageRollupQueue, UsageRollupProcessor],
})
export class UsageModule {}

