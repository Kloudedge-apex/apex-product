# Go-Live Runbook — Live Sending Week

Operator runbook for the first week of real outbound email (GO-LIVE GL9/GL10).
Everything here is grounded in the guarded-SDR candidate on
`release/go-live-2026-06-01`; the exact local candidate commit is recorded in
the workspace verification file. File references are given so behavior can be
verified before acting.

**Infra constants (do not improvise):**

| Thing | Value |
|---|---|
| Resource group | `Ledgr-prod` |
| API Container App | `apex-gtm-api` |
| Worker Container App | `apex-gtm-worker` |
| ACR / repo | `ledgracr` / `apex-api` |
| BullMQ queues | `graph-runs` (pipeline runs), `outreach-send` (post-approval delivery) |
| Tenant-zero org id | `cmpe63k370000ap01vsiehbj2` |
| Allowlisted send orgs | `OUTREACH_LIVE_FOR_ORGS` env on `apex-gtm-worker` (currently tenant-zero only) |
| Prod DB access | `ledgracr`/pgclient ACI workflow (see memory: prod-schema-snapshot-workflow). All writes go through the DB-safety workflow: dry-run + diff + explicit approval. |

Resolve the API ingress FQDN whenever a command below needs it:

```bash
API_FQDN=$(az containerapp show -n apex-gtm-api -g Ledgr-prod \
  --query properties.configuration.ingress.fqdn -o tsv)
```

### Authentication claim contract

Before an API or console-BFF revision receives traffic, verify its non-secret
Clerk claim configuration is present and consistent:

- `CLERK_ISSUER` is the exact trusted Clerk issuer origin. If omitted, the
  verifier derives it from `CLERK_DOMAIN`, the publishable-key domain, or the
  origin of `CLERK_JWKS_URL`.
- `CLERK_AUTHORIZED_PARTIES` is required in production on both the API and BFF.
  It is a comma-separated list of exact browser origins accepted in the JWT
  `azp` claim. Do not use wildcards, paths, or preview-domain patterns.
- `CLERK_AUDIENCE` is optional. Configure it only after confirming that the
  current Clerk session token carries that audience; setting an invented value
  intentionally rejects every session.
- `DEV_TRUST_X_ORG_ID` must remain false on the BFF. The code also ignores it
  whenever `NODE_ENV=production`. `ALLOW_DEV_ORG_HEADER` remains non-production
  only on the API.

The verifiers require RS256, an exact JWKS `kid`, nonempty `sub`, `exp`, `iat`,
the trusted issuer, an active `nbf` when present, and an authorized `azp` in
production. A revision that cannot validate those claims rejects the request;
it must not fall back to client-supplied tenant headers.

---

## (0) RELEASE ADMISSION AND SCHEMA ORDER

The current guarded-SDR candidate is a production **NO-GO** until all six
review-only SQL files are rehearsed and then applied with separate operator
approval. Codex did not apply them. Use the invocation, writer-pause,
duplicate-inventory, retry, and postcondition instructions inside each file.

After the authorized production apply, create a sanitized receipt conforming to
`docs/ops/production-migration-receipt.schema.json`. Store it outside the Git
working tree and include only hashes, operator/approver identifiers, the change
ticket, booleans, and the exact candidate commit. Do not include connection
strings, SQL output, row values, customer identifiers, or message content.
The `approver` must be a principal in a separately controlled OpenSSH
allowed-signers file, also kept outside the repository. After reviewing the
final receipt bytes, that approver signs them with the fixed namespace:

```bash
ssh-keygen -Y sign \
  -f <approver-private-key> \
  -n workforce-os-migration-receipt \
  <outside-repo-receipt.json>
```

Keep the resulting `.sig` beside the receipt; never copy the private key into
the repository or release evidence. The exact SHA-256 of the independently
controlled allowed-signers file must be committed in
`docs/ops/production-migration-allowed-signers.sha256` through a reviewed source
change. Its initial `UNCONFIGURED` value deliberately blocks production; do not
replace it until the principal-to-key mappings have been provisioned and
reviewed outside the deploy operator's control. Rotation changes both the
external file and this source-pinned digest.

`scripts/verify-migration-release-receipt.sh` rejects undeclared fields, copies
the supplied trust file once, matches those exact bytes to the reviewed digest,
and verifies the detached signature against the claimed approver. The reviewed
digest and all six migration bytes are read from the exact candidate commit
with replacement objects disabled, never from mutable working-tree files. The
verifier enforces their order and writer-pause requirements. The receipt,
signature, and pinned allowed-signers trust root are mandatory inputs to
`scripts/deploy-prod.sh`. The protected controller is deliberately
noninteractive and requires the explicit `--yes` acknowledgement; it never
reads a confirmation from stdin. The future admitted release environment must
execute `scripts/deploy-prod.sh` directly (not through `bash`) so its privileged
bootstrap shebang applies, using:

```bash
scripts/deploy-prod.sh \
  --migration-receipt <outside-repo-receipt.json> \
  --migration-signature <outside-repo-receipt.json.sig> \
  --migration-allowed-signers <outside-repo-allowed-signers> \
  --yes
```

