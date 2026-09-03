# Go-Live Runbook — Live Sending Week

Operator runbook for the first week of real outbound email (GO-LIVE GL9/GL10).
Everything here is grounded in the guarded-SDR candidate on
`release/go-live-2026-06-01`; the exact local candidate commit is recorded in
the workspace verification file. File references are given so behavior can be
verified before acting.

**Infra constants (do not improvise):**

| Thing                 | Value                                                                                                                                                           |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Resource group        | `workforce-os-prod`                                                                                                                                                    |
| API Container App     | `apex-gtm-api`                                                                                                                                                  |
| Worker Container App  | `apex-gtm-worker`                                                                                                                                               |
| ACR / repo            | `workforceosprodacr` / `apex-api`                                                                                                                                         |
| BullMQ queues         | `graph-runs` (pipeline runs), `outreach-send` (post-approval delivery)                                                                                          |
| Tenant-zero org id    | `cmpe63k370000ap01vsiehbj2`                                                                                                                                     |
| Live-send eligibility | Matching `OUTREACH_LIVE_FOR_ORGS` and `OUTREACH_ALLOW_WILDCARD` values on API and worker; global mode is exactly `*` plus `true`                                  |
| Prod DB access        | `workforceosprodacr`/pgclient ACI workflow (see memory: prod-schema-snapshot-workflow). All writes go through the DB-safety workflow: dry-run + diff + explicit approval. |

Resolve the API ingress FQDN whenever a command below needs it:

```bash
API_FQDN=$(az containerapp show -n apex-gtm-api -g workforce-os-prod \
  --query properties.configuration.ingress.fqdn -o tsv)
```

### Authentication claim contract

Before an API or console-BFF revision receives traffic, verify its non-secret
Clerk claim configuration is present, consistent, and equal to the reviewed
NUL-framed trust tuple pinned in `docs/ops/production-clerk-auth.sha256` in
both canonical repositories:

- `CLERK_JWKS_URL` is exactly
  `https://clerk.workforceos.xyz/.well-known/jwks.json` and `CLERK_ISSUER` is
  exactly `https://clerk.workforceos.xyz`. Clerk's public OpenID discovery
  document must report that same pair.
- `CLERK_DOMAIN` is empty so a domain fallback cannot silently replace the
  reviewed issuer.
- `CLERK_AUTHORIZED_PARTIES` is required in production on both the API and BFF.
  Its exact value is `https://workforceos.xyz`, the sole canonical browser
  application accepted in the JWT `azp` claim. Do not add the separate `www`
  surface, wildcards, paths, or preview-domain patterns.
- `CLERK_AUDIENCE` is empty. A later audience can be admitted only after
  confirming the current Clerk session token carries it and reviewing the new
  tuple pin in both repositories.
- `DEV_TRUST_X_ORG_ID` must remain false on the BFF. The code also ignores it
  whenever `NODE_ENV=production`. `ALLOW_DEV_ORG_HEADER` remains non-production
  only on the API.

The verifiers require RS256, an exact JWKS `kid`, nonempty `sub`, `exp`, `iat`,
the trusted issuer, an active `nbf` when present, and an authorized `azp` in
production. A revision that cannot validate those claims rejects the request;
it must not fall back to client-supplied tenant headers.

### Ingress throttling contract

Authenticated API requests have a bounded process-local backstop keyed only by
the organization established from the verified token. Routes that deliberately
skip tenant auth (health probes, signed webhooks, provider callbacks, and
bootstrap endpoints) are not keyed by source IP inside the application:
console-BFF and provider traffic can share one egress IP, so that design would
let one tenant deny service to all others.

Before admitting public traffic, require and capture evidence for a managed
edge rate-limit policy covering the API ingress, especially unauthenticated and
signed-callback routes. The edge must derive its client identity from the
trusted ingress connection, not a raw client-supplied forwarding header, and
must be sized/tested for shared BFF and provider egress. No production GO is
allowed without that independently enforced multi-replica volumetric control.

The API/worker release verifier hashes the exact five runtime values, including
empty fields, and compares both roles to the reviewed pin. API/worker parity
alone is insufficient: coordinated drift to a different Clerk tenant must
also fail. Missing and explicit-empty `CLERK_DOMAIN`/`CLERK_AUDIENCE` are
equivalent because the runtime treats both as absent; every nonempty byte,
authorized-party order, comma, and whitespace character is otherwise hashed
exactly.

### First-release Clerk configuration normalization

The legacy Container Apps do not satisfy this tuple. Both release controllers
verify the existing environment before they build an artifact or mutate an
image, so the first release intentionally stops until a separately authorized
provider configuration change has normalized all three roles.

That change must use the future protected OIDC release authority, not a local
user session, and must target the following non-secret values on
`apex-gtm-api`, `apex-gtm-worker`, and `nikxius-web`:

- `CLERK_JWKS_URL=https://clerk.workforceos.xyz/.well-known/jwks.json`
- `CLERK_ISSUER=https://clerk.workforceos.xyz`
- `CLERK_DOMAIN` absent or explicitly empty
- `CLERK_AUDIENCE` absent or explicitly empty
- `CLERK_AUTHORIZED_PARTIES=https://workforceos.xyz`

Capture the prior revisions and sanitized non-secret configuration evidence,
apply the API and worker values as one coordinated change, apply the same tuple
to the console, and run both repository verifiers against the active immutable
image digests before admitting a release. Restore the captured revisions if
authentication smoke checks fail. Do not weaken or bypass the preflight to make
the legacy configuration pass. Direct backend-verifier runs from a mutable
checkout are diagnostic only; release evidence comes from the exact-commit
private snapshot used by `scripts/deploy-prod.sh`.

---

## (0) RELEASE ADMISSION AND SCHEMA ORDER

The current guarded-SDR candidate is a production **NO-GO** until all ten
review-only SQL files are rehearsed and then applied with separate operator
approval. Codex did not apply them. Use the invocation, writer-pause,
duplicate-inventory, retry, and postcondition instructions inside each file.

