#!/bin/bash -p

# Rehearse and apply the post-bootstrap agency schema expansion. The caller
# must be the protected production Environment after Azure OIDC login.

set -Eeuo pipefail
umask 077

ACTION="${1:-}"
OUTPUT="${2:-}"
EXPECTED_COMMIT="${EXPECTED_RELEASE_SHA:-}"
REPOSITORY="Kloudedge-apex/apex-product"
LOCK_REF="heads/workforce-os-release-lock/production-gtm-platform"
SUBSCRIPTION="3171575e-f164-425c-9ee0-2fb10cf93884"
RESOURCE_GROUP="workforce-os-prod"
API_APP="apex-gtm-api"
WORKER_APP="apex-gtm-worker"
CONSOLE_APP="nikxius-web"
CONTROL_ACCOUNT="workforceosprodctrl"
CONTROL_CONTAINER="production-control"
CONTROL_BLOB="workforce-os/initial-production-bootstrap/state-v1.json"
DATABASE_IDENTITY_HASH="sha256:794170e38929960ddbbe08748061591dc51c0f624be47fada658fd4a34f4d74c"
REDIS_IDENTITY_HASH="sha256:46f6195148ab24d399cd4fb82d95410546441484f3531017976b3d34f7093f37"
MIGRATION="docs/migrations/2026-09-03_agency-platform-expand.sql"
PGVECTOR_IMAGE="pgvector/pgvector:pg16@sha256:84a355869251af1a3379cfc9fa7b4dbf962c03f642a4bb7b339a203925071c43"

