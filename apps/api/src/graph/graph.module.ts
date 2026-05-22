import { Module } from "@nestjs/common";
import { GraphService } from "./graph.service";
import { GraphController } from "./graph.controller";
import { LeadsModule } from "../leads/leads.module";
import { RuntimeModule } from "../runtime/runtime.module";
import { OutreachModule } from "../outreach/outreach.module";

@Module({
  imports: [LeadsModule, RuntimeModule, OutreachModule],
  controllers: [GraphController],
  providers: [GraphService],
  exports: [GraphService],
})
export class GraphModule {}
