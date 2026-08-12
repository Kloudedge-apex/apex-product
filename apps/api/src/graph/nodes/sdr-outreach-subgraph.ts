/**
 * SDR outreach subgraph — per-lead pipeline that produces a reviewable
 * OutreachArtifact (no external send). Composes four nodes:
 *
 *   build_research_brief → draft_message → qa_message → require_human_review
 *
 * QA can route back to drafting up to MAX_DRAFT_ATTEMPTS - 1 times if it
 * flags issues. After that it lands on require_human_review with the
 * issues attached, so a human can decide whether to fix or reject.
 *
 * This subgraph is intentionally self-contained: it owns its state and
 * checkpointing is the caller's choice. The outer pipeline graph invokes
 * it once per qualified lead from `outreach_agent`.
 */
import { Logger } from "@nestjs/common";
import { Annotation, StateGraph, START, END } from "@langchain/langgraph";
import type { PrismaService } from "../../prisma/prisma.service";
import type { LLMService } from "../../runtime/llm.service";
import type { OutreachArtifactsService } from "../../outreach/outreach-artifacts.service";
import type { EvidenceLedgerService } from "../../observability/evidence-ledger.service";
import type { RunLevelEvaluatorService } from "../../observability/run-level-evaluator.service";
import { withNodeSpan } from "../../observability/graph-tracing";
import { isMocked } from "../../runtime/tools/mock-metadata";
import { isFresh } from "./research/freshness";

const log = new Logger("SdrOutreachSubgraph");

const MAX_DRAFT_ATTEMPTS = 2;
const MAX_SUBJECT_LEN = 120;
const MAX_BODY_LEN = 2000;
const MIN_BODY_LEN = 30;
const MAX_RECENT_EVIDENCE_EVENTS = 5;
const EVIDENCE_EVENT_PAGE_SIZE = 25;
const MAX_EVIDENCE_EVENTS_SCANNED = 100;

/** Substrings that, if present, mean the LLM left a placeholder unfilled. */
const PLACEHOLDER_LEAKS = ["{{", "}}", "[FIRST_NAME]", "[COMPANY]", "TODO", "<insert"];

/**
 * Evidence-event kinds we surface as grounding signals in the research brief.
 * Order matters for fact_id assignment (S1, S2, …) but not for ranking — the
 * caller takes the most recent N regardless of kind.
 */
const SIGNAL_KINDS = new Set([
  "recent_hire",
  "funding_event",
  "product_launch",
  "leadership_change",
  "press_mention",
  "intent_signal",
]);

export interface BriefFact {
  readonly id: string; // "F1", "P1", "S1", "ICP1", …
  readonly category: "firmographic" | "person" | "signal" | "icp_fit";
  readonly source: string;
  readonly text: string;
  readonly date?: string; // ISO date if known (signals)
}

export interface ResearchBrief {
  readonly xml: string; // rendered for the LLM
  readonly facts: readonly BriefFact[];
  readonly doNotClaim: readonly string[];
  readonly hasGroundingSignal: boolean; // true if ≥1 fact in <signals>
}

export interface SdrLeadInput {
  readonly orgId: string;
  readonly graphRunId?: string | null;
  readonly personId: string;
  readonly email: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly title?: string | null;
  readonly companyName: string;
  readonly companyDomain: string;
}

export interface SdrLeadResult {
  readonly personId: string;
  readonly artifactId: string | null;
  readonly subject: string;
  readonly body: string;
  readonly qaIssues: readonly string[];
  readonly draftAttempts: number;
  readonly refusal: DrafterRefusal | null;
  readonly groundednessSelfCheck: GroundednessSelfCheck | null;
}

export interface DrafterRefusal {
  readonly reason: string;
  readonly missing: readonly string[];
}

export interface GroundednessSelfCheck {
  readonly citedFactIds: readonly string[];
  readonly unsupportedClaims: readonly string[];
}

/**
 * Optional drafter override so tests can run the subgraph without hitting
 * a real LLM. Production wires LLMService.chat via the default drafter.
 *
 * The optional `onRunId` callback fires when the LLM call has a LangSmith
 * run id available. We use it to stash the runId on the OutreachArtifact so
 * a reviewer rejecting the draft can later append that run to a regression
 * dataset (see OutreachArtifactsService.reject).
 */
export type DrafterFn = (input: DrafterInput) => Promise<DrafterOutput>;

