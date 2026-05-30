import { Module } from "@nestjs/common";
import { EvaluatorFactService } from "./evaluator-fact.service";

@Module({
  providers: [EvaluatorFactService],
  exports: [EvaluatorFactService],
})
export class EvaluatorFactModule {}

