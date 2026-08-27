# Initial production bootstrap controller

Status: source-controlled implementation under review. This is the one-time
bootstrap path; `scripts/deploy-prod.sh` remains subsequent-rollout-only and
must never be used while the legacy worker is stopped.

## Safety boundary

The bootstrap is a resumable, protected-environment operation. It is not one
long optimistic deployment command. Each invocation runs from the exact
protected `master` workflow source, authenticates to Azure only through the
environment-subject OIDC identity, re-acquires the same attempt's infinite
Azure blob lease, revalidates every live identity, and advances at most one
reviewed phase.

The controller never treats a receipt as a live lock. The durable controls are:

- a fixed, pre-provisioned Azure state blob with an infinite lease whose
  proposed lease ID is deterministically bound to the 32-hex bootstrap attempt;
  this same blob is the provider-enforced global mutation lease used by the
  backend and console subsequent-release controllers, so bootstrap and both
  repositories cannot mutate production concurrently;
- the GitHub production release-lock ref, used as a second serialization and
  incident marker;
- the application writer fence at a monotonically increasing generation;
- the BullMQ bootstrap fence plus globally paused `agent-runs`, `graph-runs`,
  and `outreach-send` queues; and
- disabled API ingress/traffic and inactive legacy worker revisions.

Every Container Apps mutation, including a replay that may only adopt a prior
successful result, revalidates both the live Azure lease and the exact GitHub
release-lock ref immediately before the mutation.

Every child-side Redis and PostgreSQL mutation independently revalidates those
same two authorities at its mutation sink. Redis and database descriptor
hashes are compared before client construction or target mutation; BullMQ
metadata initialization is disabled. PostgreSQL mutations repeat the admitted
identity in the same psql connection, force `public,pg_temp`, and use bounded
lock, statement, idle-transaction, and process timeouts.

The state blob contains the controller state and exact phase-ledger bytes. It
is private operational state, not release evidence. Its Azure RBAC scope must
be limited to the protected workflow identity. Never copy its content to a
workflow log or artifact: it includes the exact source restore configuration
and the prior live-send allowlist, which may be exactly empty. Receipts contain
only hashes of that private state.

The shared lease identity is exact: container `production-control`, blob
`workforce-os/initial-production-bootstrap/state-v1.json`, and the one reviewed
storage-account resource ID. Do not create per-repository lock blobs. The
protected release identities need only the data-plane permissions required to
read the blob lease state, acquire/renew/release this exact lease, and maintain
the fixed authority-drain checkpoint. The exact-container and two-exact-path
read/write role excludes blob deletion, but
Azure maps lease break to the same write action as acquire, renew, and release.
RBAC therefore cannot remove only break; the controllers contain no break
command, and protected source review enforces that prohibition. Bootstrap keeps
its deterministic attempt lease across resumptions. Subsequent releases use a
fresh UUID, acquire the same blob before creating their secondary Git ref or
writing an ACR artifact, and release Azure last after conditional Git cleanup.
The backend release identity also needs read-only storage-resource and inherited
role-assignment access because the controller binds those exact live bytes into
the independently reviewed mutation-authority evidence before any mutation.
The state assignment query is made at the exact `production-control` container
scope with inherited assignments included. That captures both the expected
conditioned storage-account assignments and any direct container-scope writer;
an account-only query would miss the latter.

Every uncertainty enters `HELD`. Before terminal OPEN, a held attempt retains
the Azure lease, GitHub lock, closed writer fence, and queue pauses. After the
durable terminal-OPEN intent, containment disables ingress, re-pauses queues,
deactivates the exact API and worker revisions, and proves stable-zero replicas;
it never recreates a CLOSED epoch. The lease is released only after
the signed `bootstrap-complete` receipt, final live readback, and B8 tombstone
all agree. An operator must investigate a retained lease; timeout or a green
Container App health state is not authorization to break it.

## Pre-bootstrap candidate artifacts

B0 consumes already-built immutable artifacts; the bootstrap controller does
not build source and the subsequent-rollout workflow is not an artifact
factory. Build the backend candidate from the exact protected `master` head
through `.github/workflows/build-production-candidate.yml`. That manual lane is
bound to the separately protected `workforce-os-production-build` environment,
requires exact-commit release CI, creates its context with `git archive`, and
may write only the full-source-SHA and ACR-run-ID tags for `apex-api`. It
refuses an existing source tag, resolves the completed run to one digest,
verifies the pulled Linux/amd64 registry artifact and OCI revision, and emits a
sanitized evidence artifact.

