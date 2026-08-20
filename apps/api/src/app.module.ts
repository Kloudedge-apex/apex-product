import { Module } from "@nestjs/common";
import { APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { ConfigModule } from "@nestjs/config";
import { PrismaModule } from "./prisma/prisma.module";
import { HealthModule } from "./health/health.module";
import { AuthModule } from "./auth/auth.module";
import { OrgsModule } from "./orgs/orgs.module";
import { IntegrationsModule } from "./integrations/integrations.module";
import { BillingModule } from "./billing/billing.module";
import { RuntimeModule } from "./runtime/runtime.module";
import { LeadsModule } from "./leads/leads.module";
import { PipelineModule } from "./pipeline/pipeline.module";
import { GraphModule } from "./graph/graph.module";
import { OutreachModule } from "./outreach/outreach.module";
import { MeetingsModule } from "./meetings/meetings.module";
import { DashboardModule } from "./dashboard/dashboard.module";
import { PolicyEventsModule } from "./policy-events/policy-events.module";
import { ObservabilityModule } from "./observability/observability.module";
import { KpisModule } from "./kpis/kpis.module";
import { ConversationsModule } from "./conversations/conversations.module";
import { OrgScopeGuard } from "./common/org-scope.guard";
import { RateLimitGuard } from "./common/rate-limit.guard";
import { ProductionBootstrapWriterFenceInterceptor } from "./ops/production-bootstrap-writer-fence.interceptor";

/**
 * Guards run in registration order. `OrgScopeGuard` establishes tenant
 * authority before the tenant-aware limiter reads `request.orgId`. The
 * application intentionally has no pre-auth per-IP limiter: console traffic
 * arrives through a shared BFF egress, so such a bucket would let one tenant
 * deny service to every tenant. Volumetric ingress limiting belongs at the
 * trusted edge; JWKS network amplification is bounded in the verifier.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    HealthModule,
    AuthModule,
    OrgsModule,
    IntegrationsModule,
    BillingModule,
    RuntimeModule,
    LeadsModule,
    PipelineModule,
    GraphModule,
    OutreachModule,
    ObservabilityModule,
    KpisModule,
    MeetingsModule,
    ConversationsModule,
    DashboardModule,
    PolicyEventsModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: OrgScopeGuard },
    { provide: APP_GUARD, useClass: RateLimitGuard },
    {
      provide: APP_INTERCEPTOR,
      useClass: ProductionBootstrapWriterFenceInterceptor,
    },
  ],
})
export class AppModule {}
