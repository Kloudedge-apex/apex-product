---
date: 2026-05-31
timestamp: 2026-05-31T23:00:00Z
subject: Sourcing pipeline agent audit — why FAQ headers became leads and SEO aggregators became companies
author: Claude Opus 4.7 (claude-opus-4-7)
session_id: 0a018912-8ce7-4099-893d-2b7c15b9277a
target_image: ledgracr.azurecr.io/apex-api:401580c3b9c7cfa6435d791badeb9aaa6695b16b
target_revs: apex-gtm-api--0000096, apex-gtm-worker--0000051
---

# Sourcing pipeline agent audit

**Symptom:** page section headers ("Frequently Asked Questions", "Services We Help You Find", "Legal Compliance", "Saudi Arabia", "United Arab Emirates") are appearing in the Person table with synthesised emails like `frequently.askedquestions@gccdomestic.com`. SEO aggregator URLs (`dnb.com`, `consultancy-me.com`, `legal500.com`, `cultureamp.com`, `landbase.com`, `marknteladvisors.com`, `ocorian.com`, `devcommx.com`, `regtechafrica.com`) are appearing in the Company table all blanket-tagged `industry="B2B SaaS"` and `country="United Arab Emirates"` regardless of what the URL actually is. Scoring assigns these garbage rows exactly 45 points each, so they survive the tier cut.

**Audit scope:** every LLM-using node in the pipeline graph (`apps/api/src/graph/pipeline-graph.ts` + `apps/api/src/graph/nodes/*`) plus the deterministic helpers that load-bear on those LLM outputs.

## Pipeline overview

The supervisor LangGraph in `/tmp/apex-sprint24h-mirror/apps/api/src/graph/pipeline-graph.ts` orchestrates 5 stages in this order:

- **supervisor** (`pipeline-graph.ts:102-125`) — routes deterministically; not an LLM.
- **sourcing** (`pipeline-graph.ts:127-213`) — delegates to `LeadsService.runSourcingStage` → company discovery (SERP / TheirStack / ATS / Registry) then people discovery (SERP people + team-page scraping + ATS + GitHub).
- **enrichment** (`pipeline-graph.ts:215-320`) — delegates to `LeadsService.runEnrichmentStage` → identity resolution + email-pattern generation/verification. **No LLM** in this stage.
- **scoring** (`pipeline-graph.ts:322-423`) — delegates to `LeadsService.runScoringStage` which calls `LeadScorer.score`. **No LLM** — purely deterministic rule scoring.
- **human_approval** (`pipeline-graph.ts:425-466`) — `interrupt()` for review; not an LLM.
- **outreach** (`pipeline-graph.ts:468-604`) — for each tier-A/B lead, invokes the SDR sub-graph: `build_research_brief` → `draft_message` (LLM) → `qa_message` → `require_human_review`.

**LLM-using nodes inside the live pipeline:** only two.
1. `TeamPageScraper.extractWithLlm` — fallback inside the sourcing stage.
2. `draft_message` inside the SDR outreach sub-graph.

A third LLM call lives in `IcpAutoService.extractIcpWithLlm` (`apps/api/src/pipeline/icp-auto.service.ts`). It is **not** triggered by the pipeline graph itself — it runs out-of-band when a user kicks off a pipeline without an ICP. Including it because it directly produces the `targetIndustries`/`targetGeos` strings that get blanket-copied onto every company by SERP.

All LLM calls in the pipeline run with **temperature 0.7** (hard-coded in `LLMService.callAzureOpenAI:358`, not overridable per call site) and model `process.env.SYSTEM_MODEL_MINI ?? "gpt-4o-mini"`. That's surprising for structured-extraction tasks — these typically want 0.

## Agent: team_page_extractor.extract (LLM fallback inside sourcing)