The blocking `Migration Rehearsal (blocking)` CI job is a hermetic candidate
check, not the staging rehearsal named by the production receipt. It applies
the exact ten committed SQL blobs, in reviewed order, to a fresh PostgreSQL
16 + pgvector service populated with two reserved synthetic tenants. It proves
the synthetic identity reconciliation/cutover invariants, fixed-index and
schema postconditions, and a custom-format backup/restore fingerprint. Its
strict receipt is always `environment: ci-synthetic` and
`authority: non-authoritative`; it has no staging or production evidence
fields and cannot satisfy `stagingRehearsalEvidenceHash`, production apply, or
rollback evidence. The controller rejects remote hosts, database names outside
the `workforce_rehearsal_*` namespace, nonempty targets, recovery replicas,
and CI runs without committed sources and native pgvector. Run it only in the
dedicated CI service or an explicitly acknowledged disposable local database:

```bash
WORKFORCE_MIGRATION_REHEARSAL_ACK=ci-synthetic-only \
DATABASE_URL=postgresql://<local-test-user>@127.0.0.1:5432/workforce_rehearsal_<test> \
scripts/rehearse-migration-candidate.sh \
  <full-candidate-sha> <new-outside-repo-receipt.json>
```

Do not point this command at staging or production, and do not promote or
rename its artifact as operator evidence. The separate staging rehearsal and
signed production receipt remain mandatory.

After that receipt passes exact-source verification, the same blocking CI job
builds the candidate production image and runs
`scripts/rehearse-runtime-candidate.sh`. This second hermetic gate starts that
image twice, using the default production command: first as the worker with all
two supported BullMQ consumer gates and Gmail watch renewal enabled, then as
the API with those local worker gates disabled. Both roles connect only to the guarded
`workforce_rehearsal_*` PostgreSQL fixture and an empty, credential-free
loopback Redis database. Before boot, the controller proves that the database still contains
exactly the two reserved synthetic tenants and refreshes only the synthetic
RUNNING graph's activity clock so orphan recovery cannot enqueue provider
work during the test.

The runtime gate requires liveness and PostgreSQL/Redis readiness from both
roles, fleet-visible consumers for `graph-runs` and `outreach-send`, HTTP 401
from an unauthenticated tenant route, and bounded
SIGTERM shutdown without a forced-kill exit. It rejects remote database or
Redis hosts, non-rehearsal database names, credentials other than the fixed CI
PostgreSQL identity, Redis credentials, and an image whose OCI revision label
does not equal the candidate commit. Provider credentials are synthetic,
scheduling and live outreach are disabled, and no cloud mutation occurs.

The resulting receipt conforms to
`docs/ops/ci-runtime-rehearsal-receipt.schema.json`. It contains only the
candidate SHA, local image ID/revision, the migration-receipt hash, dependency
and role booleans, consumer counts, the denial status, and clean-shutdown
results. Like the migration receipt, it is always
`environment: ci-synthetic`, `authority: non-authoritative`. It does not prove
the later registry digest, staging configuration, OAuth, provider delivery,
DNS, browser behavior, or any production rollout and must never be promoted as
that evidence.

After the authorized production apply, create a sanitized receipt conforming to
`docs/ops/production-migration-receipt.schema.json`. Store it outside the Git
working tree and include only hashes, operator/approver identifiers, the change
ticket, booleans, the exact candidate commit, and the non-secret immutable
rollback baseline. Receipt schema v3 requires exact immutable API, worker, and
console/BFF digest references; their exact active revision names; the
independent `enum-aware-api-worker-console-baseline-v1` compatibility
attestation; the `outreach-delivery-unknown-v1` compatibility epoch; the
`disabled` or `first-class` write mode; its mode-specific attestation; and
`verifiedAt` plus `expiresAt` no more than 15 minutes apart. A disabled receipt
also requires a
signed `outreachQuiescence` object proving API mutations blocked, the legacy
worker stopped, all agent-run/graph-run/outreach-send queues paused with zero
active jobs, zero `SENDING`, first-class `DELIVERY_UNKNOWN`, historical
`delivery-unknown:` marker, and reply-slot duplicate rows, and an empty live
send allowlist. Bind the evidence to a sanitized hash. Do not include connection
strings, SQL output, row values, customer identifiers, or message content.
The quiescence object is signed point-in-time evidence, not a live lock. Its
booleans do not hold API blocks, queue pauses, zero-active-job state, or a
stopped worker across the build. A separately protected production authority
must own those controls and revalidate them for the entire bootstrap window.
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

The reviewed pin currently identifies the independently provisioned
`workforce-production-approver` Ed25519 public key. Its private key remains
off-session and outside GitHub and Azure. Any signer rotation requires another
reviewed source change before a new signature can be admitted.

`scripts/verify-migration-release-receipt.sh` rejects undeclared fields, copies
the supplied trust file once, matches those exact bytes to the reviewed digest,
and verifies the detached signature against the claimed approver. The reviewed
digest and all ten migration bytes are read from the exact candidate commit
with replacement objects disabled, never from mutable working-tree files. The
verifier enforces their order and writer-pause requirements. The receipt,
signature, and pinned allowed-signers trust root are mandatory inputs to
`scripts/deploy-prod.sh`. The protected controller is deliberately
noninteractive and requires the explicit `--yes` acknowledgement; it never
reads a confirmation from stdin. Once externally admitted, the
`workforce-os-production` release environment must execute
`scripts/deploy-prod.sh` directly (not through `bash`) so its privileged
bootstrap shebang applies, using:

The controller freezes the receipt, signature, and trust-root bytes into its
private same-attempt runtime directory, then verifies the signature, freshness,
and fixed ten-migration order. It binds the receipt to the exact active API,
worker, and console/BFF revision, image, and write mode. Immediately before
every forward or rollback mutation it re-reads all three exact active
identities, so a same-image configuration revision is still a mismatch.
Both backend apps must explicitly retain at least one inactive revision. After
each forward write, the controller proves the signed prior revision still
exists, is inactive, and still references its exact digest before attempting
the next write. Inactive revisions do not have to expose running lifecycle
states; `Healthy` and `Provisioned` are required after exact reactivation.
Rollback re-verifies the same frozen signed bytes without reapplying the
admission clock after a long build, reactivates only the signed baseline
revisions, and assigns API traffic explicitly to the signed revision name at
100%. It never manufactures rollback revisions with `--image`.

