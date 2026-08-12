#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEMP_DIRS=()
TESTS_PASSED=0

cleanup() {
  local dir
  set +u
  for dir in "${TEMP_DIRS[@]}"; do
    rm -rf -- "${dir}"
  done
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

pass() {
  TESTS_PASSED=$((TESTS_PASSED + 1))
}

assert_log_contains() {
  local log_file=$1
  local expected=$2
  grep -Fq -- "${expected}" "${log_file}" || fail "missing log entry: ${expected}"
}

assert_log_excludes() {
  local log_file=$1
  local forbidden=$2
  if grep -Fq -- "${forbidden}" "${log_file}"; then
    fail "unexpected log entry: ${forbidden}"
  fi
}

assert_before() {
  local log_file=$1
  local first=$2
  local second=$3
  local first_line second_line
  first_line="$(grep -nF -- "${first}" "${log_file}" | head -n 1 | cut -d: -f1)"
  second_line="$(grep -nF -- "${second}" "${log_file}" | head -n 1 | cut -d: -f1)"
  [[ -n "${first_line}" && -n "${second_line}" && ${first_line} -lt ${second_line} ]] ||
    fail "expected '${first}' before '${second}'"
}

make_registry_harness() {
  HARNESS="$(mktemp -d)"
  TEMP_DIRS+=("${HARNESS}")
  mkdir -p "${HARNESS}/bin" "${HARNESS}/scripts"
  cp "${REPO_ROOT}/scripts/verify-registry-api-image.sh" "${HARNESS}/scripts/"

  cat >"${HARNESS}/scripts/verify-api-image.sh" <<'EOF'
#!/usr/bin/env bash
printf 'verify-api-image %s %s\n' "$1" "$2" >>"${CALL_LOG}"
exit "${FAKE_VERIFY_STATUS:-0}"
EOF

  cat >"${HARNESS}/bin/az" <<'EOF'
#!/usr/bin/env bash
printf 'az' >>"${CALL_LOG}"
printf ' %s' "$@" >>"${CALL_LOG}"
printf '\n' >>"${CALL_LOG}"
EOF

  cat >"${HARNESS}/bin/docker" <<'EOF'
#!/usr/bin/env bash
printf 'docker' >>"${CALL_LOG}"
printf ' %s' "$@" >>"${CALL_LOG}"
printf '\n' >>"${CALL_LOG}"

if [[ "${1:-}" == "info" ]]; then
  exit "${FAKE_DOCKER_INFO_STATUS:-0}"
fi
if [[ "${1:-}" == "pull" ]]; then
  exit 0
fi
if [[ "${1:-}" == "image" && "${2:-}" == "inspect" ]]; then
  case "$*" in
    *RepoDigests*) printf '%s\n' "${FAKE_REPO_DIGEST:-${EXPECTED_IMAGE}}" ;;
    *Architecture*) printf '%s\n' "${FAKE_PLATFORM:-linux/amd64}" ;;
    *) exit 1 ;;
  esac
  exit 0
fi
exit 1
EOF

  chmod +x "${HARNESS}/bin/az" "${HARNESS}/bin/docker" \
    "${HARNESS}/scripts/verify-api-image.sh" \
    "${HARNESS}/scripts/verify-registry-api-image.sh"
  CALL_LOG="${HARNESS}/calls.log"
  : >"${CALL_LOG}"
}

test_registry_verifier() {
  local image revision wrong_digest
  image="ledgracr.azurecr.io/apex-api@sha256:$(printf 'a%.0s' {1..64})"
  revision="$(printf 'b%.0s' {1..40})"
  wrong_digest="ledgracr.azurecr.io/apex-api@sha256:$(printf 'c%.0s' {1..64})"
  make_registry_harness

  env PATH="${HARNESS}/bin:${PATH}" CALL_LOG="${CALL_LOG}" EXPECTED_IMAGE="${image}" \
    "${HARNESS}/scripts/verify-registry-api-image.sh" "${image}" "${revision}" >/dev/null
  assert_log_contains "${CALL_LOG}" "az acr login --name ledgracr --output none"
  assert_log_contains "${CALL_LOG}" "docker pull --platform linux/amd64 ${image}"
  assert_log_contains "${CALL_LOG}" "verify-api-image ${image} ${revision}"
  assert_before "${CALL_LOG}" "docker pull --platform linux/amd64" "verify-api-image"
  pass

  : >"${CALL_LOG}"
  if env PATH="${HARNESS}/bin:${PATH}" CALL_LOG="${CALL_LOG}" EXPECTED_IMAGE="${image}" \
    "${HARNESS}/scripts/verify-registry-api-image.sh" \
    "ledgracr.azurecr.io/apex-api:${revision}" "${revision}" >/dev/null 2>&1; then
    fail "registry verifier accepted a mutable tag"
  fi
  assert_log_excludes "${CALL_LOG}" "az "
  pass

  : >"${CALL_LOG}"
  if env PATH="${HARNESS}/bin:${PATH}" CALL_LOG="${CALL_LOG}" EXPECTED_IMAGE="${image}" \
    FAKE_REPO_DIGEST="${wrong_digest}" \
    "${HARNESS}/scripts/verify-registry-api-image.sh" "${image}" "${revision}" >/dev/null 2>&1; then
    fail "registry verifier accepted a mismatched RepoDigest"
  fi
  assert_log_excludes "${CALL_LOG}" "verify-api-image"
  pass

  : >"${CALL_LOG}"
  if env PATH="${HARNESS}/bin:${PATH}" CALL_LOG="${CALL_LOG}" EXPECTED_IMAGE="${image}" \
    FAKE_PLATFORM="linux/arm64" \
    "${HARNESS}/scripts/verify-registry-api-image.sh" "${image}" "${revision}" >/dev/null 2>&1; then
    fail "registry verifier accepted the wrong runtime platform"
  fi
  assert_log_excludes "${CALL_LOG}" "verify-api-image"
  pass
}

