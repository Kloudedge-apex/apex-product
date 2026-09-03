#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKFLOW="${ROOT}/.github/workflows/apply-agency-schema-production.yml"
CONTROLLER="${ROOT}/scripts/apply-agency-platform-production.sh"
QUEUE_CONTROLLER="${ROOT}/scripts/agency-platform-production-queues.ts"

for file in "${WORKFLOW}" "${CONTROLLER}" "${QUEUE_CONTROLLER}"; do
  [[ -f "${file}" && ! -L "${file}" ]] || {
    echo "ERROR: missing regular agency migration control: ${file}" >&2
    exit 1
  }
done
bash -n "${CONTROLLER}"

require() {
  grep -Fq -- "$1" "$2" || {
    echo "ERROR: agency migration control is missing: $1" >&2
    exit 1
  }
}

require 'environment: workforce-os-production' "${WORKFLOW}"
require 'group: workforce-os-production' "${WORKFLOW}"
require 'contents: write' "${WORKFLOW}"
require 'id-token: write' "${WORKFLOW}"
require 'scripts/verify-github-release-ci.sh "${SOURCE_SHA}"' "${WORKFLOW}"
require 'PRODUCTION_BOOTSTRAP_PGPASS_B64' "${WORKFLOW}"
require 'PRODUCTION_REDIS_URL' "${WORKFLOW}"
require 'MIGRATE WORKFORCE OS PRODUCTION' "${WORKFLOW}"
require 'az storage blob lease acquire' "${CONTROLLER}"
require 'workforce-os-release-lock/production-gtm-platform' "${CONTROLLER}"
require 'queue_control pause' "${CONTROLLER}"
require 'queue_control resume' "${CONTROLLER}"
require 'revision deactivate' "${CONTROLLER}"
require "PGSSLMODE=disable PGSSLROOTCERT=''" "${CONTROLLER}"
require 'pg_restore --clean --if-exists' "${CONTROLLER}"
if grep -Fq -- 'pg_dump --no-owner --no-acl --format=custom --schema=' "${CONTROLLER}"; then
  echo 'ERROR: production rehearsal dump must include extension definitions' >&2
  exit 1
fi
require '--file="${MIGRATION}"' "${CONTROLLER}"
require 'assert_postconditions' "${CONTROLLER}"
require 'queuesRemainPaused:true' "${CONTROLLER}"
require 'productionBootstrapRedisIdentityHash()' "${QUEUE_CONTROLLER}"
require 'async function main()' "${QUEUE_CONTROLLER}"
require 'void main().catch' "${QUEUE_CONTROLLER}"

echo "Agency platform production migration workflow verified"
