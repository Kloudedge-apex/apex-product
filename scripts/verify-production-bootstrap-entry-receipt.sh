#!/usr/bin/env bash

# Verify the independently signed admission evidence for the one-time
# production enum bootstrap. This script is read-only: it authorizes no Azure,
# queue, database, or Git mutation. The controller context must be produced
# from live state and trusted build evidence; its exact bytes are hash-bound by
# the signed receipt.

set -euo pipefail

RECEIPT="${1:-}"
SIGNATURE="${2:-}"
ALLOWED_SIGNERS="${3:-}"
EXPECTED_BACKEND_COMMIT="${4:-}"
EXPECTED_CONSOLE_COMMIT="${5:-}"
EXPECTED_ATTEMPT_ID="${6:-}"
ADMISSION_CONTEXT="${7:-}"

SIGNATURE_NAMESPACE="workforce-os-initial-bootstrap-entry"
TRUST_ROOT_PIN_PATH="docs/ops/production-migration-allowed-signers.sha256"
RECEIPT_MAX_LIFETIME_SECONDS=3600
CLERK_PLAN_MAX_LIFETIME_SECONDS=86400
DELIVERY_EVIDENCE_MAX_LIFETIME_SECONDS=86400
QUEUE_STABILITY_INTERVAL_SECONDS=5
MAX_RECEIPT_BYTES=131072
MAX_CONTEXT_BYTES=131072
MAX_SIGNATURE_BYTES=16384
MAX_ALLOWED_SIGNERS_BYTES=65536

usage() {
  echo "Usage: $0 <receipt.json> <receipt.sig> <allowed-signers> <backend-commit> <console-commit> <32-hex-attempt-id> <controller-admission-context.json>" >&2
  exit 2
}

if [[ "${#}" -ne 7 ]] ||
  [[ -z "${RECEIPT}" || -z "${SIGNATURE}" || -z "${ALLOWED_SIGNERS}" || -z "${ADMISSION_CONTEXT}" ]] ||
  [[ ! "${EXPECTED_BACKEND_COMMIT}" =~ ^[0-9a-f]{40}$ ]] ||
  [[ ! "${EXPECTED_CONSOLE_COMMIT}" =~ ^[0-9a-f]{40}$ ]] ||
  [[ ! "${EXPECTED_ATTEMPT_ID}" =~ ^[0-9a-f]{32}$ ]]; then
  usage
fi

bounded_regular_file() {
  local path=$1
  local maximum=$2
  local label=$3
  local size
  if [[ ! -f "${path}" || -L "${path}" ]]; then
    echo "ERROR: ${label} must be a regular non-symlink file: ${path}" >&2
    return 1
  fi
  size="$(wc -c <"${path}" | tr -d '[:space:]')"
  if [[ ! "${size}" =~ ^[0-9]+$ ]] || ((size < 1 || size > maximum)); then
    echo "ERROR: ${label} size is outside the permitted range" >&2
    return 1
  fi
}

bounded_regular_file "${RECEIPT}" "${MAX_RECEIPT_BYTES}" "bootstrap entry receipt"
bounded_regular_file "${SIGNATURE}" "${MAX_SIGNATURE_BYTES}" "bootstrap entry signature"
bounded_regular_file "${ALLOWED_SIGNERS}" "${MAX_ALLOWED_SIGNERS_BYTES}" "bootstrap allowed-signers trust root"
bounded_regular_file "${ADMISSION_CONTEXT}" "${MAX_CONTEXT_BYTES}" "bootstrap admission context"

for required_command in date git jq node openssl ssh-keygen wc; do
  if ! command -v "${required_command}" >/dev/null 2>&1; then
    echo "ERROR: required command is unavailable: ${required_command}" >&2
    exit 1
  fi
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
STRICT_JSON_MODULE="${SCRIPT_DIR}/production-bootstrap-phase-receipt-contracts.mjs"
if [[ ! -f "${STRICT_JSON_MODULE}" || -L "${STRICT_JSON_MODULE}" ]]; then
  echo "ERROR: bounded strict-JSON verifier module is unavailable" >&2
  exit 1
fi

if ! GIT_NO_REPLACE_OBJECTS=1 git -C "${REPO_ROOT}" \
  cat-file -e "${EXPECTED_BACKEND_COMMIT}^{commit}" 2>/dev/null; then
  echo "ERROR: expected backend identity is not a committed Git object" >&2
  exit 1
fi

read_reviewed_source() {
  local path=$1
  GIT_NO_REPLACE_OBJECTS=1 git -C "${REPO_ROOT}" \
    show "${EXPECTED_BACKEND_COMMIT}:${path}"
}

if ! TRUST_ROOT_PIN_SOURCE="$(read_reviewed_source "${TRUST_ROOT_PIN_PATH}")"; then
  echo "ERROR: reviewed bootstrap approver trust-root pin is missing from ${EXPECTED_BACKEND_COMMIT}" >&2
  exit 1
fi
if ! PINNED_ALLOWED_SIGNERS_SHA256="$(printf '%s\n' "${TRUST_ROOT_PIN_SOURCE}" | awk '
  /^[[:space:]]*#/ || !NF { next }
  NF != 1 || found { exit 2 }
  { print $1; found = 1 }
  END { if (!found) exit 2 }
')"; then
  echo "ERROR: production bootstrap approver trust root is unconfigured or invalid" >&2
  exit 1
fi
if [[ ! "${PINNED_ALLOWED_SIGNERS_SHA256}" =~ ^[0-9a-f]{64}$ ]]; then
  echo "ERROR: production bootstrap approver trust root is unconfigured or invalid" >&2
  exit 1
fi

# Copy each caller-controlled file exactly once. Signature verification reads
# the private receipt bytes directly; the receipt is never reserialized.
umask 077
EVIDENCE_TEMP="$(mktemp -d "${TMPDIR:-/tmp}/workforce-os-bootstrap-entry.XXXXXX")"
cleanup_evidence() {
  local status=$?
  trap - EXIT HUP INT TERM
  set +e
  rm -f -- \
    "${EVIDENCE_TEMP}/receipt.json" \
    "${EVIDENCE_TEMP}/receipt.sig" \
    "${EVIDENCE_TEMP}/allowed-signers" \
    "${EVIDENCE_TEMP}/admission-context.json"
  rmdir -- "${EVIDENCE_TEMP}"
  exit "${status}"
}
trap cleanup_evidence EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

RECEIPT_COPY="${EVIDENCE_TEMP}/receipt.json"
SIGNATURE_COPY="${EVIDENCE_TEMP}/receipt.sig"
TRUST_ROOT_COPY="${EVIDENCE_TEMP}/allowed-signers"
CONTEXT_COPY="${EVIDENCE_TEMP}/admission-context.json"
cp -- "${RECEIPT}" "${RECEIPT_COPY}"
cp -- "${SIGNATURE}" "${SIGNATURE_COPY}"
cp -- "${ALLOWED_SIGNERS}" "${TRUST_ROOT_COPY}"
cp -- "${ADMISSION_CONTEXT}" "${CONTEXT_COPY}"
chmod 600 "${RECEIPT_COPY}" "${SIGNATURE_COPY}" "${TRUST_ROOT_COPY}" "${CONTEXT_COPY}"

