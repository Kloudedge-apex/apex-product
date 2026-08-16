#!/usr/bin/env bash

# Start the mandatory production authority credential-drain window only after
# the live audit proves structural exclusivity. This creates one fixed zero-byte
# blob with server-timed metadata, or verifies the same immutable blob after a
# receipt-delivery failure. It never reads a secret or overwrites, deletes,
# leases, or resets an existing checkpoint.

set -euo pipefail

SUBSCRIPTION_ID="3171575e-f164-425c-9ee0-2fb10cf93884"
RESOURCE_GROUP="workforce-os-prod"
STORAGE_ACCOUNT="workforceosprodctrl"
CONTAINER="production-control"
BLOB="workforce-os/initial-production-bootstrap/authority-drain-checkpoint-v1"
CHECKPOINT_KIND="workforce-os-production-authority-drain-checkpoint-v1"
CONFIRMATION_PHRASE="CREATE WORKFORCE OS AUTHORITY DRAIN CHECKPOINT"
CONFIRMATION=""
APPLY="false"

usage() {
  echo "Usage: $0 --apply --confirmation '${CONFIRMATION_PHRASE}'" >&2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply)
      APPLY="true"
      shift
      ;;
    --confirmation)
      [[ $# -ge 2 ]] || { usage; exit 2; }
      CONFIRMATION=$2
      shift 2
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

if [[ "${APPLY}" != "true" || "${CONFIRMATION}" != "${CONFIRMATION_PHRASE}" ]]; then
  echo "ERROR: exact checkpoint mutation authority is absent" >&2
  exit 1
fi

for command in az jq mktemp node; do
  command -v "${command}" >/dev/null 2>&1 || {
    echo "ERROR: required command is unavailable: ${command}" >&2
    exit 1
  }
done

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
audit_script="${repo_root}/scripts/production-azure-mutation-authority-audit.mjs"
[[ -f "${audit_script}" && ! -L "${audit_script}" ]] || {
  echo "ERROR: reviewed live audit source is unavailable" >&2
  exit 1
}

audit_status=0
audit_json="$(node "${audit_script}")" || audit_status=$?
if [[ "${audit_status}" -ne 2 ]]; then
  echo "ERROR: live audit did not return the expected drain-only NO-GO" >&2
  exit 1
fi
checkpoint_mode="$(jq -er \
  --arg subscription "${SUBSCRIPTION_ID}" \
  --arg blob "${BLOB}" '
    if (
      .schemaVersion == 1
    and .kind == "workforce-os-production-azure-mutation-authority-audit"
    and .status == "NO-GO"
    and (.subscriptionId | ascii_downcase) == ($subscription | ascii_downcase)
    and .summary.structuralExclusive == true
    and .summary.credentialDrainComplete == false
    and .summary.minimumCredentialDrainAgeSeconds == 864000
    and .credentialDrainCheckpointBlob == $blob
    and (.structuralEvidenceHash | type == "string" and test("^sha256:[0-9a-f]{64}$"))
    and .controllerEvidence == null
    and (.findings | type == "array" and length == 1)
    and .findings[0].target == "stateStorage"
    ) then
      if .findings[0].code == "credential-drain-checkpoint-missing" then
        "create"
      elif (
        .findings[0].code == "credential-drain-window-open"
        and .findings[0].minimumAgeSeconds == 864000
      ) then
        "existing"
      else
        empty
      end
    else
      empty
    end
  ' <<<"${audit_json}")"
[[ "${checkpoint_mode}" == "create" || "${checkpoint_mode}" == "existing" ]] || {
  echo "ERROR: live audit is not an admissible create or existing drain state" >&2
  exit 1
}

structural_hash="$(jq -er '.structuralEvidenceHash | sub("^sha256:"; "")' \
  <<<"${audit_json}")"
backend_release_client_id="$(jq -er '.identities.backendRelease.clientId' \
  <<<"${audit_json}")"
account_json="$(az account show --subscription "${SUBSCRIPTION_ID}" \
  --output json --only-show-errors)"
jq -e \
  --arg subscription "${SUBSCRIPTION_ID}" \
  --arg backend "${backend_release_client_id}" '
    (.id | ascii_downcase) == ($subscription | ascii_downcase)
    and .state == "Enabled"
    and .user.type == "servicePrincipal"
    and (.user.name | ascii_downcase) == ($backend | ascii_downcase)
  ' >/dev/null <<<"${account_json}"

storage_id="/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.Storage/storageAccounts/${STORAGE_ACCOUNT}"
actual_storage_id="$(az resource show \
  --subscription "${SUBSCRIPTION_ID}" \
  --ids "${storage_id}" \
  --query id \
  --output tsv \
  --only-show-errors)"
[[ "${actual_storage_id,,}" == "${storage_id,,}" ]] || {
  echo "ERROR: authority-drain storage identity drift detected" >&2
  exit 1
}

if [[ "${checkpoint_mode}" == "create" ]]; then
  runtime_dir="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/workforce-authority-drain.XXXXXX")"
  empty_file="${runtime_dir}/empty"
  cleanup() {
    rm -f -- "${empty_file}"
    rmdir -- "${runtime_dir}" 2>/dev/null || true
  }
  trap cleanup EXIT
  chmod 700 "${runtime_dir}"
  : >"${empty_file}"
  chmod 600 "${empty_file}"

  az storage blob upload \
    --subscription "${SUBSCRIPTION_ID}" \
    --account-name "${STORAGE_ACCOUNT}" \
    --container-name "${CONTAINER}" \
    --name "${BLOB}" \
    --file "${empty_file}" \
    --auth-mode login \
    --overwrite false \
    --if-none-match '*' \
    --metadata \
      "kind=${CHECKPOINT_KIND}" \
      "structural_evidence_sha256=${structural_hash}" \
      "subscription_id=${SUBSCRIPTION_ID}" \
    --content-type application/octet-stream \
    --output none \
    --only-show-errors
fi

checkpoint_after="$(az storage blob show \
  --subscription "${SUBSCRIPTION_ID}" \
  --account-name "${STORAGE_ACCOUNT}" \
  --container-name "${CONTAINER}" \
  --name "${BLOB}" \
  --auth-mode login \
  --output json \
  --only-show-errors)"
jq -e \
  --arg name "${BLOB}" \
  --arg kind "${CHECKPOINT_KIND}" \
  --arg hash "${structural_hash}" \
  --arg subscription "${SUBSCRIPTION_ID}" '
    .name == $name
    and .properties.contentLength == 0
    and .properties.lease.state == "available"
    and .properties.lease.status == "unlocked"
    and (.metadata | keys | sort) == [
      "kind", "structural_evidence_sha256", "subscription_id"
    ]
    and .metadata.kind == $kind
    and .metadata.structural_evidence_sha256 == $hash
    and (.metadata.subscription_id | ascii_downcase) == ($subscription | ascii_downcase)
    and (.properties.lastModified | type == "string" and length > 0)
  ' >/dev/null <<<"${checkpoint_after}"

jq -cn \
  --arg mode "${checkpoint_mode}" \
  --arg structuralEvidenceHash "sha256:${structural_hash}" \
  --arg lastModified "$(jq -er '.properties.lastModified' <<<"${checkpoint_after}")" '
  {
    kind: "workforce-os-production-authority-drain-checkpoint-receipt-v1",
    mode: $mode,
    structuralEvidenceHash: $structuralEvidenceHash,
    lastModified: $lastModified
  }'
