#!/usr/bin/env bash

# Validate the sanitized production-schema receipt required before a guarded
# SDR image rollout. The receipt records hashes and boolean postconditions, not
# credentials, SQL output, customer rows, or production payloads.

set -euo pipefail

RECEIPT="${1:-}"
SIGNATURE="${2:-}"
ALLOWED_SIGNERS="${3:-}"
EXPECTED_COMMIT="${4:-}"
EXPECTED_API_IMAGE="${5:-}"
EXPECTED_API_REVISION="${6:-}"
EXPECTED_WORKER_IMAGE="${7:-}"
EXPECTED_WORKER_REVISION="${8:-}"
EXPECTED_CONSOLE_IMAGE="${9:-}"
EXPECTED_CONSOLE_REVISION="${10:-}"
EXPECTED_DELIVERY_UNKNOWN_WRITE_MODE="${11:-}"

DELIVERY_UNKNOWN_COMPATIBILITY_EPOCH="outreach-delivery-unknown-v1"
ROLLBACK_BASELINE_COMPATIBILITY_ATTESTATION="enum-aware-api-worker-console-baseline-v1"
DELIVERY_UNKNOWN_DISABLED_ATTESTATION="delivery-unknown-writes-disabled-v1"
DELIVERY_UNKNOWN_FIRST_CLASS_ATTESTATION="delivery-unknown-readers-drained-rollback-baselines-verified-v1"
RECEIPT_MAX_LIFETIME_SECONDS=900
RECEIPT_FUTURE_SKEW_SECONDS=60
SAME_ATTEMPT_ROLLBACK="${WORKFORCE_RELEASE_SAME_ATTEMPT_ROLLBACK:-false}"

if [[ "${#}" -ne 4 && "${#}" -ne 11 ]]; then
  echo "Usage: $0 <receipt.json> <receipt.sig> <allowed-signers> <full-lowercase-git-sha> [<api-digest-image> <api-revision> <worker-digest-image> <worker-revision> <console-digest-image> <console-revision> <disabled|first-class>]" >&2
  exit 2
