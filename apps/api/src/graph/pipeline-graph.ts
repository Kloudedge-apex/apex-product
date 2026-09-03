import { Logger } from "@nestjs/common";
import type { OutreachArtifactStatus } from "@prisma/client";
import {
  StateGraph,
  START,
  END,
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
import type { LLMService } from "../runtime/llm.service";
import type { OutreachArtifactsService } from "../outreach/outreach-artifacts.service";
import type { EvidenceLedgerService } from "../observability/evidence-ledger.service";
import type { RunLevelEvaluatorService } from "../observability/run-level-evaluator.service";
import { withNodeSpan } from "../observability/graph-tracing";
import {
  runSdrOutreachSubgraph,
  type SdrLeadInput,
} from "./nodes/sdr-outreach-subgraph";
import { buildResearchNode } from "./nodes/research/research.node";
import type { SignalExtractionService } from "./nodes/research/signal-extraction.service";
import { tierForScore } from "../common/qualification.constants";
import {
  normalizeOutreachEmail,
  sameSelectedOutreachRecipient,
  selectOutreachRecipient,
} from "./outreach-recipient";
import {
  artifactFailureReason,
  effectiveArtifactStatus,
  isFailedArtifact,
} from "../outreach/outreach-artifact-failure";

const MAX_OUTREACH = 10;
const PERSON_SNAPSHOT_BATCH_SIZE = 200;
const log = new Logger("PipelineGraph");

function personIdFromArtifactPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const personId = (payload as Record<string, unknown>).personId;
  return typeof personId === "string" && personId.trim().length > 0
    ? personId.trim()
    : null;
}

interface Deps {
  leads: LeadsService;
  prisma: PrismaService;
  llm: LLMService;
  outreachArtifacts: OutreachArtifactsService;
  evidenceLedger: EvidenceLedgerService;
  signalExtraction: SignalExtractionService;
  // Optional: forwarded to the SDR subgraph so its drafter LangSmith runId
  // is wired into the run-level evaluator (audit P0 #13).
  runLevelEvaluator?: RunLevelEvaluatorService;
  /**
   * Audit P0 #12: LangSmith run id of the top-level GraphRun trace. Every
   * traced LLM call inside this graph (and any subgraph it invokes) must
   * pass this through `ChatOptions.parentRunId` so it lands under the root
   * RunTree instead of as its own orphaned top-level run. When undefined
   * the graph still runs — LLM calls just trace as before (top-level).
   */
  parentRunId?: string;
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
function stageStatus(
  stage: StageName,
  status: StageStatus,
): Partial<PipelineState> {
  return { stageStatuses: { [stage]: status } };
}

function mergePipelineState(
  state: PipelineState,
  update: Partial<PipelineState>,
): PipelineState {
  return {
    ...state,
    ...update,
    stagesCompleted: [
      ...new Set([
        ...state.stagesCompleted,
        ...(update.stagesCompleted ?? []),
      ]),
    ],
    stageStatuses: {
      ...state.stageStatuses,
      ...(update.stageStatuses ?? {}),
    },
    messages: [...state.messages, ...(update.messages ?? [])],
    errors: [...state.errors, ...(update.errors ?? [])],
  };
}

/**
 * Defensive gate: short-circuit a downstream node if a required upstream
 * stage is FAILED. In practice the throw from the upstream node already
 * stops the run, but if state is rehydrated (e.g. from a checkpoint) or a
 * test invokes a node directly we still want the gate.
 */
function upstreamFailed(state: PipelineState, upstream: StageName): boolean {
  return state.stageStatuses?.[upstream] === "FAILED";
}

function outcomeStatusForArtifact(artifact: {
  readonly status: OutreachArtifactStatus;
  readonly reviewerNote?: string | null;
  readonly failureReason?: string | null;
  readonly failedAt?: Date | null;
}): "queued" | "sent" | "persisted" | "failed" {
  if (isFailedArtifact(artifact)) return "failed";
  const status = effectiveArtifactStatus(artifact);
  if (status === "PENDING_REVIEW") return "queued";
  if (status === "SENT") return "sent";
  return "persisted";
}

/**
 * Build the autonomous SDR StateGraph. Returned graph is uncompiled — caller
 * compiles with their checkpointer of choice.
 *
 *   START → sdr_agent → END
 *
 * The single node owns the Serper-first research loop and persists each
 * intermediate result under the tenant. Drafts still land in the artifact
 * review queue; this removes the lead-level approval interruption, not the
 * final human send gate.
 */
export function buildPipelineGraph(deps: Deps) {
  const sourcingAgent = async (
    state: PipelineState,
    serperOnly: boolean,
  ): Promise<Partial<PipelineState>> => {
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
          ...nowMsg(
            NODE.SOURCING,
            `sourcing for ${state.icpProfileIds.length} ICP(s)`,
          ),
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
              await deps.leads.runSourcingStage(state.orgId, icpId, {
                serperOnly,
              });
            totalCompanies += companies;
            totalPeople += people;
            for (const id of companyIds) runCompanyIds.add(id);
            for (const id of personIds) runPersonIds.add(id);
            log.log(
              `sourcing[${icpId}] companies=${companies} people=${people}`,
            );
          } catch (err) {
            const msg = err instanceof Error ? err.message : "unknown";
            errors.push({
              node: NODE.SOURCING,
              error: `${icpId}: ${msg}`,
              ts: new Date().toISOString(),
            });
          }
        }

