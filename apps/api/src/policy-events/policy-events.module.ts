import { Module } from "@nestjs/common";
import { PolicyEventsController } from "./policy-events.controller";
import { PolicyEventsService } from "./policy-events.service";

@Module({
  controllers: [PolicyEventsController],
  providers: [PolicyEventsService],
})
export class PolicyEventsModule {}
