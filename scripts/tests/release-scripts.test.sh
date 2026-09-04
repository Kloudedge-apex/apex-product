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
  if [[ -n "${CALL_LOG:-}" && -f "${CALL_LOG}" ]]; then
    tail -n 80 "${CALL_LOG}" >&2
  fi
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

assert_immediately_preceded_by() {
  local log_file=$1
  local target=$2
  local expected_previous=$3
  local target_line previous_line
  target_line="$(grep -nF -- "${target}" "${log_file}" | head -n 1 | cut -d: -f1)"
  [[ -n "${target_line}" && ${target_line} -gt 1 ]] ||
    fail "missing log entry with predecessor: ${target}"
  previous_line="$(sed -n "$((target_line - 1))p" "${log_file}")"
  [[ "${previous_line}" == *"${expected_previous}"* ]] ||
    fail "expected '${target}' immediately after '${expected_previous}', got '${previous_line}'"
}

assert_last_immediately_preceded_by() {
  local log_file=$1
  local target=$2
  local expected_previous=$3
  local target_line previous_line
  target_line="$(grep -nF -- "${target}" "${log_file}" | tail -n 1 | cut -d: -f1)"
  [[ -n "${target_line}" && ${target_line} -gt 1 ]] ||
    fail "missing final log entry with predecessor: ${target}"
  previous_line="$(sed -n "$((target_line - 1))p" "${log_file}")"
  [[ "${previous_line}" == *"${expected_previous}"* ]] ||
    fail "expected final '${target}' immediately after '${expected_previous}', got '${previous_line}'"
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
  image="workforceosprodacr.azurecr.io/apex-api@sha256:$(printf 'a%.0s' {1..64})"
  revision="$(printf 'b%.0s' {1..40})"
  wrong_digest="workforceosprodacr.azurecr.io/apex-api@sha256:$(printf 'c%.0s' {1..64})"
  make_registry_harness

  env PATH="${HARNESS}/bin:${PATH}" CALL_LOG="${CALL_LOG}" EXPECTED_IMAGE="${image}" \
    "${HARNESS}/scripts/verify-registry-api-image.sh" "${image}" "${revision}" >/dev/null
  assert_log_contains "${CALL_LOG}" "az acr login --name workforceosprodacr --output none"
  assert_log_contains "${CALL_LOG}" "docker pull --platform linux/amd64 ${image}"
  assert_log_contains "${CALL_LOG}" "verify-api-image ${image} ${revision}"
  assert_before "${CALL_LOG}" "docker pull --platform linux/amd64" "verify-api-image"
  pass

  : >"${CALL_LOG}"
  if env PATH="${HARNESS}/bin:${PATH}" CALL_LOG="${CALL_LOG}" EXPECTED_IMAGE="${image}" \
    "${HARNESS}/scripts/verify-registry-api-image.sh" \
    "workforceosprodacr.azurecr.io/apex-api:${revision}" "${revision}" >/dev/null 2>&1; then
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
  HARNESS="$(cd "${HARNESS}" && pwd -P)"
  TEMP_DIRS+=("${HARNESS}")
  mkdir -p "${HARNESS}/bin" "${HARNESS}/repo/scripts" \
    "${HARNESS}/repo/docs/ops" \
    "${HARNESS}/repo/.git/objects"
  cp "${REPO_ROOT}/scripts/deploy-prod.sh" "${HARNESS}/repo/scripts/"
  cp "${REPO_ROOT}/scripts/run-release-git.sh" "${HARNESS}/repo/scripts/"
  cp "${REPO_ROOT}/docs/ops/production-clerk-auth.sha256" \
    "${HARNESS}/repo/docs/ops/"

  # The copied controller gets a fail-closed, harness-only revocation point so
  # rollback can exercise an authority loss after the forward write. It cannot
  # make production admission more permissive and is never applied to source.
  awk '
    { print }
    /^require_exclusive_containerapp_mutation_authority\(\) \{$/ {
      print "  if [[ -n \"${FAKE_AUTHORITY_DENY_FILE:-}\" && -e \"${FAKE_AUTHORITY_DENY_FILE:-/nonexistent}\" ]]; then"
      print "    echo \"ERROR: harness revoked Container Apps mutation authority\" >&2"
      print "    return 1"
      print "  fi"
    }
  ' "${HARNESS}/repo/scripts/deploy-prod.sh" \
    >"${HARNESS}/repo/scripts/deploy-prod.sh.next"
  mv "${HARNESS}/repo/scripts/deploy-prod.sh.next" \
    "${HARNESS}/repo/scripts/deploy-prod.sh"

  cat >"${HARNESS}/repo/scripts/verify-registry-api-image.sh" <<'EOF'
#!/usr/bin/env bash
printf 'verify-registry %s %s\n' "$1" "$2" >>"${CALL_LOG}"
if [[ "${FAKE_BOOTSTRAP_SIGNAL_POINT:-}" == "verify-registry" ]]; then
  printf 'bootstrap-signal-ready verify-registry\n' >>"${CALL_LOG}"
  printf '%s\n' "${WORKFORCE_RELEASE_SNAPSHOT_PARENT_PID}" >"${BOOTSTRAP_PID_FILE}"
  printf '%s\n' "$$" >"${BOOTSTRAP_DESCENDANT_PID_FILE}"
  : >"${BOOTSTRAP_SIGNAL_READY_FILE}"
  while :; do
    sleep 0.05
  done
fi
exit "${FAKE_VERIFY_STATUS:-0}"
EOF

  cat >"${HARNESS}/repo/scripts/verify-api-image.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF

  cat >"${HARNESS}/repo/scripts/verify-github-release-ci.sh" <<'EOF'
#!/usr/bin/env bash
printf 'verify-ci %s\n' "$1" >>"${CALL_LOG}"
exit "${FAKE_CI_STATUS:-0}"
EOF

  cat >"${HARNESS}/repo/scripts/verify-migration-release-receipt.sh" <<'EOF'
#!/usr/bin/env bash
call=0
if [[ -s "${MIGRATION_CALL_COUNT}" ]]; then
  call="$(cat "${MIGRATION_CALL_COUNT}")"
fi
call=$((call + 1))
printf '%s\n' "${call}" >"${MIGRATION_CALL_COUNT}"
printf 'verify-migrations same-attempt=%s %s\n' \
  "${WORKFORCE_RELEASE_SAME_ATTEMPT_ROLLBACK:-false}" "$*" >>"${CALL_LOG}"
if [[ -n "${FAKE_MIGRATION_FAIL_CALL:-}" && "${call}" == "${FAKE_MIGRATION_FAIL_CALL}" ]]; then
  exit "${FAKE_MIGRATION_FAIL_STATUS:-1}"
fi
if [[ -n "${FAKE_MIGRATION_FRESH_EXPIRES_AFTER_CALL:-}" &&
  ${call} -ge ${FAKE_MIGRATION_FRESH_EXPIRES_AFTER_CALL} &&
  "${WORKFORCE_RELEASE_SAME_ATTEMPT_ROLLBACK:-false}" != "true" ]]; then
  exit 1
fi
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
inject_rollback_failure_state() {
  if [[ -n "${FAKE_ROLLBACK_DRIFT_APP:-}" ]]; then
    printf '%s\t%s\t%s\n' \
      "${FAKE_ROLLBACK_DRIFT_APP}" \
      "${FAKE_ROLLBACK_DRIFT_IMAGE}" \
      "${FAKE_ROLLBACK_DRIFT_APP}--external" >>"${AZ_STATE}"
  fi
  if [[ "${FAKE_AUTHORITY_FAIL_ON_ROLLBACK:-false}" == "true" ]]; then
    : >"${FAKE_AUTHORITY_DENY_FILE}"
  fi
}
if [[ -n "${FAKE_CONFIG_FAIL_CALL:-}" && "${config_call}" == "${FAKE_CONFIG_FAIL_CALL}" ]]; then
  inject_rollback_failure_state
  exit "${FAKE_CONFIG_FAIL_STATUS:-1}"
fi
if [[ -n "${FAKE_CONFIG_FAIL_FROM_CALL:-}" &&
  ${config_call} -ge ${FAKE_CONFIG_FAIL_FROM_CALL} ]]; then
  inject_rollback_failure_state
  exit "${FAKE_CONFIG_FAIL_STATUS:-1}"
fi
exit "${FAKE_CONFIG_STATUS:-0}"
EOF

  cat >"${HARNESS}/bin/git" <<'EOF'
#!/usr/bin/env bash
printf 'git %s\n' "$*" >>"${CALL_LOG}"
if env | grep -Eq '^(ALL_PROXY|CURL_CA_BUNDLE|GIT_SSL_CAINFO|GIT_SSL_CAPATH|GIT_SSL_NO_VERIFY|GIT_TRACE|GIT_TRACE2|GIT_TRACE_CURL|GIT_TRACE_PACKET|HTTPS_PROXY|HTTP_PROXY|SSL_CERT_DIR|SSL_CERT_FILE|all_proxy|http_proxy|https_proxy)='; then
  printf 'unsafe Git transport or trace environment survived isolation\n' >&2
  exit 98
fi
if [[ "${GIT_TRACE_REDACT:-}" != "1" ]]; then
  printf 'Git trace redaction was not forced\n' >&2
  exit 98
fi
while [[ "${1:-}" == "-c" &&
  ("${2:-}" == "core.attributesFile=/dev/null" || "${2:-}" == "http.sslVerify=true") ]]; do
  shift 2
done
if [[ "$*" == *" archive --format=tar ${FAKE_COMMIT}"* ]]; then
  tar -C "${FAKE_REPO_ROOT}" -cf - scripts docs/ops
  exit 0
fi
if [[ "$*" == *" init --bare --template="* ]]; then
  mkdir -p -- "${!#}/objects/info"
  exit 0
fi
if [[ "$*" == *" cat-file -e ${FAKE_COMMIT}^{commit}"* ]]; then
  exit 0
fi
if [[ "$*" == *" fetch --no-tags --depth=1 https://github.com/Kloudedge-apex/apex-product.git ${FAKE_COMMIT}"* ]]; then
  exit 0
fi
if [[ "$*" == *" rev-parse FETCH_HEAD"* ]]; then
  printf '%s\n' "${FAKE_COMMIT}"
  exit 0
fi
if [[ "$*" == *" rev-parse ${FAKE_COMMIT}^{tree}"* ]]; then
  printf '%s\n' "${FAKE_TREE_COMMIT}"
  exit 0
fi
if [[ "$*" == *" commit-tree ${FAKE_TREE_COMMIT} -p ${FAKE_COMMIT}"* ]]; then
  printf '%s\n' "${FAKE_LEASE_COMMIT}"
  exit 0
fi
if [[ "$*" == *" push "* ]]; then
  if [[ "$*" == *"--force-with-lease=refs/heads/workforce-os-release-lock/production-gtm-platform:"* &&
    "$*" == *"${FAKE_LEASE_COMMIT}:refs/heads/workforce-os-release-lock/production-gtm-platform"* ]]; then
    if [[ "${FAKE_MUTATE_SOURCE_HELPER_ON_LOCK:-false}" == "true" ]]; then
      printf '#!/usr/bin/env bash\nexit 97\n' >"${FAKE_REPO_ROOT}/scripts/verify-containerapp-release-config.sh"
    fi
    if [[ "${FAKE_SWAP_SNAPSHOT_HELPER_ON_LOCK:-false}" == "true" ]]; then
      rm -f -- "${WORKFORCE_RELEASE_SNAPSHOT_ROOT}/scripts/verify-containerapp-release-config.sh"
      ln -s "${FAKE_ESCAPED_HELPER}" \
        "${WORKFORCE_RELEASE_SNAPSHOT_ROOT}/scripts/verify-containerapp-release-config.sh"
    fi
    exit "${FAKE_LOCK_STATUS:-0}"
  fi
  if [[ "$*" == *"--force-with-lease=refs/heads/workforce-os-release-lock/production-gtm-platform:${FAKE_LEASE_COMMIT}"* &&
    "$*" == *":refs/heads/workforce-os-release-lock/production-gtm-platform"* ]]; then
    exit "${FAKE_LOCK_CLEANUP_STATUS:-0}"
  fi
fi
if [[ "$*" == "-C ${FAKE_REPO_ROOT} rev-parse --git-common-dir" ]]; then
  printf '%s\n' '.git'
  exit 0
fi
if [[ "$*" == "-C ${FAKE_REPO_ROOT} rev-parse --abbrev-ref HEAD" ]]; then
  printf '%s\n' "${FAKE_BRANCH}"
  exit 0
fi
if [[ "$*" == "-C ${FAKE_REPO_ROOT} rev-parse HEAD" ]]; then
  printf '%s\n' "${FAKE_COMMIT}"
  exit 0
fi
if [[ "$*" == "-C ${FAKE_REPO_ROOT} status --porcelain --untracked-files=all" ||
  "$*" == "-C ${FAKE_REPO_ROOT} status --short --untracked-files=all" ]]; then
  exit 0
fi
case "${1:-} ${2:-} ${3:-}" in
  "rev-parse --show-toplevel ") printf '%s\n' "${FAKE_REPO_ROOT}" ;;
  "rev-parse HEAD ") printf '%s\n' "${FAKE_COMMIT}" ;;
  *) printf 'unexpected git invocation: %s\n' "$*" >&2; exit 1 ;;
esac
EOF

  cat >"${HARNESS}/bin/docker" <<'EOF'
#!/usr/bin/env bash
printf 'docker %s\n' "$*" >>"${CALL_LOG}"
[[ "${1:-}" == "info" ]]
EOF

  cat >"${HARNESS}/escaped-config-helper.sh" <<'EOF'
#!/usr/bin/env bash
printf 'escaped-config-helper-executed\n' >>"${CALL_LOG}"
exit 0
EOF

  cat >"${HARNESS}/bin/gh" <<'EOF'
#!/usr/bin/env bash
printf 'gh %s\n' "$*" >>"${CALL_LOG}"
if env | grep -Eq '^(ALL_PROXY|CURL_CA_BUNDLE|GH_DEBUG|HTTPS_PROXY|HTTP_PROXY|SSL_CERT_DIR|SSL_CERT_FILE|all_proxy|http_proxy|https_proxy)='; then
  printf 'unsafe GitHub transport environment survived isolation\n' >&2
  exit 98
fi
if [[ "$*" == "api --hostname github.com repos/Kloudedge-apex/apex-product/git/ref/heads/${FAKE_BRANCH} --jq .object.sha" ]]; then
  printf '%s\n' "${FAKE_REMOTE_COMMIT}"
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

if [[ "${1:-} ${2:-} ${3:-} ${4:-}" == "storage blob lease acquire" ]]; then
  if [[ "${FAKE_AZURE_LEASE_ACQUIRE_STATUS:-0}" != "0" ]]; then
    exit "${FAKE_AZURE_LEASE_ACQUIRE_STATUS}"
  fi
  argument --proposed-lease-id "$@"
  exit 0
fi
if [[ "${1:-} ${2:-} ${3:-} ${4:-}" == "storage blob lease renew" ]]; then
  if [[ "${FAKE_AZURE_LEASE_RENEW_STATUS:-0}" != "0" ]]; then
    exit "${FAKE_AZURE_LEASE_RENEW_STATUS}"
  fi
  argument --lease-id "$@"
  exit 0
fi
if [[ "${1:-} ${2:-} ${3:-} ${4:-}" == "storage blob lease release" ]]; then
  exit "${FAKE_AZURE_LEASE_RELEASE_STATUS:-0}"
fi
if [[ "${1:-} ${2:-} ${3:-}" == "storage blob show" ]]; then
  if [[ "${FAKE_AZURE_LEASE_SHOW_STATUS:-0}" != "0" ]]; then
    exit "${FAKE_AZURE_LEASE_SHOW_STATUS}"
  fi
  if [[ -n "${FAKE_AZURE_LEASE_STATE:-}" ]]; then
    printf '%s\n' "${FAKE_AZURE_LEASE_STATE}"
  else
    printf '%s\n' '{"status":"unlocked","state":"available"}'
  fi
  exit 0
fi

if [[ "${1:-} ${2:-}" == "acr build" ]]; then
  build_context="${!#}"
  build_context_mode="$(stat -c '%a' "${build_context}" 2>/dev/null || true)"
  if [[ ! "${build_context_mode}" =~ ^[0-7]{3,4}$ ]]; then
    build_context_mode="$(stat -f '%Lp' "${build_context}")"
  fi
  printf 'snapshot-context %s mode %s\n' "${build_context}" "${build_context_mode}" >>"${CALL_LOG}"
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
state_value() {
  local app=$1
  local field=$2
  local value
  value="$(awk -F '\t' -v app="${app}" -v field="${field}" '$1 == app { value=$field } END { print value }' "${AZ_STATE}")"
  if [[ -n "${value}" ]]; then
    printf '%s\n' "${value}"
    return
  fi
  case "${app}:${field}" in
    apex-gtm-api:2) printf '%s\n' "${FAKE_PREVIOUS_API_IMAGE}" ;;
    apex-gtm-api:3) printf '%s\n' 'apex-gtm-api--revision' ;;
    apex-gtm-worker:2) printf '%s\n' "${FAKE_PREVIOUS_WORKER_IMAGE}" ;;
    apex-gtm-worker:3) printf '%s\n' 'apex-gtm-worker--revision' ;;
    nikxius-web:2) printf '%s\n' "${FAKE_PREVIOUS_CONSOLE_IMAGE}" ;;
    nikxius-web:3) printf '%s\n' 'nikxius-web--revision' ;;
    *) return 1 ;;
  esac
}

record_state() {
  printf '%s\t%s\t%s\n' "$1" "$2" "$3" >>"${AZ_STATE}"
}

maybe_inject_concurrent_state() {
  local app=$1
  read_call=0
  if [[ -s "${SHOW_CALL_COUNT}" ]]; then read_call="$(cat "${SHOW_CALL_COUNT}")"; fi
  read_call=$((read_call + 1))
  printf '%s\n' "${read_call}" >"${SHOW_CALL_COUNT}"
  if [[ -n "${FAKE_CONCURRENT_APP:-}" && "${app}" == "${FAKE_CONCURRENT_APP}" &&
    ${read_call} -gt ${FAKE_CONCURRENT_AFTER_SHOW:-2} &&
    "$(state_value "${app}" 3)" != "${app}--concurrent" ]]; then
    printf 'concurrent-image %s %s\n' "${app}" "${FAKE_CONCURRENT_IMAGE}" >>"${CALL_LOG}"
    record_state "${app}" "${FAKE_CONCURRENT_IMAGE}" "${app}--concurrent"
  fi
}

if [[ "${1:-} ${2:-}" == "containerapp update" ]]; then
  app="$(argument --name "$@")"
  image="$(argument --image "$@")"
  record_state "${app}" "${image}" "${app}--new"
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
if [[ "${1:-} ${2:-} ${3:-}" == "containerapp revision activate" ]]; then
  app="$(argument --name "$@")"
  revision="$(argument --revision "$@")"
  case "${app}" in
    apex-gtm-api) image="${FAKE_PREVIOUS_API_IMAGE}" ;;
    apex-gtm-worker) image="${FAKE_PREVIOUS_WORKER_IMAGE}" ;;
    *) exit 1 ;;
  esac
  record_state "${app}" "${image}" "${revision}"
  exit 0
fi
if [[ "${1:-} ${2:-} ${3:-} ${4:-}" == "containerapp ingress traffic set" ]]; then
  exit 0
