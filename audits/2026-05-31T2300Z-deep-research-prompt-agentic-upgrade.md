---
date: 2026-05-31
timestamp: 2026-05-31T23:00:00Z
subject: Deep research prompt — upgrade Apex agentic sourcing pipeline to error-free best-in-class
target_audience: GPT-5 deep research agent (or equivalent strategic research analyst)
context_input: audits/2026-05-31T2300Z-sourcing-pipeline-agent-audit.md (read first)
---

# Deep research brief: redesign the Apex sourcing pipeline to be error-free, best-in-class, and competitive against Clay, Apollo, Outreach, Cognism, and 11x.ai

## Context for the researcher

Apex (the product brand of Nikxius, Inc.) is a multi-tenant B2B SaaS that deploys autonomous AI agent teams across sales, marketing, and operations domains. The flagship workload today is the AI SDR pipeline: discover companies that fit a tenant's ICP, identify decision-maker contacts, score and rank them, assemble a research brief, draft personalized outbound, and route every send through a human-in-the-loop approval queue before any external action. The stack is NestJS + Prisma/Postgres + BullMQ/Redis + LangGraph + LangSmith on Azure Container Apps, with Azure OpenAI (gpt-4o-mini as the default model) handling all LLM calls and Clerk handling auth. The pipeline is orchestrated as a LangGraph supervisor with five domain nodes, deployed via `az acr build` to `ledgracr.azurecr.io/apex-api` and serving two revisions (`apex-gtm-api`, `apex-gtm-worker`). The launch frontend is `workhorse-os`; `apex-product/apps/web` is a legacy mock and out of scope here.

The sourcing pipeline is brittle in production. The companion audit (`audits/2026-05-31T2300Z-sourcing-pipeline-agent-audit.md`) documents four recurring failure modes: SEO aggregator URLs being promoted into Company rows with blanket "B2B SaaS / UAE" firmographics; FAQ headers and section titles being promoted into Person rows with synthesized email addresses; deterministic scoring of 45 awarded to every garbage lead, defeating downstream prioritization; and ICP auto-tagging that defaults to "B2B SaaS / UAE" regardless of the real ICP. Only two LLM nodes exist in the graph today (`team_page_extractor`, `sdr_draft_message`); everything else is rule-based, and there is no critic or verifier between extraction and persistence. The audit proposes near-term hardening (blocklists, prompt rewrites, JSON-schema enforcement), but the user wants a strategic, opinionated, end-to-end redesign that maps the SOTA tooling, MCPs, agents, cognitive services, and supervisor patterns we should adopt to become best-in-class.

Urgency vs depth: Nikxius is mid pre-seed fundraise (Techstars SF primary, $200K target). Five paid pilots are live; Day-21 pilot review is 12 Jun 2026; deck v4 is locked. The redesign therefore needs to be staged so Phase 1 ships within ~10 working days (in time to demo to pilots and investors), Phase 2 ships before fundraise close, and Phase 3 lands within a quarter. Any recommendation that requires a green-field rewrite, multi-month vendor procurement, or fine-tuning workflow is out of scope; bias hard toward API-first, drop-in, and incrementally adoptable tooling.

## What we have today (one-page summary)

