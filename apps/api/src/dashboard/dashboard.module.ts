import { Module } from "@nestjs/common";
import { DashboardController } from "./dashboard.controller";
import { ActivityController } from "./activity.controller";
import { DashboardService } from "./dashboard.service";

@Module({
  controllers: [DashboardController, ActivityController],
  providers: [DashboardService],
})
export class DashboardModule {}