fi
if [[ "${1:-} ${2:-}" == "containerapp show" ]]; then
  printf '%s\n' "${PPID}" >"${DEPLOY_PID_FILE}"
  app="$(argument --name "$@")"
  maybe_inject_concurrent_state "${app}"
  current="$(state_value "${app}" 2)"
  revision="$(state_value "${app}" 3)"
  if [[ "${app}" == "apex-gtm-api" ]]; then
    max_inactive="${FAKE_API_MAX_INACTIVE_REVISIONS:-10}"
  else
    max_inactive="${FAKE_WORKER_MAX_INACTIVE_REVISIONS:-10}"
  fi
  bootstrap_attempt="0123456789abcdef0123456789abcdef"
  bootstrap_generation="7"
  omit_bootstrap_guard="false"
  if [[ "${app}" == "${FAKE_BOOTSTRAP_GUARD_MUTATE_ON_NEW_APP:-}" &&
    "${revision}" == "${app}--new" ]]; then
    case "${FAKE_BOOTSTRAP_GUARD_MUTATION:-}" in
      missing) omit_bootstrap_guard="true" ;;
      attempt) bootstrap_attempt="ffffffffffffffffffffffffffffffff" ;;
      downgrade) bootstrap_generation="6" ;;
    esac
  fi
  jq -n \
    --arg id "/subscriptions/test-subscription/resourceGroups/workforce-os-prod/providers/Microsoft.App/containerApps/${app}" \
    --arg app "${app}" \
    --arg image "${current}" \
    --arg revision "${revision}" \
    --arg omit_max_inactive_app "${FAKE_OMIT_MAX_INACTIVE_APP:-}" \
    --arg bootstrap_attempt "${bootstrap_attempt}" \
    --arg bootstrap_generation "${bootstrap_generation}" \
    --arg omit_bootstrap_guard "${omit_bootstrap_guard}" \
    --argjson max_inactive "${max_inactive}" \
    '{
      id: $id,
      properties: {
        provisioningState: "Succeeded",
        provisioningState: "Succeeded",
        latestRevisionName: $revision,
        latestReadyRevisionName: $revision,
        configuration: ({
          activeRevisionsMode: "Single",
          ingress: (if $app == "apex-gtm-api" then {
            external: true,
            traffic: [{revisionName: $revision, latestRevision: false, weight: 100}]
          } else {external: false} end)
        } + (if $omit_max_inactive_app == $app
          then {}
          else {maxInactiveRevisions: $max_inactive}
          end)),
        template: {containers: [{
          name: $app,
          image: $image,
          env: ([{name: "OUTREACH_LIVE_FOR_ORGS", value: ""}] +
            (if $omit_bootstrap_guard == "true" then [] else [
              {name: "WORKFORCE_PRODUCTION_BOOTSTRAP_ATTEMPT_ID", value: $bootstrap_attempt},
              {name: "WORKFORCE_PRODUCTION_BOOTSTRAP_MIN_WRITER_FENCE_GENERATION", value: $bootstrap_generation}
            ] end))
        }]}
      }
    }'
  exit 0
fi
if [[ "${1:-} ${2:-} ${3:-}" == "containerapp revision list" ]]; then
  app="$(argument --name "$@")"
  maybe_inject_concurrent_state "${app}"
  current="$(state_value "${app}" 2)"
  revision="$(state_value "${app}" 3)"
  jq -n --arg revision "${revision}" --arg image "${current}" '[{
    name: $revision,
    properties: {active: true, template: {containers: [{image: $image}]}}
  }]'
  exit 0
fi
if [[ "${1:-} ${2:-} ${3:-}" == "containerapp revision show" ]]; then
  app="$(argument --name "$@")"
  requested_revision="$(argument --revision "$@")"
  maybe_inject_concurrent_state "${app}"
  active_revision="$(state_value "${app}" 3)"
  if [[ "${requested_revision}" == "${active_revision}" ]]; then
    active=true
    current="$(state_value "${app}" 2)"
  else
    if [[ "${FAKE_MISSING_RETAINED_APP:-}" == "${app}" ]]; then
      exit 1
    fi
    active=false
    case "${app}" in
      apex-gtm-api) current="${FAKE_PREVIOUS_API_IMAGE}" ;;
      apex-gtm-worker) current="${FAKE_PREVIOUS_WORKER_IMAGE}" ;;
      nikxius-web) current="${FAKE_PREVIOUS_CONSOLE_IMAGE}" ;;
      *) exit 1 ;;
    esac
    if [[ "${FAKE_CHANGED_RETAINED_APP:-}" == "${app}" ]]; then
      current="workforceosprodacr.azurecr.io/apex-api@sha256:$(printf '4%.0s' {1..64})"
    fi
  fi
  bootstrap_attempt="0123456789abcdef0123456789abcdef"
  bootstrap_generation="7"
  omit_bootstrap_guard="false"
  if [[ "${app}" == "${FAKE_BOOTSTRAP_GUARD_MUTATE_ON_NEW_APP:-}" &&
    "${requested_revision}" == "${app}--new" ]]; then
    case "${FAKE_BOOTSTRAP_GUARD_MUTATION:-}" in
      missing) omit_bootstrap_guard="true" ;;
      attempt) bootstrap_attempt="ffffffffffffffffffffffffffffffff" ;;
      downgrade) bootstrap_generation="6" ;;
    esac
  fi
  jq -n \
    --arg revision "${requested_revision}" \
    --arg image "${current}" \
    --arg bootstrap_attempt "${bootstrap_attempt}" \
    --arg bootstrap_generation "${bootstrap_generation}" \
    --arg omit_bootstrap_guard "${omit_bootstrap_guard}" \
    --argjson active "${active}" '{
      name: $revision,
      properties: {
        active: $active,
        healthState: "Healthy",
        provisioningState: "Provisioned",
        template: {containers: [{
          image: $image,
          env: ([{name: "OUTREACH_LIVE_FOR_ORGS", value: ""}] +
            (if $omit_bootstrap_guard == "true" then [] else [
              {name: "WORKFORCE_PRODUCTION_BOOTSTRAP_ATTEMPT_ID", value: $bootstrap_attempt},
              {name: "WORKFORCE_PRODUCTION_BOOTSTRAP_MIN_WRITER_FENCE_GENERATION", value: $bootstrap_generation}
            ] end))
        }]}
      }
    }'
  exit 0
fi
exit 1
EOF

  chmod +x "${HARNESS}/bin/git" "${HARNESS}/bin/docker" "${HARNESS}/bin/gh" "${HARNESS}/bin/az" \
    "${HARNESS}/escaped-config-helper.sh" \
    "${HARNESS}/repo/scripts/deploy-prod.sh" \
    "${HARNESS}/repo/scripts/verify-api-image.sh" \
    "${HARNESS}/repo/scripts/verify-registry-api-image.sh" \
    "${HARNESS}/repo/scripts/verify-github-release-ci.sh" \
    "${HARNESS}/repo/scripts/verify-migration-release-receipt.sh" \
    "${HARNESS}/repo/scripts/verify-containerapp-release-config.sh"
  CALL_LOG="${HARNESS}/calls.log"
  AZ_STATE="${HARNESS}/az-state.tsv"
  CONFIG_CALL_COUNT="${HARNESS}/config-call-count"
  MIGRATION_CALL_COUNT="${HARNESS}/migration-call-count"
  SHOW_CALL_COUNT="${HARNESS}/show-call-count"
  DEPLOY_PID_FILE="${HARNESS}/deploy.pid"
  BOOTSTRAP_PID_FILE="${HARNESS}/bootstrap.pid"
  BOOTSTRAP_DESCENDANT_PID_FILE="${HARNESS}/bootstrap-descendant.pid"
  BOOTSTRAP_SIGNAL_READY_FILE="${HARNESS}/bootstrap-signal-ready"
  SIGNAL_READY_FILE="${HARNESS}/signal-ready"
  SIGNAL_CONTINUE_FILE="${HARNESS}/signal-continue"
  FAKE_AUTHORITY_DENY_FILE="${HARNESS}/authority-denied"
  touch "${HARNESS}/receipt.json"
  touch "${HARNESS}/receipt.json.sig" "${HARNESS}/allowed-signers"
  : >"${CALL_LOG}"
  : >"${AZ_STATE}"
  printf '0\n' >"${CONFIG_CALL_COUNT}"
  printf '0\n' >"${MIGRATION_CALL_COUNT}"
  printf '0\n' >"${SHOW_CALL_COUNT}"
  FAKE_TREE_COMMIT="$(printf '6%.0s' {1..40})"
  FAKE_LEASE_COMMIT="$(printf '7%.0s' {1..40})"
  FAKE_LOCK_CLEANUP_STATUS=0
  FAKE_MUTATE_SOURCE_HELPER_ON_LOCK=false
  FAKE_SWAP_SNAPSHOT_HELPER_ON_LOCK=false
  ACA_EXCLUSIVE_MUTATION_AUTHORITY_CONFIRMED=true
}

run_fake_deploy() {
  local deploy_status
  local -a deploy_args
  deploy_args=(
    --migration-receipt "${HARNESS}/receipt.json"
    --migration-signature "${HARNESS}/receipt.json.sig"
    --migration-allowed-signers "${HARNESS}/allowed-signers"
  )
  if [[ "${FAKE_OMIT_YES:-false}" != "true" ]]; then
    deploy_args+=(--yes)
  fi
  env PATH="${HARNESS}/bin:${PATH}" \
    ALL_PROXY="http://127.0.0.1:1" \
    CALL_LOG="${CALL_LOG}" \
    CURL_CA_BUNDLE="${HARNESS}/hostile-ca.pem" \
    AZ_STATE="${AZ_STATE}" \
    CONFIG_CALL_COUNT="${CONFIG_CALL_COUNT}" \
    MIGRATION_CALL_COUNT="${MIGRATION_CALL_COUNT}" \
    SHOW_CALL_COUNT="${SHOW_CALL_COUNT}" \
    DEPLOY_PID_FILE="${DEPLOY_PID_FILE}" \
    BOOTSTRAP_PID_FILE="${BOOTSTRAP_PID_FILE}" \
    BOOTSTRAP_DESCENDANT_PID_FILE="${BOOTSTRAP_DESCENDANT_PID_FILE}" \
    BOOTSTRAP_SIGNAL_READY_FILE="${BOOTSTRAP_SIGNAL_READY_FILE}" \
    SIGNAL_READY_FILE="${SIGNAL_READY_FILE}" \
    SIGNAL_CONTINUE_FILE="${SIGNAL_CONTINUE_FILE}" \
    FAKE_REPO_ROOT="${HARNESS}/repo" \
    FAKE_BRANCH="${FAKE_BRANCH}" \
    FAKE_COMMIT="${FAKE_COMMIT}" \
    FAKE_TREE_COMMIT="${FAKE_TREE_COMMIT}" \
    FAKE_LEASE_COMMIT="${FAKE_LEASE_COMMIT}" \
    FAKE_REMOTE_COMMIT="${FAKE_REMOTE_COMMIT}" \
    FAKE_RUN_ID="${FAKE_RUN_ID}" \
    FAKE_DIGEST="${FAKE_DIGEST}" \
    FAKE_VERIFY_STATUS="${FAKE_VERIFY_STATUS:-0}" \
    FAKE_CI_STATUS="${FAKE_CI_STATUS:-0}" \
    FAKE_MIGRATION_STATUS="${FAKE_MIGRATION_STATUS:-0}" \
    FAKE_MIGRATION_FAIL_CALL="${FAKE_MIGRATION_FAIL_CALL:-}" \
    FAKE_MIGRATION_FAIL_STATUS="${FAKE_MIGRATION_FAIL_STATUS:-1}" \
    FAKE_MIGRATION_FRESH_EXPIRES_AFTER_CALL="${FAKE_MIGRATION_FRESH_EXPIRES_AFTER_CALL:-}" \
    FAKE_LOCK_STATUS="${FAKE_LOCK_STATUS:-0}" \
    FAKE_LOCK_CLEANUP_STATUS="${FAKE_LOCK_CLEANUP_STATUS:-0}" \
    FAKE_AZURE_LEASE_ACQUIRE_STATUS="${FAKE_AZURE_LEASE_ACQUIRE_STATUS:-0}" \
    FAKE_AZURE_LEASE_RENEW_STATUS="${FAKE_AZURE_LEASE_RENEW_STATUS:-0}" \
    FAKE_AZURE_LEASE_RELEASE_STATUS="${FAKE_AZURE_LEASE_RELEASE_STATUS:-0}" \
    FAKE_AZURE_LEASE_SHOW_STATUS="${FAKE_AZURE_LEASE_SHOW_STATUS:-0}" \
    FAKE_AZURE_LEASE_STATE="${FAKE_AZURE_LEASE_STATE:-}" \
    FAKE_MUTATE_SOURCE_HELPER_ON_LOCK="${FAKE_MUTATE_SOURCE_HELPER_ON_LOCK:-false}" \
    FAKE_SWAP_SNAPSHOT_HELPER_ON_LOCK="${FAKE_SWAP_SNAPSHOT_HELPER_ON_LOCK:-false}" \
    FAKE_ESCAPED_HELPER="${HARNESS}/escaped-config-helper.sh" \
    FAKE_CONFIG_STATUS="${FAKE_CONFIG_STATUS:-0}" \
    FAKE_CONFIG_FAIL_CALL="${FAKE_CONFIG_FAIL_CALL:-}" \
    FAKE_CONFIG_FAIL_FROM_CALL="${FAKE_CONFIG_FAIL_FROM_CALL:-}" \
    FAKE_CONFIG_FAIL_STATUS="${FAKE_CONFIG_FAIL_STATUS:-1}" \
    FAKE_ROLLBACK_DRIFT_APP="${FAKE_ROLLBACK_DRIFT_APP:-}" \
    FAKE_ROLLBACK_DRIFT_IMAGE="${FAKE_ROLLBACK_DRIFT_IMAGE:-}" \
    FAKE_AUTHORITY_FAIL_ON_ROLLBACK="${FAKE_AUTHORITY_FAIL_ON_ROLLBACK:-false}" \
    FAKE_AUTHORITY_DENY_FILE="${FAKE_AUTHORITY_DENY_FILE}" \
    FAKE_SIGNAL_APP="${FAKE_SIGNAL_APP:-}" \
    FAKE_SIGNAL_IMAGE="${FAKE_SIGNAL_IMAGE:-}" \
    FAKE_SIGNAL_NAME="${FAKE_SIGNAL_NAME:-TERM}" \
    FAKE_BOOTSTRAP_SIGNAL_POINT="${FAKE_BOOTSTRAP_SIGNAL_POINT:-}" \
    FAKE_CONCURRENT_APP="${FAKE_CONCURRENT_APP:-}" \
    FAKE_CONCURRENT_IMAGE="${FAKE_CONCURRENT_IMAGE:-}" \
    FAKE_CONCURRENT_AFTER_SHOW="${FAKE_CONCURRENT_AFTER_SHOW:-2}" \
    FAKE_API_MAX_INACTIVE_REVISIONS="${FAKE_API_MAX_INACTIVE_REVISIONS:-10}" \
    FAKE_WORKER_MAX_INACTIVE_REVISIONS="${FAKE_WORKER_MAX_INACTIVE_REVISIONS:-10}" \
    FAKE_OMIT_MAX_INACTIVE_APP="${FAKE_OMIT_MAX_INACTIVE_APP:-}" \
    FAKE_MISSING_RETAINED_APP="${FAKE_MISSING_RETAINED_APP:-}" \
    FAKE_CHANGED_RETAINED_APP="${FAKE_CHANGED_RETAINED_APP:-}" \
    FAKE_BOOTSTRAP_GUARD_MUTATE_ON_NEW_APP="${FAKE_BOOTSTRAP_GUARD_MUTATE_ON_NEW_APP:-}" \
    FAKE_BOOTSTRAP_GUARD_MUTATION="${FAKE_BOOTSTRAP_GUARD_MUTATION:-}" \
    GIT_SSL_CAINFO="${HARNESS}/hostile-ca.pem" \
    GIT_SSL_NO_VERIFY=true \
    GIT_TRACE="${HARNESS}/hostile-git-trace" \
    GIT_TRACE_PACKET="${HARNESS}/hostile-git-packet-trace" \
    HTTPS_PROXY="http://127.0.0.1:1" \
    HTTP_PROXY="http://127.0.0.1:1" \
    ACA_EXCLUSIVE_MUTATION_AUTHORITY_CONFIRMED="${ACA_EXCLUSIVE_MUTATION_AUTHORITY_CONFIRMED-true}" \
    AZURE_SUBSCRIPTION_ID="11111111-2222-3333-4444-555555555555" \
    WORKFORCE_PRODUCTION_CONTROL_STORAGE_ACCOUNT="workforcebootstrap" \
    WORKFORCE_PRODUCTION_CONTROL_STORAGE_CONTAINER="production-control" \
    WORKFORCE_PRODUCTION_CONTROL_STORAGE_BLOB="${FAKE_CONTROL_BLOB:-workforce-os/initial-production-bootstrap/state-v1.json}" \
    WORKFORCE_PRODUCTION_CONTROL_STORAGE_RESOURCE_ID="/subscriptions/11111111-2222-3333-4444-555555555555/resourceGroups/production-control/providers/Microsoft.Storage/storageAccounts/workforcebootstrap" \
    FAKE_PREVIOUS_API_IMAGE="workforceosprodacr.azurecr.io/apex-api@sha256:$(printf 'd%.0s' {1..64})" \
    FAKE_PREVIOUS_WORKER_IMAGE="workforceosprodacr.azurecr.io/apex-api@sha256:$(printf 'e%.0s' {1..64})" \
    FAKE_PREVIOUS_CONSOLE_IMAGE="workforceosprodacr.azurecr.io/workforceos-fe@sha256:$(printf 'f%.0s' {1..64})" \
    "${HARNESS}/repo/scripts/deploy-prod.sh" "${deploy_args[@]}"
  deploy_status=$?
  return "${deploy_status}"
}

reset_deploy_harness() {
  : >"${CALL_LOG}"
  : >"${AZ_STATE}"
  printf '0\n' >"${CONFIG_CALL_COUNT}"
  printf '0\n' >"${MIGRATION_CALL_COUNT}"
  FAKE_LOCK_STATUS=0
  FAKE_LOCK_CLEANUP_STATUS=0
  FAKE_AZURE_LEASE_ACQUIRE_STATUS=0
  FAKE_AZURE_LEASE_RENEW_STATUS=0
  FAKE_AZURE_LEASE_RELEASE_STATUS=0
  FAKE_AZURE_LEASE_SHOW_STATUS=0
  FAKE_AZURE_LEASE_STATE='{"status":"unlocked","state":"available"}'
  FAKE_CONTROL_BLOB="workforce-os/initial-production-bootstrap/state-v1.json"
  FAKE_MUTATE_SOURCE_HELPER_ON_LOCK=false
  FAKE_SWAP_SNAPSHOT_HELPER_ON_LOCK=false
  FAKE_BOOTSTRAP_SIGNAL_POINT=""
  FAKE_OMIT_YES=false
  ACA_EXCLUSIVE_MUTATION_AUTHORITY_CONFIRMED=true
  FAKE_CONFIG_STATUS=0
  FAKE_CONFIG_FAIL_CALL=""
  FAKE_CONFIG_FAIL_FROM_CALL=""
  FAKE_ROLLBACK_DRIFT_APP=""
  FAKE_ROLLBACK_DRIFT_IMAGE=""
  FAKE_AUTHORITY_FAIL_ON_ROLLBACK=false
  FAKE_API_MAX_INACTIVE_REVISIONS=10
  FAKE_WORKER_MAX_INACTIVE_REVISIONS=10
  FAKE_OMIT_MAX_INACTIVE_APP=""
  FAKE_MISSING_RETAINED_APP=""
  FAKE_CHANGED_RETAINED_APP=""
  FAKE_BOOTSTRAP_GUARD_MUTATE_ON_NEW_APP=""
  FAKE_BOOTSTRAP_GUARD_MUTATION=""
  FAKE_MIGRATION_FAIL_CALL=""
  FAKE_MIGRATION_FRESH_EXPIRES_AFTER_CALL=""
  printf '0\n' >"${SHOW_CALL_COUNT}"
  rm -f -- \
    "${DEPLOY_PID_FILE}" \
    "${BOOTSTRAP_PID_FILE}" \
    "${BOOTSTRAP_DESCENDANT_PID_FILE}" \
    "${BOOTSTRAP_SIGNAL_READY_FILE}" \
    "${SIGNAL_READY_FILE}" \
    "${SIGNAL_CONTINUE_FILE}" \
    "${FAKE_AUTHORITY_DENY_FILE}"
}

