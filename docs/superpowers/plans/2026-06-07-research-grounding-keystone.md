# Research-Grounding Keystone — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `assembleResearchBrief()` carry real, fresh, dated prospect signals so the SDR drafter produces a grounded email citing a real trigger — or honestly refuses — instead of refusing on every lead.

**Architecture:** A new `RESEARCH` graph node (after `SCORING`, before `APPROVAL`) runs on qualified (tier A/B) leads, deduped per company. It parses already-fetched TheirStack/registry data and runs one live web search per company, writing dated **signal `EvidenceEvent`** rows via a new `EvidenceLedgerService.recordSignal()`. `assembleResearchBrief()` stays read-only but gains a freshness filter and a mock-exclusion filter so only fresh, real signals count toward grounding.

**Tech Stack:** NestJS, Prisma, LangGraph (`@langchain/langgraph`), TypeScript strict, Jest.

**Spec:** `docs/superpowers/specs/2026-06-07-research-grounding-keystone-design.md`

**Branch:** `feat/research-grounding-keystone` (off `release/go-live-2026-06-01`).

**Run tests with:** `cd apps/api && pnpm test -- <path>` (Jest). Type-check: `pnpm --filter @apex/api exec tsc --noEmit -p tsconfig.json` (run prisma generate first if needed: `pnpm db:generate` at repo root).

---

## File structure

| File | Responsibility | Action |
|---|---|---|
| `apps/api/src/observability/evidence-event.types.ts` | Signal event kinds + typed payloads; add `"company"` ref type | Modify |
| `apps/api/src/runtime/tools/mock-metadata.ts` | Add `isMocked()` guard | Modify |
| `apps/api/src/observability/evidence-ledger.service.ts` | `recordSignal()` append-only writer | Modify |
| `apps/api/src/graph/nodes/research/freshness.ts` | `FRESHNESS_WINDOWS` + `isFresh()` | Create |
| `apps/api/src/graph/nodes/sdr-outreach-subgraph.ts` | freshness + mock filter in `assembleResearchBrief` | Modify (`:746-803`) |
| `apps/api/src/graph/nodes/research/signal-extraction.service.ts` | parse TheirStack/registry + one live web_search → signal inputs | Create |
| `apps/api/src/graph/nodes/research/research.node.ts` | the RESEARCH node handler | Create |
| `apps/api/src/graph/state.ts` | `NODE.RESEARCH` + `STAGE.RESEARCH` | Modify (`:107-124`) |
| `apps/api/src/graph/pipeline-graph.ts` | wire node + edge + `pickNext` ordering + deps | Modify (`:36-49`, `:650-682`) |

**Confirmed shapes (from reading the code):**
- `assembleResearchBrief` (`sdr-outreach-subgraph.ts:670-804`) queries `prisma.evidenceEvent.findMany({ where: { orgId, OR:[{refType:"company",refId:company.id},{refType:"person",refId:lead.personId}], kind:{in:[...SIGNAL_KINDS]} }, orderBy:{createdAt:"desc"}, take:5 })`, dates each fact off `ev.createdAt`, and sets `hasGroundingSignal = signalCount > 0 || Boolean(company?.intentSignals?.length)`.
- `SIGNAL_KINDS` (`:40-47`) = `recent_hire, funding_event, product_launch, leadership_change, press_mention, intent_signal`.
- `summarizeEvidencePayload` (`:843-882`) reads per-kind payload fields: `recent_hire{jobTitle|title, source}`, `funding_event{amount|amountUsd, round, leadInvestor}`, `product_launch{productName|name, quote}`, `leadership_change{role, name}`, `press_mention{outlet, headline}`, `intent_signal{topic}`.
- `markMocked`/`markMockedItem` (`mock-metadata.ts`) stamp `{ source:"mock", confidence:0, reason }` onto data.
- `EvidenceLedgerService.append` (`evidence-ledger.service.ts:29-56`) is private; writers call `this.append({orgId, runId, kind, refType, refId, payload})`; payload must extend `EvidenceEventPayload` union; wrapped in best-effort try/catch.
- `EvidenceRefType` (`evidence-event.types.ts:25-32`) does NOT include `"company"` though the brief queries it — add it.
- `web_search` tool (`web-search.tool.ts`) returns `{success, data:{ results:[{title,url,snippet,content}], answer }}`; uses `TAVILY_API_KEY`; degrades to `markMocked(...)` (data `source:"mock"`) on missing key/failure. **No date field on results.**
- `state.ts` `NODE` (`:107-114`) + `STAGE` (`:119-124`) const maps; `pipeline-graph.ts` wires `.addNode(NODE.X, ...).addEdge(NODE.X, NODE.SUPERVISOR)` (`:660-670`) and routes via `pickNext(done:Set<string>, approved)` (`:676-682`); `state.scoredLeads` items carry `{ ...score, tier }`, qualified = `tier==="A"||"B"` (`:448-450`).

