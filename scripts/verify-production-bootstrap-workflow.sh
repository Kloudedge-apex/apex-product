#!/usr/bin/env bash

# Static, dependency-free admission check for the one-time protected bootstrap
# workflow. External environment reviewers, OIDC federation, Azure RBAC, and
# evidence provisioning remain explicit operational gates.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
WORKFLOW="${1:-${REPO_ROOT}/.github/workflows/bootstrap-production.yml}"
CONTROLLER="${REPO_ROOT}/scripts/production-bootstrap-controller.mjs"

fail() {
  echo "ERROR: production bootstrap workflow contract failed: $*" >&2
  exit 1
}

if [[ $# -gt 1 ]]; then
  echo "Usage: $0 [bootstrap-production.yml]" >&2
  exit 2
fi
for path in "${WORKFLOW}" "${CONTROLLER}"; do
  [[ -f "${path}" && ! -L "${path}" ]] || fail "trusted source must be a regular non-symlink file: ${path}"
done

TRUSTED_EXECUTABLES=(
  "scripts/production-bootstrap-controller.mjs"
  "scripts/production-bootstrap-phase-ledger.mjs"
  "scripts/production-bootstrap-phase-receipt-contracts.mjs"
  "scripts/production-bootstrap-runtime-control.ts"
  "scripts/production-bootstrap-database-identity.mjs"
  "scripts/production-bootstrap-mutation-authority.mjs"
  "scripts/production-clerk-reconciliation-executor.mjs"
  "scripts/verify-production-bootstrap-entry-receipt.sh"
  "scripts/verify-production-bootstrap-phase-receipt.sh"
  "scripts/verify-production-post-clerk-migration-catalog.mjs"
  "scripts/verify-registry-api-image.sh"
  "scripts/verify-containerapp-release-config.sh"
  "scripts/run-release-git.sh"
)
for relative_path in "${TRUSTED_EXECUTABLES[@]}"; do
  path="${REPO_ROOT}/${relative_path}"
  [[ -f "${path}" && ! -L "${path}" && -x "${path}" ]] ||
    fail "trusted snapshot helper must be a regular executable non-symlink file: ${relative_path}"
done

require_literal() {
  local value=$1
  grep -Fq -- "${value}" "${WORKFLOW}" || fail "missing required workflow source: ${value}"
}

reject_pattern() {
  local pattern=$1 description=$2
  if grep -Eq -- "${pattern}" "${WORKFLOW}"; then fail "${description}"; fi
}

line_of() {
  local value=$1 line
  line="$(awk -v value="${value}" 'index($0, value) { print NR; exit }' "${WORKFLOW}")"
  [[ -n "${line}" ]] || fail "missing ordered workflow source: ${value}"
  printf '%s\n' "${line}"
}

assert_before() {
  local first=$1 second=$2
  [[ $(line_of "${first}") -lt $(line_of "${second}") ]] ||
    fail "expected '${first}' before '${second}'"
}

EXPECTED_ACTIONS="$(node --input-type=module -e '
  const { ACTIONS } = await import(process.argv[1]);
  process.stdout.write(ACTIONS.join("\n"));
' "file://${CONTROLLER}")"
WORKFLOW_ACTIONS="$(awk '
  $0 == "        options:" { inside = 1; next }
  inside && /^      confirmation:/ { exit }
  inside && /^          - / { value = $0; sub(/^          - /, "", value); print value }
' "${WORKFLOW}")"
[[ "${WORKFLOW_ACTIONS}" == "${EXPECTED_ACTIONS}" ]] ||
  fail "workflow action choices differ from the controller action surface"

TOP_LEVEL="$(awk 'NF && /^[^[:space:]#]/ { value=$0; sub(/:.*/, "", value); print value }' "${WORKFLOW}")"
[[ "${TOP_LEVEL}" == $'name\non\npermissions\nconcurrency\njobs' ]] ||
  fail "top-level workflow keys are not the exact reviewed set"
TRIGGERS="$(awk '
  $0 == "on:" { inside = 1; next }
  inside && /^[^[:space:]#]/ { exit }
  inside && /^  [A-Za-z0-9_-]+:/ { value=$0; sub(/^  /, "", value); sub(/:.*/, "", value); print value }
' "${WORKFLOW}")"
[[ "${TRIGGERS}" == "workflow_dispatch" ]] || fail "workflow_dispatch must be the only trigger"

PERMISSIONS="$(awk '
  $0 == "permissions:" { inside = 1; next }
  inside && /^[^[:space:]#]/ { exit }
  inside && /^  [A-Za-z0-9_-]+:/ { value=$0; sub(/^  /, "", value); gsub(/:[[:space:]]*/, "=", value); print value }
' "${WORKFLOW}")"
[[ "${PERMISSIONS}" == $'actions=read\nchecks=read\ncontents=write\ndeployments=read\nid-token=write\nstatuses=read' ]] ||
  fail "workflow permissions differ from the reviewed least-privilege set"

require_literal '  group: workforce-os-production'
require_literal '  cancel-in-progress: false'
require_literal '    environment: workforce-os-production'
require_literal '    timeout-minutes: 120'
require_literal '"${GITHUB_EVENT_NAME}" != "workflow_dispatch"'
require_literal '"${GITHUB_REF}" != "refs/heads/master"'
require_literal '"${REF_PROTECTED}" != "true"'
require_literal '"${CONFIRMATION}" != "BOOTSTRAP WORKFORCE OS PRODUCTION"'
require_literal 'ACA_EXCLUSIVE_MUTATION_AUTHORITY_CONFIRMED'
require_literal 'AZURE_PRINCIPAL_OBJECT_ID'
require_literal 'OUTSTANDING_DELIVERY_REVIEW_CONFIRMED'
require_literal 'PROVIDER_DELIVERY_DRAIN_CONFIRMED'
require_literal 'DATABASE_DDL_EXCLUSIVE_AUTHORITY_CONFIRMED'
require_literal 'PRODUCTION_BOOTSTRAP_OUTSTANDING_DELIVERY_REVIEW_B64'
require_literal 'PRODUCTION_BOOTSTRAP_PROVIDER_DELIVERY_DRAIN_B64'
require_literal 'PRODUCTION_BOOTSTRAP_DATABASE_DDL_AUTHORITY_B64'
require_literal 'PRODUCTION_BOOTSTRAP_FAILED_LIST_SMOKE_EVIDENCE_B64'
require_literal 'PRODUCTION_BOOTSTRAP_DASHBOARD_POLICY_SMOKE_EVIDENCE_B64'
require_literal '--outstanding-delivery-review'
require_literal '--provider-delivery-drain'
require_literal '--database-ddl-authority-evidence'
require_literal '--failed-list-smoke-evidence'
require_literal '--dashboard-policy-smoke-evidence'
require_literal "inputs.action != 'audit'"
require_literal 'WORKFORCE_PRODUCTION_BOOTSTRAP_AUTHORITY_CONFIRMED: "true"'
require_literal 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262'
require_literal 'azure/login@a457da9ea143d694b1b9c7c869ebb04ebe844ef5'
require_literal 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02'
reject_pattern 'abort-before-schema' "removed abort action reappeared"
reject_pattern 'continue-on-error[[:space:]]*:[[:space:]]*true' "continue-on-error is forbidden"
reject_pattern 'uses:[[:space:]]+[^[:space:]@]+@(main|master|v[0-9]+)([[:space:]#]|$)' "mutable action references are forbidden"
reject_pattern '^[[:space:]]+(DATABASE_URL|REDIS_URL|PGPASS_B64):[[:space:]]+\$\{\{[[:space:]]*secrets\.' "production database or Redis secrets must be action-scoped and absent from audit"

assert_before "Validate protected manual authority" "Checkout exact protected master source"
assert_before "Checkout exact protected master source" "Authenticate to Azure with protected OIDC"
assert_before "Authenticate to Azure with protected OIDC" "Run one exact-snapshot bootstrap action"
assert_before 'unset REQUEST_B64' 'node scripts/production-bootstrap-controller.mjs'

printf 'Production bootstrap workflow contract verified\n'