### Two-phase activation for first-class `DELIVERY_UNKNOWN` writes

The `2026-08-12_outreach-delivery-unknown-expand.sql` enum expansion remains
fourth in the fixed ten-migration sequence. There is no fallback writer
mode. Historical `REJECTED` rows with a reserved
`delivery-unknown:` marker are read-only normalization input; new application
code must never create them.

`scripts/deploy-prod.sh` is a subsequent-rollout controller only. It requires
an already active, healthy API, worker, and console and requires the worker
consumer gates and minimum replica count to remain enabled. It therefore must
not be used to bootstrap from a stopped legacy worker. The guarded,
manual-only `.github/workflows/bootstrap-production.yml` workflow now holds
quiescence, establishes the first enum-aware disabled API/worker/console
baseline, and independently attests those three exact identities. Its source
presence is not operational admission: it is not authorized until it is
merged to protected `master` and every external authority, signer, evidence,
and outage gate in `docs/ops/initial-production-bootstrap-controller.md` has
been independently reviewed. Until that bootstrap completes, this release
remains production **NO-GO**; a signed quiescence snapshot alone does not close
the time-of-check/time-of-use gap.

Before requesting bootstrap admission, build the API/worker artifact through
the protected, manual-only `.github/workflows/build-production-candidate.yml`
lane on the exact protected `master` head. Build the console artifact through
the equivalent workflow in the console repository. These lanes are distinct
from `release-production.yml`: they only create immutable ACR artifacts and
sanitized evidence, and must have no Container App authority. Review each
completed run and bind its exact run ID, evidence hash, source commit, and
verified digest into the bootstrap request. Do not use either release workflow
to manufacture a pre-bootstrap artifact, and do not dispatch a build lane
without separate authorization for the ACR write.

Use this order and do not collapse the gates:

1. Block API mutations, stop the legacy worker, pause all three queues, wait
   for zero active jobs, and prove the signed zero inventories listed above.
2. Apply and verify the enum/index migration while the system remains quiesced.
3. Through the separately protected bootstrap workflow, deploy immutable
   console/BFF, API, and worker revisions with
   `OUTREACH_DELIVERY_UNKNOWN_WRITE_MODE=disabled` (or absent), no write
   acknowledgement, and an empty live-send allowlist. Do not substitute the
   subsequent-rollout controller for the initial-bootstrap controller, and do
   not dispatch the bootstrap workflow before its external gates are admitted.
4. Prove all legacy revisions inactive and capture the exact enum-aware
   console/API/worker digests and revision names in a new fresh signed receipt
   carrying
   `compatibilityAttestation: enum-aware-api-worker-console-baseline-v1`.
5. Through the protected bootstrap workflow's `activate-first-class` action,
   which is not authorized by `scripts/deploy-prod.sh`, create the worker-only
   first-class revision while the system remains quiesced:

```text
OUTREACH_DELIVERY_UNKNOWN_WRITE_MODE=first-class
OUTREACH_DELIVERY_UNKNOWN_WRITE_ACK=readers-drained-rollback-baselines-verified-v1
OUTREACH_ROLLBACK_COMPATIBILITY_EPOCH=outreach-delivery-unknown-v1
```

6. Verify the first-class revision and exact compatible rollback baselines,
   then resume queues and API mutations last.

The corresponding signed baseline uses
`deliveryUnknownWriteMode: first-class` and
`attestation: delivery-unknown-readers-drained-rollback-baselines-verified-v1`.
Missing or mismatched values fail startup and release-config verification.
Never restore a pre-enum revision after a first-class value exists; use a
separately reviewed data downgrade if that recovery is ever required.

### Two-phase activation for first-class `FAILED` writes

PostgreSQL enum expansion is not enough to make an old Prisma reader safe.
The first release therefore separates compatible-reader deployment from new
enum writes. Do not collapse these phases:

1. Apply and verify
   `2026-08-13_outreach-artifact-failed-expand.sql` through the signed migration
   process. Retain a hash of the read-only `auto-failed:` inventory query in
   that migration. Historical marker rows with `failedAt IS NULL` remain
   unclassified; the application does not reinterpret them as failures or
   human rejections. Any historical backfill is a later, separately approved
   data change.
2. Deploy the enum-aware console BFF/UI and verify its immutable active digest.
   Then deploy the backend compatibility image with
   `OUTREACH_FAILED_STATUS_WRITES_ENABLED=false` (or absent) and
   `OUTREACH_FAILED_STATUS_WRITES_ACK` absent. The backend controller rolls the
   API reader first and the worker second. In this phase, the new worker writes
   the legacy-compatible `REJECTED` marker plus first-class `failureReason` and
   `failedAt`; compatible readers present only those provenance-bearing rows as
   effective `FAILED`. Public reads present unattested historical marker rows
   as response-only `RECONCILIATION_REQUIRED`, never as a reviewer rejection
   or dispatch failure.
3. Prove all old API and BFF revisions are drained, both active backend roles
   use the compatibility digest, the console is on its compatible digest, the
   release-config verifiers pass, and no unreviewed historical marker has been
   promoted. Capture those immutable revisions as the rollback baseline.
4. Only through the protected configuration authority, set these values on the
   worker (never the API):

   ```text
   OUTREACH_FAILED_STATUS_WRITES_ENABLED=true
   OUTREACH_FAILED_STATUS_WRITES_ACK=readers-drained-legacy-inventory-reviewed-v1
   ```

   Re-run the backend release-config verifier, worker health check, FAILED list
   smoke, and dashboard/policy-event smoke before admitting traffic. A missing
   or different acknowledgement keeps writes on the compatibility form and is
   rejected by production environment validation.

