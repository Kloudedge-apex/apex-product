#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
SOURCE_VERIFIER="${REPO_ROOT}/scripts/verify-production-bootstrap-phase-receipt.sh"
CONTRACT_MODULE="${REPO_ROOT}/scripts/production-bootstrap-phase-receipt-contracts.mjs"
FIXTURE_GENERATOR="${REPO_ROOT}/scripts/tests/production-bootstrap-phase-receipt.fixture.mjs"
RECEIPT_SCHEMA="${REPO_ROOT}/docs/ops/production-bootstrap-phase-receipt.schema.json"
CONTEXT_SCHEMA="${REPO_ROOT}/docs/ops/production-bootstrap-phase-context.schema.json"
TESTS_PASSED=0

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

pass() {
  TESTS_PASSED=$((TESTS_PASSED + 1))
}

file_hash() {
  openssl dgst -sha256 -r "$1" | awk '{ print "sha256:" $1 }'
}

namespace_for() {
  case "$1" in
    production-schema-result) echo "workforce-os-production-schema-result" ;;
    enum-aware-disabled-baseline) echo "workforce-os-enum-aware-disabled-baseline" ;;
    first-class-activation) echo "workforce-os-first-class-activation" ;;
    bootstrap-complete) echo "workforce-os-bootstrap-complete" ;;
    *) fail "unknown receipt kind: $1" ;;
  esac
}

previous_for() {
  case "$1" in
    production-schema-result) echo "${EVIDENCE}/entry.json" ;;
    enum-aware-disabled-baseline) echo "${EVIDENCE}/production-schema-result.json" ;;
    first-class-activation) echo "${EVIDENCE}/enum-aware-disabled-baseline.json" ;;
    bootstrap-complete) echo "${EVIDENCE}/first-class-activation.json" ;;
    *) fail "unknown receipt kind: $1" ;;
  esac
}

sign_receipt() {
  local receipt=$1
  local kind=$2
  local key=${3:-${HARNESS}/approver-key}
  local namespace=${4:-$(namespace_for "${kind}")}
  rm -f -- "${receipt}.sig"
  ssh-keygen -Y sign -f "${key}" -n "${namespace}" "${receipt}" >/dev/null 2>&1
}

run_verifier() {
  local receipt=$1
  local signature=$2
  local kind=$3
  local previous=$4
  local context=$5
  local signers=${6:-${HARNESS}/allowed-signers}
  local backend=${7:-${BACKEND_COMMIT}}
  local console=${8:-${CONSOLE_COMMIT}}
  local attempt=${9:-${ATTEMPT_ID}}
  "${VERIFIER}" "${receipt}" "${signature}" "${signers}" \
    "${backend}" "${console}" "${attempt}" "${kind}" "${previous}" "${context}"
}

expect_rejected() {
  local description=$1
  shift
  if run_verifier "$@" >/dev/null 2>&1; then
    fail "verifier accepted ${description}"
  fi
  pass
}

make_bound_variant() {
  local name=$1
  local kind=$2
  local receipt_filter=$3
  local context_filter=${4:-${receipt_filter}}
  local context_hash
  VARIANT_RECEIPT="${HARNESS}/${name}.json"
  VARIANT_CONTEXT="${HARNESS}/${name}.context.json"
  jq "${context_filter}" "${EVIDENCE}/${kind}.context.json" >"${VARIANT_CONTEXT}"
  jq "${receipt_filter}" "${EVIDENCE}/${kind}.json" >"${HARNESS}/${name}.draft.json"
  context_hash="$(file_hash "${VARIANT_CONTEXT}")"
  jq --arg hash "${context_hash}" '.phaseContextHash = $hash' \
    "${HARNESS}/${name}.draft.json" >"${VARIANT_RECEIPT}"
  rm -f -- "${HARNESS}/${name}.draft.json"
  sign_receipt "${VARIANT_RECEIPT}" "${kind}"
}

bound_reject() {
  local kind=$1
  local name=$2
  local filter=$3
  local description=$4
  make_bound_variant "${name}" "${kind}" "${filter}"
  expect_rejected "${description}" \
    "${VARIANT_RECEIPT}" "${VARIANT_RECEIPT}.sig" "${kind}" \
    "$(previous_for "${kind}")" "${VARIANT_CONTEXT}"
}

