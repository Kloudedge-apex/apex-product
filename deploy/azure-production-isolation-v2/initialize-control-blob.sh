#!/usr/bin/env bash

# One-time, separately authorized initialization of the fixed zero-byte
# isolated production-control blob. This script never overwrites, deletes,
# leases, or breaks a lease. Do not run it from a release identity.

set -euo pipefail

SUBSCRIPTION_ID="3171575e-f164-425c-9ee0-2fb10cf93884"
RESOURCE_GROUP="workforce-os-prod"
STORAGE_ACCOUNT="workforceosprodctrl"
CONTAINER="production-control"
BLOB="workforce-os/initial-production-bootstrap/state-v1.json"
CONFIRMATION=""
APPLY="false"

usage() {
  echo "Usage: $0 --apply --confirmation 'INITIALIZE WORKFORCE OS PRODUCTION CONTROL BLOB'" >&2
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

if [[ "${APPLY}" != "true" ||
  "${CONFIRMATION}" != "INITIALIZE WORKFORCE OS PRODUCTION CONTROL BLOB" ]]; then
  echo "ERROR: explicit one-time initialization authority is absent" >&2
  exit 1
fi

for command in az jq mktemp; do
  command -v "${command}" >/dev/null 2>&1 || {
    echo "ERROR: required command is unavailable: ${command}" >&2
    exit 1
  }
done

account_json="$(az account show --output json --only-show-errors)"
jq -e --arg subscription "${SUBSCRIPTION_ID}" '
  (.id | ascii_downcase) == ($subscription | ascii_downcase)
  and .state == "Enabled"
' >/dev/null <<<"${account_json}"

storage_id="/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.Storage/storageAccounts/${STORAGE_ACCOUNT}"
actual_storage_id="$(az resource show \
  --subscription "${SUBSCRIPTION_ID}" \
  --ids "${storage_id}" \
  --query id \
  --output tsv \
  --only-show-errors)"
[[ "${actual_storage_id,,}" == "${storage_id,,}" ]] || {
  echo "ERROR: production-control storage identity drift detected" >&2
  exit 1
}

container_json="$(az storage container show \
  --subscription "${SUBSCRIPTION_ID}" \
  --account-name "${STORAGE_ACCOUNT}" \
  --name "${CONTAINER}" \
  --auth-mode login \
  --output json \
  --only-show-errors)"
jq -e '.name == "production-control" and (.properties.publicAccess // null) == null' \
  >/dev/null <<<"${container_json}"

exists="$(az storage blob exists \
  --subscription "${SUBSCRIPTION_ID}" \
  --account-name "${STORAGE_ACCOUNT}" \
  --container-name "${CONTAINER}" \
  --name "${BLOB}" \
  --auth-mode login \
  --query exists \
  --output tsv \
  --only-show-errors)"
if [[ "${exists}" != "false" ]]; then
  echo "ERROR: fixed production-control blob already exists; refusing to overwrite it" >&2
  exit 1
fi

runtime_dir="$(mktemp -d "${TMPDIR:-/tmp}/workforce-control-blob.XXXXXX")"
empty_file="${runtime_dir}/empty"
cleanup() {
  : >"${empty_file}" 2>/dev/null || true
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
  --content-type application/json \
  --output none \
  --only-show-errors

blob_json="$(az storage blob show \
  --subscription "${SUBSCRIPTION_ID}" \
  --account-name "${STORAGE_ACCOUNT}" \
  --container-name "${CONTAINER}" \
  --name "${BLOB}" \
  --auth-mode login \
  --output json \
  --only-show-errors)"
jq -e '
  .properties.contentLength == 0
  and .properties.lease.status == "unlocked"
  and .properties.lease.state == "available"
' >/dev/null <<<"${blob_json}"

echo "Initialized the fixed zero-byte Workforce OS production-control blob."