- **File:** `apps/api/src/leads/sources/team-page-scraper.service.ts:211-275`
- **Function:** Last-resort extractor that fires when `TeamPageScraper.scrapeTeamPage` walks the candidate URLs (`/about`, `/team`, `/leadership`, `/people`, `/our-team`, `/about-us`, `/company/team`, `/executives`, `/management`, `/founders`) on each sourced company domain and gets HTML that neither `extractJsonLd` nor `extractFromDom` could parse. The HTML is stripped to plain text, clipped to 8 000 chars, and the LLM is asked to find "people who clearly work at this company" and emit them as `{firstName, lastName, title, linkedinUrl}`.
- **Input:** the stripped/truncated HTML body of one of the candidate URLs above on a domain that was previously upserted into `Company` by `LeadsService.discoverCompanies`. Domain comes ultimately from SERP results.
- **Output:** `DiscoveredPerson[]` (`firstName`, `lastName`, `title?`, `linkedinUrl?`, `linkedinSlug?`). Each row is fed straight into `LeadsService.upsertPerson` (`leads.service.ts:426-484`). The downstream `isValidPersonName` regex (`leads.service.ts:486-512`) is the **only** quality gate.
- **Model + temp:** `process.env.SYSTEM_MODEL_MINI ?? "gpt-4o-mini"`, **temperature 0.7** (hard-coded default in `LLMService.callAzureOpenAI`, line 358; no per-call override).

**System prompt** (verbatim, single-string constant assembled inline at `team-page-scraper.service.ts:230-231`):

```
Extract people (team members, leadership) from this web page text. Return a JSON object {"people": [{firstName, lastName, title, linkedinUrl}]}. Only include people who clearly work at this company. Return {"people":[]} if none found.
```

**User prompt template** (verbatim, `team-page-scraper.service.ts:234-235`):

```
URL: ${url}

Page text:
${stripped}
```

**Output schema** (validator at `team-page-scraper.service.ts:294-319`):

```ts
type TeamPagePayload = { people: DiscoveredPerson[] } | DiscoveredPerson[];
// each DiscoveredPerson requires firstName: string, lastName: string
// title?: string, linkedinUrl?: string
```
Schema description sent on retry: `'{"people": [{"firstName": string, "lastName": string, "title"?: string, "linkedinUrl"?: string}]}'`.

**Smells:**
- The prompt has **no anti-hallucination rule**. It does not tell the model "ignore navigation, footer, FAQ headings, country lists, service categories" — so when fed a stripped-HTML page with phrases like "Frequently Asked Questions" / "Services We Help You Find" / "Legal Compliance" / "Saudi Arabia" / "United Arab Emirates", the model happily packages those phrases as `{firstName: "Frequently", lastName: "Asked Questions"}`.
- "people who clearly work at this company" is the only filter, with zero positive criteria for what a person is. No instruction that names must be human names, titles must be job titles.
- **Temperature 0.7** for a structured-extraction task — should be 0.
- The `isValidPersonName` regex downstream (`leads.service.ts:489-490`) is `^[A-Z][a-zA-Z'-]{1,19}$`. "Frequently" passes (starts with `F`, all letters, length 10). "Asked" passes. "Saudi" passes. "Arabia" passes. **The garbage filter explicitly only blocks "find out", "learn more", "contact us"…** — see `garbage` list at `leads.service.ts:494-500`. It has no entry for "frequently asked", "services we help", "legal compliance", or country names. That is why `frequently.askedquestions@gccdomestic.com` reaches the DB.
- The fallback runs whenever JSON-LD + DOM patterns both miss, which is most directory/SEO/aggregator pages — exactly the worst case for blind extraction.

## Agent: sdr_agent.draft_message (SDR outreach sub-graph)

- **File:** `apps/api/src/graph/nodes/sdr-outreach-subgraph.ts:228-360` (prompt constant at 228-284; user template at 286-304; LLM call at 306-360)
- **Function:** Inside the SDR sub-graph, after `build_research_brief` assembles an XML "brief" of facts about the lead+company from the DB, this node sends one chat call to draft a cold-email subject + body. If the brief has no behavioural/firmographic signal, the model is told to refuse with `{"refusal": {...}}` rather than draft. QA then routes back to drafting up to 2 attempts, then to `require_human_review`.
- **Input:** `state.researchBrief.xml` (string) + `lead` (firstName, lastName, title, companyName, domain). Brief comes from `Company`, `Person`, `LeadScore`, recent `EvidenceEvent` rows.
- **Output:** `{ subject, body, refusal, groundednessSelfCheck }` parsed from raw JSON by `parseDrafterJson`. Result is attached to an `OutreachArtifact` (`status: NEEDS_REVIEW`) — **never sent externally**; it's a draft for a human reviewer. The user-observed garbage was upstream Person/Company rows, not these drafts.
- **Model + temp:** `LLMService.chat` default — env-resolved (`DEFAULT_MODEL ?? "gpt-4o-mini"`), **temperature 0.7** hard-coded in transport.

**System prompt** (verbatim, constant `SDR_DRAFT_SYSTEM_PROMPT` at lines 228-284):

