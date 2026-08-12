#!/usr/bin/env bash

# Validate the sanitized production-schema receipt required before a guarded
# SDR image rollout. The receipt records hashes and boolean postconditions, not
# credentials, SQL output, customer rows, or production payloads.

set -euo pipefail

RECEIPT="${1:-}"
SIGNATURE="${2:-}"
ALLOWED_SIGNERS="${3:-}"
EXPECTED_COMMIT="${4:-}"

if [[ -z "${RECEIPT}" || -z "${SIGNATURE}" || -z "${ALLOWED_SIGNERS}" ||
  ! "${EXPECTED_COMMIT}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Usage: $0 <receipt.json> <receipt.sig> <allowed-signers> <full-lowercase-git-sha>" >&2
  exit 2
fi
for REQUIRED_FILE in "${RECEIPT}" "${SIGNATURE}" "${ALLOWED_SIGNERS}"; do
  if [[ ! -f "${REQUIRED_FILE}" ]]; then
    echo "ERROR: required release-evidence file is not a regular file: ${REQUIRED_FILE}" >&2
    exit 1
  fi
done
REQUIRED_COMMANDS=(jq openssl ssh-keygen)
if [[ "${WORKFORCE_RELEASE_SNAPSHOT_ACTIVE:-}" != "true" ]]; then
  REQUIRED_COMMANDS+=(git)
fi
for REQUIRED_COMMAND in "${REQUIRED_COMMANDS[@]}"; do
  if ! command -v "${REQUIRED_COMMAND}" >/dev/null 2>&1; then
    echo "ERROR: required command is unavailable: ${REQUIRED_COMMAND}" >&2
    exit 1
  fi
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SNAPSHOT_SOURCE_MODE="false"
if [[ "${WORKFORCE_RELEASE_SNAPSHOT_ACTIVE:-}" == "true" ]]; then
  if [[ "${EXPECTED_COMMIT}" != "${WORKFORCE_RELEASE_SOURCE_COMMIT:-}" ]]; then
    echo "ERROR: migration receipt commit does not match the exact-commit release snapshot" >&2
    exit 1
  fi
  if [[ -z "${WORKFORCE_RELEASE_SNAPSHOT_ROOT:-}" ||
    "$(cd "${WORKFORCE_RELEASE_SNAPSHOT_ROOT}" && pwd -P)" != "$(cd "${REPO_ROOT}" && pwd -P)" ]]; then
    echo "ERROR: migration verifier is not running from the admitted release snapshot" >&2
    exit 1
  fi
  SNAPSHOT_SOURCE_MODE="true"
fi

read_reviewed_source() {
  local path=$1
  local candidate current component
  local -a path_components
  if [[ "${SNAPSHOT_SOURCE_MODE}" != "true" ]]; then
    GIT_NO_REPLACE_OBJECTS=1 git -C "${REPO_ROOT}" show "${EXPECTED_COMMIT}:${path}"
    return
  fi

  candidate="${REPO_ROOT}/${path}"
  current="${REPO_ROOT}"
  IFS='/' read -r -a path_components <<<"${path}"
  for component in "${path_components[@]}"; do
    current="${current}/${component}"
    if [[ -L "${current}" ]]; then
      echo "ERROR: reviewed snapshot source must not traverse a symlink: ${path}" >&2
      return 1
    fi
  done
  if [[ ! -f "${candidate}" ]]; then
    echo "ERROR: reviewed snapshot source is not a regular file: ${path}" >&2
    return 1
  fi
  command cat -- "${candidate}"
}

TRUST_ROOT_PIN_PATH="docs/ops/production-migration-allowed-signers.sha256"
if ! TRUST_ROOT_PIN_SOURCE="$(read_reviewed_source "${TRUST_ROOT_PIN_PATH}")"; then
  echo "ERROR: reviewed migration approver trust-root pin is missing from ${EXPECTED_COMMIT}" >&2
  exit 1
fi
PINNED_ALLOWED_SIGNERS_SHA256="$(awk '!/^#/ && NF { print $1; exit }' \
  <<<"${TRUST_ROOT_PIN_SOURCE}")"
if [[ ! "${PINNED_ALLOWED_SIGNERS_SHA256}" =~ ^[0-9a-f]{64}$ ]]; then
  echo "ERROR: production migration approver trust root is not configured in reviewed source" >&2
  exit 1
fi

# Hash and verify one private copy so a caller cannot swap the allowed-signers
# file between the trust-root comparison and ssh-keygen verification.
TRUST_ROOT_TEMP="$(mktemp -d "${TMPDIR:-/tmp}/workforce-os-trust-root.XXXXXX")"
cleanup_trust_root() {
  if [[ -n "${TRUST_ROOT_TEMP:-}" && -d "${TRUST_ROOT_TEMP}" ]]; then
    rm -rf -- "${TRUST_ROOT_TEMP}"
  fi
}
trap cleanup_trust_root EXIT
TRUST_ROOT_COPY="${TRUST_ROOT_TEMP}/allowed-signers"
RECEIPT_COPY="${TRUST_ROOT_TEMP}/receipt.json"
SIGNATURE_COPY="${TRUST_ROOT_TEMP}/receipt.sig"
cp -- "${ALLOWED_SIGNERS}" "${TRUST_ROOT_COPY}"
cp -- "${RECEIPT}" "${RECEIPT_COPY}"
cp -- "${SIGNATURE}" "${SIGNATURE_COPY}"
chmod 600 "${TRUST_ROOT_COPY}" "${RECEIPT_COPY}" "${SIGNATURE_COPY}"
ACTUAL_ALLOWED_SIGNERS_SHA256="$(openssl dgst -sha256 -r "${TRUST_ROOT_COPY}" | awk '{ print $1 }')"
if [[ "${ACTUAL_ALLOWED_SIGNERS_SHA256}" != "${PINNED_ALLOWED_SIGNERS_SHA256}" ]]; then
  echo "ERROR: supplied migration approver trust root does not match reviewed source" >&2
  exit 1
fi

MIGRATIONS=(
  "docs/migrations/2026-06-01_outreach-artifact-unique.sql"
  "docs/migrations/2026-08-12_conversation-store-expand.sql"
  "docs/migrations/2026-08-12_outreach-delivery-unknown-expand.sql"
  "docs/migrations/2026-08-12_conversation-reply-single-flight-expand.sql"
  "docs/migrations/2026-08-12_graph-run-activity-expand.sql"
  "docs/migrations/2026-08-12_graph-run-lifecycle-expand.sql"
)
WRITER_PAUSE=("observed" "not-required" "not-required" "observed" "not-required" "observed")

if ! jq -e --arg commit "${EXPECTED_COMMIT}" '
  (keys == [
    "approver",
    "candidateCommit",
    "changeTicket",
    "databaseIdentityHash",
    "environment",
    "migrations",
    "operator",
    "productionApplyEvidenceHash",
    "rollbackRehearsalEvidenceHash",
    "schemaVersion",
    "stagingRehearsalEvidenceHash",
    "status",
    "verifiedAt"
  ])
  and .schemaVersion == 1
  and .environment == "production"
  and .candidateCommit == $commit
  and .status == "applied-and-verified"
  and (.verifiedAt | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))
  and (.operator | type == "string" and length > 0)
  and (.approver | type == "string" and test("^[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}$"))
  and .operator != .approver
  and (.changeTicket | type == "string" and length > 0)
  and (.databaseIdentityHash | type == "string" and test("^sha256:[0-9a-f]{64}$"))
  and (.stagingRehearsalEvidenceHash | type == "string" and test("^sha256:[0-9a-f]{64}$"))
  and (.productionApplyEvidenceHash | type == "string" and test("^sha256:[0-9a-f]{64}$"))
  and (.rollbackRehearsalEvidenceHash | type == "string" and test("^sha256:[0-9a-f]{64}$"))
  and (.migrations | type == "array" and length == 6)
' >/dev/null "${RECEIPT_COPY}"; then
  echo "ERROR: migration receipt metadata is incomplete or invalid" >&2
  exit 1
fi

APPROVER="$(jq -r '.approver' "${RECEIPT_COPY}")"
if ! ssh-keygen -Y verify \
  -f "${TRUST_ROOT_COPY}" \
  -I "${APPROVER}" \
  -n workforce-os-migration-receipt \
  -s "${SIGNATURE_COPY}" \
  <"${RECEIPT_COPY}" >/dev/null; then
  echo "ERROR: migration receipt signature is not valid for trusted approver ${APPROVER}" >&2
  exit 1
fi

for index in "${!MIGRATIONS[@]}"; do
  path="${MIGRATIONS[$index]}"
  pause="${WRITER_PAUSE[$index]}"
  if ! source_digest="$(read_reviewed_source "${path}" | \
    openssl dgst -sha256 -r | awk '{ print $1 }')"; then
    echo "ERROR: required migration is missing from ${EXPECTED_COMMIT}: ${path}" >&2
    exit 1
  fi
  if [[ ! "${source_digest}" =~ ^[0-9a-f]{64}$ ]]; then
    echo "ERROR: could not hash committed migration ${path}" >&2
    exit 1
  fi
  source_hash="sha256:${source_digest}"

  if ! jq -e \
    --argjson index "${index}" \
    --arg path "${path}" \
    --arg hash "${source_hash}" \
    --arg pause "${pause}" '
      .migrations[$index]
      | (keys == [
          "applied",
          "duplicateInventoryHash",
          "path",
          "postconditionEvidenceHash",
          "postconditionsPassed",
          "preflightPassed",
          "sha256",
          "writerPause"
        ])
      and .path == $path
      and .sha256 == $hash
      and .preflightPassed == true
      and .applied == true
      and .postconditionsPassed == true
      and .writerPause == $pause
      and (.duplicateInventoryHash | type == "string" and test("^sha256:[0-9a-f]{64}$"))
      and (.postconditionEvidenceHash | type == "string" and test("^sha256:[0-9a-f]{64}$"))
    ' >/dev/null "${RECEIPT_COPY}"; then
    echo "ERROR: migration receipt entry ${index} does not match ${path}" >&2
    exit 1
  fi
done

echo "Signed production migration receipt verified for ${EXPECTED_COMMIT} (approver ${APPROVER}; 6 ordered migrations)"