The only admitted image rollout path is `scripts/deploy-prod.sh` from a
published `release/go-live-*` branch. Mutable worktree files are neither
executed nor uploaded, and admission deliberately avoids `git status` because
repository-local fsmonitor configuration can execute code. It must resolve the
full-SHA ACR tag once,
pull `ledgracr.azurecr.io/apex-api@sha256:...` as Linux/amd64, and pass
`scripts/verify-registry-api-image.sh` before either Container App changes.
The checked-out script is only a bootstrap: it creates a mode-0700 `git
archive` of the exact candidate commit, then runs the controller, every release
helper, and the ACR build context from that private snapshot. The bootstrap
starts in privileged Bash mode so shell startup files and exported functions
cannot run before its scrub boundary. Its parent owns the child process group,
snapshot, and separate runtime-state directory, waits for the group leader,
terminates any surviving descendant, and removes those exact `mktemp` paths.
Mutable or ignored files in the original checkout are never executed or
uploaded.
Never deploy `latest`, a timestamp tag, or a digest that lacks an exact
40-character matching OCI revision label. Retain the verified digest and script
receipt with the release evidence.

The script atomically acquires the GitHub ref lease
`refs/heads/workforce-os-release-lock/production-gtm-platform` before reading
production state. Each attempt creates a unique commit with the candidate tree
and source commit as its parent. Acquisition uses Git `--force-with-lease` with
an empty expected ref; cleanup uses `--force-with-lease` with that unique commit
as the expected value. Both operations are server-side compare-and-swap, so a
cleanup cannot delete a successor attempt's lease. Lease fetches and pushes run
from a private bare repository with an empty hook template, ignored
system/global Git configuration, prompts disabled, the explicit canonical
GitHub URL, and the `gh` credential helper. Mutable checkout remotes and hooks
are outside the lease boundary. Caller-supplied Git configuration, attribute
sources (including `GIT_ATTR_SOURCE`), object stores, namespaces, and transport
overrides are scrubbed; HTTPS uses direct system trust with certificate
verification forced on, and Git tracing is disabled with redaction forced for
defense in depth around the credential helper. Snapshot bootstrap attributes
come only from the exact candidate tree. Do not make direct Container App
changes while the lease exists. If a process dies before cleanup, inspect
the unique lease commit, operator session, and Azure state before separately
authorizing stale-lease removal; never delete it merely because another rollout
is waiting. A rollout whose final conditional lease deletion fails exits
nonzero even if both applications are healthy, because the release is not
operationally complete while its lease remains.
Once the first Container App mutation is attempted, every failed rollout keeps
the lease, including one whose compensating rollback verifies healthy. This
prevents a second rollout while a delayed platform operation may still surface.
Treat that retained ref as an incident marker, not as disposable lock
contention; investigate and separately authorize its removal.

Azure Container Apps stable REST specifications from `2022-03-01` through
`2026-01-01` do not expose a resource ETag or an `If-Match` parameter for the
update operation. The image update is therefore not described as optimistic
CAS. It is fail-closed unless
`ACA_EXCLUSIVE_MUTATION_AUTHORITY_CONFIRMED=true`; set that variable only after
an RBAC audit proves the protected CI OIDC principal is the exclusive identity
with `Microsoft.App/containerApps/write` on both production apps and confirms
interactive users cannot write them. The Git lease serializes attempts by that
principal, and the controller re-reads both apps immediately before the first
write, immediately before each later or compensating write, and after every
write. No protected deploy workflow/environment currently exists, and the
private-repository branch-protection API needed to establish that admission
boundary is plan-blocked. Therefore the attestation must remain unset and the
current release remains NO-GO until those controls exist and the exclusive-RBAC
audit is recorded. Re-audit after any role-assignment, group-membership,
federation, or break-glass change.

`scripts/verify-containerapp-release-config.sh` requires
`REQUIRE_PRODUCTION_ENV=true` on both roles, enforces the intentional worker-gate
differences, compares the shared authentication, provider, compliance, health,
and observability values, and rejects `OUTREACH_LIVE_FOR_ORGS="*"` and
`OUTREACH_ALLOW_WILDCARD=true`. Sensitive variables must use `secretRef`.
`METRICS_AUTH_TOKEN` is required on both roles and must use the same non-empty
secret reference; production startup also rejects a missing or blank value.
The verifier can compare secret-reference names but cannot compare redacted
app-local secret values. Before rollout, the approved configuration evidence
must establish that every shared API/worker reference resolves to the same
approved source or rotation; never retrieve or print a secret merely to compare
it.

Required dependency order:

1. `docs/migrations/2026-06-01_outreach-artifact-unique.sql`
2. `docs/migrations/2026-08-12_conversation-store-expand.sql`
3. `docs/migrations/2026-08-12_outreach-delivery-unknown-expand.sql`
4. `docs/migrations/2026-08-12_conversation-reply-single-flight-expand.sql`
5. `docs/migrations/2026-08-12_graph-run-activity-expand.sql`
6. `docs/migrations/2026-08-12_graph-run-lifecycle-expand.sql`

Do not deploy code that writes a new column, table, or enum value before its
schema prerequisite. The artifact, reply-single-flight, and graph-lifecycle
index operations require the documented writer pauses. The concurrent index
files must not run inside a transaction-wrapping migration runner.