make_deploy_harness() {
  HARNESS="$(mktemp -d)"
  TEMP_DIRS+=("${HARNESS}")
  mkdir -p "${HARNESS}/bin" "${HARNESS}/repo/scripts"
  cp "${REPO_ROOT}/scripts/deploy-prod.sh" "${HARNESS}/repo/scripts/"

  cat >"${HARNESS}/repo/scripts/verify-registry-api-image.sh" <<'EOF'
#!/usr/bin/env bash
printf 'verify-registry %s %s\n' "$1" "$2" >>"${CALL_LOG}"
exit "${FAKE_VERIFY_STATUS:-0}"
EOF

  cat >"${HARNESS}/repo/scripts/verify-github-release-ci.sh" <<'EOF'
#!/usr/bin/env bash
printf 'verify-ci %s\n' "$1" >>"${CALL_LOG}"
exit "${FAKE_CI_STATUS:-0}"
EOF

  cat >"${HARNESS}/repo/scripts/verify-migration-release-receipt.sh" <<'EOF'
#!/usr/bin/env bash
printf 'verify-migrations %s %s %s %s\n' "$1" "$2" "$3" "$4" >>"${CALL_LOG}"
exit "${FAKE_MIGRATION_STATUS:-0}"
EOF

  cat >"${HARNESS}/repo/scripts/verify-containerapp-release-config.sh" <<'EOF'
#!/usr/bin/env bash
config_call=0
if [[ -s "${CONFIG_CALL_COUNT}" ]]; then
  config_call="$(cat "${CONFIG_CALL_COUNT}")"
fi
config_call=$((config_call + 1))
printf '%s\n' "${config_call}" >"${CONFIG_CALL_COUNT}"
printf 'verify-containerapps %s %s\n' "${1:-}" "${2:-}" >>"${CALL_LOG}"
if [[ -n "${FAKE_CONFIG_FAIL_CALL:-}" && "${config_call}" == "${FAKE_CONFIG_FAIL_CALL}" ]]; then
  exit "${FAKE_CONFIG_FAIL_STATUS:-1}"
fi
if [[ -n "${FAKE_CONFIG_FAIL_FROM_CALL:-}" &&
  ${config_call} -ge ${FAKE_CONFIG_FAIL_FROM_CALL} ]]; then
  exit "${FAKE_CONFIG_FAIL_STATUS:-1}"
fi
exit "${FAKE_CONFIG_STATUS:-0}"
EOF

  cat >"${HARNESS}/bin/git" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == "archive" && "${2:-}" == "--format=tar" ]]; then
  tar -cf - --files-from /dev/null
  exit 0
fi
case "${1:-} ${2:-} ${3:-}" in
  "rev-parse --show-toplevel ") printf '%s\n' "${FAKE_REPO_ROOT}" ;;
  "rev-parse --abbrev-ref HEAD") printf '%s\n' "${FAKE_BRANCH}" ;;
  "rev-parse HEAD ") printf '%s\n' "${FAKE_COMMIT}" ;;
  "status --porcelain ") exit 0 ;;
  "status --short ") exit 0 ;;
  "ls-remote --exit-code origin") printf '%s\trefs/heads/%s\n' "${FAKE_REMOTE_COMMIT}" "${FAKE_BRANCH}" ;;
  *) printf 'unexpected git invocation: %s\n' "$*" >&2; exit 1 ;;
esac
EOF

  cat >"${HARNESS}/bin/docker" <<'EOF'
#!/usr/bin/env bash
printf 'docker %s\n' "$*" >>"${CALL_LOG}"
[[ "${1:-}" == "info" ]]
EOF

  cat >"${HARNESS}/bin/gh" <<'EOF'
#!/usr/bin/env bash
printf 'gh %s\n' "$*" >>"${CALL_LOG}"
if [[ "$*" == *"--method POST"* ]]; then
  exit "${FAKE_LOCK_STATUS:-0}"
fi
if [[ "$*" == *"--jq .object.sha"* ]]; then
  printf '%s\n' "${FAKE_COMMIT}"
  exit 0
fi
if [[ "$*" == *"--method DELETE"* ]]; then
  exit 0
fi
exit 1
EOF

  cat >"${HARNESS}/bin/az" <<'EOF'
#!/usr/bin/env bash
printf 'az' >>"${CALL_LOG}"
printf ' %s' "$@" >>"${CALL_LOG}"
printf '\n' >>"${CALL_LOG}"