export interface DrafterInput {
  readonly brief: ResearchBrief;
  readonly lead: SdrLeadInput;
  readonly previousAttempt?: { subject: string; body: string; issues: readonly string[] };
  readonly onRunId?: (runId: string) => void;
  /**
   * Audit P0 #12: GraphRun-level LangSmith root run id, propagated from the
   * outer pipeline graph so the drafter LLM call lands as a child of the
   * GraphRun trace. Optional — when absent, the call traces as before
   * (top-level) so test/dev paths without a root keep working.
   */
  readonly parentRunId?: string;
}

export interface DrafterOutput {
  readonly subject: string;
  readonly body: string;
  readonly refusal: DrafterRefusal | null;
  readonly groundednessSelfCheck: GroundednessSelfCheck | null;
}

export interface SubgraphDeps {
  readonly prisma: PrismaService;
  readonly llm: LLMService;
  readonly outreachArtifacts: OutreachArtifactsService;
  readonly evidenceLedger: EvidenceLedgerService;
  // Optional: when supplied, the SDR drafter wires its LangSmith runId to
  // run-level feedback so the run completes-rate/qualified-leads/etc.
  // evaluators have a parent run to attach to. Audit P0 #13.
  readonly runLevelEvaluator?: RunLevelEvaluatorService;
  /**
   * Audit P0 #12: GraphRun-level LangSmith root run id. Threaded through to
   * the drafter LLM call so it lands as a child of the GraphRun trace
   * instead of as its own orphaned top-level run.
   */
  readonly parentRunId?: string;
  readonly drafter?: DrafterFn;
}

// ── Internal subgraph state ────────────────────────────────────────────────

const SdrStateAnnotation = Annotation.Root({
  lead: Annotation<SdrLeadInput>({
    reducer: (_p, n) => n,
    default: () =>
      ({
        orgId: "",
        personId: "",
        email: "",
        firstName: "",
        lastName: "",
        companyName: "",
        companyDomain: "",
      }) as SdrLeadInput,
  }),
  researchBrief: Annotation<ResearchBrief>({
    reducer: (_p, n) => n,
    default: () => ({ xml: "", facts: [], doNotClaim: [], hasGroundingSignal: false }),
  }),
  subject: Annotation<string>({
    reducer: (_p, n) => n,
    default: () => "",
  }),
  body: Annotation<string>({
    reducer: (_p, n) => n,
    default: () => "",
  }),
  refusal: Annotation<DrafterRefusal | null>({
    reducer: (_p, n) => n,
    default: () => null,
  }),
  groundednessSelfCheck: Annotation<GroundednessSelfCheck | null>({
    reducer: (_p, n) => n,
    default: () => null,
  }),
  draftAttempts: Annotation<number>({
    reducer: (_p, n) => n,
    default: () => 0,
  }),
  qaIssues: Annotation<string[]>({
    reducer: (_p, n) => n,
    default: () => [],
  }),
  artifactId: Annotation<string | null>({
    reducer: (_p, n) => n,
    default: () => null,
  }),
  // LangSmith run id of the most recent draft_message LLM call. Captured via
  // LLMService.onRunStart and stashed on the artifact so a HITL reject can
  // append the run to a regression dataset. Best-effort: empty if tracing is
  // disabled or the SDK is unavailable.
  langsmithRunId: Annotation<string | null>({
    reducer: (_p, n) => n,
    default: () => null,
  }),
});

type SdrState = typeof SdrStateAnnotation.State;

export const SDR_NODE = {
  BRIEF: "build_research_brief",
  DRAFT: "draft_message",
  QA: "qa_message",
  REVIEW: "require_human_review",
} as const;

// ── Helpers ────────────────────────────────────────────────────────────────

function qaCheck(
  subject: string,
  body: string,
  refusal: DrafterRefusal | null,
  selfCheck: GroundednessSelfCheck | null,
  briefFacts: readonly BriefFact[],
): string[] {
  // Refusals are not "QA failures" to retry — they're a first-class outcome
  // and route straight to human review with the reason preserved.
  if (refusal) {
    return [`refusal:${refusal.reason}`];
  }
  const issues: string[] = [];
  if (subject.length === 0) issues.push("empty_subject");
  if (subject.length > MAX_SUBJECT_LEN) issues.push(`subject_too_long(${subject.length})`);
  if (body.length < MIN_BODY_LEN) issues.push(`body_too_short(${body.length})`);
  if (body.length > MAX_BODY_LEN) issues.push(`body_too_long(${body.length})`);
  const combined = `${subject}\n${body}`;
  for (const needle of PLACEHOLDER_LEAKS) {
    if (combined.includes(needle)) {
      issues.push(`placeholder_leak(${needle})`);
    }
  }
  // Citation gate (audit B3): a non-refusal draft must declare which brief
  // facts it used, every cited id must exist in the brief, and the model must
  // not have flagged its own sentences as unsupported. The prompt's
  // `groundedness_self_check` field proves nothing on its own — this is where
  // "every email cites a real, dated trigger or refuses" actually fails a
  // draft. Citation issues retry like any other QA issue (the refusal
  // early-return above keeps refusals un-retried), then land on human review
  // with the issues attached.
  const cited = selfCheck?.citedFactIds ?? [];
  if (cited.length === 0) {
    issues.push("no_cited_facts");
  } else {
    const knownIds = new Set(briefFacts.map((f) => f.id));
    for (const id of cited) {
      if (!knownIds.has(id)) issues.push(`unknown_fact_id(${id})`);
    }
  }
  const unsupported = selfCheck?.unsupportedClaims ?? [];
  if (unsupported.length > 0) {
    issues.push(`unsupported_claims(${unsupported.length})`);
  }
  return issues;
}