Stop on any duplicate preflight. Never auto-delete or rewrite a `SENT` or
`DELIVERY_UNKNOWN` row. Reconcile reply duplicates against Gmail provider
truth and active GraphRun duplicates against checkpoints/evidence. A legacy
active run with neither a checkpoint nor persisted start seed requires manual
resolution; an empty backfilled seed is not evidence that it can be replayed.

After schema apply, verify the exact candidate image against the production
gates in the workspace `docs/PRODUCT_COMPLETION_CONTRACT.md` before adding any
organization to `OUTREACH_LIVE_FOR_ORGS`.

### Public unsubscribe-origin preflight

`API_PUBLIC_URL` is a production boot requirement on both the API and worker.
Set it to the externally reachable HTTPS API origin (for example,
`https://${API_FQDN}`; an optional trailing `/api` is normalized). Do not use an
internal hostname, localhost, credentials, query parameters, or fragments. The
worker stamps this origin into the visible footer and the RFC 8058
`List-Unsubscribe` header, so a bad value is a send-safety failure, not a
cosmetic configuration issue.

Before enabling a live organization, confirm both apps carry the same value:

```bash
az containerapp show -n apex-gtm-api -g Ledgr-prod \
  --query "properties.template.containers[0].env[?name=='API_PUBLIC_URL'].value | [0]" -o tsv
az containerapp show -n apex-gtm-worker -g Ledgr-prod \
  --query "properties.template.containers[0].env[?name=='API_PUBLIC_URL'].value | [0]" -o tsv
```

Then verify `https://${API_FQDN}/api/health/ready` and perform the owned-recipient
smoke below. A missing or invalid production value must make the revision fail
startup; never bypass that guard with `BASE_URL`.

The image liveness check targets `/api/health/live`. Configure the API revision's
readiness probe to `/api/health/ready` and the worker revision's readiness probe
to `/api/health/worker`; both dependency probes are bounded by
`HEALTH_CHECK_TIMEOUT_MS` (default 2000 ms). Keep `SCHEDULER_ENABLED=false` on
both guarded-SDR revisions because cadence scheduling is deferred.

---

## (a) KILL SWITCHES

Three switches, in escalation order. Pick by intent:

| You want | Use | Reversible without data loss? |
|---|---|---|
| Pause sending; resume later, nothing lost | KS-2 (`OUTREACH_WORKER_ENABLED=false`) | Yes — APPROVED rows + jobs queue up untouched |
| Guarantee no real email leaves, even if worker misconfig/compromise | KS-1 (clear `OUTREACH_LIVE_FOR_ORGS`) | No — approvals processed during the freeze terminate as `SIMULATED` and never auto-resend |
| Worker is misbehaving beyond env flips (crash-loop, runaway behavior) | KS-3 (stop the app) | Yes — BullMQ redelivers; reconcile sweep recovers strays on restart |