test_deploy_admission() {
  local azure_acquire azure_release requested_image snapshot_context direct_token rollback_api rollback_worker exact_baseline_log guard_mutation
  make_deploy_harness
  FAKE_BRANCH="release/go-live-test"
  FAKE_COMMIT="$(printf '1%.0s' {1..40})"
  FAKE_REMOTE_COMMIT="${FAKE_COMMIT}"
  FAKE_RUN_ID="ca123"
  FAKE_DIGEST="sha256:$(printf '2%.0s' {1..64})"
  FAKE_VERIFY_STATUS=0
  requested_image="workforceosprodacr.azurecr.io/apex-api@${FAKE_DIGEST}"
  rollback_api="workforceosprodacr.azurecr.io/apex-api@sha256:$(printf 'd%.0s' {1..64})"
  rollback_worker="workforceosprodacr.azurecr.io/apex-api@sha256:$(printf 'e%.0s' {1..64})"
  exact_baseline_log="${FAKE_COMMIT} ${rollback_api} apex-gtm-api--revision ${rollback_worker} apex-gtm-worker--revision workforceosprodacr.azurecr.io/workforceos-fe@sha256:$(printf 'f%.0s' {1..64}) nikxius-web--revision disabled"

  grep -Fq -- "Microsoft.App/containerApps/write authority across apex-gtm-api" \
    "${REPO_ROOT}/scripts/deploy-prod.sh" ||
    fail "deploy authority contract does not name the API mutation target"
  grep -Fq -- "apex-gtm-worker, and nikxius-web" \
    "${REPO_ROOT}/scripts/deploy-prod.sh" ||
    fail "deploy authority contract does not name the worker and console mutation targets"
  grep -Fq -- "mutation lease that excludes every other writer" \
    "${REPO_ROOT}/scripts/deploy-prod.sh" ||
    fail "deploy authority contract does not admit only a coordinated three-app lease"
  pass

  # Only the bootstrap parent may delete its runtime directory. Even a direct
  # child with an otherwise valid snapshot identity must never recursively
  # remove an environment-supplied path during EXIT cleanup.
  mkdir "${HARNESS}/direct-child-runtime"
  : >"${HARNESS}/direct-child-runtime/sentinel"
  direct_token="$(printf 'a%.0s' {1..64})"
  printf '%s\n' "${direct_token}" >"${HARNESS}/direct-child-token"
  if env PATH="${HARNESS}/bin:${PATH}" \
    ACA_EXCLUSIVE_MUTATION_AUTHORITY_CONFIRMED= \
    WORKFORCE_RELEASE_SNAPSHOT_ACTIVE=true \
    WORKFORCE_RELEASE_SOURCE_REPOSITORY="${HARNESS}/repo" \
    WORKFORCE_RELEASE_SOURCE_COMMIT="${FAKE_COMMIT}" \
    WORKFORCE_RELEASE_SNAPSHOT_ROOT="${HARNESS}/repo" \
    WORKFORCE_RELEASE_SNAPSHOT_PARENT_PID="$$" \
    WORKFORCE_RELEASE_SNAPSHOT_TOKEN="${direct_token}" \
    WORKFORCE_RELEASE_SNAPSHOT_TOKEN_FILE="${HARNESS}/direct-child-token" \
    WORKFORCE_RELEASE_RUNTIME_STATE_DIR="${HARNESS}/direct-child-runtime" \
    "${HARNESS}/repo/scripts/deploy-prod.sh" \
      --migration-receipt "${HARNESS}/receipt.json" \
      --migration-signature "${HARNESS}/receipt.json.sig" \
      --migration-allowed-signers "${HARNESS}/allowed-signers" \
      --yes >"${HARNESS}/direct-child-output.log" 2>&1; then
    fail "direct snapshot child bypassed the exclusive-authority admission gate"
  fi
  assert_log_contains "${HARNESS}/direct-child-output.log" \
    "production Container Apps writes are fail-closed pending exclusive authority attestation"
  if [[ ! -d "${HARNESS}/direct-child-runtime" ||
    ! -f "${HARNESS}/direct-child-runtime/sentinel" ]]; then
    fail "direct snapshot child deleted an environment-supplied runtime path"
  fi
  pass

  # The ordinary harness exports no Bash functions. Running this first deploy
  # under Bash 3 covers the zero discovered BASH_FUNC_* environment case.
  run_fake_deploy >/dev/null
  assert_log_contains "${CALL_LOG}" "verify-ci ${FAKE_COMMIT}"
  assert_log_contains "${CALL_LOG}" "verify-migrations "
  assert_log_contains "${CALL_LOG}" "${exact_baseline_log}"
  assert_before "${CALL_LOG}" "${exact_baseline_log}" "az acr build"
  assert_log_contains "${CALL_LOG}" "az acr task show-run --registry workforceosprodacr --run-id ${FAKE_RUN_ID}"
  assert_log_contains "${CALL_LOG}" "verify-registry ${requested_image} ${FAKE_COMMIT}"
  assert_log_contains "${CALL_LOG}" \
    "commit-tree ${FAKE_TREE_COMMIT} -p ${FAKE_COMMIT}"
  assert_log_contains "${CALL_LOG}" "-c core.hooksPath=/dev/null"
  assert_log_contains "${CALL_LOG}" "-c credential.helper=!gh auth git-credential"
  assert_log_contains "${CALL_LOG}" \
    "push --force-with-lease=refs/heads/workforce-os-release-lock/production-gtm-platform: https://github.com/Kloudedge-apex/apex-product.git ${FAKE_LEASE_COMMIT}:refs/heads/workforce-os-release-lock/production-gtm-platform"
  assert_log_contains "${CALL_LOG}" \
    "push --force-with-lease=refs/heads/workforce-os-release-lock/production-gtm-platform:${FAKE_LEASE_COMMIT} https://github.com/Kloudedge-apex/apex-product.git :refs/heads/workforce-os-release-lock/production-gtm-platform"
  azure_acquire="az storage blob lease acquire --account-name workforcebootstrap --container-name production-control --blob-name workforce-os/initial-production-bootstrap/state-v1.json --auth-mode login --subscription 11111111-2222-3333-4444-555555555555 --only-show-errors --lease-duration -1 --proposed-lease-id"
  azure_release="az storage blob lease release --account-name workforcebootstrap --container-name production-control --blob-name workforce-os/initial-production-bootstrap/state-v1.json --auth-mode login --subscription 11111111-2222-3333-4444-555555555555 --only-show-errors --lease-id"
  assert_log_contains "${CALL_LOG}" "${azure_acquire}"
  assert_log_contains "${CALL_LOG}" "${azure_release}"
  assert_log_excludes "${CALL_LOG}" "--query leaseId"
  assert_before "${CALL_LOG}" "${azure_acquire}" \
    "push --force-with-lease=refs/heads/workforce-os-release-lock/production-gtm-platform:"
  assert_before "${CALL_LOG}" "${azure_acquire}" "az acr build"
  assert_before "${CALL_LOG}" \
    "push --force-with-lease=refs/heads/workforce-os-release-lock/production-gtm-platform:${FAKE_LEASE_COMMIT}" \
    "${azure_release}"
  assert_log_excludes "${CALL_LOG}" "storage blob lease break"
  assert_before "${CALL_LOG}" \
    "push --force-with-lease=refs/heads/workforce-os-release-lock/production-gtm-platform: https://github.com/Kloudedge-apex/apex-product.git ${FAKE_LEASE_COMMIT}" \
    "az containerapp show"
  assert_log_contains "${CALL_LOG}" "az containerapp update --name apex-gtm-worker"
  assert_log_contains "${CALL_LOG}" "az containerapp update --name apex-gtm-api"
  assert_immediately_preceded_by "${CALL_LOG}" \
    "az containerapp update --name apex-gtm-api" "${exact_baseline_log}"
  assert_immediately_preceded_by "${CALL_LOG}" \
    "az containerapp update --name apex-gtm-worker" "${exact_baseline_log}"
  assert_before "${CALL_LOG}" \
    "az containerapp revision show --name nikxius-web" \
    "az containerapp update --name apex-gtm-api"
  assert_before "${CALL_LOG}" "verify-registry" "az containerapp update"
  assert_before "${CALL_LOG}" "az containerapp update --name apex-gtm-api" \
    "az containerapp update --name apex-gtm-worker"
  if grep -F -- "az acr build" "${CALL_LOG}" | grep -Fq -- "${HARNESS}/repo"; then
    fail "ACR build used the mutable source repository instead of the private snapshot"
  fi
  assert_log_contains "${CALL_LOG}" "mode 700"
  snapshot_context="$(awk '/^snapshot-context / { print $2; exit }' "${CALL_LOG}")"
  if [[ -z "${snapshot_context}" || -e "${snapshot_context}" ]]; then
    fail "bootstrap parent did not remove its exact private snapshot after release"
  fi
  pass

  reset_deploy_harness
  FAKE_AZURE_LEASE_ACQUIRE_STATUS=1
  FAKE_AZURE_LEASE_RENEW_STATUS=1
  if run_fake_deploy >/dev/null 2>&1; then
    fail "backend deploy continued while the shared Azure mutation lease was held"
  fi
  assert_log_excludes "${CALL_LOG}" "push --force-with-lease=refs/heads/workforce-os-release-lock/production-gtm-platform:"
  assert_log_excludes "${CALL_LOG}" "az acr build"
  assert_log_excludes "${CALL_LOG}" "az containerapp update"
  assert_log_excludes "${CALL_LOG}" "storage blob lease break"
  pass

  reset_deploy_harness
  FAKE_AZURE_LEASE_ACQUIRE_STATUS=1
  FAKE_AZURE_LEASE_RENEW_STATUS=0
  run_fake_deploy >/dev/null
  assert_log_contains "${CALL_LOG}" "storage blob lease renew"
  assert_log_contains "${CALL_LOG}" "storage blob lease release"
  pass

  reset_deploy_harness
  FAKE_CONTROL_BLOB="workforce-os/backend-only/state-v1.json"
  if run_fake_deploy >/dev/null 2>&1; then
    fail "backend deploy accepted a repository-specific production-control blob"
  fi
  assert_log_excludes "${CALL_LOG}" "storage blob lease acquire"
  assert_log_excludes "${CALL_LOG}" "push --force-with-lease=refs/heads/workforce-os-release-lock/production-gtm-platform:"
  assert_log_excludes "${CALL_LOG}" "az acr build"
  pass

  for guard_mutation in missing attempt downgrade; do
    reset_deploy_harness
    FAKE_BOOTSTRAP_GUARD_MUTATE_ON_NEW_APP="apex-gtm-api"
    FAKE_BOOTSTRAP_GUARD_MUTATION="${guard_mutation}"
    if run_fake_deploy >/dev/null 2>&1; then
      fail "deploy accepted a ${guard_mutation} bootstrap guard after the API image update"
    fi
    assert_log_contains "${CALL_LOG}" "az containerapp update --name apex-gtm-api"
    assert_log_excludes "${CALL_LOG}" "az containerapp update --name apex-gtm-worker"
    assert_log_contains "${CALL_LOG}" \
      "az containerapp revision activate --name apex-gtm-api --resource-group workforce-os-prod --revision apex-gtm-api--revision"
    pass
  done

  reset_deploy_harness
  FAKE_OMIT_MAX_INACTIVE_APP="apex-gtm-api"
  if run_fake_deploy >/dev/null 2>&1; then
    fail "deploy accepted API state without explicit inactive-revision retention"
  fi
  assert_log_excludes "${CALL_LOG}" "az acr build"
  assert_log_excludes "${CALL_LOG}" "az containerapp update"
  pass

  reset_deploy_harness
  FAKE_WORKER_MAX_INACTIVE_REVISIONS=0
  if run_fake_deploy >/dev/null 2>&1; then
    fail "deploy accepted zero worker inactive-revision retention"
  fi
  assert_log_excludes "${CALL_LOG}" "az acr build"
  assert_log_excludes "${CALL_LOG}" "az containerapp update"
  pass

  reset_deploy_harness
  FAKE_LOCK_CLEANUP_STATUS=1
  if run_fake_deploy >/dev/null 2>&1; then
    fail "deploy reported success while its conditional release lease cleanup failed"
  fi
  assert_log_contains "${CALL_LOG}" "az containerapp update --name apex-gtm-worker"
  assert_log_contains "${CALL_LOG}" "az containerapp update --name apex-gtm-api"
  assert_log_contains "${CALL_LOG}" \
    "push --force-with-lease=refs/heads/workforce-os-release-lock/production-gtm-platform:${FAKE_LEASE_COMMIT} https://github.com/Kloudedge-apex/apex-product.git :refs/heads/workforce-os-release-lock/production-gtm-platform"
  assert_log_excludes "${CALL_LOG}" "storage blob lease release"
  pass

  reset_deploy_harness
  FAKE_AZURE_LEASE_RELEASE_STATUS=1
  FAKE_AZURE_LEASE_STATE='{"status":"locked","state":"leased"}'
  if run_fake_deploy >/dev/null 2>&1; then
    fail "backend deploy reported success while shared Azure lease cleanup was uncertain"
  fi
  assert_log_contains "${CALL_LOG}" \
    "push --force-with-lease=refs/heads/workforce-os-release-lock/production-gtm-platform:${FAKE_LEASE_COMMIT} https://github.com/Kloudedge-apex/apex-product.git :refs/heads/workforce-os-release-lock/production-gtm-platform"
  assert_log_contains "${CALL_LOG}" "storage blob lease release"
  assert_before "${CALL_LOG}" \
    "push --force-with-lease=refs/heads/workforce-os-release-lock/production-gtm-platform:${FAKE_LEASE_COMMIT}" \
    "storage blob lease release"
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
  FAKE_OMIT_YES=true
  if run_fake_deploy >"${HARNESS}/missing-yes-output.log" 2>&1; then
    fail "deploy accepted a protected release invocation without --yes"
  fi
  assert_log_contains "${HARNESS}/missing-yes-output.log" \
    "protected release execution is noninteractive and requires --yes"
  assert_log_excludes "${CALL_LOG}" "gh "
  assert_log_excludes "${CALL_LOG}" "az "
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
  FAKE_CONCURRENT_APP="apex-gtm-api"
  FAKE_CONCURRENT_IMAGE="${rollback_api}"
  if run_fake_deploy >/dev/null 2>&1; then
    fail "deploy overwrote a same-image concurrent configuration revision"
  fi
  assert_log_contains "${CALL_LOG}" \
    "concurrent-image apex-gtm-api ${rollback_api}"
  assert_log_excludes "${CALL_LOG}" "az containerapp update"
  pass

  reset_deploy_harness
  FAKE_VERIFY_STATUS=0
  FAKE_CONCURRENT_APP="apex-gtm-api"
  FAKE_CONCURRENT_IMAGE="workforceosprodacr.azurecr.io/apex-api@sha256:$(printf '9%.0s' {1..64})"
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

  reset_deploy_harness
  FAKE_BRANCH="release/go-live-test"
  ACA_EXCLUSIVE_MUTATION_AUTHORITY_CONFIRMED=""
  if run_fake_deploy >/dev/null 2>&1; then
    fail "deploy accepted missing exclusive Container Apps mutation authority attestation"
  fi
  assert_log_excludes "${CALL_LOG}" "git push"
  assert_log_excludes "${CALL_LOG}" "az "
  pass

  # Mutating the checked-out helper after acquisition must not affect the
  # controller or helpers already running from the exact-commit snapshot.
  reset_deploy_harness
  FAKE_MUTATE_SOURCE_HELPER_ON_LOCK=true
  cp "${HARNESS}/repo/scripts/verify-containerapp-release-config.sh" \
    "${HARNESS}/verify-containerapp-release-config.saved"
  run_fake_deploy >/dev/null
  cp "${HARNESS}/verify-containerapp-release-config.saved" \
    "${HARNESS}/repo/scripts/verify-containerapp-release-config.sh"
  assert_log_contains "${CALL_LOG}" \
    "verify-containerapps ${requested_image} ${requested_image}"
  pass

  # Revalidation must fail closed if a helper is replaced after the initial
  # snapshot admission but before its later call site. The escaped target must
  # never execute, including from conditional cleanup or rollback contexts.
  reset_deploy_harness
  FAKE_SWAP_SNAPSHOT_HELPER_ON_LOCK=true
  if run_fake_deploy >/dev/null 2>&1; then
    fail "deploy accepted a post-admission snapshot helper symlink swap"
  fi
  assert_log_excludes "${CALL_LOG}" "escaped-config-helper-executed"
  assert_log_excludes "${CALL_LOG}" "az acr build"
  pass
}

test_deploy_rollback() {
  local requested_image previous_api_image previous_worker_image rollout_status
  local deploy_job deploy_pid signal_ready
  local forward_api forward_worker rollback_api rollback_worker exact_baseline_log
  make_deploy_harness
  FAKE_BRANCH="release/go-live-test"
  FAKE_COMMIT="$(printf '1%.0s' {1..40})"
  FAKE_REMOTE_COMMIT="${FAKE_COMMIT}"
  FAKE_RUN_ID="ca123"
  FAKE_DIGEST="sha256:$(printf '2%.0s' {1..64})"
  FAKE_VERIFY_STATUS=0
  FAKE_CONFIG_STATUS=0
  requested_image="workforceosprodacr.azurecr.io/apex-api@${FAKE_DIGEST}"
  previous_api_image="workforceosprodacr.azurecr.io/apex-api@sha256:$(printf 'd%.0s' {1..64})"
  previous_worker_image="workforceosprodacr.azurecr.io/apex-api@sha256:$(printf 'e%.0s' {1..64})"
  forward_worker="az containerapp update --name apex-gtm-worker --resource-group workforce-os-prod --image ${requested_image} --output none"
  forward_api="az containerapp update --name apex-gtm-api --resource-group workforce-os-prod --image ${requested_image} --output none"
  rollback_worker="az containerapp revision activate --name apex-gtm-worker --resource-group workforce-os-prod --revision apex-gtm-worker--revision --output none"
  rollback_api="az containerapp revision activate --name apex-gtm-api --resource-group workforce-os-prod --revision apex-gtm-api--revision --output none"
  exact_baseline_log="${FAKE_COMMIT} ${previous_api_image} apex-gtm-api--revision ${previous_worker_image} apex-gtm-worker--revision workforceosprodacr.azurecr.io/workforceos-fe@sha256:$(printf 'f%.0s' {1..64}) nikxius-web--revision disabled"

  # The final fresh receipt check occurs after the slow three-app identity
  # reads. If it expires there, no forward or compensating ACA write is legal.
  FAKE_MIGRATION_FRESH_EXPIRES_AFTER_CALL=4
  if run_fake_deploy >/dev/null 2>&1; then
    fail "deploy accepted a receipt that expired during final pre-write identity reads"
  fi
  assert_last_immediately_preceded_by "${CALL_LOG}" \
    "verify-migrations same-attempt=false" \
    "az containerapp revision show --name nikxius-web"
  assert_log_excludes "${CALL_LOG}" "az containerapp update"
  assert_log_excludes "${CALL_LOG}" "az containerapp revision activate"
  assert_log_excludes "${CALL_LOG}" "az containerapp ingress traffic set"
  pass

  reset_deploy_harness

  # A failed read-back after the reader-first API mutation must restore the API
  # and leave the writer worker untouched.
  FAKE_CONFIG_FAIL_CALL=3
  if run_fake_deploy >"${HARNESS}/api-post-update-rollback.log" 2>&1; then
    fail "deploy succeeded after API post-update verification failed"
  fi
  assert_log_contains "${CALL_LOG}" "${forward_api}"
  assert_log_contains "${CALL_LOG}" "${rollback_api}"
  assert_log_excludes "${HARNESS}/api-post-update-rollback.log" \
    "signed rollback baseline verification failed"
  assert_log_excludes "${CALL_LOG}" "az containerapp update --name apex-gtm-worker"
  assert_before "${CALL_LOG}" "${forward_api}" "${rollback_api}"
  assert_log_contains "${CALL_LOG}" "${exact_baseline_log}"
  assert_log_contains "${CALL_LOG}" "verify-containerapps ${previous_api_image} ${previous_worker_image}"
  assert_log_excludes "${CALL_LOG}" \
    "push --force-with-lease=refs/heads/workforce-os-release-lock/production-gtm-platform:${FAKE_LEASE_COMMIT} https://github.com/Kloudedge-apex/apex-product.git :refs/heads/workforce-os-release-lock/production-gtm-platform"
  assert_log_excludes "${CALL_LOG}" "storage blob lease release"
  pass

  # The immediately prior API revision must still exist before a worker write
  # or rollback activation. A platform-retention miss leaves both mutation
  # paths fail-closed.
  reset_deploy_harness
  FAKE_CONFIG_FAIL_CALL=""
  FAKE_MISSING_RETAINED_APP="apex-gtm-api"
  if run_fake_deploy >/dev/null 2>&1; then
    fail "deploy continued after the prior API revision disappeared"
  fi
  assert_log_contains "${CALL_LOG}" "${forward_api}"
  assert_log_excludes "${CALL_LOG}" "${forward_worker}"
  assert_log_excludes "${CALL_LOG}" "az containerapp revision activate"
  assert_log_excludes "${CALL_LOG}" "az containerapp ingress traffic set"
  pass

  reset_deploy_harness
  FAKE_CONFIG_FAIL_CALL=""
  FAKE_CHANGED_RETAINED_APP="apex-gtm-api"
  if run_fake_deploy >/dev/null 2>&1; then
    fail "deploy continued after the prior API revision image changed"
  fi
  assert_log_contains "${CALL_LOG}" "${forward_api}"
  assert_log_excludes "${CALL_LOG}" "${forward_worker}"
  assert_log_excludes "${CALL_LOG}" "az containerapp revision activate"
  assert_log_excludes "${CALL_LOG}" "az containerapp ingress traffic set"
  pass

  # Rollback runs with errexit disabled. A fresh active-state mismatch must
  # still return explicitly before either compensating Azure mutation.
  reset_deploy_harness
  FAKE_CONFIG_FAIL_CALL=3
  FAKE_ROLLBACK_DRIFT_APP="apex-gtm-api"
  FAKE_ROLLBACK_DRIFT_IMAGE="workforceosprodacr.azurecr.io/apex-api@sha256:$(printf '3%.0s' {1..64})"
  if run_fake_deploy >/dev/null 2>&1; then
    fail "deploy succeeded after rollback detected external production drift"
  fi
  assert_log_contains "${CALL_LOG}" "${forward_api}"
  assert_log_excludes "${CALL_LOG}" "az containerapp revision activate"
  assert_log_excludes "${CALL_LOG}" "az containerapp ingress traffic set"
  pass

  # The same set +e path must stop if exclusive write authority is revoked
  # after the forward mutation but before compensation.
  reset_deploy_harness
  FAKE_CONFIG_FAIL_CALL=3
  FAKE_AUTHORITY_FAIL_ON_ROLLBACK=true
  if run_fake_deploy >"${HARNESS}/rollback-authority-failure.log" 2>&1; then
    fail "deploy succeeded after rollback mutation authority was revoked"
  fi
  assert_log_contains "${CALL_LOG}" "${forward_api}"
  assert_log_contains "${HARNESS}/rollback-authority-failure.log" \
    "harness revoked Container Apps mutation authority"
  assert_log_excludes "${CALL_LOG}" "az containerapp revision activate"
  assert_log_excludes "${CALL_LOG}" "az containerapp ingress traffic set"
  pass

  # Admission freshness may expire during a slow build, but rollback must
  # reverify the frozen signed bytes and exact identities in the same attempt.
  reset_deploy_harness
  FAKE_CONFIG_FAIL_CALL=3
  FAKE_MIGRATION_FRESH_EXPIRES_AFTER_CALL=5
  if run_fake_deploy >/dev/null 2>&1; then
    fail "deploy succeeded after API verification failed in the receipt-expiry scenario"
  fi
  assert_log_contains "${CALL_LOG}" "verify-migrations same-attempt=true"
  assert_log_contains "${CALL_LOG}" "${rollback_api}"
  pass

  # A signed-baseline verifier failure at rollback time must stop before any
  # compensating write, even though earlier admission checks succeeded.
  reset_deploy_harness
  FAKE_CONFIG_FAIL_CALL=3
  FAKE_MIGRATION_FAIL_CALL=5
  if run_fake_deploy >"${HARNESS}/rollback-baseline-failure.log" 2>&1; then
    fail "deploy succeeded after rollback baseline verification failed"
  fi
  assert_log_contains "${CALL_LOG}" "${forward_api}"
  assert_log_excludes "${CALL_LOG}" "${rollback_api}"
  assert_log_excludes "${CALL_LOG}" "${rollback_worker}"
  assert_log_contains "${HARNESS}/rollback-baseline-failure.log" \
    "signed rollback baseline verification failed; no compensating write was attempted"
  pass

  # If rollback read-back also fails, production state is uncertain and the
  # lease must remain in place for explicit investigation.
  reset_deploy_harness
  FAKE_CONFIG_FAIL_CALL=""
  FAKE_CONFIG_FAIL_FROM_CALL=3
  if run_fake_deploy >/dev/null 2>&1; then
    fail "deploy succeeded after rollout and rollback verification both failed"
  fi
  assert_log_contains "${CALL_LOG}" "${forward_api}"
  assert_log_contains "${CALL_LOG}" "${rollback_api}"
  assert_log_excludes "${CALL_LOG}" \
    "push --force-with-lease=refs/heads/workforce-os-release-lock/production-gtm-platform:${FAKE_LEASE_COMMIT} https://github.com/Kloudedge-apex/apex-product.git :refs/heads/workforce-os-release-lock/production-gtm-platform"
  pass

  # A failed final read-back must disable the writer first, restore the API
  # reader second, and verify
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
  assert_before "${CALL_LOG}" "${forward_api}" "${forward_worker}"
  assert_before "${CALL_LOG}" "${rollback_worker}" "${rollback_api}"
  assert_log_contains "${CALL_LOG}" \
    "az containerapp ingress traffic set --name apex-gtm-api --resource-group workforce-os-prod --revision-weight apex-gtm-api--revision=100 --output none"
  assert_log_excludes "${CALL_LOG}" \
    "az containerapp update --name apex-gtm-api --resource-group workforce-os-prod --image ${previous_api_image}"
  assert_log_excludes "${CALL_LOG}" \
    "az containerapp update --name apex-gtm-worker --resource-group workforce-os-prod --image ${previous_worker_image}"
  assert_log_contains "${CALL_LOG}" "verify-containerapps ${previous_api_image} ${previous_worker_image}"
  pass

  # TERM is not an ERR condition in Bash. The explicit signal trap must still
  # restore an API reader mutation and preserve the conventional 143 exit status.
  reset_deploy_harness
  FAKE_CONFIG_FAIL_CALL=""
  FAKE_SIGNAL_APP="apex-gtm-api"
  FAKE_SIGNAL_IMAGE="${requested_image}"
  FAKE_SIGNAL_NAME="TERM"
  (trap - EXIT; run_fake_deploy >"${HARNESS}/signal-output.log" 2>&1) &
  deploy_job=$!
  signal_ready="false"
  for _ in {1..1200}; do
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
  assert_log_contains "${CALL_LOG}" "signal-ready TERM after apex-gtm-api update"
  assert_log_contains "${CALL_LOG}" "${forward_api}"
  assert_log_contains "${CALL_LOG}" "${rollback_api}"
  assert_log_excludes "${CALL_LOG}" "az containerapp update --name apex-gtm-worker"
  assert_before "${CALL_LOG}" "${forward_api}" "${rollback_api}"
  pass
}

