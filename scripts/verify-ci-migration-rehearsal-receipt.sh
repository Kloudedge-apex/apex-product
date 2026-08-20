#!/usr/bin/env bash

# Validate a sanitized synthetic CI rehearsal receipt against exact committed
# migration bytes. This verifier deliberately accepts no production fields,
# signatures, environment identifiers, or staging evidence claims.

set -euo pipefail

RECEIPT="${1:-}"
EXPECTED_COMMIT="${2:-}"
BASELINE_COMMIT="324f831f31ca903f851b3e697ee94cc25af04217"
MIGRATIONS=(
  "docs/migrations/2026-08-13_clerk-identity-lifecycle-expand.sql"
  "docs/migrations/2026-06-01_outreach-artifact-unique.sql"
  "docs/migrations/2026-08-12_conversation-store-expand.sql"
  "docs/migrations/2026-08-12_outreach-delivery-unknown-expand.sql"
  "docs/migrations/2026-08-13_outreach-artifact-failed-expand.sql"
  "docs/migrations/2026-08-12_conversation-reply-single-flight-expand.sql"
  "docs/migrations/2026-08-12_graph-run-activity-expand.sql"
  "docs/migrations/2026-08-12_graph-run-lifecycle-expand.sql"
  "docs/migrations/2026-08-20_icp-exclusion-domains-expand.sql"
)
FIXTURE_PATH="scripts/fixtures/migration-rehearsal-data.sql"
RECONCILIATION_PATH="scripts/fixtures/migration-rehearsal-identity-reconciliation.sql"
POSTCONDITION_PATH="scripts/fixtures/migration-rehearsal-postconditions.sql"

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

