import { Module, forwardRef } from "@nestjs/common";
import { GmailController } from "./gmail.controller";
import { GmailService } from "./gmail.service";
import { RuntimeModule } from "../../runtime/runtime.module";
import { AdminOrManagerGuard } from "../../common/admin-or-manager.guard";

@Module({
  // forwardRef breaks the IntegrationsModule → GmailModule → RuntimeModule →
  // IntegrationsModule cycle introduced when GmailService gained the ability
  // to dispatch Reply Handler runs from inbound push notifications.
  imports: [forwardRef(() => RuntimeModule)],
  controllers: [GmailController],
  providers: [GmailService, AdminOrManagerGuard],
  exports: [GmailService],
})
export class GmailModule {}