test_bootstrap_signal_forwarding() {
  local deploy_job bootstrap_pid deploy_pid descendant_pid rollout_status snapshot_context
  local signal_ready="false"
  make_deploy_harness
  FAKE_BRANCH="release/go-live-test"
  FAKE_COMMIT="$(printf '1%.0s' {1..40})"
  FAKE_REMOTE_COMMIT="${FAKE_COMMIT}"
  FAKE_RUN_ID="ca123"
  FAKE_DIGEST="sha256:$(printf '2%.0s' {1..64})"
  FAKE_VERIFY_STATUS=0
  FAKE_BOOTSTRAP_SIGNAL_POINT="verify-registry"

  (trap - EXIT; run_fake_deploy >"${HARNESS}/bootstrap-signal-output.log" 2>&1) &
  deploy_job=$!
  for _ in {1..1200}; do
    if [[ -s "${BOOTSTRAP_PID_FILE}" && -s "${DEPLOY_PID_FILE}" &&
      -s "${BOOTSTRAP_DESCENDANT_PID_FILE}" &&
      -e "${BOOTSTRAP_SIGNAL_READY_FILE}" ]]; then
      signal_ready="true"
      break
    fi
    if ! kill -0 "${deploy_job}" >/dev/null 2>&1; then
      break
    fi
    sleep 0.05
  done
  if [[ "${signal_ready}" != "true" ]]; then
    if [[ -s "${BOOTSTRAP_PID_FILE}" ]]; then
      kill -s TERM "$(cat "${BOOTSTRAP_PID_FILE}")" >/dev/null 2>&1 || true
    else
      kill -s TERM "${deploy_job}" >/dev/null 2>&1 || true
    fi
    wait "${deploy_job}" >/dev/null 2>&1 || true
    fail "bootstrap deploy did not reach the parent-signal injection point"
  fi

  bootstrap_pid="$(cat "${BOOTSTRAP_PID_FILE}")"
  deploy_pid="$(cat "${DEPLOY_PID_FILE}")"
  descendant_pid="$(cat "${BOOTSTRAP_DESCENDANT_PID_FILE}")"
  if [[ "${bootstrap_pid}" == "$$" || "${deploy_pid}" == "$$" ||
    "${bootstrap_pid}" == "${deploy_pid}" || "${deploy_pid}" == "${descendant_pid}" ]]; then
    kill -s TERM -- "-${deploy_pid}" >/dev/null 2>&1 || true
    kill -s TERM "${bootstrap_pid}" >/dev/null 2>&1 || true
    wait "${deploy_job}" >/dev/null 2>&1 || true
    fail "bootstrap signal harness did not resolve distinct controller processes"
  fi
  if ! kill -0 "${bootstrap_pid}" >/dev/null 2>&1 ||
    ! kill -0 "${deploy_pid}" >/dev/null 2>&1 ||
    ! kill -0 "${descendant_pid}" >/dev/null 2>&1; then
    kill -s TERM -- "-${deploy_pid}" >/dev/null 2>&1 || true
    wait "${deploy_job}" >/dev/null 2>&1 || true
    fail "bootstrap signal harness resolved a process that was not live"
  fi
  if ! kill -s TERM "${bootstrap_pid}"; then
    kill -s TERM -- "-${deploy_pid}" >/dev/null 2>&1 || true
    wait "${deploy_job}" >/dev/null 2>&1 || true
    fail "bootstrap signal harness could not signal the live bootstrap parent"
  fi
  if wait "${deploy_job}"; then
    fail "bootstrap deploy succeeded after its parent received TERM"
  else
    rollout_status=$?
  fi
  if [[ ${rollout_status} -ne 143 ]]; then
    fail "bootstrap-parent TERM exited ${rollout_status}, expected 143"
  fi

  for _ in {1..100}; do
    if ! kill -0 "${deploy_pid}" >/dev/null 2>&1; then
      break
    fi
    sleep 0.02
  done
  if kill -0 "${deploy_pid}" >/dev/null 2>&1; then
    fail "bootstrap parent exited while its snapshot controller was still running"
  fi
  if kill -0 "${descendant_pid}" >/dev/null 2>&1; then
    fail "bootstrap parent left a stalled release helper descendant running"
  fi
  sleep 0.1
  assert_log_excludes "${CALL_LOG}" "az containerapp update"
  snapshot_context="$(awk '/^snapshot-context / { print $2; exit }' "${CALL_LOG}")"
  if [[ -z "${snapshot_context}" || -e "${snapshot_context}" ]]; then
    fail "bootstrap parent did not remove the private snapshot after TERM"
  fi
  pass

  # If the snapshot controller itself dies, the bootstrap still owns the
  # recorded process group and must terminate a surviving release descendant.
  reset_deploy_harness
  FAKE_BOOTSTRAP_SIGNAL_POINT="verify-registry"
  signal_ready="false"
  (trap - EXIT; run_fake_deploy >"${HARNESS}/leader-death-output.log" 2>&1) &
  deploy_job=$!
  for _ in {1..1200}; do
    if [[ -s "${BOOTSTRAP_PID_FILE}" && -s "${DEPLOY_PID_FILE}" &&
      -s "${BOOTSTRAP_DESCENDANT_PID_FILE}" &&
      -e "${BOOTSTRAP_SIGNAL_READY_FILE}" ]]; then
      signal_ready="true"
      break
    fi
    if ! kill -0 "${deploy_job}" >/dev/null 2>&1; then
      break
    fi
    sleep 0.05
  done
  if [[ "${signal_ready}" != "true" ]]; then
    if [[ -s "${BOOTSTRAP_PID_FILE}" ]]; then
      kill -s TERM "$(cat "${BOOTSTRAP_PID_FILE}")" >/dev/null 2>&1 || true
    else
      kill -s TERM "${deploy_job}" >/dev/null 2>&1 || true
    fi
    wait "${deploy_job}" >/dev/null 2>&1 || true
    fail "bootstrap deploy did not reach the leader-death injection point"
  fi
  bootstrap_pid="$(cat "${BOOTSTRAP_PID_FILE}")"
  deploy_pid="$(cat "${DEPLOY_PID_FILE}")"
  descendant_pid="$(cat "${BOOTSTRAP_DESCENDANT_PID_FILE}")"
  snapshot_context="$(awk '/^snapshot-context / { print $2; exit }' "${CALL_LOG}")"
  kill -s KILL "${deploy_pid}"
  if wait "${deploy_job}"; then
    fail "bootstrap deploy succeeded after its snapshot controller was killed"
  else
    rollout_status=$?
  fi
  if [[ ${rollout_status} -ne 137 ]]; then
    fail "killed snapshot controller exited ${rollout_status}, expected 137"
  fi
  for _ in {1..100}; do
    if ! kill -0 "${descendant_pid}" >/dev/null 2>&1; then
      break
    fi
    sleep 0.02
  done
  if kill -0 "${bootstrap_pid}" >/dev/null 2>&1 ||
    kill -0 "${descendant_pid}" >/dev/null 2>&1; then
    kill -s TERM -- "-${deploy_pid}" >/dev/null 2>&1 || true
    fail "bootstrap cleanup left a process after its group leader died"
  fi
  assert_log_excludes "${CALL_LOG}" "az containerapp update"
  if [[ -z "${snapshot_context}" || -e "${snapshot_context}" ]]; then
    fail "bootstrap parent did not remove the private snapshot after leader death"
  fi
  pass
}

test_release_git_environment_isolation() {
  local harness canonical_url hostile_url canonical_sha hostile_sha control_sha isolated_sha
  harness="$(mktemp -d)"
  TEMP_DIRS+=("${harness}")
  git init -q "${harness}/work"
  git -C "${harness}/work" config user.name "Release Test"
  git -C "${harness}/work" config user.email "release-test@example.invalid"
  printf 'canonical\n' >"${harness}/work/payload.txt"
  git -C "${harness}/work" add payload.txt
  git -C "${harness}/work" commit -q -m "canonical"
  git -C "${harness}/work" branch -M main
  canonical_sha="$(git -C "${harness}/work" rev-parse HEAD)"
  git init -q --bare "${harness}/canonical.git"
  git -C "${harness}/work" push -q "${harness}/canonical.git" HEAD:refs/heads/main

  printf 'hostile\n' >"${harness}/work/payload.txt"
  git -C "${harness}/work" commit -q -am "hostile"
  hostile_sha="$(git -C "${harness}/work" rev-parse HEAD)"
  git init -q --bare "${harness}/hostile.git"
  git -C "${harness}/work" push -q "${harness}/hostile.git" HEAD:refs/heads/main

  canonical_url="file://${harness}/canonical.git"
  hostile_url="file://${harness}/hostile.git"
  printf '[url "%s"]\n\tinsteadOf = %s\n' "${hostile_url}" "${canonical_url}" \
    >"${harness}/hostile-gitconfig"

  control_sha="$(env \
    GIT_CONFIG_GLOBAL="${harness}/hostile-gitconfig" \
    GIT_CONFIG_COUNT=1 \
    GIT_CONFIG_KEY_0="url.${hostile_url}.insteadOf" \
    GIT_CONFIG_VALUE_0="${canonical_url}" \
    git ls-remote "${canonical_url}" refs/heads/main | awk '{ print $1 }')"
  if [[ "${control_sha}" != "${hostile_sha}" ]]; then
    fail "hostile Git URL rewrite fixture did not redirect the control request"
  fi

  isolated_sha="$(env \
    ALL_PROXY="http://127.0.0.1:1" \
    GIT_CONFIG_GLOBAL="${harness}/hostile-gitconfig" \
    GIT_CONFIG_COUNT=1 \
    GIT_CONFIG_KEY_0="url.${hostile_url}.insteadOf" \
    GIT_CONFIG_VALUE_0="${canonical_url}" \
    GIT_SSL_NO_VERIFY=true \
    GIT_TRACE="${harness}/git-trace" \
    HTTPS_PROXY="http://127.0.0.1:1" \
    bash "${REPO_ROOT}/scripts/run-release-git.sh" \
      ls-remote "${canonical_url}" refs/heads/main | awk '{ print $1 }')"
  if [[ "${isolated_sha}" != "${canonical_sha}" ||
    "${isolated_sha}" == "${hostile_sha}" ]]; then
    fail "release Git helper accepted caller-controlled URL rewrite configuration"
  fi
  if [[ -e "${harness}/git-trace" ]]; then
    fail "release Git helper honored caller-controlled trace output"
  fi
  pass
}

test_release_lease_real_git_protocol() {
  local harness lock_ref source_commit source_tree lease_a lease_b remaining
  harness="$(mktemp -d)"
  TEMP_DIRS+=("${harness}")
  lock_ref="refs/heads/workforce-os-release-lock/production-gtm-platform"

  git init -q "${harness}/source"
  git -C "${harness}/source" config user.name "Release Test"
  git -C "${harness}/source" config user.email "release-test@example.invalid"
  printf 'source\n' >"${harness}/source/payload.txt"
  git -C "${harness}/source" add payload.txt
  git -C "${harness}/source" commit -q -m "source"
  source_commit="$(git -C "${harness}/source" rev-parse HEAD)"
  git init -q --bare "${harness}/remote.git"
  git -C "${harness}/source" push -q \
    "${harness}/remote.git" HEAD:refs/heads/release/go-live-test

  bash "${REPO_ROOT}/scripts/run-release-git.sh" init -q --bare "${harness}/a.git"
  bash "${REPO_ROOT}/scripts/run-release-git.sh" init -q --bare "${harness}/b.git"
  bash "${REPO_ROOT}/scripts/run-release-git.sh" --git-dir="${harness}/a.git" \
    fetch -q --no-tags "${harness}/remote.git" "${source_commit}"
  bash "${REPO_ROOT}/scripts/run-release-git.sh" --git-dir="${harness}/b.git" \
    fetch -q --no-tags "${harness}/remote.git" "${source_commit}"
  source_tree="$(bash "${REPO_ROOT}/scripts/run-release-git.sh" \
    --git-dir="${harness}/a.git" rev-parse "${source_commit}^{tree}")"
  lease_a="$(printf 'release lease attempt a\n' | env \
    GIT_AUTHOR_NAME='Release Test' \
    GIT_AUTHOR_EMAIL='release-test@example.invalid' \
    GIT_COMMITTER_NAME='Release Test' \
    GIT_COMMITTER_EMAIL='release-test@example.invalid' \
    bash "${REPO_ROOT}/scripts/run-release-git.sh" \
      --git-dir="${harness}/a.git" commit-tree "${source_tree}" -p "${source_commit}")"
  lease_b="$(printf 'release lease attempt b\n' | env \
    GIT_AUTHOR_NAME='Release Test' \
    GIT_AUTHOR_EMAIL='release-test@example.invalid' \
    GIT_COMMITTER_NAME='Release Test' \
    GIT_COMMITTER_EMAIL='release-test@example.invalid' \
    bash "${REPO_ROOT}/scripts/run-release-git.sh" \
      --git-dir="${harness}/b.git" commit-tree "${source_tree}" -p "${source_commit}")"
  if [[ "${lease_a}" == "${lease_b}" || "${lease_a}" == "${source_commit}" ||
    "${lease_b}" == "${source_commit}" ]]; then
    fail "real Git lease fixture did not create unique per-attempt identities"
  fi

  bash "${REPO_ROOT}/scripts/run-release-git.sh" --git-dir="${harness}/a.git" \
    push -q "--force-with-lease=${lock_ref}:" \
    "${harness}/remote.git" "${lease_a}:${lock_ref}"
  if bash "${REPO_ROOT}/scripts/run-release-git.sh" --git-dir="${harness}/b.git" \
    push -q "--force-with-lease=${lock_ref}:" \
    "${harness}/remote.git" "${lease_b}:${lock_ref}" >/dev/null 2>&1; then
    fail "second real Git lease attempt acquired an already-held lock"
  fi
  bash "${REPO_ROOT}/scripts/run-release-git.sh" --git-dir="${harness}/a.git" \
    push -q "--force-with-lease=${lock_ref}:${lease_a}" \
    "${harness}/remote.git" ":${lock_ref}"
  bash "${REPO_ROOT}/scripts/run-release-git.sh" --git-dir="${harness}/b.git" \
    push -q "--force-with-lease=${lock_ref}:" \
    "${harness}/remote.git" "${lease_b}:${lock_ref}"
  if bash "${REPO_ROOT}/scripts/run-release-git.sh" --git-dir="${harness}/a.git" \
    push -q "--force-with-lease=${lock_ref}:${lease_a}" \
    "${harness}/remote.git" ":${lock_ref}" >/dev/null 2>&1; then
    fail "stale real Git cleanup deleted a successor lease"
  fi
  remaining="$(bash "${REPO_ROOT}/scripts/run-release-git.sh" \
    ls-remote "${harness}/remote.git" "${lock_ref}" | awk '{ print $1 }')"
  if [[ "${remaining}" != "${lease_b}" ]]; then
    fail "successor real Git lease did not remain after stale cleanup rejection"
  fi
  pass
}