- **Pipeline stages (LangGraph):** `supervisor` (deterministic router by `state.counts`) → `icp_auto` (out-of-band, LLM) → `discovery` (Serper SERP + ATS/Registry/GitHub connectors) → `team_page_extractor` (LLM, JSON-LD/DOM fallback) → `scorer` (rule-based, awards a flat 45) → `assembleResearchBrief` (rule-based) → `sdr_draft_message` (LLM) → HITL queue (PENDING_REVIEW) → BullMQ outreach worker → Gmail OAuth send.
- **Default LLM:** Azure OpenAI gpt-4o-mini, temperature ~0.2 on extraction nodes, ~0.7 on draft node, wrapped via `wrapLlm` so per-call `agent`/`node` attribution flows into LangSmith.
- **Tools today:** Serper.dev (SERP), TheirStack (job-signal intent), an internal Registry connector, an ATS connector, a GitHub source. No Apollo, Hunter, ZoomInfo, Clearbit, PDL, Cognism, Diffbot, or commercial enrichment yet. No Azure Document Intelligence / Azure AI Language usage in the sourcing path.
- **DB schema (sourcing-relevant):** Postgres source of truth. `Company`, `Person`, `Lead`, `GraphRun`, `OutreachArtifact`, `WorkflowRun`, `MeetingLedger`, `EmailEvent` (append-only, DB trigger enforced), `evidence_event` (append-only). `citext` on every email column. Schema changes ship as `prisma migrate diff` SQL for human review — never `db push` or `migrate dev` in CI. GLOBAL-scope suppression is ops-only via internal CLI.
- **Evaluator stack:** Six LangSmith inline evaluators auto-fire on every traced LLM run (PII, prompt-injection, toxicity, bias, hallucination, correctness). Three Monday P0 quality evaluators (ai_tell, boilerplate, citation_coverage) shipped 2026-05-26. `RunLevelEvaluatorService` writes through cache and DB (uses `GraphRun.langsmithRootRunId`) so cross-pod resumes still post feedback. Calibration baseline post-deploy: hallucination 0.95, PII 1.0 on SDR drafts.
- **Deployment:** image rolls via `az acr build` to `ledgracr.azurecr.io/apex-api`, dual revisions `apex-gtm-api` and `apex-gtm-worker`. Allowlist gating via `OUTREACH_LIVE_FOR_ORGS`; default is dry-run; PENDING_REVIEW gates every send.
- **Hard constraints any redesign must preserve:** do not auto-send without existing allowlist gates; do not loosen `OUTREACH_LIVE_FOR_ORGS`; do not bypass `PENDING_REVIEW`; Postgres remains source of truth for billing and tenant metrics; schema changes ship as `prisma migrate diff` SQL for human review; GLOBAL-scope suppression remains ops-only via internal CLI; `EmailEvent` stays append-only (DB trigger enforced); 10-label `ReplyIntent10` exact spelling preserved; `citext` on every email column.

For depth on any of the above, read the companion audit; do not assume readers have it open.

## What broke (the audit's four root causes — restate them tightly)

- **Root cause 1 — FAQ headers as people.** `team_page_extractor` accepts any `<h2>`/`<h3>`/`<strong>` text node as a candidate name when JSON-LD + DOM regex miss. FAQ headings ("How do I get started?", "Why choose us?") get tagged Person, then a synthesized `firstname.lastname@domain` email is fabricated and written to the Person table.
- **Root cause 2 — Aggregators as companies.** `discovery` accepts the top SERP results as candidate companies without classifying whether the URL is a primary business website vs a directory/aggregator/SEO content farm. Domains like `aaconsultancy.ae`, `gccdomestic.com`, `parkingcrew.net` become Company rows.
- **Root cause 3 — Blanket B2B SaaS / UAE tagging.** `icp_auto` defaults to "B2B SaaS / UAE" when the tenant's ICP signal is weak or the LLM call times out. Every aggregated company in that run inherits that firmographic, defeating downstream filtering.
- **Root cause 4 — Deterministic 45 scoring on garbage.** `scorer` awards a flat 45 to every Person/Lead regardless of provenance, so prioritization is meaningless and the HITL queue is flooded with low-signal artifacts.

## The questions we need answered

Number these and group into 7 sections. Each numbered question is specific and answerable. Deliver an opinionated recommendation on each, not just a survey.

### Section 1: Sourcing — entity extraction & disambiguation

1. Given a URL or a Google search result, what is the state of the art for classifying "is this a primary business website" vs "is this a directory/aggregator/listing page"? Compare hand-curated blocklists vs LLM page classifier vs commercial signal services (Diffbot Knowledge Graph, Clearbit/HG Insights firmographic API, ZoomInfo Enrich, People Data Labs Company API, Apollo.io Organization Search, Cognism, Lusha B2B Data API). For each, give: cost per 1k lookups, API latency, multi-tenant licensing terms, accuracy claims, gotchas, fit for Apex's stack.
2. For team-page scraping (when JSON-LD and DOM regex miss), what beats a bare LLM prompt? Compare: Diffbot Article/People API, AWS Comprehend custom entity recognition, Azure AI Language NER (`PersonType` entity), Google Cloud Natural Language, vendor APIs (FullEnrich, Surfe, BetterContact), and the SOTA open-source models (e.g. GLiNER, BERT-based NER fine-tuned on PERSON spans). Recommend a primary + a fallback.
3. When SERP results have ambiguous titles like "Saudi Arabia – Service directory" or "Professional Services UAE", how should the system disambiguate "is this a person, a company, a page, or a region"? Survey approaches: lightweight LLM classifier (gpt-4o-mini), Azure AI Language entity linking with confidence scores, search-grounded reranker (Cohere Rerank v3, Voyage, Mixedbread), commercial entity-resolution services. Recommend.
4. **OCR/document intelligence:** when we eventually pull annual reports, decks, slides, or scanned PDFs for company enrichment, what's the right Azure cognitive stack? Compare Azure AI Document Intelligence (formerly Form Recognizer) prebuilt + custom models, Azure Vision OCR, Azure AI Content Understanding, AWS Textract, Google Document AI. Specifically: tables, hand-written, multi-column, multi-language (Arabic/Hebrew/CJK), scanned-image quality, and PII redaction. We're an MS-stack shop (Azure OpenAI, Container Apps, ACR) — favour Azure but report tradeoffs honestly.

