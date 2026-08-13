#!/usr/bin/env bash

# Rehearse the reviewed eight-file migration sequence against a disposable,
# loopback-only PostgreSQL database populated with two synthetic tenants.
# This script never produces staging or production migration authority.

set -euo pipefail
umask 077

CANDIDATE_COMMIT="${1:-}"
RECEIPT_OUTPUT="${2:-}"
BASELINE_COMMIT="324f831f31ca903f851b3e697ee94cc25af04217"
ACKNOWLEDGEMENT="${WORKFORCE_MIGRATION_REHEARSAL_ACK:-}"
VECTOR_MODE="${WORKFORCE_REHEARSAL_VECTOR_MODE:-native}"
SOURCE_MODE="${WORKFORCE_REHEARSAL_SOURCE_MODE:-committed-candidate}"
TESTING_MODE="${WORKFORCE_REHEARSAL_TESTING:-false}"
ADVERSARY="${WORKFORCE_REHEARSAL_TEST_SCENARIO:-none}"

MIGRATIONS=(
  "docs/migrations/2026-08-13_clerk-identity-lifecycle-expand.sql"
  "docs/migrations/2026-06-01_outreach-artifact-unique.sql"
  "docs/migrations/2026-08-12_conversation-store-expand.sql"
  "docs/migrations/2026-08-12_outreach-delivery-unknown-expand.sql"
  "docs/migrations/2026-08-13_outreach-artifact-failed-expand.sql"
  "docs/migrations/2026-08-12_conversation-reply-single-flight-expand.sql"
  "docs/migrations/2026-08-12_graph-run-activity-expand.sql"
  "docs/migrations/2026-08-12_graph-run-lifecycle-expand.sql"
)
FIXTURE_PATH="scripts/fixtures/migration-rehearsal-data.sql"
RECONCILIATION_PATH="scripts/fixtures/migration-rehearsal-identity-reconciliation.sql"
POSTCONDITION_PATH="scripts/fixtures/migration-rehearsal-postconditions.sql"

usage() {
  echo "Usage: $0 <full-lowercase-candidate-sha> <new-receipt-path>" >&2
}

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

if [[ ! "${CANDIDATE_COMMIT}" =~ ^[0-9a-f]{40}$ || -z "${RECEIPT_OUTPUT}" ]]; then
  usage
  exit 2
fi
if [[ "${ACKNOWLEDGEMENT}" != "ci-synthetic-only" ]]; then
  fail "set WORKFORCE_MIGRATION_REHEARSAL_ACK=ci-synthetic-only"
fi
if [[ -z "${DATABASE_URL:-}" ]]; then
  fail "DATABASE_URL is required"
fi
if [[ -e "${RECEIPT_OUTPUT}" ]]; then
  fail "receipt output already exists"
fi
if [[ ! -d "$(dirname "${RECEIPT_OUTPUT}")" ]]; then
  fail "receipt output directory does not exist"
fi

case "${SOURCE_MODE}" in
  committed-candidate) ;;
  local-working-tree-test)
    if [[ "${TESTING_MODE}" != "true" || "${GITHUB_ACTIONS:-false}" == "true" ]]; then
      fail "working-tree source mode is allowed only for explicit local tests"
    fi
    ;;
  *) fail "unsupported rehearsal source mode: ${SOURCE_MODE}" ;;
esac

case "${VECTOR_MODE}" in
  native) ;;
  synthetic-array-stub)
    if [[ "${TESTING_MODE}" != "true" || "${GITHUB_ACTIONS:-false}" == "true" ]]; then
      fail "the vector stub is allowed only for explicit local tests"
    fi
    ;;
  *) fail "unsupported vector mode: ${VECTOR_MODE}" ;;
esac

case "${ADVERSARY}" in
  none|artifact-duplicate|reply-duplicate|graph-run-duplicate|identity-count-mismatch|identity-cursor-after-cutoff|incompatible-fixed-index|backup-fingerprint-mismatch) ;;
  *) fail "unsupported rehearsal test scenario: ${ADVERSARY}" ;;
