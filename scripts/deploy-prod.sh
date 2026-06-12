#!/usr/bin/env bash
#
# deploy-prod.sh — canonical manual prod deploy (audit B7).
#
# Meant to be run from the release branch (release/go-live-*) AFTER CI is
# green. Builds the image once in ACR tagged with the short git SHA (never
# `latest`), then rolls BOTH Container Apps to that exact tag so api and
# worker can never drift apart.
#
#   registry  ledgracr            ACR repo  apex-api
#   RG        Ledgr-prod          apps      apex-gtm-api, apex-gtm-worker
#
# Requires an `az` CLI session with AcrPush on ledgracr and Contributor on
# Ledgr-prod. DB schema changes are NOT touched here — keep the existing
# dry-run → diff → approve → apply workflow manual.
#
# Usage: scripts/deploy-prod.sh [--yes]
#   --yes   skip the interactive confirmation prompt

set -euo pipefail

REGISTRY="ledgracr"
RESOURCE_GROUP="Ledgr-prod"
ACR_REPO="apex-api"
API_APP="apex-gtm-api"
WORKER_APP="apex-gtm-worker"
DOCKERFILE="apps/api/Dockerfile"

# Always build from the repo root so the ACR build context is the full tree.
REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

# --- Guard: refuse a dirty working tree ------------------------------------
# `az acr build` uploads the working tree as the build context, so any
# uncommitted (or untracked) file would ship code that no commit describes.
if [[ -n "$(git status --porcelain)" ]]; then
  echo "ERROR: working tree is dirty — commit or stash before deploying:" >&2
  git status --short >&2
  exit 1
fi

# --- Guard: this script is meant for the release branch --------------------
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$BRANCH" != release/* ]]; then
  echo "WARNING: current branch is '$BRANCH', not a release/* branch." >&2
  echo "         Prod is expected to ship from release/go-live-*." >&2
fi

# Immutable SHA tag — never :latest, so every running revision is traceable
# back to an exact commit.
TAG="$(git rev-parse --short HEAD)"
IMAGE="${REGISTRY}.azurecr.io/${ACR_REPO}:${TAG}"

echo "Branch : ${BRANCH}"
echo "Commit : $(git rev-parse HEAD)"
echo "Image  : ${IMAGE}"
echo "Apps   : ${API_APP} + ${WORKER_APP} (rg ${RESOURCE_GROUP})"
echo

if [[ "${1:-}" != "--yes" ]]; then
  read -r -p "Deploy ${TAG} to PRODUCTION? Type 'deploy' to continue: " REPLY
  if [[ "${REPLY}" != "deploy" ]]; then
    echo "Aborted." >&2
    exit 1
  fi
fi

# --- Build once, SHA-tagged -------------------------------------------------
az acr build \
  --registry "${REGISTRY}" \
  --image "${ACR_REPO}:${TAG}" \
  --file "${DOCKERFILE}" \
  .

# --- Roll BOTH apps to the same image ---------------------------------------
for APP in "${API_APP}" "${WORKER_APP}"; do
  echo "Rolling ${APP} -> ${IMAGE}"
  az containerapp update \
    --name "${APP}" \
    --resource-group "${RESOURCE_GROUP}" \
    --image "${IMAGE}" \
    --output none
  echo "Rolled ${APP} to ${TAG}"
done

cat <<EOF

Deployed ${IMAGE} to ${API_APP} and ${WORKER_APP}.

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
