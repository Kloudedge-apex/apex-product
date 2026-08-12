#!/usr/bin/env bash
#
# deploy-prod.sh — canonical manual prod deploy (audit B7).
#
# Meant to be run from the release branch (release/go-live-*) AFTER CI is
# green. It requires the exact local commit to be published on its release
# branch, builds the image once in ACR with a full-git-SHA traceability tag,
# resolves that tag to a content digest, pulls and verifies that exact registry
# artifact, then rolls BOTH Container Apps to the same immutable digest.
#
#   registry  ledgracr            ACR repo  apex-api
#   RG        Ledgr-prod          apps      apex-gtm-api, apex-gtm-worker
#
# Requires an `az` CLI session with AcrPush on ledgracr and Contributor on
# Ledgr-prod. DB schema changes are NOT applied here; the separately approved
# workflow must finish first and provide the sanitized receipt required below.
#
# Usage: scripts/deploy-prod.sh --migration-receipt <path> \
#          --migration-signature <path> --migration-allowed-signers <path> [--yes]
#   --migration-receipt          sanitized schema receipt kept outside repo
#   --migration-signature        detached SSH signature over the receipt bytes
#   --migration-allowed-signers  external trusted approver key list
#   --yes                        skip the interactive confirmation prompt

set -euo pipefail

REGISTRY="ledgracr"
RESOURCE_GROUP="Ledgr-prod"
ACR_REPO="apex-api"
API_APP="apex-gtm-api"
WORKER_APP="apex-gtm-worker"
DOCKERFILE="apps/api/Dockerfile"

MIGRATION_RECEIPT=""
MIGRATION_SIGNATURE=""
MIGRATION_ALLOWED_SIGNERS=""
ASSUME_YES="false"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --migration-receipt)
      if [[ $# -lt 2 || -z "${2}" ]]; then
        echo "ERROR: --migration-receipt requires a path" >&2
        exit 2
      fi
      MIGRATION_RECEIPT="$2"
      shift 2
      ;;
    --migration-signature)
      if [[ $# -lt 2 || -z "${2}" ]]; then
        echo "ERROR: --migration-signature requires a path" >&2
        exit 2
      fi
      MIGRATION_SIGNATURE="$2"
      shift 2
      ;;
    --migration-allowed-signers)
      if [[ $# -lt 2 || -z "${2}" ]]; then
        echo "ERROR: --migration-allowed-signers requires a path" >&2
        exit 2
      fi
      MIGRATION_ALLOWED_SIGNERS="$2"
      shift 2
      ;;
    --yes)
      ASSUME_YES="true"
      shift
      ;;
    *)
      echo "Usage: $0 --migration-receipt <path> --migration-signature <path> --migration-allowed-signers <path> [--yes]" >&2
      exit 2
      ;;
  esac
done
if [[ -z "${MIGRATION_RECEIPT}" || -z "${MIGRATION_SIGNATURE}" ||
  -z "${MIGRATION_ALLOWED_SIGNERS}" ]]; then
  echo "ERROR: a signed production migration receipt and allowed-signers trust root are required" >&2
  exit 2
fi

# Resolve the canonical repository before checking or archiving the source.
REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

# --- Guard: refuse a dirty working tree ------------------------------------
# Refuse local drift even though the later build context comes from git archive.
if [[ -n "$(git status --porcelain)" ]]; then
  echo "ERROR: working tree is dirty — commit or stash before deploying:" >&2
  git status --short >&2
  exit 1
fi

# --- Guard: production only ships an exact published release commit --------
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "${BRANCH}" != release/go-live-* ]]; then
  echo "ERROR: current branch is '${BRANCH}', expected release/go-live-*." >&2
  exit 1
fi

