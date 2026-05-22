import { Module } from "@nestjs/common";
import { OutreachArtifactsService } from "./outreach-artifacts.service";
import { OutreachArtifactsController } from "./outreach-artifacts.controller";

@Module({
  controllers: [OutreachArtifactsController],
  providers: [OutreachArtifactsService],
  exports: [OutreachArtifactsService],
})
export class OutreachModule {}