fi
if [[ -z "${RECEIPT}" || -z "${SIGNATURE}" || -z "${ALLOWED_SIGNERS}" ||
  ! "${EXPECTED_COMMIT}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Usage: $0 <receipt.json> <receipt.sig> <allowed-signers> <full-lowercase-git-sha> [<api-digest-image> <api-revision> <worker-digest-image> <worker-revision> <console-digest-image> <console-revision> <disabled|first-class>]" >&2
  exit 2
fi
if [[ "${#}" -eq 11 ]]; then
  if [[ ! "${EXPECTED_API_IMAGE}" =~ ^workforceosprodacr\.azurecr\.io/apex-api@sha256:[0-9a-f]{64}$ ]] ||
    [[ ! "${EXPECTED_WORKER_IMAGE}" =~ ^workforceosprodacr\.azurecr\.io/apex-api@sha256:[0-9a-f]{64}$ ]] ||
    [[ ! "${EXPECTED_CONSOLE_IMAGE}" =~ ^workforceosprodacr\.azurecr\.io/workforceos-fe@sha256:[0-9a-f]{64}$ ]] ||
    [[ ! "${EXPECTED_API_REVISION}" =~ ^apex-gtm-api--[a-z0-9][a-z0-9-]*$ ]] ||
    [[ ! "${EXPECTED_WORKER_REVISION}" =~ ^apex-gtm-worker--[a-z0-9][a-z0-9-]*$ ]] ||
    [[ ! "${EXPECTED_CONSOLE_REVISION}" =~ ^nikxius-web--[a-z0-9][a-z0-9-]*$ ]] ||
    [[ "${EXPECTED_DELIVERY_UNKNOWN_WRITE_MODE}" != "disabled" &&
      "${EXPECTED_DELIVERY_UNKNOWN_WRITE_MODE}" != "first-class" ]]; then
    echo "ERROR: expected rollback baseline arguments are not canonical production identities" >&2
    exit 2
  fi
fi
if [[ "${SAME_ATTEMPT_ROLLBACK}" != "false" && "${SAME_ATTEMPT_ROLLBACK}" != "true" ]]; then
  echo "ERROR: invalid same-attempt rollback freshness mode" >&2
  exit 2
fi
if [[ "${SAME_ATTEMPT_ROLLBACK}" == "true" ]]; then
  if [[ "${#}" -ne 11 || "${WORKFORCE_RELEASE_SNAPSHOT_ACTIVE:-}" != "true" ||
    -z "${WORKFORCE_RELEASE_RUNTIME_STATE_DIR:-}" ]]; then
    echo "ERROR: freshness bypass is confined to an exact-identity same-attempt rollback" >&2
    exit 1
  fi
  RUNTIME_STATE_REAL="$(cd "${WORKFORCE_RELEASE_RUNTIME_STATE_DIR}" 2>/dev/null && pwd -P)" || {
    echo "ERROR: same-attempt runtime state directory is unavailable" >&2
    exit 1
  }
  RECEIPT_REAL="$(cd "$(dirname "${RECEIPT}")" 2>/dev/null && printf '%s/%s\n' "$(pwd -P)" "$(basename "${RECEIPT}")")" || {
    echo "ERROR: same-attempt receipt path is unavailable" >&2
    exit 1
  }
  if [[ "${RECEIPT_REAL}" != "${RUNTIME_STATE_REAL}/migration-receipt.json" ]]; then
    echo "ERROR: same-attempt rollback must use the private admitted receipt snapshot" >&2
    exit 1
  fi
fi
for REQUIRED_FILE in "${RECEIPT}" "${SIGNATURE}" "${ALLOWED_SIGNERS}"; do
  if [[ ! -f "${REQUIRED_FILE}" ]]; then
    echo "ERROR: required release-evidence file is not a regular file: ${REQUIRED_FILE}" >&2
    exit 1
  fi
done
REQUIRED_COMMANDS=(date jq openssl ssh-keygen)
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
  "docs/migrations/2026-08-13_clerk-identity-lifecycle-expand.sql"
  "docs/migrations/2026-06-01_outreach-artifact-unique.sql"
  "docs/migrations/2026-08-12_conversation-store-expand.sql"
  "docs/migrations/2026-08-12_outreach-delivery-unknown-expand.sql"
  "docs/migrations/2026-08-13_outreach-artifact-failed-expand.sql"
  "docs/migrations/2026-08-12_conversation-reply-single-flight-expand.sql"
  "docs/migrations/2026-08-12_graph-run-activity-expand.sql"
  "docs/migrations/2026-08-12_graph-run-lifecycle-expand.sql"
)
WRITER_PAUSE=("observed" "observed" "not-required" "not-required" "not-required" "observed" "not-required" "observed")
EXPECTED_MIGRATION_COUNT="${#MIGRATIONS[@]}"

if ! jq -e \
  --arg commit "${EXPECTED_COMMIT}" \
  --argjson migration_count "${EXPECTED_MIGRATION_COUNT}" '
  ((keys - ["outreachQuiescence"]) == [
    "approver",
    "candidateCommit",
    "changeTicket",
    "databaseIdentityHash",
    "environment",
    "expiresAt",
    "migrations",
    "operator",
    "productionApplyEvidenceHash",
    "rollbackBaseline",
    "rollbackRehearsalEvidenceHash",
    "schemaVersion",
    "stagingRehearsalEvidenceHash",
    "status",
    "verifiedAt"
  ])
  and .schemaVersion == 3
  and .environment == "production"
  and .candidateCommit == $commit
  and .status == "applied-and-verified"
  and (.verifiedAt | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))
  and (.expiresAt | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))
  and (.operator | type == "string" and length > 0)
  and (.approver | type == "string" and test("^[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}$"))
  and .operator != .approver
  and (.changeTicket | type == "string" and length > 0)
  and (.databaseIdentityHash | type == "string" and test("^sha256:[0-9a-f]{64}$"))
  and (.stagingRehearsalEvidenceHash | type == "string" and test("^sha256:[0-9a-f]{64}$"))
  and (.productionApplyEvidenceHash | type == "string" and test("^sha256:[0-9a-f]{64}$"))
  and (.rollbackRehearsalEvidenceHash | type == "string" and test("^sha256:[0-9a-f]{64}$"))
  and (.rollbackBaseline | type == "object")
  and (.rollbackBaseline | keys == [
    "apiImage",
    "apiRevision",
    "attestation",
    "compatibilityAttestation",
    "compatibilityEpoch",
    "consoleImage",
    "consoleRevision",
    "deliveryUnknownWriteMode",
    "workerImage",
    "workerRevision"
  ])
  and (.rollbackBaseline.apiImage | type == "string" and test("^workforceosprodacr\\.azurecr\\.io/apex-api@sha256:[0-9a-f]{64}$"))
  and (.rollbackBaseline.apiRevision | type == "string" and test("^apex-gtm-api--[a-z0-9][a-z0-9-]*$"))
  and (.rollbackBaseline.workerImage | type == "string" and test("^workforceosprodacr\\.azurecr\\.io/apex-api@sha256:[0-9a-f]{64}$"))
  and (.rollbackBaseline.workerRevision | type == "string" and test("^apex-gtm-worker--[a-z0-9][a-z0-9-]*$"))
  and (.rollbackBaseline.consoleImage | type == "string" and test("^workforceosprodacr\\.azurecr\\.io/workforceos-fe@sha256:[0-9a-f]{64}$"))
  and (.rollbackBaseline.consoleRevision | type == "string" and test("^nikxius-web--[a-z0-9][a-z0-9-]*$"))
  and .rollbackBaseline.compatibilityAttestation == "enum-aware-api-worker-console-baseline-v1"
  and .rollbackBaseline.compatibilityEpoch == "outreach-delivery-unknown-v1"
  and (
    (.rollbackBaseline.deliveryUnknownWriteMode == "disabled"
      and .rollbackBaseline.attestation == "delivery-unknown-writes-disabled-v1")
    or
    (.rollbackBaseline.deliveryUnknownWriteMode == "first-class"
      and .rollbackBaseline.attestation == "delivery-unknown-readers-drained-rollback-baselines-verified-v1")
  )
  and (
    if .rollbackBaseline.deliveryUnknownWriteMode == "disabled"
    then
      (has("outreachQuiescence")
       and (.outreachQuiescence | type == "object")
       and (.outreachQuiescence | keys == [
         "activeJobs",
         "apiMutationsBlocked",
         "evidenceHash",
         "firstClassDeliveryUnknownRows",
         "legacyDeliveryUnknownMarkerRows",
         "legacyWorkerStopped",
         "liveSendAllowlistEmpty",
         "queuesPaused",
         "replySlotDuplicateRows",
         "sendingRows"
       ])
       and .outreachQuiescence.apiMutationsBlocked == true
       and .outreachQuiescence.legacyWorkerStopped == true
       and (.outreachQuiescence.queuesPaused | keys == ["agentRuns", "graphRuns", "outreachSend"])
       and .outreachQuiescence.queuesPaused.agentRuns == true
       and .outreachQuiescence.queuesPaused.graphRuns == true
       and .outreachQuiescence.queuesPaused.outreachSend == true
       and (.outreachQuiescence.activeJobs | keys == ["agentRuns", "graphRuns", "outreachSend"])
       and .outreachQuiescence.activeJobs.agentRuns == 0
       and .outreachQuiescence.activeJobs.graphRuns == 0
       and .outreachQuiescence.activeJobs.outreachSend == 0
       and .outreachQuiescence.sendingRows == 0
       and .outreachQuiescence.firstClassDeliveryUnknownRows == 0
       and .outreachQuiescence.legacyDeliveryUnknownMarkerRows == 0
       and .outreachQuiescence.replySlotDuplicateRows == 0
       and .outreachQuiescence.liveSendAllowlistEmpty == true
       and (.outreachQuiescence.evidenceHash | type == "string" and test("^sha256:[0-9a-f]{64}$")))
    else (has("outreachQuiescence") | not)
    end
  )
  and (.migrations | type == "array" and length == $migration_count)