esac
if [[ "${ADVERSARY}" != "none" && "${TESTING_MODE}" != "true" ]]; then
  fail "adversary injection requires WORKFORCE_REHEARSAL_TESTING=true"
fi
if [[ "${GITHUB_ACTIONS:-false}" == "true" ]]; then
  [[ "${SOURCE_MODE}" == "committed-candidate" ]] || fail "CI requires committed candidate sources"
  [[ "${VECTOR_MODE}" == "native" ]] || fail "CI requires native pgvector"
fi

for required_command in git jq node openssl psql pg_dump pg_restore createdb dropdb pnpm sed sort; do
  command -v "${required_command}" >/dev/null 2>&1 ||
    fail "required command is unavailable: ${required_command}"
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"

if ! GIT_NO_REPLACE_OBJECTS=1 git -C "${REPO_ROOT}" cat-file -e \
  "${CANDIDATE_COMMIT}^{commit}" 2>/dev/null; then
  fail "candidate commit is not available locally"
fi
if ! GIT_NO_REPLACE_OBJECTS=1 git -C "${REPO_ROOT}" merge-base --is-ancestor \
  "${BASELINE_COMMIT}" "${CANDIDATE_COMMIT}"; then
  fail "candidate commit does not descend from the reviewed baseline"
fi

TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/workforce-migration-rehearsal.XXXXXX")"
RECEIPT_TEMP=""
RESTORE_CREATED="false"
RESTORE_DB=""
MAINTENANCE_URL=""

cleanup() {
  local cleanup_status=$?
  set +e
  if [[ "${RESTORE_CREATED}" == "true" && "${RESTORE_DB}" =~ ^workforce_rehearsal_[a-z0-9_]+$ ]]; then
    dropdb --if-exists --maintenance-db="${MAINTENANCE_URL}" "${RESTORE_DB}" \
      >/dev/null 2>&1
  fi
  if [[ -n "${RECEIPT_TEMP}" && -f "${RECEIPT_TEMP}" ]]; then
    find "${RECEIPT_TEMP}" -delete
  fi
  if [[ -n "${TEMP_DIR}" && -d "${TEMP_DIR}" &&
    "${TEMP_DIR}" == "${TMPDIR:-/tmp}/workforce-migration-rehearsal."* ]]; then
    find "${TEMP_DIR}" -depth -delete
  fi
  exit "${cleanup_status}"
}
trap cleanup EXIT HUP INT TERM

URL_METADATA="$(DATABASE_URL_VALUE="${DATABASE_URL}" node <<'NODE'
const value = process.env.DATABASE_URL_VALUE;
let parsed;
try {
  parsed = new URL(value);
} catch {
  process.exit(2);
}
if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) process.exit(3);
if (parsed.search || parsed.hash) process.exit(4);
const hostname = parsed.hostname.toLowerCase();
if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname)) process.exit(5);
let database;
try {
  database = decodeURIComponent(parsed.pathname.slice(1));
} catch {
  process.exit(6);
}
if (!/^workforce_rehearsal_[a-z0-9_]+$/.test(database) || database.length > 50) {
  process.exit(7);
}
const restoreDatabase = `${database}_restore`;
if (restoreDatabase.length > 63) process.exit(8);
const maintenance = new URL(parsed.toString());
maintenance.pathname = '/postgres';
process.stdout.write(JSON.stringify({ hostname, database, restoreDatabase, maintenance: maintenance.toString() }));
NODE
)" || fail "DATABASE_URL must target a short workforce_rehearsal_* database on localhost without URL parameters"

DB_HOST="$(jq -er '.hostname' <<<"${URL_METADATA}")"
DB_NAME="$(jq -er '.database' <<<"${URL_METADATA}")"
RESTORE_DB="$(jq -er '.restoreDatabase' <<<"${URL_METADATA}")"
MAINTENANCE_URL="$(jq -er '.maintenance' <<<"${URL_METADATA}")"
unset URL_METADATA

