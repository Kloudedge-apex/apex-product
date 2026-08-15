#!/usr/bin/env bash

# Hermetic contract and adversary tests for rehearse-runtime-candidate.sh.
# Docker, HTTP, and migration verification are faked, so this suite never
# contacts a database, queue, provider, or cloud resource.

set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd -P)"
RUNTIME_SCRIPT="${REPO_ROOT}/scripts/rehearse-runtime-candidate.sh"
EXPECTED_COMMIT="${1:-$(git -C "${REPO_ROOT}" rev-parse HEAD)}"
TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/workforce-runtime-rehearsal-tests.XXXXXX")"
FAKE_BIN="${TEMP_DIR}/bin"
MIGRATION_RECEIPT="${TEMP_DIR}/migration-receipt.json"
MIGRATION_VERIFIER="${TEMP_DIR}/verify-migration.sh"
TESTS_PASSED=0
LAST_OUTPUT=""
LAST_LOG=""
LAST_STATE_DIR=""

cleanup() {
  local cleanup_status=$?
  trap - EXIT HUP INT TERM
  if [[ -d "${TEMP_DIR}" &&
    "${TEMP_DIR}" == "${TMPDIR:-/tmp}/workforce-runtime-rehearsal-tests."* ]]; then
    find "${TEMP_DIR}" -depth -delete
  fi
  exit "${cleanup_status}"
}
trap cleanup EXIT HUP INT TERM

fail() {
  echo "FAIL: $*" >&2
  if [[ -n "${LAST_LOG}" && -f "${LAST_LOG}" ]]; then
    tail -n 40 "${LAST_LOG}" >&2
  fi
  exit 1
}

pass() {
  TESTS_PASSED=$((TESTS_PASSED + 1))
}

[[ "${EXPECTED_COMMIT}" =~ ^[0-9a-f]{40}$ ]] ||
  fail "expected commit must be a full lowercase SHA"
mkdir -p "${FAKE_BIN}"

jq -n --arg commit "${EXPECTED_COMMIT}" '{
  environment: "ci-synthetic",
  authority: "non-authoritative",
  status: "passed",
  candidateCommit: $commit
}' >"${MIGRATION_RECEIPT}"

cat >"${MIGRATION_VERIFIER}" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[[ "${FAKE_SCENARIO:-success}" != "migration-verifier-reject" ]]
EOF

cat >"${FAKE_BIN}/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

scenario="${FAKE_SCENARIO:-success}"
state_dir="${FAKE_DOCKER_STATE:?}"
mkdir -p "${state_dir}"
last_arg="${!#}"

case "${1:-}" in
  image)
    format="${4:-}"
    if [[ "${format}" == *org.opencontainers.image.revision* ]]; then
      if [[ "${scenario}" == "revision-mismatch" ]]; then
        printf '%s\n' 0000000000000000000000000000000000000000
      else
        printf '%s\n' "${EXPECTED_COMMIT:?}"
      fi
    elif [[ "${format}" == *'{{.Id}}'* ]]; then
      printf 'sha256:%064d\n' 1
    else
      exit 1
    fi
    ;;
  inspect)
    if [[ "${2:-}" != "--format" ]]; then
      [[ "${scenario}" == "container-collision" ]]
      exit
    fi
    format="${3:-}"
    name="${4:-}"
    if [[ "${format}" == *State.Running* ]]; then
      if [[ -f "${state_dir}/${name}.stopped" ]]; then
        printf 'false\n'
      elif [[ "${scenario}" == "worker-early-exit" && "${name}" == *worker* ]]; then
        printf 'false\n'
      else
        printf 'true\n'
      fi
    elif [[ "${format}" == *State.ExitCode* ]]; then
      if [[ "${scenario}" == "shutdown-failure" ]]; then
        printf '137\n'
      else
        printf '0\n'
      fi
    else
      exit 1
    fi
    ;;
  run)
    if [[ "${last_arg}" == "-" ]]; then
      if [[ "${scenario}" == "redis-not-empty" ]]; then
        printf 'PONG|1'
      else
        printf 'PONG|OPEN|1'
      fi
      exit 0
    fi
    name=""
    clerk_webhook_secret_seen=false
    bootstrap_attempt_seen=false
    bootstrap_generation_seen=false
    previous=""
    for value in "$@"; do
      if [[ "${previous}" == "--name" ]]; then
        name="${value}"
      elif [[ "${previous}" == "--env" &&
        "${value}" == "CLERK_WEBHOOK_SECRET=ci-synthetic-clerk-webhook-secret-0001" ]]; then
        clerk_webhook_secret_seen=true
      elif [[ "${previous}" == "--env" &&
        "${value}" == "WORKFORCE_PRODUCTION_BOOTSTRAP_ATTEMPT_ID=${EXPECTED_COMMIT:0:32}" ]]; then
        bootstrap_attempt_seen=true
      elif [[ "${previous}" == "--env" &&
        "${value}" == "WORKFORCE_PRODUCTION_BOOTSTRAP_MIN_WRITER_FENCE_GENERATION=1" ]]; then
        bootstrap_generation_seen=true
      fi
      previous="${value}"
    done
    [[ -n "${name}" ]] || exit 1
    [[ "${clerk_webhook_secret_seen}" == "true" ]] || exit 1
    [[ "${bootstrap_attempt_seen}" == "true" ]] || exit 1
    [[ "${bootstrap_generation_seen}" == "true" ]] || exit 1
    [[ "${last_arg}" == "sha256:$(printf '%064d' 1)" ]] || exit 1
    : >"${state_dir}/${name}.created"
    printf 'fake-container-id\n'
    ;;
  stop)
    : >"${state_dir}/${last_arg}.stopped"
    printf '%s\n' "${last_arg}"
    ;;
  logs)
    if [[ "${scenario}" == "fatal-log" ]]; then
      printf 'Environment validation failed: synthetic adversary\n'
    else
      printf 'synthetic runtime log clean\n'
    fi
    ;;
  rm)
    : >"${state_dir}/${last_arg}.removed"
    ;;
  *)
    exit 1
    ;;