# jq uses last-key-wins semantics and can process multiple trailing JSON
# values. Reject those representations, unsafe numbers, invalid UTF-8, and
# excessive nesting before any semantic jq check. Signature verification still
# consumes the exact original receipt bytes copied above.
if ! node "${STRICT_JSON_MODULE}" strict-json "${RECEIPT_COPY}" "${CONTEXT_COPY}"; then
  echo "ERROR: bootstrap entry receipt or context is not bounded strict JSON" >&2
  exit 1
fi

ACTUAL_ALLOWED_SIGNERS_SHA256="$(openssl dgst -sha256 -r \
  "${TRUST_ROOT_COPY}" | awk '{ print $1 }')"
if [[ "${ACTUAL_ALLOWED_SIGNERS_SHA256}" != "${PINNED_ALLOWED_SIGNERS_SHA256}" ]]; then
  echo "ERROR: supplied bootstrap allowed-signers bytes do not match reviewed source" >&2
  exit 1
fi
ADMISSION_CONTEXT_SHA256="sha256:$(openssl dgst -sha256 -r \
  "${CONTEXT_COPY}" | awk '{ print $1 }')"
if [[ ! "${ADMISSION_CONTEXT_SHA256}" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "ERROR: controller admission context could not be hashed" >&2
  exit 1
fi

MIGRATIONS=(
  "docs/migrations/2026-08-13_clerk-identity-lifecycle-expand.sql"
  "docs/migrations/2026-06-01_outreach-artifact-unique.sql"
  "docs/migrations/2026-08-12_conversation-store-expand.sql"
  "docs/migrations/2026-08-12_outreach-delivery-unknown-expand.sql"
  "docs/migrations/2026-08-13_outreach-artifact-failed-expand.sql"
  "docs/migrations/2026-08-12_conversation-reply-single-flight-expand.sql"
  "docs/migrations/2026-08-12_graph-run-activity-expand.sql"
  "docs/migrations/2026-08-12_graph-run-lifecycle-expand.sql"
  "docs/migrations/2026-08-20_icp-exclusion-domains-expand.sql"
)
WRITER_PAUSE=(
  "observed"
  "observed"
  "not-required"
  "not-required"
  "not-required"
  "observed"
  "not-required"
  "observed"
  "not-required"
)
WRITER_SCOPES=(
  '["api:clerk-webhooks","api:identity-membership"]'
  '["api:outreach-artifacts","worker:outreach-artifacts"]'
  '[]'
  '[]'
  '[]'
  '["worker:gmail-reply-sync"]'
  '[]'
  '["api:graph-start","scheduler:graph-start","worker:graph-run"]'
  '[]'
)
EXPECTED_MIGRATION_COUNT="${#MIGRATIONS[@]}"

if ! jq -e \
  --arg backend_commit "${EXPECTED_BACKEND_COMMIT}" \
  --arg console_commit "${EXPECTED_CONSOLE_COMMIT}" \
  --arg attempt_id "${EXPECTED_ATTEMPT_ID}" \
  --arg context_hash "${ADMISSION_CONTEXT_SHA256}" \
  --argjson migration_count "${EXPECTED_MIGRATION_COUNT}" \
  --slurpfile context "${CONTEXT_COPY}" '
    def exact_keys($expected): type == "object" and keys == $expected;
    def sha256: type == "string" and test("^sha256:[0-9a-f]{64}$");
    def git_sha: type == "string" and test("^[0-9a-f]{40}$");
    def ztime: type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$");
    def principal: type == "string" and test("^[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}$");
    def nonnegative: type == "number" and (floor == .) and . >= 0 and . <= 9007199254740991;
    def positive: nonnegative and . >= 1;
    def backend_image: type == "string" and test("^workforceosprodacr\\.azurecr\\.io/apex-api@sha256:[0-9a-f]{64}$");
    def console_image: type == "string" and test("^workforceosprodacr\\.azurecr\\.io/workforceos-fe@sha256:[0-9a-f]{64}$");
    def build_id: type == "string" and test("^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$");
    def target_backend($revision_pattern):
      exact_keys([
        "buildEvidenceHash", "buildRunId", "image", "manifestDigest",
        "ociRevision", "plannedRevision", "platform", "platformDigest",
        "rehearsalEvidenceHash"
      ])
      and (.image | backend_image)
      and (.manifestDigest | sha256)
      and (.platformDigest | sha256)
      and (.image == ("workforceosprodacr.azurecr.io/apex-api@" + .manifestDigest))
      and (.ociRevision | git_sha)
      and .platform == "linux/amd64"
      and (.plannedRevision | type == "string" and test($revision_pattern))
      and (.buildRunId | build_id)
      and (.buildEvidenceHash | sha256)
      and (.rehearsalEvidenceHash | sha256);
    def target_console:
      exact_keys([
        "buildEvidenceHash", "buildRunId", "clientConfigEvidenceHash", "image",
        "manifestDigest", "ociRevision", "plannedRevision", "platform",
        "platformDigest", "rehearsalEvidenceHash", "smokeEvidenceHash"
      ])
      and (.image | console_image)
      and (.manifestDigest | sha256)
      and (.platformDigest | sha256)
      and (.image == ("workforceosprodacr.azurecr.io/workforceos-fe@" + .manifestDigest))
      and (.ociRevision | git_sha)
      and .platform == "linux/amd64"
      and (.plannedRevision | type == "string" and test("^nikxius-web--[a-z0-9][a-z0-9-]{0,62}$"))
      and (.buildRunId | build_id)
      and (.buildEvidenceHash | sha256)
      and (.rehearsalEvidenceHash | sha256)
      and (.clientConfigEvidenceHash | sha256)
      and (.smokeEvidenceHash | sha256);
    def source_app($image_pattern; $revision_pattern; $repository):
      exact_keys([
        "activeRevisionsMode", "configHash", "healthy", "image",
        "manifestDigest", "maxInactiveRevisions", "ociRevision", "platform",
        "platformDigest", "revision", "secretReferencesHash", "templateHash"
      ])
      and (.image | type == "string" and test($image_pattern))
      and (.manifestDigest | sha256)
      and (.platformDigest | sha256)
      and (.image == ($repository + "@" + .manifestDigest))
      and (.ociRevision | git_sha)
      and .platform == "linux/amd64"
      and (.revision | type == "string" and test($revision_pattern))
      and (.configHash | sha256)
      and (.templateHash | sha256)
      and (.secretReferencesHash | sha256)
      and .activeRevisionsMode == "Single"
      and (.maxInactiveRevisions | type == "number" and floor == . and . >= 1)
      and .healthy == true;
    def queue_state:
      exact_keys([
        "active", "completed", "delayed", "failed", "paused", "pausedJobs",
        "prioritized", "waiting", "waitingChildren", "workerCount"
      ])
      and .paused == true
      and .active == 0
      and .workerCount == 0
      and (.waiting | nonnegative)
      and (.delayed | nonnegative)
      and (.prioritized | nonnegative)
      and (.completed | nonnegative)
      and (.failed | nonnegative)
      and (.waitingChildren | nonnegative)
      and (.pausedJobs | nonnegative);
    def queue_observation:
      exact_keys(["evidenceHash", "observedAt", "queues", "stableSince"])
      and (.observedAt | ztime)
      and (.stableSince | ztime)
      and (.evidenceHash | sha256)
      and (.queues | exact_keys(["agentRuns", "graphRuns", "outreachSend"]))
      and (.queues.agentRuns | queue_state)
      and (.queues.graphRuns | queue_state)
      and (.queues.outreachSend | queue_state);
    def valid_authority:
      exact_keys([
        "apiContainerAppResourceId", "consoleContainerAppResourceId",
        "resourceGroupName", "resourceGroupResourceId", "subscriptionId",
        "workerContainerAppResourceId"
      ])
      and (.subscriptionId | type == "string" and test("^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"))
      and (.resourceGroupName | type == "string" and test("^[A-Za-z0-9][A-Za-z0-9._()-]{0,89}$"))
      and (. as $a
        | (($a.resourceGroupResourceId | ascii_downcase) == (("/subscriptions/" + $a.subscriptionId + "/resourceGroups/" + $a.resourceGroupName) | ascii_downcase))
        and (($a.apiContainerAppResourceId | ascii_downcase) == (("/subscriptions/" + $a.subscriptionId + "/resourceGroups/" + $a.resourceGroupName + "/providers/Microsoft.App/containerApps/apex-gtm-api") | ascii_downcase))
        and (($a.workerContainerAppResourceId | ascii_downcase) == (("/subscriptions/" + $a.subscriptionId + "/resourceGroups/" + $a.resourceGroupName + "/providers/Microsoft.App/containerApps/apex-gtm-worker") | ascii_downcase))
        and (($a.consoleContainerAppResourceId | ascii_downcase) == (("/subscriptions/" + $a.subscriptionId + "/resourceGroups/" + $a.resourceGroupName + "/providers/Microsoft.App/containerApps/nikxius-web") | ascii_downcase))
      );
    def valid_release_lock:
      exact_keys(["objectSha", "ref", "repository"])
      and .repository == "https://github.com/Kloudedge-apex/apex-product.git"
      and .ref == "refs/heads/workforce-os-release-lock/production-gtm-platform"
      and (.objectSha | git_sha);
    def valid_lease:
      exact_keys(["expiresAt", "generation", "observedAt", "token"])
      and (.token | type == "string" and test("^[0-9a-f]{64}$"))
      and (.generation | type == "number" and floor == . and . >= 1)
      and (.observedAt | ztime)
      and (.expiresAt | ztime);
    def valid_clerk_reconciliation_plan:
      exact_keys([
        "approver", "dryRunEvidenceSha256", "dryRunPassed", "executor",
        "expectedActiveMembershipCount", "expectedActiveOrganizationCount",
        "expectedActiveUserCount", "expiresAt", "independentApprovalEvidenceHash",
        "inventoryEvidenceHash", "minimumEventVersion", "planSignatureSha256",
        "rawPlanSha256", "signatureNamespace", "verifiedAt"
      ])
      and (.rawPlanSha256 | sha256)
      and (.dryRunEvidenceSha256 | sha256)
      and (.inventoryEvidenceHash | sha256)
      and (.minimumEventVersion | positive)
      and (.expectedActiveOrganizationCount | nonnegative)
      and (.expectedActiveMembershipCount | nonnegative)
      and (.expectedActiveUserCount | nonnegative)
      and (.executor | exact_keys(["name", "sha256", "version"]))
      and .executor.name == "workforce-production-clerk-reconciliation-executor"
      and .executor.version == "v1"
      and (.executor.sha256 | sha256)
      and .dryRunPassed == true
      and (.approver | principal)
      and (.planSignatureSha256 | sha256)
      and .signatureNamespace == "workforce-os-clerk-reconciliation-plan"
      and (.independentApprovalEvidenceHash | sha256)
      and (.verifiedAt | ztime)
      and (.expiresAt | ztime);
    def valid_database_ddl_authority:
      exact_keys([
        "authorityScope", "backendCandidateCommit", "bootstrapAttemptId",
        "databaseIdentityHash", "environment", "evidenceHash",
        "exclusiveDdlAuthorityConfirmed", "expiresAt", "kind", "reviewedAt",
        "reviewer", "schemaVersion", "verifiedFromProtectedBytes"
      ])
      and .schemaVersion == 1
      and .environment == "production"
      and .kind == "production-database-ddl-exclusive-authority"
      and (.bootstrapAttemptId | type == "string" and test("^[0-9a-f]{32}$"))
      and (.backendCandidateCommit | git_sha)
      and (.databaseIdentityHash | sha256)
      and (.evidenceHash | sha256)
      and (.reviewer | principal)
      and (.reviewedAt | ztime)
      and (.expiresAt | ztime)
      and .authorityScope == "all-production-database-ddl-actors"
      and .exclusiveDdlAuthorityConfirmed == true
      and .verifiedFromProtectedBytes == true;
    def valid_operational_smoke($kind; $scope):
      exact_keys([
        "backendCandidateCommit", "bootstrapAttemptId", "consoleCandidateCommit",
        "environment", "evidenceHash", "expiresAt", "kind", "passed",
        "reviewedAt", "reviewer", "schemaVersion", "scope"
      ])
      and .schemaVersion == 1
      and .environment == "production"
      and .kind == $kind
      and (.bootstrapAttemptId | type == "string" and test("^[0-9a-f]{32}$"))
      and (.backendCandidateCommit | git_sha)
      and (.consoleCandidateCommit | git_sha)
      and (.evidenceHash | sha256)
      and (.reviewer | principal)
      and (.reviewedAt | ztime)
      and (.expiresAt | ztime)
      and .scope == $scope
      and .passed == true;
    def valid_target_artifacts:
      exact_keys(["api", "console", "worker"])
      and (.api | target_backend("^apex-gtm-api--[a-z0-9][a-z0-9-]{0,62}$"))
      and (.worker | target_backend("^apex-gtm-worker--[a-z0-9][a-z0-9-]{0,62}$"))
      and (.console | target_console)
      and .api.image == .worker.image
      and .api.manifestDigest == .worker.manifestDigest
      and .api.platformDigest == .worker.platformDigest
      and .api.ociRevision == .worker.ociRevision
      and .api.buildRunId == .worker.buildRunId
      and .api.buildEvidenceHash == .worker.buildEvidenceHash
      and .api.rehearsalEvidenceHash == .worker.rehearsalEvidenceHash;
    def valid_source_baseline:
      exact_keys([
        "api", "compatibilityState", "console", "databaseDdlAuthorityEvidence",
        "deliverySafetyEvidence", "operationalSmokeEvidence", "originalAllowlistHash",
        "originalAllowlistNonempty", "privateRestoreBundleHash", "rollbackPermittedUntil",
        "worker"
      ])
      and .compatibilityState == "legacy-readers-no-new-enum-values-v1"
      and .rollbackPermittedUntil == "before-first-clerk-migration-invocation-only"
      and (.originalAllowlistNonempty | type == "boolean")
      and (.originalAllowlistHash | sha256)
      and (.deliverySafetyEvidence | exact_keys([
        "outstandingDeliveryReview", "providerDeliveryDrain", "verifiedFromProtectedBytes"
      ]))
      and .deliverySafetyEvidence.verifiedFromProtectedBytes == true
      and (.deliverySafetyEvidence.outstandingDeliveryReview | exact_keys([
        "disposition", "evidenceHash", "expiresAt", "outstandingDeliveryCount",
        "reviewedAt", "reviewer", "unresolvedDeliveryCount"
      ]))
      and (.deliverySafetyEvidence.outstandingDeliveryReview.evidenceHash | sha256)
      and (.deliverySafetyEvidence.outstandingDeliveryReview.reviewer | principal)
      and (.deliverySafetyEvidence.outstandingDeliveryReview.reviewedAt | ztime)
      and (.deliverySafetyEvidence.outstandingDeliveryReview.expiresAt | ztime)
      and .deliverySafetyEvidence.outstandingDeliveryReview.outstandingDeliveryCount == 0
      and .deliverySafetyEvidence.outstandingDeliveryReview.unresolvedDeliveryCount == 0
      and .deliverySafetyEvidence.outstandingDeliveryReview.disposition == "no-outstanding-deliveries"
      and (.deliverySafetyEvidence.providerDeliveryDrain | exact_keys([
        "drainConfirmed", "evidenceHash", "expiresAt", "inFlightDeliveryCount",
        "providerScope", "reviewedAt", "reviewer"
      ]))
      and (.deliverySafetyEvidence.providerDeliveryDrain.evidenceHash | sha256)
      and (.deliverySafetyEvidence.providerDeliveryDrain.reviewer | principal)
      and (.deliverySafetyEvidence.providerDeliveryDrain.reviewedAt | ztime)
      and (.deliverySafetyEvidence.providerDeliveryDrain.expiresAt | ztime)
      and .deliverySafetyEvidence.providerDeliveryDrain.providerScope == "all-configured-outbound-providers"
      and .deliverySafetyEvidence.providerDeliveryDrain.inFlightDeliveryCount == 0
      and .deliverySafetyEvidence.providerDeliveryDrain.drainConfirmed == true
      and (.databaseDdlAuthorityEvidence | valid_database_ddl_authority)
      and (.operationalSmokeEvidence | exact_keys([
        "dashboardPolicy", "failedList", "verifiedFromProtectedBytes"
      ]))
      and .operationalSmokeEvidence.verifiedFromProtectedBytes == true
      and (.operationalSmokeEvidence.failedList |
        valid_operational_smoke("production-failed-list-smoke"; "api-failed-outreach-list"))
      and (.operationalSmokeEvidence.dashboardPolicy |
        valid_operational_smoke("production-dashboard-policy-smoke"; "console-dashboard-policy"))
      and (.privateRestoreBundleHash | sha256)
      and (.api | source_app("^workforceosprodacr\\.azurecr\\.io/apex-api@sha256:[0-9a-f]{64}$"; "^apex-gtm-api--[a-z0-9][a-z0-9-]{0,62}$"; "workforceosprodacr.azurecr.io/apex-api"))
      and (.worker | source_app("^workforceosprodacr\\.azurecr\\.io/apex-api@sha256:[0-9a-f]{64}$"; "^apex-gtm-worker--[a-z0-9][a-z0-9-]{0,62}$"; "workforceosprodacr.azurecr.io/apex-api"))
      and (.console | source_app("^workforceosprodacr\\.azurecr\\.io/workforceos-fe@sha256:[0-9a-f]{64}$"; "^nikxius-web--[a-z0-9][a-z0-9-]{0,62}$"; "workforceosprodacr.azurecr.io/workforceos-fe"))
      and .api.image == .worker.image
      and .api.manifestDigest == .worker.manifestDigest
      and .api.platformDigest == .worker.platformDigest
      and .api.ociRevision == .worker.ociRevision;
    def valid_quiesced_state:
      exact_keys([
        "api", "evidenceHash", "inventory", "liveSendAllowlistEmpty",
        "orphanRecovery", "privateRestoreBundleHash", "queueObservations", "worker", "writerFence"
      ])
      and (.api | exact_keys(["activeRevisionCount", "ingressDisabled", "replicaCount", "stopped"]))
      and .api.stopped == true
      and .api.activeRevisionCount == 1
      and .api.replicaCount == 0
      and .api.ingressDisabled == true
      and (.worker | exact_keys(["activeRevisionCount", "consumersDisabled", "replicaCount", "stopped"]))
      and .worker.stopped == true
      and .worker.activeRevisionCount == 1
      and .worker.replicaCount == 0
      and .worker.consumersDisabled == true
      and (.queueObservations | type == "array" and length == 2)
      and (.queueObservations[0] | queue_observation)
      and (.queueObservations[1] | queue_observation)
      and .queueObservations[0].queues == .queueObservations[1].queues
      and (.writerFence | exact_keys([
        "activeComplianceWriters", "activeWriters", "generation", "observedAt",
        "schemaVersion", "state", "stateHash", "target", "writerZero"
      ]))
      and .writerFence.schemaVersion == 1
      and .writerFence.target == "workforce-os-production"
      and (.writerFence.observedAt | ztime)
      and (.writerFence.generation | type == "number" and floor == . and . >= 1)
      and (.writerFence.state | exact_keys([
        "bootstrapAttemptId", "expiresAt", "generation", "issuedAt", "mode",
        "schemaVersion", "target"
      ]))
      and .writerFence.state.schemaVersion == 1
      and .writerFence.state.target == "workforce-os-production"
      and .writerFence.state.mode == "closed"
      and (.writerFence.state.bootstrapAttemptId | type == "string" and test("^[0-9a-f]{32}$"))
      and (.writerFence.state.generation | type == "number" and floor == . and . >= 1)
      and (.writerFence.state.issuedAt | ztime)
      and (.writerFence.state.expiresAt | ztime)
      and (.writerFence.stateHash | sha256)
      and .writerFence.activeWriters == 0
      and .writerFence.activeComplianceWriters == 0
      and .writerFence.writerZero == true
      and (.orphanRecovery | exact_keys([
        "bootstrapAttemptId", "generation", "post", "pre", "recoveredAt",
        "schemaVersion", "stableZeroEvidenceHash", "target"
      ]))
      and .orphanRecovery.schemaVersion == 1
      and .orphanRecovery.target == "workforce-os-production"
      and (.orphanRecovery.bootstrapAttemptId | type == "string" and test("^[0-9a-f]{32}$"))
      and (.orphanRecovery.generation | nonnegative)
      and (.orphanRecovery.recoveredAt | ztime)
      and (.orphanRecovery.stableZeroEvidenceHash | sha256)
      and (.orphanRecovery.pre | exact_keys([
        "activeApplicationWriters", "activeComplianceWriters", "tokenSetHash",
        "uncertainApplicationWriters", "uncertainComplianceWriters"
      ]))
      and (.orphanRecovery.post | exact_keys([
        "activeApplicationWriters", "activeComplianceWriters", "tokenSetHash",
        "uncertainApplicationWriters", "uncertainComplianceWriters"
      ]))
      and all([
        .orphanRecovery.pre.activeApplicationWriters,
        .orphanRecovery.pre.activeComplianceWriters,
        .orphanRecovery.pre.uncertainApplicationWriters,
        .orphanRecovery.pre.uncertainComplianceWriters
      ][]; nonnegative)
      and (.orphanRecovery.pre.tokenSetHash | sha256)
      and .orphanRecovery.post.activeApplicationWriters == 0
      and .orphanRecovery.post.activeComplianceWriters == 0
      and .orphanRecovery.post.uncertainApplicationWriters == 0
      and .orphanRecovery.post.uncertainComplianceWriters == 0
      and (.orphanRecovery.post.tokenSetHash | sha256)
      and (.inventory | exact_keys([
        "clerkActiveMembershipCount", "clerkActiveOrganizationCount",
        "clerkActiveUserCount", "clerkCutoverReady", "clerkCutoverRowCount",
        "clerkExpectedActiveMembershipCount", "clerkExpectedActiveOrganizationCount",
        "clerkExpectedActiveUserCount", "clerkIdentitySchemaReady",
        "clerkInventoryEvidenceHash", "clerkMinimumEventVersion",
        "clerkOrphanActiveAuthorityRows", "clerkProjectionMismatchRows",
        "clerkReadinessViolationCount", "databaseIdentityHash",
        "duplicateInventoryEvidenceHash",
        "firstClassDeliveryUnknownRows", "firstClassFailedRows",
        "graphActiveOrgDuplicateGroups", "graphActiveWithoutRecoveryStateRows",
        "graphLifecycleSchemaReady", "graphRunAwaitingApprovalRows",
        "graphRunRunningRows", "legacyAutoFailedMarkerRows",
        "legacyDeliveryUnknownMarkerRows", "legacyGmailReplySequenceStopRows",
        "managerRoleRows", "nullSourceReplyRows",
        "outreachIdempotencyDuplicateGroups", "replyConversationDuplicateGroups",
        "replySchemaReady", "replySlotDuplicateRows", "replySourceDuplicateGroups",
        "sendingRows"
      ]))
      and (.inventory.databaseIdentityHash | sha256)
      and .inventory.sendingRows == 0
      and .inventory.firstClassDeliveryUnknownRows == 0
      and .inventory.legacyDeliveryUnknownMarkerRows == 0
      and .inventory.firstClassFailedRows == 0
      and (.inventory.legacyAutoFailedMarkerRows | nonnegative)
      and .inventory.outreachIdempotencyDuplicateGroups == 0
      and (.inventory.legacyGmailReplySequenceStopRows | nonnegative)
      and .inventory.managerRoleRows == 0
      and .inventory.graphRunRunningRows == 0
      and (.inventory.graphRunAwaitingApprovalRows | nonnegative)
      and .inventory.graphActiveOrgDuplicateGroups == 0
      and .inventory.graphActiveWithoutRecoveryStateRows == 0
      and .inventory.graphLifecycleSchemaReady == false
      and (.inventory.replySchemaReady | type == "boolean")
      and (
        if .inventory.replySchemaReady
        then
          .inventory.replySourceDuplicateGroups == 0
          and .inventory.replyConversationDuplicateGroups == 0
          and .inventory.nullSourceReplyRows == 0
          and .inventory.replySlotDuplicateRows == 0
        else
          .inventory.replySourceDuplicateGroups == null
          and .inventory.replyConversationDuplicateGroups == null
          and .inventory.nullSourceReplyRows == null
          and .inventory.replySlotDuplicateRows == null
        end
      )
      and (.inventory.duplicateInventoryEvidenceHash | sha256)
      and .inventory.clerkIdentitySchemaReady == false
      and .inventory.clerkCutoverRowCount == null
      and .inventory.clerkCutoverReady == null
      and .inventory.clerkMinimumEventVersion == null
      and .inventory.clerkInventoryEvidenceHash == null
      and .inventory.clerkExpectedActiveOrganizationCount == null
      and .inventory.clerkExpectedActiveMembershipCount == null
      and .inventory.clerkExpectedActiveUserCount == null
      and .inventory.clerkActiveOrganizationCount == null
      and .inventory.clerkActiveMembershipCount == null
      and .inventory.clerkActiveUserCount == null
      and .inventory.clerkProjectionMismatchRows == null
      and .inventory.clerkOrphanActiveAuthorityRows == null
      and .inventory.clerkReadinessViolationCount == null
      and .liveSendAllowlistEmpty == true
      and (.privateRestoreBundleHash | sha256)
      and (.evidenceHash | sha256);

    (keys == [
      "admissionContextHash", "approver", "authority", "authorizationScope", "backendCandidateCommit",
      "bootstrapAttemptId", "changeTicket", "clerkReconciliationPlan", "consoleCandidateCommit",
      "databaseIdentityHash", "environment", "expiresAt", "kind", "lease",
      "migrations", "operator", "preparedAt", "quiescedState",
      "redisIdentityHash", "releaseLock", "schemaVersion",
      "sourceRollbackBaseline", "status", "targetArtifacts"
    ])
    and .schemaVersion == 2
    and .environment == "production"
    and .kind == "initial-bootstrap-entry"
    and .authorizationScope == "bootstrap-entry-admission-only"
    and .bootstrapAttemptId == $attempt_id
    and .backendCandidateCommit == $backend_commit
    and .consoleCandidateCommit == $console_commit
    and .status == "prepared-and-quiesced"
    and (.preparedAt | ztime)
    and (.expiresAt | ztime)
    and (.operator | principal)
    and (.approver | principal)
    and .operator != .approver
    and (.changeTicket | type == "string" and length >= 1 and length <= 256)
    and .admissionContextHash == $context_hash
    and (.authority | valid_authority)
    and (.releaseLock | valid_release_lock)
    and .releaseLock.objectSha == $backend_commit
    and (.redisIdentityHash | sha256)
    and (.databaseIdentityHash | sha256)
    and (.lease | valid_lease)
    and (.targetArtifacts | valid_target_artifacts)
    and (.clerkReconciliationPlan | valid_clerk_reconciliation_plan)
    and .clerkReconciliationPlan.approver == .approver
    and .targetArtifacts.api.ociRevision == $backend_commit
    and .targetArtifacts.worker.ociRevision == $backend_commit
    and .targetArtifacts.console.ociRevision == $console_commit
    and (.sourceRollbackBaseline | valid_source_baseline)
    and .sourceRollbackBaseline.deliverySafetyEvidence.outstandingDeliveryReview.reviewer == .approver
    and .sourceRollbackBaseline.deliverySafetyEvidence.providerDeliveryDrain.reviewer == .approver
    and .sourceRollbackBaseline.databaseDdlAuthorityEvidence.bootstrapAttemptId == .bootstrapAttemptId
    and .sourceRollbackBaseline.databaseDdlAuthorityEvidence.backendCandidateCommit == .backendCandidateCommit
    and .sourceRollbackBaseline.databaseDdlAuthorityEvidence.databaseIdentityHash == .databaseIdentityHash
    and .sourceRollbackBaseline.databaseDdlAuthorityEvidence.reviewer == .approver
    and .sourceRollbackBaseline.operationalSmokeEvidence.failedList.bootstrapAttemptId == .bootstrapAttemptId
    and .sourceRollbackBaseline.operationalSmokeEvidence.failedList.backendCandidateCommit == .backendCandidateCommit
    and .sourceRollbackBaseline.operationalSmokeEvidence.failedList.consoleCandidateCommit == .consoleCandidateCommit
    and .sourceRollbackBaseline.operationalSmokeEvidence.failedList.reviewer == .approver
    and .sourceRollbackBaseline.operationalSmokeEvidence.dashboardPolicy.bootstrapAttemptId == .bootstrapAttemptId
    and .sourceRollbackBaseline.operationalSmokeEvidence.dashboardPolicy.backendCandidateCommit == .backendCandidateCommit
    and .sourceRollbackBaseline.operationalSmokeEvidence.dashboardPolicy.consoleCandidateCommit == .consoleCandidateCommit
    and .sourceRollbackBaseline.operationalSmokeEvidence.dashboardPolicy.reviewer == .approver
    and (.quiescedState | valid_quiesced_state)
    and .quiescedState.writerFence.state.bootstrapAttemptId == $attempt_id
    and .quiescedState.orphanRecovery.bootstrapAttemptId == $attempt_id
    and (.quiescedState.orphanRecovery.generation == 0 or
      .quiescedState.orphanRecovery.generation == .lease.generation)
    and .quiescedState.writerFence.generation == .lease.generation
    and .quiescedState.writerFence.state.generation == .lease.generation
    and .quiescedState.inventory.databaseIdentityHash == .databaseIdentityHash
    and .sourceRollbackBaseline.privateRestoreBundleHash == .quiescedState.privateRestoreBundleHash
    and (.migrations | type == "array" and length == $migration_count)
    and all(.migrations[];
      (keys == ["path", "sha256", "writerPause", "writerScopes"])
      and (.path | type == "string" and length > 0)
      and (.sha256 | sha256)
      and (.writerPause == "observed" or .writerPause == "not-required")
      and (.writerScopes | type == "array" and all(.[]; type == "string" and length > 0))
    )
    and ($context | length == 1)
    and ($context[0] | exact_keys([
      "authority", "backendCandidateCommit", "bootstrapAttemptId",
      "clerkReconciliationPlan", "consoleCandidateCommit", "databaseIdentityHash", "environment",
      "generatedBy", "kind", "lease", "quiescedState", "redisIdentityHash",
      "releaseLock", "schemaVersion", "sourceRollbackBaseline", "targetArtifacts"
    ]))
    and $context[0].schemaVersion == 1
    and $context[0].environment == "production"
    and $context[0].kind == "initial-bootstrap-admission-context"
    and $context[0].generatedBy == "workforce-production-bootstrap-controller-v1"
    and $context[0].bootstrapAttemptId == $attempt_id
    and $context[0].backendCandidateCommit == $backend_commit
    and $context[0].consoleCandidateCommit == $console_commit
    and .authority == $context[0].authority
    and .releaseLock == $context[0].releaseLock
    and .redisIdentityHash == $context[0].redisIdentityHash
    and .databaseIdentityHash == $context[0].databaseIdentityHash
    and .lease == $context[0].lease
    and .targetArtifacts == $context[0].targetArtifacts
    and .clerkReconciliationPlan == $context[0].clerkReconciliationPlan
    and .sourceRollbackBaseline == $context[0].sourceRollbackBaseline
    and .quiescedState == $context[0].quiescedState
  ' "${RECEIPT_COPY}" >/dev/null; then
  echo "ERROR: bootstrap entry receipt or controller context is invalid or mismatched" >&2
  exit 1
fi

if ! RECEIPT_TIMES="$(jq -er '[
    (.preparedAt | fromdateiso8601),
    (.expiresAt | fromdateiso8601),
    (.clerkReconciliationPlan.verifiedAt | fromdateiso8601),
    (.clerkReconciliationPlan.expiresAt | fromdateiso8601),
    .clerkReconciliationPlan.minimumEventVersion,
    (.lease.observedAt | fromdateiso8601),
    (.lease.expiresAt | fromdateiso8601),
    (.quiescedState.queueObservations[0].stableSince | fromdateiso8601),
    (.quiescedState.queueObservations[0].observedAt | fromdateiso8601),
    (.quiescedState.queueObservations[1].stableSince | fromdateiso8601),
    (.quiescedState.queueObservations[1].observedAt | fromdateiso8601),
    (.quiescedState.writerFence.observedAt | fromdateiso8601),
    (.quiescedState.writerFence.state.issuedAt | fromdateiso8601),
    (.quiescedState.writerFence.state.expiresAt | fromdateiso8601),
    (.quiescedState.orphanRecovery.recoveredAt | fromdateiso8601),
    (.sourceRollbackBaseline.deliverySafetyEvidence.outstandingDeliveryReview.reviewedAt | fromdateiso8601),
    (.sourceRollbackBaseline.deliverySafetyEvidence.outstandingDeliveryReview.expiresAt | fromdateiso8601),
    (.sourceRollbackBaseline.deliverySafetyEvidence.providerDeliveryDrain.reviewedAt | fromdateiso8601),
    (.sourceRollbackBaseline.deliverySafetyEvidence.providerDeliveryDrain.expiresAt | fromdateiso8601),
    (.sourceRollbackBaseline.databaseDdlAuthorityEvidence.reviewedAt | fromdateiso8601),
    (.sourceRollbackBaseline.databaseDdlAuthorityEvidence.expiresAt | fromdateiso8601),
    (.sourceRollbackBaseline.operationalSmokeEvidence.failedList.reviewedAt | fromdateiso8601),
    (.sourceRollbackBaseline.operationalSmokeEvidence.failedList.expiresAt | fromdateiso8601),
    (.sourceRollbackBaseline.operationalSmokeEvidence.dashboardPolicy.reviewedAt | fromdateiso8601),
    (.sourceRollbackBaseline.operationalSmokeEvidence.dashboardPolicy.expiresAt | fromdateiso8601)
  ] | @tsv' "${RECEIPT_COPY}")"; then
  echo "ERROR: bootstrap entry receipt timestamps are invalid" >&2
  exit 1
fi
IFS="$(printf '\t')" read -r \
  PREPARED_AT_EPOCH EXPIRES_AT_EPOCH \
  PLAN_VERIFIED_AT_EPOCH PLAN_EXPIRES_AT_EPOCH PLAN_MINIMUM_EVENT_VERSION \
  LEASE_OBSERVED_AT_EPOCH LEASE_EXPIRES_AT_EPOCH FIRST_QUEUE_STABLE_SINCE_EPOCH \
  FIRST_QUEUE_OBSERVED_AT_EPOCH SECOND_QUEUE_STABLE_SINCE_EPOCH \
  SECOND_QUEUE_OBSERVED_AT_EPOCH WRITER_FENCE_OBSERVED_AT_EPOCH \
  WRITER_FENCE_ISSUED_AT_EPOCH WRITER_FENCE_EXPIRES_AT_EPOCH \
  ORPHAN_RECOVERY_AT_EPOCH OUTSTANDING_REVIEWED_AT_EPOCH OUTSTANDING_EXPIRES_AT_EPOCH \
  PROVIDER_REVIEWED_AT_EPOCH PROVIDER_EXPIRES_AT_EPOCH \
  DATABASE_DDL_REVIEWED_AT_EPOCH DATABASE_DDL_EXPIRES_AT_EPOCH \
  FAILED_LIST_SMOKE_REVIEWED_AT_EPOCH FAILED_LIST_SMOKE_EXPIRES_AT_EPOCH \
  DASHBOARD_SMOKE_REVIEWED_AT_EPOCH DASHBOARD_SMOKE_EXPIRES_AT_EPOCH <<EOF
${RECEIPT_TIMES}
EOF

receipt_is_fresh_at() {
  local current_epoch=$1
  if [[ ! "${PREPARED_AT_EPOCH}" =~ ^[0-9]+$ ]] ||
    [[ ! "${EXPIRES_AT_EPOCH}" =~ ^[0-9]+$ ]] ||
    [[ ! "${PLAN_VERIFIED_AT_EPOCH}" =~ ^[0-9]+$ ]] ||
    [[ ! "${PLAN_EXPIRES_AT_EPOCH}" =~ ^[0-9]+$ ]] ||
    [[ ! "${PLAN_MINIMUM_EVENT_VERSION}" =~ ^[0-9]+$ ]] ||
    [[ ! "${LEASE_OBSERVED_AT_EPOCH}" =~ ^[0-9]+$ ]] ||
    [[ ! "${LEASE_EXPIRES_AT_EPOCH}" =~ ^[0-9]+$ ]] ||
    [[ ! "${FIRST_QUEUE_STABLE_SINCE_EPOCH}" =~ ^[0-9]+$ ]] ||
    [[ ! "${FIRST_QUEUE_OBSERVED_AT_EPOCH}" =~ ^[0-9]+$ ]] ||
    [[ ! "${SECOND_QUEUE_STABLE_SINCE_EPOCH}" =~ ^[0-9]+$ ]] ||
    [[ ! "${SECOND_QUEUE_OBSERVED_AT_EPOCH}" =~ ^[0-9]+$ ]] ||
    [[ ! "${WRITER_FENCE_OBSERVED_AT_EPOCH}" =~ ^[0-9]+$ ]] ||
    [[ ! "${WRITER_FENCE_ISSUED_AT_EPOCH}" =~ ^[0-9]+$ ]] ||
    [[ ! "${WRITER_FENCE_EXPIRES_AT_EPOCH}" =~ ^[0-9]+$ ]] ||
    [[ ! "${ORPHAN_RECOVERY_AT_EPOCH}" =~ ^[0-9]+$ ]] ||
    [[ ! "${OUTSTANDING_REVIEWED_AT_EPOCH}" =~ ^[0-9]+$ ]] ||
    [[ ! "${OUTSTANDING_EXPIRES_AT_EPOCH}" =~ ^[0-9]+$ ]] ||
    [[ ! "${PROVIDER_REVIEWED_AT_EPOCH}" =~ ^[0-9]+$ ]] ||
    [[ ! "${PROVIDER_EXPIRES_AT_EPOCH}" =~ ^[0-9]+$ ]] ||
    [[ ! "${DATABASE_DDL_REVIEWED_AT_EPOCH}" =~ ^[0-9]+$ ]] ||
    [[ ! "${DATABASE_DDL_EXPIRES_AT_EPOCH}" =~ ^[0-9]+$ ]] ||
    [[ ! "${FAILED_LIST_SMOKE_REVIEWED_AT_EPOCH}" =~ ^[0-9]+$ ]] ||
    [[ ! "${FAILED_LIST_SMOKE_EXPIRES_AT_EPOCH}" =~ ^[0-9]+$ ]] ||
    [[ ! "${DASHBOARD_SMOKE_REVIEWED_AT_EPOCH}" =~ ^[0-9]+$ ]] ||
    [[ ! "${DASHBOARD_SMOKE_EXPIRES_AT_EPOCH}" =~ ^[0-9]+$ ]] ||
    [[ ! "${current_epoch}" =~ ^[0-9]+$ ]] ||
    ((EXPIRES_AT_EPOCH <= PREPARED_AT_EPOCH)) ||
    ((EXPIRES_AT_EPOCH - PREPARED_AT_EPOCH > RECEIPT_MAX_LIFETIME_SECONDS)) ||
    ((PLAN_EXPIRES_AT_EPOCH <= PLAN_VERIFIED_AT_EPOCH)) ||
    ((PLAN_EXPIRES_AT_EPOCH - PLAN_VERIFIED_AT_EPOCH > CLERK_PLAN_MAX_LIFETIME_SECONDS)) ||
    ((PLAN_VERIFIED_AT_EPOCH > PREPARED_AT_EPOCH)) ||
    ((PREPARED_AT_EPOCH >= PLAN_EXPIRES_AT_EPOCH)) ||
    ((EXPIRES_AT_EPOCH > PLAN_EXPIRES_AT_EPOCH)) ||
    ((PLAN_MINIMUM_EVENT_VERSION > PLAN_VERIFIED_AT_EPOCH * 1000)) ||
    ((PLAN_VERIFIED_AT_EPOCH * 1000 - PLAN_MINIMUM_EVENT_VERSION > CLERK_PLAN_MAX_LIFETIME_SECONDS * 1000)) ||
    ((PREPARED_AT_EPOCH > current_epoch)) ||
    ((current_epoch >= EXPIRES_AT_EPOCH)) ||
    ((LEASE_OBSERVED_AT_EPOCH > PREPARED_AT_EPOCH)) ||
    ((LEASE_EXPIRES_AT_EPOCH < EXPIRES_AT_EPOCH)) ||
    ((LEASE_EXPIRES_AT_EPOCH <= LEASE_OBSERVED_AT_EPOCH)) ||
    ((FIRST_QUEUE_STABLE_SINCE_EPOCH > FIRST_QUEUE_OBSERVED_AT_EPOCH)) ||
    ((SECOND_QUEUE_STABLE_SINCE_EPOCH > SECOND_QUEUE_OBSERVED_AT_EPOCH)) ||
    ((SECOND_QUEUE_OBSERVED_AT_EPOCH - FIRST_QUEUE_OBSERVED_AT_EPOCH < QUEUE_STABILITY_INTERVAL_SECONDS)) ||
    ((SECOND_QUEUE_OBSERVED_AT_EPOCH > WRITER_FENCE_OBSERVED_AT_EPOCH)) ||
    ((ORPHAN_RECOVERY_AT_EPOCH > FIRST_QUEUE_OBSERVED_AT_EPOCH)) ||
    ((ORPHAN_RECOVERY_AT_EPOCH > WRITER_FENCE_OBSERVED_AT_EPOCH)) ||
    ((OUTSTANDING_EXPIRES_AT_EPOCH <= OUTSTANDING_REVIEWED_AT_EPOCH)) ||
    ((OUTSTANDING_EXPIRES_AT_EPOCH - OUTSTANDING_REVIEWED_AT_EPOCH > DELIVERY_EVIDENCE_MAX_LIFETIME_SECONDS)) ||
    ((OUTSTANDING_REVIEWED_AT_EPOCH > PREPARED_AT_EPOCH)) ||
    ((OUTSTANDING_EXPIRES_AT_EPOCH < EXPIRES_AT_EPOCH)) ||
    ((PROVIDER_EXPIRES_AT_EPOCH <= PROVIDER_REVIEWED_AT_EPOCH)) ||
    ((PROVIDER_EXPIRES_AT_EPOCH - PROVIDER_REVIEWED_AT_EPOCH > DELIVERY_EVIDENCE_MAX_LIFETIME_SECONDS)) ||
    ((PROVIDER_REVIEWED_AT_EPOCH > PREPARED_AT_EPOCH)) ||
    ((PROVIDER_EXPIRES_AT_EPOCH < EXPIRES_AT_EPOCH)) ||
    ((DATABASE_DDL_EXPIRES_AT_EPOCH <= DATABASE_DDL_REVIEWED_AT_EPOCH)) ||
    ((DATABASE_DDL_EXPIRES_AT_EPOCH - DATABASE_DDL_REVIEWED_AT_EPOCH > DELIVERY_EVIDENCE_MAX_LIFETIME_SECONDS)) ||
    ((DATABASE_DDL_REVIEWED_AT_EPOCH > PREPARED_AT_EPOCH)) ||
    ((DATABASE_DDL_EXPIRES_AT_EPOCH < EXPIRES_AT_EPOCH)) ||
    ((FAILED_LIST_SMOKE_EXPIRES_AT_EPOCH <= FAILED_LIST_SMOKE_REVIEWED_AT_EPOCH)) ||
    ((FAILED_LIST_SMOKE_EXPIRES_AT_EPOCH - FAILED_LIST_SMOKE_REVIEWED_AT_EPOCH > DELIVERY_EVIDENCE_MAX_LIFETIME_SECONDS)) ||
    ((FAILED_LIST_SMOKE_REVIEWED_AT_EPOCH > PREPARED_AT_EPOCH)) ||
    ((FAILED_LIST_SMOKE_EXPIRES_AT_EPOCH < EXPIRES_AT_EPOCH)) ||
    ((DASHBOARD_SMOKE_EXPIRES_AT_EPOCH <= DASHBOARD_SMOKE_REVIEWED_AT_EPOCH)) ||
    ((DASHBOARD_SMOKE_EXPIRES_AT_EPOCH - DASHBOARD_SMOKE_REVIEWED_AT_EPOCH > DELIVERY_EVIDENCE_MAX_LIFETIME_SECONDS)) ||
    ((DASHBOARD_SMOKE_REVIEWED_AT_EPOCH > PREPARED_AT_EPOCH)) ||
    ((DASHBOARD_SMOKE_EXPIRES_AT_EPOCH < EXPIRES_AT_EPOCH)) ||
    ((WRITER_FENCE_ISSUED_AT_EPOCH > WRITER_FENCE_OBSERVED_AT_EPOCH)) ||
    ((WRITER_FENCE_OBSERVED_AT_EPOCH > PREPARED_AT_EPOCH)) ||
    ((WRITER_FENCE_EXPIRES_AT_EPOCH < EXPIRES_AT_EPOCH)) ||
    ((WRITER_FENCE_EXPIRES_AT_EPOCH <= WRITER_FENCE_OBSERVED_AT_EPOCH)); then
    return 1
  fi
}

CURRENT_EPOCH="$(date -u +%s)"
if ! receipt_is_fresh_at "${CURRENT_EPOCH}"; then
  echo "ERROR: bootstrap entry receipt, lease, or stable observations are stale or inconsistent" >&2
  exit 1
fi

APPROVER="$(jq -er '.approver' "${RECEIPT_COPY}")"
if ! ssh-keygen -Y verify \
  -f "${TRUST_ROOT_COPY}" \
  -I "${APPROVER}" \
  -n "${SIGNATURE_NAMESPACE}" \
  -s "${SIGNATURE_COPY}" \
  <"${RECEIPT_COPY}" >/dev/null; then
  echo "ERROR: bootstrap entry receipt signature is invalid for trusted approver ${APPROVER}" >&2
  exit 1
fi

# Migration bytes always come from the exact expected backend commit. The
# schema file contains review pins; these executable checks remain authoritative
# if an attacker changes worktree bytes.
for index in "${!MIGRATIONS[@]}"; do
  path="${MIGRATIONS[$index]}"
  pause="${WRITER_PAUSE[$index]}"
  scopes="${WRITER_SCOPES[$index]}"
  if ! source_digest="$(read_reviewed_source "${path}" | \
    openssl dgst -sha256 -r | awk '{ print $1 }')"; then
    echo "ERROR: required bootstrap migration is missing from ${EXPECTED_BACKEND_COMMIT}: ${path}" >&2
    exit 1
  fi
  if [[ ! "${source_digest}" =~ ^[0-9a-f]{64}$ ]]; then
    echo "ERROR: could not hash committed bootstrap migration ${path}" >&2
    exit 1
  fi
  if ! jq -e \
    --argjson index "${index}" \
    --arg path "${path}" \
    --arg hash "sha256:${source_digest}" \
    --arg pause "${pause}" \
    --argjson scopes "${scopes}" '
      .migrations[$index]
      | (keys == ["path", "sha256", "writerPause", "writerScopes"])
      and .path == $path
      and .sha256 == $hash
      and .writerPause == $pause
      and .writerScopes == $scopes
    ' "${RECEIPT_COPY}" >/dev/null; then
    echo "ERROR: bootstrap entry migration ${index} does not match ${path}" >&2
    exit 1
  fi
done

# Signature verification and committed-source hashing can cross the expiry
# boundary. Reapply every temporal invariant immediately before success.
FINAL_CURRENT_EPOCH="$(date -u +%s)"
if ! receipt_is_fresh_at "${FINAL_CURRENT_EPOCH}"; then
  echo "ERROR: bootstrap entry receipt or lease expired before verification completed" >&2
  exit 1
fi

echo "Signed production bootstrap entry receipt verified for backend ${EXPECTED_BACKEND_COMMIT}, console ${EXPECTED_CONSOLE_COMMIT}, attempt ${EXPECTED_ATTEMPT_ID} (${EXPECTED_MIGRATION_COUNT} ordered migrations; approver ${APPROVER})"
