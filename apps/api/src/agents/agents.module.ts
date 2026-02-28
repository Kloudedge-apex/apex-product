import { Module, forwardRef } from "@nestjs/common";
import { AgentsController } from "./agents.controller";
import { AgentsService } from "./agents.service";
import { RuntimeModule } from "../runtime/runtime.module";

@Module({
  imports: [forwardRef(() => RuntimeModule)],
  controllers: [AgentsController],
  providers: [AgentsService],
  exports: [AgentsService],
})
export class AgentsModule {}
