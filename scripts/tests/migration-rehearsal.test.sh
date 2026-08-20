#!/usr/bin/env bash

# Focused contract and adversary tests for the synthetic migration rehearsal.
# Database adversaries run only when an explicitly acknowledged loopback admin
# URL is supplied (as it is in the dedicated GitHub Actions service job).

set -euo pipefail
umask 077

RECEIPT="${1:-}"
EXPECTED_COMMIT="${2:-}"
if [[ -z "${RECEIPT}" || ! "${EXPECTED_COMMIT}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Usage: $0 <valid-synthetic-receipt.json> <full-lowercase-candidate-sha>" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd -P)"
TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/workforce-migration-rehearsal-tests.XXXXXX")"
ACTIVE_DATABASE=""
ADMIN_URL="${MIGRATION_REHEARSAL_DATABASE_ADMIN_URL:-}"
TESTS_PASSED=0

cleanup() {
  local cleanup_status=$?
  set +e
  if [[ -n "${ACTIVE_DATABASE}" &&
    "${ACTIVE_DATABASE}" =~ ^workforce_rehearsal_test_[0-9_]+$ ]]; then
    dropdb --if-exists --force --maintenance-db="${ADMIN_URL}" \
      "${ACTIVE_DATABASE}" >/dev/null 2>&1
  fi
  if [[ -d "${TEMP_DIR}" &&
    "${TEMP_DIR}" == "${TMPDIR:-/tmp}/workforce-migration-rehearsal-tests."* ]]; then
    find "${TEMP_DIR}" -depth -delete
  fi
  exit "${cleanup_status}"
}
trap cleanup EXIT HUP INT TERM

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

pass() {
  TESTS_PASSED=$((TESTS_PASSED + 1))
}

expect_receipt_rejection() {
  local fixture=$1
  local description=$2
  if env WORKFORCE_REHEARSAL_TESTING=true \
    "${REPO_ROOT}/scripts/verify-ci-migration-rehearsal-receipt.sh" \
    "${fixture}" "${EXPECTED_COMMIT}" >/dev/null 2>&1; then
    fail "receipt verifier accepted ${description}"
  fi
  pass
}

env WORKFORCE_REHEARSAL_TESTING=true \
  "${REPO_ROOT}/scripts/verify-ci-migration-rehearsal-receipt.sh" \
  "${RECEIPT}" "${EXPECTED_COMMIT}" >/dev/null
pass

if ! jq -e '
  .additionalProperties == false
  and .properties.backupRestore.additionalProperties == false
  and .properties.identity.additionalProperties == false
  and .properties.postconditions.additionalProperties == false
  and .properties.migrations.items.additionalProperties == false
  and .properties.environment.const == "ci-synthetic"
  and .properties.authority.const == "non-authoritative"
  and .properties.migrations.minItems == 9
  and .properties.migrations.maxItems == 9
' >/dev/null "${REPO_ROOT}/docs/ops/ci-migration-rehearsal-receipt.schema.json"; then
  fail "CI receipt JSON Schema is not strict and non-authoritative"
fi
pass

if jq -e 'has("stagingRehearsalEvidenceHash") or has("productionApplyEvidenceHash")' \
  >/dev/null "${RECEIPT}"; then
  fail "synthetic receipt contains a staging or production evidence field"
fi
pass

jq '.environment = "staging"' "${RECEIPT}" >"${TEMP_DIR}/staging.json"
expect_receipt_rejection "${TEMP_DIR}/staging.json" "a staging environment claim"

jq '.unexpected = true' "${RECEIPT}" >"${TEMP_DIR}/unknown-field.json"
expect_receipt_rejection "${TEMP_DIR}/unknown-field.json" "an undeclared field"

jq '.migrations |= reverse' "${RECEIPT}" >"${TEMP_DIR}/wrong-order.json"
expect_receipt_rejection "${TEMP_DIR}/wrong-order.json" "reordered migrations"

jq '.migrations[0].sha256 = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"' \
  "${RECEIPT}" >"${TEMP_DIR}/wrong-digest.json"
expect_receipt_rejection "${TEMP_DIR}/wrong-digest.json" "a mismatched committed digest"

jq '.backupRestore.dataFingerprintAfter = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"' \
  "${RECEIPT}" >"${TEMP_DIR}/restore-mismatch.json"
expect_receipt_rejection "${TEMP_DIR}/restore-mismatch.json" "a backup/restore mismatch"

SOURCE_MODE="$(jq -er '.sourceMode' "${RECEIPT}")"
VECTOR_MODE="$(jq -er '.vectorMode' "${RECEIPT}")"
GUARD_OUTPUT="${TEMP_DIR}/guard-receipt.json"
if env \
  DATABASE_URL="postgresql://synthetic:synthetic@example.invalid:5432/workforce_rehearsal_guard" \
  WORKFORCE_MIGRATION_REHEARSAL_ACK=ci-synthetic-only \
  WORKFORCE_REHEARSAL_SOURCE_MODE="${SOURCE_MODE}" \
  WORKFORCE_REHEARSAL_VECTOR_MODE="${VECTOR_MODE}" \
  WORKFORCE_REHEARSAL_TESTING=true \
  "${REPO_ROOT}/scripts/rehearse-migration-candidate.sh" \
  "${EXPECTED_COMMIT}" "${GUARD_OUTPUT}" >/dev/null 2>&1; then
  fail "target guard accepted a remote PostgreSQL hostname"
fi
[[ ! -e "${GUARD_OUTPUT}" ]] || fail "remote target guard wrote a receipt"
pass

if env \
  DATABASE_URL="postgresql://synthetic:synthetic@127.0.0.1:5432/production" \
  WORKFORCE_MIGRATION_REHEARSAL_ACK=ci-synthetic-only \
  WORKFORCE_REHEARSAL_SOURCE_MODE="${SOURCE_MODE}" \
  WORKFORCE_REHEARSAL_VECTOR_MODE="${VECTOR_MODE}" \
  WORKFORCE_REHEARSAL_TESTING=true \
  "${REPO_ROOT}/scripts/rehearse-migration-candidate.sh" \
  "${EXPECTED_COMMIT}" "${GUARD_OUTPUT}" >/dev/null 2>&1; then
  fail "target guard accepted a non-rehearsal database name"
fi
[[ ! -e "${GUARD_OUTPUT}" ]] || fail "database-name target guard wrote a receipt"
pass

if [[ -z "${ADMIN_URL}" ]]; then
  echo "Migration rehearsal contract tests passed: ${TESTS_PASSED} (database adversaries skipped; no admin URL)"
  exit 0
fi
if [[ "${WORKFORCE_MIGRATION_REHEARSAL_TESTS_ACK:-}" != "ci-synthetic-only" ]]; then
  fail "database adversaries require WORKFORCE_MIGRATION_REHEARSAL_TESTS_ACK=ci-synthetic-only"
fi
for required_command in createdb dropdb node; do
  command -v "${required_command}" >/dev/null 2>&1 ||
    fail "database adversary command is unavailable: ${required_command}"
done

ADMIN_METADATA="$(DATABASE_URL_VALUE="${ADMIN_URL}" node <<'NODE'
const value = process.env.DATABASE_URL_VALUE;
let parsed;
try { parsed = new URL(value); } catch { process.exit(2); }
if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) process.exit(3);
if (parsed.search || parsed.hash) process.exit(4);
if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(parsed.hostname.toLowerCase())) process.exit(5);
if (decodeURIComponent(parsed.pathname.slice(1)) !== 'postgres') process.exit(6);
process.stdout.write('safe');
NODE
)" || fail "database adversary admin URL must be the local postgres maintenance database"
[[ "${ADMIN_METADATA}" == "safe" ]] || fail "database adversary admin URL validation failed"

