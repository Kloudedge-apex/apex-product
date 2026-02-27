import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { PrismaModule } from "./prisma/prisma.module";
import { HealthModule } from "./health/health.module";
import { AuthModule } from "./auth/auth.module";
import { OrgsModule } from "./orgs/orgs.module";
import { AgentsModule } from "./agents/agents.module";
import { IntegrationsModule } from "./integrations/integrations.module";
import { BillingModule } from "./billing/billing.module";
import { RunsModule } from "./runs/runs.module";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    HealthModule,
    AuthModule,
    OrgsModule,
    AgentsModule,
    IntegrationsModule,
    BillingModule,
    RunsModule,
  ],
})
export class AppModule {}
