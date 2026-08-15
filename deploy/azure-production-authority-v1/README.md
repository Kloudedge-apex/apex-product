# Workforce OS Azure production authority v1

Status: source-only, compiled, Azure-validated, what-if reviewed, and unapplied.

This source-only package has two compiled Bicep entry points. `main.bicep` is
subscription scoped and defines four user-assigned managed identities with exact
GitHub environment OIDC subjects. `management-group-audit-reader.bicep` is a
separate management-group deployment because Azure does not allow a subscription-
scope deployment to create resources at its parent management-group scope:

- backend and console candidate-build identities for
  `workforce-os-production-build`;
- backend and console release identities for `workforce-os-production`.

The custom roles intentionally exclude registry administration, credentials,
task management, Container App deletion, secret reads, remote execution,
storage deletion, and role-assignment writes. Build identities receive only ACR
quick-build and pull authority. The backend release identity may mutate the API,
worker, and console apps because it owns initial bootstrap; the console release
identity may mutate only `nikxius-web`. Both release identities use the same
ABAC-conditioned read/write role restricted by exact container name and two
exact blob paths: the controller state blob and the zero-byte authority-drain
checkpoint. No other blob path is granted.

The `ActionMatches{...}` braces in that ABAC expression are emitted from an ARM
`format()` expression and therefore remain doubled in Bicep source. Removing
that escaping still compiles locally but fails Azure deployment validation; the
package verifier rejects that regression.

The release identities also receive two explicit read-only audit roles. The
subscription role can read only the Container Apps, managed identities and
federations, ACR registry/token/task configuration, and Storage account,
container, local-user, lifecycle, and object-replication configuration used by
the audit. The management-group companion grants only authorization/PIM role
reads, Resource Graph reads, and ancestry reads at the one reviewed ancestor
`d4b3813d-146f-4d03-96b8-d6e5862d58a2`. Neither role contains a wildcard,
write/action permission, or data-plane permission. Build identities receive
neither audit role.

The management-group entry point requires the two release principal IDs emitted
by `main.bicep`, so an authorized apply is ordered: subscription package first,
then the exact management-group companion. Omitting or mis-scoping either phase
makes the live audit incomplete and therefore `NO-GO`.

`scripts/production-azure-mutation-authority-audit.mjs` is the separate
read-only exclusivity gate. It resolves active role definitions, wildcard and
`NotActions` behavior, direct and inherited assignments, active and eligible
PIM schedules, exact OIDC federations, control-container child-scope authority,
ACR admin/token/task channels, Storage shared-key/SFTP/local-user channels,
lifecycle rules that can act on the exact control blob, and object replication
into the control container. Its report retains only opaque IDs, counts,
condition hashes, and stable reason codes.

Structural exclusivity starts, but does not complete, the credential-drain
gate. A structurally clean report exposes a sanitized structural evidence hash.
After separate authorization, `initialize-authority-drain-checkpoint.sh`
records that hash on a fixed zero-byte blob using Entra login auth and Azure's
server-controlled modification time. The audit emits `GO` and
controller-compatible assignment evidence only when the structure is unchanged
and the checkpoint is at least 10 days old. A missing, malformed, fresh, or
mismatched checkpoint is `NO-GO`.

Azure Storage authorizes lease acquire, renew, release, and break through the
same blob `write` data action. RBAC can remove blob deletion and restrict
read/write to the two exact paths, but it cannot grant release while denying only
break. The source controllers contain no break command, and protected workflow
review is therefore part of the trusted-invoker boundary. Do not describe this
as provider-enforced no-break authority.

`main.bicep` creates the private container but cannot create the zero-byte data
blob. `initialize-control-blob.sh` is the one-time, no-overwrite initializer. It
requires a separate explicit confirmation and must run under temporary
provisioning authority, never under a release identity.

## Verification

Run only local source verification:

```bash
node scripts/verify-production-authority-package.mjs
node --test scripts/tests/production-authority-package.test.mjs
node --test scripts/tests/production-azure-mutation-authority-audit.test.mjs
az bicep build --file deploy/azure-production-authority-v1/main.bicep --stdout >/dev/null
az bicep build --file deploy/azure-production-authority-v1/management-group-audit-reader.bicep --stdout >/dev/null
```