SCENARIOS=(
  "artifact-duplicate"
  "reply-duplicate"
  "graph-run-duplicate"
  "identity-count-mismatch"
  "identity-cursor-after-cutoff"
  "incompatible-fixed-index"
  "backup-fingerprint-mismatch"
  "legacy-conversation-nonempty"
)
EXPECTED_ERRORS=(
  "OutreachArtifact idempotency preflight failed"
  "reply single-flight preflight failed"
  "GraphRun single-flight preflight failed"
  "Clerk identity inventory counts do not match"
  "Clerk identity lifecycle cursor is invalid or newer"
  "valid index OutreachArtifact_idempotency_uniq exists with an incompatible definition"
  "backup/restore fingerprint mismatch"
  "legacy Conversation compatibility failed: expected zero rows, found 1"
)

for index in "${!SCENARIOS[@]}"; do
  scenario="${SCENARIOS[$index]}"
  ACTIVE_DATABASE="workforce_rehearsal_test_$$_${index}"
  createdb --maintenance-db="${ADMIN_URL}" "${ACTIVE_DATABASE}"
  TARGET_URL="$(DATABASE_URL_VALUE="${ADMIN_URL}" TARGET_DATABASE="${ACTIVE_DATABASE}" node <<'NODE'
const parsed = new URL(process.env.DATABASE_URL_VALUE);
parsed.pathname = `/${process.env.TARGET_DATABASE}`;
process.stdout.write(parsed.toString());
NODE
)"
  scenario_receipt="${TEMP_DIR}/${scenario}.json"
  scenario_log="${TEMP_DIR}/${scenario}.log"
  if env \
    DATABASE_URL="${TARGET_URL}" \
    WORKFORCE_MIGRATION_REHEARSAL_ACK=ci-synthetic-only \
    WORKFORCE_REHEARSAL_SOURCE_MODE="${SOURCE_MODE}" \
    WORKFORCE_REHEARSAL_VECTOR_MODE="${VECTOR_MODE}" \
    WORKFORCE_REHEARSAL_TESTING=true \
    WORKFORCE_REHEARSAL_TEST_SCENARIO="${scenario}" \
    "${REPO_ROOT}/scripts/rehearse-migration-candidate.sh" \
    "${EXPECTED_COMMIT}" "${scenario_receipt}" >"${scenario_log}" 2>&1; then
    fail "${scenario} adversary unexpectedly passed"
  fi
  if ! grep -Fq -- "${EXPECTED_ERRORS[$index]}" "${scenario_log}"; then
    tail -n 30 "${scenario_log}" >&2
    fail "${scenario} failed for the wrong reason"
  fi
  [[ ! -e "${scenario_receipt}" ]] || fail "${scenario} emitted a passing receipt"
  dropdb --if-exists --force --maintenance-db="${ADMIN_URL}" "${ACTIVE_DATABASE}"
  ACTIVE_DATABASE=""
  pass
done

echo "Migration rehearsal tests passed: ${TESTS_PASSED}"