argument() {
  local wanted=$1
  shift
  while [[ $# -gt 0 ]]; do
    if [[ "$1" == "${wanted}" ]]; then
      printf '%s\n' "${2:-}"
      return 0
    fi
    shift
  done
  return 1
}

if [[ "${1:-} ${2:-}" == "acr build" ]]; then
  printf '%s\n' "${FAKE_RUN_ID}"
  exit 0
fi
if [[ "${1:-} ${2:-} ${3:-}" == "acr task show-run" ]]; then
  query="$(argument --query "$@")"
  if [[ "${query}" == "status" ]]; then
    printf '%s\n' "Succeeded"
  else
    printf '%s\n' "${FAKE_DIGEST}"
  fi
  exit 0
fi
if [[ "${1:-} ${2:-}" == "containerapp update" ]]; then
  app="$(argument --name "$@")"
  image="$(argument --image "$@")"
  printf '%s\t%s\n' "${app}" "${image}" >>"${AZ_STATE}"
  if [[ -n "${FAKE_SIGNAL_APP:-}" && "${app}" == "${FAKE_SIGNAL_APP}" &&
    "${image}" == "${FAKE_SIGNAL_IMAGE:-}" ]]; then
    printf 'signal-ready %s after %s update\n' "${FAKE_SIGNAL_NAME}" "${app}" >>"${CALL_LOG}"
    : >"${SIGNAL_READY_FILE}"
    while [[ ! -e "${SIGNAL_CONTINUE_FILE}" ]]; do
      sleep 0.05
    done
  fi
  exit 0
fi
if [[ "${1:-} ${2:-}" == "containerapp show" ]]; then
  printf '%s\n' "${PPID}" >"${DEPLOY_PID_FILE}"
  app="$(argument --name "$@")"
  show_call=0
  if [[ -s "${SHOW_CALL_COUNT}" ]]; then
    show_call="$(cat "${SHOW_CALL_COUNT}")"
  fi
  show_call=$((show_call + 1))
  printf '%s\n' "${show_call}" >"${SHOW_CALL_COUNT}"
  if [[ -n "${FAKE_CONCURRENT_APP:-}" && "${app}" == "${FAKE_CONCURRENT_APP}" &&
    ${show_call} -gt ${FAKE_CONCURRENT_AFTER_SHOW:-2} ]]; then
    printf 'concurrent-image %s %s\n' "${app}" "${FAKE_CONCURRENT_IMAGE}" >>"${CALL_LOG}"
    printf '%s\n' "${FAKE_CONCURRENT_IMAGE}"
    exit 0
  fi
  current="$(awk -F '\t' -v app="${app}" '$1 == app { value=$2 } END { print value }' "${AZ_STATE}")"
  if [[ -n "${current}" ]]; then
    printf '%s\n' "${current}"
  elif [[ "${app}" == "apex-gtm-api" ]]; then
    printf '%s\n' "${FAKE_PREVIOUS_API_IMAGE}"
  else
    printf '%s\n' "${FAKE_PREVIOUS_WORKER_IMAGE}"
  fi
  exit 0
fi
exit 1
EOF

  chmod +x "${HARNESS}/bin/git" "${HARNESS}/bin/docker" "${HARNESS}/bin/gh" "${HARNESS}/bin/az" \
    "${HARNESS}/repo/scripts/deploy-prod.sh" \
    "${HARNESS}/repo/scripts/verify-registry-api-image.sh" \
    "${HARNESS}/repo/scripts/verify-github-release-ci.sh" \
    "${HARNESS}/repo/scripts/verify-migration-release-receipt.sh" \
    "${HARNESS}/repo/scripts/verify-containerapp-release-config.sh"
  CALL_LOG="${HARNESS}/calls.log"
  AZ_STATE="${HARNESS}/az-state.tsv"
  CONFIG_CALL_COUNT="${HARNESS}/config-call-count"
  SHOW_CALL_COUNT="${HARNESS}/show-call-count"
  DEPLOY_PID_FILE="${HARNESS}/deploy.pid"
  SIGNAL_READY_FILE="${HARNESS}/signal-ready"
  SIGNAL_CONTINUE_FILE="${HARNESS}/signal-continue"
  touch "${HARNESS}/receipt.json"
  touch "${HARNESS}/receipt.json.sig" "${HARNESS}/allowed-signers"
  : >"${CALL_LOG}"
  : >"${AZ_STATE}"
  printf '0\n' >"${CONFIG_CALL_COUNT}"
  printf '0\n' >"${SHOW_CALL_COUNT}"
}

run_fake_deploy() {
  local deploy_status
  env PATH="${HARNESS}/bin:${PATH}" \
    CALL_LOG="${CALL_LOG}" \
    AZ_STATE="${AZ_STATE}" \
    CONFIG_CALL_COUNT="${CONFIG_CALL_COUNT}" \
    SHOW_CALL_COUNT="${SHOW_CALL_COUNT}" \
    DEPLOY_PID_FILE="${DEPLOY_PID_FILE}" \
    SIGNAL_READY_FILE="${SIGNAL_READY_FILE}" \
    SIGNAL_CONTINUE_FILE="${SIGNAL_CONTINUE_FILE}" \
    FAKE_REPO_ROOT="${HARNESS}/repo" \
    FAKE_BRANCH="${FAKE_BRANCH}" \
    FAKE_COMMIT="${FAKE_COMMIT}" \
    FAKE_REMOTE_COMMIT="${FAKE_REMOTE_COMMIT}" \
    FAKE_RUN_ID="${FAKE_RUN_ID}" \
    FAKE_DIGEST="${FAKE_DIGEST}" \
    FAKE_VERIFY_STATUS="${FAKE_VERIFY_STATUS:-0}" \
    FAKE_CI_STATUS="${FAKE_CI_STATUS:-0}" \
    FAKE_MIGRATION_STATUS="${FAKE_MIGRATION_STATUS:-0}" \
    FAKE_LOCK_STATUS="${FAKE_LOCK_STATUS:-0}" \
    FAKE_CONFIG_STATUS="${FAKE_CONFIG_STATUS:-0}" \
    FAKE_CONFIG_FAIL_CALL="${FAKE_CONFIG_FAIL_CALL:-}" \
    FAKE_CONFIG_FAIL_FROM_CALL="${FAKE_CONFIG_FAIL_FROM_CALL:-}" \
    FAKE_CONFIG_FAIL_STATUS="${FAKE_CONFIG_FAIL_STATUS:-1}" \
    FAKE_SIGNAL_APP="${FAKE_SIGNAL_APP:-}" \
    FAKE_SIGNAL_IMAGE="${FAKE_SIGNAL_IMAGE:-}" \
    FAKE_SIGNAL_NAME="${FAKE_SIGNAL_NAME:-TERM}" \
    FAKE_CONCURRENT_APP="${FAKE_CONCURRENT_APP:-}" \
    FAKE_CONCURRENT_IMAGE="${FAKE_CONCURRENT_IMAGE:-}" \
    FAKE_CONCURRENT_AFTER_SHOW="${FAKE_CONCURRENT_AFTER_SHOW:-2}" \
    FAKE_PREVIOUS_API_IMAGE="ledgracr.azurecr.io/apex-api@sha256:$(printf 'd%.0s' {1..64})" \
    FAKE_PREVIOUS_WORKER_IMAGE="ledgracr.azurecr.io/apex-api@sha256:$(printf 'e%.0s' {1..64})" \
    "${HARNESS}/repo/scripts/deploy-prod.sh" \
      --migration-receipt "${HARNESS}/receipt.json" \
      --migration-signature "${HARNESS}/receipt.json.sig" \
      --migration-allowed-signers "${HARNESS}/allowed-signers" \
      --yes
  deploy_status=$?
  return "${deploy_status}"
}

reset_deploy_harness() {
  : >"${CALL_LOG}"
  : >"${AZ_STATE}"
  printf '0\n' >"${CONFIG_CALL_COUNT}"
  FAKE_LOCK_STATUS=0
  FAKE_CONFIG_FAIL_FROM_CALL=""
  printf '0\n' >"${SHOW_CALL_COUNT}"
  rm -f -- "${DEPLOY_PID_FILE}" "${SIGNAL_READY_FILE}" "${SIGNAL_CONTINUE_FILE}"
}

test_deploy_admission() {
  local requested_image
  make_deploy_harness
  FAKE_BRANCH="release/go-live-test"
  FAKE_COMMIT="$(printf '1%.0s' {1..40})"
  FAKE_REMOTE_COMMIT="${FAKE_COMMIT}"
  FAKE_RUN_ID="ca123"
  FAKE_DIGEST="sha256:$(printf '2%.0s' {1..64})"
  FAKE_VERIFY_STATUS=0
  requested_image="ledgracr.azurecr.io/apex-api@${FAKE_DIGEST}"

  run_fake_deploy >/dev/null
  assert_log_contains "${CALL_LOG}" "verify-ci ${FAKE_COMMIT}"
  assert_log_contains "${CALL_LOG}" "verify-migrations ${HARNESS}/receipt.json ${HARNESS}/receipt.json.sig ${HARNESS}/allowed-signers ${FAKE_COMMIT}"
  assert_log_contains "${CALL_LOG}" "az acr task show-run --registry ledgracr --run-id ${FAKE_RUN_ID}"
  assert_log_contains "${CALL_LOG}" "verify-registry ${requested_image} ${FAKE_COMMIT}"
  assert_log_contains "${CALL_LOG}" "gh api --method POST repos/Kloudedge-apex/apex-product/git/refs"
  assert_log_contains "${CALL_LOG}" "gh api --method DELETE repos/Kloudedge-apex/apex-product/git/refs/heads/workforce-os-release-lock/production-gtm-platform"
  assert_before "${CALL_LOG}" "gh api --method POST" "az containerapp show"
  assert_log_contains "${CALL_LOG}" "az containerapp update --name apex-gtm-worker"
  assert_log_contains "${CALL_LOG}" "az containerapp update --name apex-gtm-api"
  assert_before "${CALL_LOG}" "verify-registry" "az containerapp update"
  assert_before "${CALL_LOG}" "az containerapp update --name apex-gtm-worker" \
    "az containerapp update --name apex-gtm-api"
  pass

  reset_deploy_harness
  FAKE_LOCK_STATUS=1
  if run_fake_deploy >/dev/null 2>&1; then
    fail "deploy continued without acquiring the production release lease"
  fi
  assert_log_excludes "${CALL_LOG}" "az containerapp show"
  assert_log_excludes "${CALL_LOG}" "az acr build"
  pass

  reset_deploy_harness
  FAKE_REMOTE_COMMIT="$(printf '3%.0s' {1..40})"
  if run_fake_deploy >/dev/null 2>&1; then
    fail "deploy accepted an unpublished local commit"
  fi
  assert_log_excludes "${CALL_LOG}" "az acr build"
  pass

  reset_deploy_harness
  FAKE_REMOTE_COMMIT="${FAKE_COMMIT}"
  FAKE_VERIFY_STATUS=1
  if run_fake_deploy >/dev/null 2>&1; then
    fail "deploy continued after exact registry verification failed"
  fi
  assert_log_excludes "${CALL_LOG}" "az containerapp update"
  pass

  reset_deploy_harness
  FAKE_VERIFY_STATUS=0
  FAKE_CONCURRENT_APP="apex-gtm-api"
  FAKE_CONCURRENT_IMAGE="ledgracr.azurecr.io/apex-api@sha256:$(printf '9%.0s' {1..64})"
  if run_fake_deploy >/dev/null 2>&1; then
    fail "deploy overwrote a concurrent production image change"
  fi
  assert_log_contains "${CALL_LOG}" \
    "concurrent-image apex-gtm-api ${FAKE_CONCURRENT_IMAGE}"
  assert_log_excludes "${CALL_LOG}" "az containerapp update"
  pass

  reset_deploy_harness
  FAKE_CONCURRENT_APP=""
  FAKE_CONCURRENT_IMAGE=""
  FAKE_BRANCH="master"
  if run_fake_deploy >/dev/null 2>&1; then
    fail "deploy accepted a non-release branch"
  fi
  assert_log_excludes "${CALL_LOG}" "az "
  pass
}

test_deploy_rollback() {
  local requested_image previous_api_image previous_worker_image rollout_status
  local deploy_job deploy_pid signal_ready
  local forward_api forward_worker rollback_api rollback_worker
  make_deploy_harness
  FAKE_BRANCH="release/go-live-test"
  FAKE_COMMIT="$(printf '1%.0s' {1..40})"
  FAKE_REMOTE_COMMIT="${FAKE_COMMIT}"
  FAKE_RUN_ID="ca123"
  FAKE_DIGEST="sha256:$(printf '2%.0s' {1..64})"
  FAKE_VERIFY_STATUS=0
  FAKE_CONFIG_STATUS=0
  requested_image="ledgracr.azurecr.io/apex-api@${FAKE_DIGEST}"
  previous_api_image="ledgracr.azurecr.io/apex-api@sha256:$(printf 'd%.0s' {1..64})"
  previous_worker_image="ledgracr.azurecr.io/apex-api@sha256:$(printf 'e%.0s' {1..64})"
  forward_worker="az containerapp update --name apex-gtm-worker --resource-group Ledgr-prod --image ${requested_image} --output none"
  forward_api="az containerapp update --name apex-gtm-api --resource-group Ledgr-prod --image ${requested_image} --output none"
  rollback_worker="az containerapp update --name apex-gtm-worker --resource-group Ledgr-prod --image ${previous_worker_image} --output none"
  rollback_api="az containerapp update --name apex-gtm-api --resource-group Ledgr-prod --image ${previous_api_image} --output none"

  # A failed read-back after the worker mutation must restore the worker and
  # leave the API untouched.
  FAKE_CONFIG_FAIL_CALL=3
  if run_fake_deploy >/dev/null 2>&1; then
    fail "deploy succeeded after worker post-update verification failed"
  fi
  assert_log_contains "${CALL_LOG}" "${forward_worker}"
  assert_log_contains "${CALL_LOG}" "${rollback_worker}"
  assert_log_excludes "${CALL_LOG}" "az containerapp update --name apex-gtm-api"
  assert_before "${CALL_LOG}" "${forward_worker}" "${rollback_worker}"
  assert_log_contains "${CALL_LOG}" "verify-containerapps ${previous_api_image} ${previous_worker_image}"
  assert_log_excludes "${CALL_LOG}" "gh api --method DELETE repos/Kloudedge-apex/apex-product/git/refs/heads/workforce-os-release-lock/production-gtm-platform"
  pass

  # If rollback read-back also fails, production state is uncertain and the
  # lease must remain in place for explicit investigation.
  reset_deploy_harness
  FAKE_CONFIG_FAIL_CALL=""
  FAKE_CONFIG_FAIL_FROM_CALL=3
  if run_fake_deploy >/dev/null 2>&1; then
    fail "deploy succeeded after rollout and rollback verification both failed"
  fi
  assert_log_contains "${CALL_LOG}" "${forward_worker}"
  assert_log_contains "${CALL_LOG}" "${rollback_worker}"
  assert_log_excludes "${CALL_LOG}" "gh api --method DELETE repos/Kloudedge-apex/apex-product/git/refs/heads/workforce-os-release-lock/production-gtm-platform"
  pass

  # A failed final read-back must restore API first, worker second, and verify
  # the two captured immutable references.
  reset_deploy_harness
  FAKE_CONFIG_FAIL_FROM_CALL=""
  FAKE_CONFIG_FAIL_CALL=4
  if run_fake_deploy >/dev/null 2>&1; then
    fail "deploy succeeded after final post-update verification failed"
  fi
  assert_log_contains "${CALL_LOG}" "${forward_worker}"
  assert_log_contains "${CALL_LOG}" "${forward_api}"
  assert_log_contains "${CALL_LOG}" "${rollback_api}"
  assert_log_contains "${CALL_LOG}" "${rollback_worker}"
  assert_before "${CALL_LOG}" "${forward_api}" "${rollback_api}"
  assert_before "${CALL_LOG}" "${rollback_api}" "${rollback_worker}"
  assert_log_contains "${CALL_LOG}" "verify-containerapps ${previous_api_image} ${previous_worker_image}"
  pass

  # TERM is not an ERR condition in Bash. The explicit signal trap must still
  # restore a worker mutation and preserve the conventional 143 exit status.
  reset_deploy_harness
  FAKE_CONFIG_FAIL_CALL=""
  FAKE_SIGNAL_APP="apex-gtm-worker"
  FAKE_SIGNAL_IMAGE="${requested_image}"
  FAKE_SIGNAL_NAME="TERM"
  (trap - EXIT; run_fake_deploy >"${HARNESS}/signal-output.log" 2>&1) &
  deploy_job=$!
  signal_ready="false"
  for _ in {1..200}; do
    if [[ -s "${DEPLOY_PID_FILE}" && -e "${SIGNAL_READY_FILE}" ]]; then
      signal_ready="true"
      break
    fi
    sleep 0.05
  done
  if [[ "${signal_ready}" != "true" ]]; then
    : >"${SIGNAL_CONTINUE_FILE}"
    kill "${deploy_job}" >/dev/null 2>&1 || true
    wait "${deploy_job}" >/dev/null 2>&1 || true
    fail "deploy did not reach the signal injection point"
  fi
  deploy_pid="$(cat "${DEPLOY_PID_FILE}")"
  if [[ "${deploy_pid}" == "$$" ]]; then
    fail "signal harness resolved the test runner instead of the deploy process"
  fi
  kill -s TERM "${deploy_pid}"
  : >"${SIGNAL_CONTINUE_FILE}"
  if wait "${deploy_job}"; then
    fail "deploy succeeded after receiving TERM during rollout"
  else
    rollout_status=$?
  fi
  if [[ ${rollout_status} -ne 143 ]]; then
    fail "TERM rollout exited ${rollout_status}, expected 143"
  fi
  assert_log_contains "${CALL_LOG}" "signal-ready TERM after apex-gtm-worker update"
  assert_log_contains "${CALL_LOG}" "${forward_worker}"
  assert_log_contains "${CALL_LOG}" "${rollback_worker}"
  assert_log_excludes "${CALL_LOG}" "az containerapp update --name apex-gtm-api"
  assert_before "${CALL_LOG}" "${forward_worker}" "${rollback_worker}"
  pass
}

test_no_mutable_bitbucket_deploy_path() {
  if grep -Fq -- "redeploy-current-master" "${REPO_ROOT}/bitbucket-pipelines.yml"; then
    fail "Bitbucket still exposes the mutable-tag production deploy fallback"
  fi
  if grep -Fq -- "--image apex-api:latest" "${REPO_ROOT}/bitbucket-pipelines.yml"; then
    fail "Bitbucket still builds the mutable latest deployment alias"
  fi
  if grep -Fq -- "AZURE_SP_PASSWORD" "${REPO_ROOT}/bitbucket-pipelines.yml"; then
    fail "Bitbucket still declares a stored Azure client secret"
  fi
  assert_log_contains "${REPO_ROOT}/bitbucket-pipelines.yml" "oidc: true"
  assert_log_contains "${REPO_ROOT}/bitbucket-pipelines.yml" "mcr.microsoft.com/azure-cli:2.89.1@sha256:"
  pass
}

test_github_ci_verifier() {
  local harness commit
  harness="$(mktemp -d)"
  TEMP_DIRS+=("${harness}")
  mkdir -p "${harness}/bin" "${harness}/scripts"
  cp "${REPO_ROOT}/scripts/verify-github-release-ci.sh" "${harness}/scripts/"
  commit="$(printf '4%.0s' {1..40})"

  cat >"${harness}/bin/gh" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-} ${2:-}" == "run list" ]]; then
  cat "${RUN_LIST_JSON}"
elif [[ "${1:-} ${2:-}" == "run view" ]]; then
  cat "${RUN_VIEW_JSON}"
else
  exit 1
fi
EOF
  chmod +x "${harness}/bin/gh" "${harness}/scripts/verify-github-release-ci.sh"

  jq -n --arg commit "${commit}" '[{
    databaseId: 42,
    headSha: $commit,
    status: "completed",
    conclusion: "success",
    event: "push"
  }]' >"${harness}/runs.json"
  jq -n --arg commit "${commit}" '{
    databaseId: 42,
    headSha: $commit,
    status: "completed",
    conclusion: "success",
    event: "push",
    jobs: [
      {name: "API Tests (blocking)", status: "completed", conclusion: "success"},
      {name: "Lint, Type Check & Build", status: "completed", conclusion: "success"},
      {name: "Production Image Contract", status: "completed", conclusion: "success"}
    ]
  }' >"${harness}/run.json"

  env PATH="${harness}/bin:${PATH}" RUN_LIST_JSON="${harness}/runs.json" \
    RUN_VIEW_JSON="${harness}/run.json" \
    "${harness}/scripts/verify-github-release-ci.sh" "${commit}" >/dev/null
  pass

  jq '(.jobs[] | select(.name == "Production Image Contract").conclusion) = "failure"' \
    "${harness}/run.json" >"${harness}/failed-run.json"
  if env PATH="${harness}/bin:${PATH}" RUN_LIST_JSON="${harness}/runs.json" \
    RUN_VIEW_JSON="${harness}/failed-run.json" \
    "${harness}/scripts/verify-github-release-ci.sh" "${commit}" >/dev/null 2>&1; then
    fail "GitHub CI verifier accepted a failed required job"
  fi
  pass
}