test_bootstrap_archive_attribute_isolation() {
  local harness candidate_commit hostile_attr_commit output_file
  harness="$(mktemp -d)"
  TEMP_DIRS+=("${harness}")
  mkdir -p "${harness}/repo/scripts" "${harness}/repo/docs/ops"
  cp "${REPO_ROOT}/scripts/deploy-prod.sh" \
    "${REPO_ROOT}/scripts/run-release-git.sh" \
    "${REPO_ROOT}/scripts/verify-github-release-ci.sh" \
    "${REPO_ROOT}/scripts/verify-migration-release-receipt.sh" \
    "${REPO_ROOT}/scripts/verify-registry-api-image.sh" \
    "${REPO_ROOT}/scripts/verify-api-image.sh" \
    "${REPO_ROOT}/scripts/verify-containerapp-release-config.sh" \
    "${harness}/repo/scripts/"
  cp "${REPO_ROOT}/docs/ops/production-clerk-auth.sha256" \
    "${harness}/repo/docs/ops/"
  chmod +x \
    "${harness}/repo/scripts/deploy-prod.sh" \
    "${harness}/repo/scripts/verify-github-release-ci.sh" \
    "${harness}/repo/scripts/verify-migration-release-receipt.sh" \
    "${harness}/repo/scripts/verify-registry-api-image.sh" \
    "${harness}/repo/scripts/verify-api-image.sh" \
    "${harness}/repo/scripts/verify-containerapp-release-config.sh"
  git -C "${harness}/repo" init -q
  git -C "${harness}/repo" config user.name "Release Test"
  git -C "${harness}/repo" config user.email "release-test@example.invalid"
  git -C "${harness}/repo" checkout -q -b attribute-test
  git -C "${harness}/repo" add scripts docs/ops
  git -C "${harness}/repo" commit -q -m "candidate"
  candidate_commit="$(git -C "${harness}/repo" rev-parse HEAD)"

  printf 'scripts/deploy-prod.sh export-ignore\nscripts/run-release-git.sh export-ignore\n' \
    >"${harness}/repo/.gitattributes"
  git -C "${harness}/repo" add .gitattributes
  git -C "${harness}/repo" commit -q -m "hostile attribute source"
  hostile_attr_commit="$(git -C "${harness}/repo" rev-parse HEAD)"
  git -C "${harness}/repo" reset -q --hard "${candidate_commit}"

  printf 'scripts/deploy-prod.sh export-ignore\n' \
    >"${harness}/repo/.git/info/attributes"
  printf 'scripts/run-release-git.sh export-ignore\n' \
    >"${harness}/hostile-global-attributes"
  : >"${harness}/receipt.json"
  : >"${harness}/receipt.json.sig"
  : >"${harness}/allowed-signers"
  cat >"${harness}/hostile-bash-env.sh" <<'EOF'
printf 'bash-env-executed\n' >>"${BASH_ENV_MARKER}"
EOF
  : >"${harness}/bash-env-marker"
  : >"${harness}/exported-function-marker"
  output_file="${harness}/attribute-output.log"

  if (
    cd "${harness}/repo"
    bash() {
      printf 'exported-bash-function-executed\n' >>"${EXPORTED_FUNCTION_MARKER}"
      command bash "$@"
    }
    command() {
      printf 'exported-command-function-executed\n' >>"${EXPORTED_FUNCTION_MARKER}"
      builtin command "$@"
    }
    function /usr/bin/env() {
      printf 'exported-env-function-executed\n' >>"${EXPORTED_FUNCTION_MARKER}"
      builtin command /usr/bin/env "$@"
    }
    export -f bash command /usr/bin/env
    env \
      ACA_EXCLUSIVE_MUTATION_AUTHORITY_CONFIRMED=true \
      BASH_ENV="${harness}/hostile-bash-env.sh" \
      ENV="${harness}/hostile-bash-env.sh" \
      BASH_ENV_MARKER="${harness}/bash-env-marker" \
      EXPORTED_FUNCTION_MARKER="${harness}/exported-function-marker" \
      GIT_ATTR_SOURCE="${hostile_attr_commit}" \
      GIT_CONFIG_COUNT=1 \
      GIT_CONFIG_KEY_0=core.attributesFile \
      GIT_CONFIG_VALUE_0="${harness}/hostile-global-attributes" \
      TAR_OPTIONS='--exclude=scripts/deploy-prod.sh' \
      scripts/deploy-prod.sh \
        --migration-receipt "${harness}/receipt.json" \
        --migration-signature "${harness}/receipt.json.sig" \
        --migration-allowed-signers "${harness}/allowed-signers" \
        --yes
  ) >"${output_file}" 2>&1; then
    fail "attribute isolation fixture unexpectedly passed branch admission"
  fi
  assert_log_contains "${output_file}" "current branch is 'attribute-test', expected release/go-live-*"
  assert_log_excludes "${output_file}" "snapshot does not contain a regular executable release controller"
  assert_log_excludes "${output_file}" "release helper must be a regular non-symlink snapshot file"
  if [[ -s "${harness}/bash-env-marker" ]]; then
    fail "BASH_ENV executed in the bootstrap, exact-commit controller, or descendants"
  fi
  if [[ -s "${harness}/exported-function-marker" ]]; then
    fail "an exported Bash function reached the exact-commit controller"
  fi
  pass
}

test_snapshot_helper_symlink_rejection() {
  make_deploy_harness
  FAKE_BRANCH="release/go-live-test"
  FAKE_COMMIT="$(printf '1%.0s' {1..40})"
  FAKE_REMOTE_COMMIT="${FAKE_COMMIT}"
  FAKE_RUN_ID="ca123"
  FAKE_DIGEST="sha256:$(printf '2%.0s' {1..64})"
  printf '#!/usr/bin/env bash\nexit 0\n' >"${HARNESS}/outside-git-helper.sh"
  chmod +x "${HARNESS}/outside-git-helper.sh"
  rm -f -- "${HARNESS}/repo/scripts/run-release-git.sh"
  ln -s "${HARNESS}/outside-git-helper.sh" \
    "${HARNESS}/repo/scripts/run-release-git.sh"

  if run_fake_deploy >"${HARNESS}/symlink-output.log" 2>&1; then
    fail "snapshot controller accepted a release helper symlink escaping the snapshot"
  fi
  assert_log_contains "${HARNESS}/symlink-output.log" \
    "release helper must be a regular non-symlink snapshot file: scripts/run-release-git.sh"
  assert_log_excludes "${CALL_LOG}" "gh "
  assert_log_excludes "${CALL_LOG}" "az "
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

test_production_release_workflow_verifier() {
  local harness verifier workflow fixture intermediate
  harness="$(mktemp -d)"
  TEMP_DIRS+=("${harness}")
  verifier="${REPO_ROOT}/scripts/verify-production-release-workflow.sh"
  workflow="${REPO_ROOT}/.github/workflows/release-production.yml"

  if [[ ! -x "${verifier}" ]]; then
    fail "production release workflow verifier is not executable"
  fi
  "${verifier}" "${workflow}" >/dev/null
  pass

  fixture="${harness}/automatic-trigger.yml"
  awk '{
    print
    if ($0 == "on:") print "  push:"
  }' "${workflow}" >"${fixture}"
  if "${verifier}" "${fixture}" >/dev/null 2>&1; then
    fail "workflow verifier accepted an automatic production trigger"
  fi
  pass

  fixture="${harness}/pre-audit-step.yml"
  awk '{
    print
    if ($0 == "    steps:") {
      print "      - name: Unreviewed pre-audit write"
      print "        run: echo unreviewed"
    }
  }' "${workflow}" >"${fixture}"
  if "${verifier}" "${fixture}" >/dev/null 2>&1; then
    fail "workflow verifier accepted an added pre-audit run step"
  fi
  pass

  fixture="${harness}/job-container.yml"
  awk '{
    print
    if ($0 == "    runs-on: ubuntu-24.04") print "    container: ubuntu:latest"
  }' "${workflow}" >"${fixture}"
  if "${verifier}" "${fixture}" >/dev/null 2>&1; then
    fail "workflow verifier accepted an unreviewed job container"
  fi
  pass

  fixture="${harness}/job-strategy.yml"
  awk '{
    print
    if ($0 == "    runs-on: ubuntu-24.04") print "    strategy: { fail-fast: false }"
  }' "${workflow}" >"${fixture}"
  if "${verifier}" "${fixture}" >/dev/null 2>&1; then
    fail "workflow verifier accepted an unreviewed job strategy"
  fi
  pass

  fixture="${harness}/yaml-anchor.yml"
  sed 's/^    name: Protected production release$/    name: \&release_job Protected production release/' \
    "${workflow}" >"${fixture}"
  if "${verifier}" "${fixture}" >/dev/null 2>&1; then
    fail "workflow verifier accepted a YAML anchor"
  fi
  pass

  fixture="${harness}/shell-override.yml"
  awk '{
    print
    if ($0 == "      - name: Validate manual release admission") print "        shell: sh"
  }' "${workflow}" >"${fixture}"
  if "${verifier}" "${fixture}" >/dev/null 2>&1; then
    fail "workflow verifier accepted a shell override"
  fi
  pass

  fixture="${harness}/skipped-azure-identity.yml"
  awk '{
    print
    if ($0 == "      - name: Verify Azure production identity") {
      print "        if: ${{ false }}"
    }
  }' "${workflow}" >"${fixture}"
  if "${verifier}" "${fixture}" >/dev/null 2>&1; then
    fail "workflow verifier accepted a conditional Azure identity check"
  fi
  pass

  fixture="${harness}/ignored-azure-identity-failure.yml"
  awk '{
    print
    if ($0 == "      - name: Verify Azure production identity") {
      print "        continue-on-error: true"
    }
  }' "${workflow}" >"${fixture}"
  if "${verifier}" "${fixture}" >/dev/null 2>&1; then
    fail "workflow verifier accepted continue-on-error for Azure identity"
  fi
  pass

  fixture="${harness}/mutable-checkout.yml"
  sed 's#actions/checkout@11d5960a326750d5838078e36cf38b85af677262#actions/checkout@v4#' \
    "${workflow}" >"${fixture}"
  if "${verifier}" "${fixture}" >/dev/null 2>&1; then
    fail "workflow verifier accepted a mutable action reference"
  fi
  pass

  fixture="${harness}/downgraded-permissions.yml"
  sed 's/^  contents: write$/  contents: read/' "${workflow}" >"${fixture}"
  if "${verifier}" "${fixture}" >/dev/null 2>&1; then
    fail "workflow verifier accepted downgraded release permissions"
  fi
  pass

  fixture="${harness}/wrong-release-client.yml"
  sed 's/2efd64b0-87c1-43a7-a064-30679ce8b764/00000000-0000-0000-0000-000000000000/' \
    "${workflow}" >"${fixture}"
  if "${verifier}" "${fixture}" >/dev/null 2>&1; then
    fail "workflow verifier accepted an unreviewed release identity"
  fi
  pass

  fixture="${harness}/wrong-release-tenant.yml"
  sed 's/d4b3813d-146f-4d03-96b8-d6e5862d58a2/00000000-0000-0000-0000-000000000000/' \
    "${workflow}" >"${fixture}"
  if "${verifier}" "${fixture}" >/dev/null 2>&1; then
    fail "workflow verifier accepted an unreviewed Azure tenant"
  fi
  pass

  fixture="${harness}/source-authority-downgraded.yml"
  sed 's/exclusive_mutation_authority="true"/exclusive_mutation_authority="false"/' \
    "${workflow}" >"${fixture}"
  if "${verifier}" "${fixture}" >/dev/null 2>&1; then
    fail "workflow verifier accepted downgraded mutation authority"
  fi
  pass

  fixture="${harness}/repository-specific-control-blob.yml"
  sed 's#workforce-os/initial-production-bootstrap/state-v1.json#workforce-os/backend-only/state-v1.json#g' \
    "${workflow}" >"${fixture}"
  if "${verifier}" "${fixture}" >/dev/null 2>&1; then
    fail "workflow verifier accepted a repository-specific production-control blob"
  fi
  pass

  fixture="${harness}/fallback-control-variable.yml"
  sed 's#${{ steps.production_environment.outputs.production_control_storage_blob }}#${{ vars.WORKFORCE_PRODUCTION_CONTROL_STORAGE_BLOB }}#' \
    "${workflow}" >"${fixture}"
  if "${verifier}" "${fixture}" >/dev/null 2>&1; then
    fail "workflow verifier accepted fallback scope for the shared lease identity"
  fi
  pass

  fixture="${harness}/environment-admin-api.yml"
  awk '
    { print }
    !changed && $0 == "          set -Eeuo pipefail" {
      print "          gh api \"repos/${GITHUB_REPOSITORY}/environments/workforce-os-production\" >/dev/null"
      changed = 1
    }
  ' "${workflow}" >"${fixture}"
  if "${verifier}" "${fixture}" >/dev/null 2>&1; then
    fail "workflow verifier accepted an impossible Environment administration API query"
  fi
  pass

  fixture="${harness}/job-scoped-github-token.yml"
  awk '
    !changed && /^          GH_TOKEN:/ {
      sub(/^          /, "      ")
      changed = 1
    }
    { print }
  ' "${workflow}" >"${fixture}"
  if "${verifier}" "${fixture}" >/dev/null 2>&1; then
    fail "workflow verifier accepted a job-scoped GitHub token"
  fi
  pass

  fixture="${harness}/release-ref-workflow.yml"
  sed 's#if \[\[ "${GITHUB_REF}" != "refs/heads/master"#if [[ "${GITHUB_REF}" != "refs/heads/release/go-live-*"#' \
    "${workflow}" >"${fixture}"
  if "${verifier}" "${fixture}" >/dev/null 2>&1; then
    fail "workflow verifier accepted privileged workflow execution from a release ref"
  fi
  pass

  fixture="${harness}/unchecked-remote-master.yml"
  sed 's#repos/${GITHUB_REPOSITORY}/git/ref/heads/master#repos/${GITHUB_REPOSITORY}/commits/${WORKFLOW_SHA}#' \
    "${workflow}" >"${fixture}"
  if "${verifier}" "${fixture}" >/dev/null 2>&1; then
    fail "workflow verifier accepted trusted source without a remote master-head check"
  fi
  pass

  fixture="${harness}/unprotected-release-branch.yml"
  sed 's/and \.protected == true/and .protected == false/' \
    "${workflow}" >"${fixture}"
  if "${verifier}" "${fixture}" >/dev/null 2>&1; then
    fail "workflow verifier accepted an unprotected production candidate branch"
  fi
  pass

  fixture="${harness}/fallback-vars-context.yml"
  sed 's#${{ steps.production_environment.outputs.azure_client_id }}#${{ vars.AZURE_CLIENT_ID }}#' \
    "${workflow}" >"${fixture}"
  if "${verifier}" "${fixture}" >/dev/null 2>&1; then
    fail "workflow verifier accepted fallback vars context for the OIDC identity"
  fi
  pass

  fixture="${harness}/missing-environment-output.yml"
  sed '/printf '\''azure_client_id=%s\\n'\'' "${azure_client_id}" >>"${GITHUB_OUTPUT}"/d' \
    "${workflow}" >"${fixture}"
  if "${verifier}" "${fixture}" >/dev/null 2>&1; then
    fail "workflow verifier accepted an unaudited OIDC output path"
  fi
  pass

  fixture="${harness}/detached-release-head.yml"
  sed '/git checkout --force -B "${RELEASE_BRANCH}" "${RELEASE_SHA}"/d' \
    "${workflow}" >"${fixture}"
  if "${verifier}" "${fixture}" >/dev/null 2>&1; then
    fail "workflow verifier accepted a detached release checkout"
  fi
  pass

  fixture="${harness}/first-signer-pin-only.yml"
  sed 's/{ print }/{ print $1; exit }/' \
    "${workflow}" >"${fixture}"
  if "${verifier}" "${fixture}" >/dev/null 2>&1; then
    fail "workflow verifier accepted a first-line-only signer pin parser"
  fi
  pass

  fixture="${harness}/candidate-controlled-verifier.yml"
  sed 's#release-control/scripts/verify-production-release-workflow.sh#candidate/scripts/verify-production-release-workflow.sh#' \
    "${workflow}" >"${fixture}"
  if "${verifier}" "${fixture}" >/dev/null 2>&1; then
    fail "workflow verifier accepted the candidate branch as privileged control source"
  fi
  pass

  fixture="${harness}/missing-release-ci.yml"
  sed '/run: release-control\/scripts\/verify-github-release-ci.sh "${RELEASE_SHA}"/d' \
    "${workflow}" >"${fixture}"
  if "${verifier}" "${fixture}" >/dev/null 2>&1; then
    fail "workflow verifier accepted Azure access before exact-commit CI admission"
  fi
  pass

  fixture="${harness}/hardcoded-authority.yml"
  sed 's#^          ACA_EXCLUSIVE_MUTATION_AUTHORITY_CONFIRMED:.*$#          ACA_EXCLUSIVE_MUTATION_AUTHORITY_CONFIRMED: true#' \
    "${workflow}" >"${fixture}"
  if "${verifier}" "${fixture}" >/dev/null 2>&1; then
    fail "workflow verifier accepted hardcoded exclusive mutation authority"
  fi
  pass

  intermediate="${harness}/authority-input-added.yml"
  fixture="${harness}/input-authority.yml"
  awk '{
    print
    if ($0 == "    inputs:") print "      authority: { required: true, type: boolean }"
  }' "${workflow}" >"${intermediate}"
  sed 's#${{ steps.production_environment.outputs.exclusive_mutation_authority }}#${{ inputs.authority }}#' \
    "${intermediate}" >"${fixture}"
  if "${verifier}" "${fixture}" >/dev/null 2>&1; then
    fail "workflow verifier accepted dispatch-controlled mutation authority"
  fi
  pass

  fixture="${harness}/unsafe-migration-evidence.yml"
  sed 's#${{ secrets.PRODUCTION_MIGRATION_RECEIPT_B64 }}#${{ inputs.release_sha }}#' \
    "${workflow}" >"${fixture}"
  if "${verifier}" "${fixture}" >/dev/null 2>&1; then
    fail "workflow verifier accepted migration evidence from a dispatch input"
  fi
  pass

  fixture="${harness}/inherited-migration-evidence.yml"
  sed '/unset MIGRATION_RECEIPT_B64 MIGRATION_SIGNATURE_B64 MIGRATION_ALLOWED_SIGNERS_B64/d' \
    "${workflow}" >"${fixture}"
  if "${verifier}" "${fixture}" >/dev/null 2>&1; then
    fail "workflow verifier accepted inherited base64 migration evidence"
  fi
  pass

  fixture="${harness}/shell-wrapped-controller.yml"
  sed 's#^          scripts/deploy-prod.sh \\#          bash scripts/deploy-prod.sh \\#' \
    "${workflow}" >"${fixture}"
  if "${verifier}" "${fixture}" >/dev/null 2>&1; then
    fail "workflow verifier accepted a shell-wrapped release controller"
  fi
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
if [[ "${GH_HOST:-}" != "github.com" ]]; then
  exit 91
fi
if env | grep -Eq '^(ALL_PROXY|CURL_CA_BUNDLE|GH_DEBUG|HTTPS_PROXY|HTTP_PROXY|SSL_CERT_DIR|SSL_CERT_FILE|all_proxy|http_proxy|https_proxy)='; then
  exit 92
fi
if [[ "$*" != *"--repo github.com/Kloudedge-apex/apex-product"* ]]; then
  exit 93
fi
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
      {name: "Migration Rehearsal (blocking)", status: "completed", conclusion: "success"},
      {name: "Production Image Contract", status: "completed", conclusion: "success"}
    ]
  }' >"${harness}/run.json"

  env PATH="${harness}/bin:${PATH}" ALL_PROXY="http://127.0.0.1:1" \
    CURL_CA_BUNDLE="${harness}/hostile-ca.pem" GH_DEBUG=api GH_HOST=evil.invalid \
    HTTPS_PROXY="http://127.0.0.1:1" RUN_LIST_JSON="${harness}/runs.json" \
    RUN_VIEW_JSON="${harness}/run.json" \
    "${harness}/scripts/verify-github-release-ci.sh" "${commit}" >/dev/null
  pass

  jq '(.jobs[] | select(.name == "Production Image Contract").conclusion) = "failure"' \
    "${harness}/run.json" >"${harness}/failed-run.json"
  if env PATH="${harness}/bin:${PATH}" ALL_PROXY="http://127.0.0.1:1" \
    CURL_CA_BUNDLE="${harness}/hostile-ca.pem" GH_DEBUG=api GH_HOST=evil.invalid \
    HTTPS_PROXY="http://127.0.0.1:1" RUN_LIST_JSON="${harness}/runs.json" \
    RUN_VIEW_JSON="${harness}/failed-run.json" \
    "${harness}/scripts/verify-github-release-ci.sh" "${commit}" >/dev/null 2>&1; then
    fail "GitHub CI verifier accepted a failed required job"
  fi
  pass

  jq 'del(.jobs[] | select(.name == "Migration Rehearsal (blocking)"))' \
    "${harness}/run.json" >"${harness}/missing-migration-rehearsal.json"
  if env PATH="${harness}/bin:${PATH}" RUN_LIST_JSON="${harness}/runs.json" \
    RUN_VIEW_JSON="${harness}/missing-migration-rehearsal.json" \
    "${harness}/scripts/verify-github-release-ci.sh" "${commit}" >/dev/null 2>&1; then
    fail "GitHub CI verifier accepted a missing migration rehearsal job"
  fi
  pass

  jq '(.jobs[] | select(.name == "Migration Rehearsal (blocking)").conclusion) = "failure"' \
    "${harness}/run.json" >"${harness}/failed-migration-rehearsal.json"
  if env PATH="${harness}/bin:${PATH}" RUN_LIST_JSON="${harness}/runs.json" \
    RUN_VIEW_JSON="${harness}/failed-migration-rehearsal.json" \
    "${harness}/scripts/verify-github-release-ci.sh" "${commit}" >/dev/null 2>&1; then
    fail "GitHub CI verifier accepted a failed migration rehearsal job"
  fi
  pass

  jq '.jobs += [.jobs[] | select(.name == "Migration Rehearsal (blocking)")]' \
    "${harness}/run.json" >"${harness}/duplicate-migration-rehearsal.json"
  if env PATH="${harness}/bin:${PATH}" RUN_LIST_JSON="${harness}/runs.json" \
    RUN_VIEW_JSON="${harness}/duplicate-migration-rehearsal.json" \
    "${harness}/scripts/verify-github-release-ci.sh" "${commit}" >/dev/null 2>&1; then
    fail "GitHub CI verifier accepted duplicate migration rehearsal jobs"
  fi
  pass
}