        await deps.evidenceLedger.leadSourced({
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
        const companies =
          companyIdList.length > 0
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
        if (
          totalCompanies === 0 &&
          totalPeople === 0 &&
          companies.length === 0
        ) {
          Object.assign(update, stageStatus(STAGE.SOURCING, "FAILED"));
          log.warn(
            `sourcing FAILED — no_leads_from_any_source for org=${state.orgId}`,
          );
          throw new StageFailureError(
            STAGE.SOURCING,
            "no_leads_from_any_source",
            `icps=${state.icpProfileIds.length}`,
          );
        }

        // PARTIAL if some ICPs errored but we still got rows; otherwise COMPLETE.
        const status: StageStatus =
          errors.length > 0 && errors.length < state.icpProfileIds.length
            ? "PARTIAL"
            : "COMPLETE";
        Object.assign(update, stageStatus(STAGE.SOURCING, status));
        return update;
      },
    );
  };

  const enrichmentAgent = async (
    state: PipelineState,
  ): Promise<Partial<PipelineState>> => {
    return withNodeSpan(
      NODE.ENRICHMENT,
      {
        "apex.run_id": state.runId,
        "apex.org_id": state.orgId,
        "apex.node": NODE.ENRICHMENT,
      },
      async () => {
        if (upstreamFailed(state, STAGE.SOURCING)) {
          log.warn(
            `skipping ${STAGE.ENRICHMENT} — upstream ${STAGE.SOURCING} failed`,
          );
          return {
            stagesCompleted: [STAGE.ENRICHMENT],
            ...stageStatus(STAGE.ENRICHMENT, "FAILED"),
            ...nowMsg(
              NODE.ENRICHMENT,
              `skipped — upstream ${STAGE.SOURCING} failed`,
              "warn",
            ),
          };
        }

        const update: Partial<PipelineState> = {
          ...nowMsg(
            NODE.ENRICHMENT,
            `enriching for ${state.icpProfileIds.length} ICP(s)`,
          ),
        };
        const errors: PipelineState["errors"] = [];

        let totalEnriched = 0;
        // per-run only: do NOT cross-pollinate org-wide leads here. We
        // accumulate the person IDs touched in THIS run and pass them as
        // the scope to subsequent stages.
        const runPersonIds = new Set<string>(state.sourcedPersonIds);
        for (const icpId of state.icpProfileIds) {
          try {
            const { merged, enriched, personIds } =
              await deps.leads.runEnrichmentStage(
                state.orgId,
                icpId,
                state.sourcedPersonIds,
              );
            totalEnriched += enriched;
            for (const id of personIds) runPersonIds.add(id);
            log.log(
              `enrichment[${icpId}] merged=${merged} enriched=${enriched}`,
            );
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
        // Snapshot every person THIS run sourced/enriched. Keep each `IN`
        // predicate bounded without truncating the run-level state: scoring
        // still covers the full ID set, so outreach needs a recipient snapshot
        // for that same set.
        const personIdList = [...runPersonIds];
        const fetchPeople = (ids: string[]) =>
          deps.prisma.person.findMany({
            where: {
              company: { orgId: state.orgId },
              id: { in: ids },
            },
            select: {
              id: true,
              companyId: true,
              firstName: true,
              lastName: true,
              title: true,
              emails: {
                select: {
                  id: true,
                  email: true,
                  source: true,
                  verified: true,
                  verificationResult: true,
                  confidence: true,
                  verifiedAt: true,
                  createdAt: true,
                },
              },
            },
            orderBy: { id: "asc" },
          });
        type SnapshotPerson = Awaited<ReturnType<typeof fetchPeople>>[number];
        const people: SnapshotPerson[] = [];
        for (
          let offset = 0;
          offset < personIdList.length;
          offset += PERSON_SNAPSHOT_BATCH_SIZE
        ) {
          const ids = personIdList.slice(
            offset,
            offset + PERSON_SNAPSHOT_BATCH_SIZE,
          );
          people.push(...(await fetchPeople(ids)));
        }
        people.sort((a, b) => a.id.localeCompare(b.id));

        const enrichedPeople = people.map((p) => {
          const recipient = selectOutreachRecipient(p.emails);
          return {
            id: p.id,
            companyId: p.companyId,
            firstName: p.firstName,
            lastName: p.lastName,
            title: p.title ?? undefined,
            email: recipient?.email,
            recipient: recipient ?? undefined,
          };
        });
        update.enrichedPeople = enrichedPeople;
        update.enrichedPersonIds = personIdList;
        update.stagesCompleted = [STAGE.ENRICHMENT];
        if (errors.length) update.errors = errors;

        // FAILED iff sourcing produced rows but enrichment landed nothing
        // useful (no enriched contacts and none with an email in the DB).
        const inputRows = state.sourcedCompanies.length;
        const enrichedWithEmail = enrichedPeople.filter(
          (p) => !!p.email,
        ).length;
        if (totalEnriched === 0 && enrichedWithEmail === 0 && inputRows > 0) {
          Object.assign(update, stageStatus(STAGE.ENRICHMENT, "FAILED"));
          log.warn(
            `enrichment FAILED — enrichment_yielded_zero (input_companies=${inputRows})`,
          );
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
          errors.length > 0 || enrichedWithEmail < inputRows
            ? "PARTIAL"
            : "COMPLETE";
        Object.assign(update, stageStatus(STAGE.ENRICHMENT, status));
        return update;
      },
    );
  };

  const scoringAgent = async (
    state: PipelineState,
  ): Promise<Partial<PipelineState>> => {
    return withNodeSpan(
      NODE.SCORING,
      {
        "apex.run_id": state.runId,
        "apex.org_id": state.orgId,
        "apex.node": NODE.SCORING,
      },
      async () => {
        if (upstreamFailed(state, STAGE.ENRICHMENT)) {
          log.warn(
            `skipping ${STAGE.SCORING} — upstream ${STAGE.ENRICHMENT} failed`,
          );
          return {
            stagesCompleted: [STAGE.SCORING],
            ...stageStatus(STAGE.SCORING, "FAILED"),
            ...nowMsg(
              NODE.SCORING,
              `skipped — upstream ${STAGE.ENRICHMENT} failed`,
              "warn",
            ),
          };
        }

        const startedAt = Date.now();
        const update: Partial<PipelineState> = {
          ...nowMsg(
            NODE.SCORING,
            `scoring for ${state.icpProfileIds.length} ICP(s)`,
          ),
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

        await deps.evidenceLedger.leadScored({
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
        const scores =
          scoredIdList.length > 0
            ? await deps.prisma.leadScore.findMany({
                where: { orgId: state.orgId, personId: { in: scoredIdList } },
                orderBy: [{ score: "desc" }, { personId: "asc" }],
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
        if (
          totalScored === 0 &&
          scoredLeads.length === 0 &&
          state.enrichedPeople.length > 0
        ) {
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

  const outreachAgent = async (
    state: PipelineState,
  ): Promise<Partial<PipelineState>> => {
    return withNodeSpan(
      NODE.OUTREACH,
      {
        "apex.run_id": state.runId,
        "apex.org_id": state.orgId,
        "apex.node": NODE.OUTREACH,
      },
      async () => {
        const failedUpstream = upstreamFailed(state, STAGE.SCORING)
          ? STAGE.SCORING
          : upstreamFailed(state, STAGE.RESEARCH)
            ? STAGE.RESEARCH
            : null;
        if (failedUpstream) {
          log.warn(
            `skipping ${STAGE.OUTREACH} — upstream ${failedUpstream} failed`,
          );
          return {
            stagesCompleted: [STAGE.OUTREACH],
            ...stageStatus(STAGE.OUTREACH, "FAILED"),
            ...nowMsg(
              NODE.OUTREACH,
              `skipped — upstream ${failedUpstream} failed`,
              "warn",
            ),
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
            emails: {
              select: {
                id: true,
                email: true,
                source: true,
                verified: true,
                verificationResult: true,
                confidence: true,
                verifiedAt: true,
                createdAt: true,
              },
            },
            company: { select: { name: true, domain: true } },
          },
        });

        const outreachResults: PipelineState["outreachResults"] = [];
        const peopleById = new Map(people.map((person) => [person.id, person]));
        const enrichedById = new Map(
          state.enrichedPeople.map((person) => [person.id, person]),
        );
        const claimedRecipients = new Map<string, string>();

        // Preserve the score-ranked target order rather than relying on
        // unspecified Prisma row order. Missing/cross-org rows remain visible
        // as failures instead of silently shrinking the denominator.
        for (const target of targets) {
          const person = peopleById.get(target.personId);
          if (!person) {
            outreachResults.push({
              personId: target.personId,
              status: "failed",
              error: "person_not_found_or_cross_org",
            });
            continue;
          }

          // The enrichment stage chooses and snapshots one eligible candidate.
          // Outreach must use that exact address so a DB ordering/change between
          // approval and drafting cannot silently redirect the message.
          const enrichedPerson = enrichedById.get(person.id);
          let recipient = enrichedPerson?.recipient;
          const legacyEmail = enrichedPerson?.email;
          const currentRecipient = selectOutreachRecipient(person.emails);
          if (
            recipient &&
            (!currentRecipient ||
              !sameSelectedOutreachRecipient(recipient, currentRecipient))
          ) {
            outreachResults.push({
              personId: person.id,
              status: "failed",
              error: "recipient_snapshot_requires_reconciliation",
            });
            continue;
          }
          if (!recipient && legacyEmail !== undefined) {
            const normalizedLegacyEmail = normalizeOutreachEmail(legacyEmail);
            if (
              !normalizedLegacyEmail ||
              !currentRecipient ||
              currentRecipient.email !== normalizedLegacyEmail
            ) {
              outreachResults.push({
                personId: person.id,
                status: "failed",
                error: "legacy_recipient_requires_reconciliation",
              });
              continue;
            }
            recipient = currentRecipient;
          }
          if (!recipient) {
            outreachResults.push({
              personId: person.id,
              status: "failed",
              error: "no_eligible_email",
            });
            continue;
          }
          const email = recipient.email;

          // Skip-if-exists: if a prior partial run already drafted an artifact
          // for this recipient on this graphRun, do not re-run the subgraph
          // (do not re-burn LLM tokens, do not produce a duplicate). Audit
          // P0 #11: the SDR subgraph is in-memory-only (no checkpointer), so
          // a BullMQ retry mid-loop would re-run it for every target,
          // including ones already persisted by require_human_review.
          if (graphRun?.id) {
            const existingArtifact =
              await deps.prisma.outreachArtifact.findFirst({
                where: {
                  orgId: state.orgId,
                  graphRunId: graphRun.id,
                  toolName: "send_email",
                  recipientRef: email,
                },
                select: {
                  id: true,
                  status: true,
                  payload: true,
                  reviewerNote: true,
                  failureReason: true,
                  failedAt: true,
                },
              });
            if (existingArtifact) {
              const payloadPersonId = personIdFromArtifactPayload(
                existingArtifact.payload,
              );
              if (payloadPersonId !== person.id) {
                outreachResults.push({
                  personId: person.id,
                  status: "failed",
                  error: payloadPersonId
                    ? "recipient_already_targeted_in_run"
                    : "existing_artifact_requires_reconciliation",
                  recipient,
                });
                continue;
              }
              const claimedByPersonId = claimedRecipients.get(email);
              if (claimedByPersonId) {
                outreachResults.push({
                  personId: person.id,
                  status: "failed",
                  error:
                    claimedByPersonId === person.id
                      ? "duplicate_target_in_run"
                      : "recipient_already_targeted_in_run",
                  recipient,
                });
                continue;
              }
              claimedRecipients.set(email, person.id);
              const effectiveStatus =
                effectiveArtifactStatus(existingArtifact);
              const outcomeStatus = outcomeStatusForArtifact(existingArtifact);
              outreachResults.push({
                personId: person.id,
                agentRunId: existingArtifact.id,
                status: outcomeStatus,
                artifactStatus: effectiveStatus,
                ...(outcomeStatus === "failed"
                  ? {
                      error:
                        artifactFailureReason(existingArtifact) ??
                        "dispatch_failed",
                    }
                  : {}),
                recipient,
              });
              continue;
            }
          }

          const claimedByPersonId = claimedRecipients.get(email);
          if (claimedByPersonId) {
            outreachResults.push({
              personId: person.id,
              status: "failed",
              error:
                claimedByPersonId === person.id
                  ? "duplicate_target_in_run"
                  : "recipient_already_targeted_in_run",
              recipient,
            });
            continue;
          }
          claimedRecipients.set(email, person.id);

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
            recipientProvenance: recipient,
          };
          try {
            const result = await runSdrOutreachSubgraph(
              {
                prisma: deps.prisma,
                llm: deps.llm,
                outreachArtifacts: deps.outreachArtifacts,
                evidenceLedger: deps.evidenceLedger,
                runLevelEvaluator: deps.runLevelEvaluator,
                // Audit P0 #12: thread the GraphRun's root LangSmith run id
                // into the subgraph so the drafter LLM call lands as a child
                // of the GraphRun trace, not as a separate top-level run.
                parentRunId: deps.parentRunId,
              },
              lead,
            );
            const artifactStatus = result.artifactId
              ? (result.artifactStatus ?? "PENDING_REVIEW")
              : undefined;
            outreachResults.push({
              personId: person.id,
              agentRunId: result.artifactId ?? undefined,
              status:
                result.artifactId && artifactStatus
                  ? outcomeStatusForArtifact({ status: artifactStatus })
                  : "failed",
              ...(artifactStatus ? { artifactStatus } : {}),
              error:
                result.artifactId && artifactStatus !== "FAILED"
                  ? undefined
                  : result.artifactId
                    ? "dispatch_failed"
                    : `qa_failed: ${result.qaIssues.join(",")}`,
              recipient,
            });
          } catch (err) {
            outreachResults.push({
              personId: person.id,
              status: "failed",
              error: err instanceof Error ? err.message : "unknown",
              recipient,
            });
          }
        }

        const artifactsById = new Map(
          outreachResults
            .filter((result) => !!result.agentRunId)
            .map((result) => [result.agentRunId!, result]),
        );
        const persistedResults = [...artifactsById.values()];
        const generated = artifactsById.size;
        const pendingReview = persistedResults.filter(
          (result) => result.artifactStatus === "PENDING_REVIEW",
        ).length;
        const sent = persistedResults.filter(
          (result) => result.artifactStatus === "SENT",
        ).length;
        const failedPersisted = persistedResults.filter(
          (result) => result.status === "failed",
        ).length;
        const failedOutcomes = outreachResults.filter(
          (result) => result.status === "failed",
        ).length;
        const successfulOutcomes = outreachResults.length - failedOutcomes;
        const otherPersisted =
          generated - pendingReview - sent - failedPersisted;
        // PARTIAL if at least one artifact landed but not all targets
        // produced one; COMPLETE if every target got a persisted artifact;
        // FAILED if a non-empty target set produced none.
        const outreachStatus: StageStatus =
          failedOutcomes === 0 && generated === targets.length
            ? "COMPLETE"
            : successfulOutcomes > 0
              ? "PARTIAL"
              : "FAILED";
        return {
          outreachResults,
          stagesCompleted: [STAGE.OUTREACH],
          ...stageStatus(STAGE.OUTREACH, outreachStatus),
          ...nowMsg(
            NODE.OUTREACH,
            `artifacts present for ${generated}/${targets.length} target(s): ${pendingReview} pending review, ${sent} sent, ${failedOutcomes} failed, ${otherPersisted} other persisted`,
            outreachStatus === "FAILED" ? "error" : "info",
          ),
        };
      },
    );
  };

  const researchAgent = buildResearchNode({
    prisma: deps.prisma,
    signalExtraction: deps.signalExtraction,
    evidenceLedger: deps.evidenceLedger,
  });

  const autonomousSdrAgent = async (
    state: PipelineState,
  ): Promise<Partial<PipelineState>> =>
    withNodeSpan(
      NODE.AUTONOMOUS_SDR,
      {
        "apex.run_id": state.runId,
        "apex.org_id": state.orgId,
        "apex.node": NODE.AUTONOMOUS_SDR,
      },
      async () => {
        let current = mergePipelineState(
          state,
          nowMsg(
            NODE.AUTONOMOUS_SDR,
            "starting Serper-first research, scoring, and draft loop",
          ),
        );
        current = mergePipelineState(
          current,
          await sourcingAgent(current, true),
        );
        current = mergePipelineState(
          current,
          await enrichmentAgent(current),
        );
        current = mergePipelineState(current, await scoringAgent(current));
        current = mergePipelineState(current, await researchAgent(current));
        current = mergePipelineState(
          current,
          await outreachAgent({ ...current, approved: true }),
        );

        return {
          sourcedCompanies: current.sourcedCompanies,
          sourcedPersonIds: current.sourcedPersonIds,
          enrichedPeople: current.enrichedPeople,
          enrichedPersonIds: current.enrichedPersonIds,
          scoredLeads: current.scoredLeads,
          outreachResults: current.outreachResults,
          stagesCompleted: current.stagesCompleted.filter(
            (stage) => !state.stagesCompleted.includes(stage),
          ),
          stageStatuses: current.stageStatuses,
          messages: current.messages.slice(state.messages.length),
          errors: current.errors.slice(state.errors.length),
        };
      },
    );

  const graph = new StateGraph(PipelineStateAnnotation)
    .addNode(NODE.AUTONOMOUS_SDR, autonomousSdrAgent)
    .addEdge(START, NODE.AUTONOMOUS_SDR)
    .addEdge(NODE.AUTONOMOUS_SDR, END);

  return graph;
}

// keep the unused param happy for tsc when LangGraphRunnableConfig isn't referenced elsewhere
export type _GraphConfig = LangGraphRunnableConfig;
