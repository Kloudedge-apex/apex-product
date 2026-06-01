import { Logger } from "@nestjs/common";
import {
  StateGraph,
  START,
  END,
  Command,
  interrupt,
  type LangGraphRunnableConfig,
} from "@langchain/langgraph";
import {
  PipelineStateAnnotation,
  NODE,
  STAGE,
  type PipelineState,
  type StageName,
  type StageStatus,
} from "./state";
import type { LeadsService } from "../leads/leads.service";
import type { PrismaService } from "../prisma/prisma.service";
import type { RuntimeService } from "../runtime/runtime.service";
import type { LLMService } from "../runtime/llm.service";
import type { OutreachArtifactsService } from "../outreach/outreach-artifacts.service";
import type { EvidenceLedgerService } from "../observability/evidence-ledger.service";
import type { RunLevelEvaluatorService } from "../observability/run-level-evaluator.service";
import { withNodeSpan } from "../observability/graph-tracing";
import {
  runSdrOutreachSubgraph,
  type SdrLeadInput,
} from "./nodes/sdr-outreach-subgraph";
import { tierForScore } from "../common/qualification.constants";

const MAX_OUTREACH = 10;
const log = new Logger("PipelineGraph");

interface Deps {
  leads: LeadsService;
  prisma: PrismaService;
  runtime: RuntimeService;
  llm: LLMService;
  outreachArtifacts: OutreachArtifactsService;
  evidenceLedger: EvidenceLedgerService;
  // Optional: forwarded to the SDR subgraph so its drafter LangSmith runId
  // is wired into the run-level evaluator (audit P0 #13).
  runLevelEvaluator?: RunLevelEvaluatorService;
}

const nowMsg = (
  node: string,
  text: string,
  level: "info" | "warn" | "error" = "info",
) => ({
  messages: [{ node, ts: new Date().toISOString(), level, text }],
});

/**
 * Thrown by a node when the stage produced zero usable output and that is
 * fatal to the run. The graph.service catch-all turns the throw into a
 * GraphRun.status = FAILED with `error` carrying `${stage}:${reason}`.
 *
 * Keeping a dedicated error type (rather than a bare Error) lets the worker
 * layer distinguish "stage failed cleanly" from infra exceptions later.
 */
export class StageFailureError extends Error {
  constructor(
    readonly stage: StageName,
    readonly reason: string,
    details?: string,
  ) {
    super(`${stage}:${reason}${details ? ` (${details})` : ""}`);
    this.name = "StageFailureError";
  }
}

/** Build a `{ stageStatuses }` partial update for a single stage. */
function stageStatus(stage: StageName, status: StageStatus): Partial<PipelineState> {
  return { stageStatuses: { [stage]: status } };
}

/**
 * Defensive gate: short-circuit a downstream node if a required upstream
 * stage is FAILED. In practice the throw from the upstream node already
 * stops the run, but if state is rehydrated (e.g. from a checkpoint) or a
 * test invokes a node directly we still want the gate.
 */
function upstreamFailed(
  state: PipelineState,
  upstream: StageName,
): boolean {
  return state.stageStatuses?.[upstream] === "FAILED";
}

/**
 * Build the supervisor StateGraph. Returned graph is uncompiled — caller
 * compiles with their checkpointer of choice.
 *
 *   START → supervisor → (routes based on stagesCompleted)
 *           ├→ sourcing      → supervisor
 *           ├→ enrichment    → supervisor
 *           ├→ scoring       → supervisor
 *           ├→ human_approval (interrupt) → supervisor
 *           └→ outreach      → supervisor
 *                                ↓
 *                                END (when all stages done)
 */
