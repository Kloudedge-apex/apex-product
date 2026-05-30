import { Module, forwardRef } from "@nestjs/common";
import { GmailController } from "./gmail.controller";
import { GmailService } from "./gmail.service";
import { RuntimeModule } from "../../runtime/runtime.module";
import { ReplyClassifierModule } from "../../inbox/reply-classifier/reply-classifier.module";
import { SuppressionModule } from "../../suppression/suppression.module";

@Module({
  // forwardRef breaks the IntegrationsModule → GmailModule → RuntimeModule →
  // IntegrationsModule cycle introduced when GmailService gained the ability
  // to dispatch Reply Handler runs from inbound push notifications.
  imports: [forwardRef(() => RuntimeModule), ReplyClassifierModule, SuppressionModule],
  controllers: [GmailController],
  providers: [GmailService],
  exports: [GmailService],
})
export class GmailModule {}