for required_command in date git jq node openssl sed ssh-keygen wc; do
  command -v "${required_command}" >/dev/null 2>&1 ||
    fail "required test command is unavailable: ${required_command}"
done

HARNESS="$(mktemp -d "${TMPDIR:-/tmp}/bootstrap-phase-contract.XXXXXX")"
cleanup() {
  rm -rf -- "${HARNESS}"
}
trap cleanup EXIT

FIXTURE_REPO="${HARNESS}/repo"
EVIDENCE="${HARNESS}/evidence"
mkdir -p "${FIXTURE_REPO}/scripts" "${FIXTURE_REPO}/docs/ops" "${EVIDENCE}"
cp "${SOURCE_VERIFIER}" "${FIXTURE_REPO}/scripts/verify-production-bootstrap-phase-receipt.sh"
cp "${CONTRACT_MODULE}" "${FIXTURE_REPO}/scripts/production-bootstrap-phase-receipt-contracts.mjs"
VERIFIER="${FIXTURE_REPO}/scripts/verify-production-bootstrap-phase-receipt.sh"
chmod +x "${VERIFIER}"

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
for path in "${MIGRATIONS[@]}"; do
  mkdir -p "${FIXTURE_REPO}/$(dirname "${path}")"
  cp "${REPO_ROOT}/${path}" "${FIXTURE_REPO}/${path}"
done

ssh-keygen -q -t ed25519 -N '' -f "${HARNESS}/approver-key"
printf 'release.approver %s\n' "$(<"${HARNESS}/approver-key.pub")" \
  >"${HARNESS}/allowed-signers"
openssl dgst -sha256 -r "${HARNESS}/allowed-signers" | awk '{ print $1 }' \
  >"${FIXTURE_REPO}/docs/ops/production-migration-allowed-signers.sha256"

git -C "${FIXTURE_REPO}" init -q
git -C "${FIXTURE_REPO}" config user.name "Bootstrap Phase Receipt Test"
git -C "${FIXTURE_REPO}" config user.email "bootstrap-phase-test@example.invalid"
git -C "${FIXTURE_REPO}" add docs scripts
git -C "${FIXTURE_REPO}" commit -q -m "fixture: phase verifier sources"
BACKEND_COMMIT="$(git -C "${FIXTURE_REPO}" rev-parse HEAD)"
CONSOLE_COMMIT="$(printf '%040d' 0 | tr '0' 'c')"
ATTEMPT_ID="$(printf '%032d' 0 | tr '0' 'a')"
NOW_EPOCH="$(date -u +%s)"

node "${FIXTURE_GENERATOR}" "${EVIDENCE}" "${BACKEND_COMMIT}" \
  "${CONSOLE_COMMIT}" "${NOW_EPOCH}"

KINDS=(
  "production-schema-result"
  "enum-aware-disabled-baseline"
  "first-class-activation"
  "bootstrap-complete"
)
for kind in "${KINDS[@]}"; do
  sign_receipt "${EVIDENCE}/${kind}.json" "${kind}"
  run_verifier \
    "${EVIDENCE}/${kind}.json" "${EVIDENCE}/${kind}.json.sig" "${kind}" \
    "$(previous_for "${kind}")" "${EVIDENCE}/${kind}.context.json" >/dev/null ||
    fail "valid signed ${kind} receipt was rejected"
  pass
done

