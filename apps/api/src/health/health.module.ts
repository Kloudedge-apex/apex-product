import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller";
import { PrismaModule } from "../prisma/prisma.module";
import { GraphRunQueueService } from "../graph/graph-run-queue.service";

@Module({
  imports: [PrismaModule],
  controllers: [HealthController],
  providers: [GraphRunQueueService],
})
export class HealthModule {}