test_migration_receipt_verifier() {
  local harness commit evidence migrations_json index path pause source_hash entry
  local -a paths pauses
  harness="$(mktemp -d)"
  TEMP_DIRS+=("${harness}")
  mkdir -p "${harness}/repo/scripts"
  cp "${REPO_ROOT}/scripts/verify-migration-release-receipt.sh" "${harness}/repo/scripts/"
  paths=(
    "docs/migrations/2026-06-01_outreach-artifact-unique.sql"
    "docs/migrations/2026-08-12_conversation-store-expand.sql"
    "docs/migrations/2026-08-12_outreach-delivery-unknown-expand.sql"
    "docs/migrations/2026-08-12_conversation-reply-single-flight-expand.sql"
    "docs/migrations/2026-08-12_graph-run-activity-expand.sql"
    "docs/migrations/2026-08-12_graph-run-lifecycle-expand.sql"
  )
  pauses=("observed" "not-required" "not-required" "observed" "not-required" "observed")
  for path in "${paths[@]}"; do
    mkdir -p "${harness}/repo/$(dirname "${path}")"
    cp "${REPO_ROOT}/${path}" "${harness}/repo/${path}"
  done
  chmod +x "${harness}/repo/scripts/verify-migration-release-receipt.sh"

  ssh-keygen -q -t ed25519 -N '' -f "${harness}/approver-key"
  printf 'approver-b %s\n' "$(cat "${harness}/approver-key.pub")" \
    >"${harness}/allowed-signers"
  mkdir -p "${harness}/repo/docs/ops"
  openssl dgst -sha256 -r "${harness}/allowed-signers" | awk '{ print $1 }' \
    >"${harness}/repo/docs/ops/production-migration-allowed-signers.sha256"
  git -C "${harness}/repo" init -q
  git -C "${harness}/repo" config user.name "Release Test"
  git -C "${harness}/repo" config user.email "release-test@example.invalid"
  git -C "${harness}/repo" add docs
  git -C "${harness}/repo" commit -q -m "fixture: committed release evidence"
  commit="$(git -C "${harness}/repo" rev-parse HEAD)"
  evidence="sha256:$(printf '6%.0s' {1..64})"
  migrations_json='[]'
  for index in "${!paths[@]}"; do
    path="${paths[$index]}"
    pause="${pauses[$index]}"
    source_hash="sha256:$(openssl dgst -sha256 -r "${harness}/repo/${path}" | awk '{ print $1 }')"
    entry="$(jq -n \
      --arg path "${path}" \
      --arg hash "${source_hash}" \
      --arg pause "${pause}" \
      --arg evidence "${evidence}" '{
        path: $path,
        sha256: $hash,
        preflightPassed: true,
        applied: true,
        postconditionsPassed: true,
        writerPause: $pause,
        duplicateInventoryHash: $evidence,
        postconditionEvidenceHash: $evidence
      }')"
    migrations_json="$(jq -c --argjson entry "${entry}" '. + [$entry]' <<<"${migrations_json}")"
  done
  jq -n \
    --arg commit "${commit}" \
    --arg evidence "${evidence}" \
    --argjson migrations "${migrations_json}" '{
      schemaVersion: 1,
      environment: "production",
      candidateCommit: $commit,
      status: "applied-and-verified",
      verifiedAt: "2026-08-12T12:00:00Z",
      operator: "operator-a",
      approver: "approver-b",
      changeTicket: "change-1",
      databaseIdentityHash: $evidence,
      stagingRehearsalEvidenceHash: $evidence,
      productionApplyEvidenceHash: $evidence,
      rollbackRehearsalEvidenceHash: $evidence,
      migrations: $migrations
    }' >"${harness}/receipt.json"

  ssh-keygen -Y sign \
    -f "${harness}/approver-key" \
    -n workforce-os-migration-receipt \
    "${harness}/receipt.json" >/dev/null 2>&1

  "${harness}/repo/scripts/verify-migration-release-receipt.sh" \
    "${harness}/receipt.json" \
    "${harness}/receipt.json.sig" \
    "${harness}/allowed-signers" \
    "${commit}" >/dev/null
  pass

  printf '\n-- uncommitted attacker-controlled bytes\n' \
    >>"${harness}/repo/${paths[0]}"
  "${harness}/repo/scripts/verify-migration-release-receipt.sh" \
    "${harness}/receipt.json" \
    "${harness}/receipt.json.sig" \
    "${harness}/allowed-signers" \
    "${commit}" >/dev/null
  pass

  cp "${harness}/receipt.json" "${harness}/tampered-receipt.json"
  cp "${harness}/receipt.json.sig" "${harness}/tampered-receipt.json.sig"
  jq '.changeTicket = "change-after-signing"' \
    "${harness}/tampered-receipt.json" >"${harness}/tampered-receipt.next"
  mv "${harness}/tampered-receipt.next" "${harness}/tampered-receipt.json"
  if "${harness}/repo/scripts/verify-migration-release-receipt.sh" \
    "${harness}/tampered-receipt.json" \
    "${harness}/tampered-receipt.json.sig" \
    "${harness}/allowed-signers" \
    "${commit}" >/dev/null 2>&1; then
    fail "migration receipt verifier accepted content changed after signing"
  fi
  pass

  ssh-keygen -q -t ed25519 -N '' -f "${harness}/untrusted-approver-key"
  printf 'approver-b %s\n' "$(cat "${harness}/untrusted-approver-key.pub")" \
    >"${harness}/untrusted-allowed-signers"
  cp "${harness}/receipt.json" "${harness}/untrusted-receipt.json"
  ssh-keygen -Y sign \
    -f "${harness}/untrusted-approver-key" \
    -n workforce-os-migration-receipt \
    "${harness}/untrusted-receipt.json" >/dev/null 2>&1
  openssl dgst -sha256 -r "${harness}/untrusted-allowed-signers" | awk '{ print $1 }' \
    >"${harness}/repo/docs/ops/production-migration-allowed-signers.sha256"
  if "${harness}/repo/scripts/verify-migration-release-receipt.sh" \
    "${harness}/untrusted-receipt.json" \
    "${harness}/untrusted-receipt.json.sig" \
    "${harness}/untrusted-allowed-signers" \
    "${commit}" >/dev/null 2>&1; then
    fail "migration receipt verifier accepted a worktree-swapped approver trust root"
  fi
  pass

  jq '.migrations[2].sha256 = "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"' \
    "${harness}/receipt.json" >"${harness}/bad-receipt.json"
  ssh-keygen -Y sign \
    -f "${harness}/approver-key" \
    -n workforce-os-migration-receipt \
    "${harness}/bad-receipt.json" >/dev/null 2>&1
  if "${harness}/repo/scripts/verify-migration-release-receipt.sh" \
    "${harness}/bad-receipt.json" \
    "${harness}/bad-receipt.json.sig" \
    "${harness}/allowed-signers" \
    "${commit}" >/dev/null 2>&1; then
    fail "migration receipt verifier accepted a mismatched migration hash"
  fi
  pass


  jq '.unreviewedField = true | .migrations[0].unreviewedField = true' \
    "${harness}/receipt.json" >"${harness}/extra-field-receipt.json"
  ssh-keygen -Y sign \
    -f "${harness}/approver-key" \
    -n workforce-os-migration-receipt \
    "${harness}/extra-field-receipt.json" >/dev/null 2>&1
  if "${harness}/repo/scripts/verify-migration-release-receipt.sh" \
    "${harness}/extra-field-receipt.json" \
    "${harness}/extra-field-receipt.json.sig" \
    "${harness}/allowed-signers" \
    "${commit}" >/dev/null 2>&1; then
    fail "migration receipt verifier accepted undeclared receipt fields"
  fi
  pass
}