# The schemas expose four exact phase variants, strict seconds, strict nested
# objects, the signed Clerk plan, and the fail-closed resume compensation.
jq -e '
  .additionalProperties == false
  and (.required | length == 25)
  and (.allOf | length == 4)
  and .["$defs"].utcSecond.pattern == "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"
  and .["$defs"].queueState.properties.workerCount["$ref"] == "#/$defs/nonnegativeInteger"
  and .["$defs"].pausedQueueState.allOf[1].properties.workerCount.const == 0
  and .["$defs"].pausedConnectedQueueState.allOf[1].properties.workerCount["$ref"] == "#/$defs/positiveInteger"
  and .["$defs"].resumedQueueState.allOf[1].properties.workerCount["$ref"] == "#/$defs/positiveInteger"
  and .["$defs"].clerkReconciliationPlan.additionalProperties == false
  and .["$defs"].clerkReconciliationPlan.properties.signatureNamespace.const == "workforce-os-clerk-reconciliation-plan"
  and .["$defs"].completeEvidence.additionalProperties == false
  and (.["$defs"].completeEvidence.properties.health.required |
    index("releaseConfigEvidenceHash") != null)
  and (.["$defs"].completeEvidence.properties.health.required |
    index("failedListSmokeEvidenceHash") != null)
  and (.["$defs"].completeEvidence.properties.health.required |
    index("dashboardPolicySmokeEvidenceHash") != null)
  and .["$defs"].completeEvidence.properties.health.properties.releaseConfigEvidenceHash["$ref"] == "#/$defs/sha256"
  and .["$defs"].completeEvidence.properties.health.properties.failedListSmokeEvidenceHash["$ref"] == "#/$defs/sha256"
  and .["$defs"].completeEvidence.properties.health.properties.dashboardPolicySmokeEvidenceHash["$ref"] == "#/$defs/sha256"
' "${RECEIPT_SCHEMA}" >/dev/null || fail "phase receipt schema is incomplete"
jq -e '
  .additionalProperties == false
  and .properties.generatedBy.const == "workforce-production-bootstrap-controller-v1"
  and (.allOf | length == 4)
  and (.required | length == 17)
' "${CONTEXT_SCHEMA}" >/dev/null || fail "phase context schema is incomplete"
pass

# B4: exact migration execution, admitted private Clerk plan/cutover, disabled
# DELIVERY_UNKNOWN/FAILED gates, post-schema inventories, and closed fence.
bound_reject "production-schema-result" "b4-migration-not-applied" \
  '.evidence.migrationExecution[3].applied = false' "an unapplied B4 migration"
bound_reject "production-schema-result" "b4-plan-drift" \
  '.evidence.clerkReconciliationPlan.rawPlanSha256 = "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"' \
  "Clerk plan drift from the signed entry"
bound_reject "production-schema-result" "b4-cutoff-drift" \
  '.evidence.clerkCutover.minimumEventVersion += 1' "a Clerk cutover cutoff mismatch"
bound_reject "production-schema-result" "b4-count-drift" \
  '.evidence.clerkCutover.expectedActiveUserCount += 1' "a Clerk cutover count mismatch"
bound_reject "production-schema-result" "b4-delivery-gate" \
  '.evidence.deliveryState.deliveryUnknownWriteMode = "first-class"' \
  "DELIVERY_UNKNOWN writes before the two-phase activation"
bound_reject "production-schema-result" "b4-failed-gate" \
  '.evidence.deliveryState.failedStatusWritesEnabled = true' \
  "FAILED writes before the two-phase activation"
bound_reject "production-schema-result" "b4-inventory" \
  '.evidence.schemaInventory.replySlotDuplicateRows = 1' "a nonzero B4 duplicate inventory"
bound_reject "production-schema-result" "b4-connected-consumer" \
  '.evidence.quiescence.queueObservations[0].queues.agentRuns.workerCount = 1
   | .evidence.quiescence.queueObservations[1].queues.agentRuns.workerCount = 1' \
  "a connected B4 consumer while the writer fence is CLOSED"

# B5: immutable API/worker/console provenance, both write gates disabled,
# inactive legacy revisions, and no connected consumers while CLOSED.
bound_reject "enum-aware-disabled-baseline" "b5-worker-gate" \
  '.evidence.writeGates.worker.deliveryUnknownWriteMode = "first-class"' \
  "an armed B5 worker gate"
bound_reject "enum-aware-disabled-baseline" "b5-api-gate" \
  '.evidence.writeGates.api.failedStatusWritesEnabled = true' "an armed B5 API gate"
bound_reject "enum-aware-disabled-baseline" "b5-legacy-active" \
  '.evidence.legacyRevisions.workerActiveLegacyRevisionCount = 1' \
  "an active legacy B5 worker revision"
