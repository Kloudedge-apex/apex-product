import { Module } from "@nestjs/common";
import { SuppressionService } from "./suppression.service";

/**
 * SuppressionService extracted into its own module so consumers outside the
 * outreach domain (GmailModule's DSN auto-suppress) can import it WITHOUT
 * importing OutreachModule — whose imports chain (IntegrationsModule →
 * GmailModule) would close a file-level evaluation cycle and crash the app at
 * boot (UndefinedModuleException, prod incident 2026-06-12; pinned by
 * src/__tests__/module-graph.spec.ts).
 *
 * Depends only on the @Global PrismaModule, so this module must stay
 * import-free. Do not add imports here that reach back into outreach/,
 * integrations/, or runtime/.
 */
@Module({
  providers: [SuppressionService],
  exports: [SuppressionService],
})
export class SuppressionModule {}
