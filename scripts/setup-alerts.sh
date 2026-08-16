#!/usr/bin/env bash
#
# setup-alerts.sh — GO-LIVE GL9: the two live-week Azure Monitor alerts.
#
#   1. apex-gtm-worker replica restart spike  (native platform metric alert)
#   2. BullMQ queue backlog                   (log-based scheduled-query alert)
#
# Targets: resource group workforce-os-prod, Container Apps apex-gtm-api /
# apex-gtm-worker (Microsoft.App/containerApps).
#
# ── Assumptions (verified against what Azure Container Apps actually supports)
#
# * RESTART SPIKE: Microsoft.App/containerApps exposes the platform metric
#   `RestartCount` ("Replica Restart Count", aggregation: Maximum). A native
#   `az monitor metrics alert` works for this — no log plumbing needed.
#   max(RestartCount) >= RESTART_THRESHOLD over a 30-minute window ≈ a
#   crash-looping replica (healthy deploys restart 0–1 times).
#
# * QUEUE BACKLOG: there is NO native queue-depth metric. The app exposes a
#   custom Prometheus gauge `bullmq_queue_depth` at /api/metrics, but Azure
#   Container Apps has no managed Prometheus scrape of app endpoints, so a
#   metric alert on it is not possible without standing up a scraper. The
#   realistic fallback (implemented here) is a Log Analytics scheduled-query
#   alert on the structured log marker the app emits for exactly this
#   purpose: publishQueueDepth() in
#   apps/api/src/observability/metrics/metrics.service.ts logs
#       QUEUE_DEPTH_HIGH queue=<name> waiting=<n> active=<n> backlog=<n> ...
#   at WARN every 30s while waiting+active >= BULLMQ_QUEUE_DEPTH_ALERT_THRESHOLD
#   (default 25). The marker token is load-bearing: do not reword it in code
#   without updating QUERY below, and vice versa.
#
# * LOG DESTINATION: the Container Apps environment must ship console logs to
#   a Log Analytics workspace ("Log Analytics" destination). Console logs then
#   land in the `ContainerAppConsoleLogs_CL` custom table. If the environment
#   uses the "Azure Monitor" destination instead, the table is
#   `ContainerAppConsoleLogs` — override via LOG_TABLE env. If logs go nowhere
#   (destination "None"), the backlog alert cannot exist; fix the environment
#   first. Log ingestion latency (typically 1–5 min) delays this alert
#   accordingly — it is a backstop, not a pager-speed signal.
#
# * The worker emits the marker too (the depth poller runs in BOTH api and
#   worker processes), so the query matches either app's logs; dedup is not
#   needed because we alert on "any occurrences in window", not on a count of
#   distinct incidents.
#
# * IDEMPOTENCY: `az monitor action-group create` and
#   `az monitor metrics alert create` upsert on re-run.
#   `az monitor scheduled-query create` fails if the rule already exists —
#   delete it first (`az monitor scheduled-query delete -g workforce-os-prod -n
#   nikxius-golive-queue-backlog --yes`) or use `update`.
#
# * Requires: az CLI >= 2.50 logged in with Monitoring Contributor (or
#   Contributor) on workforce-os-prod, plus Reader on the Log Analytics workspace.
#
# Usage:  scripts/setup-alerts.sh
# The script refuses to run until the TODO placeholder email is replaced.

set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# TODO(ops): replace with the real on-call address before running.
# This is the ONLY placeholder in the file; the guard below hard-stops the
# script until it is replaced.
ALERT_EMAIL="REPLACE-ME@example.com"
# ─────────────────────────────────────────────────────────────────────────────

RG="workforce-os-prod"
API_APP="apex-gtm-api"
WORKER_APP="apex-gtm-worker"

ACTION_GROUP_NAME="nikxius-golive-ops"
ACTION_GROUP_SHORT="nikxgolive"   # action-group short-name limit: 12 chars

RESTART_ALERT_NAME="nikxius-golive-worker-restart-spike"
BACKLOG_ALERT_NAME="nikxius-golive-queue-backlog"

# max(RestartCount) at or above this within RESTART_WINDOW fires the alert.
RESTART_THRESHOLD=3
RESTART_WINDOW="30m"
RESTART_FREQUENCY="5m"

# The app logs QUEUE_DEPTH_HIGH every 30s while backlog >= 25 (see header).
# Requiring >= 3 marker lines in a 15-minute window filters one-off blips
# (a single poller tick during a deploy roll) while still firing within
# ~2 minutes of marker onset + ingestion latency for a real backlog.
BACKLOG_MIN_MARKER_LINES=3
BACKLOG_WINDOW="15m"
BACKLOG_FREQUENCY="5m"

# ContainerAppConsoleLogs_CL for the "Log Analytics" destination (our setup);
# ContainerAppConsoleLogs for the "Azure Monitor" destination.
LOG_TABLE="${LOG_TABLE:-ContainerAppConsoleLogs_CL}"

if [[ "${ALERT_EMAIL}" == "REPLACE-ME@example.com" ]]; then
  echo "ERROR: ALERT_EMAIL is still the placeholder." >&2
  echo "       Edit scripts/setup-alerts.sh and set the real on-call email first." >&2
  exit 1
fi

echo "==> Resolving resource IDs (rg ${RG})"

WORKER_ID=$(az containerapp show -n "${WORKER_APP}" -g "${RG}" --query id -o tsv)
echo "    worker:    ${WORKER_ID}"

# Container Apps environment -> Log Analytics workspace. The env stores only
# the workspace *customer GUID*, so map it back to the workspace ARM id.
ENV_ID=$(az containerapp show -n "${WORKER_APP}" -g "${RG}" \
  --query properties.environmentId -o tsv)