### Section 2: Verification, validation, deliverability

5. For email verification: rank Hunter, ZeroBounce, NeverBounce, EmailListVerify, Million Verifier, Kickbox, Bouncify, Mailgun Validate. For each: catch-all handling, soft-bounce rate, GDPR posture, API latency, free-tier limits, batch vs realtime, cost at 10k/day. Recommend a primary + a tiebreaker.
6. For domain verification (is `gccdomestic.com` a real business, is `parkingcrew.net` a parked domain, is `aaconsultancy.ae` a real consultancy or an SEO content farm): survey domain-intelligence APIs (SecurityTrails, WhoisXML, IPinfo, DomainTools, DNSDB) and SSL/DNS posture checks. Recommend a budget-tier stack.
7. For deliverability monitoring (replacing or augmenting our current internal `Deliverability` table): GlockApps, MailMonitor, MXToolbox API, Postmark Spam Check, Mail-Tester, Talos Intelligence. For warming + reputation: Mailwarm, Lemwarm, Warmbox, Smartlead's built-in warmup. Recommend.

### Section 3: Agent architecture — supervisor patterns, agent specialization

8. Our current LangGraph supervisor (`supervisor` node in `pipeline-graph.ts`) is purely deterministic — it routes by `state.counts` thresholds, no LLM. Should it become an LLM-supervised "orchestrator" that decides which sub-graph to run based on signal strength? Survey: AutoGen GroupChatManager, CrewAI Manager Agent, LangGraph "supervisor with handoffs" pattern, Microsoft Semantic Kernel Planner, OpenAI Swarm. Give pros/cons and an opinion: should Apex's supervisor stay deterministic with LLM critics on each leaf node, or become LLM-led?
9. **Critic / verifier agents.** The audit shows our current pipeline has no critic step between sourcing and persisting. Should we add: (a) a "lead quality critic" that vets every Person row before insert, (b) a "company classifier critic" that vets every Company row, (c) a "brief grounding critic" that runs after `assembleResearchBrief`? Cite research (Constitutional AI, self-refine, LLM-as-judge with calibration, Reflexion). What's the recommended pattern for Apex specifically — a single shared judge with role swaps, or domain-specific judges?
10. **Agent roles we may be missing.** Given a target sales motion (cold outbound B2B), what's the complete cast of agents top-tier systems have? (e.g. Researcher, Validator, Scorer, Personalizer, Sequencer, Reply Classifier, Meeting Booker, Objection Handler, Deliverability Monitor, Compliance Officer.) Map each to: what task, what input, what LLM, what tools, what failure mode. Recommend which to add to Apex first.
11. **Failover patterns.** Today a single LLM call decides whether a name is a person. What's the recommended pattern for high-reliability extraction: cascade (rule → small LLM → large LLM), ensemble (3 LLMs vote), self-consistency (sample N, majority vote), retrieval-augmented verification (look up the name in a known-entity store first)? Recommend specifics for sourcing.

### Section 4: Tools, MCPs, connectors

