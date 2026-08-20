# Workforce OS sellable-production matrix

Date: 2026-08-19 (Asia/Kolkata)

Product boundary: one guarded AI SDR workflow. A customer signs up, completes
setup, connects Gmail, sources and enriches leads, reviews grounded evidence,
approves a run and individual email, sends through policy gates, receives
replies, and operates the workspace without manual database intervention.

This matrix separates source completeness from live proof. A source pass is not
permission to call the public service production-ready.

## Current release decision

**NO-GO for production cutover today.** The current public Azure runtime is an
older compatibility release. The candidate source is substantially complete,
but the protected authority drain cannot mature before
`2026-08-26T18:49:06Z`, Google restricted-scope verification is external and
unfinished, and the exact candidate still needs governed migration, deployment,
and authenticated end-to-end proof.

Status meanings:

- **SOURCE PASS**: implemented and covered by current automated verification.
- **CUTOVER REQUIRED**: the public Azure runtime does not yet run the candidate.
- **LIVE PROOF REQUIRED**: behavior must be exercised against the exact deployed
  image and real providers.
- **EXTERNAL GATE**: completion depends on a provider or authority outside the
  application repository.

## Customer-loop matrix

| Customer outcome | Candidate evidence | Remaining evidence before sale |
| --- | --- | --- |
| Sign up and receive one isolated workspace | **SOURCE PASS.** Clerk JWT validation, immutable identity binding, tenant-scoped guards, idempotent trial provisioning, and cross-org denial are implemented. | **CUTOVER REQUIRED / LIVE PROOF REQUIRED.** Normalize the live Clerk tuple, onboard a fresh user without operator intervention, then execute the full cross-org read/write matrix. |
| Complete setup and see truthful readiness | **SOURCE PASS.** Organization, sender identity, country, physical address, ICP, mailbox, capacity, and allowlist are persisted and fail closed. Settings now uses a tenant-scoped server health projection instead of a hard-coded unavailable response. | **CUTOVER REQUIRED / LIVE PROOF REQUIRED.** Save and reload every field on a fresh production tenant and verify role-denied controls remain read-only. |
| Connect Gmail and maintain reply sync | **SOURCE PASS.** OAuth attempts are actor/org-bound and one-time; authenticated finalization, encrypted credentials, mailbox identity, history cursor, watch freshness, renewal, and reconnect failure states are implemented. | **EXTERNAL GATE.** Complete Google's restricted Gmail-scope verification. **LIVE PROOF REQUIRED.** Connect a fresh authorized mailbox and prove watch renewal, revocation, and reconnect. |
| Generate and enrich real leads | **SOURCE PASS.** `POST /pipeline/run` is the single mounted pipeline trigger. The deprecated `/leads/discover` route, detached legacy executor, dormant scheduler, and schedule-mutation route are absent; auto-generated ICPs no longer claim scheduled execution. Serper/Tavily discovery, bounded scraping, structured extraction, deduplication, scoring, and source provenance exist. Tenant ICP exclusion domains are normalized, persisted, and enforced before company persistence or follow-on ATS probing, including subdomains without suffix-lookalike matches. Team-page extraction uses the configured LLM provider, including Azure OpenAI. Web search, page scraping, company research, HubSpot, and LinkedIn now fail explicitly when live providers or tenant credentials are unavailable; they never substitute fixture facts or success receipts. Partial company profiles require at least one attributable live source and retain source URLs. Production startup requires a live search provider and a complete OpenAI-compatible model configuration. | **CUTOVER REQUIRED / LIVE PROOF REQUIRED.** Complete a live-provider run with the exact production environment and retain source, selection, exclusion, partial-provider-failure, and refusal evidence. |
| Review research, score rationale, and evidence | **SOURCE PASS.** Lead research briefs, score breakdowns, intent signals, and recent evidence are derived only when attributable data exists; missing facts remain unavailable rather than fabricated. Extracted signals count only after the evidence ledger confirms a durable create or an idempotent existing row. Production startup and release verification require `EVIDENCE_LEDGER_ENABLED=true`; if every extracted signal misses persistence, research fails before the approval prompt instead of claiming success. | **LIVE PROOF REQUIRED.** Verify representative leads contain attributable citations and that evidence-poor leads refuse unsupported personalization. Exercise a deliberate ledger-write failure and confirm the run fails before approval. |
| Approve or reject a run before drafting | **SOURCE PASS.** Tenant-scoped compare-and-set decisions, server-derived reviewer identity, explicit capability checks, and duplicate/stale conflict handling are implemented. | **LIVE PROOF REQUIRED.** Exercise authorized and unauthorized sessions against the migrated runtime. |
| Review the exact recipient and email before send | **SOURCE PASS.** Individual artifact approval revalidates recipient, subject, plain-text body, provenance, grounding, and QA at resume, approval, and dispatch. Bulk approval is hidden. | **LIVE PROOF REQUIRED.** Prove browser-visible content is byte-for-byte the provider-bound content sent by the worker. |
| Send exactly once through policy gates | **SOURCE PASS.** Gmail readiness, workspace allowlist, sender/address/country, suppression, cooldown, daily cap, reservation, unsubscribe, and ambiguity quarantine are enforced. Missing credentials now fail explicitly; simulation requires an explicit guarded worker context. | **LIVE PROOF REQUIRED.** Exercise concurrent consumers, replay, pre-provider crash, response-loss ambiguity, and one controlled owned-inbox send. |
| Ingest replies and stop further outreach | **SOURCE PASS.** Gmail history replay, duplicate Pub/Sub handling, conversation persistence, one-reply-per-inbound fencing, suppression, and follow-up state exist. Archiving is a serialized delivery stop: it suppresses draft, reviewable, and approved replies under the same org/thread locks as creation and dispatch; it refuses to hide an in-flight or delivery-unknown reply; and archived threads reject new reply artifacts until restored. Pipeline list and detail stages are derived consistently from tenant-scoped persisted sends, linked conversations, inbound replies, and non-cancelled meetings; a reply promotes the lead to `replied`, a cancelled meeting cannot falsely retain `meeting`, and the most recent outbound timestamp is exposed as last contact rather than remaining blank. | **LIVE PROOF REQUIRED.** Reply from the owned inbox, verify ingestion, Pipeline promotion, detail-stage and last-contact continuity, and sequence stop, then exercise cancellation fallback, duplicate delivery, stale-draft, archive-versus-approval, and archive-versus-dispatch races. |
| Navigate and operate every visible surface | **SOURCE PASS.** Today, Pipeline, Outbound, Runs, Conversations, and the five supported Settings tabs are wired to authenticated routes. Conversation archive is reversible: the inbox exposes archived threads and tenant-scoped, idempotent restore on desktop and mobile instead of stranding them outside every visible list. Conversation meetings expose the complete internal-ledger lifecycle: proposed and confirmed entries can be edited or cancelled, proposed entries can be confirmed, and confirmed entries can be marked completed or no-show. Status transitions are tenant-scoped, compare-and-set, and retry-safe; the UI states truthfully that these actions do not send invitations or mutate external calendars. Unsupported Settings tabs and non-Gmail integrations are hidden; a regression test prevents Outlook and HubSpot cards from leaking into the release UI. The mounted integration surface exposes and provides only Gmail list/catalog, OAuth initiation/callback/finalization, exact Gmail disconnect, authenticated reply-watch maintenance, Pub/Sub reply ingestion, and provider reads; deferred LinkedIn and HubSpot service transports are not mounted. The disabled direct-Gmail-send compatibility route is absent so every live send must pass artifact approval and the outreach worker. The mounted graph can persist only email review artifacts, approval rejects every non-email channel, and the worker rejects legacy approved non-email rows before reservation, credential access, or provider invocation. Unsupported provider and generic create/connect/test routes are absent. The API no longer mounts the legacy `/inbox`, `/accounts`, `/campaigns`, `/playbooks`, or `/deliverability` 501 stubs. Deferred Agent, AgentRun, Runtime, Workflow, and billing controllers are unmounted; their modules are absent from `AppModule`; and the generic AgentRun executor, queue worker, scheduler, and memory runtime are absent from `RuntimeModule` providers. Razorpay configuration is rejected by production release verification until a complete customer billing contract is admitted. The dashboard publishes measured stats and activity reads only; its former KPI-selection mutation, which returned success without persisting anything, is absent. KPI aggregation contains only measured operational, quality, commercial, and review-decision metrics; the placeholder experimentation endpoint and its always-empty variant payload are absent. | **CUTOVER REQUIRED.** Browser-smoke every visible link and action on desktop and mobile against the exact deployed console/BFF/API tuple, including each meeting transition and a rejected stale action. |
| Detect failures and recover safely | **SOURCE PASS.** Health/readiness probes, queue metrics, recovery loops, delivery-unknown quarantine, graceful worker drain, and protected bootstrap writer fencing exist. The HTTP fence's reviewed GET/HEAD contract is derived from the controller graph actually reachable from `AppModule`; retired Agent, AgentRun, Workflow, LinkedIn, HubSpot, and legacy compatibility routes have no policy allowlist entries, while unknown future routes remain fail-closed as writers. Worker health now covers only the supported graph-run and approved-outreach queues. Gmail watch renewal has its own exact role gate and cannot activate the retired generic AgentRun consumer. | **LIVE PROOF REQUIRED.** Verify alerts, both supported queue consumers, watch renewal, rollback, restore, kill switches, and named operator ownership in production. |

