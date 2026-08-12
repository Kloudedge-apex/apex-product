import { Module } from "@nestjs/common";
import { GmailController } from "./gmail.controller";
import { GmailService } from "./gmail.service";
import { SuppressionModule } from "../../outreach/suppression.module";
import { AdminOrManagerGuard } from "../../common/admin-or-manager.guard";
import { ConversationStoreModule } from "../../conversation-store/conversation-store.module";

@Module({
  // Both dependencies are import-cycle-free persistence/policy boundaries.
  // Gmail push materializes replies directly instead of queueing a blind
  // AgentRun whose context was written only after the run was enqueued.
  imports: [SuppressionModule, ConversationStoreModule],
  controllers: [GmailController],
  providers: [GmailService, AdminOrManagerGuard],
  exports: [GmailService],
})
export class GmailModule {}
