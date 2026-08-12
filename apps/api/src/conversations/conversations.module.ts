import { Module } from "@nestjs/common";
import { RuntimeModule } from "../runtime/runtime.module";
import { MeetingsModule } from "../meetings/meetings.module";
import { ConversationsController } from "./conversations.controller";
import { ConversationsService } from "./conversations.service";

@Module({
  imports: [RuntimeModule, MeetingsModule],
  controllers: [ConversationsController],
  providers: [ConversationsService],
  exports: [ConversationsService],
})
export class ConversationsModule {}