esac
EOF

cat >"${FAKE_BIN}/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

scenario="${FAKE_SCENARIO:-success}"
output=""
url=""
previous=""
for value in "$@"; do
  if [[ "${previous}" == "--output" ]]; then
    output="${value}"
  fi
  previous="${value}"
  if [[ "${value}" == http://* || "${value}" == https://* ]]; then
    url="${value}"
  fi
done
[[ -n "${output}" && -n "${url}" ]] || exit 2

status=200
case "${url}" in
  */api/health/live)
    printf '%s\n' '{"status":"ok","service":"apex-api"}' >"${output}"
    ;;
  */api/health/ready)
    if [[ "${scenario}" == "readiness-failure" ]]; then
      status=503
      printf '%s\n' '{"status":"degraded","checks":{"postgres":"synthetic failure","redis":"ok"}}' >"${output}"
    else
      printf '%s\n' '{"status":"ok","checks":{"postgres":"ok","redis":"ok"}}' >"${output}"
    fi
    ;;
  */api/health/worker)
    worker_count=1
    if [[ "${scenario}" == "zero-consumers" ]]; then
      worker_count=0
    fi
    jq -n --argjson count "${worker_count}" '{
      status: "ok",
      healthy: true,
      queues: [
        {queue: "agent-runs", mode: "bullmq", healthy: true, workerCount: $count},
        {queue: "graph-runs", mode: "bullmq", healthy: true, workerCount: $count},
        {queue: "outreach-send", mode: "bullmq", healthy: true, workerCount: $count}
      ]
    }' >"${output}"
    ;;
  */api/orgs/onboarding/status)
    if [[ "${scenario}" == "unauthenticated-success" ]]; then
      status=200
      printf '%s\n' '{"unexpected":"tenant data"}' >"${output}"
    else
      status=401
      printf '%s\n' '{"statusCode":401}' >"${output}"
    fi
    ;;
  *)
    exit 3
    ;;
esac
printf '%s' "${status}"
EOF

cat >"${FAKE_BIN}/psql" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${FAKE_SCENARIO:-success}" == "unexpected-tenant-data" ]]; then
  printf '2|1\n'
else
  printf '2|0\n'
fi
EOF

chmod +x "${MIGRATION_VERIFIER}" "${FAKE_BIN}/docker" "${FAKE_BIN}/curl" \
  "${FAKE_BIN}/psql"

