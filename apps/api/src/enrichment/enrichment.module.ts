import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { EnrichmentFactService } from "./enrichment-fact.service";

@Module({
  imports: [PrismaModule],
  providers: [EnrichmentFactService],
  exports: [EnrichmentFactService],
})
export class EnrichmentModule {}

