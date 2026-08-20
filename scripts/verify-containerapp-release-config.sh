#!/usr/bin/env bash

# Verify the production API/worker role matrix, probes, release-critical
# non-secret parity, secret-reference wiring, and active revision health. This
# script is read-only; it never prints environment values or secret references.
# Container App secret values are redacted per app, so equal `secretRef` names
# prove wiring parity only; they do not prove that the backing values are equal.

set -euo pipefail

EXPECTED_API_IMAGE="${1:-}"
EXPECTED_WORKER_IMAGE="${2:-}"
RESOURCE_GROUP="workforce-os-prod"
API_APP="apex-gtm-api"
WORKER_APP="apex-gtm-worker"

if [[ -n "${EXPECTED_API_IMAGE}" || -n "${EXPECTED_WORKER_IMAGE}" ]]; then
  if [[ ! "${EXPECTED_API_IMAGE}" =~ ^workforceosprodacr\.azurecr\.io/apex-api@sha256:[0-9a-f]{64}$ ]] ||
    [[ ! "${EXPECTED_WORKER_IMAGE}" =~ ^workforceosprodacr\.azurecr\.io/apex-api@sha256:[0-9a-f]{64}$ ]]; then
    echo "Usage: $0 [<expected-api-digest-ref> <expected-worker-digest-ref>]" >&2
    exit 2
  fi
fi

for REQUIRED_COMMAND in az jq openssl realpath; do
  if ! command -v "${REQUIRED_COMMAND}" >/dev/null 2>&1; then
    echo "ERROR: required command is unavailable: ${REQUIRED_COMMAND}" >&2
    exit 1
  fi
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
CLERK_AUTH_PIN_PATH="docs/ops/production-clerk-auth.sha256"
CLERK_AUTH_PIN_ABS="${REPO_ROOT}/${CLERK_AUTH_PIN_PATH}"
CLERK_AUTH_PIN_REAL="$(realpath "${CLERK_AUTH_PIN_ABS}" 2>/dev/null || true)"
if [[ ! -f "${CLERK_AUTH_PIN_ABS}" ||
  -L "${CLERK_AUTH_PIN_ABS}" ||
  "${CLERK_AUTH_PIN_REAL}" != "${CLERK_AUTH_PIN_ABS}" ]]; then
  echo "ERROR: reviewed production Clerk auth pin is missing or unsafe" >&2
  exit 1
fi
PINNED_CLERK_AUTH_SHA256="$(awk '!/^[[:space:]]*#/ && NF { print }' \
  "${CLERK_AUTH_PIN_ABS}")"
if [[ ! "${PINNED_CLERK_AUTH_SHA256}" =~ ^[0-9a-f]{64}$ ]]; then
  echo "ERROR: production Clerk auth tuple is not configured in reviewed source" >&2
  exit 1
fi

API_JSON="$(az containerapp show --name "${API_APP}" --resource-group "${RESOURCE_GROUP}" --output json)"
WORKER_JSON="$(az containerapp show --name "${WORKER_APP}" --resource-group "${RESOURCE_GROUP}" --output json)"

json_value() {
  local json=$1
  local expression=$2
  jq -er "${expression}" <<<"${json}"
}