test_migration_receipt_contract_parity() {
  local schema_min schema_max verifier_count schema_version
  schema_min="$(jq -er '.properties.migrations.minItems | numbers' \
    "${REPO_ROOT}/docs/ops/production-migration-receipt.schema.json")"
  schema_max="$(jq -er '.properties.migrations.maxItems | numbers' \
    "${REPO_ROOT}/docs/ops/production-migration-receipt.schema.json")"
  verifier_count="$(awk '
    /^MIGRATIONS=\($/ { in_migrations = 1; next }
    in_migrations && /^\)$/ { print count; exit }
    in_migrations && /^[[:space:]]+"/ { count += 1 }
  ' "${REPO_ROOT}/scripts/verify-migration-release-receipt.sh")"
  schema_version="$(jq -er '.properties.schemaVersion.const' \
    "${REPO_ROOT}/docs/ops/production-migration-receipt.schema.json")"

  [[ "${schema_min}" == "${schema_max}" ]] ||
    fail "migration receipt schema minItems/maxItems disagree: ${schema_min}/${schema_max}"
  [[ "${schema_min}" == "${verifier_count}" ]] ||
    fail "migration receipt schema expects ${schema_min} entries but verifier inventories ${verifier_count}"
  grep -Fq -- 'EXPECTED_MIGRATION_COUNT="${#MIGRATIONS[@]}"' \
    "${REPO_ROOT}/scripts/verify-migration-release-receipt.sh" ||
    fail "migration verifier count is not derived from its migration inventory"
  grep -Fq -- 'length == $migration_count' \
    "${REPO_ROOT}/scripts/verify-migration-release-receipt.sh" ||
    fail "migration verifier does not enforce its derived migration count"
  [[ "${schema_version}" == "3" ]] ||
    fail "production migration receipt schema is not freshness-bound compatibility-baseline v3"
  jq -e '
    (.required | index("rollbackBaseline")) != null
    and (.required | index("expiresAt")) != null
    and (.properties.rollbackBaseline.required | length) == 10
    and (.properties.rollbackBaseline.properties.compatibilityAttestation.const
      == "enum-aware-api-worker-console-baseline-v1")
  ' "${REPO_ROOT}/docs/ops/production-migration-receipt.schema.json" >/dev/null ||
    fail "migration receipt schema does not require the complete rollback baseline"
  pass
}