WORKSPACE_CUSTOMER_ID=$(az containerapp env show --ids "${ENV_ID}" \
  --query properties.appLogsConfiguration.logAnalyticsConfiguration.customerId -o tsv)

if [[ -z "${WORKSPACE_CUSTOMER_ID}" || "${WORKSPACE_CUSTOMER_ID}" == "null" ]]; then
  echo "ERROR: Container Apps environment ${ENV_ID} does not send logs to a" >&2
  echo "       Log Analytics workspace. The queue-backlog alert is log-based" >&2
  echo "       and cannot be created. Fix the environment's log destination" >&2
  echo "       first (az containerapp env update --logs-destination log-analytics ...)." >&2
  exit 1
fi

WORKSPACE_ID=$(az monitor log-analytics workspace list \
  --query "[?customerId=='${WORKSPACE_CUSTOMER_ID}'].id | [0]" -o tsv)
WORKSPACE_LOCATION=$(az monitor log-analytics workspace list \
  --query "[?customerId=='${WORKSPACE_CUSTOMER_ID}'].location | [0]" -o tsv)

if [[ -z "${WORKSPACE_ID}" || "${WORKSPACE_ID}" == "null" ]]; then
  echo "ERROR: could not resolve a Log Analytics workspace for customerId" >&2
  echo "       ${WORKSPACE_CUSTOMER_ID} in this subscription. If the workspace" >&2
  echo "       lives in another subscription, set WORKSPACE_ID/WORKSPACE_LOCATION" >&2
  echo "       manually and rerun." >&2
  exit 1
fi
echo "    workspace: ${WORKSPACE_ID} (${WORKSPACE_LOCATION})"

echo "==> Action group ${ACTION_GROUP_NAME} -> ${ALERT_EMAIL}"
az monitor action-group create \
  --name "${ACTION_GROUP_NAME}" \
  --resource-group "${RG}" \
  --short-name "${ACTION_GROUP_SHORT}" \
  --action email oncall "${ALERT_EMAIL}" \
  --output none

ACTION_GROUP_ID=$(az monitor action-group show \
  --name "${ACTION_GROUP_NAME}" --resource-group "${RG}" --query id -o tsv)

echo "==> Alert 1/2: ${RESTART_ALERT_NAME} (metric: RestartCount on ${WORKER_APP})"
az monitor metrics alert create \
  --name "${RESTART_ALERT_NAME}" \
  --resource-group "${RG}" \
  --scopes "${WORKER_ID}" \
  --condition "max RestartCount >= ${RESTART_THRESHOLD}" \
  --window-size "${RESTART_WINDOW}" \
  --evaluation-frequency "${RESTART_FREQUENCY}" \
  --severity 1 \
  --description "GL9: ${WORKER_APP} replica restarted >= ${RESTART_THRESHOLD}x in ${RESTART_WINDOW} (crash-loop). Triage: az containerapp logs show -n ${WORKER_APP} -g ${RG} --tail 100; then docs/ops/go-live-runbook.md." \
  --action "${ACTION_GROUP_ID}" \
  --output none

echo "==> Alert 2/2: ${BACKLOG_ALERT_NAME} (scheduled query on ${LOG_TABLE})"

# Matches the stable QUEUE_DEPTH_HIGH marker from publishQueueDepth().
# Column names are the _CL custom-table shapes (Log_s, ContainerAppName_s);
# the non-_CL table uses Log / ContainerAppName — adjust if LOG_TABLE is
# overridden.
QUERY="${LOG_TABLE} | where ContainerAppName_s in ('${WORKER_APP}', '${API_APP}') | where Log_s has 'QUEUE_DEPTH_HIGH'"

az monitor scheduled-query create \
  --name "${BACKLOG_ALERT_NAME}" \
  --resource-group "${RG}" \
  --location "${WORKSPACE_LOCATION}" \
  --scopes "${WORKSPACE_ID}" \
  --condition "count 'BacklogMarker' >= ${BACKLOG_MIN_MARKER_LINES}" \
  --condition-query BacklogMarker="${QUERY}" \
  --window-size "${BACKLOG_WINDOW}" \
  --evaluation-frequency "${BACKLOG_FREQUENCY}" \
  --severity 2 \
  --description "GL9: BullMQ backlog (waiting+active) at/over threshold for a sustained window — app logged QUEUE_DEPTH_HIGH >= ${BACKLOG_MIN_MARKER_LINES}x in ${BACKLOG_WINDOW}. If workers=0 in the marker line, the consumer is down (kill switch engaged or worker crashed); see docs/ops/go-live-runbook.md section (c)." \
  --action-groups "${ACTION_GROUP_ID}" \
  --output none

cat <<EOF

Done. Created/updated:
  - Action group     : ${ACTION_GROUP_NAME} (email -> ${ALERT_EMAIL})
  - Metric alert     : ${RESTART_ALERT_NAME} (max RestartCount >= ${RESTART_THRESHOLD} / ${RESTART_WINDOW})
  - Scheduled query  : ${BACKLOG_ALERT_NAME} (>= ${BACKLOG_MIN_MARKER_LINES} QUEUE_DEPTH_HIGH lines / ${BACKLOG_WINDOW})

Verify:
  az monitor metrics alert show -n ${RESTART_ALERT_NAME} -g ${RG} -o table
  az monitor scheduled-query show -n ${BACKLOG_ALERT_NAME} -g ${RG} -o table

Fire-drill the backlog alert (optional, safe): engage kill switch KS-2
(OUTREACH_WORKER_ENABLED=false) with >= 25 jobs queued and wait ~10 min;
remember to re-enable. See docs/ops/go-live-runbook.md.
EOF