```
You are Apex SDR, an outbound writer for first-touch B2B cold email.

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
    "cited_fact_ids": ["array of fact_id strings from <brief> you used",
    "unsupported_claims": ["array of any sentence you suspect is not grounded; empty array if confident"]
  }
}
</output_schema>

<style>
Plaintext only. One specific signal in line 1. One sentence on relevance
to the buyer's role. One soft CTA (e.g. "worth a 15-min look?"). No
hard-sell. Reading level: 5th-6th grade (short sentences, common words).
</style>
```

**User prompt template** (verbatim, `renderUserPrompt` at lines 286-304):

```
<brief>
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
Draft the email now. Remember: refuse if no specific signal is available.
```

Where `${previous}` is empty on attempt 1, and on retry is:
```
<previous_attempt_feedback>
Flagged issues: ${input.previousAttempt.issues.join(", ")}. Fix them.
</previous_attempt_feedback>
```

And `${input.brief.xml}` is assembled by `renderBriefXml` (lines 776-811) with `<firmographic>`, `<person>`, `<signals>`, `<icp_fit>`, and `<do_not_claim>` sections — see source for full shape.

**Output schema:** raw JSON parsed by `parseDrafterJson` (lines 362-390). Strict shape. No Zod, no `withStructuredOutput`. Then `qaCheck` (lines 198-220) enforces `MAX_SUBJECT_LEN=120`, `MAX_BODY_LEN=2000`, `MIN_BODY_LEN=30`, and placeholder-leak strings `["{{", "}}", "[FIRST_NAME]", "[COMPANY]", "TODO", "<insert"]`.

**Smells:**
- The drafting prompt itself is the most disciplined of the three. The refusal protocol is good in principle.
- However: `assembleResearchBrief` builds `F1` (firmographic) by reading `company.industry` and `company.country` directly. If those came from SERP and are blanket "B2B SaaS" / "United Arab Emirates", the brief will state that as fact and the model will faithfully cite it — so a downstream "Apex SDR" email about page-section-text "Frequently Asked Questions" working at "GCC Domestic" in the "B2B SaaS" industry would be the output. The drafter is not responsible for the garbage; it's a faithful echo of corrupt brief data.
- `hasGroundingSignal` (line 772) is `true` whenever there is any `EvidenceEvent` of the listed kinds, **OR** `company.intentSignals` is non-empty. Most companies don't have evidence events but `intentSignals` is filled by `JobSignalService.scoreJobIntent` from TheirStack job data — so the refusal protocol rarely actually fires for "real" companies, even when no person-specific signal exists.
- Temperature 0.7 for a JSON-strict task is too hot; explains occasional placeholder leaks and shape violations.

## Agent: icp_auto_extractor.extract (ICP auto-generation, runs out-of-band before the pipeline)

- **File:** `apps/api/src/pipeline/icp-auto.service.ts:162-226`
- **Function:** When a user kicks off a pipeline run but has no `IcpProfile` configured, this service is called. It fetches the org's homepage (resolved from `Org.website` or the first user's business email domain), strips it to plain text, clips to 8 000 chars, and asks the LLM to infer an ICP (target titles, industries, geos, intent keywords, employee range, productSummary). The result is persisted as an `IcpProfile` with `scheduleEnabled: true`. **The single `targetIndustries[0]` and `targetGeos[0]` from this output are then mechanically copied onto every Company sourced by SERP.**
- **Input:** plain-text excerpt of the user's own homepage (not a target's site). Sometimes the user's site is `landbase.com` / `consultancy-me.com` / etc.
- **Output:** `IcpProfile` row — including `targetIndustries: string[]` and `targetGeos: string[]`. These leak into every Company row tagged by SERP.
- **Model + temp:** `process.env.SYSTEM_MODEL_MINI ?? "gpt-4o-mini"`, **temperature 0.7** (transport-level default).

**System prompt** (verbatim, assembled at `icp-auto.service.ts:166-175` as a single concatenated string):

```
You are a senior B2B GTM strategist. Given a company's homepage text, infer the Ideal Customer Profile (ICP) for their outbound sales motion. Respond with ONLY a single JSON object — no prose, no markdown fence. Schema: {"productSummary": string, "industry": string, "targetTitles": string[], "targetIndustries": string[], "targetGeos": string[], "intentKeywords": string[], "minEmployees": number|null, "maxEmployees": number|null}. Titles should be specific buyer roles (e.g. 'VP of RevOps', 'Head of Demand Gen'), not generic ('Manager'). Geos as country names or 'Global'. Intent keywords are phrases that signal a buyer is in-market.
```

