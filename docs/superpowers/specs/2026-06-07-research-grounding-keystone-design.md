# Research-Grounding Keystone — Design Spec

**Date:** 2026-06-07
**Branch:** `feat/research-grounding-keystone` (off `release/go-live-2026-06-01`)
**Sub-project:** A (of the Evidence-Engine NOW roadmap — see `phenomenal-product-plan-2026-06-07.md`)
**Status:** Approved design → ready for implementation plan

## Problem

The Evidence-Engine wedge is "every email cites a real, dated trigger, or it refuses to send." Today the platform **always refuses** because the grounding signals are structurally absent:

- `assembleResearchBrief()` (`apps/api/src/graph/nodes/sdr-outreach-subgraph.ts:670`) reads "behavioral signals" from `EvidenceEvent` rows of kind `recent_hire / funding_event / leadership_change / product_launch / website_excerpt / tech_signal`.
- But `EVIDENCE_EVENT_KIND` (`apps/api/src/observability/evidence-event.types.ts`) only defines **process** kinds (`leadSourced, leadScored, messageDrafted, qaPass, messageSent`, …). **None of the prospect-signal kinds exist or are written.**
- So `<signals>` is always empty → `hasGroundingSignal=false` → the drafter's `refusal_protocol` (`sdr-outreach-subgraph.ts:269`) fires on every lead.
- `<website_excerpt>` is a separate `// web_fetch sidecar lands later this week` TODO (`:667`).

The research tools (`company_research`, `web_scrape`, `web_search`) exist and work but are stranded on the deprecated executor path; the LangGraph pipeline never calls them.

## Goal (this increment)

Real fresh signals → the brief lights up → the drafter produces a **grounded draft citing a real dated trigger**, or an **honest refusal**. Nothing fake ever gets cited.

## Architecture

A new graph node **`NODE.RESEARCH`** (stage `RESEARCH`) inserted **between `SCORING` and `APPROVAL`** in `apps/api/src/graph/pipeline-graph.ts`, following the existing node pattern (`upstreamFailed(SCORING)` guard, `stageStatus`, `stagesCompleted`, OTel span).

- Runs **only on qualified (tier A/B) leads**, **deduped per company** (research each company once per run).
- Writes dated **signal `EvidenceEvent`** rows via the ledger. Does **not** mutate leads.
- `assembleResearchBrief()` stays **read-only** — it gains real signals to read, plus a freshness filter and a mock-exclusion filter.

Scope is "hybrid: parse existing + one live trigger" — deterministic parsing of already-fetched material, plus a single live web search per company.

## Components

1. **Signal kinds** — extend `EVIDENCE_EVENT_KIND` and add typed payload interfaces for: `recent_hire`, `funding_event`, `leadership_change`, `product_launch`, `press_mention`, `website_excerpt`, `tech_signal`. Each signal payload carries: `source` (URL), `date` (ISO 8601), `summary` (string), `confidence` (0–1). The `source`/`date` map directly onto `BriefFact.source`/`BriefFact.date`.

2. **`EvidenceLedgerService.recordSignal(input)`** — one new append-only write method (`apps/api/src/observability/evidence-ledger.service.ts`), same shape as the existing `leadSourced`/`leadScored` writers. Idempotency: skip if an identical `(orgId, runId, refId, kind, source)` signal already exists for this run (avoid duplicate facts on retry).

3. **`SignalExtractionService`** (new, under `apps/api/src/graph/` or `apps/api/src/research/`):
   - `extractFromScraped(company, lead)` — deterministic parse of material the pipeline already fetched:
     - TheirStack dated job posts → `recent_hire` (with the posting date + URL).
     - EDGAR filings → `funding_event` / `leadership_change` (with filing date + URL).
   - `extractLiveTrigger(company)` — **one** `web_search` call (recent-news query, e.g. `"<company>" funding OR launches OR hires`), take the top **fresh** result → `press_mention` / `product_launch` with the result URL + date.
   - Dedups per company; hard cap of one live search per company per run.

