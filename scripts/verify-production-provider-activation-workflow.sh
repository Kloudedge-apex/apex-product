#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
WORKFLOW="${1:-${REPO_ROOT}/.github/workflows/activate-production-providers.yml}"

fail() {
  echo "ERROR: production provider activation workflow contract failed: $*" >&2
  exit 1
}

[[ $# -le 1 ]] || { echo "Usage: $0 [activate-production-providers.yml]" >&2; exit 2; }
[[ -f "${WORKFLOW}" && ! -L "${WORKFLOW}" ]] || fail "workflow must be a regular file"

require() {
  grep -Fq -- "$1" "${WORKFLOW}" || fail "missing required source: $1"
}

reject() {
  ! grep -Eq -- "$1" "${WORKFLOW}" || fail "$2"
}

require "  workflow_dispatch:"
require "  group: workforce-os-production"
require "    environment: workforce-os-production"
require '"${GITHUB_REF}" != "refs/heads/master"'
require '"${REF_PROTECTED}" != "true"'
require '"${remote_master_sha}" == "${GITHUB_SHA}"'
require "ACTIVATE WORKFORCE OS PROVIDERS"
require "azure/login@a457da9ea143d694b1b9c7c869ebb04ebe844ef5"
require 'TAVILY_API_KEY: ${{ secrets.PRODUCTION_TAVILY_API_KEY }}'
require 'THEIRSTACK_API_KEY: ${{ secrets.PRODUCTION_THEIRSTACK_API_KEY }}'
require 'HUNTER_API_KEY: ${{ secrets.PRODUCTION_HUNTER_API_KEY }}'
require 'az storage blob lease acquire'
require 'az storage blob lease renew'
require 'az storage blob lease release'
require '--force-with-lease="${release_lock_ref}:${GITHUB_SHA}"'
require 'az containerapp secret set'
require 'TAVILY_API_KEY=secretref:tavily-api-key'
require 'THEIRSTACK_API_KEY=secretref:theirstack-api-key'
require 'HUNTER_API_KEY=secretref:hunter-api-key'
require 'scripts/verify-containerapp-release-config.sh "${initial_image}" "${initial_image}"'
require '"https://${api_fqdn}/api/health/ready"'
require '"https://${api_fqdn}/api/health/worker"'
require 'if ! rollback; then'
reject 'containerapp secret list' "secret values or secret inventory must not be read"
reject '(AZURE_CLIENT_SECRET|client-secret:|creds:|password:)' "stored Azure credentials are forbidden"
reject 'storage blob lease break|storage blob delete|containerapp delete' "destructive recovery is forbidden"
reject '^\s*pull_request:|^\s*push:' "provider activation must remain manual-only"

echo "Production provider activation workflow contract passed."