write_containerapp_fixture() {
  local target=$1
  local role=$2
  local image=$3
  local revision=$4
  local enabled="false"
  if [[ "${role}" == "worker" ]]; then enabled="true"; fi
  jq -n \
    --arg image "${image}" \
    --arg revision "${revision}" \
    --arg enabled "${enabled}" '{
      properties: {
        configuration: {
          activeRevisionsMode: "Single",
          ingress: (if $enabled == "true"
            then {external: false, allowInsecure: false}
            else {external: true, allowInsecure: false, targetPort: 4000, fqdn: "api.workforceos.xyz"}
          end)
        },
        latestRevisionName: $revision,
        latestReadyRevisionName: $revision,
        template: {
          scale: {minReplicas: 1, maxReplicas: 3},
          containers: [{
            image: $image,
            env: [
              {name: "NODE_ENV", value: "production"},
              {name: "REQUIRE_PRODUCTION_ENV", value: "true"},
              {name: "WORKER_ENABLED", value: $enabled},
              {name: "GRAPH_RUN_WORKER_ENABLED", value: $enabled},
              {name: "OUTREACH_WORKER_ENABLED", value: $enabled},
              {name: "SCHEDULER_ENABLED", value: "false"},
              {name: "CORS_ALLOWED_ORIGINS", value: "https://workforceos.xyz"},
              {name: "API_PUBLIC_URL", value: "https://api.workforceos.xyz"},
              {name: "OUTREACH_LIVE_FOR_ORGS", value: "org-owned-smoke"},
              {name: "OUTREACH_ALLOW_WILDCARD", value: "false"},
              {name: "CLERK_AUTHORIZED_PARTIES", value: "https://workforceos.xyz"},
              {name: "GOOGLE_CLIENT_ID", value: "gmail-client-id.apps.googleusercontent.com"},
              {name: "GMAIL_PUSH_PUBLISHER_SA", value: "gmail-push@project.iam.gserviceaccount.com"},
              {name: "DATABASE_URL", secretRef: "database-url"},
              {name: "REDIS_URL", secretRef: "redis-url"},
              {name: "CLERK_SECRET_KEY", secretRef: "clerk-secret-key"},
              {name: "ENCRYPTION_KEY", secretRef: "encryption-key"},
              {name: "ADMIN_API_KEY", secretRef: "admin-api-key"},
              {name: "GOOGLE_CLIENT_SECRET", secretRef: "google-client-secret"},
              {name: "AZURE_OPENAI_KEY", secretRef: "azure-openai-key"}
            ],
            probes: [
              {type: "Liveness", httpGet: {path: "/api/health/live", port: 4000, scheme: "HTTP"}},
              {type: "Readiness", httpGet: {
                path: (if $enabled == "true" then "/api/health/worker" else "/api/health/ready" end),
                port: 4000,
                scheme: "HTTP"
              }}
            ]
          }]
        }
      }
    }' >"${target}"
}