**User prompt template** (verbatim, `icp-auto.service.ts:177`):

```
Source URL: ${url}

Homepage text:
${text}
```

**Output schema** (custom guard `isIcpLlmPayload`, lines 246-269): requires the value to be a JSON object with **at least one** of `targetTitles`, `targetIndustries`, `intentKeywords` as a string array. `productSummary`, when present, must be a string. Schema description echoed on retry: `'{"productSummary": string, "industry": string, "targetTitles": string[], "targetIndustries": string[], "targetGeos": string[], "intentKeywords": string[], "minEmployees": number|null, "maxEmployees": number|null}'`.

**Smells:**
- Prompt is open-ended and asks the LLM to fabricate an entire ICP from a homepage. For a marketing-y homepage like consultancy-me.com or dnb.com the LLM will plausibly answer "industry: B2B SaaS, geos: United Arab Emirates" because (a) SaaS is the modal answer the model has seen for "outbound sales motion", and (b) consultancy-me.com mentions the UAE in its content. Once persisted, that single tag becomes the **only** industry/geo SERP can paint onto company rows (see next section). There is no critique step, no "if you are unsure, return empty arrays", no temperature pinning.
- The guard accepts a result with just one non-empty array — so a sparse hallucination still satisfies it.

## Sourcing helper: SerpDiscoveryService (no LLM but the blast radius of the above)