run_case() {
  local scenario=$1
  LAST_OUTPUT="${TEMP_DIR}/runtime-${TESTS_PASSED}-${scenario}.json"
  LAST_LOG="${TEMP_DIR}/runtime-${TESTS_PASSED}-${scenario}.log"
  LAST_STATE_DIR="${TEMP_DIR}/state-${TESTS_PASSED}-${scenario}"
  mkdir -p "${LAST_STATE_DIR}"

  env -u GITHUB_ACTIONS \
    PATH="${FAKE_BIN}:${PATH}" \
    EXPECTED_COMMIT="${EXPECTED_COMMIT}" \
    FAKE_SCENARIO="${scenario}" \
    FAKE_DOCKER_STATE="${LAST_STATE_DIR}" \
    WORKFORCE_RUNTIME_REHEARSAL_ACK="${CASE_ACK-ci-synthetic-only}" \
    WORKFORCE_RUNTIME_REHEARSAL_TESTING=true \
    WORKFORCE_RUNTIME_REHEARSAL_MIGRATION_VERIFIER="${MIGRATION_VERIFIER}" \
    WORKFORCE_RUNTIME_REHEARSAL_TIMEOUT_SECONDS=1 \
    WORKFORCE_RUNTIME_REHEARSAL_POLL_INTERVAL_SECONDS=0.05 \
    WORKFORCE_RUNTIME_REHEARSAL_SHUTDOWN_TIMEOUT_SECONDS=1 \
    DATABASE_URL="${CASE_DATABASE_URL-postgresql://workforce_rehearsal:synthetic_ci_only@127.0.0.1:5432/workforce_rehearsal_ci}" \
    REDIS_URL="${CASE_REDIS_URL-redis://127.0.0.1:6379/15}" \
    WORKFORCE_RUNTIME_REHEARSAL_BOOTSTRAP_ATTEMPT_ID="${CASE_BOOTSTRAP_ATTEMPT_ID-${EXPECTED_COMMIT:0:32}}" \
    WORKFORCE_RUNTIME_REHEARSAL_BOOTSTRAP_MINIMUM_GENERATION="${CASE_BOOTSTRAP_MINIMUM_GENERATION-1}" \
    bash "${RUNTIME_SCRIPT}" \
      workforce-os-api:ci-test "${EXPECTED_COMMIT}" \
      "${MIGRATION_RECEIPT}" "${LAST_OUTPUT}" >"${LAST_LOG}" 2>&1
}

expect_rejection() {
  local scenario=$1
  local expected_message=${2:-}
  if run_case "${scenario}"; then
    fail "${scenario} adversary unexpectedly passed"
  fi
  [[ ! -e "${LAST_OUTPUT}" ]] || fail "${scenario} adversary wrote a passing receipt"
  if [[ -n "${expected_message}" ]] && ! grep -Fq -- "${expected_message}" "${LAST_LOG}"; then
    fail "${scenario} adversary failed for the wrong reason"
  fi
  pass
}

run_case success || fail "valid synthetic runtime rehearsal was rejected"
if ! jq -e --arg commit "${EXPECTED_COMMIT}" '
  .environment == "ci-synthetic"
  and .authority == "non-authoritative"
  and .status == "passed"
  and .candidateCommit == $commit
  and .migrationReceipt.verified == true
  and .dependencies == {postgres: "ok", redis: "ok"}
  and .roles.api.liveness == true
  and .roles.api.readiness == true
  and .roles.worker.liveness == true
  and .roles.worker.readiness == true
  and .consumerRegistration.healthy == true
  and (.consumerRegistration.queues | length == 3)
  and .accessBoundary == {unauthenticatedTenantDenied: true, statusCode: 401}
  and .shutdown.api.clean == true
  and .shutdown.worker.clean == true
  and (has("stagingRehearsalEvidenceHash") | not)
  and (has("productionApplyEvidenceHash") | not)
' >/dev/null "${LAST_OUTPUT}"; then
  fail "valid runtime receipt is not sanitized and non-authoritative"
fi
pass

if ! jq -e '
  .additionalProperties == false
  and .properties.environment.const == "ci-synthetic"
  and .properties.authority.const == "non-authoritative"
  and .properties.status.const == "passed"
  and .properties.consumerRegistration.additionalProperties == false
  and .properties.shutdown.additionalProperties == false
  and ."$defs".queue.additionalProperties == false
' >/dev/null "${REPO_ROOT}/docs/ops/ci-runtime-rehearsal-receipt.schema.json"; then
  fail "runtime receipt schema is not strict and non-authoritative"
fi
pass

