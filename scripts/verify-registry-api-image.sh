#!/usr/bin/env bash

# Pull one immutable ACR image by digest and run the production API/worker
# image contract against that exact registry artifact. Tags are deliberately
# rejected: resolving a tag is the caller's responsibility, and verification
# must bind to the frozen digest that will be deployed.

set -euo pipefail

IMAGE="${1:-}"
EXPECTED_REVISION="${2:-}"
EXPECTED_PLATFORM="linux/amd64"

if [[ -z "${IMAGE}" || -z "${EXPECTED_REVISION}" ]]; then
  echo "Usage: $0 <registry.azurecr.io/repository@sha256:digest> <expected-git-sha>" >&2
  exit 2
fi

if [[ ! "${IMAGE}" =~ ^([a-z0-9]{5,50})\.azurecr\.io/[a-z0-9]+([._/-][a-z0-9]+)*@sha256:[0-9a-f]{64}$ ]]; then
  echo "ERROR: image must be a canonical lowercase ACR digest reference: ${IMAGE}" >&2
  exit 1
fi
REGISTRY_NAME="${BASH_REMATCH[1]}"

if [[ ! "${EXPECTED_REVISION}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "ERROR: expected revision must be a full lowercase 40-character Git SHA" >&2
  exit 1
fi

for REQUIRED_COMMAND in az docker; do
  if ! command -v "${REQUIRED_COMMAND}" >/dev/null 2>&1; then
    echo "ERROR: required command is unavailable: ${REQUIRED_COMMAND}" >&2
    exit 1
  fi
done
if ! docker info >/dev/null 2>&1; then
  echo "ERROR: Docker is unavailable; refusing to verify or deploy an uninspected artifact" >&2
  exit 1
fi

az acr login --name "${REGISTRY_NAME}" --output none
docker pull --platform "${EXPECTED_PLATFORM}" "${IMAGE}" >/dev/null

REPO_DIGESTS="$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "${IMAGE}")"
if ! grep -Fqx -- "${IMAGE}" <<<"${REPO_DIGESTS}"; then
  echo "ERROR: pulled image does not report the requested immutable digest: ${IMAGE}" >&2
  exit 1
fi

ACTUAL_PLATFORM="$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "${IMAGE}")"
if [[ "${ACTUAL_PLATFORM}" != "${EXPECTED_PLATFORM}" ]]; then
  echo "ERROR: registry artifact platform is ${ACTUAL_PLATFORM:-<empty>}, expected ${EXPECTED_PLATFORM}" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"${SCRIPT_DIR}/verify-api-image.sh" "${IMAGE}" "${EXPECTED_REVISION}"

echo "Registry image contract verified: ${IMAGE} (${EXPECTED_PLATFORM}, revision=${EXPECTED_REVISION})"
