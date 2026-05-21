import { Logger } from "@nestjs/common";
import {
  StateGraph,
  START,
  END,
  Command,
  interrupt,
  type LangGraphRunnableConfig,
} from "@langchain/langgraph";
import { PipelineStateAnnotation, NODE, STAGE, type PipelineState } from "./state";
import type { LeadsService } from "../leads/leads.service";
import type { PrismaService } from "../prisma/prisma.service";
import type { RuntimeService } from "../runtime/runtime.service";
import type { LLMService } from "../runtime/llm.service";
import type { OutreachArtifactsService } from "../outreach/outreach-artifacts.service";
import {
  runSdrOutreachSubgraph,
  type SdrLeadInput,
} from "./nodes/sdr-outreach-subgraph";

const MAX_OUTREACH = 10;
const log = new Logger("PipelineGraph");

interface Deps {
  leads: LeadsService;
  prisma: PrismaService;
  runtime: RuntimeService;
  llm: LLMService;
  outreachArtifacts: OutreachArtifactsService;
}

const nowMsg = (
  node: string,
  text: string,
  level: "info" | "warn" | "error" = "info",
) => ({
  messages: [{ node, ts: new Date().toISOString(), level, text }],
});

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
    const done = new Set(state.stagesCompleted);
    const next = pickNext(done, state.approved);
    log.log(`supervisor → ${next} (done=[${[...done].join(",")}], approved=${state.approved})`);

    return new Command({
      goto: next === "END" ? END : next,
      update: nowMsg(NODE.SUPERVISOR, `routing → ${next}`),
    });
  };

  const sourcingAgent = async (state: PipelineState): Promise<Partial<PipelineState>> => {
    const update: Partial<PipelineState> = {
      ...nowMsg(NODE.SOURCING, `sourcing for ${state.icpProfileIds.length} ICP(s)`),
    };
    const errors: PipelineState["errors"] = [];

    for (const icpId of state.icpProfileIds) {
      try {
        const { companies, people } = await deps.leads.runSourcingStage(state.orgId, icpId);
        log.log(`sourcing[${icpId}] companies=${companies} people=${people}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "unknown";
        errors.push({ node: NODE.SOURCING, error: `${icpId}: ${msg}`, ts: new Date().toISOString() });
      }
    }

    // Snapshot sourced companies into state for the UI
    const companies = await deps.prisma.company.findMany({
      where: { orgId: state.orgId },
      select: { id: true, domain: true, name: true },
      take: 200,
    });

    update.sourcedCompanies = companies;
    update.stagesCompleted = [STAGE.SOURCING];
    if (errors.length) update.errors = errors;
    return update;
  };

  const enrichmentAgent = async (state: PipelineState): Promise<Partial<PipelineState>> => {
    const update: Partial<PipelineState> = {
      ...nowMsg(NODE.ENRICHMENT, `enriching for ${state.icpProfileIds.length} ICP(s)`),
    };
    const errors: PipelineState["errors"] = [];

    for (const icpId of state.icpProfileIds) {
      try {
        const { merged, enriched } = await deps.leads.runEnrichmentStage(state.orgId, icpId);
        log.log(`enrichment[${icpId}] merged=${merged} enriched=${enriched}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "unknown";
        errors.push({ node: NODE.ENRICHMENT, error: `${icpId}: ${msg}`, ts: new Date().toISOString() });
      }
    }

    // Snapshot enriched people (those with at least one email) into state
    const people = await deps.prisma.person.findMany({
      where: { company: { orgId: state.orgId } },
      select: {
        id: true,
        companyId: true,
        firstName: true,
        lastName: true,
        title: true,
        emails: { select: { email: true }, take: 1 },
      },
      take: 200,
    });

    update.enrichedPeople = people.map((p) => ({
      id: p.id,
      companyId: p.companyId,
      firstName: p.firstName,
      lastName: p.lastName,
      title: p.title ?? undefined,
      email: p.emails[0]?.email,
    }));
    update.stagesCompleted = [STAGE.ENRICHMENT];
    if (errors.length) update.errors = errors;
    return update;
  };

  const scoringAgent = async (state: PipelineState): Promise<Partial<PipelineState>> => {
    const update: Partial<PipelineState> = {
      ...nowMsg(NODE.SCORING, `scoring for ${state.icpProfileIds.length} ICP(s)`),
    };
    const errors: PipelineState["errors"] = [];

    for (const icpId of state.icpProfileIds) {
      try {
        const { scored } = await deps.leads.runScoringStage(state.orgId, icpId);
        log.log(`scoring[${icpId}] scored=${scored}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "unknown";
        errors.push({ node: NODE.SCORING, error: `${icpId}: ${msg}`, ts: new Date().toISOString() });
      }
    }

    const scores = await deps.prisma.leadScore.findMany({
      where: { orgId: state.orgId },
      orderBy: { score: "desc" },
      take: 100,
      select: { personId: true, score: true },
    });

    update.scoredLeads = scores.map((s) => ({
      personId: s.personId,
      score: s.score,
      tier: s.score >= 75 ? "A" : s.score >= 50 ? "B" : "C",
    }));
    update.stagesCompleted = [STAGE.SCORING];
    if (errors.length) update.errors = errors;
    return update;
  };

  const humanApproval = async (
    state: PipelineState,
  ): Promise<Partial<PipelineState>> => {
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

    return {
      approved: !!decision?.approved,
      approvedBy: decision?.approvedBy ?? null,
      stagesCompleted: [STAGE.APPROVAL],
      ...nowMsg(
        NODE.APPROVAL,
        decision?.approved
          ? `approved by ${decision?.approvedBy ?? "unknown"}`
          : "rejected — skipping outreach",
      ),
    };
  };

  const outreachAgent = async (state: PipelineState): Promise<Partial<PipelineState>> => {
    if (!state.approved) {
      log.log("outreach skipped — not approved");
      return {
        stagesCompleted: [STAGE.OUTREACH],
        ...nowMsg(NODE.OUTREACH, "skipped (not approved)", "warn"),
      };
    }

    // Find this run's GraphRun row so the subgraph can attach artifacts to it.
    const graphRun = await deps.prisma.graphRun.findFirst({
      where: { orgId: state.orgId, threadId: state.runId },
      select: { id: true },
    });

    // Identify the top-tier leads we'll generate artifacts for.
    const targets = state.scoredLeads
      .filter((s) => s.tier === "A" || s.tier === "B")
      .slice(0, MAX_OUTREACH);

    if (targets.length === 0) {
      return {
        stagesCompleted: [STAGE.OUTREACH],
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
    return {
      outreachResults,
      stagesCompleted: [STAGE.OUTREACH],
      ...nowMsg(
        NODE.OUTREACH,
        `drafted ${queued}/${targets.length} reviewable artifact(s) — no external sends`,
      ),
    };
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