test_containerapp_config_verifier() {
  local harness api_image worker_image
  harness="$(mktemp -d)"
  TEMP_DIRS+=("${harness}")
  mkdir -p "${harness}/bin" "${harness}/scripts"
  cp "${REPO_ROOT}/scripts/verify-containerapp-release-config.sh" "${harness}/scripts/"
  api_image="ledgracr.azurecr.io/apex-api@sha256:$(printf '7%.0s' {1..64})"
  worker_image="ledgracr.azurecr.io/apex-api@sha256:$(printf '8%.0s' {1..64})"
  write_containerapp_fixture "${harness}/api.json" api "${api_image}" "api--1"
  write_containerapp_fixture "${harness}/worker.json" worker "${worker_image}" "worker--1"
  jq -n --arg image "${api_image}" '{properties: {
    active: true,
    healthState: "Healthy",
    provisioningState: "Provisioned",
    template: {containers: [{image: $image}]}
  }}' >"${harness}/api-revision.json"
  jq -n --arg image "${worker_image}" '{properties: {
    active: true,
    healthState: "Healthy",
    provisioningState: "Provisioned",
    template: {containers: [{image: $image}]}
  }}' >"${harness}/worker-revision.json"

  cat >"${harness}/bin/az" <<'EOF'
#!/usr/bin/env bash
name=""
previous=""
for value in "$@"; do
  if [[ "${previous}" == "--name" ]]; then name="${value}"; fi
  previous="${value}"