An authenticated subscription validation and what-if can then run without
applying the package:

```bash
az deployment sub validate \
  --subscription 3171575e-f164-425c-9ee0-2fb10cf93884 \
  --location eastus \
  --name workforce-os-production-authority-v1-validate \
  --template-file deploy/azure-production-authority-v1/main.bicep

az deployment sub what-if \
  --subscription 3171575e-f164-425c-9ee0-2fb10cf93884 \
  --location eastus \
  --name workforce-os-production-authority-v1-whatif \
  --template-file deploy/azure-production-authority-v1/main.bicep \
  --result-format ResourceIdOnly \
  --no-pretty-print
```

On 2026-08-15 the exact candidate passed Azure subscription validation and the
what-if returned `Succeeded`, 29 creates, no modify/delete operation, and no
error. No apply operation was run. The management-group entry point must be
validated and reviewed with the two real release principal IDs after the
ordered subscription phase creates them and before its separately authorized
apply.

After an independently authorized apply and cleanup, an authorized reviewer may
run the live read-only audit with an Azure session that can enumerate RBAC,
PIM, identities, ACR configuration, and Storage configuration:

```bash
node scripts/production-azure-mutation-authority-audit.mjs
```

Do not replace a `NO-GO`, incomplete-coverage finding, or null controller
evidence with a hand-authored attestation.

The bootstrap request consumes both the report's `structuralEvidenceHash` and
`controllerEvidenceHash`. Controller evidence is schema version 2 and binds the
exact checkpoint blob identity, matching structural hash, Azure-controlled
`lastModified` value, and ten-day minimum together with the current exact-scope
role assignments. The controller reads that checkpoint again with Entra login;
an assignment-only reconstruction, alternate subscription/storage account, or
checkpoint reset fails admission.

Only after the audit has no findings except credential-drain checkpoint
findings, separately authorize one of these exact operations:

```bash
./deploy/azure-production-authority-v1/initialize-authority-drain-checkpoint.sh \
  --apply \
  --mode create \
  --confirmation 'CREATE WORKFORCE OS AUTHORITY DRAIN CHECKPOINT'

./deploy/azure-production-authority-v1/initialize-authority-drain-checkpoint.sh \
  --apply \
  --mode reset \
  --confirmation 'RESET WORKFORCE OS AUTHORITY DRAIN CHECKPOINT'
```

`create` is no-overwrite. `reset` updates only the fixed checkpoint metadata
under an exact ETag precondition. Either operation starts the full 10-day
window again. The script refuses human or unrelated service-principal sessions;
run it only through one of the two exact protected release OIDC identities and
the separately reviewed production environment.

The verifier compiles the Bicep and rejects wildcard roles, destructive
actions, wrong OIDC subjects, missing exact-path conditions, build-to-app
authority, unsafe initializer behavior, and any claim that lease break can be
separated from the required blob write action.

## External apply boundary

Do not run `az deployment sub create`, `az deployment mg create`, either initializer, GitHub environment
configuration, role removal, checkpoint creation/reset, or any other apply
operation without separate explicit authorization. Before any future apply:

1. independently review subscription-scope and exact-management-group what-if
   output, the ordered principal-ID handoff, and every custom-role action;
2. identify every inherited user, group, service principal, pipeline, and
   break-glass writer;
3. provision protected GitHub environments and branch controls;
4. initialize the blob once and verify its zero-byte unlocked state;
5. remove temporary provisioning authority and legacy
   `AZURE_CREDENTIALS`-backed mutation authority;
6. prove all remaining Container App writers participate in the same fixed
   lease protocol; and
7. capture a sanitized assignment inventory for the bootstrap request; and
8. after structural exclusivity, create/reset the credential-drain checkpoint,
   preserve the exact receipt, wait the full 10 days, and re-run the audit.

This package does not remove existing assignments. Current Azure authority is
nonexclusive, so compiling this source does not change the production NO-GO.
