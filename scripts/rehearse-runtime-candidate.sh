#!/usr/bin/env bash

# Boot the exact production image in API and worker roles against the already
# rehearsed synthetic PostgreSQL schema and an isolated loopback Redis DB.
# This script is a CI-only runtime contract; its receipt can never authorize a
# staging or production migration, deployment, provider call, or browser gate.

set -euo pipefail
umask 077

IMAGE="${1:-}"
CANDIDATE_COMMIT="${2:-}"
MIGRATION_RECEIPT="${3:-}"
RECEIPT_OUTPUT="${4:-}"
ACKNOWLEDGEMENT="${WORKFORCE_RUNTIME_REHEARSAL_ACK:-}"
TESTING_MODE="${WORKFORCE_RUNTIME_REHEARSAL_TESTING:-false}"
STARTUP_TIMEOUT_SECONDS="${WORKFORCE_RUNTIME_REHEARSAL_TIMEOUT_SECONDS:-90}"
POLL_INTERVAL_SECONDS="${WORKFORCE_RUNTIME_REHEARSAL_POLL_INTERVAL_SECONDS:-1}"
SHUTDOWN_TIMEOUT_SECONDS="${WORKFORCE_RUNTIME_REHEARSAL_SHUTDOWN_TIMEOUT_SECONDS:-15}"
API_PORT="${WORKFORCE_RUNTIME_REHEARSAL_API_PORT:-4400}"
WORKER_PORT="${WORKFORCE_RUNTIME_REHEARSAL_WORKER_PORT:-4401}"

usage() {
  echo "Usage: $0 <image> <full-lowercase-candidate-sha> <migration-receipt.json> <new-runtime-receipt.json>" >&2
}

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

if [[ -z "${IMAGE}" || ! "${CANDIDATE_COMMIT}" =~ ^[0-9a-f]{40}$ ||
  -z "${MIGRATION_RECEIPT}" || -z "${RECEIPT_OUTPUT}" ]]; then
  usage
  exit 2
fi
if [[ ! "${IMAGE}" =~ ^[A-Za-z0-9][A-Za-z0-9._/@:-]{0,255}$ ]]; then
  fail "image reference contains unsupported characters"
fi
if [[ "${ACKNOWLEDGEMENT}" != "ci-synthetic-only" ]]; then
  fail "set WORKFORCE_RUNTIME_REHEARSAL_ACK=ci-synthetic-only"
fi
if [[ "${TESTING_MODE}" == "true" && "${GITHUB_ACTIONS:-false}" == "true" ]]; then
  fail "runtime rehearsal test overrides are forbidden in GitHub Actions"
fi
if [[ "${TESTING_MODE}" != "true" && "$(uname -s)" != "Linux" ]]; then
  fail "the production runtime rehearsal requires a Linux Docker host"
fi
if [[ -z "${DATABASE_URL:-}" || -z "${REDIS_URL:-}" ]]; then
  fail "DATABASE_URL and REDIS_URL are required"
fi
if [[ ! "${STARTUP_TIMEOUT_SECONDS}" =~ ^[1-9][0-9]*$ ||
  ! "${SHUTDOWN_TIMEOUT_SECONDS}" =~ ^[1-9][0-9]*$ ||
  ! "${POLL_INTERVAL_SECONDS}" =~ ^(0\.[0-9]+|[1-9][0-9]*(\.[0-9]+)?)$ ]]; then
  fail "runtime timeout values are invalid"
fi
for port in "${API_PORT}" "${WORKER_PORT}"; do
  if [[ ! "${port}" =~ ^[0-9]+$ ]] || (( port < 1024 || port > 65535 )); then
    fail "runtime rehearsal ports must be integers from 1024 through 65535"
  fi
done
[[ "${API_PORT}" != "${WORKER_PORT}" ]] || fail "API and worker ports must differ"

for required_command in awk basename curl date dirname docker find git grep jq \
  mktemp mv node openssl psql sleep tr uname; do
  command -v "${required_command}" >/dev/null 2>&1 ||
    fail "required command is unavailable: ${required_command}"
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"

[[ -f "${MIGRATION_RECEIPT}" && ! -L "${MIGRATION_RECEIPT}" ]] ||
  fail "migration receipt must be a regular non-symlink file"