export function buildPipelineGraph(deps: Deps) {
  const supervisor = async (
    state: PipelineState,
  ): Promise<Command> => {
    return withNodeSpan(
      NODE.SUPERVISOR,
      {
        "apex.run_id": state.runId,
        "apex.org_id": state.orgId,
        "apex.node": NODE.SUPERVISOR,
      },
      async () => {
        const done = new Set(state.stagesCompleted);
        const next = pickNext(done, state.approved);
        log.log(
          `supervisor → ${next} (done=[${[...done].join(",")}], approved=${state.approved})`,
        );

        return new Command({
          goto: next === "END" ? END : next,
          update: nowMsg(NODE.SUPERVISOR, `routing → ${next}`),
        });
      },
    );
  };

  const sourcingAgent = async (state: PipelineState): Promise<Partial<PipelineState>> => {
    return withNodeSpan(
      NODE.SOURCING,
      {
        "apex.run_id": state.runId,
        "apex.org_id": state.orgId,
        "apex.node": NODE.SOURCING,
      },
      async () => {
        const startedAt = Date.now();
        const update: Partial<PipelineState> = {
          ...nowMsg(NODE.SOURCING, `sourcing for ${state.icpProfileIds.length} ICP(s)`),
        };
        const errors: PipelineState["errors"] = [];

        let totalCompanies = 0;
        let totalPeople = 0;
        // per-run only: do NOT cross-pollinate org-wide leads here. We
        // accumulate IDs produced BY THIS RUN across ICPs and use them as
        // the scope for every downstream DB read in this node and beyond.
        const runCompanyIds = new Set<string>();
        const runPersonIds = new Set<string>();
        for (const icpId of state.icpProfileIds) {
          try {
            const { companies, people, companyIds, personIds } =
              await deps.leads.runSourcingStage(state.orgId, icpId);
            totalCompanies += companies;
            totalPeople += people;
            for (const id of companyIds) runCompanyIds.add(id);
            for (const id of personIds) runPersonIds.add(id);
            log.log(`sourcing[${icpId}] companies=${companies} people=${people}`);
          } catch (err) {
            const msg = err instanceof Error ? err.message : "unknown";
            errors.push({
              node: NODE.SOURCING,
              error: `${icpId}: ${msg}`,
              ts: new Date().toISOString(),
            });
          }
        }

        void deps.evidenceLedger.leadSourced({
          orgId: state.orgId,
          runId: state.runId,
          companies: totalCompanies,
          people: totalPeople,
          durationMs: Date.now() - startedAt,
        });

        // per-run only: do NOT cross-pollinate org-wide leads here. Snapshot
        // only the companies THIS run sourced. Org+id filter is
        // defence-in-depth against id collisions.
        const companyIdList = [...runCompanyIds];
        const companies = companyIdList.length > 0
          ? await deps.prisma.company.findMany({
              where: { orgId: state.orgId, id: { in: companyIdList } },
              select: { id: true, domain: true, name: true },
              take: 200,
            })
          : [];

        update.sourcedCompanies = companies;
        update.sourcedPersonIds = [...runPersonIds];
        update.stagesCompleted = [STAGE.SOURCING];
        if (errors.length) update.errors = errors;

        // FAILED iff every ICP yielded zero rows AND we sourced nothing into
        // the DB. A run with no leads anywhere cannot drive downstream stages,
        // so throw to terminate the run cleanly via graph.service's catch.
        if (totalCompanies === 0 && totalPeople === 0 && companies.length === 0) {
          Object.assign(update, stageStatus(STAGE.SOURCING, "FAILED"));
          log.warn(`sourcing FAILED — no_leads_from_any_source for org=${state.orgId}`);
          throw new StageFailureError(
            STAGE.SOURCING,
            "no_leads_from_any_source",
            `icps=${state.icpProfileIds.length}`,
          );
        }

        // PARTIAL if some ICPs errored but we still got rows; otherwise COMPLETE.
        const status: StageStatus =
          errors.length > 0 && errors.length < state.icpProfileIds.length ? "PARTIAL" : "COMPLETE";
        Object.assign(update, stageStatus(STAGE.SOURCING, status));
        return update;
      },
    );
  };

  const enrichmentAgent = async (state: PipelineState): Promise<Partial<PipelineState>> => {
    return withNodeSpan(
      NODE.ENRICHMENT,
      {
        "apex.run_id": state.runId,
        "apex.org_id": state.orgId,
        "apex.node": NODE.ENRICHMENT,
      },
      async () => {
        if (upstreamFailed(state, STAGE.SOURCING)) {
          log.warn(`skipping ${STAGE.ENRICHMENT} — upstream ${STAGE.SOURCING} failed`);
          return {
            stagesCompleted: [STAGE.ENRICHMENT],
            ...stageStatus(STAGE.ENRICHMENT, "FAILED"),
            ...nowMsg(NODE.ENRICHMENT, `skipped — upstream ${STAGE.SOURCING} failed`, "warn"),
          };
        }

        const update: Partial<PipelineState> = {
          ...nowMsg(NODE.ENRICHMENT, `enriching for ${state.icpProfileIds.length} ICP(s)`),
        };
        const errors: PipelineState["errors"] = [];

        let totalEnriched = 0;
        // per-run only: do NOT cross-pollinate org-wide leads here. We
        // accumulate the person IDs touched in THIS run and pass them as
        // the scope to subsequent stages.
        const runPersonIds = new Set<string>(state.sourcedPersonIds);
        for (const icpId of state.icpProfileIds) {
          try {
            const { merged, enriched, personIds } = await deps.leads.runEnrichmentStage(
              state.orgId,
              icpId,
              state.sourcedPersonIds,
            );
            totalEnriched += enriched;
            for (const id of personIds) runPersonIds.add(id);
            log.log(`enrichment[${icpId}] merged=${merged} enriched=${enriched}`);
          } catch (err) {
            const msg = err instanceof Error ? err.message : "unknown";
            errors.push({
              node: NODE.ENRICHMENT,
              error: `${icpId}: ${msg}`,
              ts: new Date().toISOString(),
            });
          }
        }

        // per-run only: do NOT cross-pollinate org-wide leads here.
        // Snapshot only the people THIS run sourced/enriched.
        const personIdList = [...runPersonIds];
        const people = personIdList.length > 0
          ? await deps.prisma.person.findMany({
              where: {
                company: { orgId: state.orgId },
                id: { in: personIdList },
              },
              select: {
                id: true,
                companyId: true,
                firstName: true,
                lastName: true,
                title: true,
                emails: { select: { email: true }, take: 1 },
              },
              take: 200,
            })
          : [];

        const enrichedPeople = people.map((p) => ({
          id: p.id,
          companyId: p.companyId,
          firstName: p.firstName,
          lastName: p.lastName,
          title: p.title ?? undefined,
          email: p.emails[0]?.email,
        }));
        update.enrichedPeople = enrichedPeople;
        update.enrichedPersonIds = personIdList;
        update.stagesCompleted = [STAGE.ENRICHMENT];
        if (errors.length) update.errors = errors;

        // FAILED iff sourcing produced rows but enrichment landed nothing
        // useful (no enriched contacts and none with an email in the DB).
        const inputRows = state.sourcedCompanies.length;
        const enrichedWithEmail = enrichedPeople.filter((p) => !!p.email).length;
        if (totalEnriched === 0 && enrichedWithEmail === 0 && inputRows > 0) {
          Object.assign(update, stageStatus(STAGE.ENRICHMENT, "FAILED"));
          log.warn(`enrichment FAILED — enrichment_yielded_zero (input_companies=${inputRows})`);
          throw new StageFailureError(
            STAGE.ENRICHMENT,
            "enrichment_yielded_zero",
            `input_companies=${inputRows}`,
          );
        }

        // PARTIAL: we got something, but either some ICPs errored or we
        // enriched fewer contacts than companies suggested we should have
        // (cheap heuristic — exact "expected count" isn't available here).
        const status: StageStatus =
          errors.length > 0 || enrichedWithEmail < inputRows ? "PARTIAL" : "COMPLETE";
        Object.assign(update, stageStatus(STAGE.ENRICHMENT, status));
        return update;
      },
    );
  };

  const scoringAgent = async (state: PipelineState): Promise<Partial<PipelineState>> => {
    return withNodeSpan(
      NODE.SCORING,
      {
        "apex.run_id": state.runId,
        "apex.org_id": state.orgId,
        "apex.node": NODE.SCORING,
      },
      async () => {
        if (upstreamFailed(state, STAGE.ENRICHMENT)) {
          log.warn(`skipping ${STAGE.SCORING} — upstream ${STAGE.ENRICHMENT} failed`);
          return {
            stagesCompleted: [STAGE.SCORING],
            ...stageStatus(STAGE.SCORING, "FAILED"),
            ...nowMsg(NODE.SCORING, `skipped — upstream ${STAGE.ENRICHMENT} failed`, "warn"),
          };
        }

        const startedAt = Date.now();
        const update: Partial<PipelineState> = {
          ...nowMsg(NODE.SCORING, `scoring for ${state.icpProfileIds.length} ICP(s)`),
        };
        const errors: PipelineState["errors"] = [];

        let totalScored = 0;
        // per-run only: do NOT cross-pollinate org-wide leads here. We
        // collect the person IDs scored in THIS run and use them as the
        // exact scope for the snapshot query below.
        const runScoredIds = new Set<string>();
        for (const icpId of state.icpProfileIds) {
          try {
            const { scored, personIds } = await deps.leads.runScoringStage(
              state.orgId,
              icpId,
              state.enrichedPersonIds,
            );
            totalScored += scored;
            for (const id of personIds) runScoredIds.add(id);
            log.log(`scoring[${icpId}] scored=${scored}`);
          } catch (err) {
            const msg = err instanceof Error ? err.message : "unknown";
            errors.push({
              node: NODE.SCORING,
              error: `${icpId}: ${msg}`,
              ts: new Date().toISOString(),
            });
          }
        }

        void deps.evidenceLedger.leadScored({
          orgId: state.orgId,
          runId: state.runId,
          scored: totalScored,
          durationMs: Date.now() - startedAt,
        });

        // per-run only: do NOT cross-pollinate org-wide leads here. Pull
        // scores only for the people THIS run scored. The org-wide top-100
        // query that lived here previously was the root cause of the
        // 200-lead-leak bug.
        const scoredIdList = [...runScoredIds];
        const scores = scoredIdList.length > 0
          ? await deps.prisma.leadScore.findMany({
              where: { orgId: state.orgId, personId: { in: scoredIdList } },
              orderBy: { score: "desc" },
              take: 100,
              select: { personId: true, score: true },
            })
          : [];

        const scoredLeads = scores.map((s) => ({
          personId: s.personId,
          score: s.score,
          tier: tierForScore(s.score),
        }));
        update.scoredLeads = scoredLeads;
        update.stagesCompleted = [STAGE.SCORING];
        if (errors.length) update.errors = errors;

        // FAILED iff we couldn't score anything despite having enriched input.
        // NOTE: "zero qualified leads after scoring" (i.e. everyone tier C)
        // is NOT FAILED — that's a valid signal that the ICP simply doesn't
        // match the available leads. The approval/outreach stages handle the
        // empty-qualified-set case downstream.
        if (totalScored === 0 && scoredLeads.length === 0 && state.enrichedPeople.length > 0) {
          Object.assign(update, stageStatus(STAGE.SCORING, "FAILED"));
          log.warn(
            `scoring FAILED — scoring_yielded_zero (enriched_input=${state.enrichedPeople.length})`,
          );
          throw new StageFailureError(
            STAGE.SCORING,
            "scoring_yielded_zero",
            `enriched_input=${state.enrichedPeople.length}`,
          );
        }

        const status: StageStatus = errors.length > 0 ? "PARTIAL" : "COMPLETE";
        Object.assign(update, stageStatus(STAGE.SCORING, status));
        return update;
      },
    );
  };

  const humanApproval = async (
    state: PipelineState,
  ): Promise<Partial<PipelineState>> => {
    return withNodeSpan(
      NODE.APPROVAL,
      {
        "apex.run_id": state.runId,
        "apex.org_id": state.orgId,
        "apex.node": NODE.APPROVAL,
      },
      async () => {
        // Top tier-A/B leads we'd send to outreach if approved.
        const candidates = state.scoredLeads
          .filter((s) => s.tier === "A" || s.tier === "B")
          .slice(0, MAX_OUTREACH);

        // `interrupt` suspends the graph; resume happens via Command({ resume: ... })
        // wired by GraphService.resumePipelineGraph.
        const decision = interrupt({
          reason: "approval_required",
          candidateCount: candidates.length,
          candidates: candidates.slice(0, 5),
          message: `Approve outreach to ${candidates.length} qualified lead(s)?`,
        }) as { approved: boolean; approvedBy?: string };

        // Approval is always COMPLETE: "nothing to approve" is a valid
        // outcome and rejection is a deliberate decision, not a failure.
        return {
          approved: !!decision?.approved,
          approvedBy: decision?.approvedBy ?? null,
          stagesCompleted: [STAGE.APPROVAL],
          ...stageStatus(STAGE.APPROVAL, "COMPLETE"),
          ...nowMsg(
            NODE.APPROVAL,
            decision?.approved
              ? `approved by ${decision?.approvedBy ?? "unknown"}`
              : "rejected — skipping outreach",
          ),
        };
      },
    );
  };

  const outreachAgent = async (state: PipelineState): Promise<Partial<PipelineState>> => {
    return withNodeSpan(
      NODE.OUTREACH,
      {
        "apex.run_id": state.runId,
        "apex.org_id": state.orgId,
        "apex.node": NODE.OUTREACH,
      },
      async () => {
        if (upstreamFailed(state, STAGE.SCORING)) {
          log.warn(`skipping ${STAGE.OUTREACH} — upstream ${STAGE.SCORING} failed`);
          return {
            stagesCompleted: [STAGE.OUTREACH],
            ...stageStatus(STAGE.OUTREACH, "FAILED"),
            ...nowMsg(NODE.OUTREACH, `skipped — upstream ${STAGE.SCORING} failed`, "warn"),
          };
        }

        if (!state.approved) {
          log.log("outreach skipped — not approved");
          return {
            stagesCompleted: [STAGE.OUTREACH],
            ...stageStatus(STAGE.OUTREACH, "COMPLETE"),
            ...nowMsg(NODE.OUTREACH, "skipped (not approved)", "warn"),
          };
        }

        // Find this run's GraphRun row so the subgraph can attach artifacts to it.
        const graphRun = await deps.prisma.graphRun.findFirst({
          where: { orgId: state.orgId, threadId: state.runId },
          select: { id: true },
        });

        // per-run only: do NOT cross-pollinate org-wide leads here.
        // `state.scoredLeads` was produced exclusively by THIS run's scoring
        // node (which scopes by enrichedPersonIds); we never re-query
        // leadScore here to avoid pulling in leads from prior runs.
        const targets = state.scoredLeads
          .filter((s) => s.tier === "A" || s.tier === "B")
          .slice(0, MAX_OUTREACH);

        if (targets.length === 0) {
          // Zero qualified leads is COMPLETE, not FAILED: the ICP simply
          // didn't match anyone in the top tiers. The supervisor and the
          // UI both treat this as a normal "no-op outreach" run.
          return {
            stagesCompleted: [STAGE.OUTREACH],
            ...stageStatus(STAGE.OUTREACH, "COMPLETE"),
            ...nowMsg(NODE.OUTREACH, "no qualified leads to draft for", "warn"),
          };
        }

        // Pull person + company context in one round-trip so the subgraph can
        // skip per-lead DB lookups for fields we already have.
        const people = await deps.prisma.person.findMany({
          where: {
            id: { in: targets.map((t) => t.personId) },
            company: { orgId: state.orgId },
          },
          select: {
            id: true,
            firstName: true,
            lastName: true,
            title: true,
            emails: { select: { email: true }, take: 1 },
            company: { select: { name: true, domain: true } },
          },
        });

        const outreachResults: PipelineState["outreachResults"] = [];
        for (const person of people) {
          const email = person.emails[0]?.email;
          if (!email) {
            outreachResults.push({
              personId: person.id,
              status: "failed",
              error: "no_email",
            });
            continue;
          }

          // Skip-if-exists: if a prior partial run already drafted an artifact
          // for this recipient on this graphRun, do not re-run the subgraph
          // (do not re-burn LLM tokens, do not produce a duplicate). Audit
          // P0 #11: the SDR subgraph is in-memory-only (no checkpointer), so
          // a BullMQ retry mid-loop would re-run it for every target,
          // including ones already persisted by require_human_review.
          if (graphRun?.id) {
            const existingArtifact = await deps.prisma.outreachArtifact.findFirst({
              where: {
                orgId: state.orgId,
                graphRunId: graphRun.id,
                recipientRef: email,
              },
              select: { id: true },
            });
            if (existingArtifact) {
              outreachResults.push({
                personId: person.id,
                agentRunId: existingArtifact.id,
                status: "queued",
              });
              continue;
            }
          }

          const lead: SdrLeadInput = {
            orgId: state.orgId,
            graphRunId: graphRun?.id ?? null,
            personId: person.id,
            email,
            firstName: person.firstName,
            lastName: person.lastName,
            title: person.title,
            companyName: person.company.name,
            companyDomain: person.company.domain,
          };
          try {
            const result = await runSdrOutreachSubgraph(
              {
                prisma: deps.prisma,
                llm: deps.llm,
                outreachArtifacts: deps.outreachArtifacts,
                evidenceLedger: deps.evidenceLedger,
                runLevelEvaluator: deps.runLevelEvaluator,
              },
              lead,
            );
            outreachResults.push({
              personId: person.id,
              agentRunId: result.artifactId ?? undefined,
              status: result.artifactId ? "queued" : "failed",
              error: result.artifactId ? undefined : `qa_failed: ${result.qaIssues.join(",")}`,
            });
          } catch (err) {
            outreachResults.push({
              personId: person.id,
              status: "failed",
              error: err instanceof Error ? err.message : "unknown",
            });
          }
        }

        const queued = outreachResults.filter((r) => r.status === "queued").length;
        // PARTIAL if at least one artifact landed but not all targets
        // produced one; COMPLETE if every target got an artifact. Zero
        // artifacts from a non-empty target set is still COMPLETE for the
        // dry-run design — failures are recorded per-lead in outreachResults
        // (status="failed") and surfaced to the human reviewer, not the
        // run-level status.
        const outreachStatus: StageStatus =
          queued === targets.length ? "COMPLETE" : queued > 0 ? "PARTIAL" : "COMPLETE";
        return {
          outreachResults,
          stagesCompleted: [STAGE.OUTREACH],
          ...stageStatus(STAGE.OUTREACH, outreachStatus),
          ...nowMsg(
            NODE.OUTREACH,
            `drafted ${queued}/${targets.length} reviewable artifact(s) — no external sends`,
          ),
        };
      },
    );
  };

  const graph = new StateGraph(PipelineStateAnnotation)
    .addNode(NODE.SUPERVISOR, supervisor, {
      ends: [
        NODE.SOURCING,
        NODE.ENRICHMENT,
        NODE.SCORING,
        NODE.APPROVAL,
        NODE.OUTREACH,
        END,
      ],
    })
    .addNode(NODE.SOURCING, sourcingAgent)
    .addNode(NODE.ENRICHMENT, enrichmentAgent)
    .addNode(NODE.SCORING, scoringAgent)
    .addNode(NODE.APPROVAL, humanApproval)
    .addNode(NODE.OUTREACH, outreachAgent)
    .addEdge(START, NODE.SUPERVISOR)
    .addEdge(NODE.SOURCING, NODE.SUPERVISOR)
    .addEdge(NODE.ENRICHMENT, NODE.SUPERVISOR)
    .addEdge(NODE.SCORING, NODE.SUPERVISOR)
    .addEdge(NODE.APPROVAL, NODE.SUPERVISOR)
    .addEdge(NODE.OUTREACH, NODE.SUPERVISOR);

  return graph;
}

/** Deterministic supervisor routing: pick the next stage that hasn't run. */
function pickNext(done: Set<string>, approved: boolean): string {
  if (!done.has(STAGE.SOURCING)) return NODE.SOURCING;
  if (!done.has(STAGE.ENRICHMENT)) return NODE.ENRICHMENT;
  if (!done.has(STAGE.SCORING)) return NODE.SCORING;
  if (!done.has(STAGE.APPROVAL)) return NODE.APPROVAL;
  if (approved && !done.has(STAGE.OUTREACH)) return NODE.OUTREACH;
  return "END";
}

// keep the unused param happy for tsc when LangGraphRunnableConfig isn't referenced elsewhere
export type _GraphConfig = LangGraphRunnableConfig;