After phase 4, rollback must first disable the FAILED write gate and may restore
only the captured enum-aware compatibility revisions. Never restore a pre-enum
API/BFF after any `FAILED` row exists unless a separately approved data
downgrade has removed every such value. `scripts/deploy-prod.sh` does not enable
this gate and does not substitute for console-drain evidence.

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
pull `workforceosprodacr.azurecr.io/apex-api@sha256:...` as Linux/amd64, and pass
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

Before the repository-local ref, the script acquires an infinite Azure lease
on the fixed `production-control/workforce-os/initial-production-bootstrap/state-v1.json`
blob. This is the global provider-enforced mutation lease shared with the
initial bootstrap and the console repository. It is acquired before any Git
lock ref or ACR artifact write and released last. A post-mutation failure,
lost ownership, or Git cleanup uncertainty retains it; no controller issues a
lease break or deletes the state blob. The reviewed workflow source pins the
exact `WORKFORCE_PRODUCTION_CONTROL_STORAGE_ACCOUNT`,
`WORKFORCE_PRODUCTION_CONTROL_STORAGE_CONTAINER`,
`WORKFORCE_PRODUCTION_CONTROL_STORAGE_BLOB`, and
`WORKFORCE_PRODUCTION_CONTROL_STORAGE_RESOURCE_ID` values. Repository/org
variable fallbacks and per-repository blob names fail closed. Its OIDC identity
needs ABAC-conditioned exact-container-
and-path blob read/write data-plane authority, with blob deletion excluded, in
addition to the reviewed ACR and Container Apps permissions. Azure authorizes acquire,
renew, release, and break through the same blob-write action; RBAC cannot deny
only break, so the protected controller's absence of a break command is part
of the trusted-invoker boundary.

The script then atomically acquires the secondary GitHub ref lease
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
with `Microsoft.App/containerApps/write` across the exact `apex-gtm-api`,
`apex-gtm-worker`, and `nikxius-web` resources, or proves all three are covered
by one coordinated mutation lease that excludes every other writer. The global
Azure lease serializes bootstrap, backend, and console attempts; the Git lease
remains a repository-local compare-and-swap and incident marker. The controller
queries the bootstrap-state role assignments at the exact
`production-control` container child scope with inherited assignments included,
so a direct container assignment cannot hide below a storage-account-only
inventory. The independent read-only audit is:

```bash
node scripts/production-azure-mutation-authority-audit.mjs
```

For the required post-drain production evidence, run that audit through the
protected backend release identity rather than a human Azure session:

```bash
gh workflow run audit-production-authority.yml \
  --repo Kloudedge-apex/apex-product \
  --ref master \
  -f confirmation='AUDIT WORKFORCE OS PRODUCTION AUTHORITY'
```

The workflow uploads the sanitized report whether the audit returns `GO` or
`NO-GO`, but the run succeeds only for an exact `GO` report with no findings,
complete credential drain, and non-null structural and controller evidence.
It has no database, Redis, Container Apps mutation, or checkpoint-write
authority. Do not rerun the checkpoint initializer to collect post-drain
evidence: its create/existing operation is only the separately authorized
start-of-drain ceremony.

It must return `GO` and non-null controller evidence. Its live collection covers
exact OIDC federations, active role assignments, resolved wildcard and exclusion
semantics, active and eligible PIM schedules at management-group through exact
resource scopes, authority delegators, ACR admin/token/task paths, and Storage
shared-key/SFTP/local-user paths. It also rejects lifecycle rules that can act
on the exact control blob and object replication into the control container.
A collection error, unsupported condition, unknown role, unexpected writer,
alternate credential path, or autonomous Storage writer is `NO-GO`.
The exact release identity running this audit must inherit the source-reviewed
management-group authorization/PIM reader and the subscription resource-
configuration reader from `deploy/azure-production-authority-v1`. The package
has separate subscription and management-group entry points; omission, wrong
ancestry, build-identity assignment, or partial apply leaves collection
incomplete and cannot be replaced by a human-session report.

Structural exclusivity alone is not `GO`: already-issued cloud credentials may
outlive the assignment that created them. A structurally clean report exposes a
sanitized structural evidence hash. After separate authorization, use the
source-reviewed authority-drain checkpoint initializer documented in
`deploy/azure-production-authority-v1/README.md`. The checkpoint must bind that
exact hash, remain unchanged for at least 10 days, and still match a fresh live
audit. Missing Blob Data Reader coverage, a missing or malformed checkpoint, a
fresh checkpoint, or any later structural change is `NO-GO`. The sanitized
report contains no principal names or emails; retain the exact report bytes,
checkpoint receipt, structural-evidence hash, and controller-evidence hash for
independent review.

The bootstrap request must copy both
`bootstrapEvidence.azureMutationAuthorityStructuralEvidenceHash` and
`bootstrapEvidence.azureMutationAuthorityEvidenceHash` from that same `GO`
report. The controller admits only the fixed production subscription,
`workforce-os-prod/workforceosprodctrl`, container `production-control`, and controller-state
blob. On every non-audit action it reads the exact drain-checkpoint blob with
Entra login, revalidates its shape, structural hash, unlocked state, zero-byte
content, and minimum age, then includes that live checkpoint evidence in the
version-2 mutation-authority evidence hash. A reset checkpoint, alternate
storage target, or assignment-only evidence can no longer satisfy bootstrap
admission.

The controller re-reads all three apps immediately before the first
write, immediately before each later or compensating write, and after every
write. A manual-only, fail-closed workflow source now exists at
`.github/workflows/release-production.yml` on the review branch, with its source
contract enforced by `scripts/verify-production-release-workflow.sh`. Source
presence is not operational admission. The static verifier is a CI and review
defense; it is not the runtime authority. Protected `master` plus the approved
`workforce-os-production` environment form that runtime boundary. The
privileged workflow must first be
merged to the protected default `master` branch and dispatched with `master` as
the workflow ref. Never dispatch the privileged workflow from the candidate
branch. Its three inputs are the protected `release/go-live-*` branch, that
branch's exact 40-character head SHA, and the literal confirmation
`DEPLOY WORKFORCE OS PRODUCTION`.