/**
 * Refusal envelope emitted by the in-code evidence gate (audit B3). Mirrors
 * the prompt's <refusal_protocol> shape exactly so a code refusal and a model
 * refusal are indistinguishable downstream (QA routing, artifact payload,
 * reviewer UI).
 */
const UNGROUNDED_REFUSAL: DrafterRefusal = {
  reason: "insufficient_grounding",
  missing: ["signals"],
};

// XML-scaffolded SDR draft prompt. The grounding rules + refusal protocol +
// `groundedness_self_check` field together collapse the previous 3-line prompt's
// hallucination surface: the model can no longer invent specifics to satisfy
// "reference a specific signal" because (a) the brief lists explicit fact_ids,
// (b) refusal is a first-class JSON output, and (c) the model declares which
// fact_ids it used in the self-check, giving evaluators a deterministic citation.
const SDR_DRAFT_SYSTEM_PROMPT = `You are an outbound SDR writing on behalf of the sender's organization.

<role>
Write one short cold email to one named buyer. You are calibrated for
deliverability and grounding, not creativity. Your output is reviewed
by a human before sending.
</role>

<grounding_rules>
1. Only state facts that appear verbatim or paraphrase a fact in <brief>.
2. Every concrete claim about the prospect, their company, their stack,
   their funding, hiring, or product MUST be supported by a brief item.
   You will cite the supporting fact_id in groundedness_self_check.
3. If a fact is not in <brief>, you may NOT use it. Do not infer industry,
   company size, tech stack, funding stage, or pain points from the
   company name or title alone.
4. Do not use boilerplate like "I hope this finds you well", "quick
   question", "I help companies like yours", "circling back",
   "just checking in", or em-dashes.
5. Never invent named entities (people, products, customers, metrics).
6. If <brief> contains a <do_not_claim> item, you may not contradict it.
</grounding_rules>

<refusal_protocol>
If <brief> does not contain at least ONE specific behavioral or
firmographic signal you can ground on (e.g. recent_hire, funding_event,
product_launch, website_excerpt, tech_signal), refuse the draft.
Return:
{
  "subject": null,
  "body": null,
  "refusal": {
    "reason": "insufficient_grounding",
    "missing": ["<which signal categories are absent>"]
  },
  "groundedness_self_check": { "unsupported_claims": [], "cited_fact_ids": [] }
}
</refusal_protocol>

<output_schema>
Return ONLY valid JSON matching this shape, no markdown, no preamble:
{
  "subject": "string, 3-9 words, no emoji, no clickbait, plaintext",
  "body": "string, 60-180 words, plaintext, reference at least one cited fact_id",
  "refusal": null,
  "groundedness_self_check": {
    "cited_fact_ids": ["array of fact_id strings from <brief> you used"],
    "unsupported_claims": ["array of any sentence you suspect is not grounded; empty array if confident"]
  }
}
</output_schema>

<style>
Plaintext only. One specific signal in line 1. One sentence on relevance
to the buyer's role. One soft CTA (e.g. "worth a 15-min look?"). No
hard-sell. Reading level: 5th-6th grade (short sentences, common words).
</style>`;

function renderUserPrompt(input: DrafterInput): string {
  const previous = input.previousAttempt
    ? `\n<previous_attempt_feedback>\nFlagged issues: ${input.previousAttempt.issues.join(", ")}. Fix them.\n</previous_attempt_feedback>\n`
    : "";

  return `<brief>
${input.brief.xml}
</brief>

<lead>
  <firstName>${escapeXml(input.lead.firstName)}</firstName>
  <lastName>${escapeXml(input.lead.lastName)}</lastName>
  <title>${escapeXml(input.lead.title ?? "")}</title>
  <companyName>${escapeXml(input.lead.companyName)}</companyName>
  <domain>${escapeXml(input.lead.companyDomain)}</domain>
</lead>
${previous}
Draft the email now. Remember: refuse if no specific signal is available.`;
}