env_value() {
  local json=$1
  local name=$2
  jq -er --arg name "${name}" '
    [ .properties.template.containers[0].env[]? | select(.name == $name) ]
    | if length == 0 then ""
      elif length == 1 and (.[0].secretRef // "") == "" then (.[0].value // "")
      else error("missing, duplicate, or secret-backed value")
      end
  ' <<<"${json}"
}

require_env_absent() {
  local json=$1
  local name=$2
  local label=$3
  if [[ "$(jq -er --arg name "${name}" '[.properties.template.containers[0].env[]? | select(.name == $name)] | length' <<<"${json}")" != "0" ]]; then
    echo "ERROR: ${label} must be absent" >&2
    exit 1
  fi
}

clerk_auth_tuple_sha256() {
  local json=$1
  local name value
  {
    printf '%s\0' 'workforce-os-clerk-auth.v1'
    for name in \
      CLERK_JWKS_URL \
      CLERK_ISSUER \
      CLERK_DOMAIN \
      CLERK_AUDIENCE \
      CLERK_AUTHORIZED_PARTIES; do
      value="$(env_value "${json}" "${name}")" || return 1
      printf '%s=%s\0' "${name}" "${value}"
    done
  } | openssl dgst -sha256 -r | awk '{ print $1 }'
}

secret_ref() {
  local json=$1
  local name=$2
  jq -er --arg name "${name}" '
    [ .properties.template.containers[0].env[]? | select(.name == $name) ]
    | if length == 1
         and (.[0].secretRef | type == "string" and length > 0)
         and ((.[0].value // "") == "")
      then .[0].secretRef
      else error("missing, duplicate, or inline secret")
      end
  ' <<<"${json}"
}

optional_secret_ref() {
  local json=$1
  local name=$2
  jq -er --arg name "${name}" '
    [ .properties.template.containers[0].env[]? | select(.name == $name) ]
    | if length == 0 then ""
      elif length == 1
           and (.[0].secretRef | type == "string" and length > 0)
           and ((.[0].value // "") == "")
        then .[0].secretRef
      else error("duplicate or inline secret")
      end
  ' <<<"${json}"
}

probe_path() {
  local json=$1
  local type=$2
  jq -er --arg type "${type}" '
    [ .properties.template.containers[0].probes[]? | select(.type == $type) ]
    | if length == 1
         and (.[0].httpGet.port == 4000)
         and ((.[0].httpGet.scheme // "HTTP") == "HTTP")
      then .[0].httpGet.path
      else error("missing, duplicate, or invalid HTTP probe")
      end
  ' <<<"${json}"
}

require_value() {
  local actual=$1
  local expected=$2
  local label=$3
  if [[ "${actual}" != "${expected}" ]]; then
    echo "ERROR: ${label} is not the required release value" >&2
    exit 1
  fi
}

require_unset_or_false() {
  local actual=$1
  local label=$2
  if [[ -n "${actual}" && "${actual}" != "false" ]]; then
    echo "ERROR: ${label} must be unset or false for the guarded-SDR release" >&2
    exit 1
  fi
}

require_inactive_revision_retention() {
  local json=$1
  local app=$2
  local retained
  retained="$(json_value "${json}" '.properties.configuration.maxInactiveRevisions')" || {
    echo "ERROR: ${app} maxInactiveRevisions must be explicit" >&2
    exit 1
  }
  if [[ ! "${retained}" =~ ^[1-9][0-9]*$ ]]; then
    echo "ERROR: ${app} maxInactiveRevisions must retain at least one rollback revision" >&2
    exit 1
  fi
}

require_env_value_parity() {
  local name=$1
  local api_value worker_value
  if ! api_value="$(env_value "${API_JSON}" "${name}")"; then
    echo "ERROR: API ${name} is duplicate or secret-backed; expected one plain value" >&2
    exit 1
  fi
  if ! worker_value="$(env_value "${WORKER_JSON}" "${name}")"; then
    echo "ERROR: worker ${name} is duplicate or secret-backed; expected one plain value" >&2
    exit 1
  fi
  require_value "${worker_value}" "${api_value}" "${name} value parity"
}

require_secret_ref_name_parity() {
  local name=$1
  local required=$2
  local api_ref worker_ref
  if [[ "${required}" == "true" ]]; then
    if ! api_ref="$(secret_ref "${API_JSON}" "${name}")"; then
      echo "ERROR: API ${name} must use exactly one nonempty secretRef" >&2
      exit 1
    fi
    if ! worker_ref="$(secret_ref "${WORKER_JSON}" "${name}")"; then
      echo "ERROR: worker ${name} must use exactly one nonempty secretRef" >&2
      exit 1
    fi
  else
    if ! api_ref="$(optional_secret_ref "${API_JSON}" "${name}")"; then
      echo "ERROR: API ${name} must be absent or use exactly one nonempty secretRef" >&2
      exit 1
    fi
    if ! worker_ref="$(optional_secret_ref "${WORKER_JSON}" "${name}")"; then
      echo "ERROR: worker ${name} must be absent or use exactly one nonempty secretRef" >&2
      exit 1
    fi
  fi
  require_value "${worker_ref}" "${api_ref}" "${name} secret-reference name parity"
}

require_value "$(env_value "${API_JSON}" NODE_ENV)" "production" "API NODE_ENV"
require_value "$(env_value "${WORKER_JSON}" NODE_ENV)" "production" "worker NODE_ENV"
require_value \
  "$(env_value "${API_JSON}" REQUIRE_PRODUCTION_ENV)" \
  "true" \
  "API REQUIRE_PRODUCTION_ENV"
require_value \
  "$(env_value "${WORKER_JSON}" REQUIRE_PRODUCTION_ENV)" \
  "true" \
  "worker REQUIRE_PRODUCTION_ENV"
require_inactive_revision_retention "${API_JSON}" "${API_APP}"
require_inactive_revision_retention "${WORKER_JSON}" "${WORKER_APP}"

for GATE in GMAIL_WATCH_RENEWAL_ENABLED GRAPH_RUN_WORKER_ENABLED OUTREACH_WORKER_ENABLED; do
  require_value "$(env_value "${API_JSON}" "${GATE}")" "false" "API ${GATE}"
  require_value "$(env_value "${WORKER_JSON}" "${GATE}")" "true" "worker ${GATE}"
done
require_env_absent "${API_JSON}" WORKER_ENABLED "API retired generic worker gate"
require_env_absent "${WORKER_JSON}" WORKER_ENABLED "worker retired generic worker gate"
for RETIRED_BILLING_ENV in RAZORPAY_KEY_ID RAZORPAY_KEY_SECRET RAZORPAY_WEBHOOK_SECRET; do
  require_env_absent \
    "${API_JSON}" \
    "${RETIRED_BILLING_ENV}" \
    "API retired billing configuration ${RETIRED_BILLING_ENV}"
  require_env_absent \
    "${WORKER_JSON}" \
    "${RETIRED_BILLING_ENV}" \
    "worker retired billing configuration ${RETIRED_BILLING_ENV}"
done
API_FAILED_WRITE_GATE="$(env_value "${API_JSON}" OUTREACH_FAILED_STATUS_WRITES_ENABLED)"
WORKER_FAILED_WRITE_GATE="$(env_value "${WORKER_JSON}" OUTREACH_FAILED_STATUS_WRITES_ENABLED)"
if [[ -n "${API_FAILED_WRITE_GATE}" && "${API_FAILED_WRITE_GATE}" != "false" ]]; then
  echo "ERROR: API OUTREACH_FAILED_STATUS_WRITES_ENABLED must be absent or false" >&2
  exit 1
fi
if [[ -n "${WORKER_FAILED_WRITE_GATE}" &&
  "${WORKER_FAILED_WRITE_GATE}" != "false" &&
  "${WORKER_FAILED_WRITE_GATE}" != "true" ]]; then
  echo "ERROR: worker OUTREACH_FAILED_STATUS_WRITES_ENABLED must be absent, false, or true" >&2
  exit 1
fi
if [[ "${WORKER_FAILED_WRITE_GATE}" == "true" ]]; then
  require_value \
    "$(env_value "${WORKER_JSON}" OUTREACH_FAILED_STATUS_WRITES_ACK)" \
    "readers-drained-legacy-inventory-reviewed-v1" \
    "worker first-class FAILED write attestation"
fi
for LEGACY_DELIVERY_UNKNOWN_ENV in \
  OUTREACH_DELIVERY_UNKNOWN_STATUS_WRITES_ENABLED \
  OUTREACH_DELIVERY_UNKNOWN_STATUS_WRITES_ACK; do
  require_env_absent "${API_JSON}" "${LEGACY_DELIVERY_UNKNOWN_ENV}" "API legacy ${LEGACY_DELIVERY_UNKNOWN_ENV}"
  require_env_absent "${WORKER_JSON}" "${LEGACY_DELIVERY_UNKNOWN_ENV}" "worker legacy ${LEGACY_DELIVERY_UNKNOWN_ENV}"
done
API_DELIVERY_UNKNOWN_WRITE_MODE="$(env_value "${API_JSON}" OUTREACH_DELIVERY_UNKNOWN_WRITE_MODE)"
WORKER_DELIVERY_UNKNOWN_WRITE_MODE="$(env_value "${WORKER_JSON}" OUTREACH_DELIVERY_UNKNOWN_WRITE_MODE)"
API_DELIVERY_UNKNOWN_WRITE_MODE="${API_DELIVERY_UNKNOWN_WRITE_MODE:-disabled}"
WORKER_DELIVERY_UNKNOWN_WRITE_MODE="${WORKER_DELIVERY_UNKNOWN_WRITE_MODE:-disabled}"
require_value "${API_DELIVERY_UNKNOWN_WRITE_MODE}" "disabled" "API DELIVERY_UNKNOWN write mode"
require_env_absent "${API_JSON}" OUTREACH_DELIVERY_UNKNOWN_WRITE_ACK "API DELIVERY_UNKNOWN write acknowledgement"
require_env_absent "${API_JSON}" OUTREACH_ROLLBACK_COMPATIBILITY_EPOCH "API DELIVERY_UNKNOWN compatibility epoch"
case "${WORKER_DELIVERY_UNKNOWN_WRITE_MODE}" in
  disabled)
    require_env_absent "${WORKER_JSON}" OUTREACH_DELIVERY_UNKNOWN_WRITE_ACK \
      "disabled worker DELIVERY_UNKNOWN write acknowledgement"
    require_env_absent "${WORKER_JSON}" OUTREACH_ROLLBACK_COMPATIBILITY_EPOCH \
      "disabled worker DELIVERY_UNKNOWN compatibility epoch"
    if [[ -n "$(env_value "${WORKER_JSON}" OUTREACH_LIVE_FOR_ORGS)" ]]; then
      echo "ERROR: disabled DELIVERY_UNKNOWN bootstrap mode requires an empty worker live-send allowlist" >&2
      exit 1
    fi
    ;;
  first-class)
    require_value \
      "$(env_value "${WORKER_JSON}" OUTREACH_DELIVERY_UNKNOWN_WRITE_ACK)" \
      "readers-drained-rollback-baselines-verified-v1" \
      "worker first-class DELIVERY_UNKNOWN acknowledgement"
    require_value \
      "$(env_value "${WORKER_JSON}" OUTREACH_ROLLBACK_COMPATIBILITY_EPOCH)" \
      "outreach-delivery-unknown-v1" \
      "worker DELIVERY_UNKNOWN rollback compatibility epoch"
    ;;
  *)
    echo "ERROR: worker OUTREACH_DELIVERY_UNKNOWN_WRITE_MODE must be disabled or first-class" >&2
    exit 1
    ;;
esac
require_value "$(env_value "${API_JSON}" SCHEDULER_ENABLED)" "false" "API SCHEDULER_ENABLED"
require_value "$(env_value "${WORKER_JSON}" SCHEDULER_ENABLED)" "false" "worker SCHEDULER_ENABLED"

# These settings affect authentication, provider selection, compliance, queue
# behavior, health interpretation, or release observability in both roles. An
# empty value is allowed where the application defines an optional setting, but
# one role may not silently carry a different value from the other.
SHARED_NON_SECRET_ENV_NAMES=(
  API_PORT
  CORS_ALLOWED_ORIGINS
  CLERK_ISSUER
  CLERK_DOMAIN
  CLERK_JWKS_URL
  CLERK_AUDIENCE
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
  GOOGLE_CLIENT_ID
  GOOGLE_REDIRECT_URI
  MICROSOFT_CLIENT_ID
  MICROSOFT_REDIRECT_URI
  HUBSPOT_CLIENT_ID
  HUBSPOT_REDIRECT_URI
  LINKEDIN_CLIENT_ID
  LINKEDIN_REDIRECT_URI
  AZURE_OPENAI_ENDPOINT
  AZURE_OPENAI_API_VERSION
  AZURE_OPENAI_DEPLOYMENT
  AZURE_OPENAI_FAST_DEPLOYMENT
  AZURE_OPENAI_EMBEDDING_DEPLOYMENT
  DEFAULT_MODEL
  SYSTEM_MODEL_MINI
  LLM_TIMEOUT_MS
  LLM_DAILY_USD_CAP_PER_ORG
  OUTREACH_DAILY_CAP_PER_ORG
  OUTREACH_EXECUTION_MODE
  OUTREACH_ALLOW_WILDCARD
  GMAIL_PUBSUB_TOPIC
  GMAIL_PUSH_AUDIENCE
  GMAIL_PUSH_PUBLISHER_SA
  HEALTH_CHECK_TIMEOUT_MS
  WORKER_HEALTH_STALL_WINDOW_MS
  BULLMQ_QUEUE_DEPTH_ALERT_THRESHOLD
  REDIS_HOST
  REDIS_PORT
  REDIS_USERNAME
  REDIS_TLS
  SSRF_GUARD_HOSTNAME_ALLOWLIST
  LANGSMITH_TRACING
  LANGSMITH_PROJECT
  LANGSMITH_CAPTURE_PROMPTS
  LANGSMITH_MAX_CONTENT_CHARS
  LANGSMITH_JUDGE_MODEL
  OTEL_EXPORTER_OTLP_ENDPOINT
  EVIDENCE_LEDGER_ENABLED
  FRONTEND_URL
  ALLOW_DEV_ORG_HEADER
  ENCRYPTION_KEY_DEV_FALLBACK
  WORKFORCE_PRODUCTION_BOOTSTRAP_ATTEMPT_ID
  WORKFORCE_PRODUCTION_BOOTSTRAP_MIN_WRITER_FENCE_GENERATION
)
for ENV_NAME in "${SHARED_NON_SECRET_ENV_NAMES[@]}"; do
  require_env_value_parity "${ENV_NAME}"
done

require_value \
  "$(env_value "${API_JSON}" EVIDENCE_LEDGER_ENABLED)" \
  "true" \
  "API EVIDENCE_LEDGER_ENABLED"
require_value \
  "$(env_value "${WORKER_JSON}" EVIDENCE_LEDGER_ENABLED)" \
  "true" \
  "worker EVIDENCE_LEDGER_ENABLED"

BOOTSTRAP_ATTEMPT_ID="$(env_value \
  "${API_JSON}" WORKFORCE_PRODUCTION_BOOTSTRAP_ATTEMPT_ID)"
BOOTSTRAP_MINIMUM_GENERATION="$(env_value \
  "${API_JSON}" WORKFORCE_PRODUCTION_BOOTSTRAP_MIN_WRITER_FENCE_GENERATION)"
if [[ ! "${BOOTSTRAP_ATTEMPT_ID}" =~ ^[0-9a-f]{32}$ ]]; then
  echo "ERROR: production bootstrap attempt guard must be exactly 32 lowercase hexadecimal characters" >&2
  exit 1
fi
if [[ ! "${BOOTSTRAP_MINIMUM_GENERATION}" =~ ^[1-9][0-9]*$ ]] ||
  (( ${#BOOTSTRAP_MINIMUM_GENERATION} > 16 )) ||
  { (( ${#BOOTSTRAP_MINIMUM_GENERATION} == 16 )) &&
    [[ "${BOOTSTRAP_MINIMUM_GENERATION}" > "9007199254740991" ]]; }; then
  echo "ERROR: production bootstrap minimum writer-fence generation must be a positive safe integer" >&2
  exit 1
fi

FRONTEND_URL_VALUE="$(env_value "${API_JSON}" FRONTEND_URL)"
if [[ ! "${FRONTEND_URL_VALUE}" =~ ^https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?$ ]]; then
  echo "ERROR: FRONTEND_URL is not a canonical public HTTPS origin" >&2
  exit 1
fi
FRONTEND_AUTHORITY="${FRONTEND_URL_VALUE#https://}"
FRONTEND_HOST="${FRONTEND_AUTHORITY%%:*}"
FRONTEND_HOST_LOWER="$(printf '%s' "${FRONTEND_HOST}" | tr '[:upper:]' '[:lower:]')"
case "${FRONTEND_HOST_LOWER}" in
  localhost|*.localhost|*.arpa|*.corp|*.example|*.home|*.internal|*.invalid|*.lan|*.local|*.onion|*.test)
    echo "ERROR: FRONTEND_URL is not public" >&2
    exit 1
    ;;
esac
if [[ "${FRONTEND_HOST_LOWER}" =~ ^[0-9]+(\.[0-9]+){3}$ ]]; then
  echo "ERROR: FRONTEND_URL must use a public DNS hostname, not an IP address" >&2
  exit 1
fi
if [[ "${FRONTEND_HOST_LOWER}" != *.* ]]; then
  echo "ERROR: FRONTEND_URL host is not a fully qualified public DNS name" >&2
  exit 1
fi

for DISABLED_ENV in OUTREACH_ALLOW_WILDCARD ALLOW_DEV_ORG_HEADER ENCRYPTION_KEY_DEV_FALLBACK; do
  require_unset_or_false \
    "$(env_value "${API_JSON}" "${DISABLED_ENV}")" \
    "${DISABLED_ENV}"
done

API_PORT_VALUE="$(env_value "${API_JSON}" API_PORT)"
if [[ -n "${API_PORT_VALUE}" && "${API_PORT_VALUE}" != "4000" ]]; then
  echo "ERROR: API_PORT must be unset or 4000 to match the release probes" >&2
  exit 1
fi
if [[ -z "$(env_value "${API_JSON}" CORS_ALLOWED_ORIGINS)" ]]; then
  echo "ERROR: CORS_ALLOWED_ORIGINS must be explicit in production" >&2
  exit 1
fi
if [[ -z "$(env_value "${API_JSON}" GOOGLE_CLIENT_ID)" ]]; then
  echo "ERROR: GOOGLE_CLIENT_ID must be explicit in production" >&2
  exit 1
fi

API_PUBLIC_URL="$(env_value "${API_JSON}" API_PUBLIC_URL)"
WORKER_PUBLIC_URL="$(env_value "${WORKER_JSON}" API_PUBLIC_URL)"
require_value "${WORKER_PUBLIC_URL}" "${API_PUBLIC_URL}" "API_PUBLIC_URL parity"
if [[ ! "${API_PUBLIC_URL}" =~ ^https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?(/api)?/?$ ]]; then
  echo "ERROR: API_PUBLIC_URL is not a canonical public HTTPS API origin" >&2
  exit 1
fi
PUBLIC_AUTHORITY="${API_PUBLIC_URL#https://}"
PUBLIC_AUTHORITY="${PUBLIC_AUTHORITY%%/*}"
PUBLIC_HOST="${PUBLIC_AUTHORITY%%:*}"
case "${PUBLIC_HOST}" in
  localhost|*.localhost|*.local|127.*|10.*|192.168.*|169.254.*)
    echo "ERROR: API_PUBLIC_URL is not public" >&2
    exit 1
    ;;
esac
if [[ "${PUBLIC_HOST}" != *.* ]]; then
  echo "ERROR: API_PUBLIC_URL host is not a fully qualified public DNS name" >&2
  exit 1
fi

EXPECTED_GOOGLE_REDIRECT_URI="https://${PUBLIC_AUTHORITY}/api/integrations/gmail/callback"
require_value \
  "$(env_value "${API_JSON}" GOOGLE_REDIRECT_URI)" \
  "${EXPECTED_GOOGLE_REDIRECT_URI}" \
  "GOOGLE_REDIRECT_URI"

GMAIL_PUBSUB_TOPIC="$(env_value "${API_JSON}" GMAIL_PUBSUB_TOPIC)"
if [[ ! "${GMAIL_PUBSUB_TOPIC}" =~ ^projects/[a-z][a-z0-9-]{4,28}[a-z0-9]/topics/[A-Za-z][A-Za-z0-9._~+%-]{2,254}$ ]]; then
  echo "ERROR: GMAIL_PUBSUB_TOPIC is not a canonical Pub/Sub topic resource name" >&2
  exit 1
fi

EXPECTED_GMAIL_PUSH_AUDIENCE="https://${PUBLIC_AUTHORITY}/api/integrations/gmail/push"
require_value \
  "$(env_value "${API_JSON}" GMAIL_PUSH_AUDIENCE)" \
  "${EXPECTED_GMAIL_PUSH_AUDIENCE}" \
  "GMAIL_PUSH_AUDIENCE"

GMAIL_PUSH_PUBLISHER_SA="$(env_value "${API_JSON}" GMAIL_PUSH_PUBLISHER_SA)"
if [[ ! "${GMAIL_PUSH_PUBLISHER_SA}" =~ ^[a-z][a-z0-9-]{0,62}@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$ ]]; then
  echo "ERROR: GMAIL_PUSH_PUBLISHER_SA is not a canonical Google service-account email" >&2
  exit 1
fi
require_value \
  "$(json_value "${API_JSON}" '.properties.configuration.ingress.external')" \
  "true" \
  "API external ingress"
require_value \
  "$(json_value "${API_JSON}" '(.properties.configuration.ingress.allowInsecure // false)')" \
  "false" \
  "API TLS-only ingress"
require_value \
  "$(json_value "${API_JSON}" '.properties.configuration.ingress.targetPort')" \
  "4000" \
  "API ingress target port"
require_value \
  "$(json_value "${API_JSON}" '.properties.configuration.ingress.fqdn')" \
  "${PUBLIC_HOST}" \
  "API_PUBLIC_URL and ingress FQDN parity"
require_value \
  "$(json_value "${WORKER_JSON}" '(.properties.configuration.ingress.external // false)')" \
  "false" \
  "worker external ingress"

API_OUTREACH_ALLOWLIST="$(env_value "${API_JSON}" OUTREACH_LIVE_FOR_ORGS)"
WORKER_OUTREACH_ALLOWLIST="$(env_value "${WORKER_JSON}" OUTREACH_LIVE_FOR_ORGS)"
require_value \
  "${WORKER_OUTREACH_ALLOWLIST}" \
  "${API_OUTREACH_ALLOWLIST}" \
  "OUTREACH_LIVE_FOR_ORGS parity"
if [[ "${API_OUTREACH_ALLOWLIST}" =~ ^[[:space:]]*\*[[:space:]]*$ ]]; then
  echo "ERROR: OUTREACH_LIVE_FOR_ORGS wildcard is forbidden for the guarded-SDR release" >&2
  exit 1
fi
API_CLERK_PARTIES="$(env_value "${API_JSON}" CLERK_AUTHORIZED_PARTIES)"
if [[ -z "${API_CLERK_PARTIES}" ]]; then
  echo "ERROR: CLERK_AUTHORIZED_PARTIES must be explicit in production" >&2
  exit 1
fi
require_value \
  "$(env_value "${WORKER_JSON}" CLERK_AUTHORIZED_PARTIES)" \
  "${API_CLERK_PARTIES}" \
  "CLERK_AUTHORIZED_PARTIES parity"
if ! API_CLERK_AUTH_SHA256="$(clerk_auth_tuple_sha256 "${API_JSON}")"; then
  echo "ERROR: API Clerk auth tuple is missing, duplicate, or secret-backed" >&2
  exit 1
fi
if ! WORKER_CLERK_AUTH_SHA256="$(clerk_auth_tuple_sha256 "${WORKER_JSON}")"; then
  echo "ERROR: worker Clerk auth tuple is missing, duplicate, or secret-backed" >&2
  exit 1
fi
require_value \
  "${API_CLERK_AUTH_SHA256}" \
  "${PINNED_CLERK_AUTH_SHA256}" \
  "API Clerk auth trust tuple"
require_value \
  "${WORKER_CLERK_AUTH_SHA256}" \
  "${PINNED_CLERK_AUTH_SHA256}" \
  "worker Clerk auth trust tuple"
require_value \
  "${FRONTEND_URL_VALUE}" \
  "${API_CLERK_PARTIES}" \
  "FRONTEND_URL and sole pinned Clerk browser party"

API_TIMEOUT="$(env_value "${API_JSON}" HEALTH_CHECK_TIMEOUT_MS)"
WORKER_TIMEOUT="$(env_value "${WORKER_JSON}" HEALTH_CHECK_TIMEOUT_MS)"
require_value "${WORKER_TIMEOUT}" "${API_TIMEOUT}" "HEALTH_CHECK_TIMEOUT_MS parity"
if [[ -n "${API_TIMEOUT}" && "${API_TIMEOUT}" != "2000" ]]; then
  echo "ERROR: HEALTH_CHECK_TIMEOUT_MS must be unset or 2000 for the guarded-SDR release" >&2
  exit 1
fi

# Required in both roles. These comparisons intentionally compare only the
# environment's secretRef name. The release evidence must separately establish
# that identically named app-local secrets resolve to the same approved source.
REQUIRED_SHARED_SECRET_ENV_NAMES=(
  DATABASE_URL
  REDIS_URL
  CLERK_SECRET_KEY
  ENCRYPTION_KEY
  ADMIN_API_KEY
  GOOGLE_CLIENT_SECRET
  METRICS_AUTH_TOKEN
  OAUTH_STATE_SECRET
)
for SECRET_NAME in "${REQUIRED_SHARED_SECRET_ENV_NAMES[@]}"; do
  require_secret_ref_name_parity "${SECRET_NAME}" "true"
done

# At least one LLM provider is required at boot. Every configured provider key
# must be secret-backed in both roles and use the same reference name.
LLM_SECRET_REF_PRESENT="false"
for SECRET_NAME in OPENAI_API_KEY AZURE_OPENAI_KEY ANTHROPIC_API_KEY; do
  require_secret_ref_name_parity "${SECRET_NAME}" "false"
  API_SECRET_REF="$(optional_secret_ref "${API_JSON}" "${SECRET_NAME}")"
  if [[ -n "${API_SECRET_REF}" ]]; then
    LLM_SECRET_REF_PRESENT="true"
  fi
done
if [[ "${LLM_SECRET_REF_PRESENT}" != "true" ]]; then
  echo "ERROR: at least one LLM provider key must be secret-backed in both roles" >&2
  exit 1
fi

# Optional shared integrations remain optional, but if either role configures
# one, both must wire it through the same secretRef name. This also rejects an
# inline value without ever reading or printing the backing secret.
OPTIONAL_SHARED_SECRET_ENV_NAMES=(
  UNSUBSCRIBE_HMAC_SECRET
  MICROSOFT_CLIENT_SECRET
  HUBSPOT_CLIENT_SECRET
  LINKEDIN_CLIENT_SECRET
  SERPER_API_KEY
  TAVILY_API_KEY
  THEIRSTACK_API_KEY
  HUNTER_API_KEY
  COMPANIES_HOUSE_API_KEY
  GITHUB_TOKEN
  LANGSMITH_API_KEY
  HUBSPOT_ACCESS_TOKEN
  APOLLO_API_KEY
  INSTANTLY_API_KEY
  REDIS_PASSWORD
)
for SECRET_NAME in "${OPTIONAL_SHARED_SECRET_ENV_NAMES[@]}"; do
  require_secret_ref_name_parity "${SECRET_NAME}" "false"
done

# The Clerk webhook is API-only and intentionally outside cross-role parity.
# If configured, it must still be secret-backed rather than inline.
for SECRET_NAME in CLERK_WEBHOOK_SECRET; do
  optional_secret_ref "${API_JSON}" "${SECRET_NAME}" >/dev/null
  optional_secret_ref "${WORKER_JSON}" "${SECRET_NAME}" >/dev/null
done

require_value "$(probe_path "${API_JSON}" Liveness)" "/api/health/live" "API liveness probe"
require_value "$(probe_path "${API_JSON}" Readiness)" "/api/health/ready" "API readiness probe"
require_value "$(probe_path "${WORKER_JSON}" Liveness)" "/api/health/live" "worker liveness probe"
require_value "$(probe_path "${WORKER_JSON}" Readiness)" "/api/health/worker" "worker readiness probe"

verify_revision() {
  local app=$1
  local json=$2
  local expected_image=$3
  local template_image latest_revision ready_revision revision_json min_replicas

  require_value \
    "$(json_value "${json}" '.properties.template.containers | length')" \
    "1" \
    "${app} container count"

  min_replicas="$(json_value "${json}" '.properties.template.scale.minReplicas')"
  if [[ ! "${min_replicas}" =~ ^[1-9][0-9]*$ ]]; then
    echo "ERROR: ${app} must keep at least one running replica during guarded rollout" >&2
    exit 1
  fi

  require_value \
    "$(json_value "${json}" '.properties.configuration.activeRevisionsMode')" \
    "Single" \
    "${app} active revision mode"
  template_image="$(json_value "${json}" '.properties.template.containers[0].image')"
  if [[ -n "${expected_image}" ]]; then
    require_value "${template_image}" "${expected_image}" "${app} template image"
  fi
  latest_revision="$(json_value "${json}" '.properties.latestRevisionName')"
  ready_revision="$(json_value "${json}" '.properties.latestReadyRevisionName')"
  require_value "${ready_revision}" "${latest_revision}" "${app} latest ready revision"

  revision_json="$(az containerapp revision show \
    --name "${app}" \
    --resource-group "${RESOURCE_GROUP}" \
    --revision "${ready_revision}" \
    --output json)"
  require_value "$(json_value "${revision_json}" '.properties.active')" "true" "${app} revision active state"
  require_value "$(json_value "${revision_json}" '.properties.healthState')" "Healthy" "${app} revision health"
  require_value \
    "$(json_value "${revision_json}" '.properties.provisioningState')" \
    "Provisioned" \
    "${app} revision provisioning"
  require_value \
    "$(json_value "${revision_json}" '.properties.template.containers | length')" \
    "1" \
    "${app} active revision container count"
  require_value \
    "$(json_value "${revision_json}" '.properties.template.containers[0].image')" \
    "${template_image}" \
    "${app} active revision image"
}

verify_revision "${API_APP}" "${API_JSON}" "${EXPECTED_API_IMAGE}"
verify_revision "${WORKER_APP}" "${WORKER_JSON}" "${EXPECTED_WORKER_IMAGE}"

echo "Container App release configuration verified (roles, values, secretRef names, probes, active revisions)"