test_migration_receipt_verifier() {
  local harness commit evidence migrations_json index path pause source_hash entry
  local api_image worker_image console_image api_revision worker_revision console_revision
  local now_epoch verified_at expires_at
  local -a paths pauses
  harness="$(mktemp -d)"
  TEMP_DIRS+=("${harness}")
  mkdir -p "${harness}/repo/scripts"
  cp "${REPO_ROOT}/scripts/verify-migration-release-receipt.sh" "${harness}/repo/scripts/"
  paths=(
    "docs/migrations/2026-08-13_clerk-identity-lifecycle-expand.sql"
    "docs/migrations/2026-06-01_outreach-artifact-unique.sql"
    "docs/migrations/2026-08-12_conversation-store-expand.sql"
    "docs/migrations/2026-08-12_outreach-delivery-unknown-expand.sql"
    "docs/migrations/2026-08-13_outreach-artifact-failed-expand.sql"
    "docs/migrations/2026-08-12_conversation-reply-single-flight-expand.sql"
    "docs/migrations/2026-08-12_graph-run-activity-expand.sql"
    "docs/migrations/2026-08-12_graph-run-lifecycle-expand.sql"
    "docs/migrations/2026-08-20_icp-exclusion-domains-expand.sql"
    "docs/migrations/2026-09-03_agency-platform-expand.sql"
  )
  pauses=("observed" "observed" "not-required" "not-required" "not-required" "observed" "not-required" "observed" "not-required" "observed")
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
  git -C "${harness}/repo" add docs scripts
  git -C "${harness}/repo" commit -q -m "fixture: committed release evidence"
  commit="$(git -C "${harness}/repo" rev-parse HEAD)"
  evidence="sha256:$(printf '6%.0s' {1..64})"
  api_image="workforceosprodacr.azurecr.io/apex-api@sha256:$(printf '7%.0s' {1..64})"
  worker_image="workforceosprodacr.azurecr.io/apex-api@sha256:$(printf '8%.0s' {1..64})"
  console_image="workforceosprodacr.azurecr.io/workforceos-fe@sha256:$(printf '9%.0s' {1..64})"
  api_revision="apex-gtm-api--rollback-a"
  worker_revision="apex-gtm-worker--rollback-b"
  console_revision="nikxius-web--rollback-c"
  now_epoch="$(date -u +%s)"
  verified_at="$(jq -nr --argjson epoch "${now_epoch}" '$epoch | todateiso8601')"
  expires_at="$(jq -nr --argjson epoch "$((now_epoch + 600))" '$epoch | todateiso8601')"
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
    --arg api_image "${api_image}" \
    --arg api_revision "${api_revision}" \
    --arg worker_image "${worker_image}" \
    --arg worker_revision "${worker_revision}" \
    --arg console_image "${console_image}" \
    --arg console_revision "${console_revision}" \
    --arg verified_at "${verified_at}" \
    --arg expires_at "${expires_at}" \
    --argjson migrations "${migrations_json}" '{
      schemaVersion: 3,
      environment: "production",
      candidateCommit: $commit,
      status: "applied-and-verified",
      verifiedAt: $verified_at,
      expiresAt: $expires_at,
      operator: "operator-a",
      approver: "approver-b",
      changeTicket: "change-1",
      databaseIdentityHash: $evidence,
      stagingRehearsalEvidenceHash: $evidence,
      productionApplyEvidenceHash: $evidence,
      rollbackRehearsalEvidenceHash: $evidence,
      rollbackBaseline: {
        apiImage: $api_image,
        apiRevision: $api_revision,
        workerImage: $worker_image,
        workerRevision: $worker_revision,
        consoleImage: $console_image,
        consoleRevision: $console_revision,
        compatibilityAttestation: "enum-aware-api-worker-console-baseline-v1",
        compatibilityEpoch: "outreach-delivery-unknown-v1",
        deliveryUnknownWriteMode: "disabled",
        attestation: "delivery-unknown-writes-disabled-v1"
      },
      outreachQuiescence: {
        apiMutationsBlocked: true,
        legacyWorkerStopped: true,
        queuesPaused: {agentRuns: true, graphRuns: true, outreachSend: true},
        activeJobs: {agentRuns: 0, graphRuns: 0, outreachSend: 0},
        sendingRows: 0,
        firstClassDeliveryUnknownRows: 0,
        legacyDeliveryUnknownMarkerRows: 0,
        replySlotDuplicateRows: 0,
        liveSendAllowlistEmpty: true,
        evidenceHash: $evidence
      },
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

  mkdir -p "${harness}/freshness-bin"
  cat >"${harness}/freshness-bin/date" <<'EOF'
#!/usr/bin/env bash
if [[ "$*" != "-u +%s" ]]; then
  exec /bin/date "$@"
fi
count=0
if [[ -s "${DATE_CALL_COUNT}" ]]; then count="$(cat "${DATE_CALL_COUNT}")"; fi
count=$((count + 1))
printf '%s\n' "${count}" >"${DATE_CALL_COUNT}"
if [[ ${count} -eq 1 ]]; then
  printf '%s\n' "${DATE_FIRST_EPOCH}"
else
  printf '%s\n' "${DATE_FINAL_EPOCH}"
fi
EOF
  chmod +x "${harness}/freshness-bin/date"
  printf '0\n' >"${harness}/date-call-count"
  if env PATH="${harness}/freshness-bin:${PATH}" \
    DATE_CALL_COUNT="${harness}/date-call-count" \
    DATE_FIRST_EPOCH="${now_epoch}" \
    DATE_FINAL_EPOCH="$((now_epoch + 600))" \
    "${harness}/repo/scripts/verify-migration-release-receipt.sh" \
      "${harness}/receipt.json" \
      "${harness}/receipt.json.sig" \
      "${harness}/allowed-signers" \
      "${commit}" >/dev/null 2>&1; then
    fail "migration receipt verifier accepted the exact expiresAt boundary"
  fi
  [[ "$(cat "${harness}/date-call-count")" == "2" ]] ||
    fail "migration receipt verifier did not recheck freshness at return"
  pass

  jq '.rollbackBaseline.compatibilityAttestation = "unverified-baseline"' \
    "${harness}/receipt.json" >"${harness}/unverified-baseline-receipt.json"
  ssh-keygen -Y sign \
    -f "${harness}/approver-key" \
    -n workforce-os-migration-receipt \
    "${harness}/unverified-baseline-receipt.json" >/dev/null 2>&1
  if "${harness}/repo/scripts/verify-migration-release-receipt.sh" \
    "${harness}/unverified-baseline-receipt.json" \
    "${harness}/unverified-baseline-receipt.json.sig" \
    "${harness}/allowed-signers" \
    "${commit}" >/dev/null 2>&1; then
    fail "migration receipt verifier accepted an unverified enum-compatibility baseline"
  fi
  pass

  "${harness}/repo/scripts/verify-migration-release-receipt.sh" \
    "${harness}/receipt.json" \
    "${harness}/receipt.json.sig" \
    "${harness}/allowed-signers" \
    "${commit}" \
    "${api_image}" \
    "${api_revision}" \
    "${worker_image}" \
    "${worker_revision}" \
    "${console_image}" \
    "${console_revision}" \
    disabled >/dev/null
  pass

  if "${harness}/repo/scripts/verify-migration-release-receipt.sh" \
    "${harness}/receipt.json" \
    "${harness}/receipt.json.sig" \
    "${harness}/allowed-signers" \
    "${commit}" \
    "workforceosprodacr.azurecr.io/apex-api@sha256:$(printf '9%.0s' {1..64})" \
    "${api_revision}" \
    "${worker_image}" \
    "${worker_revision}" \
    "${console_image}" \
    "${console_revision}" \
    disabled >/dev/null 2>&1; then
    fail "migration receipt verifier accepted a different rollback API digest"
  fi
  pass

  if "${harness}/repo/scripts/verify-migration-release-receipt.sh" \
    "${harness}/receipt.json" \
    "${harness}/receipt.json.sig" \
    "${harness}/allowed-signers" \
    "${commit}" \
    "${api_image}" \
    "apex-gtm-api--different" \
    "${worker_image}" \
    "${worker_revision}" \
    "${console_image}" \
    "${console_revision}" \
    disabled >/dev/null 2>&1; then
    fail "migration receipt verifier accepted a different rollback API revision"
  fi
  pass

  if "${harness}/repo/scripts/verify-migration-release-receipt.sh" \
    "${harness}/receipt.json" \
    "${harness}/receipt.json.sig" \
    "${harness}/allowed-signers" \
    "${commit}" \
    "${api_image}" \
    "${api_revision}" \
    "${worker_image}" \
    "${worker_revision}" \
    "${console_image}" \
    "${console_revision}" \
    first-class >/dev/null 2>&1; then
    fail "migration receipt verifier accepted a different DELIVERY_UNKNOWN write mode"
  fi
  pass

  if "${harness}/repo/scripts/verify-migration-release-receipt.sh" \
    "${harness}/receipt.json" \
    "${harness}/receipt.json.sig" \
    "${harness}/allowed-signers" \
    "${commit}" \
    "${api_image}" \
    "${api_revision}" \
    "${worker_image}" \
    "${worker_revision}" \
    "workforceosprodacr.azurecr.io/workforceos-fe@sha256:$(printf 'a%.0s' {1..64})" \
    "${console_revision}" \
    disabled >/dev/null 2>&1; then
    fail "migration receipt verifier accepted a different console/BFF digest"
  fi
  pass

  jq '.verifiedAt = "2026-01-01T00:00:00Z" | .expiresAt = "2026-01-01T00:10:00Z"' \
    "${harness}/receipt.json" >"${harness}/stale-receipt.json"
  ssh-keygen -Y sign \
    -f "${harness}/approver-key" \
    -n workforce-os-migration-receipt \
    "${harness}/stale-receipt.json" >/dev/null 2>&1
  if "${harness}/repo/scripts/verify-migration-release-receipt.sh" \
    "${harness}/stale-receipt.json" \
    "${harness}/stale-receipt.json.sig" \
    "${harness}/allowed-signers" \
    "${commit}" >/dev/null 2>&1; then
    fail "migration receipt verifier accepted a stale signed receipt"
  fi
  pass

  jq 'del(.outreachQuiescence)' \
    "${harness}/receipt.json" >"${harness}/missing-quiescence-receipt.json"
  ssh-keygen -Y sign \
    -f "${harness}/approver-key" \
    -n workforce-os-migration-receipt \
    "${harness}/missing-quiescence-receipt.json" >/dev/null 2>&1
  if "${harness}/repo/scripts/verify-migration-release-receipt.sh" \
    "${harness}/missing-quiescence-receipt.json" \
    "${harness}/missing-quiescence-receipt.json.sig" \
    "${harness}/allowed-signers" \
    "${commit}" >/dev/null 2>&1; then
    fail "migration receipt verifier accepted disabled bootstrap without quiescence evidence"
  fi
  pass

  jq '.outreachQuiescence.legacyDeliveryUnknownMarkerRows = 1' \
    "${harness}/receipt.json" >"${harness}/legacy-marker-receipt.json"
  ssh-keygen -Y sign \
    -f "${harness}/approver-key" \
    -n workforce-os-migration-receipt \
    "${harness}/legacy-marker-receipt.json" >/dev/null 2>&1
  if "${harness}/repo/scripts/verify-migration-release-receipt.sh" \
    "${harness}/legacy-marker-receipt.json" \
    "${harness}/legacy-marker-receipt.json.sig" \
    "${harness}/allowed-signers" \
    "${commit}" >/dev/null 2>&1; then
    fail "migration receipt verifier accepted an incompatible legacy marker inventory"
  fi
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

  # Snapshot mode reads the already archived reviewed bytes directly and must
  # neither require Git metadata nor accept a mismatched snapshot identity.
  mkdir -p "${harness}/snapshot" "${harness}/no-git-bin"
  git -C "${harness}/repo" archive --format=tar "${commit}" | \
    tar -xf - -C "${harness}/snapshot"
  cat >"${harness}/no-git-bin/git" <<'EOF'
#!/usr/bin/env bash
exit 93
EOF
  chmod +x "${harness}/no-git-bin/git"
  env PATH="${harness}/no-git-bin:${PATH}" \
    WORKFORCE_RELEASE_SNAPSHOT_ACTIVE=true \
    WORKFORCE_RELEASE_SOURCE_COMMIT="${commit}" \
    WORKFORCE_RELEASE_SNAPSHOT_ROOT="${harness}/snapshot" \
    "${harness}/snapshot/scripts/verify-migration-release-receipt.sh" \
      "${harness}/receipt.json" \
      "${harness}/receipt.json.sig" \
      "${harness}/allowed-signers" \
      "${commit}" >/dev/null
  pass

  if env PATH="${harness}/no-git-bin:${PATH}" \
    WORKFORCE_RELEASE_SNAPSHOT_ACTIVE=true \
    WORKFORCE_RELEASE_SOURCE_COMMIT="$(printf '9%.0s' {1..40})" \
    WORKFORCE_RELEASE_SNAPSHOT_ROOT="${harness}/snapshot" \
    "${harness}/snapshot/scripts/verify-migration-release-receipt.sh" \
      "${harness}/receipt.json" \
      "${harness}/receipt.json.sig" \
      "${harness}/allowed-signers" \
      "${commit}" >/dev/null 2>&1; then
    fail "migration verifier accepted a mismatched exact-snapshot commit identity"
  fi
  pass

  rm -f -- "${harness}/snapshot/${paths[0]}"
  ln -s "${harness}/repo/${paths[0]}" "${harness}/snapshot/${paths[0]}"
  if env PATH="${harness}/no-git-bin:${PATH}" \
    WORKFORCE_RELEASE_SNAPSHOT_ACTIVE=true \
    WORKFORCE_RELEASE_SOURCE_COMMIT="${commit}" \
    WORKFORCE_RELEASE_SNAPSHOT_ROOT="${harness}/snapshot" \
    "${harness}/snapshot/scripts/verify-migration-release-receipt.sh" \
      "${harness}/receipt.json" \
      "${harness}/receipt.json.sig" \
      "${harness}/allowed-signers" \
      "${commit}" >/dev/null 2>&1; then
    fail "migration verifier accepted a symlinked reviewed snapshot source"
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
          maxInactiveRevisions: 10,
          ingress: (if $enabled == "true"
            then {external: false, allowInsecure: false}
            else {external: true, allowInsecure: false, targetPort: 4000, fqdn: "apex-gtm-api.braveflower-6d3bb66b.eastus.azurecontainerapps.io"}
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
              {name: "WORKFORCE_PRODUCTION_BOOTSTRAP_ATTEMPT_ID", value: "0123456789abcdef0123456789abcdef"},
              {name: "WORKFORCE_PRODUCTION_BOOTSTRAP_MIN_WRITER_FENCE_GENERATION", value: "7"},
              {name: "GMAIL_WATCH_RENEWAL_ENABLED", value: $enabled},
              {name: "GRAPH_RUN_WORKER_ENABLED", value: $enabled},
              {name: "OUTREACH_WORKER_ENABLED", value: $enabled},
              {name: "SCHEDULER_ENABLED", value: "false"},
              {name: "CORS_ALLOWED_ORIGINS", value: "https://workforceos.xyz"},
              {name: "API_PUBLIC_URL", value: "https://api.workforceos.xyz"},
              {name: "FRONTEND_URL", value: "https://workforceos.xyz"},
              {name: "OUTREACH_LIVE_FOR_ORGS", value: ""},
              {name: "OUTREACH_ALLOW_WILDCARD", value: "false"},
              {name: "EVIDENCE_LEDGER_ENABLED", value: "true"},
              {name: "CLERK_JWKS_URL", value: "https://clerk.workforceos.xyz/.well-known/jwks.json"},
              {name: "CLERK_ISSUER", value: "https://clerk.workforceos.xyz"},
              {name: "CLERK_DOMAIN", value: ""},
              {name: "CLERK_AUDIENCE", value: ""},
              {name: "CLERK_AUTHORIZED_PARTIES", value: "https://workforceos.xyz"},
              {name: "GOOGLE_CLIENT_ID", value: "gmail-client-id.apps.googleusercontent.com"},
              {name: "GOOGLE_REDIRECT_URI", value: "https://api.workforceos.xyz/api/integrations/gmail/callback"},
              {name: "GMAIL_PUBSUB_TOPIC", value: "projects/workforce-prod/topics/gmail-inbound"},
              {name: "GMAIL_PUSH_AUDIENCE", value: "https://api.workforceos.xyz/api/integrations/gmail/push"},
              {name: "GMAIL_PUSH_PUBLISHER_SA", value: "gmail-push@project.iam.gserviceaccount.com"},
              {name: "DATABASE_URL", secretRef: "database-url"},
              {name: "REDIS_URL", secretRef: "redis-url"},
              {name: "CLERK_SECRET_KEY", secretRef: "clerk-secret-key"},
              {name: "ENCRYPTION_KEY", secretRef: "encryption-key"},
              {name: "ADMIN_API_KEY", secretRef: "admin-api-key"},
              {name: "GOOGLE_CLIENT_SECRET", secretRef: "google-client-secret"},
              {name: "METRICS_AUTH_TOKEN", secretRef: "metrics-auth-token"},
              {name: "OAUTH_STATE_SECRET", secretRef: "oauth-state-secret"},
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
  local harness api_image worker_image pin_path pin_copy test_vector
  harness="$(mktemp -d)"
  TEMP_DIRS+=("${harness}")
  mkdir -p "${harness}/bin" "${harness}/scripts" "${harness}/docs/ops"
  cp "${REPO_ROOT}/scripts/verify-containerapp-release-config.sh" "${harness}/scripts/"
  cp "${REPO_ROOT}/docs/ops/production-clerk-auth.sha256" "${harness}/docs/ops/"
  pin_path="${harness}/docs/ops/production-clerk-auth.sha256"
  test_vector="$({
    printf '%s\0' 'workforce-os-clerk-auth.v1'
    printf '%s\0' \
      'CLERK_JWKS_URL=https://clerk.workforceos.xyz/.well-known/jwks.json' \
      'CLERK_ISSUER=https://clerk.workforceos.xyz' \
      'CLERK_DOMAIN=' \
      'CLERK_AUDIENCE=' \
      'CLERK_AUTHORIZED_PARTIES=https://workforceos.xyz'
  } | openssl dgst -sha256 -r | awk '{ print $1 }')"
  [[ "${test_vector}" == "5eddc3f498e16df540776fa025bef86f741fae6815abfb9dd80652026b8956ad" ]] ||
    fail "Clerk auth trust-tuple test vector drifted"
  pass
  api_image="workforceosprodacr.azurecr.io/apex-api@sha256:$(printf '7%.0s' {1..64})"
  worker_image="workforceosprodacr.azurecr.io/apex-api@sha256:$(printf '8%.0s' {1..64})"
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

  jq '(.properties.template.containers[0].env[] |
    select(.name == "API_PUBLIC_URL").value) = "https://wrong.example.com"' \
    "${harness}/api.json" >"${harness}/api-wrong-public-origin.json"
  jq '(.properties.template.containers[0].env[] |
    select(.name == "API_PUBLIC_URL").value) = "https://wrong.example.com"' \
    "${harness}/worker.json" >"${harness}/worker-wrong-public-origin.json"
  if env PATH="${harness}/bin:${PATH}" \
    API_JSON_FILE="${harness}/api-wrong-public-origin.json" \
    WORKER_JSON_FILE="${harness}/worker-wrong-public-origin.json" \
    API_REVISION_FILE="${harness}/api-revision.json" \
    WORKER_REVISION_FILE="${harness}/worker-revision.json" \
    "${harness}/scripts/verify-containerapp-release-config.sh" \
    "${api_image}" "${worker_image}" >/dev/null 2>&1; then
    fail "Container App verifier accepted a coordinated public API origin drift"
  fi
  pass

  jq '.properties.configuration.ingress.fqdn = "api.workforceos.xyz"' \
    "${harness}/api.json" >"${harness}/api-non-azure-ingress-fqdn.json"
  if env PATH="${harness}/bin:${PATH}" \
    API_JSON_FILE="${harness}/api-non-azure-ingress-fqdn.json" \
    WORKER_JSON_FILE="${harness}/worker.json" \
    API_REVISION_FILE="${harness}/api-revision.json" \
    WORKER_REVISION_FILE="${harness}/worker-revision.json" \
    "${harness}/scripts/verify-containerapp-release-config.sh" \
    "${api_image}" "${worker_image}" >/dev/null 2>&1; then
    fail "Container App verifier accepted a non-Azure isolated API ingress FQDN"
  fi
  pass

  jq '(.properties.template.containers[0].env[] |
    select(.name == "EVIDENCE_LEDGER_ENABLED").value) = "false"' \
    "${harness}/worker.json" >"${harness}/worker-evidence-disabled.json"
  if env PATH="${harness}/bin:${PATH}" \
    API_JSON_FILE="${harness}/api.json" \
    WORKER_JSON_FILE="${harness}/worker-evidence-disabled.json" \
    API_REVISION_FILE="${harness}/api-revision.json" \
    WORKER_REVISION_FILE="${harness}/worker-revision.json" \
    "${harness}/scripts/verify-containerapp-release-config.sh" \
    "${api_image}" "${worker_image}" >/dev/null 2>&1; then
    fail "Container App verifier accepted a disabled evidence ledger"
  fi
  pass

  jq '.properties.template.containers[0].env += [
    {name: "RAZORPAY_KEY_ID", value: "retired-key"},
    {name: "RAZORPAY_KEY_SECRET", secretRef: "retired-key-secret"},
    {name: "RAZORPAY_WEBHOOK_SECRET", secretRef: "retired-webhook-secret"}
  ]' "${harness}/api.json" >"${harness}/api-retired-billing-config.json"
  if env PATH="${harness}/bin:${PATH}" \
    API_JSON_FILE="${harness}/api-retired-billing-config.json" \
    WORKER_JSON_FILE="${harness}/worker.json" \
    API_REVISION_FILE="${harness}/api-revision.json" \
    WORKER_REVISION_FILE="${harness}/worker-revision.json" \
    "${harness}/scripts/verify-containerapp-release-config.sh" \
    "${api_image}" "${worker_image}" >/dev/null 2>&1; then
    fail "Container App verifier accepted retired API billing configuration"
  fi
  pass

  jq '.properties.template.containers[0].env += [
    {name: "RAZORPAY_KEY_ID", value: "retired-key"},
    {name: "RAZORPAY_KEY_SECRET", secretRef: "retired-key-secret"},
    {name: "RAZORPAY_WEBHOOK_SECRET", secretRef: "retired-webhook-secret"}
  ]' "${harness}/worker.json" >"${harness}/worker-retired-billing-config.json"
  if env PATH="${harness}/bin:${PATH}" \
    API_JSON_FILE="${harness}/api.json" \
    WORKER_JSON_FILE="${harness}/worker-retired-billing-config.json" \
    API_REVISION_FILE="${harness}/api-revision.json" \
    WORKER_REVISION_FILE="${harness}/worker-revision.json" \
    "${harness}/scripts/verify-containerapp-release-config.sh" \
    "${api_image}" "${worker_image}" >/dev/null 2>&1; then
    fail "Container App verifier accepted retired worker billing configuration"
  fi
  pass

  jq '.properties.template.containers[0].env += [{name: "WORKER_ENABLED", value: "true"}]' \
    "${harness}/worker.json" >"${harness}/worker-retired-gate.json"
  if env PATH="${harness}/bin:${PATH}" \
    API_JSON_FILE="${harness}/api.json" \
    WORKER_JSON_FILE="${harness}/worker-retired-gate.json" \
    API_REVISION_FILE="${harness}/api-revision.json" \
    WORKER_REVISION_FILE="${harness}/worker-revision.json" \
    "${harness}/scripts/verify-containerapp-release-config.sh" \
    "${api_image}" "${worker_image}" >/dev/null 2>&1; then
    fail "Container App verifier accepted the retired generic worker gate"
  fi
  pass

  jq '.properties.template.containers[0].env |= map(select(
    .name != "WORKFORCE_PRODUCTION_BOOTSTRAP_ATTEMPT_ID" and
    .name != "WORKFORCE_PRODUCTION_BOOTSTRAP_MIN_WRITER_FENCE_GENERATION"
  ))' "${harness}/api.json" >"${harness}/api-missing-bootstrap-guard.json"
  jq '.properties.template.containers[0].env |= map(select(
    .name != "WORKFORCE_PRODUCTION_BOOTSTRAP_ATTEMPT_ID" and
    .name != "WORKFORCE_PRODUCTION_BOOTSTRAP_MIN_WRITER_FENCE_GENERATION"
  ))' "${harness}/worker.json" >"${harness}/worker-missing-bootstrap-guard.json"
  if env PATH="${harness}/bin:${PATH}" \
    API_JSON_FILE="${harness}/api-missing-bootstrap-guard.json" \
    WORKER_JSON_FILE="${harness}/worker-missing-bootstrap-guard.json" \
    API_REVISION_FILE="${harness}/api-revision.json" \
    WORKER_REVISION_FILE="${harness}/worker-revision.json" \
    "${harness}/scripts/verify-containerapp-release-config.sh" \
    "${api_image}" "${worker_image}" >/dev/null 2>&1; then
    fail "Container App verifier accepted a missing bootstrap deployment guard"
  fi
  pass

  jq '(.properties.template.containers[0].env[] |
    select(.name == "WORKFORCE_PRODUCTION_BOOTSTRAP_ATTEMPT_ID").value) =
    "ffffffffffffffffffffffffffffffff"' \
    "${harness}/worker.json" >"${harness}/worker-bootstrap-attempt-drift.json"
  if env PATH="${harness}/bin:${PATH}" \
    API_JSON_FILE="${harness}/api.json" \
    WORKER_JSON_FILE="${harness}/worker-bootstrap-attempt-drift.json" \
    API_REVISION_FILE="${harness}/api-revision.json" \
    WORKER_REVISION_FILE="${harness}/worker-revision.json" \
    "${harness}/scripts/verify-containerapp-release-config.sh" \
    "${api_image}" "${worker_image}" >/dev/null 2>&1; then
    fail "Container App verifier accepted mismatched bootstrap attempt guards"
  fi
  pass

  jq '(.properties.template.containers[0].env[] |
    select(.name == "WORKFORCE_PRODUCTION_BOOTSTRAP_MIN_WRITER_FENCE_GENERATION").value) =
    "9007199254740992"' \
    "${harness}/api.json" >"${harness}/api-unsafe-bootstrap-generation.json"
  jq '(.properties.template.containers[0].env[] |
    select(.name == "WORKFORCE_PRODUCTION_BOOTSTRAP_MIN_WRITER_FENCE_GENERATION").value) =
    "9007199254740992"' \
    "${harness}/worker.json" >"${harness}/worker-unsafe-bootstrap-generation.json"
  if env PATH="${harness}/bin:${PATH}" \
    API_JSON_FILE="${harness}/api-unsafe-bootstrap-generation.json" \
    WORKER_JSON_FILE="${harness}/worker-unsafe-bootstrap-generation.json" \
    API_REVISION_FILE="${harness}/api-revision.json" \
    WORKER_REVISION_FILE="${harness}/worker-revision.json" \
    "${harness}/scripts/verify-containerapp-release-config.sh" \
    "${api_image}" "${worker_image}" >/dev/null 2>&1; then
    fail "Container App verifier accepted an unsafe bootstrap generation guard"
  fi
  pass

  jq 'del(.properties.configuration.maxInactiveRevisions)' \
    "${harness}/api.json" >"${harness}/api-missing-revision-retention.json"
  if env PATH="${harness}/bin:${PATH}" \
    API_JSON_FILE="${harness}/api-missing-revision-retention.json" \
    WORKER_JSON_FILE="${harness}/worker.json" \
    API_REVISION_FILE="${harness}/api-revision.json" \
    WORKER_REVISION_FILE="${harness}/worker-revision.json" \
    "${harness}/scripts/verify-containerapp-release-config.sh" \
    "${api_image}" "${worker_image}" >/dev/null 2>&1; then
    fail "Container App verifier accepted missing inactive-revision retention"
  fi
  pass

  jq '.properties.configuration.maxInactiveRevisions = 0' \
    "${harness}/worker.json" >"${harness}/worker-zero-revision-retention.json"
  if env PATH="${harness}/bin:${PATH}" \
    API_JSON_FILE="${harness}/api.json" \
    WORKER_JSON_FILE="${harness}/worker-zero-revision-retention.json" \
    API_REVISION_FILE="${harness}/api-revision.json" \
    WORKER_REVISION_FILE="${harness}/worker-revision.json" \
    "${harness}/scripts/verify-containerapp-release-config.sh" \
    "${api_image}" "${worker_image}" >/dev/null 2>&1; then
    fail "Container App verifier accepted zero inactive-revision retention"
  fi
  pass

  jq '.properties.template.containers[0].env |= map(select(.name != "FRONTEND_URL"))' \
    "${harness}/api.json" >"${harness}/api-missing-frontend-url.json"
  if env PATH="${harness}/bin:${PATH}" \
    API_JSON_FILE="${harness}/api-missing-frontend-url.json" \
    WORKER_JSON_FILE="${harness}/worker.json" \
    API_REVISION_FILE="${harness}/api-revision.json" WORKER_REVISION_FILE="${harness}/worker-revision.json" \
    "${harness}/scripts/verify-containerapp-release-config.sh" \
    "${api_image}" "${worker_image}" >/dev/null 2>&1; then
    fail "Container App verifier accepted API without FRONTEND_URL"
  fi
  pass

  jq '.properties.template.containers[0].env |= map(select(.name != "FRONTEND_URL"))' \
    "${harness}/worker.json" >"${harness}/worker-missing-frontend-url.json"
  if env PATH="${harness}/bin:${PATH}" \
    API_JSON_FILE="${harness}/api.json" \
    WORKER_JSON_FILE="${harness}/worker-missing-frontend-url.json" \
    API_REVISION_FILE="${harness}/api-revision.json" WORKER_REVISION_FILE="${harness}/worker-revision.json" \
    "${harness}/scripts/verify-containerapp-release-config.sh" \
    "${api_image}" "${worker_image}" >/dev/null 2>&1; then
    fail "Container App verifier accepted worker without FRONTEND_URL"
  fi
  pass

  jq '(.properties.template.containers[0].env[] | select(.name == "FRONTEND_URL").value) = "https://wrong.example.com"' \
    "${harness}/api.json" >"${harness}/api-wrong-frontend-url.json"
  jq '(.properties.template.containers[0].env[] | select(.name == "FRONTEND_URL").value) = "https://wrong.example.com"' \
    "${harness}/worker.json" >"${harness}/worker-wrong-frontend-url.json"
  if env PATH="${harness}/bin:${PATH}" \
    API_JSON_FILE="${harness}/api-wrong-frontend-url.json" \
    WORKER_JSON_FILE="${harness}/worker-wrong-frontend-url.json" \
    API_REVISION_FILE="${harness}/api-revision.json" WORKER_REVISION_FILE="${harness}/worker-revision.json" \
    "${harness}/scripts/verify-containerapp-release-config.sh" \
    "${api_image}" "${worker_image}" >/dev/null 2>&1; then
    fail "Container App verifier accepted FRONTEND_URL outside the pinned browser party"
  fi
  pass

  jq '.properties.template.containers[0].env |= map(select(.name != "OAUTH_STATE_SECRET"))' \
    "${harness}/api.json" >"${harness}/api-missing-oauth-state-secret.json"
  if env PATH="${harness}/bin:${PATH}" \
    API_JSON_FILE="${harness}/api-missing-oauth-state-secret.json" \
    WORKER_JSON_FILE="${harness}/worker.json" \
    API_REVISION_FILE="${harness}/api-revision.json" WORKER_REVISION_FILE="${harness}/worker-revision.json" \
    "${harness}/scripts/verify-containerapp-release-config.sh" \
    "${api_image}" "${worker_image}" >/dev/null 2>&1; then
    fail "Container App verifier accepted API without OAUTH_STATE_SECRET"
  fi
  pass

  jq '.properties.template.containers[0].env |= map(select(.name != "OAUTH_STATE_SECRET"))' \
    "${harness}/worker.json" >"${harness}/worker-missing-oauth-state-secret.json"
  if env PATH="${harness}/bin:${PATH}" \
    API_JSON_FILE="${harness}/api.json" \
    WORKER_JSON_FILE="${harness}/worker-missing-oauth-state-secret.json" \
    API_REVISION_FILE="${harness}/api-revision.json" WORKER_REVISION_FILE="${harness}/worker-revision.json" \
    "${harness}/scripts/verify-containerapp-release-config.sh" \
    "${api_image}" "${worker_image}" >/dev/null 2>&1; then
    fail "Container App verifier accepted worker without OAUTH_STATE_SECRET"
  fi
  pass

  pin_copy="${harness}/production-clerk-auth.saved"
  cp "${pin_path}" "${pin_copy}"
  printf '%s\n' UNCONFIGURED >"${pin_path}"
  if env PATH="${harness}/bin:${PATH}" \
    API_JSON_FILE="${harness}/api.json" WORKER_JSON_FILE="${harness}/worker.json" \
    API_REVISION_FILE="${harness}/api-revision.json" \
    WORKER_REVISION_FILE="${harness}/worker-revision.json" \
    "${harness}/scripts/verify-containerapp-release-config.sh" \
    "${api_image}" "${worker_image}" >/dev/null 2>&1; then
    fail "Container App verifier accepted an unconfigured Clerk auth pin"
  fi
  cp "${pin_copy}" "${pin_path}"
  pass

  rm -f -- "${pin_path}"
  ln -s "${pin_copy}" "${pin_path}"
  if env PATH="${harness}/bin:${PATH}" \
    API_JSON_FILE="${harness}/api.json" WORKER_JSON_FILE="${harness}/worker.json" \
    API_REVISION_FILE="${harness}/api-revision.json" \
    WORKER_REVISION_FILE="${harness}/worker-revision.json" \
    "${harness}/scripts/verify-containerapp-release-config.sh" \
    "${api_image}" "${worker_image}" >/dev/null 2>&1; then
    fail "Container App verifier accepted a symlinked Clerk auth pin"
  fi
  rm -f -- "${pin_path}"
  cp "${pin_copy}" "${pin_path}"
  pass

  while IFS='|' read -r clerk_name clerk_value; do
    jq --arg name "${clerk_name}" --arg value "${clerk_value}" \
      '(.properties.template.containers[0].env[] | select(.name == $name).value) = $value' \
      "${harness}/api.json" >"${harness}/api-clerk-drift.json"
    jq --arg name "${clerk_name}" --arg value "${clerk_value}" \
      '(.properties.template.containers[0].env[] | select(.name == $name).value) = $value' \
      "${harness}/worker.json" >"${harness}/worker-clerk-drift.json"
    if env PATH="${harness}/bin:${PATH}" \
      API_JSON_FILE="${harness}/api-clerk-drift.json" \
      WORKER_JSON_FILE="${harness}/worker-clerk-drift.json" \
      API_REVISION_FILE="${harness}/api-revision.json" \
      WORKER_REVISION_FILE="${harness}/worker-revision.json" \
      "${harness}/scripts/verify-containerapp-release-config.sh" \
      "${api_image}" "${worker_image}" >/dev/null 2>&1; then
      fail "Container App verifier accepted coordinated ${clerk_name} trust drift"
    fi
    pass
  done <<'EOF'
