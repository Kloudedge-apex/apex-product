import { Module } from "@nestjs/common";
import { GraphService } from "./graph.service";
import { GraphController } from "./graph.controller";
import { LeadsModule } from "../leads/leads.module";
import { RuntimeModule } from "../runtime/runtime.module";
import { OutreachModule } from "../outreach/outreach.module";
import { ObservabilityModule } from "../observability/observability.module";

@Module({
  imports: [LeadsModule, RuntimeModule, OutreachModule, ObservabilityModule],
  controllers: [GraphController],
  providers: [GraphService],
  exports: [GraphService],
})
export class GraphModule {}