---

### Task 1: Define signal evidence kinds + payloads

**Files:**
- Modify: `apps/api/src/observability/evidence-event.types.ts`
- Test: `apps/api/src/observability/__tests__/evidence-event.types.spec.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
import { EVIDENCE_EVENT_KIND, SIGNAL_EVENT_KINDS } from "../evidence-event.types";

describe("signal evidence kinds", () => {
  it("defines the prospect-signal kinds the research brief queries", () => {
    expect(EVIDENCE_EVENT_KIND.recentHire).toBe("recent_hire");
    expect(EVIDENCE_EVENT_KIND.fundingEvent).toBe("funding_event");
    expect(EVIDENCE_EVENT_KIND.leadershipChange).toBe("leadership_change");
    expect(EVIDENCE_EVENT_KIND.productLaunch).toBe("product_launch");
    expect(EVIDENCE_EVENT_KIND.pressMention).toBe("press_mention");
  });
  it("exposes the signal-kind set for callers", () => {
    expect(SIGNAL_EVENT_KINDS).toEqual(
      expect.arrayContaining(["recent_hire", "funding_event", "leadership_change", "product_launch", "press_mention"]),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && pnpm test -- evidence-event.types.spec`
Expected: FAIL — `EVIDENCE_EVENT_KIND.recentHire` is undefined / `SIGNAL_EVENT_KINDS` not exported.

- [ ] **Step 3: Implement** — in `evidence-event.types.ts`, add to the `EVIDENCE_EVENT_KIND` object (after `crmSynced`):

```ts
  recentHire: "recent_hire",
  fundingEvent: "funding_event",
  leadershipChange: "leadership_change",
  productLaunch: "product_launch",
  pressMention: "press_mention",
```

Add `"company"` to `EvidenceRefType`:

```ts
export type EvidenceRefType =
  | "workflow_run"
  | "graph_run"
  | "org"
  | "company"
  | "person"
  | "outreach_artifact"
  | "outreach_tool_call"
  | "crm_object";
```

Add the signal payload type + the kind set + extend the union:

```ts
/** Kinds surfaced as grounding signals in the research brief (must match SIGNAL_KINDS in sdr-outreach-subgraph.ts). */
export const SIGNAL_EVENT_KINDS = [
  EVIDENCE_EVENT_KIND.recentHire,
  EVIDENCE_EVENT_KIND.fundingEvent,
  EVIDENCE_EVENT_KIND.leadershipChange,
  EVIDENCE_EVENT_KIND.productLaunch,
  EVIDENCE_EVENT_KIND.pressMention,
] as const;

export type SignalEventKind = (typeof SIGNAL_EVENT_KINDS)[number];

/**
 * Prospect-signal payload. `source` is the real URL the signal came from and
 * `date` is the ISO-8601 event date (e.g. job-post date, filing date, or the
 * discovery date for a live press mention) — both REQUIRED so the fact is
 * citable and freshness-checkable. Kind-specific fields are read by
 * summarizeEvidencePayload(). `confidence` 0..1; NEVER 0 for a real signal
 * (0 is reserved for mock data and is excluded from grounding).
 */
export interface SignalRecordedPayload extends Prisma.InputJsonObject {
  readonly kind: SignalEventKind;
  readonly source: string; // real URL
  readonly date: string; // ISO 8601
  readonly summary?: string;
  readonly confidence: number; // 0..1, >0 for real signals
  // kind-specific (all optional; summarizeEvidencePayload reads these):
  readonly jobTitle?: string;
  readonly amount?: string;
  readonly round?: string;
  readonly leadInvestor?: string;
  readonly productName?: string;
  readonly quote?: string;
  readonly role?: string;
  readonly name?: string;
  readonly outlet?: string;
  readonly headline?: string;
}
```