CLERK_JWKS_URL|https://attacker.example/.well-known/jwks.json
CLERK_ISSUER|https://attacker.example
CLERK_DOMAIN|attacker.example
CLERK_AUDIENCE|unexpected-audience
CLERK_AUTHORIZED_PARTIES|https://attacker.example
EOF

  jq '(.properties.template.containers[0].env[] | select(.name == "GOOGLE_REDIRECT_URI").value) = "https://wrong.example/api/integrations/gmail/callback"' \
    "${harness}/api.json" >"${harness}/api-wrong-google-redirect.json"
  jq '(.properties.template.containers[0].env[] | select(.name == "GOOGLE_REDIRECT_URI").value) = "https://wrong.example/api/integrations/gmail/callback"' \
    "${harness}/worker.json" >"${harness}/worker-wrong-google-redirect.json"
  if env PATH="${harness}/bin:${PATH}" \
    API_JSON_FILE="${harness}/api-wrong-google-redirect.json" \
    WORKER_JSON_FILE="${harness}/worker-wrong-google-redirect.json" \
    API_REVISION_FILE="${harness}/api-revision.json" WORKER_REVISION_FILE="${harness}/worker-revision.json" \
    "${harness}/scripts/verify-containerapp-release-config.sh" \
    "${api_image}" "${worker_image}" >/dev/null 2>&1; then
    fail "Container App verifier accepted a noncanonical Gmail OAuth redirect URI"
  fi
  pass

  jq '(.properties.template.containers[0].env[] | select(.name == "GMAIL_PUSH_AUDIENCE").value) = ""' \
    "${harness}/api.json" >"${harness}/api-empty-gmail-audience.json"
  jq '(.properties.template.containers[0].env[] | select(.name == "GMAIL_PUSH_AUDIENCE").value) = ""' \
    "${harness}/worker.json" >"${harness}/worker-empty-gmail-audience.json"
  if env PATH="${harness}/bin:${PATH}" \
    API_JSON_FILE="${harness}/api-empty-gmail-audience.json" \
    WORKER_JSON_FILE="${harness}/worker-empty-gmail-audience.json" \
    API_REVISION_FILE="${harness}/api-revision.json" WORKER_REVISION_FILE="${harness}/worker-revision.json" \
    "${harness}/scripts/verify-containerapp-release-config.sh" \
    "${api_image}" "${worker_image}" >/dev/null 2>&1; then
    fail "Container App verifier accepted an empty Gmail push audience"
  fi
  pass

  jq '(.properties.template.containers[0].env[] | select(.name == "GMAIL_PUBSUB_TOPIC").value) = "gmail-inbound"' \
    "${harness}/api.json" >"${harness}/api-invalid-gmail-topic.json"
  jq '(.properties.template.containers[0].env[] | select(.name == "GMAIL_PUBSUB_TOPIC").value) = "gmail-inbound"' \
    "${harness}/worker.json" >"${harness}/worker-invalid-gmail-topic.json"
  if env PATH="${harness}/bin:${PATH}" \
    API_JSON_FILE="${harness}/api-invalid-gmail-topic.json" \
    WORKER_JSON_FILE="${harness}/worker-invalid-gmail-topic.json" \
    API_REVISION_FILE="${harness}/api-revision.json" WORKER_REVISION_FILE="${harness}/worker-revision.json" \
    "${harness}/scripts/verify-containerapp-release-config.sh" \
    "${api_image}" "${worker_image}" >/dev/null 2>&1; then
    fail "Container App verifier accepted a malformed Gmail Pub/Sub topic"
  fi
  pass

  jq '.properties.template.containers[0].env |= map(select(.name != "METRICS_AUTH_TOKEN"))' \
    "${harness}/api.json" >"${harness}/api-missing-metrics-token.json"
  jq '.properties.template.containers[0].env |= map(select(.name != "METRICS_AUTH_TOKEN"))' \
    "${harness}/worker.json" >"${harness}/worker-missing-metrics-token.json"
  if env PATH="${harness}/bin:${PATH}" \
    API_JSON_FILE="${harness}/api-missing-metrics-token.json" \
    WORKER_JSON_FILE="${harness}/worker-missing-metrics-token.json" \
    API_REVISION_FILE="${harness}/api-revision.json" WORKER_REVISION_FILE="${harness}/worker-revision.json" \
    "${harness}/scripts/verify-containerapp-release-config.sh" \
    "${api_image}" "${worker_image}" >/dev/null 2>&1; then
    fail "Container App verifier accepted a missing METRICS_AUTH_TOKEN secretRef"
  fi
  pass

  jq '(.properties.template.containers[0].env[] | select(.name == "METRICS_AUTH_TOKEN")) = {name: "METRICS_AUTH_TOKEN", value: "inline-test-value"}' \
    "${harness}/api.json" >"${harness}/api-inline-metrics-token.json"
  jq '(.properties.template.containers[0].env[] | select(.name == "METRICS_AUTH_TOKEN")) = {name: "METRICS_AUTH_TOKEN", value: "inline-test-value"}' \
    "${harness}/worker.json" >"${harness}/worker-inline-metrics-token.json"
  if env PATH="${harness}/bin:${PATH}" \
    API_JSON_FILE="${harness}/api-inline-metrics-token.json" \
    WORKER_JSON_FILE="${harness}/worker-inline-metrics-token.json" \
    API_REVISION_FILE="${harness}/api-revision.json" WORKER_REVISION_FILE="${harness}/worker-revision.json" \
    "${harness}/scripts/verify-containerapp-release-config.sh" \
    "${api_image}" "${worker_image}" >/dev/null 2>&1; then
    fail "Container App verifier accepted an inline METRICS_AUTH_TOKEN"
  fi
  pass

  jq '.properties.template.containers[0].env += [{name: "OUTREACH_FAILED_STATUS_WRITES_ENABLED", value: "yes"}]' \
    "${harness}/worker.json" >"${harness}/worker-invalid-failed-write-gate.json"
  if env PATH="${harness}/bin:${PATH}" \
    API_JSON_FILE="${harness}/api.json" \
    WORKER_JSON_FILE="${harness}/worker-invalid-failed-write-gate.json" \
    API_REVISION_FILE="${harness}/api-revision.json" WORKER_REVISION_FILE="${harness}/worker-revision.json" \
    "${harness}/scripts/verify-containerapp-release-config.sh" \
    "${api_image}" "${worker_image}" >/dev/null 2>&1; then
    fail "Container App verifier accepted an invalid FAILED write gate"
  fi
  pass

  jq '.properties.template.containers[0].env += [{name: "OUTREACH_FAILED_STATUS_WRITES_ENABLED", value: "true"}]' \
    "${harness}/worker.json" >"${harness}/worker-unattested-failed-write-gate.json"
  if env PATH="${harness}/bin:${PATH}" \
    API_JSON_FILE="${harness}/api.json" \
    WORKER_JSON_FILE="${harness}/worker-unattested-failed-write-gate.json" \
    API_REVISION_FILE="${harness}/api-revision.json" WORKER_REVISION_FILE="${harness}/worker-revision.json" \
    "${harness}/scripts/verify-containerapp-release-config.sh" \
    "${api_image}" "${worker_image}" >/dev/null 2>&1; then
    fail "Container App verifier accepted an unattested FAILED write gate"
  fi
  pass

  jq '.properties.template.containers[0].env += [
    {name: "OUTREACH_FAILED_STATUS_WRITES_ENABLED", value: "true"},
    {name: "OUTREACH_FAILED_STATUS_WRITES_ACK", value: "readers-drained-legacy-inventory-reviewed-v1"}
  ]' "${harness}/worker.json" >"${harness}/worker-attested-failed-write-gate.json"
  if ! env PATH="${harness}/bin:${PATH}" \
    API_JSON_FILE="${harness}/api.json" \
    WORKER_JSON_FILE="${harness}/worker-attested-failed-write-gate.json" \
    API_REVISION_FILE="${harness}/api-revision.json" WORKER_REVISION_FILE="${harness}/worker-revision.json" \
    "${harness}/scripts/verify-containerapp-release-config.sh" \
    "${api_image}" "${worker_image}" >/dev/null 2>&1; then
    fail "Container App verifier rejected the attested FAILED write gate"
  fi
  pass

  jq '.properties.template.containers[0].env += [
    {name: "OUTREACH_ROLLBACK_COMPATIBILITY_EPOCH", value: "outreach-delivery-unknown-v1"}
  ]' "${harness}/worker.json" >"${harness}/worker-disabled-with-epoch.json"
  if env PATH="${harness}/bin:${PATH}" \
    API_JSON_FILE="${harness}/api.json" \
    WORKER_JSON_FILE="${harness}/worker-disabled-with-epoch.json" \
    API_REVISION_FILE="${harness}/api-revision.json" WORKER_REVISION_FILE="${harness}/worker-revision.json" \
    "${harness}/scripts/verify-containerapp-release-config.sh" \
    "${api_image}" "${worker_image}" >/dev/null 2>&1; then
    fail "Container App verifier accepted a disabled worker carrying a compatibility epoch"
  fi
  pass

  jq '.properties.template.containers[0].env += [{name: "OUTREACH_DELIVERY_UNKNOWN_WRITE_MODE", value: "first-class"}]' \
    "${harness}/api.json" >"${harness}/api-enabled-delivery-unknown-write-gate.json"
  if env PATH="${harness}/bin:${PATH}" \
    API_JSON_FILE="${harness}/api-enabled-delivery-unknown-write-gate.json" \
    WORKER_JSON_FILE="${harness}/worker.json" \
    API_REVISION_FILE="${harness}/api-revision.json" WORKER_REVISION_FILE="${harness}/worker-revision.json" \
    "${harness}/scripts/verify-containerapp-release-config.sh" \
    "${api_image}" "${worker_image}" >/dev/null 2>&1; then
    fail "Container App verifier accepted DELIVERY_UNKNOWN writes on the API"
  fi
  pass

  jq '.properties.template.containers[0].env += [{name: "OUTREACH_DELIVERY_UNKNOWN_WRITE_MODE", value: "first-class"}]' \
    "${harness}/worker.json" >"${harness}/worker-unattested-delivery-unknown-write-gate.json"
  if env PATH="${harness}/bin:${PATH}" \
    API_JSON_FILE="${harness}/api.json" \
    WORKER_JSON_FILE="${harness}/worker-unattested-delivery-unknown-write-gate.json" \
    API_REVISION_FILE="${harness}/api-revision.json" WORKER_REVISION_FILE="${harness}/worker-revision.json" \
    "${harness}/scripts/verify-containerapp-release-config.sh" \
    "${api_image}" "${worker_image}" >/dev/null 2>&1; then
    fail "Container App verifier accepted an unattested DELIVERY_UNKNOWN write gate"
  fi
  pass

  jq '.properties.template.containers[0].env += [
    {name: "OUTREACH_DELIVERY_UNKNOWN_WRITE_MODE", value: "first-class"},
    {name: "OUTREACH_DELIVERY_UNKNOWN_WRITE_ACK", value: "readers-drained-rollback-baselines-verified-v1"},
    {name: "OUTREACH_ROLLBACK_COMPATIBILITY_EPOCH", value: "wrong-epoch"}
  ]' "${harness}/worker.json" >"${harness}/worker-wrong-delivery-unknown-epoch.json"
  if env PATH="${harness}/bin:${PATH}" \
    API_JSON_FILE="${harness}/api.json" \
    WORKER_JSON_FILE="${harness}/worker-wrong-delivery-unknown-epoch.json" \
    API_REVISION_FILE="${harness}/api-revision.json" WORKER_REVISION_FILE="${harness}/worker-revision.json" \
    "${harness}/scripts/verify-containerapp-release-config.sh" \
    "${api_image}" "${worker_image}" >/dev/null 2>&1; then
    fail "Container App verifier accepted the wrong DELIVERY_UNKNOWN compatibility epoch"
  fi
  pass

  jq '.properties.template.containers[0].env += [
    {name: "OUTREACH_DELIVERY_UNKNOWN_WRITE_MODE", value: "first-class"},
    {name: "OUTREACH_DELIVERY_UNKNOWN_WRITE_ACK", value: "readers-drained-rollback-baselines-verified-v1"},
    {name: "OUTREACH_ROLLBACK_COMPATIBILITY_EPOCH", value: "outreach-delivery-unknown-v1"}
  ]' "${harness}/worker.json" >"${harness}/worker-attested-delivery-unknown-write-gate.json"
  if ! env PATH="${harness}/bin:${PATH}" \
    API_JSON_FILE="${harness}/api.json" \
    WORKER_JSON_FILE="${harness}/worker-attested-delivery-unknown-write-gate.json" \
    API_REVISION_FILE="${harness}/api-revision.json" WORKER_REVISION_FILE="${harness}/worker-revision.json" \
    "${harness}/scripts/verify-containerapp-release-config.sh" \
    "${api_image}" "${worker_image}" >/dev/null 2>&1; then
    fail "Container App verifier rejected fully attested DELIVERY_UNKNOWN writes"
  fi
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
    "${harness}/worker-attested-delivery-unknown-write-gate.json" >"${harness}/worker-wildcard.json"
  if env PATH="${harness}/bin:${PATH}" \
    API_JSON_FILE="${harness}/api-wildcard.json" WORKER_JSON_FILE="${harness}/worker-wildcard.json" \
    API_REVISION_FILE="${harness}/api-revision.json" WORKER_REVISION_FILE="${harness}/worker-revision.json" \
    "${harness}/scripts/verify-containerapp-release-config.sh" \
    "${api_image}" "${worker_image}" >/dev/null 2>&1; then
    fail "Container App verifier accepted an unacknowledged live-send wildcard"
  fi
  pass

  jq '(.properties.template.containers[0].env[] |
    select(.name == "OUTREACH_ALLOW_WILDCARD").value) = "true"' \
    "${harness}/api-wildcard.json" >"${harness}/api-wildcard-acknowledged.json"
  jq '(.properties.template.containers[0].env[] |
    select(.name == "OUTREACH_ALLOW_WILDCARD").value) = "true"' \
    "${harness}/worker-wildcard.json" >"${harness}/worker-wildcard-acknowledged.json"
  if ! env PATH="${harness}/bin:${PATH}" \
    API_JSON_FILE="${harness}/api-wildcard-acknowledged.json" \
    WORKER_JSON_FILE="${harness}/worker-wildcard-acknowledged.json" \
    API_REVISION_FILE="${harness}/api-revision.json" WORKER_REVISION_FILE="${harness}/worker-revision.json" \
    "${harness}/scripts/verify-containerapp-release-config.sh" \
    "${api_image}" "${worker_image}" >/dev/null 2>&1; then
    fail "Container App verifier rejected the explicitly acknowledged live-send wildcard"
  fi
  pass

  jq '(.properties.template.containers[0].env[] |
    select(.name == "OUTREACH_ALLOW_WILDCARD").value) = "true"' \
    "${harness}/api.json" >"${harness}/api-wildcard-escape.json"
  jq '(.properties.template.containers[0].env[] |
    select(.name == "OUTREACH_ALLOW_WILDCARD").value) = "true"' \
    "${harness}/worker.json" >"${harness}/worker-wildcard-escape.json"
  if env PATH="${harness}/bin:${PATH}" \
    API_JSON_FILE="${harness}/api-wildcard-escape.json" WORKER_JSON_FILE="${harness}/worker-wildcard-escape.json" \
    API_REVISION_FILE="${harness}/api-revision.json" WORKER_REVISION_FILE="${harness}/worker-revision.json" \
    "${harness}/scripts/verify-containerapp-release-config.sh" \
    "${api_image}" "${worker_image}" >/dev/null 2>&1; then
    fail "Container App verifier accepted OUTREACH_ALLOW_WILDCARD=true without the wildcard"
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

test_go_live_runbook_uses_mounted_gmail_readiness() {
  local runbook="${REPO_ROOT}/docs/ops/go-live-runbook.md"

  if grep -Fq -- "/api/integrations/gmail/test" "${runbook}"; then
    fail "go-live runbook references the removed Gmail test route"
  fi
  pass

  grep -Fq -- "/api/orgs/onboarding/status" "${runbook}" ||
    fail "go-live runbook omits server-authoritative mailbox readiness"
  pass

  grep -Fq -- "/api/integrations/gmail/messages?maxResults=1" "${runbook}" ||
    fail "go-live runbook omits the mounted bounded Gmail provider read"
  pass
}

test_partial_release_recovery_workflow_source() {
  local workflow="${REPO_ROOT}/.github/workflows/recover-partial-production-release.yml"
  [[ -f "${workflow}" && ! -L "${workflow}" ]] ||
    fail "partial-release recovery workflow is missing or unsafe"
  assert_log_contains "${workflow}" "  workflow_dispatch:"
  assert_log_contains "${workflow}" "  actions: read"
  assert_log_contains "${workflow}" "  contents: write"
  assert_log_contains "${workflow}" "  id-token: write"
  assert_log_contains "${workflow}" "  group: workforce-os-production"
  assert_log_contains "${workflow}" "    environment: workforce-os-production"
  assert_log_contains "${workflow}" \
    'expected_confirmation="RECOVER FAILED WORKFORCE OS BACKEND RELEASE ${failed_run_id}"'
  assert_log_contains "${workflow}" 'failed_run_id="33341922807"'
  assert_log_contains "${workflow}" \
    'candidate_commit="d1cb5fc2a9945414c8412f8bd193418cb2e1c4d8"'
  assert_log_contains "${workflow}" \
    'candidate_image="workforceosprodacr.azurecr.io/apex-api@sha256:a047fe1ceb54bc022475e44ef7c006550d9384eaaf6083c08fbbcafdc38added"'
  assert_log_contains "${workflow}" 'api_revision="apex-gtm-api--88oi4d1"'
  assert_log_contains "${workflow}" \
    'prior_worker_revision="apex-gtm-worker--bootstrap-first-class-629881c-r4"'
  assert_log_contains "${workflow}" 'console_revision="nikxius-web--bdrngs2"'
  assert_log_contains "${workflow}" \
    'release_lock_commit="a2d5c61bd5c84db45d63ac76160359c2840504d9"'
  assert_log_contains "${workflow}" \
    'ERROR: failed run does not prove the exact known partial-rollout incident'
  assert_log_contains "${workflow}" \
    'incident-candidate/scripts/verify-migration-release-receipt.sh'
  assert_log_contains "${workflow}" \
    '--name apex-gtm-worker --image "${candidate_image}"'
  assert_log_contains "${workflow}" \
    '"--force-with-lease=${release_lock_ref}:${release_lock_commit}"'
  assert_log_contains "${workflow}" "az storage blob lease break"
  assert_log_contains "${workflow}" "--lease-break-period 0"
  assert_log_excludes "${workflow}" "storage blob delete"
  assert_log_excludes "${workflow}" \
    '--name apex-gtm-api --image "${candidate_image}"'
  assert_log_contains "${REPO_ROOT}/scripts/deploy-prod.sh" \
    'did not converge to exactly one healthy active revision'
  assert_log_contains "${REPO_ROOT}/scripts/deploy-prod.sh" \
    'signed rollback revision ${revision} did not become inactive'
  pass
}

test_global_live_send_workflow_source() {
  local workflow="${REPO_ROOT}/.github/workflows/enable-global-live-send.yml"
  [[ -f "${workflow}" && ! -L "${workflow}" ]] ||
    fail "global live-send workflow is missing or unsafe"
  assert_log_contains "${workflow}" "  workflow_dispatch:"
  assert_log_contains "${workflow}" "  actions: read"
  assert_log_contains "${workflow}" "  contents: write"
  assert_log_contains "${workflow}" "  id-token: write"
  assert_log_contains "${workflow}" "  group: workforce-os-production"
  assert_log_contains "${workflow}" "    environment: workforce-os-production"
  assert_log_contains "${workflow}" \
    'expected_confirmation="ENABLE LIVE EMAIL FOR ALL READY WORKFORCE OS ORGANIZATIONS"'
  assert_log_contains "${workflow}" \
    'expected_image="workforceosprodacr.azurecr.io/apex-api@sha256:a047fe1ceb54bc022475e44ef7c006550d9384eaaf6083c08fbbcafdc38added"'
  assert_log_contains "${workflow}" \
    "--set-env-vars 'OUTREACH_LIVE_FOR_ORGS=*' 'OUTREACH_ALLOW_WILDCARD=true'"
  assert_log_contains "${workflow}" "scripts/verify-containerapp-release-config.sh"
  assert_log_contains "${workflow}" "az storage blob lease acquire"
  assert_log_contains "${workflow}" "az storage blob lease renew"
  assert_log_contains "${workflow}" "az storage blob lease release"
  assert_log_contains "${workflow}" \
    '--force-with-lease="${release_lock_ref}:${GITHUB_SHA}"'
  assert_log_contains "${workflow}" 'if ! rollback; then'
  assert_log_contains "${workflow}" \
    'Dispatch still requires manager/admin approval, ready Gmail, complete sender identity, suppression/cooldown checks, and daily capacity'
  assert_log_excludes "${workflow}" "storage blob lease break"
  assert_log_excludes "${workflow}" "storage blob delete"
  assert_log_excludes "${workflow}" "containerapp delete"
  pass
}

test_provider_activation_workflow_source() {
  local workflow="${REPO_ROOT}/.github/workflows/activate-production-providers.yml"
  [[ -f "${workflow}" && ! -L "${workflow}" ]] ||
    fail "provider activation workflow is missing or unsafe"
  "${REPO_ROOT}/scripts/verify-production-provider-activation-workflow.sh" "${workflow}" >/dev/null
  pass

  assert_log_contains "${workflow}" \
    'initial_image="$(jq -er '\''.properties.template.containers[0].image'\'' "${state_dir}/api-before.json")"'
  assert_log_contains "${workflow}" \
    '[[ "${initial_image}" == "${worker_image}" ]]'
  assert_log_contains "${workflow}" \
    '--revision-suffix "${revision_suffix}"'
  assert_log_contains "${workflow}" \
    'unset TAVILY_API_KEY THEIRSTACK_API_KEY HUNTER_API_KEY'
  assert_log_excludes "${workflow}" "containerapp secret list"
  pass
}

test_registry_verifier
test_deploy_admission
test_deploy_rollback
test_bootstrap_signal_forwarding
test_release_git_environment_isolation
test_release_lease_real_git_protocol
test_bootstrap_archive_attribute_isolation
test_snapshot_helper_symlink_rejection
test_no_mutable_bitbucket_deploy_path
test_partial_release_recovery_workflow_source
test_global_live_send_workflow_source
test_provider_activation_workflow_source
test_production_release_workflow_verifier
test_github_ci_verifier
test_migration_receipt_contract_parity
test_migration_receipt_verifier
test_containerapp_config_verifier
test_go_live_runbook_uses_mounted_gmail_readiness

echo "Release script tests passed: ${TESTS_PASSED}"
