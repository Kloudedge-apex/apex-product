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
 * single company's extraction failure is isolated and never fails the stage
 * (the lead simply refuses at draft time, which is the correct behavior, not an
 * error). Zero signals is a valid COMPLETE outcome.
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
        const personIds = qualified.map((s) => s.personId);
        const persons = await deps.prisma.person.findMany({
          where: { id: { in: personIds } },
          select: { companyId: true },
        });
        const companyIds = [...new Set(persons.map((p) => p.companyId).filter(Boolean))];
        const companies = companyIds.length
          ? await deps.prisma.company.findMany({
              where: { id: { in: companyIds } },
              select: { id: true, name: true, domain: true, raw: true },
            })
          : [];

        const now = new Date();
        // NOTE: `signalsWritten` counts write ATTEMPTS, and `companiesWithError`
        // / PARTIAL reflect EXTRACTION failures only. EvidenceLedgerService.append
        // swallows its own Prisma errors (best-effort ledger), so a DB-level
        // recordSignal failure resolves successfully here and does NOT flip the
        // stage to PARTIAL. If signal-write failures ever need to surface, change
        // append's swallow contract — not this loop.
        let signalsWritten = 0;
        let companiesWithError = 0;
        for (const company of companies) {
          try {
            const inputs = await deps.signalExtraction.extractForCompany(
              company as CompanyForExtraction,
              now,
            );
            for (const input of inputs) {
              await deps.evidenceLedger.recordSignal({
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
              signalsWritten += 1;
            }
          } catch (err) {
            companiesWithError += 1;
            log.warn(
              `research failed for company ${company.id}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }

        const status: StageStatus = companiesWithError > 0 ? "PARTIAL" : "COMPLETE";
        return {
          stagesCompleted: [STAGE.RESEARCH],
          stageStatuses: { [STAGE.RESEARCH]: status },
          ...msg(
            `researched ${companies.length} compan${companies.length === 1 ? "y" : "ies"}, wrote ${signalsWritten} signal(s)`,
          ),
        };
      },
    );
}
