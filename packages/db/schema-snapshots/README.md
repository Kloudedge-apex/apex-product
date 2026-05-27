Schema snapshots of `apex-prod-db`.

Captured via `pg_dump --schema-only --no-owner --no-privileges --no-tablespaces --no-publications --no-subscriptions --no-comments --quote-all-identifiers`.

These are point-in-time references for rollback planning and schema drift detection — **not migration sources**. Migrations live in `packages/db/prisma/migrations/`.

## How to refresh

```bash
# Build the pg16 client image (idempotent)
az acr build --registry ledgracr --image pg16-client:latest --file pg16.Dockerfile .

# Run a one-off ACI that dumps schema and uploads to blob storage
# (requires temp blob container + SAS — see scripts/snapshot-prod-schema.sh)
```