bound_reject "enum-aware-disabled-baseline" "b5-queue-active" \
  '.evidence.quiescence.queueObservations[0].queues.graphRuns.active = 1
   | .evidence.quiescence.queueObservations[1].queues.graphRuns.active = 1' \
  "an active job in a paused B5 queue"
bound_reject "enum-aware-disabled-baseline" "b5-connected-consumer" \
  '.evidence.quiescence.queueObservations[0].queues.graphRuns.workerCount = 1
   | .evidence.quiescence.queueObservations[1].queues.graphRuns.workerCount = 1' \
  "a connected B5 consumer while the writer fence is CLOSED"
bound_reject "enum-aware-disabled-baseline" "b5-image-drift" \
  '.evidence.deployments.api.identity.manifestDigest = "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"' \
  "mutable or mismatched B5 deployment provenance"

# B6: distinct first-class worker, exact ACKs for both enum transitions,
# rollback floor, drained readers, reviewed legacy FAILED markers, and zeros.
bound_reject "first-class-activation" "b6-same-worker" \
  '.evidence.deployments.worker.identity.revision = "apex-gtm-worker--candidate-a"' \
  "reuse of the disabled worker revision for B6"
bound_reject "first-class-activation" "b6-delivery-ack" \
  '.evidence.writeGates.worker.deliveryUnknownWriteAck = null' \
  "B6 without the DELIVERY_UNKNOWN reader-drain ACK"
bound_reject "first-class-activation" "b6-failed-ack" \
  '.evidence.writeGates.worker.failedStatusWritesAck = null' \
  "B6 without the FAILED legacy-inventory ACK"
bound_reject "first-class-activation" "b6-rollback-active" \
  '.evidence.rollbackBaseline.worker.active = true' "an invalid B6 rollback baseline"
bound_reject "first-class-activation" "b6-reader-active" \
  '.evidence.readerDrain.legacyApiReadersActive = 1' "an undrained B6 legacy reader"
bound_reject "first-class-activation" "b6-unreviewed-failed" \
  '.evidence.failedActivation.unreviewedHistoricalMarkersPromotedRows = 1' \
  "unreviewed historical FAILED markers"
bound_reject "first-class-activation" "b6-first-class-row" \
  '.evidence.deliveryUnknownActivation.firstClassDeliveryUnknownRows = 1' \
  "a first-class DELIVERY_UNKNOWN row before resume"
bound_reject "first-class-activation" "b6-connected-consumer" \
  '.evidence.quiescence.queueObservations[0].queues.outreachSend.workerCount = 1
   | .evidence.quiescence.queueObservations[1].queues.outreachSend.workerCount = 1' \
  "a connected B6 consumer while the writer fence is CLOSED"

# B8: durable terminal OPEN, consumers connected while paused, queue-by-queue
# resume, and API ingress last; ambiguity containment never recloses the epoch.
bound_reject "bootstrap-complete" "b8-order" \
  '.evidence.resume.steps[1].action = "resume-graph-runs"' "an out-of-order B8 resume"
bound_reject "bootstrap-complete" "b8-api-early" \
  '.evidence.resume.apiMutations.restoredAt = .evidence.resume.steps[3].completedAt' \
  "API mutations restored before the final B8 step"
bound_reject "bootstrap-complete" "b8-future-completion" \
  '(.evidence.resume.steps[4].completedAt | fromdateiso8601 + 600 | todateiso8601) as $future
   | .evidence.resume.steps[4].startedAt = $future
   | .evidence.resume.steps[4].completedAt = $future
   | .evidence.resume.apiMutations.restoredAt = $future' \
  "B8 resume evidence after receipt issuance"
bound_reject "bootstrap-complete" "b8-no-worker" \
  '.evidence.resume.queues.outreachSend.workerCount = 0' "a resumed queue without a worker"
bound_reject "bootstrap-complete" "b8-no-paused-worker" \
  '.evidence.resume.pausedConsumerProof.queues.outreachSend.workerCount = 0' \
  "terminal OPEN without a paused connected outreach consumer"
bound_reject "bootstrap-complete" "b8-ambiguity-policy" \
  '.evidence.resume.ambiguityControl.allQueuesRePauseRequired = false' \
  "weakened ambiguous-resume compensation"
