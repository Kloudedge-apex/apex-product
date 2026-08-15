import { Module, forwardRef } from "@nestjs/common";
import { AgentsService } from "./agents.service";
import { RuntimeModule } from "../runtime/runtime.module";

@Module({
  imports: [forwardRef(() => RuntimeModule)],
  providers: [AgentsService],
  exports: [AgentsService],
})
export class AgentsModule {}