- **File:** `apps/api/src/leads/sources/serp-discovery.service.ts`
- **Function (companies):** Generates Serper.dev queries from the ICP's `targetIndustries × targetGeos`, hits Google via Serper, walks each organic result, and produces a `DiscoveredCompany` row.
- **Smells (load-bearing for the user's reported bug):**
  - `parseCompanyResult` at line 260-267:
    ```
    const geo = icp.targetGeos[0];
    const industry = icp.targetIndustries[0];
    return { domain, name, country: geo, industry, … };
    ```
    Every company gets the **same** industry and country — the first element of the ICP arrays. This is the actual code path that paints "B2B SaaS" + "United Arab Emirates" onto every row regardless of what the URL is.
  - `noiseDomains` filter at line 257 only blocks `google.com, facebook.com, twitter.com, youtube.com, wikipedia.org, github.com`. **It does not block** `dnb.com`, `crunchbase.com`, `legal500.com`, `consultancy-me.com`, `cultureamp.com`, `landbase.com`, `g2.com`, `capterra.com`, `clutch.co`, `apollo.io`, `zoominfo.com`, or any other aggregator/SEO directory. Every directory result becomes a Company row.
  - For LinkedIn `/company/<slug>` results, line 238 synthesises a fake domain when the snippet doesn't yield one: `domain = \`${linkedinMatch[1]!.replace(/-/g, "")}.com\``. That synthetic domain is then "validated" by HEAD-fetching it (line 273-303) — but many random `.com`s actually return 200 (parked pages), so the synthetic domain often persists in the DB.
  - `parseLinkedInPersonResult` at line 305-342 splits `result.title` on a hyphen pattern like `^(.+?)\s*[-–]\s*(.+?)…` and treats the left half as a name. If a SERP result title is `"Saudi Arabia – Service directory"`, this parser will produce `firstName="Saudi", lastName="Arabia", title="Service directory"`. The downstream `isValidPersonName` regex (`leads.service.ts:489-512`) doesn't block country names.

## Email pattern service (where the synthesised emails come from)

- **File:** `apps/api/src/leads/enrichment/email-pattern.service.ts:51-114`
- **Function:** For every Person without an email, generates 6 candidates by templating across patterns (`first.last`, `first`, `flast`, `firstl`, `f.last`, `first_last`, `last.first`, `last`) and stores them as `EmailCandidate` rows. Top 2 are SMTP-verified.
- **Smells (load-bearing for the user's reported bug):**
  - `normalize` at line 315-321 just lowercases, strips diacritics, and strips non-alpha. `"Frequently"` normalises to `frequently`, `"Asked Questions"` (whitespace stripped) normalises to `askedquestions`. Combined with template `first.last`: `frequently.askedquestions@gccdomestic.com` — exactly what the user observed.
  - The candidate is persisted **even if** the verification result is `INVALID` (`leads.service.ts:579-580` only drops `adjustedConfidence` to 0.05; it still upserts at line 587). So junk persists at low confidence rather than being dropped.

## Root-cause hypotheses

**Why page section headers are becoming Person rows.** The `team_page_extractor.extract` LLM fallback in `team-page-scraper.service.ts:230` runs on the stripped-text body of *any* HTML the JSON-LD and DOM regex couldn't parse, and its prompt is a single-sentence "extract people, return JSON" with **zero anti-hallucination rule, no negative criteria, no example of what is not a person, no instruction to ignore navigation/FAQ/footer/country-list text**, and **temperature 0.7**. The downstream `isValidPersonName` guard (`leads.service.ts:486-512`) only blacklists a small set of UI-chrome phrases ("find out", "learn more", "contact us"…) and accepts any TitleCase token pair. So when the page being scraped is a SEO/directory result (because SERP fed in `dnb.com`/`consultancy-me.com` as legitimate companies — see next bullet), the LLM happily extracts `"Frequently Asked Questions"`, `"Services We Help You Find"`, `"Legal Compliance"`, `"Saudi Arabia"`, `"United Arab Emirates"` as people. The email-pattern service then mechanically templates `frequently.askedquestions@gccdomestic.com` and persists it even if SMTP returns INVALID.

**Why SEO aggregators are becoming Company rows.** `SerpDiscoveryService.parseCompanyResult` (`serp-discovery.service.ts:224-271`) accepts any non-LinkedIn organic search result as a company, with only the noise-domain filter at line 257 (`google.com, facebook.com, twitter.com, youtube.com, wikipedia.org, github.com`) — **no aggregator/directory blacklist** (no dnb.com, consultancy-me.com, legal500.com, crunchbase.com, capterra.com, g2.com, clutch.co, cultureamp.com, landbase.com, etc.). The "validation" step at line 273-303 only checks the domain returns a 200 on HEAD — parked aggregator pages pass. The LinkedIn-company branch at line 238 also fabricates a `.com` domain when the snippet has none, contaminating further. There is no classifier that fetches the page and asks "is this a primary business website or a directory listing".

**Why everything is tagged "B2B SaaS" / "United Arab Emirates".** Two compounding facts: (1) `icp_auto_extractor.extract` (`icp-auto.service.ts:166-175`) hallucinates a single industry/geo from a homepage scrape with temperature 0.7, no critique step, and a permissive guard that accepts a sparse output. For consultancy-me.com it lands on `targetIndustries:["B2B SaaS"]`, `targetGeos:["United Arab Emirates"]`. (2) `SerpDiscoveryService.parseCompanyResult` then **mechanically copies `icp.targetIndustries[0]` and `icp.targetGeos[0]` onto every single discovered Company row** (lines 260-267) — it never reads the page, never asks the LLM "what industry is this company in", never even looks at the result snippet. The Company table therefore gets `industry="B2B SaaS"` × `country="United Arab Emirates"` on every row, regardless of what the URL actually is.

**Why scoring rows are showing as 45.** The scoring agent is **not an LLM** — it's `LeadScorer.score` in `apps/api/src/leads/scoring/lead-scorer.service.ts:42-109`, a fixed-weight rule engine: fullName=10, jobTitle=10, companyDomain=10, linkedinUrl=20, geoMatch=5, seniorityMatch=10, verifiedEmail=50 (else sourceConfirmed=50, else patternGuess=15), buyingIntent=15, multiSourceCorroboration=10. A garbage row with `firstName="Frequently", lastName="Asked Questions", title=<something from page>, company.domain=<aggregator>, company.name=<title>, no linkedinUrl, no verified email but pattern-guess email with confidence>0.3` scores `10 + 10 + 10 + 15 = 45`. That is the deterministic 45 the user is seeing — no prompt to change, the fix is to stop ingesting these rows in the first place, or to add a "has linkedinUrl" / "name looks human" hard gate before scoring at all.

## Fixes shipped in companion PR `fix/sourcing-agent-quality`

See PR description for the exact set of changes. Summary:
- Rewrote `team_page_extractor` system prompt with negative criteria + self-filter step, pinned temp 0
- Rewrote `icp_auto_extractor` system prompt with hard refusal protocol, pinned temp 0, tightened guard
- Expanded `SerpDiscoveryService.noiseDomains` to a curated 60+ entry aggregator blocklist
- Stopped mechanical `icp.targetIndustries[0]` / `targetGeos[0]` copy onto Company rows
- Added `isLikelyHumanName` + `isAggregatorDomain` + `isLikelyJobTitle` validators wired into the upsert path
- Added per-call `temperature` override in `LLMService`
