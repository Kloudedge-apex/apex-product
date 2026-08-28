#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
SCHEMA="${REPO_ROOT}/docs/ops/production-bootstrap-entry-receipt.schema.json"
SOURCE_VERIFIER="${REPO_ROOT}/scripts/verify-production-bootstrap-entry-receipt.sh"
STRICT_JSON_MODULE="${REPO_ROOT}/scripts/production-bootstrap-phase-receipt-contracts.mjs"
TEMP_DIRS=()
TESTS_PASSED=0

cleanup() {
  local dir
  set +u
  for dir in "${TEMP_DIRS[@]}"; do
    rm -rf -- "${dir}"
  done
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

pass() {
  TESTS_PASSED=$((TESTS_PASSED + 1))
}

repeat_char() {
  local value=$1
  local count=$2
  local result=""
  while [[ ${#result} -lt ${count} ]]; do
    result="${result}${value}"
  done
  printf '%s' "${result}"
}

file_hash() {
  openssl dgst -sha256 -r "$1" | awk '{ print "sha256:" $1 }'
}

for required_command in date git jq node openssl ssh-keygen wc; do
  command -v "${required_command}" >/dev/null 2>&1 ||
    fail "required test command is unavailable: ${required_command}"
done

HARNESS="$(mktemp -d "${TMPDIR:-/tmp}/bootstrap-entry-contract.XXXXXX")"
TEMP_DIRS+=("${HARNESS}")
FIXTURE_REPO="${HARNESS}/repo"
mkdir -p "${FIXTURE_REPO}/scripts" "${FIXTURE_REPO}/docs/ops"
cp "${SOURCE_VERIFIER}" \
  "${FIXTURE_REPO}/scripts/verify-production-bootstrap-entry-receipt.sh"
cp "${STRICT_JSON_MODULE}" \
  "${FIXTURE_REPO}/scripts/production-bootstrap-phase-receipt-contracts.mjs"
VERIFIER="${FIXTURE_REPO}/scripts/verify-production-bootstrap-entry-receipt.sh"
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

for path in "${MIGRATIONS[@]}"; do
  mkdir -p "${FIXTURE_REPO}/$(dirname "${path}")"
  cp "${REPO_ROOT}/${path}" "${FIXTURE_REPO}/${path}"
done

ssh-keygen -q -t ed25519 -N '' -f "${HARNESS}/approver-key"
printf 'bootstrap-approver %s\n' "$(<"${HARNESS}/approver-key.pub")" \
  >"${HARNESS}/allowed-signers"
openssl dgst -sha256 -r "${HARNESS}/allowed-signers" | awk '{ print $1 }' \
  >"${FIXTURE_REPO}/docs/ops/production-migration-allowed-signers.sha256"

git -C "${FIXTURE_REPO}" init -q
git -C "${FIXTURE_REPO}" config user.name "Bootstrap Receipt Test"
git -C "${FIXTURE_REPO}" config user.email "bootstrap-test@example.invalid"
git -C "${FIXTURE_REPO}" add docs scripts
git -C "${FIXTURE_REPO}" commit -q -m "fixture: bootstrap entry sources"
BACKEND_COMMIT="$(git -C "${FIXTURE_REPO}" rev-parse HEAD)"
git -C "${FIXTURE_REPO}" commit -q --allow-empty -m "fixture: alternate identity"
ALTERNATE_BACKEND_COMMIT="$(git -C "${FIXTURE_REPO}" rev-parse HEAD)"

CONSOLE_COMMIT="$(repeat_char c 40)"
ATTEMPT_ID="$(repeat_char a 32)"
SUBSCRIPTION_ID="12345678-1234-4234-8234-123456789abc"
RESOURCE_GROUP="workforce-os-prod"
RESOURCE_GROUP_ID="/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}"
API_RESOURCE_ID="${RESOURCE_GROUP_ID}/providers/Microsoft.App/containerApps/apex-gtm-api"
WORKER_RESOURCE_ID="${RESOURCE_GROUP_ID}/providers/Microsoft.App/containerApps/apex-gtm-worker"
CONSOLE_RESOURCE_ID="${RESOURCE_GROUP_ID}/providers/Microsoft.App/containerApps/nikxius-web"

HASH_1="sha256:$(repeat_char 1 64)"
HASH_2="sha256:$(repeat_char 2 64)"
HASH_3="sha256:$(repeat_char 3 64)"
HASH_4="sha256:$(repeat_char 4 64)"
HASH_5="sha256:$(repeat_char 5 64)"
HASH_6="sha256:$(repeat_char 6 64)"
HASH_7="sha256:$(repeat_char 7 64)"
HASH_8="sha256:$(repeat_char 8 64)"
HASH_9="sha256:$(repeat_char 9 64)"
HASH_A="sha256:$(repeat_char a 64)"
HASH_B="sha256:$(repeat_char b 64)"
HASH_C="sha256:$(repeat_char c 64)"
HASH_D="sha256:$(repeat_char d 64)"
HASH_E="sha256:$(repeat_char e 64)"
HASH_F="sha256:$(repeat_char f 64)"
LEGACY_BACKEND_COMMIT="$(repeat_char d 40)"
LEGACY_CONSOLE_COMMIT="$(repeat_char e 40)"
LEASE_TOKEN="$(repeat_char f 64)"

NOW_EPOCH="$(date -u +%s)"
PLAN_MINIMUM_EVENT_VERSION=$(((NOW_EPOCH - 300) * 1000))
PLAN_VERIFIED_AT="$(jq -nr --argjson epoch "$((NOW_EPOCH - 180))" '$epoch | todateiso8601')"
PLAN_EXPIRES_AT="$(jq -nr --argjson epoch "$((NOW_EPOCH + 2100))" '$epoch | todateiso8601')"
PLAN_OVERLONG_EXPIRES_AT="$(jq -nr --argjson epoch "$((NOW_EPOCH - 180 + 86401))" '$epoch | todateiso8601')"
LEASE_OBSERVED_AT="$(jq -nr --argjson epoch "$((NOW_EPOCH - 120))" '$epoch | todateiso8601')"
QUEUE_STABLE_SINCE="$(jq -nr --argjson epoch "$((NOW_EPOCH - 120))" '$epoch | todateiso8601')"
QUEUE_OBSERVED_AT_1="$(jq -nr --argjson epoch "$((NOW_EPOCH - 90))" '$epoch | todateiso8601')"
QUEUE_OBSERVED_AT_2="$(jq -nr --argjson epoch "$((NOW_EPOCH - 60))" '$epoch | todateiso8601')"
QUEUE_OBSERVED_TOO_CLOSE="$(jq -nr --argjson epoch "$((NOW_EPOCH - 86))" '$epoch | todateiso8601')"
WRITER_FENCE_ISSUED_AT="$(jq -nr --argjson epoch "$((NOW_EPOCH - 150))" '$epoch | todateiso8601')"
WRITER_FENCE_OBSERVED_AT="$(jq -nr --argjson epoch "$((NOW_EPOCH - 45))" '$epoch | todateiso8601')"
PREPARED_AT="$(jq -nr --argjson epoch "$((NOW_EPOCH - 30))" '$epoch | todateiso8601')"
EXPIRES_AT_EPOCH=$((NOW_EPOCH + 1800))
EXPIRES_AT="$(jq -nr --argjson epoch "${EXPIRES_AT_EPOCH}" '$epoch | todateiso8601')"
LEASE_EXPIRES_AT="$(jq -nr --argjson epoch "$((NOW_EPOCH + 2400))" '$epoch | todateiso8601')"

jq -n \
  --arg attempt "${ATTEMPT_ID}" \
  --arg backend_commit "${BACKEND_COMMIT}" \
  --arg console_commit "${CONSOLE_COMMIT}" \
  --arg subscription "${SUBSCRIPTION_ID}" \
  --arg resource_group "${RESOURCE_GROUP}" \
  --arg resource_group_id "${RESOURCE_GROUP_ID}" \
  --arg api_resource_id "${API_RESOURCE_ID}" \
  --arg worker_resource_id "${WORKER_RESOURCE_ID}" \
  --arg console_resource_id "${CONSOLE_RESOURCE_ID}" \
  --arg lease_token "${LEASE_TOKEN}" \
  --argjson plan_minimum_event_version "${PLAN_MINIMUM_EVENT_VERSION}" \
  --arg plan_verified_at "${PLAN_VERIFIED_AT}" \
  --arg plan_expires_at "${PLAN_EXPIRES_AT}" \
  --arg lease_observed_at "${LEASE_OBSERVED_AT}" \
  --arg lease_expires_at "${LEASE_EXPIRES_AT}" \
  --arg queue_observed_at_1 "${QUEUE_OBSERVED_AT_1}" \
  --arg queue_observed_at_2 "${QUEUE_OBSERVED_AT_2}" \
  --arg queue_stable_since "${QUEUE_STABLE_SINCE}" \
  --arg writer_fence_issued_at "${WRITER_FENCE_ISSUED_AT}" \
  --arg writer_fence_observed_at "${WRITER_FENCE_OBSERVED_AT}" \
  --arg legacy_backend_commit "${LEGACY_BACKEND_COMMIT}" \
  --arg legacy_console_commit "${LEGACY_CONSOLE_COMMIT}" \
  --arg h1 "${HASH_1}" --arg h2 "${HASH_2}" \
  --arg h3 "${HASH_3}" --arg h4 "${HASH_4}" \
  --arg h5 "${HASH_5}" --arg h6 "${HASH_6}" \
  --arg h7 "${HASH_7}" --arg h8 "${HASH_8}" \
  --arg h9 "${HASH_9}" --arg ha "${HASH_A}" \
  --arg hb "${HASH_B}" --arg hc "${HASH_C}" \
  --arg hd "${HASH_D}" --arg he "${HASH_E}" \
  --arg hf "${HASH_F}" '
    def backend_target($revision): {
      image: ("workforceosprodacr.azurecr.io/apex-api@" + $h1),
      manifestDigest: $h1,
      platformDigest: $h2,
      ociRevision: $backend_commit,
      platform: "linux/amd64",
      plannedRevision: $revision,
      buildRunId: "acr-backend-123",
      buildEvidenceHash: $ha,
      rehearsalEvidenceHash: $hb
    };
    def source_app($image; $manifest; $platform_digest; $oci; $revision; $config; $template; $secrets): {
      image: $image,
      manifestDigest: $manifest,
      platformDigest: $platform_digest,
      ociRevision: $oci,
      platform: "linux/amd64",
      revision: $revision,
      configHash: $config,
      templateHash: $template,
      secretReferencesHash: $secrets,
      activeRevisionsMode: "Single",
      maxInactiveRevisions: 10,
      healthy: true
    };
    def queue_state($waiting; $delayed; $completed; $failed; $paused_jobs): {
      paused: true,
      waiting: $waiting,
      active: 0,
      delayed: $delayed,
      prioritized: 0,
      completed: $completed,
      failed: $failed,
      waitingChildren: 0,
      pausedJobs: $paused_jobs,
      workerCount: 0
    };
    def queues: {
      agentRuns: queue_state(2; 1; 10; 1; 2),
      graphRuns: queue_state(1; 0; 20; 2; 1),
      outreachSend: queue_state(3; 2; 30; 3; 3)
    };
    {
      schemaVersion: 1,
      environment: "production",
      kind: "initial-bootstrap-admission-context",
      generatedBy: "workforce-production-bootstrap-controller-v1",
      bootstrapAttemptId: $attempt,
      backendCandidateCommit: $backend_commit,
      consoleCandidateCommit: $console_commit,
      authority: {
        subscriptionId: $subscription,
        resourceGroupName: $resource_group,
        resourceGroupResourceId: $resource_group_id,
        apiContainerAppResourceId: $api_resource_id,
        workerContainerAppResourceId: $worker_resource_id,
        consoleContainerAppResourceId: $console_resource_id
      },
      releaseLock: {
        repository: "https://github.com/Kloudedge-apex/apex-product.git",
        ref: "refs/heads/workforce-os-release-lock/production-gtm-platform",
        objectSha: $backend_commit
      },
      redisIdentityHash: $hc,
      databaseIdentityHash: $hd,
      lease: {
        token: $lease_token,
        generation: 7,
        observedAt: $lease_observed_at,
        expiresAt: $lease_expires_at
      },
      targetArtifacts: {
        api: backend_target("apex-gtm-api--candidate-a"),
        worker: backend_target("apex-gtm-worker--candidate-a"),
        console: {
          image: ("workforceosprodacr.azurecr.io/workforceos-fe@" + $h3),
          manifestDigest: $h3,
          platformDigest: $h4,
          ociRevision: $console_commit,
          platform: "linux/amd64",
          plannedRevision: "nikxius-web--candidate-a",
          buildRunId: "acr-console-456",
          buildEvidenceHash: $hc,
          rehearsalEvidenceHash: $hd,
          clientConfigEvidenceHash: $he,
          smokeEvidenceHash: $hf
        }
      },
      clerkReconciliationPlan: {
        rawPlanSha256: $h1,
        dryRunEvidenceSha256: $h2,
        inventoryEvidenceHash: $h3,
        minimumEventVersion: $plan_minimum_event_version,
        expectedActiveOrganizationCount: 2,
        expectedActiveMembershipCount: 3,
        expectedActiveUserCount: 3,
        executor: {
          name: "workforce-production-clerk-reconciliation-executor",
          version: "v1",
          sha256: $h4
        },
        dryRunPassed: true,
        approver: "bootstrap-approver",
        planSignatureSha256: $h5,
        signatureNamespace: "workforce-os-clerk-reconciliation-plan",
        independentApprovalEvidenceHash: $h6,
        verifiedAt: $plan_verified_at,
        expiresAt: $plan_expires_at
      },
      sourceRollbackBaseline: {
        compatibilityState: "legacy-readers-no-new-enum-values-v1",
        rollbackPermittedUntil: "before-first-clerk-migration-invocation-only",
        originalAllowlistNonempty: true,
        originalAllowlistHash: $he,
        deliverySafetyEvidence: {
          outstandingDeliveryReview: {
            evidenceHash: $h3,
            reviewer: "bootstrap-approver",
            reviewedAt: $plan_verified_at,
            expiresAt: $plan_expires_at,
            outstandingDeliveryCount: 0,
            unresolvedDeliveryCount: 0,
            disposition: "no-outstanding-deliveries"
          },
          providerDeliveryDrain: {
            evidenceHash: $h1,
            reviewer: "bootstrap-approver",
            reviewedAt: $plan_verified_at,
            expiresAt: $plan_expires_at,
            providerScope: "all-configured-outbound-providers",
            inFlightDeliveryCount: 0,
            drainConfirmed: true
          },
          verifiedFromProtectedBytes: true
        },
        databaseDdlAuthorityEvidence: {
          schemaVersion: 1,
          environment: "production",
          kind: "production-database-ddl-exclusive-authority",
          bootstrapAttemptId: $attempt,
          backendCandidateCommit: $backend_commit,
          databaseIdentityHash: $hd,
          evidenceHash: $h2,
          reviewer: "bootstrap-approver",
          reviewedAt: $plan_verified_at,
          expiresAt: $plan_expires_at,
          authorityScope: "all-production-database-ddl-actors",
          exclusiveDdlAuthorityConfirmed: true,
          verifiedFromProtectedBytes: true
        },
        operationalSmokeEvidence: {
          failedList: {
            schemaVersion: 1,
            environment: "production",
            kind: "production-failed-list-smoke",
            bootstrapAttemptId: $attempt,
            backendCandidateCommit: $backend_commit,
            consoleCandidateCommit: $console_commit,
            evidenceHash: $h3,
            reviewer: "bootstrap-approver",
            reviewedAt: $plan_verified_at,
            expiresAt: $plan_expires_at,
            scope: "api-failed-outreach-list",
            passed: true
          },
          dashboardPolicy: {
            schemaVersion: 1,
            environment: "production",
            kind: "production-dashboard-policy-smoke",
            bootstrapAttemptId: $attempt,
            backendCandidateCommit: $backend_commit,
            consoleCandidateCommit: $console_commit,
            evidenceHash: $h4,
            reviewer: "bootstrap-approver",
            reviewedAt: $plan_verified_at,
            expiresAt: $plan_expires_at,
            scope: "console-dashboard-policy",
            passed: true
          },
          verifiedFromProtectedBytes: true
        },
        privateRestoreBundleHash: $hf,
        api: source_app(
          ("workforceosprodacr.azurecr.io/apex-api@" + $h5); $h5; $h6;
          $legacy_backend_commit; "apex-gtm-api--legacy-a"; $h9; $ha; $hb
        ),
        worker: source_app(
          ("workforceosprodacr.azurecr.io/apex-api@" + $h5); $h5; $h6;
          $legacy_backend_commit; "apex-gtm-worker--legacy-a"; $hc; $hd; $he
        ),
        console: source_app(
          ("workforceosprodacr.azurecr.io/workforceos-fe@" + $h7); $h7; $h8;
          $legacy_console_commit; "nikxius-web--legacy-a"; $h9; $ha; $hb
        )
      },
      quiescedState: {
        api: {
          stopped: true,
          activeRevisionCount: 1,
          replicaCount: 0,
          ingressDisabled: true
        },
        worker: {
          stopped: true,
          activeRevisionCount: 1,
          replicaCount: 0,
          consumersDisabled: true
        },
        queueObservations: [
          {
            observedAt: $queue_observed_at_1,
            stableSince: $queue_stable_since,
            evidenceHash: $h9,
            queues: queues
          },
          {
            observedAt: $queue_observed_at_2,
            stableSince: $queue_stable_since,
            evidenceHash: $ha,
            queues: queues
          }
        ],
        writerFence: {
          schemaVersion: 1,
          target: "workforce-os-production",
          observedAt: $writer_fence_observed_at,
          generation: 7,
          state: {
            schemaVersion: 1,
            target: "workforce-os-production",
            mode: "closed",
            bootstrapAttemptId: $attempt,
            generation: 7,
            issuedAt: $writer_fence_issued_at,
            expiresAt: $lease_expires_at
          },
          stateHash: $hb,
          activeWriters: 0,
          activeComplianceWriters: 0,
          writerZero: true
        },
        orphanRecovery: {
          schemaVersion: 1,
          target: "workforce-os-production",
          bootstrapAttemptId: $attempt,
          generation: 0,
          recoveredAt: $writer_fence_issued_at,
          stableZeroEvidenceHash: $h1,
          pre: {
            activeApplicationWriters: 0,
            activeComplianceWriters: 0,
            uncertainApplicationWriters: 1,
            uncertainComplianceWriters: 0,
            tokenSetHash: $h2
          },
          post: {
            activeApplicationWriters: 0,
            activeComplianceWriters: 0,
            uncertainApplicationWriters: 0,
            uncertainComplianceWriters: 0,
            tokenSetHash: $h3
          }
        },
        inventory: {
          databaseIdentityHash: $hd,
          sendingRows: 0,
          firstClassDeliveryUnknownRows: 0,
          legacyDeliveryUnknownMarkerRows: 0,
          firstClassFailedRows: 0,
          legacyAutoFailedMarkerRows: 2,
          outreachIdempotencyDuplicateGroups: 0,
          legacyGmailReplySequenceStopRows: 4,
          managerRoleRows: 0,
          graphRunRunningRows: 0,
          graphRunAwaitingApprovalRows: 1,
          graphActiveOrgDuplicateGroups: 0,
          graphActiveWithoutRecoveryStateRows: 0,
          graphLifecycleSchemaReady: false,
          replySchemaReady: false,
          replySourceDuplicateGroups: null,
          replyConversationDuplicateGroups: null,
          nullSourceReplyRows: null,
          replySlotDuplicateRows: null,
          duplicateInventoryEvidenceHash: $hd,
          clerkIdentitySchemaReady: false,
          clerkCutoverRowCount: null,
          clerkCutoverReady: null,
          clerkMinimumEventVersion: null,
          clerkInventoryEvidenceHash: null,
          clerkExpectedActiveOrganizationCount: null,
          clerkExpectedActiveMembershipCount: null,
          clerkExpectedActiveUserCount: null,
          clerkActiveOrganizationCount: null,
          clerkActiveMembershipCount: null,
          clerkActiveUserCount: null,
          clerkProjectionMismatchRows: null,
          clerkOrphanActiveAuthorityRows: null,
          clerkReadinessViolationCount: null
        },
        liveSendAllowlistEmpty: true,
        privateRestoreBundleHash: $hf,
        evidenceHash: $he
      }
    }
  ' >"${HARNESS}/context.json"

MIGRATIONS_JSON='[]'
for index in "${!MIGRATIONS[@]}"; do
  path="${MIGRATIONS[$index]}"
  pause="${WRITER_PAUSE[$index]}"
  scopes="${WRITER_SCOPES[$index]}"
  source_hash="$(file_hash "${FIXTURE_REPO}/${path}")"
  entry="$(jq -n \
    --arg path "${path}" \
    --arg hash "${source_hash}" \
    --arg pause "${pause}" \
    --argjson scopes "${scopes}" \
    '{path: $path, sha256: $hash, writerPause: $pause, writerScopes: $scopes}')"
  MIGRATIONS_JSON="$(jq -c --argjson entry "${entry}" '. + [$entry]' \
    <<<"${MIGRATIONS_JSON}")"
done

CONTEXT_HASH="$(file_hash "${HARNESS}/context.json")"
jq -n \
  --slurpfile context "${HARNESS}/context.json" \
  --arg prepared_at "${PREPARED_AT}" \
  --arg expires_at "${EXPIRES_AT}" \
  --arg context_hash "${CONTEXT_HASH}" \
  --argjson migrations "${MIGRATIONS_JSON}" '
    $context[0] as $c
    | {
      schemaVersion: 2,
      environment: "production",
      kind: "initial-bootstrap-entry",
      authorizationScope: "bootstrap-entry-admission-only",
      bootstrapAttemptId: $c.bootstrapAttemptId,
      backendCandidateCommit: $c.backendCandidateCommit,
      consoleCandidateCommit: $c.consoleCandidateCommit,
      status: "prepared-and-quiesced",
      preparedAt: $prepared_at,
      expiresAt: $expires_at,
      operator: "bootstrap-operator",
      approver: "bootstrap-approver",
      changeTicket: "change-bootstrap-1",
      admissionContextHash: $context_hash,
      authority: $c.authority,
      releaseLock: $c.releaseLock,
      redisIdentityHash: $c.redisIdentityHash,
      databaseIdentityHash: $c.databaseIdentityHash,
      lease: $c.lease,
      targetArtifacts: $c.targetArtifacts,
      clerkReconciliationPlan: $c.clerkReconciliationPlan,
      sourceRollbackBaseline: $c.sourceRollbackBaseline,
      quiescedState: $c.quiescedState,
      migrations: $migrations
    }
  ' >"${HARNESS}/receipt.json"

sign_receipt() {
  local receipt=$1
  local key=${2:-${HARNESS}/approver-key}
  local namespace=${3:-workforce-os-initial-bootstrap-entry}
  rm -f -- "${receipt}.sig"
  ssh-keygen -Y sign -f "${key}" -n "${namespace}" "${receipt}" \
    >/dev/null 2>&1
}

run_verifier() {
  local receipt=$1
  local signature=$2
  local allowed_signers=$3
  local context=$4
  local backend_commit=${5:-${BACKEND_COMMIT}}
  local console_commit=${6:-${CONSOLE_COMMIT}}
  local attempt=${7:-${ATTEMPT_ID}}
  "${VERIFIER}" \
    "${receipt}" "${signature}" "${allowed_signers}" \
    "${backend_commit}" "${console_commit}" "${attempt}" "${context}"
}

expect_rejected() {
  local description=$1
  local receipt=$2
  local signature=$3
  local context=$4
  local allowed_signers=${5:-${HARNESS}/allowed-signers}
  if run_verifier "${receipt}" "${signature}" "${allowed_signers}" "${context}" \
    >/dev/null 2>&1; then
    fail "verifier accepted ${description}"
  fi
  pass
}

make_signed_variant() {
  local name=$1
  local filter=$2
  VARIANT_CONTEXT="${HARNESS}/context.json"
  VARIANT_RECEIPT="${HARNESS}/${name}.json"
  jq "${filter}" "${HARNESS}/receipt.json" >"${VARIANT_RECEIPT}"
  sign_receipt "${VARIANT_RECEIPT}"
}

make_bound_variant() {
  local name=$1
  local receipt_filter=$2
  local context_filter=${3:-${receipt_filter}}
  local draft="${HARNESS}/${name}.draft.json"
  VARIANT_CONTEXT="${HARNESS}/${name}.context.json"
  VARIANT_RECEIPT="${HARNESS}/${name}.json"
  jq "${context_filter}" "${HARNESS}/context.json" >"${VARIANT_CONTEXT}"
  jq "${receipt_filter}" "${HARNESS}/receipt.json" >"${draft}"
  variant_context_hash="$(file_hash "${VARIANT_CONTEXT}")"
  jq --arg hash "${variant_context_hash}" '.admissionContextHash = $hash' \
    "${draft}" >"${VARIANT_RECEIPT}"
  rm -f -- "${draft}"
  sign_receipt "${VARIANT_RECEIPT}"
}

sign_receipt "${HARNESS}/receipt.json"

# The published schema is a strict v2 contract and statically pins the same
# nine migrations, ordering, writer pauses, and writer scopes as the verifier.
jq -e '
  .["$schema"] == "https://json-schema.org/draft/2020-12/schema"
  and .["$id"] == "https://workforceos.xyz/schemas/production-bootstrap-entry-receipt-v2.json"
  and .properties.schemaVersion.const == 2
  and .properties.kind.const == "initial-bootstrap-entry"
  and .properties.status.const == "prepared-and-quiesced"
  and .additionalProperties == false
  and (.required | length == 24)
  and .properties.authorizationScope.const == "bootstrap-entry-admission-only"
  and (.required | index("sourceRollbackBaseline") != null)
  and (.required | index("clerkReconciliationPlan") != null)
  and (.required | index("quiescedState") != null)
  and (.properties.sourceRollbackBaseline["$ref"] == "#/$defs/sourceRollbackBaseline")
  and (.properties.quiescedState["$ref"] == "#/$defs/quiescedState")
  and .["$defs"].sourceRollbackBaseline.additionalProperties == false
  and (.["$defs"].sourceRollbackBaseline.required | index("databaseDdlAuthorityEvidence") != null)
  and (.["$defs"].sourceRollbackBaseline.required | index("operationalSmokeEvidence") != null)
  and .["$defs"].databaseDdlAuthorityEvidence.additionalProperties == false
  and .["$defs"].databaseDdlAuthorityEvidence.properties.environment.const == "production"
  and .["$defs"].databaseDdlAuthorityEvidence.properties.kind.const == "production-database-ddl-exclusive-authority"
  and .["$defs"].databaseDdlAuthorityEvidence.properties.authorityScope.const == "all-production-database-ddl-actors"
  and .["$defs"].databaseDdlAuthorityEvidence.properties.exclusiveDdlAuthorityConfirmed.const == true
  and .["$defs"].databaseDdlAuthorityEvidence.properties.verifiedFromProtectedBytes.const == true
  and .["$defs"].operationalSmokeEvidence.additionalProperties == false
  and .["$defs"].operationalSmokeEvidence.properties.verifiedFromProtectedBytes.const == true
  and .["$defs"].failedListSmokeEvidence.additionalProperties == false
  and .["$defs"].failedListSmokeEvidence.properties.kind.const == "production-failed-list-smoke"
  and .["$defs"].failedListSmokeEvidence.properties.scope.const == "api-failed-outreach-list"
  and .["$defs"].failedListSmokeEvidence.properties.passed.const == true
  and .["$defs"].dashboardPolicySmokeEvidence.additionalProperties == false
  and .["$defs"].dashboardPolicySmokeEvidence.properties.kind.const == "production-dashboard-policy-smoke"
  and .["$defs"].dashboardPolicySmokeEvidence.properties.scope.const == "console-dashboard-policy"
  and .["$defs"].dashboardPolicySmokeEvidence.properties.passed.const == true
  and .["$defs"].clerkReconciliationPlan.additionalProperties == false
  and .["$defs"].clerkReconciliationPlan.properties.signatureNamespace.const == "workforce-os-clerk-reconciliation-plan"
  and .["$defs"].clerkReconciliationPlan.properties.dryRunPassed.const == true
  and .["$defs"].timestamp.pattern == "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"
  and .properties.preparedAt["$ref"] == "#/$defs/timestamp"
  and .["$defs"].clerkReconciliationPlan.properties.verifiedAt["$ref"] == "#/$defs/timestamp"
  and .["$defs"].quiescedState.additionalProperties == false
  and .["$defs"].queueState.properties.workerCount.const == 0
  and .["$defs"].quiescedState.properties.queueObservations.minItems == 2
  and .["$defs"].quiescedState.properties.queueObservations.maxItems == 2
  and (.["$defs"].queueObservation.required | index("stableSince") != null)
  and .["$defs"].quiescedState.properties.writerFence["$ref"] == "#/$defs/writerFence"
  and .["$defs"].quiescedState.properties.orphanRecovery["$ref"] == "#/$defs/orphanRecovery"
  and .["$defs"].orphanRecoveryZeroTokenState.allOf[1].properties.uncertainApplicationWriters.const == 0
  and .["$defs"].writerFence.properties.activeWriters.const == 0
  and .["$defs"].writerFence.properties.activeComplianceWriters.const == 0
  and .["$defs"].inventory.properties.graphLifecycleSchemaReady.const == false
  and .["$defs"].inventory.properties.outreachIdempotencyDuplicateGroups.const == 0
  and .["$defs"].inventory.properties.managerRoleRows.const == 0
  and (.properties.migrations.prefixItems | length == 9)
  and .properties.migrations.minItems == 9
  and .properties.migrations.maxItems == 9
  and .properties.migrations.items == false
' "${SCHEMA}" >/dev/null || fail "bootstrap entry JSON Schema v2 contract is incomplete"
for index in "${!MIGRATIONS[@]}"; do
  path="${MIGRATIONS[$index]}"
  pause="${WRITER_PAUSE[$index]}"
  scopes="${WRITER_SCOPES[$index]}"
  source_hash="$(file_hash "${REPO_ROOT}/${path}")"
  jq -e \
    --argjson index "${index}" \
    --arg path "${path}" \
    --arg hash "${source_hash}" \
    --arg pause "${pause}" \
    --argjson scopes "${scopes}" '
      .properties.migrations.prefixItems[$index].allOf[1].properties.path.const == $path
      and .properties.migrations.prefixItems[$index].allOf[1].properties.sha256.const == $hash
      and .properties.migrations.prefixItems[$index].allOf[1].properties.writerPause.const == $pause
      and .properties.migrations.prefixItems[$index].allOf[1].properties.writerScopes.const == $scopes
    ' "${SCHEMA}" >/dev/null ||
    fail "schema migration entry ${index} does not match committed source and writer scope"
done
pass

run_verifier \
  "${HARNESS}/receipt.json" "${HARNESS}/receipt.json.sig" \
  "${HARNESS}/allowed-signers" "${HARNESS}/context.json" >/dev/null ||
  fail "valid signed bootstrap entry receipt was rejected"
pass

# All three explicit identities are independently caller-bound.
if run_verifier \
  "${HARNESS}/receipt.json" "${HARNESS}/receipt.json.sig" \
  "${HARNESS}/allowed-signers" "${HARNESS}/context.json" \
  "${ALTERNATE_BACKEND_COMMIT}" >/dev/null 2>&1; then
  fail "verifier accepted a mismatched expected backend commit"
fi
pass
if run_verifier \
  "${HARNESS}/receipt.json" "${HARNESS}/receipt.json.sig" \
  "${HARNESS}/allowed-signers" "${HARNESS}/context.json" \
  "${BACKEND_COMMIT}" "$(repeat_char b 40)" >/dev/null 2>&1; then
  fail "verifier accepted a mismatched expected console commit"
fi
pass
if run_verifier \
  "${HARNESS}/receipt.json" "${HARNESS}/receipt.json.sig" \
  "${HARNESS}/allowed-signers" "${HARNESS}/context.json" \
  "${BACKEND_COMMIT}" "${CONSOLE_COMMIT}" "$(repeat_char b 32)" >/dev/null 2>&1; then
  fail "verifier accepted a mismatched expected attempt id"
fi
pass

# Unknown fields fail at every signed nesting boundary, even when the context
# carries the same added field and the receipt is freshly signed over its hash.
EXTRA_BOUND_FILTERS=(
  '.authority.unexpected = true'
  '.releaseLock.unexpected = true'
  '.lease.unexpected = true'
  '.targetArtifacts.api.unexpected = true'
  '.clerkReconciliationPlan.unexpected = true'
  '.clerkReconciliationPlan.executor.unexpected = true'
  '.sourceRollbackBaseline.unexpected = true'
  '.sourceRollbackBaseline.databaseDdlAuthorityEvidence.unexpected = true'
  '.sourceRollbackBaseline.operationalSmokeEvidence.unexpected = true'
  '.sourceRollbackBaseline.operationalSmokeEvidence.failedList.unexpected = true'
  '.sourceRollbackBaseline.operationalSmokeEvidence.dashboardPolicy.unexpected = true'
  '.sourceRollbackBaseline.worker.unexpected = true'
  '.quiescedState.unexpected = true'
  '.quiescedState.queueObservations[0].unexpected = true'
  '.quiescedState.queueObservations[0].queues.agentRuns.unexpected = true'
  '.quiescedState.writerFence.unexpected = true'
  '.quiescedState.orphanRecovery.unexpected = true'
  '.quiescedState.inventory.unexpected = true'
)
extra_index=0
for filter in "${EXTRA_BOUND_FILTERS[@]}"; do
  make_bound_variant "extra-bound-${extra_index}" "${filter}"
  expect_rejected "nested unknown field ${extra_index}" \
    "${VARIANT_RECEIPT}" "${VARIANT_RECEIPT}.sig" "${VARIANT_CONTEXT}"
  extra_index=$((extra_index + 1))
done
make_signed_variant "extra-top-level" '.unexpected = true'
expect_rejected "an extra top-level field" \
  "${VARIANT_RECEIPT}" "${VARIANT_RECEIPT}.sig" "${VARIANT_CONTEXT}"
make_signed_variant "extra-migration-field" '.migrations[0].unexpected = true'
expect_rejected "an extra migration field" \
  "${VARIANT_RECEIPT}" "${VARIANT_RECEIPT}.sig" "${VARIANT_CONTEXT}"

make_signed_variant "same-operator-approver" '.operator = .approver'
expect_rejected "the same operator and approver" \
  "${VARIANT_RECEIPT}" "${VARIANT_RECEIPT}.sig" "${VARIANT_CONTEXT}"
make_signed_variant "mutation-authorization" '.authorizationScope = "mutation-authorized"'
expect_rejected "a receipt claiming mutation authority" \
  "${VARIANT_RECEIPT}" "${VARIANT_RECEIPT}.sig" "${VARIANT_CONTEXT}"

# Signed and controller-context-bound unsafe mutations exercise every critical
# authority, artifact, rollback-anchor, quiescence, fence, and inventory gate.
UNSAFE_BOUND_FILTERS=(
  '.authority.subscriptionId = "22345678-1234-4234-8234-123456789abc"'
  '.authority.apiContainerAppResourceId = .authority.workerContainerAppResourceId'
  '.releaseLock.ref = "refs/heads/other"'
  '.releaseLock.objectSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"'
  '.redisIdentityHash = "invalid"'
  '.databaseIdentityHash = "invalid"'
  '.lease.token = "short"'
  '.lease.generation = 0'
  '.clerkReconciliationPlan.rawPlanSha256 = "invalid"'
  '.clerkReconciliationPlan.dryRunEvidenceSha256 = "invalid"'
  '.clerkReconciliationPlan.inventoryEvidenceHash = "invalid"'
  '.clerkReconciliationPlan.minimumEventVersion = 0'
  '.clerkReconciliationPlan.expectedActiveOrganizationCount = -1'
  '.clerkReconciliationPlan.executor.name = "other-executor"'
  '.clerkReconciliationPlan.executor.sha256 = "invalid"'
  '.clerkReconciliationPlan.dryRunPassed = false'
  '.clerkReconciliationPlan.approver = "other-approver"'
  '.clerkReconciliationPlan.planSignatureSha256 = "invalid"'
  '.clerkReconciliationPlan.signatureNamespace = "other-namespace"'
  '.clerkReconciliationPlan.independentApprovalEvidenceHash = "invalid"'
  '.targetArtifacts.api.platform = "linux/arm64"'
  '.targetArtifacts.api.manifestDigest = "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"'
  '.targetArtifacts.api.ociRevision = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"'
  '.targetArtifacts.api.buildRunId = "bad run id"'
  '.targetArtifacts.api.buildEvidenceHash = "invalid"'
  '.targetArtifacts.api.rehearsalEvidenceHash = "invalid"'
  '.targetArtifacts.worker.platformDigest = "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"'
  '.targetArtifacts.console.platform = "linux/arm64"'
  '.targetArtifacts.console.ociRevision = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"'
  '.targetArtifacts.console.clientConfigEvidenceHash = "invalid"'
  '.targetArtifacts.console.smokeEvidenceHash = "invalid"'
  '.sourceRollbackBaseline.compatibilityState = "unverified"'
  '.sourceRollbackBaseline.rollbackPermittedUntil = "after-migrations"'
  '.sourceRollbackBaseline.originalAllowlistNonempty = "yes"'
  '.sourceRollbackBaseline.originalAllowlistHash = "invalid"'
  '.sourceRollbackBaseline.deliverySafetyEvidence.verifiedFromProtectedBytes = false'
  '.sourceRollbackBaseline.deliverySafetyEvidence.outstandingDeliveryReview.evidenceHash = "invalid"'
  '.sourceRollbackBaseline.deliverySafetyEvidence.outstandingDeliveryReview.reviewer = "other-approver"'
  '.sourceRollbackBaseline.deliverySafetyEvidence.outstandingDeliveryReview.outstandingDeliveryCount = 1'
  '.sourceRollbackBaseline.deliverySafetyEvidence.providerDeliveryDrain.providerScope = "one-provider"'
  '.sourceRollbackBaseline.deliverySafetyEvidence.providerDeliveryDrain.inFlightDeliveryCount = 1'
  '.sourceRollbackBaseline.deliverySafetyEvidence.providerDeliveryDrain.drainConfirmed = false'
  '.sourceRollbackBaseline.databaseDdlAuthorityEvidence.schemaVersion = 2'
  '.sourceRollbackBaseline.databaseDdlAuthorityEvidence.environment = "staging"'
  '.sourceRollbackBaseline.databaseDdlAuthorityEvidence.kind = "other-authority"'
  '.sourceRollbackBaseline.databaseDdlAuthorityEvidence.bootstrapAttemptId = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"'
  '.sourceRollbackBaseline.databaseDdlAuthorityEvidence.backendCandidateCommit = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"'
  '.sourceRollbackBaseline.databaseDdlAuthorityEvidence.databaseIdentityHash = "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"'
  '.sourceRollbackBaseline.databaseDdlAuthorityEvidence.evidenceHash = "invalid"'
  '.sourceRollbackBaseline.databaseDdlAuthorityEvidence.reviewer = "other-approver"'
  '.sourceRollbackBaseline.databaseDdlAuthorityEvidence.authorityScope = "one-ddl-actor"'
  '.sourceRollbackBaseline.databaseDdlAuthorityEvidence.exclusiveDdlAuthorityConfirmed = false'
  '.sourceRollbackBaseline.databaseDdlAuthorityEvidence.verifiedFromProtectedBytes = false'
  '.sourceRollbackBaseline.operationalSmokeEvidence.verifiedFromProtectedBytes = false'
  '.sourceRollbackBaseline.operationalSmokeEvidence.failedList.schemaVersion = 2'
  '.sourceRollbackBaseline.operationalSmokeEvidence.failedList.environment = "staging"'
  '.sourceRollbackBaseline.operationalSmokeEvidence.failedList.kind = "other-smoke"'
  '.sourceRollbackBaseline.operationalSmokeEvidence.failedList.bootstrapAttemptId = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"'
  '.sourceRollbackBaseline.operationalSmokeEvidence.failedList.backendCandidateCommit = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"'
  '.sourceRollbackBaseline.operationalSmokeEvidence.failedList.consoleCandidateCommit = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"'
  '.sourceRollbackBaseline.operationalSmokeEvidence.failedList.evidenceHash = "invalid"'
  '.sourceRollbackBaseline.operationalSmokeEvidence.failedList.reviewer = "other-approver"'
  '.sourceRollbackBaseline.operationalSmokeEvidence.failedList.scope = "other-scope"'
  '.sourceRollbackBaseline.operationalSmokeEvidence.failedList.passed = false'
  '.sourceRollbackBaseline.operationalSmokeEvidence.dashboardPolicy.kind = "other-smoke"'
  '.sourceRollbackBaseline.operationalSmokeEvidence.dashboardPolicy.bootstrapAttemptId = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"'
  '.sourceRollbackBaseline.operationalSmokeEvidence.dashboardPolicy.backendCandidateCommit = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"'
  '.sourceRollbackBaseline.operationalSmokeEvidence.dashboardPolicy.consoleCandidateCommit = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"'
  '.sourceRollbackBaseline.operationalSmokeEvidence.dashboardPolicy.evidenceHash = "invalid"'
  '.sourceRollbackBaseline.operationalSmokeEvidence.dashboardPolicy.reviewer = "other-approver"'
  '.sourceRollbackBaseline.operationalSmokeEvidence.dashboardPolicy.scope = "other-scope"'
  '.sourceRollbackBaseline.operationalSmokeEvidence.dashboardPolicy.passed = false'
  '.sourceRollbackBaseline.api.image = "workforceosprodacr.azurecr.io/apex-api:mutable"'
  '.sourceRollbackBaseline.api.manifestDigest = "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"'
  '.sourceRollbackBaseline.api.ociRevision = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"'
  '.sourceRollbackBaseline.api.configHash = "invalid"'
  '.sourceRollbackBaseline.api.templateHash = "invalid"'
  '.sourceRollbackBaseline.api.secretReferencesHash = "invalid"'
  '.sourceRollbackBaseline.api.activeRevisionsMode = "Multiple"'
  '.sourceRollbackBaseline.api.maxInactiveRevisions = 0'
  '.sourceRollbackBaseline.api.healthy = false'
  '.sourceRollbackBaseline.worker.image = "workforceosprodacr.azurecr.io/apex-api@sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"'
  '.sourceRollbackBaseline.console.platform = "linux/arm64"'
  '.quiescedState.api.stopped = false'
  '.quiescedState.api.activeRevisionCount = 0'
  '.quiescedState.api.replicaCount = 1'
  '.quiescedState.api.ingressDisabled = false'
  '.quiescedState.worker.stopped = false'
  '.quiescedState.worker.activeRevisionCount = 0'
  '.quiescedState.worker.replicaCount = 1'
  '.quiescedState.worker.consumersDisabled = false'
  '.quiescedState.queueObservations[0].queues.agentRuns.paused = false'
  '.quiescedState.queueObservations[0].queues.graphRuns.active = 1'
  '.quiescedState.queueObservations[0].queues.outreachSend.workerCount = 1'
  '.quiescedState.queueObservations[1].queues.agentRuns.waiting = 99'
  '.quiescedState.writerFence.state.bootstrapAttemptId = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"'
  '.quiescedState.writerFence.generation = 8'
  '.quiescedState.orphanRecovery.bootstrapAttemptId = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"'
  '.quiescedState.orphanRecovery.post.uncertainApplicationWriters = 1'
  '.quiescedState.orphanRecovery.stableZeroEvidenceHash = "invalid"'
  '.quiescedState.writerFence.state.generation = 8'
  '.quiescedState.writerFence.stateHash = "invalid"'
  '.quiescedState.writerFence.activeWriters = 1'
  '.quiescedState.writerFence.activeComplianceWriters = 1'
  '.quiescedState.writerFence.writerZero = false'
  '.quiescedState.liveSendAllowlistEmpty = false'
  '.quiescedState.privateRestoreBundleHash = "sha256:0000000000000000000000000000000000000000000000000000000000000000"'
  '.quiescedState.inventory.sendingRows = 1'
  '.quiescedState.inventory.firstClassDeliveryUnknownRows = 1'
  '.quiescedState.inventory.legacyDeliveryUnknownMarkerRows = 1'
  '.quiescedState.inventory.firstClassFailedRows = 1'
  '.quiescedState.inventory.outreachIdempotencyDuplicateGroups = 1'
  '.quiescedState.inventory.legacyGmailReplySequenceStopRows = -1'
  '.quiescedState.inventory.managerRoleRows = 1'
  '.quiescedState.inventory.graphRunRunningRows = 1'
  '.quiescedState.inventory.graphActiveOrgDuplicateGroups = 1'
  '.quiescedState.inventory.graphActiveWithoutRecoveryStateRows = 1'
  '.quiescedState.inventory.graphLifecycleSchemaReady = true'
  '.quiescedState.inventory.replySourceDuplicateGroups = 1'
  '.quiescedState.inventory.replyConversationDuplicateGroups = 1'
  '.quiescedState.inventory.nullSourceReplyRows = 1'
  '.quiescedState.inventory.databaseIdentityHash = "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"'
  '.quiescedState.inventory.clerkIdentitySchemaReady = true'
)
unsafe_index=0
for filter in "${UNSAFE_BOUND_FILTERS[@]}"; do
  make_bound_variant "unsafe-bound-${unsafe_index}" "${filter}"
  expect_rejected "unsafe signed/controller-bound state ${unsafe_index}" \
    "${VARIANT_RECEIPT}" "${VARIANT_RECEIPT}.sig" "${VARIANT_CONTEXT}"
  unsafe_index=$((unsafe_index + 1))
done

# Controller-context metadata is strict and the receipt binds its exact bytes.
make_bound_variant "wrong-context-producer" '.' '.generatedBy = "manual"'
expect_rejected "an untrusted controller-context producer" \
  "${VARIANT_RECEIPT}" "${VARIANT_RECEIPT}.sig" "${VARIANT_CONTEXT}"
make_bound_variant "extra-context-metadata" '.' '.unexpected = true'
expect_rejected "extra controller-context metadata" \
  "${VARIANT_RECEIPT}" "${VARIANT_RECEIPT}.sig" "${VARIANT_CONTEXT}"

cp "${HARNESS}/context.json" "${HARNESS}/changed-context.json"
printf '\n' >>"${HARNESS}/changed-context.json"
expect_rejected "controller context bytes changed after approval" \
  "${HARNESS}/receipt.json" "${HARNESS}/receipt.json.sig" \
  "${HARNESS}/changed-context.json"

# A pre-existing reply schema is allowed only with exact zero inventories;
# absent reply columns must remain represented as null, never invented zeros.
REPLY_READY_FILTER='
  .quiescedState.inventory.replySchemaReady = true
  | .quiescedState.inventory.replySourceDuplicateGroups = 0
  | .quiescedState.inventory.replyConversationDuplicateGroups = 0
  | .quiescedState.inventory.nullSourceReplyRows = 0
  | .quiescedState.inventory.replySlotDuplicateRows = 0
'
make_bound_variant "reply-schema-ready" "${REPLY_READY_FILTER}"
run_verifier \
  "${VARIANT_RECEIPT}" "${VARIANT_RECEIPT}.sig" \
  "${HARNESS}/allowed-signers" "${VARIANT_CONTEXT}" >/dev/null ||
  fail "verifier rejected a reply-ready exact-zero inventory"
pass
make_bound_variant "reply-absent-invented-zero" \
  '.quiescedState.inventory.replySourceDuplicateGroups = 0'
expect_rejected "invented reply inventory for an absent schema" \
  "${VARIANT_RECEIPT}" "${VARIANT_RECEIPT}.sig" "${VARIANT_CONTEXT}"
make_bound_variant "reply-ready-null" \
  "${REPLY_READY_FILTER} | .quiescedState.inventory.replySourceDuplicateGroups = null"
expect_rejected "a null inventory for a ready reply schema" \
  "${VARIANT_RECEIPT}" "${VARIANT_RECEIPT}.sig" "${VARIANT_CONTEXT}"
make_bound_variant "reply-ready-nonzero" \
  "${REPLY_READY_FILTER} | .quiescedState.inventory.replyConversationDuplicateGroups = 1"
expect_rejected "a nonzero inventory for a ready reply schema" \
  "${VARIANT_RECEIPT}" "${VARIANT_RECEIPT}.sig" "${VARIANT_CONTEXT}"

# The two observations must be temporally ordered and the lease must cover the
# receipt. These variants remain structurally and cryptographically bound.
make_bound_variant "same-time-observations" \
  '.quiescedState.queueObservations[0].observedAt = .quiescedState.queueObservations[1].observedAt'
expect_rejected "same-time queue observations" \
  "${VARIANT_RECEIPT}" "${VARIANT_RECEIPT}.sig" "${VARIANT_CONTEXT}"
make_bound_variant "reversed-observations" \
  '.quiescedState.queueObservations[0].observedAt = .quiescedState.writerFence.observedAt'
expect_rejected "reversed queue observations" \
  "${VARIANT_RECEIPT}" "${VARIANT_RECEIPT}.sig" "${VARIANT_CONTEXT}"
make_bound_variant "too-close-observations" \
  ".quiescedState.queueObservations[1].observedAt = \"${QUEUE_OBSERVED_TOO_CLOSE}\""
expect_rejected "queue observations less than five seconds apart" \
  "${VARIANT_RECEIPT}" "${VARIANT_RECEIPT}.sig" "${VARIANT_CONTEXT}"
make_bound_variant "late-stable-since" \
  '.quiescedState.queueObservations[0].stableSince = .quiescedState.queueObservations[1].observedAt'
expect_rejected "stableSince after observedAt" \
  "${VARIANT_RECEIPT}" "${VARIANT_RECEIPT}.sig" "${VARIANT_CONTEXT}"
make_bound_variant "writer-observed-too-early" \
  '.quiescedState.writerFence.observedAt = .quiescedState.queueObservations[0].observedAt'
expect_rejected "writer fence observed before the stable queue sample" \
  "${VARIANT_RECEIPT}" "${VARIANT_RECEIPT}.sig" "${VARIANT_CONTEXT}"
make_bound_variant "writer-issued-after-observed" \
  ".quiescedState.writerFence.state.issuedAt = \"${PREPARED_AT}\""
expect_rejected "writer fence issued after its readback" \
  "${VARIANT_RECEIPT}" "${VARIANT_RECEIPT}.sig" "${VARIANT_CONTEXT}"
make_bound_variant "writer-expiry-too-short" \
  ".quiescedState.writerFence.state.expiresAt = \"${PREPARED_AT}\""
expect_rejected "writer fence that does not cover receipt validity" \
  "${VARIANT_RECEIPT}" "${VARIANT_RECEIPT}.sig" "${VARIANT_CONTEXT}"
make_bound_variant "lease-too-short" \
  ".lease.expiresAt = \"${PREPARED_AT}\""
expect_rejected "a lease that does not cover receipt validity" \
  "${VARIANT_RECEIPT}" "${VARIANT_RECEIPT}.sig" "${VARIANT_CONTEXT}"
make_bound_variant "plan-verified-after-receipt" \
  '.clerkReconciliationPlan.verifiedAt = .expiresAt'
expect_rejected "a Clerk plan verified after receipt preparation" \
  "${VARIANT_RECEIPT}" "${VARIANT_RECEIPT}.sig" "${VARIANT_CONTEXT}"
make_bound_variant "plan-expiry-too-short" \
  '.clerkReconciliationPlan.expiresAt = .clerkReconciliationPlan.verifiedAt'
expect_rejected "a Clerk plan that does not cover receipt validity" \
  "${VARIANT_RECEIPT}" "${VARIANT_RECEIPT}.sig" "${VARIANT_CONTEXT}"
make_bound_variant "plan-cutoff-after-verification" \
  '.clerkReconciliationPlan.minimumEventVersion = ((.clerkReconciliationPlan.verifiedAt | fromdateiso8601) * 1000 + 1)'
expect_rejected "a Clerk inventory cutoff after plan verification" \
  "${VARIANT_RECEIPT}" "${VARIANT_RECEIPT}.sig" "${VARIANT_CONTEXT}"
make_bound_variant "plan-overlong" \
  ".clerkReconciliationPlan.expiresAt = \"${PLAN_OVERLONG_EXPIRES_AT}\""
expect_rejected "a Clerk plan lifetime over 24 hours" \
  "${VARIANT_RECEIPT}" "${VARIANT_RECEIPT}.sig" "${VARIANT_CONTEXT}"
make_bound_variant "database-ddl-reviewed-after-receipt" \
  '.sourceRollbackBaseline.databaseDdlAuthorityEvidence.reviewedAt = .expiresAt'
expect_rejected "database DDL authority reviewed after receipt preparation" \
  "${VARIANT_RECEIPT}" "${VARIANT_RECEIPT}.sig" "${VARIANT_CONTEXT}"
make_bound_variant "database-ddl-expiry-too-short" \
  ".sourceRollbackBaseline.databaseDdlAuthorityEvidence.expiresAt = \"${PREPARED_AT}\""
expect_rejected "database DDL authority that does not cover receipt validity" \
  "${VARIANT_RECEIPT}" "${VARIANT_RECEIPT}.sig" "${VARIANT_CONTEXT}"
make_bound_variant "database-ddl-overlong" \
  ".sourceRollbackBaseline.databaseDdlAuthorityEvidence.expiresAt = \"${PLAN_OVERLONG_EXPIRES_AT}\""
expect_rejected "database DDL authority lifetime over 24 hours" \
  "${VARIANT_RECEIPT}" "${VARIANT_RECEIPT}.sig" "${VARIANT_CONTEXT}"
make_bound_variant "failed-list-smoke-reviewed-after-receipt" \
  '.sourceRollbackBaseline.operationalSmokeEvidence.failedList.reviewedAt = .expiresAt'
expect_rejected "failed-list smoke reviewed after receipt preparation" \
  "${VARIANT_RECEIPT}" "${VARIANT_RECEIPT}.sig" "${VARIANT_CONTEXT}"
make_bound_variant "failed-list-smoke-expiry-too-short" \
  ".sourceRollbackBaseline.operationalSmokeEvidence.failedList.expiresAt = \"${PREPARED_AT}\""
expect_rejected "failed-list smoke that does not cover receipt validity" \
  "${VARIANT_RECEIPT}" "${VARIANT_RECEIPT}.sig" "${VARIANT_CONTEXT}"
make_bound_variant "dashboard-smoke-empty-window" \
  '.sourceRollbackBaseline.operationalSmokeEvidence.dashboardPolicy.expiresAt = .sourceRollbackBaseline.operationalSmokeEvidence.dashboardPolicy.reviewedAt'
expect_rejected "dashboard-policy smoke with an empty review window" \
  "${VARIANT_RECEIPT}" "${VARIANT_RECEIPT}.sig" "${VARIANT_CONTEXT}"
make_bound_variant "dashboard-smoke-overlong" \
  ".sourceRollbackBaseline.operationalSmokeEvidence.dashboardPolicy.expiresAt = \"${PLAN_OVERLONG_EXPIRES_AT}\""
expect_rejected "dashboard-policy smoke lifetime over 24 hours" \
  "${VARIANT_RECEIPT}" "${VARIANT_RECEIPT}.sig" "${VARIANT_CONTEXT}"

# Migration sequence, committed hashes, pause modes, and writer scopes are all
# exact. None can be changed merely by obtaining another valid signature.
make_signed_variant "migration-order" \
  '.migrations[0] as $first | .migrations[0] = .migrations[1] | .migrations[1] = $first'
expect_rejected "reordered migrations" \
  "${VARIANT_RECEIPT}" "${VARIANT_RECEIPT}.sig" "${VARIANT_CONTEXT}"
make_signed_variant "migration-hash" \
  '.migrations[3].sha256 = "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"'
expect_rejected "a mismatched migration hash" \
  "${VARIANT_RECEIPT}" "${VARIANT_RECEIPT}.sig" "${VARIANT_CONTEXT}"
make_signed_variant "migration-pause" '.migrations[5].writerPause = "not-required"'
expect_rejected "a mismatched writer-pause requirement" \
  "${VARIANT_RECEIPT}" "${VARIANT_RECEIPT}.sig" "${VARIANT_CONTEXT}"
make_signed_variant "migration-scope" '.migrations[7].writerScopes = ["worker:graph-run"]'
expect_rejected "a mismatched writer scope" \
  "${VARIANT_RECEIPT}" "${VARIANT_RECEIPT}.sig" "${VARIANT_CONTEXT}"
make_signed_variant "migration-missing" '.migrations = .migrations[0:7]'
expect_rejected "a missing migration" \
  "${VARIANT_RECEIPT}" "${VARIANT_RECEIPT}.sig" "${VARIANT_CONTEXT}"
make_signed_variant "migration-extra" '.migrations += [.migrations[0]]'
expect_rejected "an extra migration" \
  "${VARIANT_RECEIPT}" "${VARIANT_RECEIPT}.sig" "${VARIANT_CONTEXT}"

# Signature verification uses the exact original JSON bytes and namespace.
cp "${HARNESS}/receipt.json" "${HARNESS}/tampered.json"
cp "${HARNESS}/receipt.json.sig" "${HARNESS}/tampered.json.sig"
jq '.changeTicket = "changed-after-signing"' "${HARNESS}/tampered.json" \
  >"${HARNESS}/tampered.next"
mv "${HARNESS}/tampered.next" "${HARNESS}/tampered.json"
expect_rejected "receipt bytes changed after signing" \
  "${HARNESS}/tampered.json" "${HARNESS}/tampered.json.sig" \
  "${HARNESS}/context.json"

cp "${HARNESS}/receipt.json" "${HARNESS}/wrong-namespace.json"
sign_receipt "${HARNESS}/wrong-namespace.json" \
  "${HARNESS}/approver-key" "workforce-os-migration-receipt"
expect_rejected "a signature from another namespace" \
  "${HARNESS}/wrong-namespace.json" "${HARNESS}/wrong-namespace.json.sig" \
  "${HARNESS}/context.json"

printf '{not-json\n' >"${HARNESS}/invalid.json"
cp "${HARNESS}/receipt.json.sig" "${HARNESS}/invalid.json.sig"
expect_rejected "invalid JSON" \
  "${HARNESS}/invalid.json" "${HARNESS}/invalid.json.sig" \
  "${HARNESS}/context.json"

# Strict parsing happens on the exact signed bytes before jq can normalize
# duplicate keys or ignore a trailing JSON value.
sed '1s/^{/{"schemaVersion":2,/' "${HARNESS}/receipt.json" \
  >"${HARNESS}/duplicate-key.json"
sign_receipt "${HARNESS}/duplicate-key.json"
expect_rejected "duplicate receipt keys" \
  "${HARNESS}/duplicate-key.json" "${HARNESS}/duplicate-key.json.sig" \
  "${HARNESS}/context.json"

cp "${HARNESS}/receipt.json" "${HARNESS}/trailing-value.json"
printf 'true\n' >>"${HARNESS}/trailing-value.json"
sign_receipt "${HARNESS}/trailing-value.json"
expect_rejected "a trailing JSON value" \
  "${HARNESS}/trailing-value.json" "${HARNESS}/trailing-value.json.sig" \
  "${HARNESS}/context.json"

sed '1s/^{/{"schemaVersion":1,/' "${HARNESS}/context.json" \
  >"${HARNESS}/duplicate-context.json"
duplicate_context_hash="$(file_hash "${HARNESS}/duplicate-context.json")"
jq --arg hash "${duplicate_context_hash}" '.admissionContextHash = $hash' \
  "${HARNESS}/receipt.json" >"${HARNESS}/duplicate-context-receipt.json"
sign_receipt "${HARNESS}/duplicate-context-receipt.json"
expect_rejected "duplicate controller-context keys" \
  "${HARNESS}/duplicate-context-receipt.json" \
  "${HARNESS}/duplicate-context-receipt.json.sig" \
  "${HARNESS}/duplicate-context.json"

dd if=/dev/zero of="${HARNESS}/oversized.json" bs=131073 count=1 2>/dev/null
cp "${HARNESS}/receipt.json.sig" "${HARNESS}/oversized.json.sig"
expect_rejected "an oversized receipt" \
  "${HARNESS}/oversized.json" "${HARNESS}/oversized.json.sig" \
  "${HARNESS}/context.json"

# Receipt freshness is strict and rechecked after signature/source validation.
future_prepared="$(jq -nr --argjson epoch "$((NOW_EPOCH + 300))" '$epoch | todateiso8601')"
future_expires="$(jq -nr --argjson epoch "$((NOW_EPOCH + 900))" '$epoch | todateiso8601')"
make_signed_variant "future" \
  ".preparedAt = \"${future_prepared}\" | .expiresAt = \"${future_expires}\""
expect_rejected "a future-dated receipt" \
  "${VARIANT_RECEIPT}" "${VARIANT_RECEIPT}.sig" "${VARIANT_CONTEXT}"

stale_prepared="$(jq -nr --argjson epoch "$((NOW_EPOCH - 7200))" '$epoch | todateiso8601')"
stale_expires="$(jq -nr --argjson epoch "$((NOW_EPOCH - 3600))" '$epoch | todateiso8601')"
make_signed_variant "stale" \
  ".preparedAt = \"${stale_prepared}\" | .expiresAt = \"${stale_expires}\""
expect_rejected "a stale receipt" \
  "${VARIANT_RECEIPT}" "${VARIANT_RECEIPT}.sig" "${VARIANT_CONTEXT}"

long_prepared_epoch=$((NOW_EPOCH - 30))
long_expires_epoch=$((long_prepared_epoch + 3601))
long_prepared="$(jq -nr --argjson epoch "${long_prepared_epoch}" '$epoch | todateiso8601')"
long_expires="$(jq -nr --argjson epoch "${long_expires_epoch}" '$epoch | todateiso8601')"
make_signed_variant "overlong" \
  ".preparedAt = \"${long_prepared}\" | .expiresAt = \"${long_expires}\""
expect_rejected "a receipt lifetime over 3600 seconds" \
  "${VARIANT_RECEIPT}" "${VARIANT_RECEIPT}.sig" "${VARIANT_CONTEXT}"

make_signed_variant "empty-window" '.expiresAt = .preparedAt'
expect_rejected "a nonpositive validity window" \
  "${VARIANT_RECEIPT}" "${VARIANT_RECEIPT}.sig" "${VARIANT_CONTEXT}"

mkdir -p "${HARNESS}/clock-bin"
cat >"${HARNESS}/clock-bin/date" <<'EOF'
#!/usr/bin/env bash
if [[ "$*" != "-u +%s" ]]; then
  exec /bin/date "$@"
fi
count=0
if [[ -s "${DATE_CALL_COUNT}" ]]; then count="$(<"${DATE_CALL_COUNT}")"; fi
count=$((count + 1))
printf '%s\n' "${count}" >"${DATE_CALL_COUNT}"
if [[ ${count} -eq 1 ]]; then
  printf '%s\n' "${DATE_FIRST_EPOCH}"
else
  printf '%s\n' "${DATE_FINAL_EPOCH}"
fi
EOF
chmod +x "${HARNESS}/clock-bin/date"

printf '0\n' >"${HARNESS}/date-call-count"
if env PATH="${HARNESS}/clock-bin:${PATH}" \
  DATE_CALL_COUNT="${HARNESS}/date-call-count" \
  DATE_FIRST_EPOCH="${EXPIRES_AT_EPOCH}" \
  DATE_FINAL_EPOCH="${EXPIRES_AT_EPOCH}" \
  "${VERIFIER}" \
    "${HARNESS}/receipt.json" "${HARNESS}/receipt.json.sig" \
    "${HARNESS}/allowed-signers" "${BACKEND_COMMIT}" \
    "${CONSOLE_COMMIT}" "${ATTEMPT_ID}" "${HARNESS}/context.json" \
    >/dev/null 2>&1; then
  fail "verifier accepted the exact expiresAt boundary"
fi
pass

printf '0\n' >"${HARNESS}/date-call-count"
if env PATH="${HARNESS}/clock-bin:${PATH}" \
  DATE_CALL_COUNT="${HARNESS}/date-call-count" \
  DATE_FIRST_EPOCH="${NOW_EPOCH}" \
  DATE_FINAL_EPOCH="${EXPIRES_AT_EPOCH}" \
  "${VERIFIER}" \
    "${HARNESS}/receipt.json" "${HARNESS}/receipt.json.sig" \
    "${HARNESS}/allowed-signers" "${BACKEND_COMMIT}" \
    "${CONSOLE_COMMIT}" "${ATTEMPT_ID}" "${HARNESS}/context.json" \
    >/dev/null 2>&1; then
  fail "verifier returned success after the receipt expired during verification"
fi
[[ "$(<"${HARNESS}/date-call-count")" == "2" ]] ||
  fail "verifier did not perform the final freshness recheck"
pass

# Every caller path rejects symlinks before the one-copy snapshot.
ln -s "${HARNESS}/receipt.json" "${HARNESS}/receipt-link.json"
expect_rejected "a symlinked receipt" \
  "${HARNESS}/receipt-link.json" "${HARNESS}/receipt.json.sig" \
  "${HARNESS}/context.json"
ln -s "${HARNESS}/receipt.json.sig" "${HARNESS}/receipt-link.sig"
expect_rejected "a symlinked signature" \
  "${HARNESS}/receipt.json" "${HARNESS}/receipt-link.sig" \
  "${HARNESS}/context.json"
ln -s "${HARNESS}/allowed-signers" "${HARNESS}/allowed-signers-link"
expect_rejected "a symlinked allowed-signers file" \
  "${HARNESS}/receipt.json" "${HARNESS}/receipt.json.sig" \
  "${HARNESS}/context.json" "${HARNESS}/allowed-signers-link"
ln -s "${HARNESS}/context.json" "${HARNESS}/context-link.json"
expect_rejected "a symlinked admission context" \
  "${HARNESS}/receipt.json" "${HARNESS}/receipt.json.sig" \
  "${HARNESS}/context-link.json"

# A second signer cannot replace the reviewed trust root.
ssh-keygen -q -t ed25519 -N '' -f "${HARNESS}/untrusted-key"
printf 'bootstrap-approver %s\n' "$(<"${HARNESS}/untrusted-key.pub")" \
  >"${HARNESS}/untrusted-allowed-signers"
cp "${HARNESS}/receipt.json" "${HARNESS}/untrusted.json"
sign_receipt "${HARNESS}/untrusted.json" "${HARNESS}/untrusted-key"
expect_rejected "an unpinned allowed-signers trust root" \
  "${HARNESS}/untrusted.json" "${HARNESS}/untrusted.json.sig" \
  "${HARNESS}/context.json" "${HARNESS}/untrusted-allowed-signers"

# The expected commit, not attacker-modified worktree bytes, supplies migration
# hashes. This also proves the verifier reads the old commit after HEAD moves.
printf '\n-- attacker-controlled worktree bytes\n' \
  >>"${FIXTURE_REPO}/${MIGRATIONS[0]}"
run_verifier \
  "${HARNESS}/receipt.json" "${HARNESS}/receipt.json.sig" \
  "${HARNESS}/allowed-signers" "${HARNESS}/context.json" >/dev/null ||
  fail "verifier consumed uncommitted migration bytes"
pass

# Literal UNCONFIGURED in the expected commit is a hard stop. Construct a
# fully matching receipt/context so no later identity mismatch can mask it.
printf 'UNCONFIGURED\n' \
  >"${FIXTURE_REPO}/docs/ops/production-migration-allowed-signers.sha256"
git -C "${FIXTURE_REPO}" add \
  "docs/ops/production-migration-allowed-signers.sha256"
git -C "${FIXTURE_REPO}" commit -q -m "fixture: unconfigured trust root"
UNCONFIGURED_COMMIT="$(git -C "${FIXTURE_REPO}" rev-parse HEAD)"
jq --arg commit "${UNCONFIGURED_COMMIT}" '
  .backendCandidateCommit = $commit
  | .releaseLock.objectSha = $commit
  | .targetArtifacts.api.ociRevision = $commit
  | .targetArtifacts.worker.ociRevision = $commit
' "${HARNESS}/context.json" >"${HARNESS}/unconfigured.context.json"
unconfigured_context_hash="$(file_hash "${HARNESS}/unconfigured.context.json")"
jq --arg commit "${UNCONFIGURED_COMMIT}" \
  --arg context_hash "${unconfigured_context_hash}" '
    .backendCandidateCommit = $commit
    | .releaseLock.objectSha = $commit
    | .targetArtifacts.api.ociRevision = $commit
    | .targetArtifacts.worker.ociRevision = $commit
    | .admissionContextHash = $context_hash
  ' "${HARNESS}/receipt.json" >"${HARNESS}/unconfigured.json"
sign_receipt "${HARNESS}/unconfigured.json"
if run_verifier \
  "${HARNESS}/unconfigured.json" "${HARNESS}/unconfigured.json.sig" \
  "${HARNESS}/allowed-signers" "${HARNESS}/unconfigured.context.json" \
  "${UNCONFIGURED_COMMIT}" >/dev/null 2>&1; then
  fail "verifier accepted an unconfigured reviewed trust-root pin"
fi
pass

# Mutating all four caller paths immediately after their single private copy
# cannot affect verification; none is reread from the caller path.
mkdir -p "${HARNESS}/copy-bin"
cat >"${HARNESS}/copy-bin/cp" <<'EOF'
#!/usr/bin/env bash
/bin/cp "$@" || exit $?
source_path=${2:-}
destination_path=${3:-}
case "${destination_path}" in
  */receipt.json) printf '\nchanged-after-private-copy\n' >>"${source_path}" ;;
  */receipt.sig) printf '\nchanged-after-private-copy\n' >>"${source_path}" ;;
  */allowed-signers) printf 'changed-after-private-copy\n' >>"${source_path}" ;;
  */admission-context.json) printf '\nchanged-after-private-copy\n' >>"${source_path}" ;;
esac
EOF
chmod +x "${HARNESS}/copy-bin/cp"
cp "${HARNESS}/receipt.json" "${HARNESS}/copy-once.json"
cp "${HARNESS}/receipt.json.sig" "${HARNESS}/copy-once.json.sig"
cp "${HARNESS}/allowed-signers" "${HARNESS}/copy-once-allowed-signers"
cp "${HARNESS}/context.json" "${HARNESS}/copy-once-context.json"
if ! env PATH="${HARNESS}/copy-bin:${PATH}" \
  "${VERIFIER}" \
    "${HARNESS}/copy-once.json" \
    "${HARNESS}/copy-once.json.sig" \
    "${HARNESS}/copy-once-allowed-signers" \
    "${BACKEND_COMMIT}" "${CONSOLE_COMMIT}" "${ATTEMPT_ID}" \
    "${HARNESS}/copy-once-context.json" >/dev/null; then
  fail "verifier reread caller-controlled evidence after its private copy"
fi
pass

echo "Production bootstrap entry receipt tests passed: ${TESTS_PASSED}"