Add `SignalRecordedPayload` to the `EvidenceEventPayload` union.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && pnpm test -- evidence-event.types.spec`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/observability/evidence-event.types.ts apps/api/src/observability/__tests__/evidence-event.types.spec.ts
git commit -m "feat(evidence): define prospect-signal event kinds + payload"
```

---

### Task 2: `isMocked()` guard

**Files:**
- Modify: `apps/api/src/runtime/tools/mock-metadata.ts`
- Test: `apps/api/src/runtime/tools/__tests__/mock-metadata.spec.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
import { isMocked, markMocked } from "../mock-metadata";
describe("isMocked", () => {
  it("detects mock-tagged data", () => {
    expect(isMocked(markMocked({ a: 1 }, "no key"))).toBe(true);
  });
  it("treats real data and nullish as not mocked", () => {
    expect(isMocked({ a: 1 })).toBe(false);
    expect(isMocked(null)).toBe(false);
    expect(isMocked(undefined)).toBe(false);
  });
});
```

- [ ] **Step 2: Run** `cd apps/api && pnpm test -- mock-metadata.spec` → FAIL (`isMocked` undefined).

- [ ] **Step 3: Implement** — append to `mock-metadata.ts`:

```ts
/** True if a value carries the mock metadata flag. Mock data must never be cited as fact. */
export function isMocked(data: unknown): boolean {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { source?: unknown }).source === "mock"
  );
}
```

- [ ] **Step 4: Run** → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/runtime/tools/mock-metadata.ts apps/api/src/runtime/tools/__tests__/mock-metadata.spec.ts
git commit -m "feat(tools): add isMocked guard"
```

---

### Task 3: `EvidenceLedgerService.recordSignal()`

**Files:**
- Modify: `apps/api/src/observability/evidence-ledger.service.ts`
- Test: `apps/api/src/observability/__tests__/evidence-ledger.signal.spec.ts` (create)

- [ ] **Step 1: Write the failing test** (mirror the existing ledger spec style — a fake PrismaService capturing `evidenceEvent.create`):

```ts
import { EvidenceLedgerService } from "../evidence-ledger.service";

function fakePrisma() {
  const created: any[] = [];
  return { created, evidenceEvent: { create: async ({ data }: any) => { created.push(data); return data; } } } as any;
}

describe("recordSignal", () => {
  it("appends a signal EvidenceEvent with company refType + payload", async () => {
    const prisma = fakePrisma();
    const svc = new EvidenceLedgerService(prisma);
    await svc.recordSignal({
      orgId: "o1", runId: "r1", companyId: "c1", kind: "recent_hire",
      source: "https://jobs.example.com/123", date: "2026-05-20",
      summary: 'Posted "Senior SDR".', confidence: 0.9, fields: { jobTitle: "Senior SDR" },
    });
    expect(prisma.created).toHaveLength(1);
    expect(prisma.created[0]).toMatchObject({
      orgId: "o1", runId: "r1", kind: "recent_hire", refType: "company", refId: "c1",
    });
    expect(prisma.created[0].payload).toMatchObject({
      kind: "recent_hire", source: "https://jobs.example.com/123", date: "2026-05-20", confidence: 0.9, jobTitle: "Senior SDR",
    });
  });
});
```

- [ ] **Step 2: Run** `cd apps/api && pnpm test -- evidence-ledger.signal.spec` → FAIL.

- [ ] **Step 3: Implement** — add to `EvidenceLedgerService` (after `leadScored`), importing `SignalEventKind`, `SignalRecordedPayload` from the types file:

```ts
  async recordSignal(input: {
    readonly orgId: string;
    readonly runId?: string | null;
    readonly companyId?: string | null;
    readonly personId?: string | null;
    readonly kind: SignalEventKind;
    readonly source: string;
    readonly date: string;
    readonly summary?: string;
    readonly confidence: number;
    readonly fields?: Partial<Omit<SignalRecordedPayload, "kind" | "source" | "date" | "summary" | "confidence">>;
  }): Promise<void> {
    const refType = input.companyId ? "company" : "person";
    const refId = input.companyId ?? input.personId ?? "unknown";
    return this.append({
      orgId: input.orgId,
      runId: input.runId ?? null,
      kind: input.kind,
      refType,
      refId,
      payload: {
        kind: input.kind,
        source: input.source,
        date: input.date,
        summary: input.summary,
        confidence: input.confidence,
        ...(input.fields ?? {}),
      } as SignalRecordedPayload,
    });
  }