COMMIT="$(git rev-parse HEAD)"
if [[ ! "${COMMIT}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "ERROR: HEAD is not a full lowercase Git SHA: ${COMMIT:-<empty>}" >&2
  exit 1
fi

REMOTE_COMMIT="$(git ls-remote --exit-code origin "refs/heads/${BRANCH}" | awk 'NR == 1 { print $1 }')"
if [[ "${REMOTE_COMMIT}" != "${COMMIT}" ]]; then
  echo "ERROR: local HEAD ${COMMIT} is not the published origin/${BRANCH} head" >&2
  echo "       remote head: ${REMOTE_COMMIT:-<missing>}" >&2
  exit 1
fi

"${REPO_ROOT}/scripts/verify-github-release-ci.sh" "${COMMIT}"
"${REPO_ROOT}/scripts/verify-migration-release-receipt.sh" \
  "${MIGRATION_RECEIPT}" \
  "${MIGRATION_SIGNATURE}" \
  "${MIGRATION_ALLOWED_SIGNERS}" \
  "${COMMIT}"

for REQUIRED_COMMAND in az docker gh; do
  if ! command -v "${REQUIRED_COMMAND}" >/dev/null 2>&1; then
    echo "ERROR: required command is unavailable: ${REQUIRED_COMMAND}" >&2
    exit 1
  fi
done
if ! docker info >/dev/null 2>&1; then
  echo "ERROR: Docker is unavailable; the exact registry artifact cannot be verified" >&2
  exit 1
fi

# An atomic GitHub ref serializes all admitted production rollouts across
# operator workstations. Direct Azure mutations remain prohibited while this
# lease exists. A stale lease must be investigated and removed explicitly.
RELEASE_LOCK_REPOSITORY="Kloudedge-apex/apex-product"
RELEASE_LOCK_REF="refs/heads/workforce-os-release-lock/production-gtm-platform"
RELEASE_LOCK_ENDPOINT="repos/${RELEASE_LOCK_REPOSITORY}/git/refs/heads/workforce-os-release-lock/production-gtm-platform"
RELEASE_LOCK_ACQUIRED="false"
RELEASE_LOCK_SAFE_TO_RELEASE="true"
BUILD_CONTEXT=""
cleanup_release_resources() {
  local status=$?
  local lock_commit=""
  trap - EXIT
  set +e
  if [[ -n "${BUILD_CONTEXT:-}" && -d "${BUILD_CONTEXT}" ]]; then
    rm -rf -- "${BUILD_CONTEXT}"
  fi
  if [[ "${RELEASE_LOCK_ACQUIRED:-false}" == "true" &&
    "${RELEASE_LOCK_SAFE_TO_RELEASE:-false}" == "true" ]]; then
    lock_commit="$(gh api "${RELEASE_LOCK_ENDPOINT}" --jq '.object.sha' 2>/dev/null)"
    if [[ "${lock_commit}" == "${COMMIT}" ]]; then
      gh api --method DELETE "${RELEASE_LOCK_ENDPOINT}" >/dev/null 2>&1 ||
        echo "WARNING: release lease cleanup failed; remove it only after confirming no rollout is active" >&2
    else
      echo "WARNING: release lease identity changed; refusing to delete another process's lease" >&2
    fi
  elif [[ "${RELEASE_LOCK_ACQUIRED:-false}" == "true" ]]; then
    echo "ERROR: retaining the production release lease because rollout state is uncertain" >&2
    echo "       investigate Azure state before separately authorizing lease removal" >&2
  fi
  exit "${status}"
}
trap cleanup_release_resources EXIT
if ! gh api \
  --method POST \
  "repos/${RELEASE_LOCK_REPOSITORY}/git/refs" \
  -f "ref=${RELEASE_LOCK_REF}" \
  -f "sha=${COMMIT}" >/dev/null; then
  echo "ERROR: production release lease is already held or could not be acquired" >&2
  echo "       inspect ${RELEASE_LOCK_REF} before any stale-lock removal" >&2
  exit 1
fi
RELEASE_LOCK_ACQUIRED="true"

# Prove access to both targets before creating a registry artifact. Capturing
# the prior references also gives the operator an explicit partial-rollout
# recovery identity; the script never guesses a mutable rollback tag.
PREVIOUS_API_IMAGE="$(az containerapp show \
  --name "${API_APP}" \
  --resource-group "${RESOURCE_GROUP}" \
  --query 'properties.template.containers[0].image' \
  --output tsv)"
PREVIOUS_WORKER_IMAGE="$(az containerapp show \
  --name "${WORKER_APP}" \
  --resource-group "${RESOURCE_GROUP}" \
  --query 'properties.template.containers[0].image' \
  --output tsv)"
if [[ -z "${PREVIOUS_API_IMAGE}" || -z "${PREVIOUS_WORKER_IMAGE}" ]]; then
  echo "ERROR: could not resolve both current Container App image references" >&2
  exit 1
fi
if [[ ! "${PREVIOUS_API_IMAGE}" =~ ^${REGISTRY}\.azurecr\.io/${ACR_REPO}@sha256:[0-9a-f]{64}$ ]] ||
  [[ ! "${PREVIOUS_WORKER_IMAGE}" =~ ^${REGISTRY}\.azurecr\.io/${ACR_REPO}@sha256:[0-9a-f]{64}$ ]]; then
  echo "ERROR: both current apps must already use immutable digest references for safe rollback" >&2
  exit 1
fi
"${REPO_ROOT}/scripts/verify-containerapp-release-config.sh" \
  "${PREVIOUS_API_IMAGE}" \
  "${PREVIOUS_WORKER_IMAGE}"

# Full-SHA traceability tag. Tags remain mutable registry aliases, so the
# deployment identity is resolved to a content digest after the build.
TAG="${COMMIT}"
TAGGED_IMAGE="${REGISTRY}.azurecr.io/${ACR_REPO}:${TAG}"

echo "Branch : ${BRANCH}"
echo "Commit : ${COMMIT}"
echo "Build tag: ${TAGGED_IMAGE}"
echo "Apps   : ${API_APP} + ${WORKER_APP} (rg ${RESOURCE_GROUP})"
echo "Current API image   : ${PREVIOUS_API_IMAGE}"
echo "Current worker image: ${PREVIOUS_WORKER_IMAGE}"
echo

if [[ "${ASSUME_YES}" != "true" ]]; then
  read -r -p "Deploy ${TAG} to PRODUCTION? Type 'deploy' to continue: " REPLY
  if [[ "${REPLY}" != "deploy" ]]; then
    echo "Aborted." >&2
    exit 1
  fi
fi

# --- Build once from the immutable tracked commit ---------------------------
# A clean-tree check alone cannot see ignored secrets and leaves a TOCTOU gap.
# A fresh git archive contains only bytes committed at COMMIT.
BUILD_CONTEXT="$(mktemp -d "${TMPDIR:-/tmp}/workforce-os-release.XXXXXX")"
GIT_NO_REPLACE_OBJECTS=1 git archive --format=tar "${COMMIT}" | \
  tar -xf - -C "${BUILD_CONTEXT}"

# Tag with both the immutable build-run ID and the source SHA. The digest is
# read from the completed ACR run record, not by querying a mutable tag.
RUN_ID="$(az acr build \
  --registry "${REGISTRY}" \
  --image "${ACR_REPO}:{{.Run.ID}}" \
  --image "${ACR_REPO}:${TAG}" \
  --build-arg "VCS_REF=${COMMIT}" \
  --file "${DOCKERFILE}" \
  --platform linux/amd64 \
  --no-logs \
  --query runId \
  --output tsv \
  "${BUILD_CONTEXT}")"
if [[ ! "${RUN_ID}" =~ ^[a-z0-9]+$ ]]; then
  echo "ERROR: ACR returned an invalid build run ID: ${RUN_ID:-<empty>}" >&2
  exit 1
fi

RUN_STATUS="$(az acr task show-run \
  --registry "${REGISTRY}" \
  --run-id "${RUN_ID}" \
  --query status \
  --output tsv)"
if [[ "${RUN_STATUS}" != "Succeeded" ]]; then
  echo "ERROR: ACR build ${RUN_ID} status is ${RUN_STATUS:-<empty>}" >&2
  exit 1
fi

# Resolve from the completed run's outputImages. A tag lookup here would allow
# a retargeting race between build completion and resolution.
DIGEST="$(az acr task show-run \
  --registry "${REGISTRY}" \
  --run-id "${RUN_ID}" \
  --query "outputImages[?repository=='${ACR_REPO}' && tag=='${RUN_ID}'].digest | [0]" \
  --output tsv)"
if [[ ! "${DIGEST}" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "ERROR: ACR run ${RUN_ID} returned an invalid manifest digest: ${DIGEST:-<empty>}" >&2
  exit 1
fi
COMMIT_TAG_DIGEST="$(az acr task show-run \
  --registry "${REGISTRY}" \
  --run-id "${RUN_ID}" \
  --query "outputImages[?repository=='${ACR_REPO}' && tag=='${TAG}'].digest | [0]" \
  --output tsv)"
if [[ "${COMMIT_TAG_DIGEST}" != "${DIGEST}" ]]; then
  echo "ERROR: ACR run ${RUN_ID} did not bind run and commit tags to one digest" >&2
  exit 1
fi
IMAGE="${REGISTRY}.azurecr.io/${ACR_REPO}@${DIGEST}"
echo "ACR run: ${RUN_ID}"
echo "Resolved run output: ${IMAGE}"

# Pull by immutable digest and verify the actual registry object before any
# Container App is changed. The OCI revision label binds it back to COMMIT.
"${REPO_ROOT}/scripts/verify-registry-api-image.sh" "${IMAGE}" "${COMMIT}"

# The registry build and pull can take long enough for a separate operator to
# change production after the initial snapshot. Re-read both deployment
# identities and their configuration immediately before the first mutation;
# never roll back over a release that appeared while this process was building.
CURRENT_REMOTE_COMMIT="$(git ls-remote --exit-code origin "refs/heads/${BRANCH}" | awk 'NR == 1 { print $1 }')"
if [[ "${CURRENT_REMOTE_COMMIT}" != "${COMMIT}" ]]; then
  echo "ERROR: origin/${BRANCH} advanced while the artifact was building; refusing to deploy stale source" >&2
  exit 1
fi
CURRENT_API_IMAGE="$(az containerapp show \
  --name "${API_APP}" \
  --resource-group "${RESOURCE_GROUP}" \
  --query 'properties.template.containers[0].image' \
  --output tsv)"
CURRENT_WORKER_IMAGE="$(az containerapp show \
  --name "${WORKER_APP}" \
  --resource-group "${RESOURCE_GROUP}" \
  --query 'properties.template.containers[0].image' \
  --output tsv)"
if [[ "${CURRENT_API_IMAGE}" != "${PREVIOUS_API_IMAGE}" ||
  "${CURRENT_WORKER_IMAGE}" != "${PREVIOUS_WORKER_IMAGE}" ]]; then
  echo "ERROR: production images changed while the artifact was building; refusing to overwrite a concurrent release" >&2
  echo "Captured API/worker: ${PREVIOUS_API_IMAGE} / ${PREVIOUS_WORKER_IMAGE}" >&2
  echo "Current API/worker : ${CURRENT_API_IMAGE:-<missing>} / ${CURRENT_WORKER_IMAGE:-<missing>}" >&2
  exit 1
fi
"${REPO_ROOT}/scripts/verify-containerapp-release-config.sh" \
  "${PREVIOUS_API_IMAGE}" \
  "${PREVIOUS_WORKER_IMAGE}"

# --- Roll BOTH apps to the same digest --------------------------------------
WORKER_UPDATE_ATTEMPTED="false"
API_UPDATE_ATTEMPTED="false"
rollback_partial_rollout() {
  local rollout_status=$1
  local rollback_failed="false"
  local current_image
  trap - ERR HUP INT TERM
  set +e
  echo "ERROR: rollout did not complete; restoring the captured immutable images." >&2
  if [[ "${API_UPDATE_ATTEMPTED}" == "true" ]]; then
    current_image=""
    current_image="$(az containerapp show \
      --name "${API_APP}" \
      --resource-group "${RESOURCE_GROUP}" \
      --query 'properties.template.containers[0].image' \
      --output tsv)" || rollback_failed="true"
    if [[ "${current_image}" == "${IMAGE}" ]]; then
      az containerapp update \
        --name "${API_APP}" \
        --resource-group "${RESOURCE_GROUP}" \
        --image "${PREVIOUS_API_IMAGE}" \
        --output none || rollback_failed="true"
    elif [[ "${current_image}" != "${PREVIOUS_API_IMAGE}" ]]; then
      echo "ERROR: ${API_APP} changed outside this rollout; refusing to overwrite it during rollback" >&2
      rollback_failed="true"
    fi
  fi
  if [[ "${WORKER_UPDATE_ATTEMPTED}" == "true" ]]; then
    current_image=""
    current_image="$(az containerapp show \
      --name "${WORKER_APP}" \
      --resource-group "${RESOURCE_GROUP}" \
      --query 'properties.template.containers[0].image' \
      --output tsv)" || rollback_failed="true"
    if [[ "${current_image}" == "${IMAGE}" ]]; then
      az containerapp update \
        --name "${WORKER_APP}" \
        --resource-group "${RESOURCE_GROUP}" \
        --image "${PREVIOUS_WORKER_IMAGE}" \
        --output none || rollback_failed="true"
    elif [[ "${current_image}" != "${PREVIOUS_WORKER_IMAGE}" ]]; then
      echo "ERROR: ${WORKER_APP} changed outside this rollout; refusing to overwrite it during rollback" >&2
      rollback_failed="true"
    fi
  fi
  "${REPO_ROOT}/scripts/verify-containerapp-release-config.sh" \
    "${PREVIOUS_API_IMAGE}" \
    "${PREVIOUS_WORKER_IMAGE}" || rollback_failed="true"
  if [[ "${rollback_failed}" == "true" ]]; then
    echo "ERROR: automatic rollback verification failed; operator intervention is required." >&2
    echo "Previous API image   : ${PREVIOUS_API_IMAGE}" >&2
    echo "Previous worker image: ${PREVIOUS_WORKER_IMAGE}" >&2
    echo "Rejected image       : ${IMAGE}" >&2
  else
    echo "Rollback verified on both apps; retaining the lease for post-failure investigation." >&2
  fi
  exit "${rollout_status}"
}
rollback_on_error() {
  local rollout_status=$?
  rollback_partial_rollout "${rollout_status}"
}
rollback_on_signal() {
  local signal_status=$1
  rollback_partial_rollout "${signal_status}"
}
trap rollback_on_error ERR
trap 'rollback_on_signal 129' HUP
trap 'rollback_on_signal 130' INT
trap 'rollback_on_signal 143' TERM

# Worker first: if it cannot provision, the public API remains untouched.
RELEASE_LOCK_SAFE_TO_RELEASE="false"
WORKER_UPDATE_ATTEMPTED="true"
echo "Rolling ${WORKER_APP} -> ${IMAGE}"
az containerapp update \
  --name "${WORKER_APP}" \
  --resource-group "${RESOURCE_GROUP}" \
  --image "${IMAGE}" \
  --output none
"${REPO_ROOT}/scripts/verify-containerapp-release-config.sh" \
  "${PREVIOUS_API_IMAGE}" \
  "${IMAGE}"
echo "Worker is healthy on ${DIGEST}"

API_UPDATE_ATTEMPTED="true"
echo "Rolling ${API_APP} -> ${IMAGE}"
az containerapp update \
  --name "${API_APP}" \
  --resource-group "${RESOURCE_GROUP}" \
  --image "${IMAGE}" \
  --output none
"${REPO_ROOT}/scripts/verify-containerapp-release-config.sh" "${IMAGE}" "${IMAGE}"
echo "API and worker are healthy on ${DIGEST}"

trap - ERR HUP INT TERM
RELEASE_LOCK_SAFE_TO_RELEASE="true"

cat <<EOF

Deployed and read back ${IMAGE} on ${API_APP} and ${WORKER_APP}.

Post-deploy verify:
  1. Confirm both apps run the new image on their active revision:
       az containerapp revision list -n ${API_APP} -g ${RESOURCE_GROUP} \\
         --query "[?properties.active].{rev:name,image:properties.template.containers[0].image}" -o table
       az containerapp revision list -n ${WORKER_APP} -g ${RESOURCE_GROUP} \\
         --query "[?properties.active].{rev:name,image:properties.template.containers[0].image}" -o table
  2. Tail logs for boot errors (the env validator fails fast on misconfig):
       az containerapp logs show -n ${API_APP} -g ${RESOURCE_GROUP} --tail 50
       az containerapp logs show -n ${WORKER_APP} -g ${RESOURCE_GROUP} --tail 50
  3. Hit the API health endpoint, run a tenant-zero smoke
     (approve -> queue -> worker), then check LangSmith for fresh traces.
EOF
