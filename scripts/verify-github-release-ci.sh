#!/usr/bin/env bash

# Require the latest push-triggered GitHub CI run for an exact source commit to
# be complete and green, including every release-blocking job.

set -euo pipefail

COMMIT="${1:-}"
REPOSITORY="github.com/Kloudedge-apex/apex-product"

github_cli() {
  /usr/bin/env \
    -u ALL_PROXY \
    -u CURL_CA_BUNDLE \
    -u DEBUG \
    -u GH_DEBUG \
    -u HTTPS_PROXY \
    -u HTTP_PROXY \
    -u SSL_CERT_DIR \
    -u SSL_CERT_FILE \
    -u all_proxy \
    -u http_proxy \
    -u https_proxy \
    GH_HOST=github.com \
    gh "$@"
}

if [[ ! "${COMMIT}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Usage: $0 <full-lowercase-git-sha>" >&2
  exit 2
fi
for REQUIRED_COMMAND in gh jq; do
  if ! command -v "${REQUIRED_COMMAND}" >/dev/null 2>&1; then
    echo "ERROR: required command is unavailable: ${REQUIRED_COMMAND}" >&2
    exit 1
  fi
done

RUNS="$(github_cli run list \
  --repo "${REPOSITORY}" \
  --workflow ci.yml \
  --commit "${COMMIT}" \
  --event push \
  --limit 20 \
  --json databaseId,headSha,status,conclusion,event)"

RUN_ID="$(jq -er --arg commit "${COMMIT}" '
  [ .[] | select(.headSha == $commit and .event == "push") ]
  | sort_by(.databaseId)
  | last
  | .databaseId
' <<<"${RUNS}")" || {
  echo "ERROR: no push-triggered GitHub CI run exists for ${COMMIT}" >&2
  exit 1
}

RUN="$(github_cli run view "${RUN_ID}" \
  --repo "${REPOSITORY}" \
  --json databaseId,headSha,status,conclusion,event,jobs)"

if ! jq -e --arg commit "${COMMIT}" '
  .headSha == $commit
  and .event == "push"
  and .status == "completed"
  and .conclusion == "success"
' >/dev/null <<<"${RUN}"; then
  echo "ERROR: latest GitHub CI run ${RUN_ID} is not a completed success for ${COMMIT}" >&2
  exit 1
fi

for REQUIRED_JOB in \
  "API Tests (blocking)" \
  "Lint, Type Check & Build" \
  "Production Image Contract"; do
  if ! jq -e --arg job "${REQUIRED_JOB}" '
    [ .jobs[] | select(.name == $job and .status == "completed" and .conclusion == "success") ]
    | length == 1
  ' >/dev/null <<<"${RUN}"; then
    echo "ERROR: GitHub CI run ${RUN_ID} lacks one successful '${REQUIRED_JOB}' job" >&2
    exit 1
  fi
done

echo "GitHub release CI verified: ${REPOSITORY} run ${RUN_ID} (${COMMIT})"
