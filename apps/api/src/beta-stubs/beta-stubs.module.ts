import { Module } from "@nestjs/common";
import { BetaStubsController } from "./beta-stubs.controller";

@Module({
  controllers: [BetaStubsController],
})
export class BetaStubsModule {}
