import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ConfigModule } from "@nestjs/config";
import { PrismaModule } from "./prisma/prisma.module";
import { HealthModule } from "./health/health.module";
import { AuthModule } from "./auth/auth.module";
import { OrgsModule } from "./orgs/orgs.module";
import { AgentsModule } from "./agents/agents.module";
import { IntegrationsModule } from "./integrations/integrations.module";
import { BillingModule } from "./billing/billing.module";
import { RunsModule } from "./runs/runs.module";
import { RuntimeModule } from "./runtime/runtime.module";
import { LeadsModule } from "./leads/leads.module";
import { PipelineModule } from "./pipeline/pipeline.module";
import { GraphModule } from "./graph/graph.module";
import { OutreachModule } from "./outreach/outreach.module";
import { WorkflowsModule } from "./workflows/workflows.module";
import { MeetingsModule } from "./meetings/meetings.module";
import { DashboardModule } from "./dashboard/dashboard.module";
import { PolicyEventsModule } from "./policy-events/policy-events.module";
import { ObservabilityModule } from "./observability/observability.module";
import { KpisModule } from "./kpis/kpis.module";
import { BetaStubsModule } from "./beta-stubs/beta-stubs.module";
import { OrgScopeGuard } from "./common/org-scope.guard";
import { RateLimitGuard } from "./common/rate-limit.guard";

/**
 * Guards run in registration order. `OrgScopeGuard` must run first so that
 * `request.orgId` is populated before `RateLimitGuard` reads it; otherwise
 * the rate limiter would have to key on a client-controlled header, which
 * lets any caller claim another org's quota.
 */
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
    RuntimeModule,
    LeadsModule,
    PipelineModule,
    GraphModule,
    OutreachModule,
    ObservabilityModule,
    KpisModule,
    WorkflowsModule,
    MeetingsModule,
    DashboardModule,
    PolicyEventsModule,
    BetaStubsModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: OrgScopeGuard },
    { provide: APP_GUARD, useClass: RateLimitGuard },
  ],
})
export class AppModule {}
