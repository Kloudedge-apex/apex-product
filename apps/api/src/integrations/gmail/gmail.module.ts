import { Module, forwardRef } from "@nestjs/common";
import { GmailController } from "./gmail.controller";
import { GmailService } from "./gmail.service";
import { RuntimeModule } from "../../runtime/runtime.module";
import { OutreachModule } from "../../outreach/outreach.module";
import { AdminOrManagerGuard } from "../../common/admin-or-manager.guard";

@Module({
  // forwardRef breaks the IntegrationsModule → GmailModule → RuntimeModule →
  // IntegrationsModule cycle introduced when GmailService gained the ability
  // to dispatch Reply Handler runs from inbound push notifications. Same
  // treatment for OutreachModule (SuppressionService for DSN auto-suppress):
  // OutreachModule → IntegrationsModule → GmailModule closes a cycle too.
  imports: [forwardRef(() => RuntimeModule), forwardRef(() => OutreachModule)],
  controllers: [GmailController],
  providers: [GmailService, AdminOrManagerGuard],
  exports: [GmailService],
})
export class GmailModule {}