4. **`research.node.ts`** — the node handler: for each unique company among qualified leads, call the extractors and `recordSignal` for each finding; emit progress messages; set `stagesCompleted=[RESEARCH]`.

## The three non-negotiable contracts

1. **Citation** — every signal carries `source` + ISO `date`; it surfaces in `<signals>` as a `fact_id` (S-series). No undated/unsourced signal is ever written.
2. **Freshness** — a `FRESHNESS_WINDOWS` map keyed by signal kind (initial defaults, tunable): `recent_hire` 75d, `funding_event` 365d, `leadership_change` 365d, `product_launch` 120d, `press_mention` 90d, `website_excerpt` 180d, `tech_signal` 180d. Stale signals are **stored** but excluded from `hasGroundingSignal` — so a lead with only stale signals correctly **refuses**.
3. **Mock-never-a-fact** — `markMocked()` output (`apps/api/src/runtime/tools/mock-metadata.ts`) is excluded at **two layers**: (a) `SignalExtractionService` checks `isMocked(data)` and writes **no** signal from mocked tool output; (b) `assembleResearchBrief` defensively filters any fact whose payload carries mock metadata. A failed/keyless tool yields **no signal**, never a fabricated one → refusal fires.

## Data flow

```
SCORING (tier A/B leads)
  → RESEARCH node:
      for each unique qualified company:
        extractFromScraped(...)  → recordSignal(...)   // deterministic, dated
        extractLiveTrigger(...)  → recordSignal(...)   // 1 live search, dated, mock-excluded
  → APPROVAL (interrupt)
  → OUTREACH (SDR subgraph):
      assembleResearchBrief() reads FRESH, non-mock signals → <signals> fact_ids
        ≥1 fresh signal → grounded draft citing a real fact_id
        0 fresh signals → refusal (insufficient_grounding)
```

## Error handling

- `RESEARCH` follows the node pattern: `upstreamFailed(SCORING)` → skip with `stageStatus(RESEARCH, "FAILED")`.
- Per-company extraction is isolated in try/catch — one company's failure does not fail the stage.
- `web_search` failure or missing `SERPER` key → **no live signal** (degrade to parse-only; never mock).
- The stage completes `COMPLETED` even if some companies yield zero signals — those leads refuse at draft time, which is the **correct** behavior, not an error.

## Testing (TDD, refusal-first)

- **Unit — extractors:** TheirStack job → `recent_hire` with correct date+URL; EDGAR filing → `funding_event`; web_search result → `press_mention`; **mocked tool data → zero signals** (the critical guard).
- **Unit — freshness:** a signal older than its window is excluded from `hasGroundingSignal`; a fresh one is included.
- **Unit — brief:** `assembleResearchBrief` emits fresh signals as `fact_id`s; excludes mock and stale facts.
- **Integration — node:** `RESEARCH` writes `EvidenceEvent`s only for qualified companies; deduped per company.
- **Integration — end to end:** lead with no fresh signal → drafter **refuses** (`insufficient_grounding`); lead with a fresh signal → draft **cites** a real `fact_id`. Write the refusal test **first**.

## Scope boundary (YAGNI — explicitly NOT in this increment)

- Full multi-source per-lead dossier ("5+ sources") — later increment.
- Deep `website_excerpt` content fetch beyond the one live trigger.
- `tech_signal` extraction — no data source wired yet (kind is defined for forward-compat only).
- The FE "Why this email" evidence card — that is sub-project D.
- Apollo enrichment — that is sub-project B.

## To confirm during the implementation-plan step (reads, not assumptions)

- Exactly where TheirStack / EDGAR data lands on the lead today (sourcing payload vs enrichment payload) and its shape.
- The precise `web_search.tool.ts` output shape (result fields: title/url/snippet/date?).
- How qualified (tier A/B) leads are represented in graph state after `SCORING`, and how to group them by company.