DB_IDENTITY="$(PGCONNECT_TIMEOUT=5 psql --no-psqlrc --dbname="${DATABASE_URL}" \
  --set=ON_ERROR_STOP=1 --tuples-only --no-align --field-separator='|' \
  --command="SELECT current_database(), COALESCE(inet_server_addr()::text, ''), current_setting('server_version_num'), pg_is_in_recovery();")" ||
  fail "could not query the guarded rehearsal database"
IFS='|' read -r ACTUAL_DB SERVER_ADDRESS SERVER_VERSION_NUM IN_RECOVERY <<<"${DB_IDENTITY}"
[[ "${ACTUAL_DB}" == "${DB_NAME}" ]] || fail "database identity changed after URL validation"
[[ "${IN_RECOVERY}" == "f" ]] || fail "rehearsal database must not be a recovery replica"
[[ "${SERVER_VERSION_NUM}" =~ ^[0-9]+$ ]] || fail "invalid PostgreSQL version"
POSTGRES_MAJOR=$((SERVER_VERSION_NUM / 10000))

if [[ "${SERVER_ADDRESS}" =~ ^127\. || "${SERVER_ADDRESS}" == "::1" ]]; then
  :
elif [[ "${GITHUB_ACTIONS:-false}" == "true" &&
  ("${SERVER_ADDRESS}" =~ ^10\. || "${SERVER_ADDRESS}" =~ ^192\.168\. ||
   "${SERVER_ADDRESS}" =~ ^172\.(1[6-9]|2[0-9]|3[01])\.) ]]; then
  :
else
  fail "PostgreSQL server address is not loopback (or a private GitHub Actions service address)"
fi

PUBLIC_OBJECT_COUNT="$(psql --no-psqlrc --dbname="${DATABASE_URL}" \
  --set=ON_ERROR_STOP=1 --tuples-only --no-align --command="
    SELECT COUNT(*)
    FROM pg_class AS c
    JOIN pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f');
  " | tr -d '[:space:]')"
[[ "${PUBLIC_OBJECT_COUNT}" == "0" ]] || fail "rehearsal target public schema is not empty"

if [[ "${VECTOR_MODE}" == "native" ]]; then
  (( POSTGRES_MAJOR >= 16 )) || fail "native CI rehearsal requires PostgreSQL 16 or newer"
  VECTOR_AVAILABLE="$(psql --no-psqlrc --dbname="${DATABASE_URL}" \
    --set=ON_ERROR_STOP=1 --tuples-only --no-align \
    --command="SELECT COUNT(*) FROM pg_available_extensions WHERE name = 'vector';" | tr -d '[:space:]')"
  [[ "${VECTOR_AVAILABLE}" == "1" ]] || fail "native CI rehearsal requires the vector extension"
fi

hash_file() {
  local source_file=$1
  printf 'sha256:%s' "$(openssl dgst -sha256 -r "${source_file}" | awk '{print $1}')"
}

materialize_committed() {
  local source_path=$1
  local destination=$2
  local mode
  mode="$(GIT_NO_REPLACE_OBJECTS=1 git -C "${REPO_ROOT}" ls-tree \
    "${CANDIDATE_COMMIT}" -- "${source_path}" | awk 'NR == 1 {print $1}')"
  [[ "${mode}" == "100644" || "${mode}" == "100755" ]] ||
    fail "candidate source is missing or is not a regular file: ${source_path}"
  GIT_NO_REPLACE_OBJECTS=1 git -C "${REPO_ROOT}" show \
    "${CANDIDATE_COMMIT}:${source_path}" >"${destination}"
}

materialize_fixture() {
  local source_path=$1
  local destination=$2
  local working_path="${REPO_ROOT}/${source_path}"
  if [[ "${SOURCE_MODE}" == "committed-candidate" ]]; then
    materialize_committed "${source_path}" "${destination}"
    return
  fi
  [[ -f "${working_path}" && ! -L "${working_path}" ]] ||
    fail "local test fixture is not a regular non-symlink file: ${source_path}"
  cp -- "${working_path}" "${destination}"
}

