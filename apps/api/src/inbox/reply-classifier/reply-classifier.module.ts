import { Module } from "@nestjs/common";
import { LlmModule } from "../../runtime/llm.module";
import { ReplyClassifierQueueService } from "./reply-classifier.queue";
import { ReplyClassifierProcessor } from "./reply-classifier.processor";
import { ReplyClassifierService } from "./reply-classifier.service";

@Module({
  imports: [LlmModule],
  providers: [ReplyClassifierQueueService, ReplyClassifierProcessor, ReplyClassifierService],
  exports: [ReplyClassifierService, ReplyClassifierQueueService],
})
export class ReplyClassifierModule {}