async function defaultDrafter(
  llm: LLMService,
  input: DrafterInput,
  evidenceLedger: EvidenceLedgerService,
): Promise<DrafterOutput> {
  const startedAt = Date.now();
  const resp = await llm.chat(
    [
      { role: "system", content: SDR_DRAFT_SYSTEM_PROMPT },
      { role: "user", content: renderUserPrompt(input) },
    ],
    {
      maxTokens: 700,
      agent: "sdr_agent.draft_message",
      node: "sdr_outreach.draft_message",
      tags: ["sdr_outreach", "draft_message", "customer_facing"],
      // Audit P0 #12: anchor this LLM run under the GraphRun's root LangSmith
      // run so cross-pod resume after HITL approval can reattach. Without
      // this the draft lands as a separate top-level run with no parent.
      parentRunId: input.parentRunId,
      metadata: {
        org_id: input.lead.orgId,
        person_id: input.lead.personId,
        graph_run_id: input.lead.graphRunId ?? null,
        draft_attempt: input.previousAttempt ? "retry" : "first",
        brief_fact_count: input.brief.facts.length,
        brief_has_signal: input.brief.hasGroundingSignal,
      },
      // Capture the LangSmith runId so the artifact can be linked back to its
      // generating trace. We record only the latest attempt's runId — that's
      // the draft a human actually reviews.
      onRunStart: input.onRunId
        ? (runId): void => {
            input.onRunId?.(runId);
          }
        : undefined,
    },
  );

  void evidenceLedger.messageDrafted({
    orgId: input.lead.orgId,
    runId: input.lead.graphRunId ?? null,
    personId: input.lead.personId,
    model: resp.model,
    tokensUsed: resp.tokensUsed,
    costUsd: resp.cost,
    durationMs: Date.now() - startedAt,
  });

  return parseDrafterJson(resp.content);
}

function parseDrafterJson(raw: string): DrafterOutput {
  const empty: DrafterOutput = {
    subject: "",
    body: "",
    refusal: null,
    groundednessSelfCheck: null,
  };
  const trimmed = raw.trim();
  // Strip ```json fences if the model added them despite the instruction.
  const cleaned = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    const parsed = JSON.parse(cleaned) as {
      subject?: unknown;
      body?: unknown;
      refusal?: unknown;
      groundedness_self_check?: unknown;
    };
    const subject = typeof parsed.subject === "string" ? parsed.subject : "";
    const body = typeof parsed.body === "string" ? parsed.body : "";
    const refusal = parseRefusal(parsed.refusal);
    const selfCheck = parseSelfCheck(parsed.groundedness_self_check);
    return { subject, body, refusal, groundednessSelfCheck: selfCheck };
  } catch {
    return empty;
  }
}

function parseRefusal(raw: unknown): DrafterRefusal | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const reason = typeof obj.reason === "string" ? obj.reason : null;
  if (!reason) return null;
  const missing = Array.isArray(obj.missing)
    ? obj.missing.filter((m): m is string => typeof m === "string")
    : [];
  return { reason, missing };
}

function parseSelfCheck(raw: unknown): GroundednessSelfCheck | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const cited = Array.isArray(obj.cited_fact_ids)
    ? obj.cited_fact_ids.filter((m): m is string => typeof m === "string")
    : [];
  const unsupported = Array.isArray(obj.unsupported_claims)
    ? obj.unsupported_claims.filter((m): m is string => typeof m === "string")
    : [];
  return { citedFactIds: cited, unsupportedClaims: unsupported };
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Subgraph builder ───────────────────────────────────────────────────────

