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
ABAC-conditioned read/write role restricted by both exact container name and
exact blob path to
`production-control/workforce-os/initial-production-bootstrap/state-v1.json`.

Azure Storage authorizes lease acquire, renew, release, and break through the
same blob `write` data action. RBAC can remove blob deletion and restrict
read/write to the exact path, but it cannot grant release while denying only
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
```

The verifier compiles the Bicep and rejects wildcard roles, destructive
actions, wrong OIDC subjects, missing exact-path conditions, build-to-app
authority, unsafe initializer behavior, and any claim that lease break can be
separated from the required blob write action.

## External apply boundary

Do not run `az deployment sub create`, the initializer, GitHub environment
configuration, role removal, or any other apply operation without separate
explicit authorization. Before any future apply:

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
7. capture a sanitized assignment inventory for the bootstrap request.

This package does not remove existing assignments. Current Azure authority is
nonexclusive, so compiling this source does not change the production NO-GO.