' >/dev/null "${RECEIPT_COPY}"; then
  echo "ERROR: migration receipt metadata is incomplete or invalid" >&2
  exit 1
fi

if ! VERIFIED_AT_EPOCH="$(jq -er '.verifiedAt | fromdateiso8601' "${RECEIPT_COPY}")" ||
  ! EXPIRES_AT_EPOCH="$(jq -er '.expiresAt | fromdateiso8601' "${RECEIPT_COPY}")"; then
  echo "ERROR: migration receipt freshness timestamps are invalid" >&2
  exit 1
fi
receipt_freshness_is_valid_at() {
  local current_epoch=$1
  if [[ ! "${VERIFIED_AT_EPOCH}" =~ ^[0-9]+$ ]] ||
    [[ ! "${EXPIRES_AT_EPOCH}" =~ ^[0-9]+$ ]] ||
    [[ ! "${current_epoch}" =~ ^[0-9]+$ ]] ||
    ((EXPIRES_AT_EPOCH <= VERIFIED_AT_EPOCH)) ||
    ((EXPIRES_AT_EPOCH - VERIFIED_AT_EPOCH > RECEIPT_MAX_LIFETIME_SECONDS)); then
    return 1
  fi
  if [[ "${SAME_ATTEMPT_ROLLBACK}" != "true" ]] &&
    { ((VERIFIED_AT_EPOCH - current_epoch > RECEIPT_FUTURE_SKEW_SECONDS)) ||
      ((current_epoch >= EXPIRES_AT_EPOCH)); }; then
    return 1
  fi
}