12. Survey the public MCP (Model Context Protocol) ecosystem for B2B sales tooling as of mid-2026. Specifically check for: Apollo MCP, Hunter MCP, Clearbit MCP, ZoomInfo MCP, LinkedIn MCP (anything beyond Sales Navigator scraping), Salesforce MCP, HubSpot MCP, Pipedrive MCP, Outreach MCP, Salesloft MCP, Gong MCP, Chorus MCP, Avoma MCP, Calendly MCP, Cal.com MCP. For each: maintained by vendor or community, auth model, rate limits, fit for Apex.
13. For SERP, beyond Serper.dev (current): compare Bright Data, Oxylabs SERP API, ScaleSERP, ZenSERP, SerpAPI, DataForSEO, Apify. Score on cost per 1k, latency, geo support (especially MENA — Apex's first market), structured-data quality.
14. For company-firmographic enrichment (replacing the current "icp_auto + blanket tag" pattern): Diffbot Knowledge Graph, Clearbit Reveal, FullContact, People Data Labs, Apollo.io Bulk Enrich, ZoomInfo Engage API. For each: data freshness, coverage in MENA/APAC, schema fidelity (industry taxonomy granularity), price.
15. For intent signals (currently TheirStack only): Bombora Company Surge, G2 Buyer Intent, 6sense Revenue AI, Demandbase Account Intelligence, Cognism Intent. Recommend a primary intent stack.

### Section 5: Evaluation, observability, ground truth

16. Beyond LangSmith inline evaluators, what's the SOTA for "did the system extract the right person from this page" evaluation? Survey: Phoenix (Arize), Braintrust, Patronus AI, Galileo, TruEra, OpenAI Evals. For each: how to ingest production traces, how to build golden datasets, calibration features, multi-tenant isolation.
17. We need a "golden set" of labeled sourcing examples to test against. What's the right size, sampling strategy, and tooling? Compare hand-labeled (Labelbox, Scale AI, Surge AI, Snorkel Flow) vs synthetic generation vs adversarial mining from production failures.
18. For run-level scoring (replacing or augmenting `RunLevelEvaluatorService`): what's the SOTA pattern for grading a multi-step agentic run end-to-end? Cite: AgentBench, AgentBoard, TauBench, SWE-bench-style golden tasks.

### Section 6: Compliance, privacy, regional

19. Apex's first market is MENA (UAE, Saudi). For PDPL/GDPR/CCPA: what's the right consent + retention + erasure architecture for scraped personal data? Survey: OneTrust, TrustArc, Osano, Termly, Securiti.ai, Transcend. Recommend.
20. For multi-tenant data-moat: today every tenant's discovered leads land in shared tables with `orgId` scoping. What's the SOTA for "cross-tenant signal sharing without leaking data" — federated learning, differential-privacy aggregates, secure multi-party computation, or just k-anonymous aggregate tables? Recommend.
21. For deliverability compliance (CAN-SPAM, CASL, GDPR opt-in, UAE Data Protection Law): what mandatory headers, footer text, sender identity, and consent records do we need to bake into every outbound email? Survey the latest 2026 enforcement actions.

### Section 7: Strategic recommendation

22. Given the audit + answers above, draft a 90-day phased upgrade plan for the Apex sourcing pipeline. Phase 1 (Week 1-2): emergency hardening. Phase 2 (Week 3-6): replace brittle agents with verified tools. Phase 3 (Week 7-12): introduce critic/verifier agents and supervisor intelligence. For each phase: deliverables, dependencies, cost, headcount, risk.
23. Estimate annual run-rate cost at 1M lookups/month, 10k outbound/day, 5 paid pilots → 50 paid pilots: what's the all-in COGS of the recommended stack vs the current Serper-only stack? Where does Apex lose margin?
24. If we had to pick **the single most impactful change** to ship next week, what is it? (Yes, the audit already proposes prompt rewrites + blocklists — assume those are shipped. What's the NEXT highest leverage move?)

## Deliverable format we want back

Return a structured Markdown report with one section per numbered question, an opinionated primary recommendation (not just a survey) plus a runner-up and a deliberate non-recommendation per question, cost numbers where applicable in USD with assumed volumes, links to vendor docs and pricing pages, and a one-page executive summary at the top that lists the top five changes by leverage with rough cost and effort. Where you disagree with the audit's proposed fixes, say so explicitly and show why.

## Out of scope for this research

- Agent training or model fine-tuning — we are API-only and will stay so for the next two quarters.
- Full migration off Azure (Container Apps, ACR, Azure OpenAI) — we are committed to the MS stack.
- UI/UX changes — the frontend (`workhorse-os`) is a separate workstream and not in scope here.
- Changes to billing or Razorpay flow — Postgres remains the source of truth for billing and tenant metrics, untouched.
- Anything that loosens `OUTREACH_LIVE_FOR_ORGS`, bypasses `PENDING_REVIEW`, or relaxes the GLOBAL-scope suppression CLI-only rule.

## Reference materials the researcher should pull

- `audits/2026-05-31T2300Z-sourcing-pipeline-agent-audit.md` (the audit this prompt is based on)
- Apex's deep research report v5 (2026-05-28 GPT report on canonical telemetry schema and 90-day roadmap)
- LangSmith evaluator stack (six evaluators currently auto-firing: PII, prompt-injection, toxicity, bias, hallucination, correctness; plus Monday P0 set: ai_tell, boilerplate, citation_coverage)
- Memory file `langgraph-orchestration.md` for current supervisor + 5-node design

## Tone and rigor

Match a top-tier strategy consultant or principal engineer at a Series-B B2B SaaS. Cite docs and primary sources. Disagree with the audit where you have stronger evidence. Avoid vendor cheerleading; assume the user will procurement-test every recommendation. Be specific about MENA-specific gotchas — most B2B tooling is US/EU-first.
