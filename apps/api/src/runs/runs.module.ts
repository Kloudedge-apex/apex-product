import { Module } from "@nestjs/common";
import { RunsService } from "./runs.service";

@Module({
  providers: [RunsService],
  exports: [RunsService],
})
export class RunsModule {}