if [[ -z "${RECEIPT}" || ! "${EXPECTED_COMMIT}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Usage: $0 <receipt.json> <full-lowercase-candidate-sha>" >&2
  exit 2
fi
[[ -f "${RECEIPT}" && ! -L "${RECEIPT}" ]] ||
  fail "receipt must be a regular non-symlink file"
for required_command in git jq openssl; do
  command -v "${required_command}" >/dev/null 2>&1 ||
    fail "required command is unavailable: ${required_command}"
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
if ! GIT_NO_REPLACE_OBJECTS=1 git -C "${REPO_ROOT}" cat-file -e \
  "${EXPECTED_COMMIT}^{commit}" 2>/dev/null; then
  fail "expected candidate commit is not available locally"
fi

if ! jq -e \
  --arg commit "${EXPECTED_COMMIT}" \
  --arg baseline "${BASELINE_COMMIT}" '
  (keys == [
    "authority",
    "backupRestore",
    "baselineCommit",
    "baselineSchemaSha256",
    "candidateCommit",
    "environment",
    "fixtureSha256",
    "identity",
    "migrations",
    "postconditionFixtureSha256",
    "postconditions",
    "postgresMajor",
    "reconciliationFixtureSha256",
    "schemaVersion",
    "sourceMode",
    "status",
    "tenantFixtureCount",
    "vectorMode",
    "verifiedAt"
  ])
  and .schemaVersion == 1
  and .environment == "ci-synthetic"
  and .authority == "non-authoritative"
  and .status == "passed"
  and (.sourceMode == "committed-candidate" or .sourceMode == "local-working-tree-test")
  and .candidateCommit == $commit
  and .baselineCommit == $baseline
  and (.baselineSchemaSha256 | type == "string" and test("^sha256:[0-9a-f]{64}$"))
  and (.fixtureSha256 | type == "string" and test("^sha256:[0-9a-f]{64}$"))
  and (.reconciliationFixtureSha256 | type == "string" and test("^sha256:[0-9a-f]{64}$"))
  and (.postconditionFixtureSha256 | type == "string" and test("^sha256:[0-9a-f]{64}$"))
  and (.verifiedAt | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))
  and (.postgresMajor | type == "number" and floor == . and . >= 14)
  and (.vectorMode == "native" or .vectorMode == "synthetic-array-stub")
  and .tenantFixtureCount == 2
  and (.backupRestore | keys == [
    "archiveFormat",
    "dataFingerprintAfter",
    "dataFingerprintBefore",
    "matched",
    "schemaFingerprintAfter",
    "schemaFingerprintBefore"
  ])
  and .backupRestore.archiveFormat == "postgres-custom"
  and .backupRestore.matched == true
  and (.backupRestore.schemaFingerprintBefore | test("^sha256:[0-9a-f]{64}$"))
  and (.backupRestore.schemaFingerprintAfter | test("^sha256:[0-9a-f]{64}$"))
  and (.backupRestore.dataFingerprintBefore | test("^sha256:[0-9a-f]{64}$"))
  and (.backupRestore.dataFingerprintAfter | test("^sha256:[0-9a-f]{64}$"))
  and .backupRestore.schemaFingerprintBefore == .backupRestore.schemaFingerprintAfter
  and .backupRestore.dataFingerprintBefore == .backupRestore.dataFingerprintAfter
  and (.identity | keys == [
    "cutoverReady",
    "expectedActiveMembershipCount",
    "expectedActiveOrganizationCount",
    "expectedActiveUserCount",
    "orphanActiveAuthorityCount",
    "projectionMismatchCount",
    "readinessViolationCount"
  ])
  and .identity == {
    cutoverReady: true,
    expectedActiveOrganizationCount: 1,
    expectedActiveMembershipCount: 1,
    expectedActiveUserCount: 1,
    projectionMismatchCount: 0,
    orphanActiveAuthorityCount: 0,
    readinessViolationCount: 0
  }
  and (.postconditions | keys == [
    "fixedIndexCount",
    "fixedIndexesPassed",
    "migrationPostconditionsPassed",
    "tenantIsolationPassed"
  ])
  and .postconditions == {
    fixedIndexCount: 6,
    fixedIndexesPassed: true,
    migrationPostconditionsPassed: true,
    tenantIsolationPassed: true
  }
  and (.migrations | type == "array" and length == 9)
  and all(.migrations[];
    (keys == ["applied", "path", "postconditionsPassed", "sha256"])
    and .applied == true
    and .postconditionsPassed == true
    and (.path | type == "string" and length > 0)
    and (.sha256 | type == "string" and test("^sha256:[0-9a-f]{64}$"))
  )
  ' >/dev/null "${RECEIPT}"; then
  fail "synthetic CI migration receipt is incomplete, authoritative, or structurally invalid"
fi

SOURCE_MODE="$(jq -er '.sourceMode' "${RECEIPT}")"
VECTOR_MODE="$(jq -er '.vectorMode' "${RECEIPT}")"
POSTGRES_MAJOR="$(jq -er '.postgresMajor' "${RECEIPT}")"
if [[ "${GITHUB_ACTIONS:-false}" == "true" ]]; then
  [[ "${SOURCE_MODE}" == "committed-candidate" ]] ||
    fail "GitHub CI receipt must use committed candidate fixtures"
  [[ "${VECTOR_MODE}" == "native" && "${POSTGRES_MAJOR}" -ge 16 ]] ||
    fail "GitHub CI receipt must use PostgreSQL 16+ with native pgvector"
elif [[ "${SOURCE_MODE}" == "local-working-tree-test" &&
  "${WORKFORCE_REHEARSAL_TESTING:-false}" != "true" ]]; then
  fail "local working-tree receipt requires explicit test mode"
fi

committed_digest() {
  local commit=$1
  local path=$2
  local mode
  mode="$(GIT_NO_REPLACE_OBJECTS=1 git -C "${REPO_ROOT}" ls-tree \
    "${commit}" -- "${path}" | awk 'NR == 1 {print $1}')"
  [[ "${mode}" == "100644" || "${mode}" == "100755" ]] || return 1
  GIT_NO_REPLACE_OBJECTS=1 git -C "${REPO_ROOT}" show "${commit}:${path}" | \
    openssl dgst -sha256 -r | awk '{print "sha256:" $1}'
}

local_digest() {
  local path=$1
  local source="${REPO_ROOT}/${path}"
  [[ -f "${source}" && ! -L "${source}" ]] || return 1
  openssl dgst -sha256 -r "${source}" | awk '{print "sha256:" $1}'
}

BASELINE_SCHEMA_SHA256="$(committed_digest \
  "${BASELINE_COMMIT}" "packages/db/prisma/schema.prisma")" ||
  fail "reviewed baseline schema is unavailable"
[[ "$(jq -er '.baselineSchemaSha256' "${RECEIPT}")" == "${BASELINE_SCHEMA_SHA256}" ]] ||
  fail "baseline schema digest does not match reviewed source"

if [[ "${SOURCE_MODE}" == "committed-candidate" ]]; then
  FIXTURE_SHA256="$(committed_digest "${EXPECTED_COMMIT}" "${FIXTURE_PATH}")" ||
    fail "committed synthetic fixture is unavailable"
  RECONCILIATION_SHA256="$(committed_digest "${EXPECTED_COMMIT}" "${RECONCILIATION_PATH}")" ||
    fail "committed reconciliation fixture is unavailable"
  POSTCONDITION_SHA256="$(committed_digest "${EXPECTED_COMMIT}" "${POSTCONDITION_PATH}")" ||
    fail "committed postcondition fixture is unavailable"
else
  FIXTURE_SHA256="$(local_digest "${FIXTURE_PATH}")" || fail "local synthetic fixture is unavailable"
  RECONCILIATION_SHA256="$(local_digest "${RECONCILIATION_PATH}")" ||
    fail "local reconciliation fixture is unavailable"
  POSTCONDITION_SHA256="$(local_digest "${POSTCONDITION_PATH}")" ||
    fail "local postcondition fixture is unavailable"
fi

[[ "$(jq -er '.fixtureSha256' "${RECEIPT}")" == "${FIXTURE_SHA256}" ]] ||
  fail "synthetic fixture digest mismatch"
[[ "$(jq -er '.reconciliationFixtureSha256' "${RECEIPT}")" == "${RECONCILIATION_SHA256}" ]] ||
  fail "identity reconciliation fixture digest mismatch"
[[ "$(jq -er '.postconditionFixtureSha256' "${RECEIPT}")" == "${POSTCONDITION_SHA256}" ]] ||
  fail "postcondition fixture digest mismatch"

for index in "${!MIGRATIONS[@]}"; do
  if [[ "${SOURCE_MODE}" == "committed-candidate" ]]; then
    source_hash="$(committed_digest "${EXPECTED_COMMIT}" "${MIGRATIONS[$index]}")" ||
      fail "required committed migration is unavailable: ${MIGRATIONS[$index]}"
  else
    source_hash="$(local_digest "${MIGRATIONS[$index]}")" ||
      fail "required local migration is unavailable: ${MIGRATIONS[$index]}"
  fi
  if ! jq -e \
    --argjson index "${index}" \
    --arg path "${MIGRATIONS[$index]}" \
    --arg sha256 "${source_hash}" '
      .migrations[$index].path == $path
      and .migrations[$index].sha256 == $sha256
    ' >/dev/null "${RECEIPT}"; then
    fail "migration receipt order or digest mismatch at index ${index}"
  fi
done

echo "Synthetic CI migration receipt verified for ${EXPECTED_COMMIT} (non-authoritative; nine reviewed migrations)"
