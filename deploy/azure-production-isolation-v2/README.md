# Workforce OS isolated Azure production v2

This package creates the dedicated Workforce OS production control plane in the
existing KloudEdge Azure subscription. It does not mutate or delete anything in
`Ledgr-prod`.

The subscription-scoped template creates:

- resource group `workforce-os-prod`;
- ACR `workforceosprodacr` with admin and anonymous credentials disabled;
- Storage account `workforceosprodctrl` with shared-key, public-blob, SFTP, and
  local-user access disabled;
- private `production-control` blob container;
- a dedicated Log Analytics workspace and Container Apps environment;
- four user-assigned identities with exact GitHub Environment OIDC subjects;
- one non-federated runtime identity with read-only `AcrPull` on the isolated
  registry;
- narrow ACR build/pull, exact-path control-blob, and read-only audit roles.

The template intentionally creates no application, database, cache, DNS, or
custom-domain mutation. Those are later cutover phases.

## Deployment stack boundary

Use a subscription deployment stack so the final provider-created deny
assignment protects the resources from inherited writers in the shared
subscription. The initial apply uses `deny-settings-mode none` while the exact
OIDC identities and zero-byte control blob are established. The final reviewed
update must use:

- `denyWriteAndDelete`;
- child-scope application;
- only the four emitted workload principal IDs as excluded principals;
- the read-only runtime pull identity is not excluded from the deny boundary;
- `detachAll` on unmanage;
- no human principal exclusion.

Do not claim exclusive authority before the live deny assignment, role
assignments, federations, registry credential channels, and Storage credential
channels have been read back and the ten-day drain checkpoint has matured.

## Verify and preview

```bash
az bicep build \
  --file deploy/azure-production-isolation-v2/main.bicep \
  --stdout >/dev/null

az stack sub validate \
  --subscription 3171575e-f164-425c-9ee0-2fb10cf93884 \
  --name workforce-os-production-isolation-v2 \
  --location eastus \
  --template-file deploy/azure-production-isolation-v2/main.bicep \
  --deny-settings-mode none \
  --action-on-unmanage detachAll
```

An authorized initial apply uses the same arguments with `az stack sub create`
and `--yes`. Capture the sanitized output IDs; never copy secrets or registry or
Storage credentials into evidence.

After the stack is applied, a separately authorized provisioning operator may
create the fixed zero-byte controller state exactly once:

```bash
deploy/azure-production-isolation-v2/initialize-control-blob.sh \
  --apply \
  --confirmation 'INITIALIZE WORKFORCE OS PRODUCTION CONTROL BLOB'
```

The initializer uses Entra login, rejects an existing blob, and sends both
`--overwrite false` and `--if-none-match '*'`. Release identities must not run
this one-time provisioning step.