Before checkout or OIDC, the workflow fails closed unless the repository API
reports `master` as the default branch, remote `master` still equals the
executing workflow SHA, and the selected release branch is protected and still
equals the requested SHA. GitHub natively admits the job through the exact
`workforce-os-production` environment. The separate governance audit proves
administrator bypass is disabled, reviewer rules are absent for accountable
direct owner dispatch, and only protected branches may deploy. A workflow token
cannot read Environment administration endpoints, so public OIDC coordinates,
the shared control-blob identity, and the current reviewed authority verdict are
source-pinned on protected `master`. The verdict was changed only through a reviewed,
CI-proven source change after protected audit run `33075989120` returned `GO`. The workflow
deliberately never consumes the fallback `${{ vars.* }}` context. Trusted
workflow and exact-CI helpers run only
from the separately checked-out `master` source. The candidate is checked out
to a different directory, materialized on the selected local release branch,
and only then supplies the signer pin and release controller.

The one-time bootstrap workflow uses the same native Environment admission
before checkout or OIDC. Its public Azure coordinates and every current NO-GO
authority verdicts are source-pinned on protected `master`; Container Apps authority is
admitted from protected audit run `33075989120`, while database DDL authority remains
fail-closed until its separate evidence is reviewed. Only the
action that needs a protected secret receives it. Generic `${{ vars.* }}`
fallback and workflow-token Environment administration queries are rejected by
the source contract.

Both repositories were explicitly made public on 2026-08-15 for the protected
release and ten-day drain window, removing the GitHub Free private-plan gate.
At this review point, external GitHub `master`,
`release/go-live-2026-06-01`, and console `main` are still unprotected, so the
workflow cannot be admitted and production remains **NO-GO**. Both protected
environments, secret scanning, and push protection must also be provisioned.
A `protected: true` branch response alone is not
sufficient evidence: the retained ruleset review must require pull-request
approval and the exact CI checks, enforce the rule for administrators, dismiss
stale approval, and forbid force-push and deletion.

The repository also currently contains a legacy repository-scoped
`AZURE_CREDENTIALS` secret. No current workflow consumes it, and its value was
not read, but the authority of its principal is unverified. Revoke/rotate that
credential or prove that its principal cannot write any of the three production
Container Apps before asserting exclusive authority. Azure OIDC federation and
an RBAC audit must still prove that its service principal is the exclusive
`Microsoft.App/containerApps/write` identity across `apex-gtm-api`,
`apex-gtm-worker`, and `nikxius-web`, or is confined by the same coordinated
three-resource mutation lease. The allowed-signers source pin is configured for
`workforce-production-approver`, but all ten migrations still require staging
rehearsal, separate production approval, apply, and signed receipt evidence.
Therefore the authority attestation must remain unset until every external
control and migration prerequisite is verified. Re-audit after any
branch-protection, environment, role-assignment, group-membership, federation,
or break-glass change.

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

1. `docs/migrations/2026-08-13_clerk-identity-lifecycle-expand.sql`
2. `docs/migrations/2026-06-01_outreach-artifact-unique.sql`
3. `docs/migrations/2026-08-12_conversation-store-expand.sql`
4. `docs/migrations/2026-08-12_outreach-delivery-unknown-expand.sql`
5. `docs/migrations/2026-08-13_outreach-artifact-failed-expand.sql`
6. `docs/migrations/2026-08-12_conversation-reply-single-flight-expand.sql`
7. `docs/migrations/2026-08-12_graph-run-activity-expand.sql`
8. `docs/migrations/2026-08-12_graph-run-lifecycle-expand.sql`
9. `docs/migrations/2026-08-20_icp-exclusion-domains-expand.sql`
10. `docs/migrations/2026-09-03_agency-platform-expand.sql`

Before migration 3, retain the read-only legacy `Conversation` catalog
inventory and row count with the change record. The reviewed migration accepts
either no existing relation or the exact empty pre-release production shape.
For that exact shape only, it verifies columns and defaults, index definitions,
constraints, and `ConversationStatus` labels, then preserves the table as
`LegacyConversation` before creating the canonical conversation store. Any
row, prior archive relation, or catalog drift aborts the transaction. Do not
drop, truncate, rename, or manually coerce the legacy table to make the guard
pass.

The Clerk identity migration is intentionally fail-closed: it sets every
legacy `User.membershipActive` value to `false`. Keep identity writers paused
after applying it. Export the current Clerk organization and membership
inventory through an approved operator channel, bind `clerkOrgId` and
`clerkMembershipId` only from immutable provider ids, and explicitly reactivate
only verified current memberships and reviewed local-workspace owners. Seed the
matching organization, membership, and user lifecycle cursors from that same
snapshot. Record the exact active organization, membership, and user-authority
counts from that inventory, including explicit zeroes; omitted counts remain
at the fail-closed `-1` sentinel. Run both zero-row invariants printed in the
migration, then arm the one `clerk_identity_cutover` singleton with those three
counts, the sanitized inventory evidence hash, and the verified
provider-snapshot cutoff in Unix milliseconds as the final paused identity
write. The arming trigger rejects count drift and any seeded cursor newer than
that cutoff. Run the migration's final readiness query and require zero rows.
For Clerk instances where Organizations is disabled, represent each verified
Clerk-backed personal workspace owner with a `personal-owner` plan operation.
It binds the existing local user to the immutable Clerk user id, keeps both
organization and membership ids null, and seeds the matching active user
lifecycle row. Reserve `local-owner` for a reviewed local principal with no
Clerk user id. Never coerce a personal Clerk user into `local-owner` merely to
make the invariant pass.
Do not substitute the database clock for the provider watermark. Until the row
is ready, the API returns a
retryable failure for every authority-creating Clerk webhook; signed deletion
events remain fail-closed. The sanitized inventory digest and invariant-output
digest are mandatory parts of that migration's `postconditionEvidenceHash`;
raw emails, user ids, tenant ids, or provider payloads must not enter the
receipt or repository. Any unresolved row is a rollout stop, not a reason to
restore the old blanket-active default.

