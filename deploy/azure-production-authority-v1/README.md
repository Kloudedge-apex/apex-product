# Workforce OS Azure production authority v1

Status: source-only, compiled, and unapplied.

This subscription-scope Bicep package defines four user-assigned managed
identities with exact GitHub environment OIDC subjects:

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

The release roles retain only the read-only management actions required by the
controller to verify the storage resource identity and enumerate inherited role
assignments at each protected resource; they cannot create, update, or delete
role assignments.

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
```

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

Do not run `az deployment sub create`, either initializer, GitHub environment
configuration, role removal, checkpoint creation/reset, or any other apply
operation without separate explicit authorization. Before any future apply:

1. independently review a subscription-scope what-if and the exact custom-role
   actions;
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
