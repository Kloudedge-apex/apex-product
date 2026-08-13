import { Module } from "@nestjs/common";
import { GraphModule } from "../graph/graph.module";
import { WorkflowTemplatesService } from "./workflow-templates.service";
import { WorkflowRunsService } from "./workflow-runs.service";

@Module({
  imports: [GraphModule],
  providers: [WorkflowTemplatesService, WorkflowRunsService],
  exports: [WorkflowTemplatesService, WorkflowRunsService],
})
export class WorkflowsModule {}