Dashboard stats and Today KPI contracts contain only measured fields; former always-null reply-rate and calendar-day lead placeholders are absent. Rolling outreach-quality windows use each outcome's persisted lifecycle timestamp: draft creation for new review items, reviewer decision time for approvals and rejections, failure time for dispatch failures, and provider-confirmed send time for sends. A later unrelated row update therefore cannot make an old outcome appear recent.

## Mandatory gates

The release is sellable only when all of these are recorded for one exact source
commit and immutable image digest:

1. Protected release-authority drain reaches its full ten days with a fresh
   unchanged `GO` audit. Earliest possible maturity is
   `2026-08-26T18:49:06Z`.
2. Google approves the OAuth consent screen for the restricted Gmail scopes
   required by send and reply sync.
3. Default branches contain the approved candidate, exact-branch CI is green,
   and immutable API, worker, BFF, and console images are built from those
   commits.
4. Required production migrations are rehearsed on a production-shaped snapshot,
   backed up, applied in order, and verified before writers reopen.
5. The exact images pass fresh-user onboarding, cross-tenant denial, non-mock
   sourcing, approval, one controlled Gmail send, reply ingestion, suppression,
   recovery, observability, and rollback tests.
6. Unsupported capabilities remain hidden and marketing is limited to the
   guarded SDR workflow in this document.

Until every gate passes, the accurate state is **verified source candidate,
production cutover pending**.