CURRENT_EPOCH="$(date -u +%s)"
if ! receipt_freshness_is_valid_at "${CURRENT_EPOCH}"; then
  echo "ERROR: migration receipt is stale, future-dated, or exceeds the 15-minute lifetime" >&2
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

if [[ "${#}" -eq 11 ]]; then
  if ! jq -e \
    --arg api_image "${EXPECTED_API_IMAGE}" \
    --arg api_revision "${EXPECTED_API_REVISION}" \
    --arg worker_image "${EXPECTED_WORKER_IMAGE}" \
    --arg worker_revision "${EXPECTED_WORKER_REVISION}" \
    --arg console_image "${EXPECTED_CONSOLE_IMAGE}" \
    --arg console_revision "${EXPECTED_CONSOLE_REVISION}" \
    --arg compatibility_attestation "${ROLLBACK_BASELINE_COMPATIBILITY_ATTESTATION}" \
    --arg epoch "${DELIVERY_UNKNOWN_COMPATIBILITY_EPOCH}" \
    --arg mode "${EXPECTED_DELIVERY_UNKNOWN_WRITE_MODE}" \
    --arg disabled_attestation "${DELIVERY_UNKNOWN_DISABLED_ATTESTATION}" \
    --arg first_class_attestation "${DELIVERY_UNKNOWN_FIRST_CLASS_ATTESTATION}" '
      .rollbackBaseline.apiImage == $api_image
      and .rollbackBaseline.apiRevision == $api_revision
      and .rollbackBaseline.workerImage == $worker_image
      and .rollbackBaseline.workerRevision == $worker_revision
      and .rollbackBaseline.consoleImage == $console_image
      and .rollbackBaseline.consoleRevision == $console_revision
      and .rollbackBaseline.compatibilityAttestation == $compatibility_attestation
      and .rollbackBaseline.compatibilityEpoch == $epoch
      and .rollbackBaseline.deliveryUnknownWriteMode == $mode
      and .rollbackBaseline.attestation ==
        (if $mode == "disabled"
         then $disabled_attestation
         else $first_class_attestation
         end)
    ' >/dev/null "${RECEIPT_COPY}"; then
    echo "ERROR: signed migration receipt does not match the exact current rollback baseline" >&2
    exit 1
  fi
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

# Signature verification and hashing the reviewed migration inventory can
# cross the expiry boundary. Reapply the identical predicate at return so a
# caller never receives a fresh success based only on the earlier clock read.
FINAL_CURRENT_EPOCH="$(date -u +%s)"
if ! receipt_freshness_is_valid_at "${FINAL_CURRENT_EPOCH}"; then
  echo "ERROR: migration receipt expired before verification completed" >&2
  exit 1
fi

if [[ "${#}" -eq 11 ]]; then
  echo "Signed production migration receipt verified for ${EXPECTED_COMMIT} (approver ${APPROVER}; ${EXPECTED_MIGRATION_COUNT} ordered migrations; fresh exact ${EXPECTED_DELIVERY_UNKNOWN_WRITE_MODE} API/worker/console rollback baseline)"
else
  echo "Signed production migration receipt verified for ${EXPECTED_COMMIT} (approver ${APPROVER}; ${EXPECTED_MIGRATION_COUNT} ordered migrations)"
fi
