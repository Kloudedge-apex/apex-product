# Workforce OS design-partner onboarding

Status: operational checklist; do not onboard a customer while the exact
release candidate is `NO-GO`.

This checklist covers the guarded AI SDR release only. It does not promise
Marketing or Operations agents, automatic or bulk approval, campaign cadence,
Outlook, CRM, LinkedIn, calendar writes, billing self-service, or other deferred
capabilities excluded by `docs/ops/go-live-runbook.md`.

Store partner names, email addresses, domains, mailbox identifiers, customer
records, and message content in the approved customer/operations system, not in
Git, CI artifacts, release receipts, or shared-memory checkpoints.

## 1. Release admission

Every item is a hard prerequisite. A partial checklist is not approval to
invite the partner.

- [ ] Both exact source candidates are reviewed and merged through protected
  branches with non-self approval and passing default-branch CI.
- [ ] Exact immutable backend, worker, and console digests are recorded and
  independently verified.
- [ ] The Azure authority audit is `GO`, including the unchanged ten-day
  credential-drain checkpoint and schema-v2 controller evidence.
- [ ] The protected bootstrap has completed B0-B8 with signed receipts and a
  verified immutable rollback baseline.
- [ ] All nine migrations are applied in reviewed order with the signed
  production receipt, postconditions, old-reader drain, and writer attestation.
- [ ] Clerk configuration is identical across API, worker, and console and a
  fresh-user smoke has passed without SQL/operator provisioning.
- [ ] Production Postgres, Redis, queue consumers, recovery loops, Gmail watch
  renewal, readiness probes, alerts, and kill switches have passed.
- [ ] `api.workforceos.xyz` resolves to the reviewed API edge and the older
  `www` surface has an explicit disposition.
- [ ] A named release operator, independent reviewer, incident owner, and
  partner-success owner have accepted the launch window.
- [ ] `OUTREACH_LIVE_FOR_ORGS` is empty and the outreach worker is paused before
  the partner account is created.

Evidence must identify the exact source commits, image digests, active
revisions, CI runs, authority evidence hash, migration receipt hash, and
rollback baseline. Evidence must not contain credentials or customer data.

## 2. Partner scope and consent

Record these fields in the approved customer system before account creation:

- contracting company and primary accountable contact;
- approved guarded-SDR use case and success criterion;
- data-processing, retention, deletion, and incident-contact terms;
- one Google Workspace or Gmail sender controlled by the partner;
- one owned recipient inbox for the controlled delivery test;
- approved countries, target industries, titles, company sizes, and seed
  domains;
- physical postal address and sender identity for the unsubscribe footer;
- explicit exclusions, suppression sources, daily cap, and stop conditions.

Do not import a lead list, enable live delivery, or accept credentials through
email/chat. Use the product OAuth flow and approved customer-data channel.

## 3. Fresh-tenant onboarding

1. Invite the design partner through the ordinary Clerk signup flow. Do not
   insert or reactivate a user, membership, or organization directly in SQL.
2. Confirm the new principal has exactly one active membership in the intended
   organization and no access to any other organization.
3. In the product, complete the server-derived onboarding sequence:
   organization name and website, sender name/country/postal address, one usable
   ICP, then Gmail OAuth.
4. Complete Gmail OAuth as the authenticated admin/manager. Require an encrypted
   grant, resolved account, durable history cursor, and fresh watch. Replays,
   mismatches, expiry, or unknown state are a launch stop.
5. Read `GET /api/orgs/onboarding/status`. Require `complete: true`, but require
   `readyForLiveSend: false` while the org is not allowlisted.
6. Reload in a new authorized browser session and prove the same server state.
   In a user/member without admin/manager authority, prove settings, mailbox,
   organization, and suppression writes are denied.

## 4. Isolation and non-mock run

- [ ] Prove cross-organization reads and writes fail for settings, ICP, leads,
  runs, artifacts, conversations, meetings, follow-ups, integrations, and
  suppressions.
- [ ] Run sourcing and research with approved real providers while delivery is
  disabled. Mock-tagged or failed evidence must not become an approvable fact or
  successful KPI.
- [ ] Confirm deterministic recipient selection and exact evidence/citation
  provenance are visible to the reviewer.
- [ ] Confirm no draft exists before run approval and no provider call occurs
  before individual artifact approval.
- [ ] Reject one artifact and verify it cannot be dispatched.

Do not use a real prospect for these checks.

## 5. Owned-recipient delivery smoke

This is the only delivery allowed before partner launch sign-off.

1. Keep the daily cap at one and allowlist only the exact design-partner org.
2. Resume the outreach consumer only after the API and worker report identical
   allowlist, sender, public API origin, Gmail, and compliance configuration.
3. Create one grounded artifact to the owned recipient inbox. The partner must
   review the exact recipient, subject, plain-text body, citation, and footer.
4. Approve that single artifact. Verify one Gmail provider receipt, one Sent
   copy, exact From identity, exact text MIME, HTTPS unsubscribe footer and
   one-click headers, trace linkage, reply ingestion, and sequence stop.
5. Exercise one ordinary reply and one controlled unsubscribe/suppression case.
   Verify neither can produce an automatic duplicate or reviewed-content drift.
6. Clear the live org allowlist and pause the outreach worker immediately after
   the smoke. Reconcile any `SENDING` or `DELIVERY_UNKNOWN` artifact against
   provider truth before continuing.

Any ambiguous provider outcome ends the launch window. Never automatically
retry it or approve a replacement before operator reconciliation.

## 6. Partner launch decision

The independent reviewer may approve a bounded pilot only when all prior
evidence is complete:

- [ ] exact design-partner org is the sole live allowlist entry;
- [ ] explicit daily cap and owned sending window are recorded;
- [ ] every outbound artifact requires individual human approval;
- [ ] suppression registry and legal footer are verified;
- [ ] queue, error, provider, watch-expiry, delivery-unknown, and zero-consumer
  alerts route to the named operator;
- [ ] rollback and all three kill switches were rehearsed against the exact
  active revisions;
- [ ] partner understands the guarded-SDR scope and deferred capabilities.

Record a sanitized decision receipt with the exact release evidence hashes,
decision time, reviewer/operator identifiers, cap, and `GO`/`NO-GO`. Do not
record partner personal data or message content in the receipt.

## 7. First-week controls

- Review every draft and every provider outcome daily.
- Keep one design-partner org only; adding another org requires a new launch
  decision.
- Do not raise the daily cap until seven days of clean provider, suppression,
  watch, queue, and tenant-isolation evidence exist.
- Review sourced leads and citations with the partner; refused or uncertain
  evidence remains excluded.
- Re-run the authority audit after any identity, RBAC, federation, branch,
  environment, group-membership, or break-glass change.
- Stop delivery on any cross-org, approval, duplicate, suppression, OAuth,
  monitoring, or authority anomaly and follow `docs/ops/go-live-runbook.md`.