export function buildSdrOutreachSubgraph(deps: SubgraphDeps) {
  const drafter: DrafterFn =
    deps.drafter ?? ((input) => defaultDrafter(deps.llm, input, deps.evidenceLedger));

  const buildResearchBrief = async (state: SdrState): Promise<Partial<SdrState>> => {
    return withNodeSpan(
      SDR_NODE.BRIEF,
      {
        "apex.run_id": state.lead.graphRunId ?? "unknown",
        "apex.org_id": state.lead.orgId,
        "apex.node": SDR_NODE.BRIEF,
        "apex.lead.person_id": state.lead.personId,
      },
      async () => {
        const brief = await assembleResearchBrief(deps.prisma, state.lead);
        return { researchBrief: brief };
      },
    );
  };

  const draftMessage = async (state: SdrState): Promise<Partial<SdrState>> => {
    return withNodeSpan(
      SDR_NODE.DRAFT,
      {
        "apex.run_id": state.lead.graphRunId ?? "unknown",
        "apex.org_id": state.lead.orgId,
        "apex.node": SDR_NODE.DRAFT,
        "apex.lead.person_id": state.lead.personId,
      },
      async () => {
        // Evidence gate (audit B3): refusal on an ungrounded brief is enforced
        // IN CODE, before any LLM call. Zero dated grounding signals means
        // there is nothing citable, so drafting must not start — the prompt's
        // <refusal_protocol> stays as defense-in-depth, but trusting the model
        // to refuse would make the wedge probabilistic. Same envelope as a
        // model refusal so routeAfterQa sends it straight to human review.
        if (!state.researchBrief.hasGroundingSignal) {
          return {
            subject: "",
            body: "",
            refusal: UNGROUNDED_REFUSAL,
            groundednessSelfCheck: { citedFactIds: [], unsupportedClaims: [] },
            draftAttempts: state.draftAttempts + 1,
            langsmithRunId: null,
          };
        }

        const previous =
          state.draftAttempts > 0 && state.qaIssues.length > 0
            ? { subject: state.subject, body: state.body, issues: state.qaIssues }
            : undefined;

        let capturedRunId: string | null = null;
        try {
          const out = await drafter({
            brief: state.researchBrief,
            lead: state.lead,
            previousAttempt: previous,
            // Audit P0 #12: forward the GraphRun's root LangSmith run id so
            // the drafter's LLM call reattaches as a child instead of a
            // separate top-level run.
            parentRunId: deps.parentRunId,
            onRunId: (runId): void => {
              capturedRunId = runId;
              // Audit P0 #13: forward the LangSmith root run id to the
              // run-level evaluator so its terminal feedback (composite score,
              // qualified-leads, send-rate, approval-drop-off) actually
              // attaches to a parent run. Without this wire, postFeedback at
              // run-level-evaluator.service.ts:245 logs "no langsmith root
              // run for graphRun=..." for every terminal GraphRun.
              if (deps.runLevelEvaluator && state.lead.graphRunId) {
                deps.runLevelEvaluator.recordLangSmithRunId(
                  state.lead.graphRunId,
                  runId,
                );
              }
            },
          });
          return {
            subject: out.subject,
            body: out.body,
            refusal: out.refusal,
            groundednessSelfCheck: out.groundednessSelfCheck,
            draftAttempts: state.draftAttempts + 1,
            langsmithRunId: capturedRunId,
          };
        } catch (err) {
          log.warn(
            `drafter failed for person=${state.lead.personId}: ${err instanceof Error ? err.message : "unknown"}`,
          );
          return {
            subject: "",
            body: "",
            refusal: null,
            groundednessSelfCheck: null,
            draftAttempts: state.draftAttempts + 1,
            langsmithRunId: capturedRunId,
          };
        }
      },
    );
  };

  const qaMessage = async (state: SdrState): Promise<Partial<SdrState>> => {
    return withNodeSpan(
      SDR_NODE.QA,
      {
        "apex.run_id": state.lead.graphRunId ?? "unknown",
        "apex.org_id": state.lead.orgId,
        "apex.node": SDR_NODE.QA,
        "apex.lead.person_id": state.lead.personId,
      },
      async () => {
        const startedAt = Date.now();
        const issues = qaCheck(
          state.subject,
          state.body,
          state.refusal,
          state.groundednessSelfCheck,
          state.researchBrief.facts,
        );

        if (issues.length === 0) {
          void deps.evidenceLedger.qaPass({
            orgId: state.lead.orgId,
            runId: state.lead.graphRunId ?? null,
            personId: state.lead.personId,
            durationMs: Date.now() - startedAt,
          });
        } else {
          void deps.evidenceLedger.qaFail({
            orgId: state.lead.orgId,
            runId: state.lead.graphRunId ?? null,
            personId: state.lead.personId,
            issues,
            durationMs: Date.now() - startedAt,
          });
        }

        return { qaIssues: issues };
      },
    );
  };

  const requireHumanReview = async (state: SdrState): Promise<Partial<SdrState>> => {
    return withNodeSpan(
      SDR_NODE.REVIEW,
      {
        "apex.run_id": state.lead.graphRunId ?? "unknown",
        "apex.org_id": state.lead.orgId,
        "apex.node": SDR_NODE.REVIEW,
        "apex.lead.person_id": state.lead.personId,
      },
      async () => {
        // TODO(schema): promote `langsmith_run_id` to a first-class column on
        // OutreachArtifact so we can index/query rejected drafts by trace.
        // Today we stash it in the payload JSON to avoid a prod migration.
        const toolArgs: Record<string, unknown> = {
          to: state.lead.email,
          subject: state.subject,
          body: state.body,
          personId: state.lead.personId,
          qaIssues: state.qaIssues,
          draftAttempts: state.draftAttempts,
          // Grounding surface: the cited fact_ids and unsupported_claims the model
          // declared, plus the structured brief facts the drafter actually saw.
          // Approvers see these alongside the draft so they can spot-check.
          brief_facts: state.researchBrief.facts,
          brief_do_not_claim: state.researchBrief.doNotClaim,
          ...(state.refusal ? { refusal: state.refusal } : {}),
          ...(state.groundednessSelfCheck
            ? { groundedness_self_check: state.groundednessSelfCheck }
            : {}),
          ...(state.langsmithRunId
            ? { langsmith_run_id: state.langsmithRunId }
            : {}),
        };

        const artifact = await deps.outreachArtifacts.recordDryRun({
          orgId: state.lead.orgId,
          graphRunId: state.lead.graphRunId ?? null,
          toolName: "send_email",
          toolArgs,
        });

        return { artifactId: artifact?.id ?? null };
      },
    );
  };

  // QA → DRAFT if issues remain AND we have attempts left AND we didn't refuse;
  // else QA → REVIEW. Refusals are a deliberate outcome — retrying loses the
  // signal and risks the model fabricating to escape the refusal.
  const routeAfterQa = (state: SdrState): typeof SDR_NODE.DRAFT | typeof SDR_NODE.REVIEW => {
    if (state.refusal) return SDR_NODE.REVIEW;
    if (state.qaIssues.length > 0 && state.draftAttempts < MAX_DRAFT_ATTEMPTS) {
      return SDR_NODE.DRAFT;
    }
    return SDR_NODE.REVIEW;
  };

  const graph = new StateGraph(SdrStateAnnotation)
    .addNode(SDR_NODE.BRIEF, buildResearchBrief)
    .addNode(SDR_NODE.DRAFT, draftMessage)
    .addNode(SDR_NODE.QA, qaMessage)
    .addNode(SDR_NODE.REVIEW, requireHumanReview)
    .addEdge(START, SDR_NODE.BRIEF)
    .addEdge(SDR_NODE.BRIEF, SDR_NODE.DRAFT)
    .addEdge(SDR_NODE.DRAFT, SDR_NODE.QA)
    .addConditionalEdges(SDR_NODE.QA, routeAfterQa, {
      [SDR_NODE.DRAFT]: SDR_NODE.DRAFT,
      [SDR_NODE.REVIEW]: SDR_NODE.REVIEW,
    })
    .addEdge(SDR_NODE.REVIEW, END);

  return graph;
}