CASE_ACK= expect_rejection missing-ack \
  "set WORKFORCE_RUNTIME_REHEARSAL_ACK=ci-synthetic-only"
CASE_DATABASE_URL=postgresql://workforce_rehearsal:synthetic_ci_only@db.example.com:5432/workforce_rehearsal_ci \
  expect_rejection remote-database "credential-bounded loopback CI targets"
CASE_DATABASE_URL=postgresql://postgres:real-looking@127.0.0.1:5432/workforce_rehearsal_ci \
  expect_rejection database-credentials "credential-bounded loopback CI targets"
CASE_REDIS_URL=redis://redis.example.com:6379/15 \
  expect_rejection remote-redis "credential-bounded loopback CI targets"
CASE_REDIS_URL=redis://:secret@127.0.0.1:6379/15 \
  expect_rejection redis-credentials "credential-bounded loopback CI targets"
CASE_BOOTSTRAP_ATTEMPT_ID= expect_rejection missing-bootstrap-attempt \
  "synthetic bootstrap attempt id must be 32 lowercase hexadecimal characters"
CASE_BOOTSTRAP_ATTEMPT_ID=ffffffffffffffffffffffffffffffff \
  expect_rejection wrong-bootstrap-attempt \
  "synthetic bootstrap attempt id must match the candidate-bound epoch"
CASE_BOOTSTRAP_MINIMUM_GENERATION=0 expect_rejection rollback-bootstrap-generation \
  "synthetic bootstrap minimum generation must be exactly 1"
expect_rejection unexpected-tenant-data "not the reserved two-tenant synthetic fixture"

expect_rejection revision-mismatch "image revision does not match"
expect_rejection redis-not-empty "guarded Redis database must contain only the exact synthetic OPEN epoch"
expect_rejection migration-verifier-reject
expect_rejection container-collision "container name collision"
expect_rejection worker-early-exit "container exited before its probe passed"
expect_rejection readiness-failure "did not satisfy its runtime contract before timeout"
if [[ "$(find "${LAST_STATE_DIR}" -name '*.removed' | wc -l | tr -d '[:space:]')" != "1" ]]; then
  fail "readiness failure did not clean up its worker container"
fi
pass

expect_rejection zero-consumers "did not satisfy its runtime contract before timeout"
if [[ "$(find "${LAST_STATE_DIR}" -name '*.removed' | wc -l | tr -d '[:space:]')" != "2" ]]; then
  fail "consumer failure did not clean up both runtime containers"
fi
pass

expect_rejection unauthenticated-success \
  "unauthenticated tenant endpoint did not fail closed"
expect_rejection shutdown-failure "exited uncleanly after SIGTERM"
expect_rejection fatal-log "runtime log contains a fatal startup or dependency error"

LAST_OUTPUT="${TEMP_DIR}/runtime-existing.json"
LAST_LOG="${TEMP_DIR}/runtime-existing.log"
printf '%s\n' preserved >"${LAST_OUTPUT}"
if env -u GITHUB_ACTIONS \
  PATH="${FAKE_BIN}:${PATH}" \
  EXPECTED_COMMIT="${EXPECTED_COMMIT}" \
  FAKE_SCENARIO=success \
  FAKE_DOCKER_STATE="${TEMP_DIR}/state-existing" \
  WORKFORCE_RUNTIME_REHEARSAL_ACK=ci-synthetic-only \
  WORKFORCE_RUNTIME_REHEARSAL_TESTING=true \
  WORKFORCE_RUNTIME_REHEARSAL_MIGRATION_VERIFIER="${MIGRATION_VERIFIER}" \
  DATABASE_URL=postgresql://workforce_rehearsal:synthetic_ci_only@127.0.0.1:5432/workforce_rehearsal_ci \
  REDIS_URL=redis://127.0.0.1:6379/15 \
  bash "${RUNTIME_SCRIPT}" workforce-os-api:ci-test "${EXPECTED_COMMIT}" \
    "${MIGRATION_RECEIPT}" "${LAST_OUTPUT}" >"${LAST_LOG}" 2>&1; then
  fail "runtime rehearsal overwrote an existing receipt"
fi
[[ "$(tr -d '\n' <"${LAST_OUTPUT}")" == "preserved" ]] ||
  fail "existing receipt content changed"
pass

echo "Runtime rehearsal tests passed: ${TESTS_PASSED}"
