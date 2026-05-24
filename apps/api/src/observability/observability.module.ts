import { Global, Module } from "@nestjs/common";
import { LangSmithService } from "./langsmith.service";
import { EvidenceLedgerService } from "./evidence-ledger.service";

@Global()
@Module({
  providers: [LangSmithService, EvidenceLedgerService],
  exports: [LangSmithService, EvidenceLedgerService],
})
export class ObservabilityModule {}
