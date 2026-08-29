#!/usr/bin/env bash
set -Eeuo pipefail

readonly SUBSCRIPTION_ID="3171575e-f164-425c-9ee0-2fb10cf93884"
readonly RESOURCE_GROUP="workforce-os-prod"
readonly ENVIRONMENT_NAME="workforce-os-prod-env"
readonly API_APP="apex-gtm-api"
readonly WORKER_APP="apex-gtm-worker"
readonly CONSOLE_APP="nikxius-web"
readonly API_HOSTNAME="api.workforceos.xyz"
readonly CONSOLE_HOSTNAME="workforceos.xyz"
readonly API_CERTIFICATE_NAME="workforceos-api-v1"
readonly CONSOLE_CERTIFICATE_NAME="workforceos-root-v1"
readonly API_FQDN="apex-gtm-api.braveflower-6d3bb66b.eastus.azurecontainerapps.io"
readonly CONSOLE_FQDN="nikxius-web.braveflower-6d3bb66b.eastus.azurecontainerapps.io"
readonly BACKEND_IMAGE="workforceosprodacr.azurecr.io/apex-api@sha256:6eb0734c3e27a7c4eaec61aa69ccc37e325ab227a4a19789ac64e5efbac9f699"
readonly CONSOLE_IMAGE="workforceosprodacr.azurecr.io/workforceos-fe@sha256:892c308dcf991214a2ac4b4ea95a58c2eb1481524f6f83b1e0734f4c424fe30c"
readonly API_REVISION="apex-gtm-api--bootstrap-api-0767c74-r1-r4"
readonly WORKER_REVISION="apex-gtm-worker--bootstrap-first-class-629881c-r4"
readonly CONSOLE_REVISION="nikxius-web--bootstrap-console-1b930e4"
readonly PREPARE_CONFIRMATION_PHRASE="PREPARE WORKFORCE OS PUBLIC DOMAINS"
readonly BIND_CONFIRMATION_PHRASE="PROMOTE WORKFORCE OS PUBLIC DOMAINS"

APPLY=false
CONFIRMATION=""
PHASE="bind"

usage() {
  cat <<'USAGE'
Usage: scripts/promote-production-custom-domains.sh [options]

Safely verifies the exact completed production bootstrap and prepares or binds
the reviewed custom domains on its Azure Container Apps. This script never
changes DNS or removes a hostname from the legacy environment.

Options:
  --phase prepare|bind    Prepare unbound hostnames or bind ready certificates.
                          Defaults to bind.
  --apply                 Perform the selected phase.
  --confirmation TEXT     Required with --apply. Exact phrase is phase-specific.
  -h, --help              Show this help.
USAGE
}

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