[[ ! -e "${RECEIPT_OUTPUT}" ]] || fail "runtime receipt output already exists"
OUTPUT_DIR="$(dirname "${RECEIPT_OUTPUT}")"
[[ -d "${OUTPUT_DIR}" ]] || fail "runtime receipt output directory does not exist"
OUTPUT_DIR="$(cd "${OUTPUT_DIR}" && pwd -P)"
RECEIPT_OUTPUT="${OUTPUT_DIR}/$(basename "${RECEIPT_OUTPUT}")"
case "${RECEIPT_OUTPUT}" in
  "${REPO_ROOT}"|"${REPO_ROOT}"/*)
    fail "runtime receipt must be written outside the repository"
    ;;
esac

if ! GIT_NO_REPLACE_OBJECTS=1 git -C "${REPO_ROOT}" cat-file -e \
  "${CANDIDATE_COMMIT}^{commit}" 2>/dev/null; then
  fail "candidate commit is not available locally"
fi

MIGRATION_VERIFIER="${REPO_ROOT}/scripts/verify-ci-migration-rehearsal-receipt.sh"
if [[ -n "${WORKFORCE_RUNTIME_REHEARSAL_MIGRATION_VERIFIER:-}" ]]; then
  [[ "${TESTING_MODE}" == "true" ]] ||
    fail "migration verifier override is allowed only in explicit test mode"
  MIGRATION_VERIFIER="${WORKFORCE_RUNTIME_REHEARSAL_MIGRATION_VERIFIER}"
fi
[[ -f "${MIGRATION_VERIFIER}" && -x "${MIGRATION_VERIFIER}" ]] ||
  fail "migration receipt verifier is unavailable"
"${MIGRATION_VERIFIER}" "${MIGRATION_RECEIPT}" "${CANDIDATE_COMMIT}" >/dev/null
if ! jq -e --arg commit "${CANDIDATE_COMMIT}" '
  .environment == "ci-synthetic"
  and .authority == "non-authoritative"
  and .status == "passed"
  and .candidateCommit == $commit
' >/dev/null "${MIGRATION_RECEIPT}"; then
  fail "migration receipt is not linked to this synthetic candidate"
fi

URL_GUARD="$(DATABASE_URL_VALUE="${DATABASE_URL}" REDIS_URL_VALUE="${REDIS_URL}" node <<'NODE'
function parse(raw, label) {
  try { return new URL(raw); } catch { throw new Error(`${label} is not a URL`); }
}

const database = parse(process.env.DATABASE_URL_VALUE, 'DATABASE_URL');
if (!['postgres:', 'postgresql:'].includes(database.protocol)) process.exit(2);
if (database.search || database.hash) process.exit(3);
if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(database.hostname.toLowerCase())) {
  process.exit(4);
}
let databaseName;
let databaseUser;
let databasePassword;
try {
  databaseName = decodeURIComponent(database.pathname.slice(1));
  databaseUser = decodeURIComponent(database.username);
  databasePassword = decodeURIComponent(database.password);
} catch {
  process.exit(5);
}
if (!/^workforce_rehearsal_[a-z0-9_]+$/.test(databaseName) || databaseName.length > 50) {
  process.exit(6);
}
if (databaseUser !== 'workforce_rehearsal' || databasePassword !== 'synthetic_ci_only') {
  process.exit(7);
}

const redis = parse(process.env.REDIS_URL_VALUE, 'REDIS_URL');
if (redis.protocol !== 'redis:' || redis.search || redis.hash) process.exit(8);
if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(redis.hostname.toLowerCase())) {
  process.exit(9);
}
if (redis.username || redis.password) process.exit(10);
const redisDb = redis.pathname === '' || redis.pathname === '/'
  ? 0
  : Number(redis.pathname.slice(1));
if (!Number.isInteger(redisDb) || redisDb < 0 || redisDb > 15) process.exit(11);

process.stdout.write('safe');
NODE
)" || fail "database and Redis must be credential-bounded loopback CI targets"
[[ "${URL_GUARD}" == "safe" ]] || fail "synthetic runtime target validation failed"
unset URL_GUARD

SYNTHETIC_TENANT_COUNTS="$(PGCONNECT_TIMEOUT=5 psql --no-psqlrc \
  --dbname="${DATABASE_URL}" --set=ON_ERROR_STOP=1 --tuples-only --no-align \
  --field-separator='|' --command='
    SELECT
      COUNT(*) FILTER (WHERE "id" LIKE '\''ci_org_%'\''),
      COUNT(*) FILTER (WHERE "id" NOT LIKE '\''ci_org_%'\'')
    FROM "Org";
  ' | tr -d '[:space:]')" || fail "could not verify synthetic tenant inventory"
[[ "${SYNTHETIC_TENANT_COUNTS}" == "2|0" ]] ||
  fail "runtime target is not the reserved two-tenant synthetic fixture"

# The migration fixture intentionally contains one RUNNING GraphRun. Refresh
# only its synthetic activity clock so a slow image build cannot make the
# worker's orphan-recovery sweep enqueue provider work during this boot test.
psql --no-psqlrc --dbname="${DATABASE_URL}" --set=ON_ERROR_STOP=1 \
  --command='
    UPDATE "GraphRun"
    SET "lastActivityAt" = clock_timestamp()
    WHERE "id" LIKE '\''ci_graph_%'\'' AND "status" = '\''RUNNING'\'';
  ' >/dev/null || fail "could not quiesce the synthetic graph fixture"

IMAGE_ID="$(docker image inspect --format '{{.Id}}' "${IMAGE}")" ||
  fail "candidate image identity is unavailable"
[[ "${IMAGE_ID}" =~ ^sha256:[0-9a-f]{64}$ ]] || fail "candidate image ID is invalid"
IMAGE_REVISION="$(docker image inspect --format \
  '{{index .Config.Labels "org.opencontainers.image.revision"}}' "${IMAGE_ID}")" ||
  fail "candidate image is unavailable"
[[ "${IMAGE_REVISION}" == "${CANDIDATE_COMMIT}" ]] ||
  fail "image revision does not match the candidate commit"

REDIS_PREFLIGHT="$(docker run --rm \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --network host \
  --env "REDIS_URL=${REDIS_URL}" \
  --interactive \
  --entrypoint node \
  "${IMAGE_ID}" - <<'NODE'
const Redis = require("ioredis");

(async () => {
  const client = new Redis(process.env.REDIS_URL, {
    lazyConnect: true,
    connectTimeout: 3_000,
    commandTimeout: 3_000,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  try {
    await client.connect();
    const pong = await client.ping();
    const keyCount = Number(await client.dbsize());
    if (pong !== "PONG" || keyCount !== 0) process.exit(2);
    process.stdout.write("PONG|0");
  } finally {
    client.disconnect(false);
  }
})().catch(() => process.exit(1));
NODE
)" || fail "guarded Redis database must be reachable and empty"
[[ "${REDIS_PREFLIGHT}" == "PONG|0" ]] ||
  fail "guarded Redis database must be reachable and empty"
unset REDIS_PREFLIGHT

MIGRATION_RECEIPT_SHA256="sha256:$(openssl dgst -sha256 -r \
  "${MIGRATION_RECEIPT}" | awk '{print $1}')"

TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/workforce-runtime-rehearsal.XXXXXX")"
RECEIPT_TEMP=""
NAME_SUFFIX="${CANDIDATE_COMMIT:0:12}-$$"
API_CONTAINER="workforce-runtime-api-${NAME_SUFFIX}"
WORKER_CONTAINER="workforce-runtime-worker-${NAME_SUFFIX}"
API_CREATED="false"
WORKER_CREATED="false"

cleanup() {
  local cleanup_status=$?
  trap - EXIT HUP INT TERM
  set +e
  if [[ "${API_CREATED}" == "true" ]]; then
    docker rm --force "${API_CONTAINER}" >/dev/null 2>&1
  fi
  if [[ "${WORKER_CREATED}" == "true" ]]; then
    docker rm --force "${WORKER_CONTAINER}" >/dev/null 2>&1
  fi
  if [[ -n "${RECEIPT_TEMP}" && -f "${RECEIPT_TEMP}" ]]; then
    find "${RECEIPT_TEMP}" -delete
  fi
  if [[ -d "${TEMP_DIR}" &&
    "${TEMP_DIR}" == "${TMPDIR:-/tmp}/workforce-runtime-rehearsal."* ]]; then
    find "${TEMP_DIR}" -depth -delete
  fi
  exit "${cleanup_status}"
}
trap cleanup EXIT HUP INT TERM

for container_name in "${API_CONTAINER}" "${WORKER_CONTAINER}"; do
  if docker inspect "${container_name}" >/dev/null 2>&1; then
    fail "runtime rehearsal container name collision"
  fi
done

COMMON_ENV=(
  --env NODE_ENV=production
  --env REQUIRE_PRODUCTION_ENV=true
  --env "DATABASE_URL=${DATABASE_URL}"
  --env "REDIS_URL=${REDIS_URL}"
  --env ENCRYPTION_KEY=1111111111111111111111111111111111111111111111111111111111111111
  --env ADMIN_API_KEY=ci-synthetic-admin-only
  --env METRICS_AUTH_TOKEN=ci-synthetic-metrics-only
  --env OPENAI_API_KEY=ci-synthetic-provider-disabled
  --env GOOGLE_CLIENT_ID=ci-synthetic-client.apps.googleusercontent.com
  --env GOOGLE_CLIENT_SECRET=ci-synthetic-provider-disabled
  --env OAUTH_STATE_SECRET=ci-synthetic-oauth-state-secret-0000000000000000
  --env API_PUBLIC_URL=https://api.ci.workforce-os.example.com
  --env FRONTEND_URL=https://console.ci.workforce-os.example.com
  --env CORS_ALLOWED_ORIGINS=https://console.ci.workforce-os.example.com
  --env GOOGLE_REDIRECT_URI=https://api.ci.workforce-os.example.com/api/integrations/gmail/callback
  --env GMAIL_PUBSUB_TOPIC=projects/workforce-ci/topics/gmail-push
  --env GMAIL_PUSH_AUDIENCE=https://api.ci.workforce-os.example.com/api/integrations/gmail/push
  --env GMAIL_PUSH_PUBLISHER_SA=gmail-push@workforce-ci.iam.gserviceaccount.com
  --env CLERK_ISSUER=https://clerk.ci.workforce-os.example.com
  --env CLERK_AUTHORIZED_PARTIES=https://console.ci.workforce-os.example.com
  --env CLERK_WEBHOOK_SECRET=whsec_BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=
  --env LANGSMITH_TRACING=false
  --env LANGSMITH_CAPTURE_PROMPTS=false
  --env EVIDENCE_LEDGER_ENABLED=false
  --env SCHEDULER_ENABLED=false
  --env OUTREACH_EXECUTION_MODE=mock
  --env OUTREACH_LIVE_FOR_ORGS=
)

start_role() {
  local name=$1
  local port=$2
  local workers_enabled=$3
  docker run --detach \
    --name "${name}" \
    --read-only \
    --tmpfs /tmp:rw,noexec,nosuid,size=32m \
    --cap-drop ALL \
    --security-opt no-new-privileges \
    --network host \
    --env "API_PORT=${port}" \
    --env "WORKER_ENABLED=${workers_enabled}" \
    --env "GRAPH_RUN_WORKER_ENABLED=${workers_enabled}" \
    --env "OUTREACH_WORKER_ENABLED=${workers_enabled}" \
    "${COMMON_ENV[@]}" \
    "${IMAGE_ID}" >/dev/null
}

container_running() {
  [[ "$(docker inspect --format '{{.State.Running}}' "$1" 2>/dev/null)" == "true" ]]
}

wait_for_json_probe() {
  local label=$1
  local container_name=$2
  local url=$3
  local filter=$4
  local body_file=$5
  local deadline=$((SECONDS + STARTUP_TIMEOUT_SECONDS))
  local status=""

  while (( SECONDS < deadline )); do
    if ! container_running "${container_name}"; then
      fail "${label} container exited before its probe passed"
    fi
    status="$(curl --silent --show-error --max-time 3 \
      --output "${body_file}" --write-out '%{http_code}' "${url}" 2>/dev/null || true)"
    if [[ "${status}" == "200" ]] && jq -e "${filter}" >/dev/null "${body_file}" 2>/dev/null; then
      return 0
    fi
    sleep "${POLL_INTERVAL_SECONDS}"
  done
  fail "${label} did not satisfy its runtime contract before timeout"
}

start_role "${WORKER_CONTAINER}" "${WORKER_PORT}" true
WORKER_CREATED="true"
wait_for_json_probe "worker liveness" "${WORKER_CONTAINER}" \
  "http://127.0.0.1:${WORKER_PORT}/api/health/live" \
  '.status == "ok" and .service == "apex-api"' \
  "${TEMP_DIR}/worker-live.json"
wait_for_json_probe "worker readiness" "${WORKER_CONTAINER}" \
  "http://127.0.0.1:${WORKER_PORT}/api/health/ready" \
  '.status == "ok" and .checks.postgres == "ok" and .checks.redis == "ok"' \
  "${TEMP_DIR}/worker-ready.json"

start_role "${API_CONTAINER}" "${API_PORT}" false
API_CREATED="true"
wait_for_json_probe "API liveness" "${API_CONTAINER}" \
  "http://127.0.0.1:${API_PORT}/api/health/live" \
  '.status == "ok" and .service == "apex-api"' \
  "${TEMP_DIR}/api-live.json"
wait_for_json_probe "API readiness" "${API_CONTAINER}" \
  "http://127.0.0.1:${API_PORT}/api/health/ready" \
  '.status == "ok" and .checks.postgres == "ok" and .checks.redis == "ok"' \
  "${TEMP_DIR}/api-ready.json"

WORKER_HEALTH_FILTER='
  .status == "ok" and .healthy == true
  and (.queues | type == "array" and length == 3)
  and ((.queues | map(.queue) | sort) == ["agent-runs", "graph-runs", "outreach-send"])
  and all(.queues[];
    .mode == "bullmq" and .healthy == true
    and (.workerCount | type == "number" and . >= 1)
  )'
wait_for_json_probe "worker consumer registration" "${WORKER_CONTAINER}" \
  "http://127.0.0.1:${WORKER_PORT}/api/health/worker" \
  "${WORKER_HEALTH_FILTER}" "${TEMP_DIR}/worker-health.json"
wait_for_json_probe "API fleet consumer visibility" "${API_CONTAINER}" \
  "http://127.0.0.1:${API_PORT}/api/health/worker" \
  "${WORKER_HEALTH_FILTER}" "${TEMP_DIR}/api-worker-health.json"

UNAUTH_STATUS="$(curl --silent --show-error --max-time 3 \
  --output "${TEMP_DIR}/unauthenticated.json" --write-out '%{http_code}' \
  "http://127.0.0.1:${API_PORT}/api/orgs/onboarding/status" 2>/dev/null || true)"
[[ "${UNAUTH_STATUS}" == "401" ]] ||
  fail "unauthenticated tenant endpoint did not fail closed with HTTP 401"

QUEUE_RECEIPT_JSON="$(jq -c '
  [.queues[] | {name: .queue, workerCount: .workerCount}] | sort_by(.name)
' "${TEMP_DIR}/api-worker-health.json")"

stop_role() {
  local name=$1
  local role=$2
  local exit_code
  docker stop --time "${SHUTDOWN_TIMEOUT_SECONDS}" "${name}" >/dev/null ||
    fail "${role} did not accept bounded SIGTERM shutdown"
  [[ "$(docker inspect --format '{{.State.Running}}' "${name}")" == "false" ]] ||
    fail "${role} remained running after bounded SIGTERM"
  exit_code="$(docker inspect --format '{{.State.ExitCode}}' "${name}")"
  if [[ "${exit_code}" != "0" && "${exit_code}" != "143" ]]; then
    fail "${role} exited uncleanly after SIGTERM"
  fi
  printf '%s' "${exit_code}"
}

API_EXIT_CODE="$(stop_role "${API_CONTAINER}" API)"
WORKER_EXIT_CODE="$(stop_role "${WORKER_CONTAINER}" worker)"

for role in api worker; do
  container_var="${role^^}_CONTAINER"
  docker logs --tail 300 "${!container_var}" >"${TEMP_DIR}/${role}.log" 2>&1 ||
    fail "could not read ${role} runtime log"
  if grep -Eiq \
    'Environment validation failed|Nest can.t resolve dependencies|PrismaClient(Initialization|KnownRequest)Error|UnhandledPromiseRejection|BullMQ (worker|connection) error' \
    "${TEMP_DIR}/${role}.log"; then
    fail "${role} runtime log contains a fatal startup or dependency error"
  fi
done

docker rm "${API_CONTAINER}" >/dev/null
API_CREATED="false"
docker rm "${WORKER_CONTAINER}" >/dev/null
WORKER_CREATED="false"

RECEIPT_TEMP="$(mktemp "${RECEIPT_OUTPUT}.tmp.XXXXXX")"
jq -n \
  --arg candidate "${CANDIDATE_COMMIT}" \
  --arg image_id "${IMAGE_ID}" \
  --arg image_revision "${IMAGE_REVISION}" \
  --arg migration_sha256 "${MIGRATION_RECEIPT_SHA256}" \
  --arg verified_at "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" \
  --argjson queues "${QUEUE_RECEIPT_JSON}" \
  --argjson api_exit_code "${API_EXIT_CODE}" \
  --argjson worker_exit_code "${WORKER_EXIT_CODE}" \
  --argjson shutdown_timeout "${SHUTDOWN_TIMEOUT_SECONDS}" '
  {
    schemaVersion: 1,
    environment: "ci-synthetic",
    authority: "non-authoritative",
    status: "passed",
    candidateCommit: $candidate,
    verifiedAt: $verified_at,
    image: {
      id: $image_id,
      revision: $image_revision
    },
    migrationReceipt: {
      sha256: $migration_sha256,
      verified: true
    },
    dependencies: {
      postgres: "ok",
      redis: "ok"
    },
    roles: {
      api: {liveness: true, readiness: true},
      worker: {liveness: true, readiness: true}
    },
    consumerRegistration: {
      healthy: true,
      queues: $queues
    },
    accessBoundary: {
      unauthenticatedTenantDenied: true,
      statusCode: 401
    },
    shutdown: {
      timeoutSeconds: $shutdown_timeout,
      api: {clean: true, exitCode: $api_exit_code},
      worker: {clean: true, exitCode: $worker_exit_code}
    }
  }' >"${RECEIPT_TEMP}"

if ! jq -e --arg commit "${CANDIDATE_COMMIT}" '
  (keys == [
    "accessBoundary", "authority", "candidateCommit", "consumerRegistration",
    "dependencies", "environment", "image", "migrationReceipt", "roles",
    "schemaVersion", "shutdown", "status", "verifiedAt"
  ])
  and .schemaVersion == 1
  and .environment == "ci-synthetic"
  and .authority == "non-authoritative"
  and .status == "passed"
  and .candidateCommit == $commit
  and (.verifiedAt | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))
  and (.image | keys == ["id", "revision"])
  and (.image.id | test("^sha256:[0-9a-f]{64}$"))
  and .image.revision == $commit
  and (.migrationReceipt | keys == ["sha256", "verified"])
  and (.migrationReceipt.sha256 | test("^sha256:[0-9a-f]{64}$"))
  and .migrationReceipt.verified == true
  and .dependencies == {postgres: "ok", redis: "ok"}
  and .roles == {
    api: {liveness: true, readiness: true},
    worker: {liveness: true, readiness: true}
  }
  and .consumerRegistration.healthy == true
  and (.consumerRegistration.queues | length == 3)
  and all(.consumerRegistration.queues[];
    (.name == "agent-runs" or .name == "graph-runs" or .name == "outreach-send")
    and (.workerCount | type == "number" and . >= 1)
  )
  and .accessBoundary == {unauthenticatedTenantDenied: true, statusCode: 401}
  and .shutdown.api.clean == true
  and .shutdown.worker.clean == true
' >/dev/null "${RECEIPT_TEMP}"; then
  fail "generated runtime receipt is incomplete or structurally invalid"
fi

mv -- "${RECEIPT_TEMP}" "${RECEIPT_OUTPUT}"
RECEIPT_TEMP=""
echo "Synthetic production-runtime rehearsal passed; non-authoritative receipt written"
