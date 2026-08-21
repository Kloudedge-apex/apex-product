import { Module } from "@nestjs/common";
import { PipelineController } from "./pipeline.controller";
import { IcpAutoService } from "./icp-auto.service";
import { LeadsModule } from "../leads/leads.module";
import { RuntimeModule } from "../runtime/runtime.module";
import { GraphModule } from "../graph/graph.module";
import { AdminOrManagerGuard } from "../common/admin-or-manager.guard";

@Module({
  imports: [LeadsModule, RuntimeModule, GraphModule],
  controllers: [PipelineController],
  providers: [IcpAutoService, AdminOrManagerGuard],
})
export class PipelineModule {}
