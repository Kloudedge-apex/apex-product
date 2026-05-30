import { Module } from "@nestjs/common";
import { LLMService } from "./llm.service";
import { LlmBudgetService } from "./llm-budget.service";

@Module({
  providers: [LLMService, LlmBudgetService],
  exports: [LLMService, LlmBudgetService],
})
export class LlmModule {}

