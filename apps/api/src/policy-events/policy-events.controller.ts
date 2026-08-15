import { Controller, Get, Query, BadRequestException } from "@nestjs/common";
import { OrgId } from "../common/org-context.decorator";
import {
  PolicyEventsService,
  type PolicyDecision,
} from "./policy-events.service";

const ALLOWED_DECISIONS: ReadonlySet<PolicyDecision> = new Set([
  "allowed",
  "blocked",
  "dry_run",
  "delivery_unknown",
  "failed",
  "reconciliation_required",
]);

@Controller("policy-events")
export class PolicyEventsController {
  constructor(private readonly events: PolicyEventsService) {}

  @Get()
  list(
    @OrgId() orgId: string | undefined,
    @Query("graphRunId") graphRunId?: string,
    @Query("decision") decision?: string,
    @Query("limit") limit?: string,
  ) {
    if (!orgId) throw new BadRequestException("orgId required");
    const decisionNarrow: PolicyDecision | undefined =
      decision && ALLOWED_DECISIONS.has(decision as PolicyDecision)
        ? (decision as PolicyDecision)
        : undefined;
    return this.events.list(orgId, {
      graphRunId: graphRunId?.trim() || undefined,
      decision: decisionNarrow,
      limit: Math.min(200, Math.max(1, parseInt(limit ?? "50", 10))),
    });
  }
}
