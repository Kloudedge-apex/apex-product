#!/usr/bin/env bash

# Verify one final signed B4/B5/B6/B8 production-bootstrap receipt against its
# exact predecessor and the protected controller's exact-byte phase context.
# This verifier is read-only and grants no provider mutation authority.

set -euo pipefail

RECEIPT="${1:-}"
SIGNATURE="${2:-}"
ALLOWED_SIGNERS="${3:-}"
EXPECTED_BACKEND_COMMIT="${4:-}"
EXPECTED_CONSOLE_COMMIT="${5:-}"
EXPECTED_ATTEMPT_ID="${6:-}"
EXPECTED_KIND="${7:-}"
PREVIOUS_RECEIPT="${8:-}"
PHASE_CONTEXT="${9:-}"

TRUST_ROOT_PIN_PATH="docs/ops/production-migration-allowed-signers.sha256"
MAX_RECEIPT_BYTES=131072
MAX_CONTEXT_BYTES=131072
MAX_SIGNATURE_BYTES=16384
MAX_ALLOWED_SIGNERS_BYTES=65536

usage() {
  echo "Usage: $0 <receipt.json> <receipt.sig> <allowed-signers> <backend-commit> <console-commit> <32-hex-attempt-id> <production-schema-result|enum-aware-disabled-baseline|first-class-activation|bootstrap-complete> <previous-receipt.json> <controller-phase-context.json>" >&2
  exit 2
}

if [[ "${#}" -ne 9 ]] ||
  [[ -z "${RECEIPT}" || -z "${SIGNATURE}" || -z "${ALLOWED_SIGNERS}" ||
    -z "${PREVIOUS_RECEIPT}" || -z "${PHASE_CONTEXT}" ]] ||
  [[ ! "${EXPECTED_BACKEND_COMMIT}" =~ ^[0-9a-f]{40}$ ]] ||
  [[ ! "${EXPECTED_CONSOLE_COMMIT}" =~ ^[0-9a-f]{40}$ ]] ||
  [[ ! "${EXPECTED_ATTEMPT_ID}" =~ ^[0-9a-f]{32}$ ]]; then
  usage
fi
case "${EXPECTED_KIND}" in
  production-schema-result | enum-aware-disabled-baseline | first-class-activation | bootstrap-complete) ;;
  *) usage ;;
esac

for required_command in date git jq node openssl ssh-keygen wc; do
  if ! command -v "${required_command}" >/dev/null 2>&1; then
    echo "ERROR: required command is unavailable: ${required_command}" >&2
    exit 1
  fi
done

bounded_regular_file() {
  local path=$1
  local maximum=$2
  local label=$3
  local size
  if [[ ! -f "${path}" || -L "${path}" ]]; then
    echo "ERROR: ${label} must be a regular non-symlink file: ${path}" >&2
    return 1
  fi
  size="$(wc -c <"${path}" | tr -d '[:space:]')"
  if [[ ! "${size}" =~ ^[0-9]+$ ]] || ((size < 1 || size > maximum)); then
    echo "ERROR: ${label} size is outside the permitted range" >&2
    return 1
  fi
}

bounded_regular_file "${RECEIPT}" "${MAX_RECEIPT_BYTES}" "phase receipt"
bounded_regular_file "${SIGNATURE}" "${MAX_SIGNATURE_BYTES}" "phase receipt signature"
bounded_regular_file "${ALLOWED_SIGNERS}" "${MAX_ALLOWED_SIGNERS_BYTES}" "allowed-signers trust root"
bounded_regular_file "${PREVIOUS_RECEIPT}" "${MAX_RECEIPT_BYTES}" "previous receipt"
bounded_regular_file "${PHASE_CONTEXT}" "${MAX_CONTEXT_BYTES}" "controller phase context"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
CONTRACT_MODULE="${SCRIPT_DIR}/production-bootstrap-phase-receipt-contracts.mjs"
if [[ ! -f "${CONTRACT_MODULE}" || -L "${CONTRACT_MODULE}" ]]; then
  echo "ERROR: final phase receipt contract module is unavailable" >&2
  exit 1
fi
if ! GIT_NO_REPLACE_OBJECTS=1 git -C "${REPO_ROOT}" \
  cat-file -e "${EXPECTED_BACKEND_COMMIT}^{commit}" 2>/dev/null; then
  echo "ERROR: expected backend identity is not a committed Git object" >&2
  exit 1
fi

read_reviewed_source() {
  local path=$1
  GIT_NO_REPLACE_OBJECTS=1 git -C "${REPO_ROOT}" show "${EXPECTED_BACKEND_COMMIT}:${path}"
}

if ! TRUST_ROOT_PIN_SOURCE="$(read_reviewed_source "${TRUST_ROOT_PIN_PATH}")"; then
  echo "ERROR: reviewed bootstrap approver trust-root pin is missing from ${EXPECTED_BACKEND_COMMIT}" >&2
  exit 1
fi
if ! PINNED_ALLOWED_SIGNERS_SHA256="$(printf '%s\n' "${TRUST_ROOT_PIN_SOURCE}" | awk '
  /^[[:space:]]*#/ || !NF { next }
  NF != 1 || found { exit 2 }
  { print $1; found = 1 }
  END { if (!found) exit 2 }
')" || [[ ! "${PINNED_ALLOWED_SIGNERS_SHA256}" =~ ^[0-9a-f]{64}$ ]]; then
  echo "ERROR: production bootstrap approver trust root is unconfigured or invalid" >&2
  exit 1
fi