The matching console repository build-only lane produces and verifies the
console digest. Neither lane may read or update Container Apps, databases,
storage, networking, DNS, or bootstrap state. Provision their OIDC principals
with ACR build/pull access only, independently review a successful run, and
bind the resulting exact run IDs, evidence hashes, commits, and digest
references into `targetArtifacts`. Dispatching a candidate-build workflow is
a registry mutation and requires separate operational authorization; merging
its source or passing CI is not that authorization.

## Phase contract

| Phase | Required proof and permitted effect |
| --- | --- |
| B0 `ARTIFACT_READY` | Both protected candidate refs still equal the requested exact commits. API, worker, and console images are immutable `linux/amd64` digest references with matching OCI revision labels and reviewed build/rehearsal evidence. No production mutation. |
| B1 `CONTROL_ACQUIRED` | Protected OIDC identity, exact Azure resources, exclusive RBAC attestation, infinite Azure blob lease, and GitHub release lock are read back. A same-commit Git ref is adoptable only while the exact request-bound attempt journal owns that lease. The exact source API, worker, console, secret-reference hashes, and present non-wildcard allowlist are captured privately. Exact empty is allowed. Independently reviewed outstanding-delivery, provider-drain, exclusive database-DDL authority, failed-list smoke, and dashboard-policy smoke artifacts are exact-byte hash-bound. The DDL artifact covers every production DDL actor for the attempt/database and expires within 24 hours. |
| B2 `LEGACY_QUIESCED` | API ingress and traffic are closed, every active API and worker revision is deactivated, all three queues are globally paused/drained, and two observations prove zero execution replicas. Only then may the protected orphan-token recovery clear process leases, bound to the stable-zero evidence hash; its zero post-state is included in the signed admission context. The application writer fence is then closed, and two later observations prove zero active jobs and zero connected workers. The signed fresh `initial-bootstrap-entry` v2 bytes must match the controller context exactly. |
| B3 `SCHEMA_FORWARD_ONLY` | Before B3 admission, an independently signed, dry-run-verified private Clerk reconciliation plan must already be frozen and hash-bound by the entry receipt. Only sanitized plan metadata (inventory hash, cutoff, expected counts, executor identity/hash, and raw-plan/dry-run hashes) enters the context; row-bearing plan bytes remain private. The ledger is then advanced with Clerk invocation `uncertain` before the first byte is passed to `psql`. From this point, legacy API/worker rollback is forbidden even if the command result is ambiguous. The exact first Clerk migration runs with `ON_ERROR_STOP`, no psqlrc, and no outer transaction. |
| `HELD` after first Clerk apply | The Clerk migration deliberately leaves legacy users inactive and the cutover unarmed. A separately approved identity-reconciliation operation must seed verified Clerk lifecycle state and arm the singleton. The bootstrap retains every control while waiting; it does not infer identities or auto-arm the cutover. |
| B4 `SCHEMA_VERIFIED` | After exact Clerk inventory verification, migrations 2-9 run in the committed order with `psql --no-psqlrc --set=ON_ERROR_STOP=1` and no transaction wrapper. Before every step, one bounded PostgreSQL 16 `pg_catalog` snapshot verifies the exact public-schema objects, persisted prefix, next signed path/SHA against the verifier's hardcoded reviewed byte contract, and complete index-build visibility. Exact complete after-images may adopt a lost acknowledgement; mixed, out-of-order, or same-name/wrong-definition states hold. Each completed step and its catalog-plan hashes are checkpointed. A post-migration quiescence snapshot and signed `production-schema-result` receipt prove every postcondition and exact receipt-chain predecessor. |
| B5 `COMPATIBLE_BASELINE` | Console first, then API reader, then worker are deployed from the signed immutable digests with both new enum writer gates disabled, all consumers disabled, an empty live-send allowlist, API ingress still closed, and all legacy revisions inactive. Progress is checkpointed after each console, API, worker, and ingress-disable mutation; a retry reads back and adopts only the exact expected live revision/template before continuing. The signed `enum-aware-disabled-baseline` receipt binds the exact three revisions. The rollback floor is now enum-aware-disabled only. |
| B6 `FIRST_CLASS_ARMED` | While still quiesced, a worker-only revision enables `DELIVERY_UNKNOWN` and `FAILED` with their exact acknowledgements and compatibility epoch. Its mutation is checkpointed and exact live state is adopted on retry. API never receives worker-only gates. Under the exact CLOSED epoch the signed worker revision remains dormant: it constructs no BullMQ consumer, and both signed observations require `workerCount=0` for every queue. Once activation is attempted or its result is uncertain, assume new enum values may exist. |
| B7 `RESUMING` | The controller first persists the one-way terminal-OPEN intent, including the exact previous CLOSED-state hash, then performs the CLOSED-to-OPEN compare-and-set. The same signed worker revision constructs the `graph-runs` and `outreach-send` consumers only after observing the exact guarded OPEN epoch. While all queues remain paused, the controller proves those two consumers connected and drained and proves retired `agent-runs` remains worker-free; it then resumes graph and outreach while keeping `agent-runs` paused. API ingress and exact-revision traffic are restored last and must pass `/api/health/ready`. Any ambiguity disables ingress, re-pauses all queues, deactivates API/worker revisions, proves stable zero where possible, and remains forward-only under the retained lease. |
| B8 `COMPLETE` | Immediately before the B8 ledger transition, one fresh proof revalidates the lease and release lock; exact terminal OPEN state; connected, resumed, idle `graph-runs` and `outreach-send` consumers; paused, idle, worker-free `agent-runs`; database identity/inventory; sole active API, worker, and console revisions, images, environment gates, ingress, and traffic; both empty live-send allowlists; `/api/health/ready`; and the live Container App release-configuration verifier. Failed-list and dashboard-policy claims use the exact protected smoke-evidence hashes captured at B1, never hard-coded booleans. Its hash is written into the B8 event and tombstone. The signed `bootstrap-complete` receipt, consumed ledger, and tombstone are persisted before cleanup. Git lock deletion is conditionally read back and checkpointed while the Azure lease is held; lease release is last. A crash before or after either cleanup step replays from the consumed B8 checkpoint without readmitting the receipt or reopening the attempt. |