while (($# > 0)); do
  case "$1" in
    --apply)
      APPLY=true
      shift
      ;;
    --phase)
      (($# >= 2)) || fail "--phase requires a value"
      PHASE="$2"
      shift 2
      ;;
    --confirmation)
      (($# >= 2)) || fail "--confirmation requires a value"
      CONFIRMATION="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown argument: $1"
      ;;
  esac
done

[[ "${PHASE}" == "prepare" || "${PHASE}" == "bind" ]] ||
  fail "--phase must be prepare or bind"

for command_name in az curl jq; do
  command -v "${command_name}" >/dev/null 2>&1 || fail "${command_name} is required"
done

[[ "$(az account show --query id -o tsv)" == "${SUBSCRIPTION_ID}" ]] ||
  fail "the active Azure subscription is not the reviewed production subscription"

environment_id="$(az containerapp env show \
  --subscription "${SUBSCRIPTION_ID}" \
  --resource-group "${RESOURCE_GROUP}" \
  --name "${ENVIRONMENT_NAME}" \
  --query id -o tsv --only-show-errors)"
[[ -n "${environment_id}" ]] || fail "the isolated Container Apps environment is unavailable"

api_json="$(az containerapp show --subscription "${SUBSCRIPTION_ID}" \
  --resource-group "${RESOURCE_GROUP}" --name "${API_APP}" --only-show-errors -o json)"
worker_json="$(az containerapp show --subscription "${SUBSCRIPTION_ID}" \
  --resource-group "${RESOURCE_GROUP}" --name "${WORKER_APP}" --only-show-errors -o json)"
console_json="$(az containerapp show --subscription "${SUBSCRIPTION_ID}" \
  --resource-group "${RESOURCE_GROUP}" --name "${CONSOLE_APP}" --only-show-errors -o json)"

jq -e --arg image "${BACKEND_IMAGE}" --arg revision "${API_REVISION}" \
  --arg fqdn "${API_FQDN}" --arg console "https://${CONSOLE_HOSTNAME}" \
  --arg publicApi "https://${API_HOSTNAME}" '
    .properties.provisioningState == "Succeeded"
    and .properties.latestReadyRevisionName == $revision
    and .properties.configuration.ingress.external == true
    and .properties.configuration.ingress.fqdn == $fqdn
    and .properties.template.containers[0].image == $image
    and any(.properties.template.containers[0].env[];
      .name == "API_PUBLIC_URL" and .value == $publicApi)
    and any(.properties.template.containers[0].env[];
      .name == "FRONTEND_URL" and .value == $console)
  ' >/dev/null <<<"${api_json}" || fail "the API is not the reviewed production candidate"

jq -e --arg image "${BACKEND_IMAGE}" --arg revision "${WORKER_REVISION}" '
    .properties.provisioningState == "Succeeded"
    and .properties.latestReadyRevisionName == $revision
    and (.properties.configuration.ingress == null)
    and .properties.template.containers[0].image == $image
  ' >/dev/null <<<"${worker_json}" || fail "the worker is not the reviewed production candidate"

jq -e --arg image "${CONSOLE_IMAGE}" --arg revision "${CONSOLE_REVISION}" \
  --arg fqdn "${CONSOLE_FQDN}" --arg upstream "https://${API_FQDN}" '
    .properties.provisioningState == "Succeeded"
    and .properties.latestReadyRevisionName == $revision
    and .properties.configuration.ingress.external == true
    and .properties.configuration.ingress.fqdn == $fqdn
    and .properties.template.containers[0].image == $image
    and any(.properties.template.containers[0].env[];
      .name == "API_UPSTREAM_URL" and .value == $upstream)
  ' >/dev/null <<<"${console_json}" || fail "the console is not the reviewed production candidate"

for app_record in "${api_json}:${API_HOSTNAME}" "${console_json}:${CONSOLE_HOSTNAME}"; do
  app_payload="${app_record%:*}"
  app_hostname="${app_record##*:}"
  jq -e --arg hostname "${app_hostname}" '
    (.properties.configuration.ingress.customDomains // []) |
    all(.name == $hostname)
  ' >/dev/null <<<"${app_payload}" || fail "an unreviewed custom domain is already present"
done

curl --fail --silent --show-error --retry 4 --retry-delay 2 \
  "https://${API_FQDN}/api/health/live" >/dev/null
curl --fail --silent --show-error --retry 4 --retry-delay 2 \
  "https://${API_FQDN}/api/health/ready" >/dev/null
curl --fail --silent --show-error --retry 4 --retry-delay 2 \
  "https://${CONSOLE_FQDN}/api/healthz" >/dev/null

if [[ "${PHASE}" == "prepare" ]]; then
  jq -n \
    --arg mode "$([[ "${APPLY}" == true ]] && echo apply || echo dry-run)" \
    --arg phase "${PHASE}" \
    --arg apiApp "${API_APP}" --arg apiHostname "${API_HOSTNAME}" \
    --arg consoleApp "${CONSOLE_APP}" --arg consoleHostname "${CONSOLE_HOSTNAME}" \
    '{mode:$mode,phase:$phase,verified:true,hostnames:[{app:$apiApp,hostname:$apiHostname},{app:$consoleApp,hostname:$consoleHostname}],certificateBindingsChanged:false,dnsChanged:false,legacyBindingsChanged:false}'

  if [[ "${APPLY}" != true ]]; then
    exit 0
  fi
  [[ "${CONFIRMATION}" == "${PREPARE_CONFIRMATION_PHRASE}" ]] ||
    fail "prepare apply requires the exact confirmation phrase"

  api_hostname_preexisting="$(jq -r --arg hostname "${API_HOSTNAME}" '
    any((.properties.configuration.ingress.customDomains // [])[]; .name == $hostname)
  ' <<<"${api_json}")"
  console_hostname_preexisting="$(jq -r --arg hostname "${CONSOLE_HOSTNAME}" '
    any((.properties.configuration.ingress.customDomains // [])[]; .name == $hostname)
  ' <<<"${console_json}")"
  api_added_by_run=false
  console_added_by_run=false

  rollback_partial_preparation() {
    local exit_code=$?
    trap - ERR
    set +e
    if [[ "${console_added_by_run}" == true ]]; then
      az containerapp hostname delete --subscription "${SUBSCRIPTION_ID}" \
        --resource-group "${RESOURCE_GROUP}" --name "${CONSOLE_APP}" \
        --hostname "${CONSOLE_HOSTNAME}" --yes --only-show-errors -o none
    fi
    if [[ "${api_added_by_run}" == true ]]; then
      az containerapp hostname delete --subscription "${SUBSCRIPTION_ID}" \
        --resource-group "${RESOURCE_GROUP}" --name "${API_APP}" \
        --hostname "${API_HOSTNAME}" --yes --only-show-errors -o none
    fi
    echo "ERROR: preparation failed; any hostname added by this run was rolled back" >&2
    exit "${exit_code}"
  }
  trap rollback_partial_preparation ERR

  if [[ "${api_hostname_preexisting}" != true ]]; then
    az containerapp hostname add --subscription "${SUBSCRIPTION_ID}" \
      --resource-group "${RESOURCE_GROUP}" --name "${API_APP}" \
      --hostname "${API_HOSTNAME}" --only-show-errors -o none
    api_added_by_run=true
  fi
  if [[ "${console_hostname_preexisting}" != true ]]; then
    az containerapp hostname add --subscription "${SUBSCRIPTION_ID}" \
      --resource-group "${RESOURCE_GROUP}" --name "${CONSOLE_APP}" \
      --hostname "${CONSOLE_HOSTNAME}" --only-show-errors -o none
    console_added_by_run=true
  fi

  api_prepared="$(az containerapp show --subscription "${SUBSCRIPTION_ID}" \
    --resource-group "${RESOURCE_GROUP}" --name "${API_APP}" --only-show-errors -o json)"
  console_prepared="$(az containerapp show --subscription "${SUBSCRIPTION_ID}" \
    --resource-group "${RESOURCE_GROUP}" --name "${CONSOLE_APP}" --only-show-errors -o json)"
  jq -e --arg hostname "${API_HOSTNAME}" '
    any(.properties.configuration.ingress.customDomains[]; .name == $hostname)
  ' >/dev/null <<<"${api_prepared}" || fail "the API hostname was not prepared"
  jq -e --arg hostname "${CONSOLE_HOSTNAME}" '
    any(.properties.configuration.ingress.customDomains[]; .name == $hostname)
  ' >/dev/null <<<"${console_prepared}" || fail "the console hostname was not prepared"

  trap - ERR
  jq -n --arg api "${API_HOSTNAME}" --arg console "${CONSOLE_HOSTNAME}" \
    '{prepared:true,hostnames:[$api,$console],certificateBindingsChanged:false,dnsChanged:false}'
  exit 0
fi

certificates_json="$(az containerapp env certificate list \
  --subscription "${SUBSCRIPTION_ID}" \
  --resource-group "${RESOURCE_GROUP}" \
  --name "${ENVIRONMENT_NAME}" \
  --managed-certificates-only --only-show-errors -o json)"

certificate_id() {
  local name="$1"
  local hostname="$2"
  jq -er --arg name "${name}" --arg hostname "${hostname}" '
    [.[] | select(
      .name == $name
      and .properties.subjectName == $hostname
      and .properties.domainControlValidation == "TXT"
      and .properties.provisioningState == "Succeeded"
    )] | select(length == 1) | .[0].id
  ' <<<"${certificates_json}"
}

api_certificate_id="$(certificate_id "${API_CERTIFICATE_NAME}" "${API_HOSTNAME}")" ||
  fail "the reviewed API managed certificate is not ready"
console_certificate_id="$(certificate_id "${CONSOLE_CERTIFICATE_NAME}" "${CONSOLE_HOSTNAME}")" ||
  fail "the reviewed console managed certificate is not ready"

jq -n \
  --arg mode "$([[ "${APPLY}" == true ]] && echo apply || echo dry-run)" \
  --arg phase "${PHASE}" \
  --arg apiApp "${API_APP}" --arg apiHostname "${API_HOSTNAME}" \
  --arg consoleApp "${CONSOLE_APP}" --arg consoleHostname "${CONSOLE_HOSTNAME}" \
  --arg backendImage "${BACKEND_IMAGE}" --arg consoleImage "${CONSOLE_IMAGE}" \
  '{mode:$mode,phase:$phase,verified:true,bindings:[{app:$apiApp,hostname:$apiHostname},{app:$consoleApp,hostname:$consoleHostname}],images:{backend:$backendImage,console:$consoleImage},dnsChanged:false,legacyBindingsChanged:false}'

if [[ "${APPLY}" != true ]]; then
  exit 0
fi
[[ "${CONFIRMATION}" == "${BIND_CONFIRMATION_PHRASE}" ]] ||
  fail "bind apply requires the exact confirmation phrase"

api_preexisting="$(jq -r --arg hostname "${API_HOSTNAME}" '
  any((.properties.configuration.ingress.customDomains // [])[];
    .name == $hostname and .bindingType == "SniEnabled")
' <<<"${api_json}")"
console_preexisting="$(jq -r --arg hostname "${CONSOLE_HOSTNAME}" '
  any((.properties.configuration.ingress.customDomains // [])[];
    .name == $hostname and .bindingType == "SniEnabled")
' <<<"${console_json}")"
api_bound_by_run=false
console_bound_by_run=false

rollback_partial_binding() {
  local exit_code=$?
  trap - ERR
  set +e
  if [[ "${console_bound_by_run}" == true ]]; then
    az containerapp hostname delete --subscription "${SUBSCRIPTION_ID}" \
      --resource-group "${RESOURCE_GROUP}" --name "${CONSOLE_APP}" \
      --hostname "${CONSOLE_HOSTNAME}" --yes --only-show-errors -o none
  fi
  if [[ "${api_bound_by_run}" == true ]]; then
    az containerapp hostname delete --subscription "${SUBSCRIPTION_ID}" \
      --resource-group "${RESOURCE_GROUP}" --name "${API_APP}" \
      --hostname "${API_HOSTNAME}" --yes --only-show-errors -o none
  fi
  echo "ERROR: promotion failed; any binding created by this run was rolled back" >&2
  exit "${exit_code}"
}
trap rollback_partial_binding ERR

if [[ "${api_preexisting}" != true ]]; then
  az containerapp hostname bind --subscription "${SUBSCRIPTION_ID}" \
    --resource-group "${RESOURCE_GROUP}" --name "${API_APP}" \
    --hostname "${API_HOSTNAME}" --environment "${environment_id}" \
    --certificate "${api_certificate_id}" --validation-method TXT \
    --only-show-errors -o none
  api_bound_by_run=true
fi

if [[ "${console_preexisting}" != true ]]; then
  az containerapp hostname bind --subscription "${SUBSCRIPTION_ID}" \
    --resource-group "${RESOURCE_GROUP}" --name "${CONSOLE_APP}" \
    --hostname "${CONSOLE_HOSTNAME}" --environment "${environment_id}" \
    --certificate "${console_certificate_id}" --validation-method TXT \
    --only-show-errors -o none
  console_bound_by_run=true
fi

api_post="$(az containerapp show --subscription "${SUBSCRIPTION_ID}" \
  --resource-group "${RESOURCE_GROUP}" --name "${API_APP}" --only-show-errors -o json)"
console_post="$(az containerapp show --subscription "${SUBSCRIPTION_ID}" \
  --resource-group "${RESOURCE_GROUP}" --name "${CONSOLE_APP}" --only-show-errors -o json)"

jq -e --arg hostname "${API_HOSTNAME}" --arg certificate "${api_certificate_id}" '
  any(.properties.configuration.ingress.customDomains[];
    .name == $hostname and .bindingType == "SniEnabled"
    and (.certificateId | ascii_downcase) == ($certificate | ascii_downcase))
' >/dev/null <<<"${api_post}" || fail "the API hostname binding did not persist exactly"
jq -e --arg hostname "${CONSOLE_HOSTNAME}" --arg certificate "${console_certificate_id}" '
  any(.properties.configuration.ingress.customDomains[];
    .name == $hostname and .bindingType == "SniEnabled"
    and (.certificateId | ascii_downcase) == ($certificate | ascii_downcase))
' >/dev/null <<<"${console_post}" || fail "the console hostname binding did not persist exactly"

trap - ERR
jq -n --arg api "${API_HOSTNAME}" --arg console "${CONSOLE_HOSTNAME}" \
  '{promoted:true,bindings:[{hostname:$api,status:"SniEnabled"},{hostname:$console,status:"SniEnabled"}],dnsChanged:false}'