BASELINE_SCHEMA_ORIGINAL="${TEMP_DIR}/baseline-original.prisma"
BASELINE_SCHEMA="${TEMP_DIR}/baseline.prisma"
GIT_NO_REPLACE_OBJECTS=1 git -C "${REPO_ROOT}" show \
  "${BASELINE_COMMIT}:packages/db/prisma/schema.prisma" >"${BASELINE_SCHEMA_ORIGINAL}"
BASELINE_SCHEMA_SHA256="$(hash_file "${BASELINE_SCHEMA_ORIGINAL}")"

if [[ "${VECTOR_MODE}" == "synthetic-array-stub" ]]; then
  [[ "$(grep -c 'extensions = \[vector\]' "${BASELINE_SCHEMA_ORIGINAL}")" == "1" ]] ||
    fail "baseline vector extension contract changed"
  [[ "$(grep -c 'Unsupported("vector(3072)")' "${BASELINE_SCHEMA_ORIGINAL}")" == "1" ]] ||
    fail "baseline vector field contract changed"
  sed -e '/^[[:space:]]*extensions = \[vector\]$/d' \
    -e 's/Unsupported("vector(3072)")/Float[]/' \
    "${BASELINE_SCHEMA_ORIGINAL}" >"${BASELINE_SCHEMA}"
else
  cp -- "${BASELINE_SCHEMA_ORIGINAL}" "${BASELINE_SCHEMA}"
fi

FIXTURE_FILE="${TEMP_DIR}/fixture.sql"
RECONCILIATION_FILE="${TEMP_DIR}/identity-reconciliation.sql"
POSTCONDITION_FILE="${TEMP_DIR}/postconditions.sql"
materialize_fixture "${FIXTURE_PATH}" "${FIXTURE_FILE}"
materialize_fixture "${RECONCILIATION_PATH}" "${RECONCILIATION_FILE}"
materialize_fixture "${POSTCONDITION_PATH}" "${POSTCONDITION_FILE}"
FIXTURE_SHA256="$(hash_file "${FIXTURE_FILE}")"
RECONCILIATION_SHA256="$(hash_file "${RECONCILIATION_FILE}")"
POSTCONDITION_SHA256="$(hash_file "${POSTCONDITION_FILE}")"

MIGRATION_FILES=()
MIGRATION_HASHES=()
for index in "${!MIGRATIONS[@]}"; do
  migration_file="${TEMP_DIR}/migration-${index}.sql"
  materialize_committed "${MIGRATIONS[$index]}" "${migration_file}"
  MIGRATION_FILES+=("${migration_file}")
  MIGRATION_HASHES+=("$(hash_file "${migration_file}")")
done

echo "Initializing reviewed baseline in guarded synthetic database"
DATABASE_URL="${DATABASE_URL}" pnpm --dir "${REPO_ROOT}/packages/db" exec prisma \
  db push --schema "${BASELINE_SCHEMA}" --skip-generate >/dev/null
psql --no-psqlrc --dbname="${DATABASE_URL}" --set=ON_ERROR_STOP=1 \
  --file="${FIXTURE_FILE}" >/dev/null

canonical_schema_fingerprint() {
  local connection_url=$1
  pg_dump --dbname="${connection_url}" --schema-only --no-owner --no-privileges | \
    sed -e '/^--/d' -e '/^[[:space:]]*$/d' \
      -e '/^\\restrict /d' -e '/^\\unrestrict /d' | \
    openssl dgst -sha256 -r | awk '{print "sha256:" $1}'
}

canonical_data_fingerprint() {
  local connection_url=$1
  pg_dump --dbname="${connection_url}" --data-only --no-owner --no-privileges \
    --column-inserts --rows-per-insert=1 | \
    sed -e '/^--/d' -e '/^[[:space:]]*$/d' \
      -e '/^\\restrict /d' -e '/^\\unrestrict /d' | \
    LC_ALL=C sort | openssl dgst -sha256 -r | awk '{print "sha256:" $1}'
}

