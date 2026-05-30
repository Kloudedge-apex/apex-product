import { Module } from "@nestjs/common";
import { LlmFactService } from "./llm-fact.service";

@Module({
  providers: [LlmFactService],
  exports: [LlmFactService],
})
export class LlmFactModule {}