done
if [[ "${1:-} ${2:-}" == "containerapp show" ]]; then
  if [[ "${name}" == "apex-gtm-api" ]]; then cat "${API_JSON_FILE}"; else cat "${WORKER_JSON_FILE}"; fi
elif [[ "${1:-} ${2:-} ${3:-}" == "containerapp revision show" ]]; then
  if [[ "${name}" == "apex-gtm-api" ]]; then cat "${API_REVISION_FILE}"; else cat "${WORKER_REVISION_FILE}"; fi
else
  exit 1
fi
EOF
  chmod +x "${harness}/bin/az" "${harness}/scripts/verify-containerapp-release-config.sh"

  env PATH="${harness}/bin:${PATH}" \
    API_JSON_FILE="${harness}/api.json" WORKER_JSON_FILE="${harness}/worker.json" \
    API_REVISION_FILE="${harness}/api-revision.json" WORKER_REVISION_FILE="${harness}/worker-revision.json" \
    "${harness}/scripts/verify-containerapp-release-config.sh" \
    "${api_image}" "${worker_image}" >/dev/null
  pass

  jq '(.properties.template.containers[0].env[] | select(.name == "OUTREACH_LIVE_FOR_ORGS").value) = "different-org"' \
    "${harness}/worker.json" >"${harness}/worker-drift.json"
  if env PATH="${harness}/bin:${PATH}" \
    API_JSON_FILE="${harness}/api.json" WORKER_JSON_FILE="${harness}/worker-drift.json" \
    API_REVISION_FILE="${harness}/api-revision.json" WORKER_REVISION_FILE="${harness}/worker-revision.json" \
    "${harness}/scripts/verify-containerapp-release-config.sh" \
    "${api_image}" "${worker_image}" >/dev/null 2>&1; then
    fail "Container App verifier accepted API/worker allowlist drift"
  fi
  pass

  jq '(.properties.template.containers[0].env[] | select(.name == "OUTREACH_LIVE_FOR_ORGS").value) = "*"' \
    "${harness}/api.json" >"${harness}/api-wildcard.json"
  jq '(.properties.template.containers[0].env[] | select(.name == "OUTREACH_LIVE_FOR_ORGS").value) = "*"' \
    "${harness}/worker.json" >"${harness}/worker-wildcard.json"
  if env PATH="${harness}/bin:${PATH}" \
    API_JSON_FILE="${harness}/api-wildcard.json" WORKER_JSON_FILE="${harness}/worker-wildcard.json" \
    API_REVISION_FILE="${harness}/api-revision.json" WORKER_REVISION_FILE="${harness}/worker-revision.json" \
    "${harness}/scripts/verify-containerapp-release-config.sh" \
    "${api_image}" "${worker_image}" >/dev/null 2>&1; then
    fail "Container App verifier accepted the live-send wildcard"
  fi
  pass

  jq '(.properties.template.containers[0].env[] | select(.name == "OUTREACH_ALLOW_WILDCARD").value) = "true"' \
    "${harness}/api.json" >"${harness}/api-wildcard-escape.json"
  jq '(.properties.template.containers[0].env[] | select(.name == "OUTREACH_ALLOW_WILDCARD").value) = "true"' \
    "${harness}/worker.json" >"${harness}/worker-wildcard-escape.json"
  if env PATH="${harness}/bin:${PATH}" \
    API_JSON_FILE="${harness}/api-wildcard-escape.json" WORKER_JSON_FILE="${harness}/worker-wildcard-escape.json" \
    API_REVISION_FILE="${harness}/api-revision.json" WORKER_REVISION_FILE="${harness}/worker-revision.json" \
    "${harness}/scripts/verify-containerapp-release-config.sh" \
    "${api_image}" "${worker_image}" >/dev/null 2>&1; then
    fail "Container App verifier accepted OUTREACH_ALLOW_WILDCARD=true"
  fi
  pass

  jq '(.properties.template.containers[0].env[] | select(.name == "REQUIRE_PRODUCTION_ENV").value) = "false"' \
    "${harness}/worker.json" >"${harness}/worker-nonprod-guard.json"
  if env PATH="${harness}/bin:${PATH}" \
    API_JSON_FILE="${harness}/api.json" WORKER_JSON_FILE="${harness}/worker-nonprod-guard.json" \
    API_REVISION_FILE="${harness}/api-revision.json" WORKER_REVISION_FILE="${harness}/worker-revision.json" \
    "${harness}/scripts/verify-containerapp-release-config.sh" \
    "${api_image}" "${worker_image}" >/dev/null 2>&1; then
    fail "Container App verifier accepted REQUIRE_PRODUCTION_ENV=false"
  fi
  pass

  jq '(.properties.template.containers[0].env[] | select(.name == "CORS_ALLOWED_ORIGINS").value) = "https://drift.example"' \
    "${harness}/worker.json" >"${harness}/worker-nonsecret-drift.json"
  if env PATH="${harness}/bin:${PATH}" \
    API_JSON_FILE="${harness}/api.json" WORKER_JSON_FILE="${harness}/worker-nonsecret-drift.json" \
    API_REVISION_FILE="${harness}/api-revision.json" WORKER_REVISION_FILE="${harness}/worker-revision.json" \
    "${harness}/scripts/verify-containerapp-release-config.sh" \
    "${api_image}" "${worker_image}" >/dev/null 2>&1; then
    fail "Container App verifier accepted release-critical non-secret drift"
  fi
  pass

  jq '(.properties.template.containers[0].env[] | select(.name == "GMAIL_PUSH_PUBLISHER_SA").value) = "unexpected@project.iam.gserviceaccount.com"' \
    "${harness}/worker.json" >"${harness}/worker-push-identity-drift.json"
  if env PATH="${harness}/bin:${PATH}" \
    API_JSON_FILE="${harness}/api.json" WORKER_JSON_FILE="${harness}/worker-push-identity-drift.json" \
    API_REVISION_FILE="${harness}/api-revision.json" WORKER_REVISION_FILE="${harness}/worker-revision.json" \
    "${harness}/scripts/verify-containerapp-release-config.sh" \
    "${api_image}" "${worker_image}" >/dev/null 2>&1; then
    fail "Container App verifier accepted Gmail push identity drift"
  fi
  pass

  jq '(.properties.template.containers[0].env[] | select(.name == "ADMIN_API_KEY").secretRef) = "different-admin-api-key"' \
    "${harness}/worker.json" >"${harness}/worker-secret-ref-drift.json"
  if env PATH="${harness}/bin:${PATH}" \
    API_JSON_FILE="${harness}/api.json" WORKER_JSON_FILE="${harness}/worker-secret-ref-drift.json" \
    API_REVISION_FILE="${harness}/api-revision.json" WORKER_REVISION_FILE="${harness}/worker-revision.json" \
    "${harness}/scripts/verify-containerapp-release-config.sh" \
    "${api_image}" "${worker_image}" >/dev/null 2>&1; then
    fail "Container App verifier accepted secretRef name drift"
  fi
  pass

  jq '.properties.template.containers[0].env |= map(select(.name != "ADMIN_API_KEY"))' \
    "${harness}/api.json" >"${harness}/api-missing-required-secret.json"
  jq '.properties.template.containers[0].env |= map(select(.name != "ADMIN_API_KEY"))' \
    "${harness}/worker.json" >"${harness}/worker-missing-required-secret.json"
  if env PATH="${harness}/bin:${PATH}" \
    API_JSON_FILE="${harness}/api-missing-required-secret.json" \
    WORKER_JSON_FILE="${harness}/worker-missing-required-secret.json" \
    API_REVISION_FILE="${harness}/api-revision.json" WORKER_REVISION_FILE="${harness}/worker-revision.json" \
    "${harness}/scripts/verify-containerapp-release-config.sh" \
    "${api_image}" "${worker_image}" >/dev/null 2>&1; then
    fail "Container App verifier accepted a required secretRef missing from both roles"
  fi
  pass

  jq '.properties.template.containers[0].env += [{name: "SERPER_API_KEY", value: "inline-test-value"}]' \
    "${harness}/api.json" >"${harness}/api-inline-secret.json"
  jq '.properties.template.containers[0].env += [{name: "SERPER_API_KEY", value: "inline-test-value"}]' \
    "${harness}/worker.json" >"${harness}/worker-inline-secret.json"
  if env PATH="${harness}/bin:${PATH}" \
    API_JSON_FILE="${harness}/api-inline-secret.json" WORKER_JSON_FILE="${harness}/worker-inline-secret.json" \
    API_REVISION_FILE="${harness}/api-revision.json" WORKER_REVISION_FILE="${harness}/worker-revision.json" \
    "${harness}/scripts/verify-containerapp-release-config.sh" \
    "${api_image}" "${worker_image}" >/dev/null 2>&1; then
    fail "Container App verifier accepted an inline provider secret"
  fi
  pass

  jq '.properties.template.containers += [{name: "unreviewed-sidecar", image: "example.invalid/sidecar:latest"}]' \
    "${harness}/api.json" >"${harness}/api-sidecar.json"
  if env PATH="${harness}/bin:${PATH}" \
    API_JSON_FILE="${harness}/api-sidecar.json" WORKER_JSON_FILE="${harness}/worker.json" \
    API_REVISION_FILE="${harness}/api-revision.json" WORKER_REVISION_FILE="${harness}/worker-revision.json" \
    "${harness}/scripts/verify-containerapp-release-config.sh" \
    "${api_image}" "${worker_image}" >/dev/null 2>&1; then
    fail "Container App verifier accepted an unreviewed sidecar container"
  fi
  pass

  jq '.properties.configuration.ingress.allowInsecure = true' \
    "${harness}/api.json" >"${harness}/api-plaintext-ingress.json"
  if env PATH="${harness}/bin:${PATH}" \
    API_JSON_FILE="${harness}/api-plaintext-ingress.json" WORKER_JSON_FILE="${harness}/worker.json" \
    API_REVISION_FILE="${harness}/api-revision.json" WORKER_REVISION_FILE="${harness}/worker-revision.json" \
    "${harness}/scripts/verify-containerapp-release-config.sh" \
    "${api_image}" "${worker_image}" >/dev/null 2>&1; then
    fail "Container App verifier accepted plaintext public API ingress"
  fi
  pass

  jq '.properties.configuration.ingress.targetPort = 8080' \
    "${harness}/api.json" >"${harness}/api-wrong-ingress-port.json"
  if env PATH="${harness}/bin:${PATH}" \
    API_JSON_FILE="${harness}/api-wrong-ingress-port.json" WORKER_JSON_FILE="${harness}/worker.json" \
    API_REVISION_FILE="${harness}/api-revision.json" WORKER_REVISION_FILE="${harness}/worker-revision.json" \
    "${harness}/scripts/verify-containerapp-release-config.sh" \
    "${api_image}" "${worker_image}" >/dev/null 2>&1; then
    fail "Container App verifier accepted an incorrect public API target port"
  fi
  pass

  jq '.properties.healthState = "Unhealthy"' \
    "${harness}/worker-revision.json" >"${harness}/unhealthy-worker.json"
  if env PATH="${harness}/bin:${PATH}" \
    API_JSON_FILE="${harness}/api.json" WORKER_JSON_FILE="${harness}/worker.json" \
    API_REVISION_FILE="${harness}/api-revision.json" WORKER_REVISION_FILE="${harness}/unhealthy-worker.json" \
    "${harness}/scripts/verify-containerapp-release-config.sh" \
    "${api_image}" "${worker_image}" >/dev/null 2>&1; then
    fail "Container App verifier accepted an unhealthy active revision"
  fi
  pass
}

test_registry_verifier
test_deploy_admission
test_deploy_rollback
test_no_mutable_bitbucket_deploy_path
test_github_ci_verifier
test_migration_receipt_verifier
test_containerapp_config_verifier

echo "Release script tests passed: ${TESTS_PASSED}"