umask 077
EVIDENCE_TEMP="$(mktemp -d "${TMPDIR:-/tmp}/workforce-os-bootstrap-phase.XXXXXX")"
cleanup_evidence() {
  local status=$?
  trap - EXIT HUP INT TERM
  set +e
  rm -f -- "${EVIDENCE_TEMP}/receipt.json" "${EVIDENCE_TEMP}/receipt.sig" \
    "${EVIDENCE_TEMP}/allowed-signers" "${EVIDENCE_TEMP}/previous-receipt.json" \
    "${EVIDENCE_TEMP}/phase-context.json"
  rmdir -- "${EVIDENCE_TEMP}"
  exit "${status}"
}
trap cleanup_evidence EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

RECEIPT_COPY="${EVIDENCE_TEMP}/receipt.json"
SIGNATURE_COPY="${EVIDENCE_TEMP}/receipt.sig"
TRUST_ROOT_COPY="${EVIDENCE_TEMP}/allowed-signers"
PREVIOUS_COPY="${EVIDENCE_TEMP}/previous-receipt.json"
CONTEXT_COPY="${EVIDENCE_TEMP}/phase-context.json"
cp -- "${RECEIPT}" "${RECEIPT_COPY}"
cp -- "${SIGNATURE}" "${SIGNATURE_COPY}"
cp -- "${ALLOWED_SIGNERS}" "${TRUST_ROOT_COPY}"
cp -- "${PREVIOUS_RECEIPT}" "${PREVIOUS_COPY}"
cp -- "${PHASE_CONTEXT}" "${CONTEXT_COPY}"
chmod 600 "${RECEIPT_COPY}" "${SIGNATURE_COPY}" "${TRUST_ROOT_COPY}" \
  "${PREVIOUS_COPY}" "${CONTEXT_COPY}"

ACTUAL_ALLOWED_SIGNERS_SHA256="$(openssl dgst -sha256 -r "${TRUST_ROOT_COPY}" | awk '{ print $1 }')"
if [[ "${ACTUAL_ALLOWED_SIGNERS_SHA256}" != "${PINNED_ALLOWED_SIGNERS_SHA256}" ]]; then
  echo "ERROR: supplied bootstrap allowed-signers bytes do not match reviewed source" >&2
  exit 1
fi

verify_contract_at() {
  local epoch=$1
  node "${CONTRACT_MODULE}" verify \
    "${RECEIPT_COPY}" "${PREVIOUS_COPY}" "${CONTEXT_COPY}" \
    "${EXPECTED_BACKEND_COMMIT}" "${EXPECTED_CONSOLE_COMMIT}" \
    "${EXPECTED_ATTEMPT_ID}" "${EXPECTED_KIND}" "${epoch}"
}

CURRENT_EPOCH="$(date -u +%s)"
if ! CONTRACT_SUMMARY="$(verify_contract_at "${CURRENT_EPOCH}")"; then
  echo "ERROR: final bootstrap phase receipt or controller context is invalid" >&2
  exit 1
fi
if ! APPROVER="$(jq -er '.approver' <<<"${CONTRACT_SUMMARY}")" ||
  ! SIGNATURE_NAMESPACE="$(jq -er '.signatureNamespace' <<<"${CONTRACT_SUMMARY}")"; then
  echo "ERROR: final phase contract summary is invalid" >&2
  exit 1
fi

if ! ssh-keygen -Y verify \
  -f "${TRUST_ROOT_COPY}" \
  -I "${APPROVER}" \
  -n "${SIGNATURE_NAMESPACE}" \
  -s "${SIGNATURE_COPY}" \
  <"${RECEIPT_COPY}" >/dev/null; then
  echo "ERROR: ${EXPECTED_KIND} signature is invalid for trusted approver ${APPROVER}" >&2
  exit 1
fi

# B4 is also bound directly to the nine bytes in the exact expected commit;
# hard-coded source pins in the schema/module are defense in depth, not a
# substitute for reading the reviewed commit.
if [[ "${EXPECTED_KIND}" == "production-schema-result" ]]; then
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
  for index in "${!MIGRATIONS[@]}"; do
    path="${MIGRATIONS[$index]}"
    if ! digest="$(read_reviewed_source "${path}" | openssl dgst -sha256 -r | awk '{ print $1 }')" ||
      [[ ! "${digest}" =~ ^[0-9a-f]{64}$ ]]; then
      echo "ERROR: required bootstrap migration is missing from ${EXPECTED_BACKEND_COMMIT}: ${path}" >&2
      exit 1
    fi
    if ! jq -e --argjson index "${index}" --arg path "${path}" --arg hash "sha256:${digest}" '
      .evidence.migrationExecution[$index].path == $path
      and .evidence.migrationExecution[$index].sha256 == $hash
    ' "${RECEIPT_COPY}" >/dev/null; then
      echo "ERROR: signed schema-result migration ${index} does not match exact commit source" >&2
      exit 1
    fi
  done
fi

# Signature and committed-source verification can cross the expiry boundary.
FINAL_CURRENT_EPOCH="$(date -u +%s)"
if ! verify_contract_at "${FINAL_CURRENT_EPOCH}" >/dev/null; then
  echo "ERROR: final bootstrap phase receipt expired before verification completed" >&2
  exit 1
fi

RECEIPT_SHA256="$(jq -er '.receiptSha256' <<<"${CONTRACT_SUMMARY}")"
echo "Signed ${EXPECTED_KIND} receipt verified for backend ${EXPECTED_BACKEND_COMMIT}, console ${EXPECTED_CONSOLE_COMMIT}, attempt ${EXPECTED_ATTEMPT_ID} (approver ${APPROVER}; ${RECEIPT_SHA256})"