There is no controller abort action. Before B3, any uncertain preparation stays
held for investigation; the implementation does not claim an automated source
restore path. After B3, recovery is forward-only. After B5, only the signed
enum-aware disabled baseline is an eligible recovery baseline. After any B6
activation attempt, old enum-unaware readers are permanently ineligible.

## Maintenance window and customer-facing availability

Disabling API ingress also makes unsubscribe and other API-backed compliance
endpoints unavailable. `prepare` must therefore run only inside an explicitly
approved maintenance window with a documented maximum outage and escalation
SLA. Before the window, review all outstanding campaigns and live-send work.
Every attempt must provide both protected evidence artifacts, even when the
source allowlist is empty. Their exact bytes must match the request hashes and
bind the production environment, attempt ID, backend commit, receipt approver
as reviewer, current `reviewedAt`/`expiresAt` values no more than 24 hours
apart, zero outstanding/unresolved or in-flight deliveries, and the fixed
reviewed disposition/provider scope. If the captured source allowlist is
nonempty, the protected environment must additionally set both
`OUTSTANDING_DELIVERY_REVIEW_CONFIRMED=true` and
`PROVIDER_DELIVERY_DRAIN_CONFIRMED=true`. Queue drain alone is not provider
drain. The bootstrap keeps `OUTREACH_LIVE_FOR_ORGS` exactly empty through B8;
re-enabling live send is a separate reviewed post-bootstrap operation.

## Exact migration order

The controller reads these bytes from the admitted backend commit and verifies
the hashes carried by the entry receipt. It never discovers migrations by
directory order.

1. `docs/migrations/2026-08-13_clerk-identity-lifecycle-expand.sql`
2. `docs/migrations/2026-06-01_outreach-artifact-unique.sql`
3. `docs/migrations/2026-08-12_conversation-store-expand.sql`
4. `docs/migrations/2026-08-12_outreach-delivery-unknown-expand.sql`
5. `docs/migrations/2026-08-13_outreach-artifact-failed-expand.sql`
6. `docs/migrations/2026-08-12_conversation-reply-single-flight-expand.sql`
7. `docs/migrations/2026-08-12_graph-run-activity-expand.sql`
8. `docs/migrations/2026-08-12_graph-run-lifecycle-expand.sql`
9. `docs/migrations/2026-08-20_icp-exclusion-domains-expand.sql`

The concurrent-index files require psql autocommit. Supplying `-1`,
`--single-transaction`, a transaction-wrapping migration runner, or a mutable
file outside the exact commit is a hard failure.

The catalog verifier runs its one read-only query under PostgreSQL 16,
literal `public` namespace checks, a `pg_catalog,public` search path, and
repeatable-read isolation. Built-in inspection functions are explicitly
`pg_catalog`-qualified so public-schema function shadowing cannot create a
false after-image. The production migration principal must
be a superuser or a member of `pg_read_all_stats`, so
`pg_stat_progress_create_index` visibility is complete. Missing that authority
is a hard hold, not permission to assume there is no active index build. The
only bounded repair drops the exact verifier-selected reply indexes, one
`DROP INDEX CONCURRENTLY` invocation at a time, with a fresh lease and release
lock check before each command and a fresh catalog verification before replay.

