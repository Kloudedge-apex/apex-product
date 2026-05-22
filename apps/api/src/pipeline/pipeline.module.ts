import { Module } from "@nestjs/common";
import { PipelineController } from "./pipeline.controller";
import { IcpAutoService } from "./icp-auto.service";
import { LeadsModule } from "../leads/leads.module";
import { RuntimeModule } from "../runtime/runtime.module";
import { GraphModule } from "../graph/graph.module";

@Module({
  imports: [LeadsModule, RuntimeModule, GraphModule],
  controllers: [PipelineController],
  providers: [IcpAutoService],
})
export class PipelineModule {}