/**
 * Convenience wrapper: compile + invoke the subgraph for a single lead and
 * return a flat result. Production callers (outreach_agent) use this; tests
 * can either call this or compile the graph themselves to inspect state.
 */
export async function runSdrOutreachSubgraph(
  deps: SubgraphDeps,
  lead: SdrLeadInput,
): Promise<SdrLeadResult> {
  const compiled = buildSdrOutreachSubgraph(deps).compile();
  const final = (await compiled.invoke({ lead })) as SdrState;
  return {
    personId: lead.personId,
    artifactId: final.artifactId,
    subject: final.subject,
    body: final.body,
    qaIssues: final.qaIssues,
    draftAttempts: final.draftAttempts,
    refusal: final.refusal,
    groundednessSelfCheck: final.groundednessSelfCheck,
  };
}

// ── Research brief assembly (XML, fact_id-indexed) ─────────────────────────

/**
 * Build a research brief for one lead. The brief is XML so the drafter can cite
 * facts by id; each fact carries a stable `id` (F1, P1, S1…), a `source`
 * attribute (the DB table or service that produced it), and verbatim text. The
 * structured `facts` array is preserved on state so downstream evaluators
 * (citation_coverage) can verify citation-by-id without re-parsing XML.
 *
 * Today the brief is sourced from Company + Person + LeadScore + recent
 * EvidenceEvents. The `<website_excerpt>` slot is left empty until the
 * web_fetch sidecar lands later this week; the schema is forward-compatible.
 */
