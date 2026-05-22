import { Module } from "@nestjs/common";
import { GraphModule } from "../graph/graph.module";
import { WorkflowTemplatesService } from "./workflow-templates.service";
import { WorkflowRunsService } from "./workflow-runs.service";
import { WorkflowsController } from "./workflows.controller";

@Module({
  imports: [GraphModule],
  controllers: [WorkflowsController],
  providers: [WorkflowTemplatesService, WorkflowRunsService],
  exports: [WorkflowTemplatesService, WorkflowRunsService],
})
export class WorkflowsModule {}
