#!/usr/bin/env bash

# Statically enforce the protected, build-only backend candidate workflow.
# Its only cloud mutation is one exact-source ACR build; Container Apps,
# databases, storage, DNS, and production configuration are outside its scope.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
WORKFLOW="${1:-${REPO_ROOT}/.github/workflows/build-production-candidate.yml}"

fail() {
  echo "ERROR: production candidate-build workflow contract failed: $*" >&2
  exit 1
}

if [[ $# -gt 1 ]]; then
  echo "Usage: $0 [build-production-candidate.yml]" >&2
  exit 2
fi
[[ -f "${WORKFLOW}" && ! -L "${WORKFLOW}" ]] ||
  fail "workflow must be a regular non-symlink file"

require_literal() {
  grep -Fq -- "$1" "${WORKFLOW}" || fail "missing required workflow source: $1"
}

reject_pattern() {
  if grep -Eq -- "$1" "${WORKFLOW}"; then fail "$2"; fi
}

line_of() {
  local line
  line="$(awk -v value="$1" 'index($0, value) { print NR; exit }' "${WORKFLOW}")"
  [[ -n "${line}" ]] || fail "missing ordered workflow source: $1"
  printf '%s\n' "${line}"
}

assert_before() {
  [[ $(line_of "$1") -lt $(line_of "$2") ]] ||
    fail "expected '$1' before '$2'"
}

TOP_LEVEL="$(awk 'NF && /^[^[:space:]#]/ { value=$0; sub(/:.*/, "", value); print value }' \
  "${WORKFLOW}")"
[[ "${TOP_LEVEL}" == $'name\non\npermissions\nconcurrency\njobs' ]] ||
  fail "top-level workflow keys differ from the reviewed set"

TRIGGERS="$(awk '
  $0 == "on:" { inside = 1; next }
  inside && /^[^[:space:]#]/ { exit }
  inside && /^  [A-Za-z0-9_-]+:/ {
    value=$0; sub(/^  /, "", value); sub(/:.*/, "", value); print value
  }
' "${WORKFLOW}")"
[[ "${TRIGGERS}" == "workflow_dispatch" ]] ||
  fail "workflow_dispatch must be the only trigger"

PERMISSIONS="$(awk '
  $0 == "permissions:" { inside = 1; next }
  inside && /^[^[:space:]#]/ { exit }
  inside && /^  [A-Za-z0-9_-]+:/ {
    value=$0; sub(/^  /, "", value); gsub(/:[[:space:]]*/, "=", value); print value
  }
' "${WORKFLOW}")"
[[ "${PERMISSIONS}" == $'actions=read\ncontents=read\ndeployments=read\nid-token=write' ]] ||
  fail "workflow permissions differ from the build-only set"

STEP_NAMES="$(awk '
  /^      - name: / {
    value=$0; sub(/^      - name: /, "", value); print value
  }
' "${WORKFLOW}")"
[[ "${STEP_NAMES}" == $'Audit protected build authority\nCheckout exact protected source\nVerify candidate-build workflow source\nVerify exact-commit GitHub CI\nMaterialize private exact-commit build context\nAuthenticate build-only Azure identity\nVerify build-only Azure identity\nBuild and verify immutable backend artifact\nUpload sanitized backend artifact evidence\nRemove private build context' ]] ||
  fail "workflow steps differ from the exact reviewed build-only sequence"

require_literal '  group: workforce-os-production-build-backend'
require_literal '  cancel-in-progress: false'
require_literal '    environment: workforce-os-production-build'
require_literal '    timeout-minutes: 90'
require_literal '"${GITHUB_REF}" != "refs/heads/master"'
require_literal '"${REF_PROTECTED}" != "true"'
require_literal '"${CONFIRMATION}" != "BUILD WORKFORCE OS BACKEND CANDIDATE"'
require_literal 'azure_client_id="f0c078a3-dd62-4494-af94-1bee946cb4a9"'
require_literal 'azure_tenant_id="d4b3813d-146f-4d03-96b8-d6e5862d58a2"'
require_literal 'azure_subscription_id="3171575e-f164-425c-9ee0-2fb10cf93884"'
require_literal 'azure_principal_object_id="4e305819-61f5-4557-a990-4b0c49631928"'
require_literal 'build_only_authority="true"'
require_literal 'client-id: ${{ steps.build_environment.outputs.azure_client_id }}'
require_literal 'tenant-id: ${{ steps.build_environment.outputs.azure_tenant_id }}'
require_literal 'subscription-id: ${{ steps.build_environment.outputs.azure_subscription_id }}'
require_literal 'ACR_BUILD_ONLY_AUTHORITY_CONFIRMED: ${{ steps.build_environment.outputs.build_only_authority }}'
require_literal 'scripts/verify-github-release-ci.sh "${SOURCE_SHA}"'
require_literal 'git -c core.hooksPath=/dev/null archive --format=tar "${SOURCE_SHA}"'
require_literal 'az acr repository show-tags'
require_literal 'if [[ "${existing}" != "0" ]]; then'
require_literal 'immutable source tag already exists; refusing to overwrite it'
require_literal 'az acr build'
require_literal "--image 'apex-api:{{.Run.ID}}'"
require_literal '--image "apex-api:${SOURCE_SHA}"'
require_literal '--build-arg "VCS_REF=${SOURCE_SHA}"'
require_literal '--file apps/api/Dockerfile'
require_literal '--platform linux/amd64'
require_literal '--no-logs'
require_literal 'az acr task show-run'
require_literal '"${BUILD_CONTEXT}/scripts/verify-registry-api-image.sh"'
require_literal '"${image}" "${SOURCE_SHA}"'
require_literal 'kind: "workforce-production-candidate-artifact"'
require_literal 'role: "api-worker"'
require_literal 'azurePrincipalObjectId: $azurePrincipalObjectId'
require_literal 'verified: true'
require_literal 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262'
require_literal 'azure/login@a457da9ea143d694b1b9c7c869ebb04ebe844ef5'
require_literal 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02'

reject_pattern '\$\{\{[[:space:]]*vars\.' \
  "repository or organization variable fallback is forbidden"
reject_pattern '\$\{\{[[:space:]]*secrets\.' \
  "backend candidate build must not consume secrets"
reject_pattern 'repos/\$\{GITHUB_REPOSITORY\}/actions/variables' \
  "repository-scoped build variables are forbidden"
reject_pattern 'repos/\$\{GITHUB_REPOSITORY\}/environments' \
  "workflow token cannot query Environment administration APIs"
reject_pattern 'continue-on-error[[:space:]]*:[[:space:]]*true' \
  "continue-on-error is forbidden"
reject_pattern 'uses:[[:space:]]+[^[:space:]@]+@(main|master|v[0-9]+)([[:space:]#]|$)' \
  "mutable action references are forbidden"
reject_pattern '^[[:space:]]+(container|services|strategy|defaults):' \
  "unreviewed job execution indirection is forbidden"
reject_pattern 'az[[:space:]]+(containerapp|group|resource|storage|postgres|redis|network|cdn|apim)' \
  "candidate build workflow must not access mutable production services"
reject_pattern 'az[[:space:]]+acr[[:space:]]+(repository|manifest)[[:space:]]+delete' \
  "candidate build workflow must not delete registry state"
reject_pattern '(kubectl|helm|terraform|bicep|az deployment)[[:space:]]' \
  "candidate build workflow contains an unreviewed deployment tool"

assert_before 'Audit protected build authority' 'Checkout exact protected source'
assert_before 'Verify exact-commit GitHub CI' 'Materialize private exact-commit build context'
assert_before 'Materialize private exact-commit build context' 'Authenticate build-only Azure identity'
assert_before 'Verify build-only Azure identity' 'az acr build'
assert_before 'az acr repository show-tags' 'az acr build'
assert_before 'az acr build' 'verify-registry-api-image.sh'
assert_before 'verify-registry-api-image.sh' 'Upload sanitized backend artifact evidence'

printf 'Production backend candidate-build workflow contract verified\n'
