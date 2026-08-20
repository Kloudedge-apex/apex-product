import { Logger } from "@nestjs/common";
import { NODE, STAGE, type PipelineState, type StageStatus } from "../../state";
import { withNodeSpan } from "../../../observability/graph-tracing";
import type { PrismaService } from "../../../prisma/prisma.service";
import type { EvidenceLedgerService } from "../../../observability/evidence-ledger.service";
import type { SignalExtractionService, CompanyForExtraction } from "./signal-extraction.service";

const log = new Logger("ResearchNode");

export interface ResearchNodeDeps {
  readonly prisma: PrismaService;
  readonly signalExtraction: SignalExtractionService;
  readonly evidenceLedger: EvidenceLedgerService;
}

/**
 * RESEARCH node — runs after SCORING, before APPROVAL. For each unique
 * qualified (tier A/B) company among scoredLeads, extracts dated prospect
 * signals and writes them to the evidence ledger. Best-effort PER COMPANY: a
 * single company's extraction failure is isolated. Zero extracted signals is
 * a valid COMPLETE outcome, but extracted evidence is not counted until the
 * ledger confirms it is durable (or already existed after a retry). If every
 * extracted signal fails persistence, the stage fails before approval.
 *
 * The person→company RESOLVE queries below are deliberately NOT best-effort: a
 * Prisma throw there is genuine infra failure (DB outage), not "this company
 * has no signal", so it escapes the node and fails the run loudly rather than
 * silently approving with zero research. Do not wrap them in try/catch.
 */
export function buildResearchNode(deps: ResearchNodeDeps) {
  return async (state: PipelineState): Promise<Partial<PipelineState>> =>
    withNodeSpan(
      NODE.RESEARCH,
      { "apex.run_id": state.runId, "apex.org_id": state.orgId, "apex.node": NODE.RESEARCH },
      async () => {
        const msg = (text: string, level: "info" | "warn" | "error" = "info") => ({
          messages: [{ node: NODE.RESEARCH, ts: new Date().toISOString(), level, text }],
        });

        if (state.stageStatuses?.[STAGE.SCORING] === "FAILED") {
          log.warn(`skipping ${STAGE.RESEARCH} — upstream ${STAGE.SCORING} failed`);
          return {
            stagesCompleted: [STAGE.RESEARCH],
            stageStatuses: { [STAGE.RESEARCH]: "FAILED" as StageStatus },
            ...msg(`skipped — upstream ${STAGE.SCORING} failed`, "warn"),
          };
        }

        const qualified = state.scoredLeads.filter((s) => s.tier === "A" || s.tier === "B");
        if (qualified.length === 0) {
          return {
            stagesCompleted: [STAGE.RESEARCH],
            stageStatuses: { [STAGE.RESEARCH]: "COMPLETE" as StageStatus },
            ...msg("no qualified leads to research"),
          };
        }

        // scoredLeads has no companyId — resolve person → company, dedupe per company.
        // Both reads are org-scoped (defense-in-depth, matching every other node in
        // the pipeline): Person has no direct orgId, so scope it via its company.
        const personIds = qualified.map((s) => s.personId);
        const persons = await deps.prisma.person.findMany({
          where: { id: { in: personIds }, company: { orgId: state.orgId } },
          select: { companyId: true },
        });
        const companyIds = [...new Set(persons.map((p) => p.companyId).filter(Boolean))];
        const companies = companyIds.length
          ? await deps.prisma.company.findMany({
              where: { id: { in: companyIds }, orgId: state.orgId },
              select: { id: true, name: true, domain: true, raw: true },
            })
          : [];

        const now = new Date();
        let signalsExtracted = 0;
        let signalsDurable = 0;
        let signalsFailed = 0;
        let companiesWithError = 0;
        for (const company of companies) {
          let inputs: Awaited<
            ReturnType<SignalExtractionService["extractForCompany"]>
          >;
          try {
            inputs = await deps.signalExtraction.extractForCompany(
              company as CompanyForExtraction,
              now,
            );
          } catch (err) {
            companiesWithError += 1;
            log.warn(
              `research extraction failed for company ${company.id}: ${err instanceof Error ? err.message : String(err)}`,
            );
            continue;
          }

          signalsExtracted += inputs.length;
          for (const input of inputs) {
            try {
              const persistence = await deps.evidenceLedger.recordSignal({
                orgId: state.orgId,
                runId: state.runId,
                companyId: company.id,
                kind: input.kind,
                source: input.source,
                date: input.date,
                summary: input.summary,
                confidence: input.confidence,
                fields: input.fields,
              });
              if (persistence === "CREATED" || persistence === "EXISTING") {
                signalsDurable += 1;
              } else {
                signalsFailed += 1;
                log.warn(
                  `research evidence was not persisted for company ${company.id}: ${persistence}`,
                );
              }
            } catch (err) {
              signalsFailed += 1;
              log.warn(
                `research evidence persistence failed for company ${company.id}: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
        }

        const status: StageStatus =
          signalsExtracted > 0 && signalsDurable === 0 && signalsFailed > 0
            ? "FAILED"
            : companiesWithError > 0 || signalsFailed > 0
              ? "PARTIAL"
              : "COMPLETE";
        return {
          stagesCompleted: [STAGE.RESEARCH],
          stageStatuses: { [STAGE.RESEARCH]: status },
          ...msg(
            `researched ${companies.length} compan${companies.length === 1 ? "y" : "ies"}, confirmed ${signalsDurable}/${signalsExtracted} signal(s) durable${signalsFailed > 0 ? `, ${signalsFailed} persistence failure(s)` : ""}`,
            status === "FAILED" ? "error" : status === "PARTIAL" ? "warn" : "info",
          ),
        };
      },
    );
}
