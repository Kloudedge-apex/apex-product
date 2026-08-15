import { Global, Module } from "@nestjs/common";
import { PrismaService } from "./prisma.service";
import { ProductionBootstrapOpsModule } from "../ops/production-bootstrap-ops.module";

@Global()
@Module({
  imports: [ProductionBootstrapOpsModule],
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