export async function assembleResearchBrief(
  prisma: PrismaService,
  lead: SdrLeadInput,
): Promise<ResearchBrief> {
  const facts: BriefFact[] = [];

  // Company firmographics (F-series).
  const company = await prisma.company.findFirst({
    where: { orgId: lead.orgId, domain: lead.companyDomain },
    select: {
      id: true,
      name: true,
      domain: true,
      industry: true,
      employeeRange: true,
      country: true,
      city: true,
      fundingStage: true,
      techStack: true,
    },
  });

  const firmoBits: string[] = [`Company: ${lead.companyName} (${lead.companyDomain})`];
  if (company?.industry) firmoBits.push(`industry: ${company.industry}`);
  if (company?.employeeRange) firmoBits.push(`headcount: ${company.employeeRange}`);
  if (company?.city || company?.country) {
    firmoBits.push(`HQ: ${[company?.city, company?.country].filter(Boolean).join(", ")}`);
  }
  facts.push({
    id: "F1",
    category: "firmographic",
    source: "company.registry",
    text: firmoBits.join("; ") + ".",
  });
  if (company?.fundingStage) {
    facts.push({
      id: "F2",
      category: "firmographic",
      source: "company.registry",
      text: `Funding stage: ${company.fundingStage}.`,
    });
  }
  if (company?.techStack && company.techStack.length > 0) {
    facts.push({
      id: "F3",
      category: "firmographic",
      source: "company.builtwith",
      text: `Tech stack: ${company.techStack.slice(0, 8).join(", ")}.`,
    });
  }

  // Person facts (P-series).
  const person = await prisma.person.findFirst({
    where: { id: lead.personId },
    select: { title: true, seniority: true, department: true, location: true, bio: true },
  });
  const personBits: string[] = [`${lead.firstName} ${lead.lastName}`];
  if (lead.title) personBits.push(`${lead.title}`);
  personBits.push(`at ${lead.companyName}`);
  if (person?.location) personBits.push(`location: ${person.location}`);
  facts.push({
    id: "P1",
    category: "person",
    source: "person.profile",
    text: personBits.join(", ") + ".",
  });
  if (person?.bio) {
    facts.push({
      id: "P2",
      category: "person",
      source: "person.bio",
      text: `Bio: ${truncate(person.bio, 240)}`,
    });
  }

  // Behavioral signals (S-series) from EvidenceEvent — most recent first, fresh + non-mock only.
  let signalCount = 0;
  if (company?.id) {
    let cursor: string | undefined;
    let scanned = 0;

    // Freshness is based on payload.date rather than createdAt, and mocked rows
    // are rejected after retrieval. Scan a bounded window until we collect the
    // desired number of usable signals so newer stale/mock rows cannot crowd a
    // genuinely fresh fact out of the brief.
    while (
      signalCount < MAX_RECENT_EVIDENCE_EVENTS &&
      scanned < MAX_EVIDENCE_EVENTS_SCANNED
    ) {
      const take = Math.min(
        EVIDENCE_EVENT_PAGE_SIZE,
        MAX_EVIDENCE_EVENTS_SCANNED - scanned,
      );
      const events = await prisma.evidenceEvent.findMany({
        where: {
          orgId: lead.orgId,
          OR: [
            { refType: "company", refId: company.id },
            { refType: "person", refId: lead.personId },
          ],
          kind: { in: Array.from(SIGNAL_KINDS) },
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        take,
        select: { id: true, kind: true, payload: true, createdAt: true },
      });
      if (events.length === 0) break;

      scanned += events.length;
      cursor = events[events.length - 1]?.id;

      for (const ev of events) {
        const payload = (ev.payload ?? {}) as Record<string, unknown>;
        if (isMocked(payload)) continue; // mock never becomes a cited fact
        const effectiveDate =
          typeof payload.date === "string"
            ? payload.date
            : ev.createdAt.toISOString().slice(0, 10);
        if (!isFresh(ev.kind, effectiveDate)) continue; // stale signals don't ground
        signalCount += 1;
        facts.push({
          id: `S${signalCount}`,
          category: "signal",
          source:
            typeof payload.source === "string"
              ? payload.source
              : `evidence_event.${ev.kind}`,
          text: summarizeEvidencePayload(ev.kind, ev.payload),
          date: effectiveDate,
        });
        if (signalCount >= MAX_RECENT_EVIDENCE_EVENTS) break;
      }

      if (events.length < take || !cursor) break;
    }
  }

  // ICP fit (ICP1) — only if we have a score.
  const score = await prisma.leadScore.findFirst({
    where: { orgId: lead.orgId, personId: lead.personId },
    select: { score: true, breakdown: true, updatedAt: true },
  });
  if (score) {
    facts.push({
      id: "ICP1",
      category: "icp_fit",
      source: "lead_score",
      text: `ICP score: ${score.score}/100. Updated ${score.updatedAt.toISOString().slice(0, 10)}.`,
    });
  }

  // Defensive `do_not_claim` items — small, generic, always-on. The catalog
  // can grow as we learn what the model fabricates most often in production.
  const doNotClaim: string[] = [
    `Do not claim ${lead.companyName} is in any specific industry unless a fact above explicitly states it.`,
    `Do not claim ${lead.firstName} previously worked at any specific company unless a fact above explicitly states it.`,
    `Do not reference "AI SDR" or "AI agent" as ${lead.companyName}'s pain — they are evaluating us, not buying it.`,
  ];

  const xml = renderBriefXml(facts, doNotClaim);
  return {
    xml,
    facts,
    doNotClaim,
    hasGroundingSignal: signalCount > 0,
  };
}

function renderBriefXml(facts: readonly BriefFact[], doNotClaim: readonly string[]): string {
  const byCategory = {
    firmographic: facts.filter((f) => f.category === "firmographic"),
    person: facts.filter((f) => f.category === "person"),
    signal: facts.filter((f) => f.category === "signal"),
    icp_fit: facts.filter((f) => f.category === "icp_fit"),
  };

  const section = (
    tag: string,
    items: readonly BriefFact[],
  ): string =>
    items.length === 0
      ? `<${tag}/>`
      : `<${tag}>\n${items
          .map((f) => {
            const date = f.date ? ` date="${escapeXml(f.date)}"` : "";
            return `    <fact id="${escapeXml(f.id)}" source="${escapeXml(f.source)}"${date}>${escapeXml(f.text)}</fact>`;
          })
          .join("\n")}\n  </${tag}>`;

  const dnc =
    doNotClaim.length === 0
      ? "<do_not_claim/>"
      : `<do_not_claim>\n${doNotClaim
          .map((s) => `    <item>${escapeXml(s)}</item>`)
          .join("\n")}\n  </do_not_claim>`;

  return `<brief>
  ${section("firmographic", byCategory.firmographic)}
  ${section("person", byCategory.person)}
  ${section("signals", byCategory.signal)}
  ${section("icp_fit", byCategory.icp_fit)}
  ${dnc}
</brief>`;
}

function summarizeEvidencePayload(kind: string, payload: unknown): string {
  if (!payload || typeof payload !== "object") return `${kind} signal recorded.`;
  const p = payload as Record<string, unknown>;
  const pickStr = (k: string): string | null => (typeof p[k] === "string" ? (p[k] as string) : null);
  const pickNum = (k: string): number | null => (typeof p[k] === "number" ? (p[k] as number) : null);
  switch (kind) {
    case "recent_hire": {
      const title = pickStr("jobTitle") ?? pickStr("title") ?? "an open role";
      const source = pickStr("source") ?? "a public job board";
      return `Posted a job for "${title}" on ${source}.`;
    }
    case "funding_event": {
      const amount = pickStr("amount") ?? (pickNum("amountUsd") ? `$${pickNum("amountUsd")}` : "an undisclosed amount");
      const round = pickStr("round") ?? "round";
      const lead = pickStr("leadInvestor");
      return `Raised ${amount} ${round}${lead ? ` led by ${lead}` : ""}.`;
    }
    case "product_launch": {
      const name = pickStr("productName") ?? pickStr("name") ?? "a new product";
      const quote = pickStr("quote");
      return `Announced ${name}${quote ? `: "${truncate(quote, 200)}"` : "."}`;
    }
    case "leadership_change": {
      const role = pickStr("role") ?? "a leadership role";
      const who = pickStr("name") ?? "a new leader";
      return `${who} joined as ${role}.`;
    }
    case "press_mention": {
      const outlet = pickStr("outlet") ?? "a publication";
      const headline = pickStr("headline") ?? "a recent story";
      return `Mentioned in ${outlet}: "${truncate(headline, 200)}".`;
    }
    case "intent_signal": {
      const topic = pickStr("topic") ?? "a relevant topic";
      return `Showing buyer intent around ${topic}.`;
    }
    default:
      return `${kind} signal recorded.`;
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

export const _internalForTests = {
  qaCheck,
  parseDrafterJson,
  renderBriefXml,
  summarizeEvidencePayload,
  SDR_DRAFT_SYSTEM_PROMPT,
};