Do not deploy code that writes a new column, table, or enum value before its
schema prerequisite. The Clerk identity, artifact, reply-single-flight, and
graph-lifecycle index operations require the documented writer pauses. The
FAILED expand migration is schema-only; deploy it before FAILED writers, then
drain legacy workers before considering any separately approved marker
backfill.
concurrent index files must not run inside a transaction-wrapping migration
runner.

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
az containerapp show -n apex-gtm-api -g workforce-os-prod \
  --query "properties.template.containers[0].env[?name=='API_PUBLIC_URL'].value | [0]" -o tsv
az containerapp show -n apex-gtm-worker -g workforce-os-prod \
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

| You want                                                              | Use                                    | Reversible without data loss?                                                             |
| --------------------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------- |
| Pause sending; resume later, nothing lost                             | KS-2 (`OUTREACH_WORKER_ENABLED=false`) | Yes — APPROVED rows + jobs queue up untouched                                             |
| Guarantee no real email leaves, even if worker misconfig/compromise   | KS-1 (clear `OUTREACH_LIVE_FOR_ORGS`)  | No — approvals processed during the freeze terminate as `SIMULATED` and never auto-resend |
| Worker is misbehaving beyond env flips (crash-loop, runaway behavior) | KS-3 (stop the app)                    | Yes — BullMQ redelivers; reconcile sweep recovers strays on restart                       |

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
CURRENT_API_ALLOWLIST="$(az containerapp show -n apex-gtm-api -g workforce-os-prod \
  --query "properties.template.containers[0].env[?name=='OUTREACH_LIVE_FOR_ORGS'].value | [0]" -o tsv)"
CURRENT_WORKER_ALLOWLIST="$(az containerapp show -n apex-gtm-worker -g workforce-os-prod \
  --query "properties.template.containers[0].env[?name=='OUTREACH_LIVE_FOR_ORGS'].value | [0]" -o tsv)"
test "$CURRENT_API_ALLOWLIST" = "$CURRENT_WORKER_ALLOWLIST"
test -n "$CURRENT_API_ALLOWLIST"
```

Stop if parity fails. Do not guess which value is authoritative.

**2. Clear on BOTH apps** (the worker evaluates it on the send path; the api
evaluates it for honesty/display — keep them in sync):

```bash
az containerapp update -n apex-gtm-worker -g workforce-os-prod --remove-env-vars OUTREACH_LIVE_FOR_ORGS
az containerapp update -n apex-gtm-api    -g workforce-os-prod --remove-env-vars OUTREACH_LIVE_FOR_ORGS
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
az containerapp update -n apex-gtm-api -g workforce-os-prod \
  --set-env-vars "OUTREACH_LIVE_FOR_ORGS=$CURRENT_API_ALLOWLIST"
az containerapp update -n apex-gtm-worker -g workforce-os-prod \
  --set-env-vars "OUTREACH_LIVE_FOR_ORGS=$CURRENT_WORKER_ALLOWLIST"

RESTORED_API_ALLOWLIST="$(az containerapp show -n apex-gtm-api -g workforce-os-prod \
  --query "properties.template.containers[0].env[?name=='OUTREACH_LIVE_FOR_ORGS'].value | [0]" -o tsv)"
RESTORED_WORKER_ALLOWLIST="$(az containerapp show -n apex-gtm-worker -g workforce-os-prod \
  --query "properties.template.containers[0].env[?name=='OUTREACH_LIVE_FOR_ORGS'].value | [0]" -o tsv)"
test "$RESTORED_API_ALLOWLIST" = "$CURRENT_API_ALLOWLIST"
test "$RESTORED_WORKER_ALLOWLIST" = "$CURRENT_WORKER_ALLOWLIST"
```

Restore API truth first and worker delivery last so the UI cannot report dry
run while the worker is already live-enabled.

Production may enable live email for every organization only with the exact,
two-part configuration `OUTREACH_LIVE_FOR_ORGS="*"` and
`OUTREACH_ALLOW_WILDCARD=true` on both API and worker. The release verifier
rejects a wildcard without that acknowledgement, rejects the acknowledgement
without the wildcard, and rejects API/worker drift. This changes eligibility,
not dispatch authorization: an admin or manager must still approve each email,
and mailbox readiness, sender identity, unsubscribe, suppression, cooldown,
daily-cap, reservation, and delivery-ambiguity gates remain fail-closed.

To disable global live send, update the worker first to an empty
`OUTREACH_LIVE_FOR_ORGS` and `OUTREACH_ALLOW_WILDCARD=false`, verify the worker
revision, then update the API. This preserves the worker-first kill direction;
use `OUTREACH_WORKER_ENABLED=false` first when an immediate hard pause is
required.

### KS-2 — `OUTREACH_WORKER_ENABLED=false` (pause the send loop)

Code: `apps/api/src/outreach/send-outreach.worker.ts` —
`isOutreachWorkerEnabled()` is strict: only the literal string `"true"`
enables; anything else disables. `onModuleInit` then returns before attaching
the BullMQ consumer **and before scheduling the reconcile sweep**.

```bash
az containerapp update -n apex-gtm-worker -g workforce-os-prod \
  --set-env-vars OUTREACH_WORKER_ENABLED=false
```

**Expected effect:**

- Worker boot log: `SendOutreachWorker disabled (set OUTREACH_WORKER_ENABLED=true to enable)`.
- No consumer on `outreach-send`; APPROVED rows and their jobs accumulate
  untouched. Nothing goes terminal. True pause.
- Pipeline runs (`graph-runs`, gated by `GRAPH_RUN_WORKER_ENABLED`) and the
  Gmail watch renewal sweep (gated by `GMAIL_WATCH_RENEWAL_ENABLED`) keep
  running.
- **Expected alarms while paused** (ack them, don't chase): `/api/health/worker`
  goes 503 once backlog > 0 with reason
  `N job(s) backlogged on "outreach-send" with zero BullMQ consumers attached`;
  the `QUEUE_DEPTH_HIGH` log marker (and the backlog alert from
  `scripts/setup-alerts.sh`) fires once waiting+active ≥ 25.

**Recovery:**

```bash
az containerapp update -n apex-gtm-worker -g workforce-os-prod \
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
az containerapp stop -n apex-gtm-worker -g workforce-os-prod
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
az containerapp start -n apex-gtm-worker -g workforce-os-prod
az containerapp logs show -n apex-gtm-worker -g workforce-os-prod --tail 50   # watch boot: env validator, worker enable lines
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

