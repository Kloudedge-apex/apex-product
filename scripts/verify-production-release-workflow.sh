#!/usr/bin/env bash

# Statically enforce the fail-closed source contract for the protected
# production release workflow. External environment protection, OIDC federation,
# RBAC exclusivity, signer provisioning, and migration evidence remain separate
# operational gates.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
WORKFLOW="${1:-${REPO_ROOT}/.github/workflows/release-production.yml}"

fail() {
  echo "ERROR: production release workflow contract failed: $*" >&2
  exit 1
}

if [[ $# -gt 1 ]]; then
  echo "Usage: $0 [release-production.yml]" >&2
  exit 2
fi
if [[ ! -f "${WORKFLOW}" || -L "${WORKFLOW}" ]]; then
  fail "workflow must be a regular non-symlink file"
fi

require_line() {
  local expected=$1
  grep -Fqx -- "${expected}" "${WORKFLOW}" || fail "missing exact line: ${expected}"
}

require_literal() {
  local expected=$1
  grep -Fq -- "${expected}" "${WORKFLOW}" || fail "missing required source: ${expected}"
}

require_count() {
  local expected=$1
  local count=$2
  local actual
  actual="$(grep -Fxc -- "${expected}" "${WORKFLOW}" || true)"
  [[ "${actual}" == "${count}" ]] ||
    fail "expected ${count} exact occurrence(s) of '${expected}', found ${actual}"
}

reject_pattern() {
  local pattern=$1
  local description=$2
  if grep -Eq -- "${pattern}" "${WORKFLOW}"; then
    fail "${description}"
  fi
}

require_step_line() {
  local step_name=$1
  local expected=$2
  if ! awk -v step="      - name: ${step_name}" -v expected="${expected}" '
    $0 == step { inside = 1; next }
    inside && /^      - name:/ { exit }
    inside && $0 == expected { found = 1 }
    END { if (!found) exit 1 }
  ' "${WORKFLOW}"; then
    fail "step '${step_name}' is missing exact source: ${expected}"
  fi
}

line_of() {
  local needle=$1
  local line
  line="$(awk -v needle="${needle}" 'index($0, needle) { print NR; exit }' "${WORKFLOW}")"
  [[ -n "${line}" ]] || fail "missing ordered source marker: ${needle}"
  printf '%s\n' "${line}"
}

assert_before() {
  local first=$1
  local second=$2
  local first_line second_line
  first_line="$(line_of "${first}")"
  second_line="$(line_of "${second}")"
  [[ ${first_line} -lt ${second_line} ]] ||
    fail "expected '${first}' before '${second}'"
}

TOP_LEVEL_KEYS="$(awk '
  /^[A-Za-z0-9_-]+:/ {
    value = $0
    sub(/:.*/, "", value)
    print value
  }
' "${WORKFLOW}")"
[[ "${TOP_LEVEL_KEYS}" == $'name\non\npermissions\nconcurrency\njobs' ]] ||
  fail "top-level keys must be exactly name, on, permissions, concurrency, and jobs in order"
TOP_LEVEL_LINES="$(awk '
  NF && /^[^[:space:]#]/ { print }
' "${WORKFLOW}")"
[[ "${TOP_LEVEL_LINES}" == $'name: Protected production release\non:\npermissions:\nconcurrency:\njobs:' ]] ||
  fail "top-level workflow structure contains an unreviewed key or value"

RELEASE_JOB_KEYS="$(awk '
  $0 == "  release:" { inside = 1; next }
  inside && /^[^[:space:]#]/ { exit }
  inside && /^    [A-Za-z0-9_-]+:/ {
    value = $0
    sub(/^    /, "", value)
    sub(/:.*/, "", value)
    print value
  }
' "${WORKFLOW}")"
[[ "${RELEASE_JOB_KEYS}" == $'name\nruns-on\ntimeout-minutes\nenvironment\nsteps' ]] ||
  fail "release job keys must be exactly name, runs-on, timeout-minutes, environment, and steps in order"
RELEASE_JOB_LINES="$(awk '
  $0 == "  release:" { inside = 1; next }
  inside && /^[^[:space:]#]/ { exit }
  inside && /^    [^[:space:]#]/ { print }
' "${WORKFLOW}")"
[[ "${RELEASE_JOB_LINES}" == $'    name: Protected production release\n    runs-on: ubuntu-24.04\n    timeout-minutes: 120\n    environment: workforce-os-production\n    steps:' ]] ||
  fail "release job structure contains an unreviewed key or value"

STEP_STARTERS="$(awk '
  /^      - / {
    value = $0
    sub(/^      - /, "", value)
    print value
  }
' "${WORKFLOW}")"
[[ "${STEP_STARTERS}" == $'name: Validate manual release admission\nname: Verify protected production environment\nname: Checkout trusted master workflow source\nname: Verify trusted master workflow source\nname: Verify exact release CI\nname: Checkout exact release candidate\nname: Materialize exact release candidate\nname: Verify reviewed migration signer pin\nname: Authenticate to Azure with protected OIDC identity\nname: Verify Azure production identity\nname: Decode protected migration evidence and release' ]] ||
  fail "workflow steps must be the exact reviewed named sequence with no unnamed or extra steps"
STEP_LEVEL_LINES="$(awk '
  $0 == "    steps:" { inside = 1; next }
  inside && /^[^[:space:]#]/ { exit }
  inside && /^      [^[:space:]#]/ { print }
' "${WORKFLOW}")"
[[ "${STEP_LEVEL_LINES}" == $'      - name: Validate manual release admission\n      - name: Verify protected production environment\n      - name: Checkout trusted master workflow source\n      - name: Verify trusted master workflow source\n      - name: Verify exact release CI\n      - name: Checkout exact release candidate\n      - name: Materialize exact release candidate\n      - name: Verify reviewed migration signer pin\n      - name: Authenticate to Azure with protected OIDC identity\n      - name: Verify Azure production identity\n      - name: Decode protected migration evidence and release' ]] ||
  fail "workflow step sequence contains an unnamed or unreviewed entry"

reject_pattern '(^|[[:space:]])[&*][A-Za-z0-9_-]+([[:space:]#]|$)' \
  "YAML anchors and aliases are forbidden"
reject_pattern '^[[:space:]]*<<[[:space:]]*:' \
  "YAML merge keys are forbidden"
reject_pattern '^[[:space:]]+['\''"]?shell['\''"]?[[:space:]]*:' \
  "workflow shell overrides are forbidden"
reject_pattern '^[[:space:]]+['\''"]?if['\''"]?[[:space:]]*:' \
  "workflow conditional execution keys are forbidden"
reject_pattern '^[[:space:]]+['\''"]?continue-on-error['\''"]?[[:space:]]*:' \
  "workflow continue-on-error keys are forbidden"

require_count "on:" 1
TRIGGERS="$(awk '
  $0 == "on:" { inside = 1; next }
  inside && /^[^[:space:]#]/ { exit }
  inside && /^  [A-Za-z0-9_-]+:/ {
    value = $0
    sub(/^  /, "", value)
    sub(/:.*/, "", value)
    print value
  }
' "${WORKFLOW}")"
[[ "${TRIGGERS}" == "workflow_dispatch" ]] ||
  fail "workflow_dispatch must be the only trigger"

INPUT_KEYS="$(awk '
  $0 == "    inputs:" { inside = 1; next }
  inside && /^[^[:space:]#]/ { exit }
  inside && /^      [A-Za-z0-9_-]+:/ {
    value = $0
    sub(/^      /, "", value)
    sub(/:.*/, "", value)
    print value
  }
' "${WORKFLOW}")"
[[ "${INPUT_KEYS}" == $'release_branch\nrelease_sha\nconfirmation' ]] ||
  fail "manual inputs must be exactly release_branch, release_sha, and confirmation"

PERMISSIONS="$(awk '
  $0 == "permissions:" { inside = 1; next }
  inside && /^[^[:space:]#]/ { exit }
  inside && /^  [A-Za-z0-9_-]+:/ {
    value = $0
    sub(/^  /, "", value)
    gsub(/:[[:space:]]*/, "=", value)
    print value
  }
' "${WORKFLOW}")"
[[ "${PERMISSIONS}" == $'actions=read\ncontents=write\ndeployments=read\nid-token=write' ]] ||
  fail "permissions must be exactly actions:read, contents:write, deployments:read, id-token:write"

JOBS="$(awk '
  $0 == "jobs:" { inside = 1; next }
  inside && /^[^[:space:]#]/ { exit }
  inside && /^  [A-Za-z0-9_-]+:/ {
    value = $0
    sub(/^  /, "", value)
    sub(/:.*/, "", value)
    print value
  }
' "${WORKFLOW}")"
[[ "${JOBS}" == "release" ]] || fail "workflow must contain only the protected release job"

require_line "  group: workforce-os-production"
require_line "  cancel-in-progress: false"
require_count "    environment: workforce-os-production" 1

USES="$(awk '
  /^[[:space:]]+uses:/ {
    value = $0
    sub(/^[[:space:]]+uses:[[:space:]]*/, "", value)
    print value
  }
' "${WORKFLOW}")"
[[ "${USES}" == $'actions/checkout@11d5960a326750d5838078e36cf38b85af677262\nactions/checkout@11d5960a326750d5838078e36cf38b85af677262\nazure/login@a457da9ea143d694b1b9c7c869ebb04ebe844ef5' ]] ||
  fail "workflow actions must be exactly two reviewed checkout pins and the reviewed Azure login pin"

reject_pattern '(^|[^A-Za-z0-9_])vars\.' \
  "workflow must not consume the fallback vars context"
reject_pattern '(AZURE_CLIENT_SECRET|client-secret:|client_secret:|creds:|password:)' \
  "stored Azure credentials or client-secret login are forbidden"
require_count '          GH_TOKEN: ${{ github.token }}' 3
reject_pattern '^      GH_TOKEN:' "GitHub token must not be job-scoped"
require_step_line "Verify protected production environment" \
  '          GH_TOKEN: ${{ github.token }}'
require_step_line "Verify exact release CI" \
  '          GH_TOKEN: ${{ github.token }}'
require_step_line "Decode protected migration evidence and release" \
  '          GH_TOKEN: ${{ github.token }}'

require_literal 'if [[ "${EVENT_NAME}" != "workflow_dispatch" ]]; then'
require_literal 'if [[ "${GITHUB_REF}" != "refs/heads/master" || "${REF_PROTECTED}" != "true" ]]; then'
require_literal '[[ ! "${WORKFLOW_SHA}" =~ ^[0-9a-f]{40}$ || ! "${RELEASE_SHA}" =~ ^[0-9a-f]{40}$ ]]'
require_literal '[[ ! "${RELEASE_BRANCH}" =~ ^release/go-live-[A-Za-z0-9._/-]+$ ||'
require_literal '"${RELEASE_BRANCH}" == *".."* || "${RELEASE_BRANCH}" == */'
require_literal '[[ "${CONFIRMATION}" != "DEPLOY WORKFORCE OS PRODUCTION" ]]'

require_step_line "Verify protected production environment" \
  '        id: production_environment'
require_literal 'repos/${GITHUB_REPOSITORY}'
require_literal '.default_branch == "master"'
require_literal 'repos/${GITHUB_REPOSITORY}/git/ref/heads/master'
require_literal '.ref == "refs/heads/master"'
require_literal '[[ "${remote_master_sha}" != "${WORKFLOW_SHA}" ]]'
require_literal 'jq -rn --arg branch "${RELEASE_BRANCH}" '\''$branch | @uri'\'''
require_literal 'repos/${GITHUB_REPOSITORY}/branches/${release_branch_path}'
require_literal '.name == $branch'
require_literal 'and .protected == true'
require_literal 'and .commit.sha == $sha'

require_literal 'repos/${GITHUB_REPOSITORY}/environments/workforce-os-production'
require_literal '.can_admins_bypass == false'
require_literal '.type == "required_reviewers"'
require_literal '.prevent_self_review == true'
require_literal '(.reviewers | type == "array" and length > 0)'
require_literal '.deployment_branch_policy.protected_branches == true'
require_literal '.deployment_branch_policy.custom_branch_policies == false'
require_literal 'repos/${GITHUB_REPOSITORY}/environments/workforce-os-production/variables/${name}'
require_literal 'azure_client_id="$(read_environment_variable "AZURE_CLIENT_ID")"'
require_literal 'azure_tenant_id="$(read_environment_variable "AZURE_TENANT_ID")"'
require_literal 'azure_subscription_id="$(read_environment_variable "AZURE_SUBSCRIPTION_ID")"'
require_literal '"ACA_EXCLUSIVE_MUTATION_AUTHORITY_CONFIRMED")"'
require_literal '[[ "${exclusive_mutation_authority}" != "true" ]]'
require_literal '"WORKFORCE_PRODUCTION_CONTROL_STORAGE_ACCOUNT")"'
require_literal '"WORKFORCE_PRODUCTION_CONTROL_STORAGE_CONTAINER")"'
require_literal '"WORKFORCE_PRODUCTION_CONTROL_STORAGE_BLOB")"'
require_literal '"WORKFORCE_PRODUCTION_CONTROL_STORAGE_RESOURCE_ID")"'
require_literal '"${production_control_storage_container}" != "production-control"'
require_literal '"${production_control_storage_blob}" != "workforce-os/initial-production-bootstrap/state-v1.json"'
require_literal 'providers/Microsoft.Storage/storageAccounts/${production_control_storage_account}$'
require_literal 'repos/${GITHUB_REPOSITORY}/environments/workforce-os-production/secrets/${name}'
require_literal 'verify_environment_secret "PRODUCTION_MIGRATION_RECEIPT_B64"'
require_literal 'verify_environment_secret "PRODUCTION_MIGRATION_SIGNATURE_B64"'
require_literal 'verify_environment_secret "PRODUCTION_MIGRATION_ALLOWED_SIGNERS_B64"'
require_literal 'printf '\''azure_client_id=%s\n'\'' "${azure_client_id}" >>"${GITHUB_OUTPUT}"'
require_literal 'printf '\''azure_tenant_id=%s\n'\'' "${azure_tenant_id}" >>"${GITHUB_OUTPUT}"'
require_literal 'printf '\''azure_subscription_id=%s\n'\'' "${azure_subscription_id}" >>"${GITHUB_OUTPUT}"'
require_literal 'printf '\''exclusive_mutation_authority=%s\n'\'' \'
require_literal 'printf '\''production_control_storage_account=%s\n'\'' \'
require_literal 'printf '\''production_control_storage_container=%s\n'\'' \'
require_literal 'printf '\''production_control_storage_blob=%s\n'\'' \'
require_literal 'printf '\''production_control_storage_resource_id=%s\n'\'' \'

require_step_line "Checkout trusted master workflow source" \
  '        uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262'
require_step_line "Checkout trusted master workflow source" \
  '          ref: ${{ github.sha }}'
require_step_line "Checkout trusted master workflow source" \
  '          path: release-control'
require_step_line "Checkout trusted master workflow source" \
  '          persist-credentials: false'
require_literal '[[ "$(git -C release-control rev-parse HEAD)" != "${WORKFLOW_SHA}" ]]'
require_literal 'git -C release-control status --porcelain --untracked-files=all'
require_literal 'release-control/scripts/verify-production-release-workflow.sh \'
require_literal 'release-control/.github/workflows/release-production.yml'
require_step_line "Verify exact release CI" \
  '        run: release-control/scripts/verify-github-release-ci.sh "${RELEASE_SHA}"'

require_step_line "Checkout exact release candidate" \
  '        uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262'
require_step_line "Checkout exact release candidate" \
  '          ref: ${{ inputs.release_sha }}'
require_step_line "Checkout exact release candidate" \
  '          path: candidate'
require_step_line "Checkout exact release candidate" \
  '          persist-credentials: false'
require_step_line "Materialize exact release candidate" \
  '        working-directory: candidate'
require_literal 'git checkout --force -B "${RELEASE_BRANCH}" "${RELEASE_SHA}"'
require_literal '[[ "$(git rev-parse HEAD)" != "${RELEASE_SHA}" ]]'
require_literal '[[ "$(git branch --show-current)" != "${RELEASE_BRANCH}" ]]'
require_literal 'git status --porcelain --untracked-files=all'

require_step_line "Verify reviewed migration signer pin" \
  '        working-directory: candidate'
require_literal 'docs/ops/production-migration-allowed-signers.sha256'
require_literal 'awk '\''!/^[[:space:]]*#/ && NF { print }'\'' "${pin_path}"'
require_literal '[[ ! "${signer_pin}" =~ ^[0-9a-f]{64}$ ]]'

require_line '          client-id: ${{ steps.production_environment.outputs.azure_client_id }}'
require_line '          tenant-id: ${{ steps.production_environment.outputs.azure_tenant_id }}'
require_line '          subscription-id: ${{ steps.production_environment.outputs.azure_subscription_id }}'
require_step_line "Verify Azure production identity" \
  '          AZURE_CLIENT_ID: ${{ steps.production_environment.outputs.azure_client_id }}'
require_step_line "Verify Azure production identity" \
  '          AZURE_TENANT_ID: ${{ steps.production_environment.outputs.azure_tenant_id }}'
require_step_line "Verify Azure production identity" \
  '          AZURE_SUBSCRIPTION_ID: ${{ steps.production_environment.outputs.azure_subscription_id }}'
require_literal 'account_json="$(az account show --output json)"'
require_literal '(.id | ascii_downcase) == ($subscription | ascii_downcase)'
require_literal '(.tenantId | ascii_downcase) == ($tenant | ascii_downcase)'
require_literal '.user.type == "servicePrincipal"'
require_literal '(.user.name | ascii_downcase) == ($client | ascii_downcase)'

require_step_line "Decode protected migration evidence and release" \
  '        working-directory: candidate'
require_line '          ACA_EXCLUSIVE_MUTATION_AUTHORITY_CONFIRMED: ${{ steps.production_environment.outputs.exclusive_mutation_authority }}'
require_line '          AZURE_SUBSCRIPTION_ID: ${{ steps.production_environment.outputs.azure_subscription_id }}'
require_line '          WORKFORCE_PRODUCTION_CONTROL_STORAGE_ACCOUNT: ${{ steps.production_environment.outputs.production_control_storage_account }}'
require_line '          WORKFORCE_PRODUCTION_CONTROL_STORAGE_CONTAINER: ${{ steps.production_environment.outputs.production_control_storage_container }}'
require_line '          WORKFORCE_PRODUCTION_CONTROL_STORAGE_BLOB: ${{ steps.production_environment.outputs.production_control_storage_blob }}'
require_line '          WORKFORCE_PRODUCTION_CONTROL_STORAGE_RESOURCE_ID: ${{ steps.production_environment.outputs.production_control_storage_resource_id }}'
require_count '          WORKFORCE_PRODUCTION_CONTROL_STORAGE_ACCOUNT: ${{ steps.production_environment.outputs.production_control_storage_account }}' 1
require_count '          WORKFORCE_PRODUCTION_CONTROL_STORAGE_CONTAINER: ${{ steps.production_environment.outputs.production_control_storage_container }}' 1
require_count '          WORKFORCE_PRODUCTION_CONTROL_STORAGE_BLOB: ${{ steps.production_environment.outputs.production_control_storage_blob }}' 1
require_count '          WORKFORCE_PRODUCTION_CONTROL_STORAGE_RESOURCE_ID: ${{ steps.production_environment.outputs.production_control_storage_resource_id }}' 1
require_count '          ACA_EXCLUSIVE_MUTATION_AUTHORITY_CONFIRMED: ${{ steps.production_environment.outputs.exclusive_mutation_authority }}' 1
reject_pattern 'ACA_EXCLUSIVE_MUTATION_AUTHORITY_CONFIRMED:[[:space:]]*(true|false)' \
  "exclusive authority must not be hardcoded"
reject_pattern 'ACA_EXCLUSIVE_MUTATION_AUTHORITY_CONFIRMED:.*\$\{\{[[:space:]]*inputs\.' \
  "exclusive authority must not be dispatch-controlled"
reject_pattern 'ACA_EXCLUSIVE_MUTATION_AUTHORITY_CONFIRMED[[:space:]]*=[[:space:]]*true' \
  "exclusive authority must not be exported or assigned in workflow code"
require_line '          MIGRATION_RECEIPT_B64: ${{ secrets.PRODUCTION_MIGRATION_RECEIPT_B64 }}'
require_line '          MIGRATION_SIGNATURE_B64: ${{ secrets.PRODUCTION_MIGRATION_SIGNATURE_B64 }}'
require_line '          MIGRATION_ALLOWED_SIGNERS_B64: ${{ secrets.PRODUCTION_MIGRATION_ALLOWED_SIGNERS_B64 }}'
require_step_line "Decode protected migration evidence and release" \
  '          MIGRATION_RECEIPT_B64: ${{ secrets.PRODUCTION_MIGRATION_RECEIPT_B64 }}'
require_step_line "Decode protected migration evidence and release" \
  '          MIGRATION_SIGNATURE_B64: ${{ secrets.PRODUCTION_MIGRATION_SIGNATURE_B64 }}'
require_step_line "Decode protected migration evidence and release" \
  '          MIGRATION_ALLOWED_SIGNERS_B64: ${{ secrets.PRODUCTION_MIGRATION_ALLOWED_SIGNERS_B64 }}'
reject_pattern 'MIGRATION_(RECEIPT|SIGNATURE|ALLOWED_SIGNERS)_B64:.*\$\{\{[[:space:]]*(inputs|vars|github)\.' \
  "migration evidence must come only from protected environment secrets"
require_literal 'receipt_b64="${MIGRATION_RECEIPT_B64}"'
require_literal 'signature_b64="${MIGRATION_SIGNATURE_B64}"'
require_literal 'allowed_signers_b64="${MIGRATION_ALLOWED_SIGNERS_B64}"'
require_literal 'unset MIGRATION_RECEIPT_B64 MIGRATION_SIGNATURE_B64 MIGRATION_ALLOWED_SIGNERS_B64'
require_literal 'umask 077'
require_literal 'mktemp -d "${RUNNER_TEMP}/workforce-os-production-evidence.XXXXXX"'
require_literal 'printf '\''%s'\'' "${receipt_b64}" | base64 --decode >"${receipt_file}"'
require_literal 'printf '\''%s'\'' "${signature_b64}" | base64 --decode >"${signature_file}"'
require_literal 'printf '\''%s'\'' "${allowed_signers_b64}" | base64 --decode >"${allowed_signers_file}"'
require_literal 'rm -f -- "${receipt_file}" "${signature_file}" "${allowed_signers_file}"'
require_literal 'rmdir -- "${evidence_dir}"'
require_literal 'scripts/deploy-prod.sh \'
require_literal '--migration-receipt "${receipt_file}"'
require_literal '--migration-signature "${signature_file}"'
require_literal '--migration-allowed-signers "${allowed_signers_file}"'
require_literal '--yes'
reject_pattern '(^|[[:space:]])(bash|sh)[[:space:]]+[^#\n]*scripts/deploy-prod\.sh' \
  "release controller must be executed directly so its privileged shebang applies"

assert_before "Verify protected production environment" "Checkout trusted master workflow source"
assert_before '[[ "${remote_master_sha}" != "${WORKFLOW_SHA}" ]]' "Checkout trusted master workflow source"
assert_before 'and .commit.sha == $sha' "Checkout trusted master workflow source"
assert_before '.deployment_branch_policy.custom_branch_policies == false' \
  "Checkout trusted master workflow source"
assert_before 'repos/${GITHUB_REPOSITORY}/environments/workforce-os-production/secrets/${name}' \
  "Checkout trusted master workflow source"
assert_before "Checkout trusted master workflow source" "Verify trusted master workflow source"
assert_before "release-control/scripts/verify-production-release-workflow.sh" "Verify exact release CI"
assert_before "Verify exact release CI" "Checkout exact release candidate"
assert_before "Checkout exact release candidate" "Materialize exact release candidate"
assert_before "Materialize exact release candidate" "Verify reviewed migration signer pin"
assert_before "Verify reviewed migration signer pin" "azure/login@"
assert_before "azure/login@" "Verify Azure production identity"
assert_before "Verify Azure production identity" "Decode protected migration evidence and release"
assert_before "unset MIGRATION_RECEIPT_B64" "scripts/deploy-prod.sh"

echo "Protected production release workflow source verified: ${WORKFLOW}"