SCHEMA_FINGERPRINT_BEFORE="$(canonical_schema_fingerprint "${DATABASE_URL}")"
DATA_FINGERPRINT_BEFORE="$(canonical_data_fingerprint "${DATABASE_URL}")"
BACKUP_FILE="${TEMP_DIR}/baseline-fixture.dump"
pg_dump --dbname="${DATABASE_URL}" --format=custom --no-owner --no-privileges \
  --file="${BACKUP_FILE}"

IDENTITY_EXPECTED_ORGANIZATION_COUNT=1
IDENTITY_EVENT_OFFSET=0
if [[ "${ADVERSARY}" == "identity-count-mismatch" ]]; then
  IDENTITY_EXPECTED_ORGANIZATION_COUNT=2
elif [[ "${ADVERSARY}" == "identity-cursor-after-cutoff" ]]; then
  IDENTITY_EVENT_OFFSET=1
fi

for index in "${!MIGRATIONS[@]}"; do
  if [[ "${index}" == "1" ]]; then
    if [[ "${ADVERSARY}" == "artifact-duplicate" ]]; then
      psql --no-psqlrc --dbname="${DATABASE_URL}" --set=ON_ERROR_STOP=1 \
        --command="
          INSERT INTO \"OutreachArtifact\" (
            \"id\", \"orgId\", \"graphRunId\", \"toolName\", \"channel\",
            \"recipientRef\", \"payload\", \"status\", \"updatedAt\"
          )
          SELECT
            'ci_artifact_alpha_duplicate', \"orgId\", \"graphRunId\", \"toolName\",
            \"channel\", \"recipientRef\", \"payload\", \"status\", clock_timestamp()
          FROM \"OutreachArtifact\" WHERE \"id\" = 'ci_artifact_alpha';
        " >/dev/null
    elif [[ "${ADVERSARY}" == "incompatible-fixed-index" ]]; then
      psql --no-psqlrc --dbname="${DATABASE_URL}" --set=ON_ERROR_STOP=1 \
        --command='CREATE INDEX "OutreachArtifact_idempotency_uniq" ON "OutreachArtifact" ("status");' \
        >/dev/null
    fi
  fi

  echo "Applying committed migration $((index + 1))/${#MIGRATIONS[@]}"
  psql --no-psqlrc --dbname="${DATABASE_URL}" --set=ON_ERROR_STOP=1 \
    --file="${MIGRATION_FILES[$index]}" >/dev/null

  if [[ "${index}" == "0" ]]; then
    psql --no-psqlrc --dbname="${DATABASE_URL}" --set=ON_ERROR_STOP=1 \
      --set=identity_expected_organization_count="${IDENTITY_EXPECTED_ORGANIZATION_COUNT}" \
      --set=identity_event_offset="${IDENTITY_EVENT_OFFSET}" \
      --file="${RECONCILIATION_FILE}" >/dev/null
  elif [[ "${index}" == "4" && "${ADVERSARY}" == "reply-duplicate" ]]; then
    psql --no-psqlrc --dbname="${DATABASE_URL}" --set=ON_ERROR_STOP=1 >/dev/null <<'SQL'