### 1. Terminal dispatch failures — `FAILED` plus legacy `auto-failed:` rows

Code: `send-outreach.worker.ts` `markTerminalFailure()` — fires when BullMQ
exhausts retries (3 attempts, exponential backoff from 5s). New workers write
`FAILED` with `failureReason` and `failedAt`, preserving the original human
approval fields. During the expand-first rolling deployment, readers also
recognize the compatibility `REJECTED` plus `auto-failed: <reason>`
representation, but only when `failedAt IS NOT NULL`. A marker row with
`failedAt IS NULL` is historical, unattested inventory: investigate it, but do
not classify or backfill it as a failure without a separately approved data
review.
This applies only when the artifact is safely back in `APPROVED` after a proved
no-attempt or provider-rejected response. An unresolved `SENDING` claim becomes
`DELIVERY_UNKNOWN` instead.

```sql
SELECT id, "orgId", "recipientRef", status, "failureReason", "failedAt",
       CASE
         WHEN status = 'FAILED' THEN 'first-class-failure'
         WHEN "failedAt" IS NOT NULL THEN 'compatibility-failure'
         ELSE 'historical-unattested-marker'
       END AS "failureClassification",
       "reviewerNote", "reviewedAt", "reviewedBy"
FROM "OutreachArtifact"
WHERE status = 'FAILED'
   OR (status = 'REJECTED' AND "reviewerNote" LIKE 'auto-failed:%')
ORDER BY COALESCE("failedAt", "updatedAt") DESC;
```

Common reasons (verbatim from the code paths that throw):

- `live send required for org <orgId> but dispatch fell back to mock mode (provider=...) — no usable credential; refusing to record SENT`
  → the GL2 guard: an allowlisted org had no usable credential. Go to triage #4.
- `Org <orgId> is missing physicalAddress; cannot send live email outreach until configured (CAN-SPAM §7704(a)(5)).`
  → set the org's physical address (PATCH /api/orgs, admin-gated), then regenerate.
- Provider 4xx/5xx from Gmail → check worker logs around `failedAt` (or
  `updatedAt` on a legacy row).

**Recovery:** fix the root cause first. A failed row CANNOT be re-approved —
`approve()` only accepts `PENDING_REVIEW` (`outreach-artifacts.service.ts`).
Re-run the pipeline to produce a separate fresh artifact and review it. Never
mutate the terminal row back to `APPROVED` or retry it in place.

### 2. Policy-skip rows — `SUPPRESSED` with `reviewerNote` prefix `policy-skip:`

`SUPPRESSED` has two distinct producers; tell them apart by `reviewerNote`:

| `reviewerNote`        | Producer                                                                                                                                                                           | Action                             |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| starts `policy-skip:` | GL8b recipient cooldown — org real-SENT to this recipient within 14 days. Note text: `policy-skip: recipient contacted within 14-day cooldown (last SENT <iso> via artifact <id>)` | None. Working as designed.         |
| NULL                  | Suppression list hit (unsubscribed / bounced / manually suppressed recipient)                                                                                                      | None — compliance. Never override. |

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

| Failure                                                                                                 | Log line (logger `IntegrationsService`)                                                                                                                | Effect                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Permanent — provider returns `invalid_grant` (revoked consent, expired refresh token, changed password) | ERROR: `[Integration:gmail] OAuth refresh PERMANENTLY rejected (invalid_grant) for org <orgId> — marking integration ERROR; user must reconnect gmail` | Row flips `CONNECTED` → `ERROR` with `lastErrorAt` + `lastErrorMessage` = `OAuth token refresh failed: invalid_grant. Reconnect required.` Dashboard shows reconnect. |
| Transient — non-`invalid_grant` HTTP error                                                              | WARN: `[Integration:gmail] token refresh HTTP <status> (<code>) — keeping existing creds`                                                              | Status unchanged; sends continue on the existing token (may 401 if it really is dead → dispatch fails → BullMQ retries).                                              |
| Transport error (network/circuit breaker)                                                               | WARN: `[Integration:gmail] token refresh transport error — keeping existing creds: <msg>`                                                              | Same as transient.                                                                                                                                                    |
| Refresh OK but DB write failed                                                                          | WARN: `[Integration:gmail] token refresh DB write failed; using in-memory creds: <msg>`                                                                | Send proceeds with fresh in-memory token; next process refreshes again.                                                                                               |
| Credentials undecryptable                                                                               | WARN: `[Integration:gmail] decrypt failed: <msg>`                                                                                                      | `refreshTokenIfNeeded` returns null → worker skips the integration.                                                                                                   |

**Downstream symptom chain for an allowlisted org:** integration unusable →
`loadIntegrations` yields an empty map → send tool falls back to mock → GL2
guard throws (`live send required ... refusing to record SENT`) → 3 BullMQ
retries → terminal `FAILED` row (or the provenance-bearing `auto-failed:`
representation while the compatibility writer phase is active; triage #1).
The send path never lies about delivery.

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
at worker boot) examines `SENDING` rows older than 15 min. In attested
`first-class` mode it changes them to terminal `DELIVERY_UNKNOWN`; in
`disabled` mode it deliberately leaves them `SENDING`. Neither state is
re-enqueued, and both remain capacity and recipient-delivery risks until an
operator reconciles provider truth. A stale claim cannot prove whether process
loss happened before or after the provider accepted the POST. Automatically
dispatching it again would risk duplicate mail. Reserved
`REJECTED`/`delivery-unknown:` rows are historical read-only compatibility
input; current workers never create them.

