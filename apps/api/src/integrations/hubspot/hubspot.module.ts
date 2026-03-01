import { Module } from "@nestjs/common";
import { HubspotController } from "./hubspot.controller";
import { HubspotService } from "./hubspot.service";

@Module({
  controllers: [HubspotController],
  providers: [HubspotService],
  exports: [HubspotService],
})
export class HubspotModule {}