bound_reject "bootstrap-complete" "b8-fence-generation" \
  '.evidence.resume.writerFenceRelease.generation -= 1' "release of the wrong fence generation"
bound_reject "bootstrap-complete" "b8-final-inventory" \
  '.evidence.finalInventory.firstClassFailedRows = 1' "a nonzero final FAILED inventory"
bound_reject "bootstrap-complete" "b8-activation-drift" \
  '.evidence.writeGates.worker.failedStatusWritesEnabled = false' \
  "drift from the signed B6 activation state"
bound_reject "bootstrap-complete" "b8-missing-release-config-evidence" \
  'del(.evidence.health.releaseConfigEvidenceHash)' \
  "B8 health without exact release-configuration evidence"
bound_reject "bootstrap-complete" "b8-invalid-failed-list-smoke-evidence" \
  '.evidence.health.failedListSmokeEvidenceHash = "sha256:not-a-hash"' \
  "B8 health with an invalid failed-list smoke evidence hash"
bound_reject "bootstrap-complete" "b8-invalid-dashboard-smoke-evidence" \
  '.evidence.health.dashboardPolicySmokeEvidenceHash = "sha256:not-a-hash"' \
  "B8 health with an invalid dashboard-policy smoke evidence hash"

# Common exact identity, predecessor hash, rollback floor, context producer,
# strict JSON, detached namespace, trust root, and bounded-file controls.
bound_reject "first-class-activation" "wrong-predecessor-hash" \
  '.previousReceiptSha256 = "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"' \
  "a broken exact-byte predecessor hash"
bound_reject "first-class-activation" "rollback-downgrade" \
  '.rollbackPolicy.floor = "enum-aware-disabled"' "a rollback-floor downgrade"
bound_reject "enum-aware-disabled-baseline" "unknown-field" \
  '.evidence.unexpected = true' "an unknown signed evidence field"

make_bound_variant "wrong-context-producer" "enum-aware-disabled-baseline" '.' \
  '.generatedBy = "manual"'
expect_rejected "an untrusted phase-context producer" \
  "${VARIANT_RECEIPT}" "${VARIANT_RECEIPT}.sig" "enum-aware-disabled-baseline" \
  "$(previous_for enum-aware-disabled-baseline)" "${VARIANT_CONTEXT}"

cp "${EVIDENCE}/enum-aware-disabled-baseline.context.json" "${HARNESS}/changed-context.json"
printf '\n' >>"${HARNESS}/changed-context.json"
expect_rejected "changed exact controller-context bytes" \
  "${EVIDENCE}/enum-aware-disabled-baseline.json" \
  "${EVIDENCE}/enum-aware-disabled-baseline.json.sig" "enum-aware-disabled-baseline" \
  "$(previous_for enum-aware-disabled-baseline)" "${HARNESS}/changed-context.json"

sed '1s/^{/{"schemaVersion":1,/' "${EVIDENCE}/first-class-activation.json" \
  >"${HARNESS}/duplicate-receipt.json"
sign_receipt "${HARNESS}/duplicate-receipt.json" "first-class-activation"
expect_rejected "duplicate receipt keys" \
  "${HARNESS}/duplicate-receipt.json" "${HARNESS}/duplicate-receipt.json.sig" \
  "first-class-activation" "$(previous_for first-class-activation)" \
  "${EVIDENCE}/first-class-activation.context.json"

cp "${EVIDENCE}/first-class-activation.json" "${HARNESS}/trailing-receipt.json"
printf 'true\n' >>"${HARNESS}/trailing-receipt.json"
sign_receipt "${HARNESS}/trailing-receipt.json" "first-class-activation"
expect_rejected "a trailing receipt JSON value" \
  "${HARNESS}/trailing-receipt.json" "${HARNESS}/trailing-receipt.json.sig" \
  "first-class-activation" "$(previous_for first-class-activation)" \
  "${EVIDENCE}/first-class-activation.context.json"

sed '1s/^{/{"schemaVersion":1,/' "${EVIDENCE}/first-class-activation.context.json" \
  >"${HARNESS}/duplicate-context.json"