BEGIN;
INSERT INTO "Conversation" (
  "id", "orgId", "integrationId", "providerThreadId", "contactEmail",
  "subject", "lastMessageAt", "updatedAt"
) VALUES (
  'ci_conversation_adversary', 'ci_org_alpha', 'ci_integration_alpha',
  'ci-provider-thread-adversary', 'reply-source@workforce.invalid',
  'Synthetic reply adversary', clock_timestamp(), clock_timestamp()
);
INSERT INTO "ConversationMessage" (
  "id", "orgId", "conversationId", "direction", "providerMessageId",
  "senderEmail", "toEmails", "sentAt"
) VALUES (
  'ci_message_adversary', 'ci_org_alpha', 'ci_conversation_adversary',
  'INBOUND', 'ci-provider-message-adversary', 'reply-source@workforce.invalid',
  ARRAY['owner-alpha@workforce.invalid'], clock_timestamp()
);
INSERT INTO "OutreachArtifact" (
  "id", "orgId", "toolName", "channel", "recipientRef", "payload", "status",
  "purpose", "conversationId", "providerThreadId", "replyToMessageId", "updatedAt"
) VALUES
  (
    'ci_reply_adversary_one', 'ci_org_alpha', 'ci_synthetic_reply', 'EMAIL',
    'reply-source@workforce.invalid', '{"synthetic":true}'::jsonb, 'PENDING_REVIEW',
    'REPLY', 'ci_conversation_adversary', 'ci-provider-thread-adversary',
    'ci_message_adversary', clock_timestamp()
  ),
  (
    'ci_reply_adversary_two', 'ci_org_alpha', 'ci_synthetic_reply', 'EMAIL',
    'reply-source@workforce.invalid', '{"synthetic":true}'::jsonb, 'SENT',
    'REPLY', 'ci_conversation_adversary', 'ci-provider-thread-adversary',
    'ci_message_adversary', clock_timestamp()
  );
COMMIT;
SQL
  elif [[ "${index}" == "6" && "${ADVERSARY}" == "graph-run-duplicate" ]]; then
    psql --no-psqlrc --dbname="${DATABASE_URL}" --set=ON_ERROR_STOP=1 \
      --command="
        INSERT INTO \"GraphRun\" (
          \"id\", \"orgId\", \"threadId\", \"graphName\", \"status\"
        ) VALUES (
          'ci_graph_alpha_duplicate', 'ci_org_alpha', 'ci-thread-alpha-duplicate',
          'ci-synthetic-graph', 'RUNNING'
        );
      " >/dev/null
  fi
done

psql --no-psqlrc --dbname="${DATABASE_URL}" --set=ON_ERROR_STOP=1 \
  --file="${POSTCONDITION_FILE}" >/dev/null

echo "Restoring and fingerprinting the pre-migration backup"
createdb --maintenance-db="${MAINTENANCE_URL}" "${RESTORE_DB}"
RESTORE_CREATED="true"
RESTORE_URL="$(DATABASE_URL_VALUE="${DATABASE_URL}" RESTORE_DATABASE="${RESTORE_DB}" node <<'NODE'
const parsed = new URL(process.env.DATABASE_URL_VALUE);
parsed.pathname = `/${process.env.RESTORE_DATABASE}`;
process.stdout.write(parsed.toString());
NODE
)"
pg_restore --dbname="${RESTORE_URL}" --exit-on-error --no-owner --no-privileges \
  "${BACKUP_FILE}" >/dev/null

if [[ "${ADVERSARY}" == "backup-fingerprint-mismatch" ]]; then
  psql --no-psqlrc --dbname="${RESTORE_URL}" --set=ON_ERROR_STOP=1 \
    --command='COMMENT ON TABLE "Org" IS '\''synthetic backup fingerprint adversary'\'';' \
    >/dev/null
fi

SCHEMA_FINGERPRINT_AFTER="$(canonical_schema_fingerprint "${RESTORE_URL}")"
DATA_FINGERPRINT_AFTER="$(canonical_data_fingerprint "${RESTORE_URL}")"
if [[ "${SCHEMA_FINGERPRINT_BEFORE}" != "${SCHEMA_FINGERPRINT_AFTER}" ||
  "${DATA_FINGERPRINT_BEFORE}" != "${DATA_FINGERPRINT_AFTER}" ]]; then
  fail "backup/restore fingerprint mismatch"
fi

IDENTITY_METRICS="$(psql --no-psqlrc --dbname="${DATABASE_URL}" \
  --set=ON_ERROR_STOP=1 --tuples-only --no-align --field-separator='|' \
  --command="
    SELECT
      \"ready\",
      \"expectedActiveOrganizationCount\",
      \"expectedActiveMembershipCount\",
      \"expectedActiveUserCount\"
    FROM \"clerk_identity_cutover\" WHERE \"id\" = 1;
  ")"