if [[ ("${ACTION}" != "apply" && "${ACTION}" != "resume") ||
  -z "${OUTPUT}" || "${OUTPUT}" != /* ||
  ! "${EXPECTED_COMMIT}" =~ ^[0-9a-f]{40}$ ||
  "${WORKFORCE_AGENCY_MIGRATION_AUTHORITY_CONFIRMED:-}" != "true" ]]; then
  echo "usage: $0 <apply|resume> <absolute-evidence-path>" >&2
  exit 2
fi
if [[ "$(git rev-parse HEAD)" != "${EXPECTED_COMMIT}" ||
  -n "$(git status --porcelain --untracked-files=all)" ]]; then
  echo "ERROR: agency migration must run from the exact clean release commit" >&2
  exit 1
fi
for command in az base64 corepack docker gh git jq node openssl pg_dump pg_restore psql; do
  command -v "${command}" >/dev/null || {
    echo "ERROR: required command is unavailable: ${command}" >&2
    exit 1
  }
done

RUNTIME_DIR="$(mktemp -d "${RUNNER_TEMP:-/tmp}/workforce-agency-migration.XXXXXX")"
chmod 700 "${RUNTIME_DIR}"
LOCK_ACQUIRED=false
LEASE_ACQUIRED=false
MIGRATION_COMPLETED=false
QUEUE_PAUSED=false
CLONE_CONTAINER=""
API_REVISION=""
WORKER_REVISION=""
LEASE_ID=""

queue_control() {
  local operation=$1 destination=$2
  EXPECTED_REDIS_IDENTITY_HASH="${REDIS_IDENTITY_HASH}" \
  WORKFORCE_AGENCY_MIGRATION_AUTHORITY_CONFIRMED=true \
    corepack pnpm --filter @apex/api exec tsx \
      "${PWD}/scripts/agency-platform-production-queues.ts" "${operation}" "${destination}"
}

release_authority() {
  local failed=false current
  if [[ "${LEASE_ACQUIRED}" == "true" ]]; then
    az storage blob lease release --account-name "${CONTROL_ACCOUNT}" \
      --container-name "${CONTROL_CONTAINER}" --blob-name "${CONTROL_BLOB}" \
      --auth-mode login --subscription "${SUBSCRIPTION}" --lease-id "${LEASE_ID}" \
      --only-show-errors --output none || failed=true
    [[ "${failed}" == "false" ]] && LEASE_ACQUIRED=false
  fi
  if [[ "${LOCK_ACQUIRED}" == "true" ]]; then
    current="$(gh api "repos/${REPOSITORY}/git/ref/${LOCK_REF}" --jq .object.sha 2>/dev/null || true)"
    if [[ "${current}" == "${EXPECTED_COMMIT}" ]]; then
      gh api --method DELETE "repos/${REPOSITORY}/git/refs/${LOCK_REF}" >/dev/null || failed=true
      [[ "${failed}" == "false" ]] && LOCK_ACQUIRED=false
    else
      echo "ERROR: production Git lock identity changed; refusing to delete it" >&2
      failed=true
    fi
  fi
  [[ "${failed}" == "false" ]]
}

cleanup() {
  local status=$?
  trap - EXIT HUP INT TERM
  set +e
  if [[ -n "${CLONE_CONTAINER}" ]]; then docker rm --force "${CLONE_CONTAINER}" >/dev/null 2>&1; fi
  if [[ "${QUEUE_PAUSED}" == "true" && "${MIGRATION_COMPLETED}" != "true" ]]; then
    queue_control resume "${RUNTIME_DIR}/queue-failure-resume.json" || status=1
  fi
  release_authority || status=1
  find "${RUNTIME_DIR}" -type f -exec chmod u+w {} \; 2>/dev/null || true
  rm -rf -- "${RUNTIME_DIR}"
  exit "${status}"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

hash_json() {
  jq -cS . "$1" | openssl dgst -sha256 -r | awk '{print "sha256:" $1}'
}

postconditions() {
  psql --no-psqlrc --set=ON_ERROR_STOP=1 --quiet --tuples-only --no-align "$@" <<'SQL'
WITH facts AS (
  SELECT
    EXISTS (SELECT 1 FROM pg_catalog.pg_enum e JOIN pg_catalog.pg_type t ON t.oid=e.enumtypid WHERE t.typname='EmailSource' AND e.enumlabel='VERIFIED_PATTERN') AS email_source_ready,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='Org' AND column_name='designPartner' AND column_default ILIKE '%true%') AS design_partner_default,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='Org' AND column_name='plan' AND column_default LIKE '%ENTERPRISE%') AS enterprise_default,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='Company' AND column_name='serpDescription') AS serp_description_ready,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='Company' AND column_name='serpSourceUrl') AS serp_source_ready,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='Company' AND column_name='orgId' AND is_nullable='NO') AS company_org_required,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='PatternStore' AND column_name='orgId' AND is_nullable='NO') AS pattern_org_required,
    EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname='Company_orgId_fkey' AND confdeltype='c' AND confupdtype='c') AS company_fk_cascade,
    EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname='PatternStore_orgId_fkey' AND confdeltype='c' AND confupdtype='c') AS pattern_fk_cascade,
    EXISTS (SELECT 1 FROM pg_catalog.pg_indexes WHERE schemaname='public' AND tablename='PatternStore' AND indexname='PatternStore_orgId_domain_key') AS pattern_tenant_unique,
    NOT EXISTS (SELECT 1 FROM pg_catalog.pg_indexes WHERE schemaname='public' AND tablename='PatternStore' AND indexname='PatternStore_domain_key') AS legacy_unique_removed,
    (SELECT count(*) FROM "Company" WHERE "orgId" IS NULL) AS company_null_org_rows,
    (SELECT count(*) FROM "PatternStore" WHERE "orgId" IS NULL) AS pattern_null_org_rows,
    (SELECT count(*) FROM "PatternStore" p LEFT JOIN "Org" o ON o.id=p."orgId" WHERE o.id IS NULL) AS pattern_orphan_rows,
    (SELECT count(*) FROM (SELECT "orgId",domain FROM "PatternStore" GROUP BY "orgId",domain HAVING count(*)>1) d) AS pattern_duplicate_groups
)
SELECT pg_catalog.json_build_object(
  'emailSourceVerifiedPattern',email_source_ready,
  'designPartnerDefault',design_partner_default,
  'enterpriseDefault',enterprise_default,
  'serpDescriptionReady',serp_description_ready,
  'serpSourceReady',serp_source_ready,
  'companyOrgRequired',company_org_required,
  'patternOrgRequired',pattern_org_required,
  'companyFkCascade',company_fk_cascade,
  'patternFkCascade',pattern_fk_cascade,
  'patternTenantUnique',pattern_tenant_unique,
  'legacyUniqueRemoved',legacy_unique_removed,
  'companyNullOrgRows',company_null_org_rows,
  'patternNullOrgRows',pattern_null_org_rows,
  'patternOrphanRows',pattern_orphan_rows,
  'patternDuplicateGroups',pattern_duplicate_groups
)::text FROM facts;
SQL
}

assert_postconditions() {
  jq -e '
    .emailSourceVerifiedPattern and .designPartnerDefault and .enterpriseDefault and
    .serpDescriptionReady and .serpSourceReady and .companyOrgRequired and
    .patternOrgRequired and .companyFkCascade and .patternFkCascade and
    .patternTenantUnique and .legacyUniqueRemoved and
    .companyNullOrgRows == 0 and .patternNullOrgRows == 0 and
    .patternOrphanRows == 0 and .patternDuplicateGroups == 0
  ' "$1" >/dev/null
}

preflight() {
  psql --no-psqlrc --set=ON_ERROR_STOP=1 --quiet --tuples-only --no-align <<'SQL'
SELECT pg_catalog.json_build_object(
  'companyNullOrgRows',(SELECT count(*) FROM "Company" WHERE "orgId" IS NULL),
  'patternOrphanRows',(SELECT count(*) FROM "PatternStore" p WHERE NOT EXISTS (SELECT 1 FROM "Company" c WHERE c.domain=p.domain AND c."orgId" IS NOT NULL)),
  'multiTenantPatternDomains',(SELECT count(*) FROM (SELECT p.domain FROM "PatternStore" p JOIN "Company" c ON c.domain=p.domain AND c."orgId" IS NOT NULL GROUP BY p.domain HAVING count(DISTINCT c."orgId")>1) d),
  'patternRows',(SELECT count(*) FROM "PatternStore")
)::text;
SQL
}

acquire_authority() {
  gh api --method POST "repos/${REPOSITORY}/git/refs" \
    -f ref="refs/${LOCK_REF}" -f sha="${EXPECTED_COMMIT}" >/dev/null
  LOCK_ACQUIRED=true
  LEASE_ID="$(tr '[:upper:]' '[:lower:]' </proc/sys/kernel/random/uuid)"
  returned="$(az storage blob lease acquire --account-name "${CONTROL_ACCOUNT}" \
    --container-name "${CONTROL_CONTAINER}" --blob-name "${CONTROL_BLOB}" \
    --auth-mode login --subscription "${SUBSCRIPTION}" --lease-duration -1 \
    --proposed-lease-id "${LEASE_ID}" --only-show-errors --output tsv)"
  [[ "${returned}" == "${LEASE_ID}" ]] || {
    echo "ERROR: shared production mutation lease returned a different identity" >&2
    exit 1
  }
  LEASE_ACQUIRED=true
}

assert_active_candidate() {
  local digest api worker api_ready worker_ready
  digest="$(az acr manifest list-metadata --registry workforceosprodacr --name apex-api \
    --query "[?tags[?@=='${EXPECTED_COMMIT}']].digest | [0]" --output tsv --only-show-errors)"
  [[ "${digest}" =~ ^sha256:[0-9a-f]{64}$ ]] || {
    echo "ERROR: exact release image is absent from ACR" >&2
    exit 1
  }
  api="$(az containerapp show --name "${API_APP}" --resource-group "${RESOURCE_GROUP}" \
    --query properties.template.containers[0].image --output tsv --only-show-errors)"
  worker="$(az containerapp show --name "${WORKER_APP}" --resource-group "${RESOURCE_GROUP}" \
    --query properties.template.containers[0].image --output tsv --only-show-errors)"
  [[ "${api}" == "workforceosprodacr.azurecr.io/apex-api@${digest}" && "${worker}" == "${api}" ]] || {
    echo "ERROR: API and worker are not on the exact release image" >&2
    exit 1
  }
  api_ready="$(az containerapp revision show --name "${API_APP}" --resource-group "${RESOURCE_GROUP}" \
    --revision "$(az containerapp show --name "${API_APP}" --resource-group "${RESOURCE_GROUP}" --query properties.latestReadyRevisionName --output tsv --only-show-errors)" \
    --query "properties.active && properties.healthState == 'Healthy'" --output tsv --only-show-errors)"
  worker_ready="$(az containerapp revision show --name "${WORKER_APP}" --resource-group "${RESOURCE_GROUP}" \
    --revision "$(az containerapp show --name "${WORKER_APP}" --resource-group "${RESOURCE_GROUP}" --query properties.latestReadyRevisionName --output tsv --only-show-errors)" \
    --query "properties.active && properties.healthState == 'Healthy'" --output tsv --only-show-errors)"
  [[ "${api_ready}" == "true" && "${worker_ready}" == "true" ]] || {
    echo "ERROR: exact release API or worker revision is not healthy" >&2
    exit 1
  }
}

setup_postgres() {
  local decode_path="${RUNTIME_DIR}/pgpass"
  printf '%s' "${PGPASS_B64:?}" | base64 --decode >"${decode_path}"
  chmod 600 "${decode_path}"
  export PGPASSFILE="${decode_path}"
  export PGSSLMODE=verify-full
  export PGSSLROOTCERT=system
  export PGCONNECT_TIMEOUT=10
  export PGOPTIONS='-c search_path=public,pg_temp -c lock_timeout=5000 -c statement_timeout=900000 -c idle_in_transaction_session_timeout=60000'
}

acquire_authority
setup_postgres

if [[ "${ACTION}" == "resume" ]]; then
  assert_active_candidate
  postconditions >"${RUNTIME_DIR}/postconditions.json"
  assert_postconditions "${RUNTIME_DIR}/postconditions.json"
  queue_control resume "${OUTPUT}"
  QUEUE_PAUSED=false
  exit 0
fi

MIGRATION_SHA="sha256:$(openssl dgst -sha256 -r "${MIGRATION}" | awk '{print $1}')"
API_STATE="${RUNTIME_DIR}/api.json"
WORKER_STATE="${RUNTIME_DIR}/worker.json"
CONSOLE_STATE="${RUNTIME_DIR}/console.json"
az containerapp show --name "${API_APP}" --resource-group "${RESOURCE_GROUP}" --output json --only-show-errors >"${API_STATE}"
az containerapp show --name "${WORKER_APP}" --resource-group "${RESOURCE_GROUP}" --output json --only-show-errors >"${WORKER_STATE}"
az containerapp show --name "${CONSOLE_APP}" --resource-group "${RESOURCE_GROUP}" --output json --only-show-errors >"${CONSOLE_STATE}"
for state in "${API_STATE}" "${WORKER_STATE}" "${CONSOLE_STATE}"; do
  jq -e '.properties.configuration.activeRevisionsMode == "Single" and .properties.latestRevisionName == .properties.latestReadyRevisionName' "${state}" >/dev/null
done
API_REVISION="$(jq -r .properties.latestReadyRevisionName "${API_STATE}")"
WORKER_REVISION="$(jq -r .properties.latestReadyRevisionName "${WORKER_STATE}")"

psql --no-psqlrc --set=ON_ERROR_STOP=1 --quiet --tuples-only --no-align <<'SQL' \
  >"${RUNTIME_DIR}/database-identity.json"
SELECT pg_catalog.json_build_object(
  'database_name',pg_catalog.current_database(),
  'database_user',CURRENT_USER,
  'database_schema',pg_catalog.current_schema(),
  'server_address',COALESCE(pg_catalog.inet_server_addr()::text,'local'),
  'server_port',pg_catalog.inet_server_port()::text,
  'server_version',pg_catalog.current_setting('server_version_num')
)::text;
SQL
node --input-type=module - "${RUNTIME_DIR}/database-identity.json" "${DATABASE_IDENTITY_HASH}" <<'NODE'
import { readFileSync } from "node:fs";
import { assertProductionDatabaseIdentityOutput } from "./scripts/production-bootstrap-database-identity.mjs";
assertProductionDatabaseIdentityOutput(readFileSync(process.argv[2]), process.argv[3]);
NODE

preflight >"${RUNTIME_DIR}/preflight.json"
jq -e '.companyNullOrgRows == 0 and .patternOrphanRows == 0' "${RUNTIME_DIR}/preflight.json" >/dev/null
PREFLIGHT_HASH="$(hash_json "${RUNTIME_DIR}/preflight.json")"
STAGING_PREFLIGHT_HASH="${PREFLIGHT_HASH}"

# Rehearse against an ephemeral PostgreSQL 16 clone; the dump is never uploaded.
CLONE_CONTAINER="workforce-agency-rehearsal-${GITHUB_RUN_ID:-local}"
docker run --detach --rm --name "${CLONE_CONTAINER}" -e POSTGRES_USER=rehearsal \
  -e POSTGRES_PASSWORD=synthetic_local_only -e POSTGRES_DB=rehearsal \
  -p 127.0.0.1::5432 "${PGVECTOR_IMAGE}" >/dev/null
for attempt in $(seq 1 60); do
  docker exec "${CLONE_CONTAINER}" pg_isready -U rehearsal -d rehearsal >/dev/null 2>&1 && break
  [[ "${attempt}" -lt 60 ]] || { echo "ERROR: rehearsal PostgreSQL did not start" >&2; exit 1; }
  sleep 2
done
CLONE_PORT="$(docker port "${CLONE_CONTAINER}" 5432/tcp | awk -F: 'NR==1{print $NF}')"
pg_dump --no-owner --no-acl --format=custom --file="${RUNTIME_DIR}/production.dump"
PGPASSWORD=synthetic_local_only PGSSLMODE=disable PGSSLROOTCERT='' PGOPTIONS='' pg_restore --clean --if-exists --no-owner --no-acl \
  --exit-on-error --host=127.0.0.1 --port="${CLONE_PORT}" --username=rehearsal \
  --dbname=rehearsal "${RUNTIME_DIR}/production.dump" >/dev/null
if PGPASSWORD=synthetic_local_only PGSSLMODE=disable PGSSLROOTCERT='' PGOPTIONS='' postconditions \
  --host=127.0.0.1 --port="${CLONE_PORT}" --username=rehearsal --dbname=rehearsal \
  >"${RUNTIME_DIR}/staging-preexisting-postconditions.json" 2>/dev/null &&
  assert_postconditions "${RUNTIME_DIR}/staging-preexisting-postconditions.json" 2>/dev/null; then
  :
else
  PGPASSWORD=synthetic_local_only PGSSLMODE=disable PGSSLROOTCERT='' PGOPTIONS='' psql --no-psqlrc --set=ON_ERROR_STOP=1 \
    --host=127.0.0.1 --port="${CLONE_PORT}" --username=rehearsal --dbname=rehearsal \
    --file="${MIGRATION}" >/dev/null
fi
PGPASSWORD=synthetic_local_only PGSSLMODE=disable PGSSLROOTCERT='' PGOPTIONS='' postconditions \
  --host=127.0.0.1 --port="${CLONE_PORT}" --username=rehearsal --dbname=rehearsal \
  >"${RUNTIME_DIR}/staging-postconditions.json"
assert_postconditions "${RUNTIME_DIR}/staging-postconditions.json"
DUMP_HASH="sha256:$(openssl dgst -sha256 -r "${RUNTIME_DIR}/production.dump" | awk '{print $1}')"
STAGING_HASH="$(jq -cnS --arg dump "${DUMP_HASH}" --arg migration "${MIGRATION_SHA}" \
  --arg preflight "${STAGING_PREFLIGHT_HASH}" --arg post "$(hash_json "${RUNTIME_DIR}/staging-postconditions.json")" \
  '{dumpSha256:$dump,migrationSha256:$migration,preflightEvidenceHash:$preflight,postconditionEvidenceHash:$post}' | openssl dgst -sha256 -r | awk '{print "sha256:" $1}')"
docker rm --force "${CLONE_CONTAINER}" >/dev/null
CLONE_CONTAINER=""

CLONE_CONTAINER="workforce-agency-rollback-${GITHUB_RUN_ID:-local}"
docker run --detach --rm --name "${CLONE_CONTAINER}" -e POSTGRES_USER=rehearsal \
  -e POSTGRES_PASSWORD=synthetic_local_only -e POSTGRES_DB=rehearsal \
  -p 127.0.0.1::5432 "${PGVECTOR_IMAGE}" >/dev/null
for attempt in $(seq 1 60); do
  docker exec "${CLONE_CONTAINER}" pg_isready -U rehearsal -d rehearsal >/dev/null 2>&1 && break
  [[ "${attempt}" -lt 60 ]] || { echo "ERROR: rollback PostgreSQL did not start" >&2; exit 1; }
  sleep 2
done
CLONE_PORT="$(docker port "${CLONE_CONTAINER}" 5432/tcp | awk -F: 'NR==1{print $NF}')"
PGPASSWORD=synthetic_local_only PGSSLMODE=disable PGSSLROOTCERT='' PGOPTIONS='' pg_restore --clean --if-exists --no-owner --no-acl \
  --exit-on-error --host=127.0.0.1 --port="${CLONE_PORT}" --username=rehearsal \
  --dbname=rehearsal "${RUNTIME_DIR}/production.dump" >/dev/null
PGPASSWORD=synthetic_local_only PGSSLMODE=disable PGSSLROOTCERT='' PGOPTIONS='' psql --no-psqlrc --set=ON_ERROR_STOP=1 --quiet --tuples-only --no-align \
  --host=127.0.0.1 --port="${CLONE_PORT}" --username=rehearsal --dbname=rehearsal \
  >"${RUNTIME_DIR}/rollback.json" <<'SQL'
SELECT pg_catalog.json_build_object(
  'companyNullOrgRows',(SELECT count(*) FROM "Company" WHERE "orgId" IS NULL),
  'patternRows',(SELECT count(*) FROM "PatternStore")
)::text;
SQL
jq -e --argjson preflight "$(<"${RUNTIME_DIR}/preflight.json")" \
  '.companyNullOrgRows == $preflight.companyNullOrgRows and .patternRows == $preflight.patternRows' \
  "${RUNTIME_DIR}/rollback.json" >/dev/null
ROLLBACK_HASH="$(hash_json "${RUNTIME_DIR}/rollback.json")"
docker rm --force "${CLONE_CONTAINER}" >/dev/null
CLONE_CONTAINER=""

queue_control pause "${RUNTIME_DIR}/queues-paused.json"
QUEUE_PAUSED=true

preflight >"${RUNTIME_DIR}/production-preflight.json"
jq -e '.companyNullOrgRows == 0 and .patternOrphanRows == 0' "${RUNTIME_DIR}/production-preflight.json" >/dev/null
PREFLIGHT_HASH="$(hash_json "${RUNTIME_DIR}/production-preflight.json")"

lease_readback="$(az storage blob lease renew --account-name "${CONTROL_ACCOUNT}" \
  --container-name "${CONTROL_CONTAINER}" --blob-name "${CONTROL_BLOB}" \
  --auth-mode login --subscription "${SUBSCRIPTION}" --lease-id "${LEASE_ID}" \
  --only-show-errors --output tsv)"
[[ "${lease_readback}" == "${LEASE_ID}" &&
  "$(gh api "repos/${REPOSITORY}/git/ref/${LOCK_REF}" --jq .object.sha)" == "${EXPECTED_COMMIT}" ]] || {
  echo "ERROR: production mutation authority changed before schema apply" >&2
  exit 1
}

if postconditions >"${RUNTIME_DIR}/preexisting-postconditions.json" 2>/dev/null &&
  assert_postconditions "${RUNTIME_DIR}/preexisting-postconditions.json" 2>/dev/null; then
  APPLIED_NOW=false
else
  node --input-type=module - "${RUNTIME_DIR}/database-identity.json" "${DATABASE_IDENTITY_HASH}" "${RUNTIME_DIR}/identity-assertion.sql" <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";
import { assertProductionDatabaseIdentityOutput, productionDatabaseIdentityAssertionSql } from "./scripts/production-bootstrap-database-identity.mjs";
const identity = assertProductionDatabaseIdentityOutput(readFileSync(process.argv[2]), process.argv[3]);
writeFileSync(process.argv[4], `${productionDatabaseIdentityAssertionSql(identity)}\n`, { mode: 0o600, flag: "wx" });
NODE
  psql --no-psqlrc --set=ON_ERROR_STOP=1 --file="${RUNTIME_DIR}/identity-assertion.sql" \
    --file="${MIGRATION}" >/dev/null
  APPLIED_NOW=true
fi
MIGRATION_COMPLETED=true
postconditions >"${RUNTIME_DIR}/production-postconditions.json"
assert_postconditions "${RUNTIME_DIR}/production-postconditions.json"
POSTCONDITION_HASH="$(hash_json "${RUNTIME_DIR}/production-postconditions.json")"

QUEUE_HASH="$(jq -r .evidenceHash "${RUNTIME_DIR}/queues-paused.json")"
PRODUCTION_APPLY_HASH="$(jq -cnS --arg commit "${EXPECTED_COMMIT}" --arg migration "${MIGRATION_SHA}" \
  --arg preflight "${PREFLIGHT_HASH}" --arg post "${POSTCONDITION_HASH}" --arg queues "${QUEUE_HASH}" \
  --argjson appliedNow "${APPLIED_NOW}" \
  '{candidateCommit:$commit,migrationSha256:$migration,preflightEvidenceHash:$preflight,postconditionEvidenceHash:$post,queueEvidenceHash:$queues,appliedNow:$appliedNow,writerPause:"observed"}' \
  | openssl dgst -sha256 -r | awk '{print "sha256:" $1}')"

jq -nS \
  --arg commit "${EXPECTED_COMMIT}" \
  --arg operator "github:${GITHUB_ACTOR:-unknown}" \
  --arg database "${DATABASE_IDENTITY_HASH}" \
  --arg migrationPath "${MIGRATION}" \
  --arg migrationSha "${MIGRATION_SHA}" \
  --arg duplicateInventoryHash "${PREFLIGHT_HASH}" \
  --arg postconditionEvidenceHash "${POSTCONDITION_HASH}" \
  --arg stagingRehearsalEvidenceHash "${STAGING_HASH}" \
  --arg rollbackRehearsalEvidenceHash "${ROLLBACK_HASH}" \
  --arg productionApplyEvidenceHash "${PRODUCTION_APPLY_HASH}" \
  --arg queueEvidenceHash "${QUEUE_HASH}" \
  --arg apiImage "$(jq -r .properties.template.containers[0].image "${API_STATE}")" \
  --arg apiRevision "${API_REVISION}" \
  --arg workerImage "$(jq -r .properties.template.containers[0].image "${WORKER_STATE}")" \
  --arg workerRevision "${WORKER_REVISION}" \
  --arg consoleImage "$(jq -r .properties.template.containers[0].image "${CONSOLE_STATE}")" \
  --arg consoleRevision "$(jq -r .properties.latestReadyRevisionName "${CONSOLE_STATE}")" \
  --arg deliveryUnknownWriteMode "$(jq -r '[.properties.template.containers[0].env[] | select(.name=="OUTREACH_DELIVERY_UNKNOWN_WRITE_MODE") | .value][0] // "disabled"' "${WORKER_STATE}")" \
  --argjson appliedNow "${APPLIED_NOW}" '
  {
    schemaVersion:1,
    kind:"agency-platform-production-migration-evidence",
    environment:"production",
    candidateCommit:$commit,
    operator:$operator,
    databaseIdentityHash:$database,
    migration:{path:$migrationPath,sha256:$migrationSha,preflightPassed:true,applied:true,appliedNow:$appliedNow,postconditionsPassed:true,writerPause:"observed",duplicateInventoryHash:$duplicateInventoryHash,postconditionEvidenceHash:$postconditionEvidenceHash},
    stagingRehearsalEvidenceHash:$stagingRehearsalEvidenceHash,
    productionApplyEvidenceHash:$productionApplyEvidenceHash,
    rollbackRehearsalEvidenceHash:$rollbackRehearsalEvidenceHash,
    queueEvidenceHash:$queueEvidenceHash,
    queuesRemainPaused:true,
    rollbackBaseline:{apiImage:$apiImage,apiRevision:$apiRevision,workerImage:$workerImage,workerRevision:$workerRevision,consoleImage:$consoleImage,consoleRevision:$consoleRevision,deliveryUnknownWriteMode:$deliveryUnknownWriteMode},
    verifiedAt:(now|todateiso8601)
  }' >"${OUTPUT}"

exit 0
