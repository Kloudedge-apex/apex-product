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
import { withNodeSpan } from "../../observability/graph-tracing";

const log = new Logger("SdrOutreachSubgraph");

const MAX_DRAFT_ATTEMPTS = 2;
const MAX_SUBJECT_LEN = 120;
const MAX_BODY_LEN = 2000;
const MIN_BODY_LEN = 30;

/** Substrings that, if present, mean the LLM left a placeholder unfilled. */
const PLACEHOLDER_LEAKS = ["{{", "}}", "[FIRST_NAME]", "[COMPANY]", "TODO", "<insert"];

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
export type DrafterFn = (
  input: DrafterInput,
) => Promise<{ subject: string; body: string }>;

export interface DrafterInput {
  readonly researchBrief: string;
  readonly lead: SdrLeadInput;
  readonly previousAttempt?: { subject: string; body: string; issues: readonly string[] };
  readonly onRunId?: (runId: string) => void;
}

export interface SubgraphDeps {
  readonly prisma: PrismaService;
  readonly llm: LLMService;
  readonly outreachArtifacts: OutreachArtifactsService;
  readonly evidenceLedger: EvidenceLedgerService;
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
  researchBrief: Annotation<string>({
    reducer: (_p, n) => n,
    default: () => "",
  }),
  subject: Annotation<string>({
    reducer: (_p, n) => n,
    default: () => "",
  }),
  body: Annotation<string>({
    reducer: (_p, n) => n,
    default: () => "",
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

function qaCheck(subject: string, body: string): string[] {
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
  return issues;
}

async function defaultDrafter(
  llm: LLMService,
  input: DrafterInput,
  evidenceLedger: EvidenceLedgerService,
): Promise<{ subject: string; body: string }> {
  const previous = input.previousAttempt
    ? `\nPrevious draft was flagged for: ${input.previousAttempt.issues.join(", ")}. Fix those issues.`
    : "";

  const systemPrompt =
    "You are an SDR writing a first-touch cold email. Output ONLY valid JSON " +
    "with shape {\"subject\":\"...\",\"body\":\"...\"}. No markdown, no commentary. " +
    "The body must be 60-180 words, plaintext, and reference a specific signal from the brief.";

  const userPrompt = `Lead: ${input.lead.firstName} ${input.lead.lastName} (${input.lead.title ?? "no title"}) at ${input.lead.companyName} (${input.lead.companyDomain}).
Research brief:
${input.researchBrief}${previous}`;

  const startedAt = Date.now();
  const resp = await llm.chat(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    {
      maxTokens: 600,
      agent: "sdr_agent.draft_message",
      node: "sdr_outreach.draft_message",
      tags: ["sdr_outreach", "draft_message", "customer_facing"],
      metadata: {
        org_id: input.lead.orgId,
        person_id: input.lead.personId,
        graph_run_id: input.lead.graphRunId ?? null,
        draft_attempt: input.previousAttempt ? "retry" : "first",
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

function parseDrafterJson(raw: string): { subject: string; body: string } {
  const trimmed = raw.trim();
  // Strip ```json fences if the model added them despite the instruction.
  const cleaned = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    const parsed = JSON.parse(cleaned) as { subject?: unknown; body?: unknown };
    const subject = typeof parsed.subject === "string" ? parsed.subject : "";
    const body = typeof parsed.body === "string" ? parsed.body : "";
    return { subject, body };
  } catch {
    return { subject: "", body: "" };
  }
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
        // Pull a small amount of context. The brief is rendered as plain text the
        // drafter sees; richer signals (firmographics, news) can attach later
        // without changing the subgraph shape.
        const company = await deps.prisma.company.findFirst({
          where: { orgId: state.lead.orgId, domain: state.lead.companyDomain },
          select: { name: true, domain: true, employeeRange: true, industry: true },
        });

        const briefLines = [
          `Company: ${state.lead.companyName} (${state.lead.companyDomain}).`,
          company?.industry ? `Industry: ${company.industry}.` : null,
          company?.employeeRange ? `Headcount: ${company.employeeRange}.` : null,
          `Contact: ${state.lead.firstName} ${state.lead.lastName}, ${state.lead.title ?? "title unknown"}.`,
        ].filter(Boolean);

        return { researchBrief: briefLines.join(" ") };
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
        const previous =
          state.draftAttempts > 0 && state.qaIssues.length > 0
            ? { subject: state.subject, body: state.body, issues: state.qaIssues }
            : undefined;

        let capturedRunId: string | null = null;
        try {
          const { subject, body } = await drafter({
            researchBrief: state.researchBrief,
            lead: state.lead,
            previousAttempt: previous,
            onRunId: (runId): void => {
              capturedRunId = runId;
            },
          });
          return {
            subject,
            body,
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
        const issues = qaCheck(state.subject, state.body);

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

  // QA → DRAFT if issues remain AND we have attempts left; else QA → REVIEW.
  const routeAfterQa = (state: SdrState): typeof SDR_NODE.DRAFT | typeof SDR_NODE.REVIEW => {
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
  };
}

export const _internalForTests = { qaCheck, parseDrafterJson };