Every `az containerapp update`/`stop` rolls a new revision/restarts replicas;
in-flight jobs are interrupted, BullMQ marks them stalled and redelivers, and
artifacts caught mid-send in `SENDING` are quarantined as
`DELIVERY_UNKNOWN` by the reconcile sweep (see triage #5). They are never
automatically dispatched again.

### KS-1 — Clear `OUTREACH_LIVE_FOR_ORGS` (fail-closed → everything SIMULATED)

Code: `apps/api/src/outreach/outreach-allowlist.util.ts` —
`isLiveSendAllowedForOrg()` returns `false` for every org when the var is
unset/empty. The worker keeps consuming, but loads an **empty** integrations
map, so `SendEmailTool`/`LinkedInSendMessageTool` take their mock branch and
the artifact terminates as `SIMULATED` (mock receipt kept, `sentAt` stays
NULL, dashboards never count it as delivered).

**1. Capture and compare both current values first** (you need the exact
verbatim value to recover):

```bash
CURRENT_API_ALLOWLIST="$(az containerapp show -n apex-gtm-api -g Ledgr-prod \
  --query "properties.template.containers[0].env[?name=='OUTREACH_LIVE_FOR_ORGS'].value | [0]" -o tsv)"
CURRENT_WORKER_ALLOWLIST="$(az containerapp show -n apex-gtm-worker -g Ledgr-prod \
  --query "properties.template.containers[0].env[?name=='OUTREACH_LIVE_FOR_ORGS'].value | [0]" -o tsv)"
test "$CURRENT_API_ALLOWLIST" = "$CURRENT_WORKER_ALLOWLIST"
test -n "$CURRENT_API_ALLOWLIST"
```

Stop if parity fails. Do not guess which value is authoritative.

**2. Clear on BOTH apps** (the worker evaluates it on the send path; the api
evaluates it for honesty/display — keep them in sync):

```bash
az containerapp update -n apex-gtm-worker -g Ledgr-prod --remove-env-vars OUTREACH_LIVE_FOR_ORGS
az containerapp update -n apex-gtm-api    -g Ledgr-prod --remove-env-vars OUTREACH_LIVE_FOR_ORGS
```

**Expected effect:**
- Worker log per artifact: `Org <orgId> not in OUTREACH_LIVE_FOR_ORGS — forcing mock send for artifact <id>`.
- Every APPROVED artifact processed while cleared goes terminal `SIMULATED`. No external call is made.
- This is a one-way valve for queued approvals: `SIMULATED` is terminal, the
  worker's idempotency guard skips non-APPROVED rows, and the approve endpoint
  only accepts `PENDING_REVIEW` — so those sends are burned, not paused. If
  you need pause semantics, use KS-2 instead (or in addition, FIRST).

**Recovery:**

```bash
az containerapp update -n apex-gtm-api -g Ledgr-prod \
  --set-env-vars "OUTREACH_LIVE_FOR_ORGS=$CURRENT_API_ALLOWLIST"
az containerapp update -n apex-gtm-worker -g Ledgr-prod \
  --set-env-vars "OUTREACH_LIVE_FOR_ORGS=$CURRENT_WORKER_ALLOWLIST"

RESTORED_API_ALLOWLIST="$(az containerapp show -n apex-gtm-api -g Ledgr-prod \
  --query "properties.template.containers[0].env[?name=='OUTREACH_LIVE_FOR_ORGS'].value | [0]" -o tsv)"
RESTORED_WORKER_ALLOWLIST="$(az containerapp show -n apex-gtm-worker -g Ledgr-prod \
  --query "properties.template.containers[0].env[?name=='OUTREACH_LIVE_FOR_ORGS'].value | [0]" -o tsv)"
test "$RESTORED_API_ALLOWLIST" = "$CURRENT_API_ALLOWLIST"
test "$RESTORED_WORKER_ALLOWLIST" = "$CURRENT_WORKER_ALLOWLIST"
```

Restore API truth first and worker delivery last so the UI cannot report dry
run while the worker is already live-enabled.

Never set `*` in production. The runtime guard requires the explicit
`OUTREACH_ALLOW_WILDCARD=true` escape before it will accept a wildcard, but the
production release verifier rejects both the wildcard and that escape flag.

### KS-2 — `OUTREACH_WORKER_ENABLED=false` (pause the send loop)

Code: `apps/api/src/outreach/send-outreach.worker.ts` —
`isOutreachWorkerEnabled()` is strict: only the literal string `"true"`
enables; anything else disables. `onModuleInit` then returns before attaching
the BullMQ consumer **and before scheduling the reconcile sweep**.

```bash
az containerapp update -n apex-gtm-worker -g Ledgr-prod \
  --set-env-vars OUTREACH_WORKER_ENABLED=false
```

**Expected effect:**
- Worker boot log: `SendOutreachWorker disabled (set OUTREACH_WORKER_ENABLED=true to enable)`.
- No consumer on `outreach-send`; APPROVED rows and their jobs accumulate
  untouched. Nothing goes terminal. True pause.
- Pipeline runs (`graph-runs`, gated by `GRAPH_RUN_WORKER_ENABLED`) and the
  Gmail watch renewal sweep (gated by `WORKER_ENABLED`) keep running.
- **Expected alarms while paused** (ack them, don't chase): `/api/health/worker`
  goes 503 once backlog > 0 with reason
  `N job(s) backlogged on "outreach-send" with zero BullMQ consumers attached`;
  the `QUEUE_DEPTH_HIGH` log marker (and the backlog alert from
  `scripts/setup-alerts.sh`) fires once waiting+active ≥ 25.

**Recovery:**

```bash
az containerapp update -n apex-gtm-worker -g Ledgr-prod \
  --set-env-vars OUTREACH_WORKER_ENABLED=true
```

On boot the worker attaches the consumer and runs the reconcile sweep
immediately, re-enqueueing APPROVED rows older than 10 min. The queue drains
at concurrency 5, still honoring the per-org daily cap (default 40, UTC day) —
a large paused backlog may take more than one UTC day to drain by design.

### KS-3 — Scale worker to zero (hard stop)

`--min-replicas 0 --max-replicas 0` is not valid (maxReplicas must be ≥ 1),
and min=0 with scale rules can scale back up. The deterministic zero is:

```bash
az containerapp stop -n apex-gtm-worker -g Ledgr-prod
```

**Expected effect:**
- Everything the worker process does stops: outreach sends, graph/pipeline
  runs, Gmail watch renewal sweep, reconcile sweeps.
- Jobs active at the moment of the kill are redelivered by BullMQ on restart;
  artifacts caught in `SENDING` sit there until the post-restart reconcile
  sweep quarantines claims older than 15 min as `DELIVERY_UNKNOWN`.
- Still working (these live on `apex-gtm-api`): the API itself, inbound Gmail
  push (`/api/integrations/gmail/push`), unsubscribe endpoints (`/api/u/:token`),
  approvals. Approvals made during the stop queue up and send on restart.
- Same expected alarms as KS-2. The replica-restart alert will NOT fire (no
  replicas to restart).

**Recovery:**

```bash
az containerapp start -n apex-gtm-worker -g Ledgr-prod
az containerapp logs show -n apex-gtm-worker -g Ledgr-prod --tail 50   # watch boot: env validator, worker enable lines
curl -fsS "https://${API_FQDN}/api/health/worker" | jq .               # expect 200 + workerCount ≥ 1 per queue
```

Boot order on restart: reconcile sweep runs once immediately (quarantines
stale `SENDING`; re-enqueues only stranded `APPROVED`), then the Gmail watch
renewal sweep runs once (re-arms any watch that expired during the outage).

---

## (b) FAILURE TRIAGE

All SQL below is read-only and runs through the pgclient ACI. Table names are
Prisma defaults (no `@@map`): `"OutreachArtifact"`, `"Integration"`,
`"OutreachSuppression"`, `"GraphRun"` — quote them.

### 1. Auto-failed rows — `REJECTED` with `reviewerNote` prefix `auto-failed:`

Code: `send-outreach.worker.ts` `markTerminalFailure()` — fires when BullMQ
exhausts retries (3 attempts, exponential backoff from 5s). There is no FAILED
enum value yet, so worker-side failures reuse `REJECTED` with the
`auto-failed: <reason>` marker to distinguish them from human rejections.
This applies only when the artifact is safely back in `APPROVED` after a
proved no-attempt or provider-rejected response. An unresolved `SENDING` claim
becomes `DELIVERY_UNKNOWN` instead.

```sql
SELECT id, "orgId", "recipientRef", "reviewerNote", "reviewedAt"
FROM "OutreachArtifact"
WHERE status = 'REJECTED' AND "reviewerNote" LIKE 'auto-failed:%'
ORDER BY "reviewedAt" DESC;
```

Common reasons (verbatim from the code paths that throw):
- `live send required for org <orgId> but dispatch fell back to mock mode (provider=...) — no usable credential; refusing to record SENT`
  → the GL2 guard: an allowlisted org had no usable credential. Go to triage #4.
- `Org <orgId> is missing physicalAddress; cannot send live email outreach until configured (CAN-SPAM §7704(a)(5)).`
  → set the org's physical address (PATCH /api/orgs, admin-gated), then regenerate.
- Provider 4xx/5xx from Gmail → check worker logs around the `reviewedAt` timestamp.

**Recovery:** fix the root cause first. An auto-failed row CANNOT be
re-approved — `approve()` only accepts `PENDING_REVIEW`
(`outreach-artifacts.service.ts`). Re-run the pipeline to produce a fresh
artifact, or (exceptional, DB-safety workflow required) flip the row back to
`APPROVED` by hand and let the reconcile sweep re-enqueue it.

### 2. Policy-skip rows — `SUPPRESSED` with `reviewerNote` prefix `policy-skip:`

`SUPPRESSED` has two distinct producers; tell them apart by `reviewerNote`:

| `reviewerNote` | Producer | Action |
|---|---|---|
| starts `policy-skip:` | GL8b recipient cooldown — org real-SENT to this recipient within 14 days. Note text: `policy-skip: recipient contacted within 14-day cooldown (last SENT <iso> via artifact <id>)` | None. Working as designed. |
| NULL | Suppression list hit (unsubscribed / bounced / manually suppressed recipient) | None — compliance. Never override. |

```sql
SELECT id, "recipientRef", "reviewerNote", "updatedAt"
FROM "OutreachArtifact"
WHERE status = 'SUPPRESSED'
ORDER BY "updatedAt" DESC;
```

Both are terminal, intentional, and not failures. The only triage-worthy
signal is volume: a sudden spike of cooldown skips means something upstream is
generating duplicate outreach for the same recipients.

### 3. Daily-cap deferrals — APPROVED rows that retry after midnight UTC

Code: GL8a in `processArtifact()`. Live sends only. When the org already has
≥ cap (default 40; override `OUTREACH_DAILY_CAP_PER_ORG`, typo-safe fallback
to 40) `SENT` rows with `sentAt` in the current UTC day, the artifact is
**deferred, never failed**: the worker returns without claiming, the row stays
`APPROVED`, the BullMQ job completes. The reconcile sweep (every 5 min)
re-enqueues APPROVED rows older than 10 min — clearing the completed job under
the same jobId first, otherwise the re-add would silently no-op — so deferred
rows keep retrying until the UTC midnight reset clears headroom.

Worker log line (warn):

```
Daily send cap reached for org <orgId> (<n>/<cap> SENT today, UTC) — deferring artifact <id>; row stays APPROVED for the reconcile sweep to retry after midnight UTC
```

Check headroom:

```sql
SELECT count(*) FROM "OutreachArtifact"
WHERE "orgId" = 'cmpe63k370000ap01vsiehbj2'
  AND status = 'SENT'
  AND "sentAt" >= date_trunc('day', now() AT TIME ZONE 'utc');
```

**Action:** normally none — deferral is the designed behavior. Old-but-APPROVED
rows plus the log line above = cap deferral, not a stuck queue. Raising
`OUTREACH_DAILY_CAP_PER_ORG` during pilot week is a product decision, not an
ops fix.

### 4. Token-refresh failure — integration status flip + log lines

Code: GL1 in `apps/api/src/integrations/integrations.service.ts`
`refreshTokenIfNeeded()` / `markRefreshFailedPermanently()`. Behavior matrix:

| Failure | Log line (logger `IntegrationsService`) | Effect |
|---|---|---|
| Permanent — provider returns `invalid_grant` (revoked consent, expired refresh token, changed password) | ERROR: `[Integration:gmail] OAuth refresh PERMANENTLY rejected (invalid_grant) for org <orgId> — marking integration ERROR; user must reconnect gmail` | Row flips `CONNECTED` → `ERROR` with `lastErrorAt` + `lastErrorMessage` = `OAuth token refresh failed: invalid_grant. Reconnect required.` Dashboard shows reconnect. |
| Transient — non-`invalid_grant` HTTP error | WARN: `[Integration:gmail] token refresh HTTP <status> (<code>) — keeping existing creds` | Status unchanged; sends continue on the existing token (may 401 if it really is dead → dispatch fails → BullMQ retries). |
| Transport error (network/circuit breaker) | WARN: `[Integration:gmail] token refresh transport error — keeping existing creds: <msg>` | Same as transient. |
| Refresh OK but DB write failed | WARN: `[Integration:gmail] token refresh DB write failed; using in-memory creds: <msg>` | Send proceeds with fresh in-memory token; next process refreshes again. |
| Credentials undecryptable | WARN: `[Integration:gmail] decrypt failed: <msg>` | `refreshTokenIfNeeded` returns null → worker skips the integration. |

**Downstream symptom chain for an allowlisted org:** integration unusable →
`loadIntegrations` yields an empty map → send tool falls back to mock → GL2
guard throws (`live send required ... refusing to record SENT`) → 3 BullMQ
retries → terminal `auto-failed:` row (triage #1). The send path never lies
about delivery.

Detection:

```sql
SELECT provider, status, "lastErrorAt", "lastErrorMessage"
FROM "Integration"
WHERE status = 'ERROR';
```

**Recovery:** the org admin reconnects the provider through the dashboard
(Gmail OAuth, GL3 flow). The callback stores fresh tokens with an absolute
`expires_at` (GL1 `withAbsoluteExpiry`), and the row flips back to `CONNECTED`.
There is no server-side fix for `invalid_grant` — it requires the user.

### 5. `DELIVERY_UNKNOWN` and `SENDING` claims stuck > 15 min

Code: the reconcile sweep (`reconcileStuckArtifacts()`, every 5 min, also once
at worker boot) changes `SENDING` rows older than 15 min to terminal
`DELIVERY_UNKNOWN`. It does not re-enqueue them. A stale claim cannot prove
whether process loss happened before or after the provider accepted the POST.
Automatically dispatching it again would risk duplicate mail.

```sql
SELECT id, "orgId", status, "recipientRef", subject, "updatedAt",
       "sendReceiptId", "reviewerNote"
FROM "OutreachArtifact"
WHERE status = 'DELIVERY_UNKNOWN'
   OR (status = 'SENDING'
       AND "updatedAt" < now() - interval '15 minutes')
ORDER BY "updatedAt" DESC;
```

**Action:**
1. `curl -fsS "https://${API_FQDN}/api/health/worker"` — if 503 with zero
   consumers on `outreach-send`, fix the worker (env gate? crash-loop? KS-2/KS-3
   left engaged?).
2. Restart the worker (`az containerapp revision restart` or KS-3
   stop/start). Look for
   `Reconcile sweep: quarantined N stale SENDING claim(s) as DELIVERY_UNKNOWN`
   in worker logs.
3. For each `DELIVERY_UNKNOWN`, inspect the connected provider's Sent mailbox
   or message API using recipient, subject, and the narrow send-time window.
   Record the provider evidence in the incident/change record.
4. Never reset the same artifact to `APPROVED`. If provider evidence proves no
   message was accepted and a replacement is still appropriate, create a new
   artifact and put it through normal human review and approval.

This provides at-most-once automatic dispatch for ambiguous outcomes. It is
not exactly-once delivery: a provider may have accepted a request whose
response was lost, so manual/provider reconciliation remains mandatory.

---

## (c) HEALTH

### `/api/health/worker` (GL9)

Code: `apps/api/src/health/worker-health.service.ts` +
`health.controller.ts`. Answers "are the BullMQ consumers actually consuming?"
from queue stats in Redis — so hitting the **api** ingress sees the **worker**
pod's consumers (fleet-wide `Queue.getWorkers()`).

```bash
curl -fsS "https://${API_FQDN}/api/health/worker" | jq .
```

- `200 {"status":"ok", ...}` — healthy.
- `503 {"status":"degraded", ...}` — at least one queue unhealthy; `queues[].reasons` says why.

Per queue (`graph-runs`, `outreach-send`, `agent-runs`) it reports `mode`
(`bullmq`/`fallback`), `healthy`, `reasons`, `workerCount` (fleet-wide),
`backlog` (waiting+active), full `counts`, and `observedWindowMs`. Failure
conditions — exactly two:

1. **No consumers** — zero attached consumers while backlog > 0, or while the
   probed process itself sets the queue's gate env (`WORKER_ENABLED` /
   `GRAPH_RUN_WORKER_ENABLED` / `OUTREACH_WORKER_ENABLED`) to `true`. In
   production, all three consumers are required even when the probe is served
   by an API process whose local worker gates are false, so API-ingress checks
   still assess the fleet-wide worker deployment.
2. **Stalled** — backlog was non-zero a full stall window ago (default 5 min;
   `WORKER_HEALTH_STALL_WINDOW_MS`), has not shrunk, and neither completed nor
   failed counts moved. Consumers attached, nothing flowing.

Redis unreachable → 503 (`queue stats unavailable: ...`). Dev fallback
(no Redis) → healthy-but-unassessable; never the case in prod (queue services
throw at boot without Redis).

**Known limits (deliberate — minimum detection, not APM):** stall snapshots
live in process memory, so (a) the probe must be polled at least once per
stall window for stall detection to work at all — **poll every 60s during live
week** — and (b) an api pod restart loses up to one window of stall history.
`getWorkers()` is fleet-wide: with >1 worker replica, one wedged replica hides
behind a healthy one until throughput stalls. A queue at the removeOnComplete
retention cap with inflow ≈ outflow can rarely false-positive as stalled.

### Watch-renewal status (GL7)

Code: `apps/api/src/integrations/gmail/gmail.service.ts`. Gmail watches expire
after ~7 days; without renewal, DSN bounce auto-suppression and
reply→stop-outreach silently die. The worker (`WORKER_ENABLED=true` process
only) runs a renewal sweep **daily and once at boot**, re-registering the
watch for every CONNECTED gmail integration. Requires `GMAIL_PUBSUB_TOPIC`
set (GCP project `supple-design-494220-v3`, topic `gmail-inbound`).

Log lines to check (worker logs):

```bash
az containerapp logs show -n apex-gtm-worker -g Ledgr-prod --tail 200 \
  | grep -E "gmail.watch|gmail.users.watch"
```

- `gmail.users.watch registered` `{orgId, historyId, expiration}` — per-mailbox success; `expiration` is ms-epoch ~7 days out.
- `gmail.watch renewal sweep complete` `{renewed, failed}` — sweep summary (only logged when it did something).
- `gmail.watch renewal failed for org` `{orgId, error}` — per-org failure; the sweep continues for other orgs. Repeated failures for the same org usually mean a dead token → triage #4.
- `Gmail watch renewal sweep disabled in this process (set WORKER_ENABLED=true to enable)` — you are looking at the api pod, or the worker gate is off.

Manual re-arm for one org (idempotent, org-scoped auth):
`POST https://${API_FQDN}/api/integrations/gmail/watch` — returns
`{ ok: true, historyId, expiration }`.

**Healthy state:** every CONNECTED gmail org gets a `gmail.users.watch registered`
line at least once per 24h. If you see none for >24h, the worker's gate or the
topic env is broken.

### Queue-depth metric (GL9)

Code: `metrics.service.ts` (`publishQueueDepth`) + the 30s pollers in
`outreach-send-queue.service.ts` / `graph-run-queue.service.ts` (run in BOTH
api and worker; primed at boot).

```bash
curl -fsS \
  -H "Authorization: Bearer $METRICS_AUTH_TOKEN" \
  "https://${API_FQDN}/api/metrics" | grep bullmq_queue_depth
```

Production requires `METRICS_AUTH_TOKEN`; local and test environments may omit
it for unauthenticated scraping.

Gauge: `bullmq_queue_depth{queue="outreach-send"|"graph-runs", state="waiting"|"active"|"delayed"|"failed"|"completed"}`.

Alert wiring: when `waiting+active ≥ 25` (override
`BULLMQ_QUEUE_DEPTH_ALERT_THRESHOLD`), the poller logs the stable marker

```
QUEUE_DEPTH_HIGH queue=<name> waiting=<n> active=<n> backlog=<n> threshold=<n> workers=<n>
```

at WARN. `scripts/setup-alerts.sh` creates a Log Analytics scheduled-query
alert matching exactly that token — **do not reword the marker without
updating the script** (and vice versa).

Reading it: backlog high + `workers=0` → consumer down (KS-2 engaged? worker
crashed). Backlog high + workers ≥ 1 → slow drain — check cap deferrals
(triage #3) before assuming a stall; deferred jobs complete and re-enqueue, so
they churn rather than accumulate in `waiting`.

---

## (d) GL10 SMOKE CHECKLIST — tenant-zero, ONE real email

Goal: exactly one real, tracked email out of prod, end to end. Org
`cmpe63k370000ap01vsiehbj2` is already in `OUTREACH_LIVE_FOR_ORGS`. The
recipient must be an inbox **you control** — step 8 permanently suppresses it
for this org, and GL8b will cooldown-block it for 14 days regardless.

**Preconditions**

1. Worker healthy: `curl -fsS "https://${API_FQDN}/api/health/worker" | jq '.healthy'` → `true`, `workerCount ≥ 1` on `outreach-send`.
2. `API_PUBLIC_URL` is identical on API and worker, equals the public API origin,
   and `curl -fsS "https://${API_FQDN}/api/health/ready"` succeeds.
3. Allowlist contains the org:
   ```bash
   az containerapp show -n apex-gtm-worker -g Ledgr-prod \
     --query "properties.template.containers[0].env[?name=='OUTREACH_LIVE_FOR_ORGS'].value | [0]" -o tsv
   ```
4. Org has `physicalAddress` set (live email fail-closes without it):
   ```sql
   SELECT "physicalAddress", "senderName", country FROM "Org" WHERE id = 'cmpe63k370000ap01vsiehbj2';
   ```
5. Daily-cap headroom (triage #3 query) — count must be < 40.

**Step 1 — fresh-or-refreshed Gmail token (GL1)**

```sql
SELECT provider, status, "lastErrorAt", "lastErrorMessage"
FROM "Integration"
WHERE "orgId" = 'cmpe63k370000ap01vsiehbj2' AND provider = 'gmail';
```

- `status = 'CONNECTED'` → done. The GL1 fix means even a credential stored
  before 2026-06-12 (no `expires_at`) is treated as expired and auto-refreshed
  at first use; the refreshed token is persisted to both storage shapes.
  Optional positive check: `POST https://${API_FQDN}/api/integrations/gmail/test`
  (authed, org-scoped) → `{ "ok": true, "message": "gmail credentials are valid." }`.
- `status = 'ERROR'` with `lastErrorMessage` `OAuth token refresh failed: invalid_grant. Reconnect required.`
  → reconnect Gmail via the dashboard OAuth flow (GL3), then re-run the query
  and confirm `CONNECTED`.

**Step 2 — produce one PENDING_REVIEW artifact**

Either trigger a pipeline run from the dashboard scoped so the drafted
recipient is your controlled inbox, or pick an existing one:

```
GET https://${API_FQDN}/api/outreach-artifacts?status=PENDING_REVIEW
```

Record the artifact `id` and `recipientRef`. Confirm the recipient is yours —
this is the last gate before real email.

**Step 3 — approve exactly ONE artifact**

Dashboard Approve button (admin/manager role required), or:

```
POST https://${API_FQDN}/api/outreach-artifacts/<artifact-id>/approve
```

(Clerk-authenticated; `reviewedBy` is server-derived from your session, body
is ignored.) Approve enqueues the send job (jobId = artifact id). A 503 from
approve means enqueue failed but the row IS approved — the reconcile sweep
will retry within ~15 min; don't re-approve.

**Step 4 — watch it flip APPROVED → SENDING → SENT**

```bash
az containerapp logs show -n apex-gtm-worker -g Ledgr-prod --follow \
  | grep -iE "artifact|outreach"
```

Then confirm the terminal row:

```sql
SELECT status, "sentAt", "sendReceiptId"
FROM "OutreachArtifact" WHERE id = '<artifact-id>';
```

Required: `status='SENT'`, `sentAt` set, `sendReceiptId` = Gmail message id.
- `SIMULATED` instead → the org was NOT allowlisted in the worker's env. Fix the allowlist, regenerate, retry.
- `REJECTED auto-failed: live send required ... mock mode` → credential problem; back to Step 1.
- `DELIVERY_UNKNOWN` → do not approve or retry this artifact. Follow failure
  triage #5 and reconcile the provider's Sent mailbox/API first.

**Step 5 — verify Gmail delivery + receipt**

In the recipient inbox: message arrived, from the tenant-zero mailbox.
In the sender mailbox: same message in Sent, Gmail message id matches
`sendReceiptId`. Not in spam (if it is, note headers/SPF/DKIM results from
"Show original" — deliverability data point for the week).

**Step 6 — verify headers + compliance footer**

Gmail → "Show original" on the received message. Must be present:

- `List-Unsubscribe: <https://.../api/u/<token>>`
- `List-Unsubscribe-Post: List-Unsubscribe=One-Click`
- Body footer: sender name, physical postal address, visible Unsubscribe link
  (CAN-SPAM §7704(a)(5)).

**Step 7 — one-click POST**

Take the exact https URL from the `List-Unsubscribe` header:

```bash
curl -i -X POST \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data 'List-Unsubscribe=One-Click' \
  'https://<host>/api/u/<token>'
```

Expect bare `HTTP/2 200`, empty body (RFC 8058 — `unsubscribe.controller.ts`
`unsubscribeOneClick`). Then verify the suppression row:

```sql
SELECT reason, source, "createdAt"
FROM "OutreachSuppression"
WHERE "orgId" = 'cmpe63k370000ap01vsiehbj2' AND "recipientRef" = '<recipient-email>';
```

Expect `reason='USER_UNSUBSCRIBED'`, `source='unsubscribe_one_click'`. This
recipient is now permanently suppressed for the org — any future artifact for
it terminates `SUPPRESSED`. That is the point.

**Step 8 — LangSmith trace**

```sql
SELECT "langsmithRootRunId" FROM "GraphRun"
WHERE id = (SELECT "graphRunId" FROM "OutreachArtifact" WHERE id = '<artifact-id>');
```

Open that run id in the LangSmith project. Confirm the root run exists, node
spans are present, and inline evaluator feedback fired on the LLM runs
(hallucination / PII / etc. — 5/7 verified E2E on 2026-05-25).

**Step 9 — post-smoke sweep**

- `curl -fsS -H "Authorization: Bearer $METRICS_AUTH_TOKEN" "https://${API_FQDN}/api/metrics" | grep 'bullmq_queue_depth{queue="outreach-send"'` → `waiting` and `active` back to 0.
- Triage #1 query → no new `auto-failed:` rows.
- `/api/health/worker` → 200.
- Log the smoke result (artifact id, Gmail message id, LangSmith run id,
  timestamps) in the go-live log doc for the day.

Smoke is GREEN only if all nine steps pass. Any deviation: stop, fix, re-run
with a NEW artifact — never retry the smoke by mutating artifact rows.
