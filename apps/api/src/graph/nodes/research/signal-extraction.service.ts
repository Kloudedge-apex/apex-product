import type { Tool, ToolContext } from "../../../runtime/tools/tool.interface";
import { isMocked } from "../../../runtime/tools/mock-metadata";
import type { SignalEventKind } from "../../../observability/evidence-event.types";

/**
 * A dated, sourced prospect signal ready to be written to the evidence ledger
 * via EvidenceLedgerService.recordSignal(). The citation contract: every signal
 * carries a real `source` URL and an ISO `date`; mock-tagged inputs never reach
 * this type (they are filtered upstream), so the lead refuses rather than cites
 * fixture data.
 */
export interface SignalInput {
  readonly kind: SignalEventKind;
  readonly source: string; // real URL
  readonly date: string; // ISO yyyy-mm-dd
  readonly summary?: string;
  readonly confidence: number;
  readonly fields?: Record<string, string>;
}

/**
 * Minimal company shape needed for extraction. Loosely coupled (not the Prisma
 * type) so the service is trivially testable. `raw` is `Company.raw` (Json |
 * null); today it is empty in production.
 */
export interface CompanyForExtraction {
  readonly id: string;
  readonly name: string;
  readonly domain: string;
  readonly raw?: unknown; // Company.raw (Json | null)
}

/**
 * The only constructor dependency. Typed narrowly so both the real
 * WebSearchTool and test fakes satisfy it.
 */
export type WebSearchExecutor = Pick<Tool, "execute">;

// web_search keys off process.env.TAVILY_API_KEY and ignores ToolContext entirely;
// this placeholder only satisfies the Tool.execute signature.
// INVARIANT: if web_search ever starts reading context (per-tenant API keys,
// rate-limit attribution, tracing), this service must instead receive real
// org/run ids via its constructor or extractForCompany args — the empty values
// here would silently misattribute or break those features.
const SEARCH_CONTEXT: ToolContext = {
  orgId: "",
  agentId: "research_agent",
  runId: "",
  integrations: new Map(),
};

export class SignalExtractionService {
  constructor(private readonly webSearch: WebSearchExecutor) {}

  /** Parse + one live trigger. Returns dated, sourced, non-mock signal inputs. */
  async extractForCompany(company: CompanyForExtraction, now: Date): Promise<SignalInput[]> {
    const scraped = this.extractFromScraped(company);
    const live = await this.extractLiveTrigger(company, now);
    return [...scraped, ...live];
  }

  /**
   * Deterministic parse of already-persisted material on `company.raw`.
   * Forward-compatible: today `raw` is empty so this returns []. When sourcing
   * persists structured dated job data (`raw.jobs[]`), each real job with BOTH
   * a URL and a date becomes a `recent_hire` (citation contract: no undated or
   * unsourced signal is ever emitted; mock-tagged items are skipped).
   *
   * Job dates MUST be strict ISO yyyy-mm-dd (full ISO datetimes are normalized
   * to their date). Anything else — "05/20/2026", "May 20, 2026" — is REJECTED
   * (the job is skipped), because a blind `.slice(0, 10)` of those yields a
   * wrong-but-valid date (e.g. "May 20, 20" → year 2020), which would cite an
   * incorrect trigger. Rejecting is the fail-closed, wedge-correct behavior.
   */
  extractFromScraped(company: CompanyForExtraction): SignalInput[] {
    const raw = company.raw;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const jobs = (raw as Record<string, unknown>).jobs;
    if (!Array.isArray(jobs)) return [];
    const out: SignalInput[] = [];
    for (const job of jobs) {
      if (!job || typeof job !== "object" || isMocked(job)) continue;
      const j = job as Record<string, unknown>;
      const url =
        typeof j.url === "string" ? j.url : typeof j.absoluteUrl === "string" ? j.absoluteUrl : null;
      const date = toIsoDate(j.postedAt ?? j.posted_at ?? j.updatedAt ?? j.date);
      const title = typeof j.title === "string" ? j.title : null;
      if (!url || !date || !title) continue; // need a citable URL + strict-ISO date
      out.push({
        kind: "recent_hire",
        source: url,
        date,
        summary: `Posted "${title}".`,
        confidence: 0.9,
        fields: { jobTitle: title },
      });
    }
    return out;
  }

  /**
   * One live web_search per company → at most one `press_mention`. Mock or
   * failed search yields NO signal (mock-never-a-fact) → the lead refuses.
   */
  async extractLiveTrigger(company: CompanyForExtraction, now: Date): Promise<SignalInput[]> {
    let result;
    try {
      result = await this.webSearch.execute(
        { query: `"${company.name}" funding OR launches OR partnership OR hires`, max_results: 3 },
        SEARCH_CONTEXT,
      );
    } catch {
      return [];
    }
    if (!result || !result.success || isMocked(result.data)) return [];
    const data = result.data as { results?: Array<Record<string, unknown>> };
    const results = Array.isArray(data?.results) ? data.results : [];
    const top = results.find(
      (r) => !isMocked(r) && typeof r.url === "string" && (r.url as string).length > 0,
    );
    if (!top || typeof top.url !== "string") return [];
    const title = typeof top.title === "string" ? top.title : "Recent mention";
    return [
      {
        kind: "press_mention",
        source: top.url,
        date: now.toISOString().slice(0, 10),
        summary: title,
        confidence: 0.6,
        fields: { outlet: hostname(top.url), headline: title },
      },
    ];
  }
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Normalize a raw date value to a strict ISO `yyyy-mm-dd`, or null if it isn't
 * one. Accepts a bare ISO date or a full ISO datetime (sliced to its date);
 * rejects every other format so a non-ISO string can never be stored as a
 * citation date. The post-slice `Date.parse` rejects in-range-looking but
 * invalid dates (e.g. "2026-13-45").
 */
function toIsoDate(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const candidate = raw.slice(0, 10);
  if (!ISO_DATE.test(candidate)) return null;
  return Number.isNaN(Date.parse(`${candidate}T00:00:00Z`)) ? null : candidate;
}