```sql
SELECT id, "orgId", status, "recipientRef", subject, "updatedAt",
       "sendReceiptId", "reviewerNote"
FROM "OutreachArtifact"
WHERE status = 'DELIVERY_UNKNOWN'
   OR (status = 'REJECTED'
       AND "reviewerNote" LIKE 'delivery-unknown:%')
   OR (status = 'SENDING'
       AND "updatedAt" < now() - interval '15 minutes')
ORDER BY "updatedAt" DESC;
```

**Action:**

1. `curl -fsS "https://${API_FQDN}/api/health/worker"` — if 503 with zero
   consumers on `outreach-send`, fix the worker (env gate? crash-loop? KS-2/KS-3
   left engaged?).
2. Restart the worker (`az containerapp revision restart` or KS-3
   stop/start). In `first-class` mode, look for
   `Reconcile sweep: quarantined N stale SENDING claim(s) as DELIVERY_UNKNOWN`.
   In `disabled` mode, expect
   `Stale claim ... remains SENDING because delivery-unknown writes are disabled`
   and keep dispatch quiesced until reconciliation is complete.
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

Per supported queue (`graph-runs`, `outreach-send`) it reports `mode`
(`bullmq`/`fallback`), `healthy`, `reasons`, `workerCount` (fleet-wide),
`backlog` (waiting+active), full `counts`, and `observedWindowMs`. Failure
conditions — exactly two:

1. **No consumers** — zero attached consumers while backlog > 0, or while the
   probed process itself sets the supported queue gate env
   (`GRAPH_RUN_WORKER_ENABLED` / `OUTREACH_WORKER_ENABLED`) to `true`. In
   production, both consumers are required even when the probe is served
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
reply→stop-outreach silently die. The worker
(`GMAIL_WATCH_RENEWAL_ENABLED=true` process
only) runs a renewal sweep **daily and once at boot**, re-registering the
watch for every CONNECTED gmail integration. Requires `GMAIL_PUBSUB_TOPIC`
set (GCP project `supple-design-494220-v3`, topic `gmail-inbound`).

Log lines to check (worker logs):

```bash
az containerapp logs show -n apex-gtm-worker -g workforce-os-prod --tail 200 \
  | grep -E "gmail.watch|gmail.users.watch"
```

- `gmail.users.watch registered` `{orgId, historyId, expiration}` — per-mailbox success; `expiration` is ms-epoch ~7 days out.
- `gmail.watch renewal sweep complete` `{renewed, failed}` — sweep summary (only logged when it did something).
- `gmail.watch renewal failed for org` `{orgId, error}` — per-org failure; the sweep continues for other orgs. Repeated failures for the same org usually mean a dead token → triage #4.
- `Gmail watch renewal sweep disabled in this process (set GMAIL_WATCH_RENEWAL_ENABLED=true to enable)` — you are looking at the api pod, or the Gmail renewal gate is off.

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

Goal: exactly one real, tracked email out of prod, end to end. Verify the org
is live-eligible through either the explicit allowlist or the acknowledged
global mode. The recipient must be an inbox **you control** — step 8
permanently suppresses it for this org, and GL8b will cooldown-block it for 14
days regardless.

**Preconditions**

1. Worker healthy: `curl -fsS "https://${API_FQDN}/api/health/worker" | jq '.healthy'` → `true`, `workerCount ≥ 1` on `outreach-send`.
2. `API_PUBLIC_URL` is identical on API and worker, equals the public API origin,
   and `curl -fsS "https://${API_FQDN}/api/health/ready"` succeeds.
3. Allowlist contains the org:
   ```bash
   az containerapp show -n apex-gtm-worker -g workforce-os-prod \
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

- `status = 'CONNECTED'` is necessary but is not a readiness verdict. The GL1
  fix means even a credential stored before 2026-06-12 (no `expires_at`) is
  treated as expired and auto-refreshed at first provider use; the refreshed
  token is persisted to both storage shapes.
- `status = 'ERROR'` with `lastErrorMessage` `OAuth token refresh failed: invalid_grant. Reconnect required.`
  → reconnect Gmail via the dashboard OAuth flow (GL3), then re-run the query
  and confirm `CONNECTED`.
- Any other status is a stop. Do not infer mailbox readiness from the
  Integration row alone.

Using the same authenticated admin/manager session as the production console:

1. `GET https://${API_FQDN}/api/orgs/onboarding/status` must return both
   `mailbox.connected = true` and `sendReadiness.mailboxConnected = true`.
   This is the server-authoritative projection for an identified mailbox with
   a durable history cursor and a fresh provider watch.
2. `GET https://${API_FQDN}/api/integrations/gmail/messages?maxResults=1` must
   return HTTP 200. Discard the response body and do not copy mailbox metadata
   into release evidence. This bounded, read-only provider call is the mounted
   credential-refresh check; the retired Gmail test operation is not part of
   the sellable release.

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
az containerapp logs show -n apex-gtm-worker -g workforce-os-prod --follow \
  | grep -iE "artifact|outreach"
```

Then confirm the terminal row:

```sql
SELECT status, "sentAt", "sendReceiptId"
FROM "OutreachArtifact" WHERE id = '<artifact-id>';
```

Required: `status='SENT'`, `sentAt` set, `sendReceiptId` = Gmail message id.

- `SIMULATED` instead → the org was NOT allowlisted in the worker's env. Fix the allowlist, regenerate, retry.
- `FAILED` with `failureReason` containing `live send required ... mock mode`
  (or the compatibility `REJECTED auto-failed:` form with `failedAt` set) →
  credential problem; back to Step 1.
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
- Triage #1 query → no new `FAILED` or legacy `auto-failed:` rows.
- `/api/health/worker` → 200.
- Log the smoke result (artifact id, Gmail message id, LangSmith run id,
  timestamps) in the go-live log doc for the day.

Smoke is GREEN only if all nine steps pass. Any deviation: stop, fix, re-run
with a NEW artifact — never retry the smoke by mutating artifact rows.
