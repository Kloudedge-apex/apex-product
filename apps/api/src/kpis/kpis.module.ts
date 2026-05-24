import { Module } from "@nestjs/common";
import { KpiCalculatorService } from "./kpi-calculator.service";
import { KpisController } from "./kpis.controller";

@Module({
  controllers: [KpisController],
  providers: [KpiCalculatorService],
})
export class KpisModule {}