## Workflow secret scope

Before checkout or OIDC, GitHub natively admits the manual job through the exact
`workforce-os-production` environment. The reviewed workflow source pins the
public OIDC identity coordinates and every current authority verdict. Container
Apps authority is admitted by protected audit run `33075989120`; database DDL
authority remains fail-closed pending its separate bounded evidence review;
the separate governance audit verifies the Environment policy. A workflow token
cannot read Environment administration endpoints. Repository- or
organization-level `vars` fallback is forbidden, and protected secrets are
provided only to the actions that require them.

The workflow injects receipt/signature material only into actions that
verify a receipt; Clerk, delivery-review, exclusive-DDL, and operational-smoke
artifacts only into `prepare`; and
PostgreSQL credentials only into `invoke-clerk` or `apply-schema`. The `audit`
action receives neither `DATABASE_URL` nor `REDIS_URL`; private decoded files
are outside the checkout, mode-restricted, scrubbed, and never uploaded.

## External gates

Source presence is not production admission. Keep production NO-GO until all
of these exist and have been independently reviewed:

- protected `master` and protected exact candidate branches with required CI;
- a `workforce-os-production` direct-dispatch environment with no reviewer rule,
  no administrator bypass, protected-branch admission, and exact typed
  confirmation;
- exact environment-subject Azure OIDC federation and exclusive RBAC across
  all three Container Apps and the bootstrap state blob;
- the exact release identities have both source-reviewed read-only audit roles:
  subscription-scoped resource-configuration reads and authorization/PIM plus
  Resource Graph reads at the fixed management-group ancestor; build identities
  have neither role;
- a current `GO` report from
  `scripts/production-azure-mutation-authority-audit.mjs`, with complete active
  and eligible PIM coverage, no alternate federation, delegator, wildcard,
  child-scope, shared-key, SFTP, local-user, ACR admin, token, or persistent-task
  authority, no lifecycle rule affecting the exact control blob, no object
  replication into the control container, and non-null controller evidence
  whose hash is copied unchanged;
- a server-timed authority-drain checkpoint bound to the audit's exact
  structural evidence hash, unchanged for at least 10 days, with the separately
  authorized create/reset receipt retained for review;
- a bootstrap request that copies both the structural-evidence hash and the
  version-2 controller-evidence hash from the same `GO` report. The controller
  independently reads the exact `workforceosprodctrl/production-control` checkpoint,
  revalidates its age and metadata, and hashes it with the current exact-scope
  assignments before admitting any non-audit action;
- explicit proof that no other principal, pipeline, autoscaler, or operator can
  mutate the three Container Apps or bootstrap blob during the attempt; the
  controller verifies exact assignment evidence, but exclusivity remains an
  independently reviewed external NO-GO gate;
- the pre-provisioned fixed bootstrap state blob;
- a configured reviewed allowed-signers pin for
  `workforce-production-approver` (a malformed or mismatched pin blocks every
  bootstrap);
- final signed B4/B5/B6/B8 receipt contracts and verifiers;
- a separately approved Clerk reconciliation procedure and evidence;
- an approved unsubscribe/API outage window and escalation SLA; and
- reviewed outstanding-campaign, live-send, and provider-drain evidence; and
- reviewed failed-list and dashboard-policy smoke evidence whose exact bytes
  bind both candidates and the attempt;
- exclusive database-DDL authority covering every DDL actor, the exact
  database identity, candidate, attempt, approver, and a live <=24-hour window;
- a PostgreSQL migration principal with verified complete index-progress
  visibility (`rolsuper` or membership in `pg_read_all_stats`).

The Clerk plan is a precondition, not something improvised during the B3 hold.
Its exact private bytes, detached signature, and dry-run bytes are frozen before
any production mutation. `invoke-clerk` re-verifies all three exact byte sets
against the entry receipt and refuses the irreversible migration if any byte,
expected count, cutoff, executor identity, signature, or freshness value has
changed. The plan is never printed or uploaded as a workflow artifact.

No controller source change, test double, CI receipt, synthetic rehearsal, or
locally generated signature satisfies one of these external gates.

Every later production API and worker rollout must preserve the exact
`WORKFORCE_PRODUCTION_BOOTSTRAP_ATTEMPT_ID` and a positive, non-downgraded
`WORKFORCE_PRODUCTION_BOOTSTRAP_MIN_WRITER_FENCE_GENERATION`. Missing, partial,
mismatched, or downgraded guard values are a startup and release-verifier
failure even after terminal OPEN.
