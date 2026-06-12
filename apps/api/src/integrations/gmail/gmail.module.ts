import { Module, forwardRef } from "@nestjs/common";
import { GmailController } from "./gmail.controller";
import { GmailService } from "./gmail.service";
import { RuntimeModule } from "../../runtime/runtime.module";
import { SuppressionModule } from "../../outreach/suppression.module";
import { AdminOrManagerGuard } from "../../common/admin-or-manager.guard";

@Module({
  // forwardRef breaks the IntegrationsModule → GmailModule → RuntimeModule →
  // IntegrationsModule cycle introduced when GmailService gained the ability
  // to dispatch Reply Handler runs from inbound push notifications.
  // SuppressionService (DSN auto-suppress) comes from the import-free
  // SuppressionModule — NOT OutreachModule, whose imports chain reaches back
  // here and crashed boot on 2026-06-12 (see src/__tests__/module-graph.spec.ts).
  imports: [forwardRef(() => RuntimeModule), SuppressionModule],
  controllers: [GmailController],
  providers: [GmailService, AdminOrManagerGuard],
  exports: [GmailService],
})
export class GmailModule {}