IFS='|' read -r CUTOVER_READY EXPECTED_ORGS EXPECTED_MEMBERSHIPS EXPECTED_USERS \
  <<<"${IDENTITY_METRICS}"
[[ "${CUTOVER_READY}" == "t" && "${EXPECTED_ORGS}" == "1" &&
  "${EXPECTED_MEMBERSHIPS}" == "1" && "${EXPECTED_USERS}" == "1" ]] ||
  fail "identity receipt metrics do not match the proven cutover"

MIGRATION_JSON='[]'
for index in "${!MIGRATIONS[@]}"; do
  MIGRATION_JSON="$(jq -c \
    --arg path "${MIGRATIONS[$index]}" \
    --arg sha256 "${MIGRATION_HASHES[$index]}" \
    '. + [{path: $path, sha256: $sha256, applied: true, postconditionsPassed: true}]' \
    <<<"${MIGRATION_JSON}")"
done

RECEIPT_TEMP="$(mktemp "${RECEIPT_OUTPUT}.tmp.XXXXXX")"
jq -n \
  --arg source_mode "${SOURCE_MODE}" \
  --arg candidate "${CANDIDATE_COMMIT}" \
  --arg baseline "${BASELINE_COMMIT}" \
  --arg baseline_schema_sha256 "${BASELINE_SCHEMA_SHA256}" \
  --arg fixture_sha256 "${FIXTURE_SHA256}" \
  --arg reconciliation_sha256 "${RECONCILIATION_SHA256}" \
  --arg postcondition_sha256 "${POSTCONDITION_SHA256}" \
  --arg verified_at "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" \
  --argjson postgres_major "${POSTGRES_MAJOR}" \
  --arg vector_mode "${VECTOR_MODE}" \
  --arg schema_before "${SCHEMA_FINGERPRINT_BEFORE}" \
  --arg schema_after "${SCHEMA_FINGERPRINT_AFTER}" \
  --arg data_before "${DATA_FINGERPRINT_BEFORE}" \
  --arg data_after "${DATA_FINGERPRINT_AFTER}" \
  --argjson migrations "${MIGRATION_JSON}" '
  {
    schemaVersion: 1,
    environment: "ci-synthetic",
    authority: "non-authoritative",
    status: "passed",
    sourceMode: $source_mode,
    candidateCommit: $candidate,
    baselineCommit: $baseline,
    baselineSchemaSha256: $baseline_schema_sha256,
    fixtureSha256: $fixture_sha256,
    reconciliationFixtureSha256: $reconciliation_sha256,
    postconditionFixtureSha256: $postcondition_sha256,
    verifiedAt: $verified_at,
    postgresMajor: $postgres_major,
    vectorMode: $vector_mode,
    tenantFixtureCount: 2,
    backupRestore: {
      archiveFormat: "postgres-custom",
      schemaFingerprintBefore: $schema_before,
      schemaFingerprintAfter: $schema_after,
      dataFingerprintBefore: $data_before,
      dataFingerprintAfter: $data_after,
      matched: true
    },
    identity: {
      cutoverReady: true,
      expectedActiveOrganizationCount: 1,
      expectedActiveMembershipCount: 1,
      expectedActiveUserCount: 1,
      projectionMismatchCount: 0,
      orphanActiveAuthorityCount: 0,
      readinessViolationCount: 0
    },
    postconditions: {
      fixedIndexCount: 6,
      fixedIndexesPassed: true,
      migrationPostconditionsPassed: true,
      tenantIsolationPassed: true
    },
    migrations: $migrations
  }' >"${RECEIPT_TEMP}"

mv -- "${RECEIPT_TEMP}" "${RECEIPT_OUTPUT}"
RECEIPT_TEMP=""
echo "Synthetic migration rehearsal passed; non-authoritative receipt written"