```

- [ ] **Step 4: Run** → PASS.

- [ ] **Step 5: Commit** `git commit -am "feat(evidence): recordSignal writer for prospect signals"`

---

### Task 4: Freshness windows + brief filtering (refusal-first)

**Files:**
- Create: `apps/api/src/graph/nodes/research/freshness.ts`
- Modify: `apps/api/src/graph/nodes/sdr-outreach-subgraph.ts:746-803`
- Test: `apps/api/src/graph/nodes/research/__tests__/freshness.spec.ts` (create) + extend the brief test (`_internalForTests` already exports internals at `:889`)

- [ ] **Step 1: Write the failing freshness test**

```ts
import { isFresh, FRESHNESS_WINDOWS } from "../freshness";
describe("isFresh", () => {
  const now = new Date("2026-06-07T00:00:00Z");
  it("counts a recent_hire within 75d as fresh", () => {
    expect(isFresh("recent_hire", "2026-05-01", now)).toBe(true);
  });
  it("excludes a recent_hire older than 75d", () => {
    expect(isFresh("recent_hire", "2026-01-01", now)).toBe(false);
  });
  it("uses a longer window for funding_event", () => {
    expect(isFresh("funding_event", "2025-09-01", now)).toBe(true);
    expect(FRESHNESS_WINDOWS.funding_event).toBeGreaterThan(FRESHNESS_WINDOWS.recent_hire);
  });
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement `freshness.ts`**

```ts
import type { SignalEventKind } from "../../../observability/evidence-event.types";

/** Max age (days) a signal kind may be and still count toward grounding. */
export const FRESHNESS_WINDOWS: Record<SignalEventKind, number> = {
  recent_hire: 75,
  funding_event: 365,
  leadership_change: 365,
  product_launch: 120,
  press_mention: 90,
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** True if `isoDate` is within the freshness window for `kind` relative to `now`. */
export function isFresh(kind: string, isoDate: string | undefined, now: Date = new Date()): boolean {
  const window = (FRESHNESS_WINDOWS as Record<string, number>)[kind];
  if (!window || !isoDate) return false;
  const d = new Date(isoDate);
  if (Number.isNaN(d.getTime())) return false;
  return now.getTime() - d.getTime() <= window * DAY_MS;
}
```

- [ ] **Step 4: Run** → PASS. Commit: `git commit -am "feat(research): signal freshness windows"`

- [ ] **Step 5: Write the failing brief test** (refusal-first) — in the brief spec, build a fake prisma whose `evidenceEvent.findMany` returns (a) a stale `recent_hire` and (b) a mock-tagged signal, and assert `hasGroundingSignal === false`; then a fresh real one and assert `true` and that the fact carries the payload `date`.

```ts
// fresh date computed relative to today so the test doesn't rot:
const freshDate = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
const staleDate = "2025-01-01";
// findMany returns [{kind:"recent_hire", payload:{date:staleDate, source:"https://x", confidence:0.9, jobTitle:"SDR"}, createdAt:new Date()}]
// → expect brief.hasGroundingSignal === false (stale)
// findMany returns [{kind:"recent_hire", payload:{date:freshDate, source:"https://x", confidence:0.9, jobTitle:"SDR"}, createdAt:new Date()}]
// → expect brief.hasGroundingSignal === true AND the S1 fact.date === freshDate
// findMany returns [{kind:"press_mention", payload:{source:"mock", confidence:0, date:freshDate}, createdAt:new Date()}]
// → expect brief.hasGroundingSignal === false (mock excluded)
```

- [ ] **Step 6: Run** → FAIL.

- [ ] **Step 7: Modify `assembleResearchBrief` (`:746-803`)** — in the signal loop, derive the effective date from `payload.date` (fallback `createdAt`), skip mock + stale, and count only fresh:

```ts
  // Behavioral signals (S-series) from EvidenceEvent — most recent first, fresh + non-mock only.
  let signalCount = 0;
  if (company?.id) {
    const events = await prisma.evidenceEvent.findMany({
      where: {
        orgId: lead.orgId,
        OR: [
          { refType: "company", refId: company.id },
          { refType: "person", refId: lead.personId },
        ],
        kind: { in: Array.from(SIGNAL_KINDS) },
      },
      orderBy: { createdAt: "desc" },
      take: MAX_RECENT_EVIDENCE_EVENTS,
      select: { kind: true, payload: true, createdAt: true },
    });
    for (const ev of events) {
      const payload = (ev.payload ?? {}) as Record<string, unknown>;
      if (isMocked(payload)) continue; // mock never becomes a cited fact
      const effectiveDate =
        typeof payload.date === "string" ? payload.date : ev.createdAt.toISOString().slice(0, 10);
      if (!isFresh(ev.kind, effectiveDate)) continue; // stale signals don't ground
      signalCount += 1;
      facts.push({
        id: `S${signalCount}`,
        category: "signal",
        source: typeof payload.source === "string" ? payload.source : `evidence_event.${ev.kind}`,
        text: summarizeEvidencePayload(ev.kind, ev.payload),
        date: effectiveDate,
      });
    }
  }
```

Add imports at the top of the file: `import { isMocked } from "../../runtime/tools/mock-metadata";` and `import { isFresh } from "./research/freshness";`. Change `hasGroundingSignal` to: `hasGroundingSignal: signalCount > 0` (drop the `intentSignals` OR — stale/ungrounded intent strings must not satisfy the refusal gate; this is the whole point of the wedge).

- [ ] **Step 8: Run** the brief spec → PASS. Run the full subgraph spec to catch regressions. Commit: `git commit -am "feat(research): brief counts only fresh, non-mock signals (refusal-first)"`

---

### Task 5: SignalExtractionService

**Files:**
- Create: `apps/api/src/graph/nodes/research/signal-extraction.service.ts`
- Test: `apps/api/src/graph/nodes/research/__tests__/signal-extraction.service.spec.ts` (create)

**READ FIRST (exact source shapes — do not assume):**
- `apps/api/src/leads/sources/theirstack.service.ts` — its public method + the job object shape (title/date/url). Map each job → a `recent_hire` signal: `{ kind:"recent_hire", source: <job url>, date: <ISO posting date>, summary: 'Posted "<title>".', confidence: 0.9, fields:{ jobTitle:<title>, source:<board> } }`.
- `apps/api/src/leads/sources/registry-scraper.service.ts` — its method + filing shape. Map funding filings → `funding_event` `{ source:<filing url>, date:<ISO filing date>, fields:{ amount, round } }`; leadership filings → `leadership_change` `{ fields:{ role, name } }`.
- Confirm whether sourcing already persisted this onto `Company.raw` (Json) — if so, prefer reading `company.raw` over re-fetching; otherwise call the service per company.

- [ ] **Step 1: Write the failing test** — inject fake theirstack/registry services + a fake `web_search` tool; assert:
  - a TheirStack job with a date → one `recent_hire` signal input with that date + url;
  - a `web_search` result (real) → one `press_mention` signal input with the result url + today's date;
  - a **mock-tagged** `web_search` result → **zero** signal inputs (the critical guard);
  - dedupe: two qualified leads at the same company → company-level extractors run once.

```ts
import { SignalExtractionService } from "../signal-extraction.service";
import { markMocked } from "../../../../runtime/tools/mock-metadata";

const company = { id: "c1", name: "Lumen", domain: "lumen.com", raw: {} } as any;

it("emits a press_mention from a real web_search result and none from mock", async () => {
  const realSearch = { execute: async () => ({ success: true, data: { results: [{ title: "Lumen raises $20M", url: "https://news.example.com/lumen", snippet: "..." }] } }) } as any;
  const svc = new SignalExtractionService(realSearch, /*theirstack*/ stubNoJobs(), /*registry*/ stubNoFilings());
  const out = await svc.extractForCompany(company, new Date("2026-06-07"));
  expect(out.find((s) => s.kind === "press_mention")).toMatchObject({ source: "https://news.example.com/lumen", date: "2026-06-07" });

  const mockSearch = { execute: async () => ({ success: true, data: markMocked({ results: [{ title: "x", url: "https://x" }] }, "no key") }) } as any;
  const svc2 = new SignalExtractionService(mockSearch, stubNoJobs(), stubNoFilings());
  expect(await svc2.extractForCompany(company, new Date("2026-06-07"))).toHaveLength(0);
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** — `SignalExtractionService` with constructor `(webSearch: Tool, theirstack: TheirstackService, registry: RegistryScraperService)`. Output type:

```ts
export interface SignalInput {
  kind: SignalEventKind;
  source: string;
  date: string; // ISO
  summary?: string;
  confidence: number;
  fields?: Record<string, string>;
}
```

`extractForCompany(company, now)` returns `SignalInput[]`:
- `extractFromScraped(company)` — parse jobs/filings (per the READ-FIRST shapes) into `recent_hire`/`funding_event`/`leadership_change` inputs. Skip any item whose source data `isMocked(...)`.
- `extractLiveTrigger(company, now)` — call `this.webSearch.execute({ query: `"${company.name}" funding OR launches OR partnership OR hires`, max_results: 3 })`. If `isMocked(result.data)` or `!result.success` → return `[]`. Else take the top result → one `press_mention` `{ source: result.url, date: now.toISOString().slice(0,10), summary: result.title, confidence: 0.6, fields:{ outlet: hostname(result.url), headline: result.title } }`.
- Concatenate; cap one live search per company.

- [ ] **Step 4: Run** → PASS. Commit: `git commit -am "feat(research): SignalExtractionService (parse + one live trigger, mock-excluded)"`

---

### Task 6: RESEARCH node + graph wiring

**Files:**
- Create: `apps/api/src/graph/nodes/research/research.node.ts`
- Modify: `apps/api/src/graph/state.ts` (`NODE`, `STAGE`)
- Modify: `apps/api/src/graph/pipeline-graph.ts` (deps, addNode/addEdge, `pickNext`)
- Test: `apps/api/src/graph/nodes/research/__tests__/research.node.spec.ts` (create)

- [ ] **Step 1: Add `NODE.RESEARCH` + `STAGE.RESEARCH`** to `state.ts` (`RESEARCH: "research_agent"` in NODE; `RESEARCH: "research"` in STAGE). Run `pnpm test` for any state snapshot; commit.

- [ ] **Step 2: Write the failing node test** — fake deps (signalExtraction returning 2 inputs for 1 qualified company; an evidenceLedger spy). Assert the node calls `recordSignal` once per input, only for tier A/B companies, deduped per company, and returns `{ stagesCompleted: [STAGE.RESEARCH], ... }`.

- [ ] **Step 3: Run** → FAIL.

- [ ] **Step 4: Implement `research.node.ts`** following the existing node pattern in `pipeline-graph.ts` (`:336-431` scoring node is the template): guard `upstreamFailed(state, STAGE.SCORING)` → skip with `stageStatus(STAGE.RESEARCH,"FAILED")`; else for each unique company among `state.scoredLeads.filter(s => s.tier==="A"||s.tier==="B")` (dedupe by companyId/domain), look up the Company, call `signalExtraction.extractForCompany(company, new Date())`, and `await evidenceLedger.recordSignal({ orgId: state.orgId, runId: state.graphRunId, companyId: company.id, ...input })` for each input, each wrapped so one company's failure doesn't fail the stage; set `update.stagesCompleted=[STAGE.RESEARCH]` + `stageStatus(STAGE.RESEARCH,"COMPLETED")` + a `nowMsg(NODE.RESEARCH, ...)` progress line.

- [ ] **Step 5: Wire the graph** in `pipeline-graph.ts`:
  - Add to `Deps`: `signalExtraction: SignalExtractionService;` and construct it (web_search tool + theirstack + registry services — pull from the existing module providers).
  - `.addNode(NODE.RESEARCH, researchAgent).addEdge(NODE.RESEARCH, NODE.SUPERVISOR)`.
  - Update `pickNext(done, approved)` (`:676-682`) so the order is `SOURCING → ENRICHMENT → SCORING → RESEARCH → APPROVAL → OUTREACH` (insert a `if (!done.has(STAGE.RESEARCH)) return NODE.RESEARCH;` check after SCORING and before the approval gate — match the existing structure exactly).

- [ ] **Step 6: Run** node test + full graph spec → PASS. Type-check. Commit: `git commit -am "feat(graph): RESEARCH node writes prospect signals between scoring and approval"`

---

### Task 7: End-to-end grounding test + module wiring

**Files:**
- Modify: the graph module/provider wiring so `SignalExtractionService` + its deps are injected.
- Test: `apps/api/src/graph/nodes/research/__tests__/grounding.e2e.spec.ts` (create)

- [ ] **Step 1: Write the failing E2E test** — seed a fake prisma with one qualified company + person; run RESEARCH (writes a fresh `recent_hire`), then `assembleResearchBrief` → assert `hasGroundingSignal === true` and `facts.some(f => f.category === "signal" && f.date)`; separately, a company with no jobs/filings + mock-only search → `assembleResearchBrief` → `hasGroundingSignal === false` (drafter will refuse).

- [ ] **Step 2: Run** → FAIL. **Step 3:** wire providers so the real services inject. **Step 4: Run** → PASS.

- [ ] **Step 5: Full check** — `cd apps/api && pnpm test` (whole suite) + `pnpm --filter @apex/api exec tsc --noEmit -p tsconfig.json`. Fix any regressions. Commit: `git commit -am "test(research): end-to-end grounding + refusal"`

---

## Config dependency (flag, do not block)

The live trigger uses `web_search` → **`TAVILY_API_KEY`**. Prod currently has `SERPER_API_KEY`, not Tavily — so in prod the live search degrades to mock → **no live signal** (parse-only still works; refusal still correct). To actually get live triggers in prod, either set `TAVILY_API_KEY` on `apex-gtm-api`/`worker`, or add a Serper branch to `web-search.tool.ts` (separate small task). Either way the system is safe without it.

## Self-review

- **Spec coverage:** RESEARCH node after SCORING (Task 6) ✓; signal kinds (Task 1) ✓; recordSignal (Task 3) ✓; parse + one live trigger (Task 5) ✓; freshness contract (Task 4) ✓; mock-never-a-fact (Tasks 2,4,5) ✓; citation/date on facts (Task 4) ✓; qualified-only + dedupe (Task 6) ✓; refusal-first tests (Tasks 4,7) ✓; error isolation (Task 6) ✓.
- **Placeholder scan:** Task 5 names exact files to read for the two external service shapes and gives the exact target payloads — not a vague placeholder.
- **Type consistency:** `SignalEventKind`/`SignalRecordedPayload` (Task 1) used consistently in Tasks 3/5/6; `SignalInput` defined in Task 5 and consumed in Task 6; `isFresh`/`FRESHNESS_WINDOWS` (Task 4) used in Task 4's brief change.