duplicate_context_hash="$(file_hash "${HARNESS}/duplicate-context.json")"
jq --arg hash "${duplicate_context_hash}" '.phaseContextHash = $hash' \
  "${EVIDENCE}/first-class-activation.json" >"${HARNESS}/duplicate-context-receipt.json"
sign_receipt "${HARNESS}/duplicate-context-receipt.json" "first-class-activation"
expect_rejected "duplicate phase-context keys" \
  "${HARNESS}/duplicate-context-receipt.json" \
  "${HARNESS}/duplicate-context-receipt.json.sig" "first-class-activation" \
  "$(previous_for first-class-activation)" "${HARNESS}/duplicate-context.json"

cp "${EVIDENCE}/production-schema-result.json" "${HARNESS}/wrong-namespace.json"
sign_receipt "${HARNESS}/wrong-namespace.json" "production-schema-result" \
  "${HARNESS}/approver-key" "workforce-os-initial-bootstrap-entry"
expect_rejected "a signature from another namespace" \
  "${HARNESS}/wrong-namespace.json" "${HARNESS}/wrong-namespace.json.sig" \
  "production-schema-result" "$(previous_for production-schema-result)" \
  "${EVIDENCE}/production-schema-result.context.json"

ssh-keygen -q -t ed25519 -N '' -f "${HARNESS}/untrusted-key"
cp "${EVIDENCE}/production-schema-result.json" "${HARNESS}/untrusted.json"
sign_receipt "${HARNESS}/untrusted.json" "production-schema-result" "${HARNESS}/untrusted-key"
expect_rejected "an untrusted receipt signer" \
  "${HARNESS}/untrusted.json" "${HARNESS}/untrusted.json.sig" \
  "production-schema-result" "$(previous_for production-schema-result)" \
  "${EVIDENCE}/production-schema-result.context.json"

printf 'release.approver %s\n' "$(<"${HARNESS}/untrusted-key.pub")" \
  >"${HARNESS}/untrusted-signers"
expect_rejected "an unpinned allowed-signers trust root" \
  "${EVIDENCE}/production-schema-result.json" \
  "${EVIDENCE}/production-schema-result.json.sig" "production-schema-result" \
  "$(previous_for production-schema-result)" \
  "${EVIDENCE}/production-schema-result.context.json" "${HARNESS}/untrusted-signers"

expect_rejected "a mismatched expected console commit" \
  "${EVIDENCE}/production-schema-result.json" \
  "${EVIDENCE}/production-schema-result.json.sig" "production-schema-result" \
  "$(previous_for production-schema-result)" \
  "${EVIDENCE}/production-schema-result.context.json" "${HARNESS}/allowed-signers" \
  "${BACKEND_COMMIT}" "$(printf '%040d' 0 | tr '0' 'b')"

dd if=/dev/zero of="${HARNESS}/oversized.json" bs=131073 count=1 2>/dev/null
cp "${EVIDENCE}/first-class-activation.json.sig" "${HARNESS}/oversized.json.sig"
expect_rejected "an oversized phase receipt" \
  "${HARNESS}/oversized.json" "${HARNESS}/oversized.json.sig" \
  "first-class-activation" "$(previous_for first-class-activation)" \
  "${EVIDENCE}/first-class-activation.context.json"

cp "${EVIDENCE}/enum-aware-disabled-baseline.json" "${HARNESS}/tampered.json"
cp "${EVIDENCE}/enum-aware-disabled-baseline.json.sig" "${HARNESS}/tampered.json.sig"
jq '.changeTicket = "changed-after-signing"' "${HARNESS}/tampered.json" \
  >"${HARNESS}/tampered.next"
mv "${HARNESS}/tampered.next" "${HARNESS}/tampered.json"
expect_rejected "receipt bytes changed after signing" \
  "${HARNESS}/tampered.json" "${HARNESS}/tampered.json.sig" \
  "enum-aware-disabled-baseline" "$(previous_for enum-aware-disabled-baseline)" \
  "${EVIDENCE}/enum-aware-disabled-baseline.context.json"

echo "Production bootstrap phase receipt tests passed: ${TESTS_PASSED}"
