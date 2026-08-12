import { Module } from "@nestjs/common";
import { ConversationStoreService } from "./conversation-store.service";

/**
 * Import-cycle-free persistence boundary for provider conversation events.
 *
 * PrismaModule is global, so this module intentionally has no imports. Gmail,
 * outreach, and runtime modules may consume the store without creating another
 * Gmail -> Runtime -> Integrations cycle. Keep provider API clients and queues
 * out of this module.
 */
@Module({
  providers: [ConversationStoreService],
  exports: [ConversationStoreService],
})
export class ConversationStoreModule {}
