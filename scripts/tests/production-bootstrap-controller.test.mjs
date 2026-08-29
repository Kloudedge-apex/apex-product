import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  ACTIONS,
  MIGRATIONS,
  assertNextCatalogPlan,
  assertPostClerkCatalogPlan,
  attemptLeaseId,
  azureControlContainerRoleAssignmentScope,
  azureInheritedRoleAssignmentListArgs,
  buildAdmissionContext,
  classifyPreOpenActionReplay,
  matchesCapturedQuiescenceRevision,
  productionAuthorityDrainCheckpointSnapshot,
  parseAzureLeaseCommandOutput,
  runReplayableMutationSteps,
  runReplayableOrderedSteps,
  validateRequest,
  verifyDatabaseDdlAuthorityEvidence,
  verifyDeliverySafetyEvidence,
  verifyOperationalSmokeEvidence,
  writableRevisionTemplate,
} from "../production-bootstrap-controller.mjs";
import {
  PRODUCTION_AZURE_AUTHORITY_CONTRACT,
} from "../production-azure-mutation-authority-audit.mjs";
import {
  POST_CLERK_CATALOG_CONTRACT_HASH,
  POST_CLERK_MIGRATION_CONTRACT,
  POST_CLERK_MIGRATION_CONTRACT_HASH,
  POST_CLERK_MIGRATIONS,
} from "../verify-production-post-clerk-migration-catalog.mjs";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const CONTROLLER = resolve(TEST_DIR, "../production-bootstrap-controller.mjs");
const PHASE_RECEIPT_CONTRACT = resolve(
  TEST_DIR,
  "../production-bootstrap-phase-receipt-contracts.mjs",
);
const RUNTIME_CONTROL = resolve(TEST_DIR, "../production-bootstrap-runtime-control.ts");

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const DIGEST_A = `sha256:${"1".repeat(64)}`;
const DIGEST_B = `sha256:${"2".repeat(64)}`;
const DIGEST_C = `sha256:${"3".repeat(64)}`;
const SUBSCRIPTION = PRODUCTION_AZURE_AUTHORITY_CONTRACT.subscriptionId;
const RG = PRODUCTION_AZURE_AUTHORITY_CONTRACT.resourceGroupId;

function backendArtifact(role, digest = DIGEST_A) {
  const app = role === "api" ? "apex-gtm-api" : "apex-gtm-worker";
  return {
    image: `workforceosprodacr.azurecr.io/apex-api@${digest}`,
    manifestDigest: digest,
    platformDigest: DIGEST_B,
    ociRevision: SHA_A,
    platform: "linux/amd64",
    plannedRevision: `${app}--bootstrap-${role}-1234`,
    buildRunId: "1001",
    buildEvidenceHash: DIGEST_B,
    rehearsalEvidenceHash: DIGEST_C,
  };
}

function validRequest() {
  return {
    schemaVersion: 1,
    environment: "production",
    kind: "initial-production-bootstrap-request",
    attemptId: "0123456789abcdef0123456789abcdef",
    backendCandidate: {
      repository: "Kloudedge-apex/apex-product",
      branch: "master",
      commit: SHA_A,
    },
    consoleCandidate: {
      repository: "Kloudedge-apex/Workforce-OS",
      branch: "main",
      commit: SHA_B,
    },
    authority: {
      subscriptionId: SUBSCRIPTION,
      resourceGroupName: "workforce-os-prod",
      resourceGroupResourceId: RG,
      apiContainerAppResourceId: `${RG}/providers/Microsoft.App/containerApps/apex-gtm-api`,
      workerContainerAppResourceId: `${RG}/providers/Microsoft.App/containerApps/apex-gtm-worker`,
      consoleContainerAppResourceId: `${RG}/providers/Microsoft.App/containerApps/nikxius-web`,
    },
    storage: {
      accountName: "workforceosprodctrl",
      containerName: "production-control",
      blobName: "workforce-os/initial-production-bootstrap/state-v1.json",
      resourceId: PRODUCTION_AZURE_AUTHORITY_CONTRACT.targets.stateStorage.storageAccountResourceId,
    },
    targetArtifacts: {
      api: backendArtifact("api", DIGEST_A),
      worker: backendArtifact("worker", DIGEST_A),
      console: {
        image: `workforceosprodacr.azurecr.io/workforceos-fe@${DIGEST_C}`,
        manifestDigest: DIGEST_C,
        platformDigest: DIGEST_B,
        ociRevision: SHA_B,
        platform: "linux/amd64",
        plannedRevision: "nikxius-web--bootstrap-console-1234",
        buildRunId: "2001",
        buildEvidenceHash: DIGEST_B,
        rehearsalEvidenceHash: DIGEST_C,
        clientConfigEvidenceHash: DIGEST_A,
        smokeEvidenceHash: DIGEST_B,
      },
    },
    bootstrapEvidence: {
      stagingRehearsalEvidenceHash: DIGEST_A,
      backupRestoreEvidenceHash: DIGEST_B,
      failedListSmokeEvidenceHash: DIGEST_C,
      dashboardPolicySmokeEvidenceHash: DIGEST_A,
      azureMutationAuthorityEvidenceHash: DIGEST_B,
      azureMutationAuthorityStructuralEvidenceHash: DIGEST_C,
      databaseDdlAuthorityEvidenceHash: DIGEST_B,
      outstandingDeliveryReviewEvidenceHash: DIGEST_C,
      providerDeliveryDrainEvidenceHash: DIGEST_A,
    },
    databaseIdentityHash: DIGEST_A,
    redisIdentityHash: DIGEST_B,
    operator: "release.operator@example.com",
    approver: "release.approver@example.com",
    changeTicket: "CHG-2026-001",
    activationWorkerRevision: "apex-gtm-worker--bootstrap-first-class-1234",
  };
}

function mutate(path, value) {
  const request = structuredClone(validRequest());
  let cursor = request;
  for (const key of path.slice(0, -1)) cursor = cursor[key];
  cursor[path.at(-1)] = value;
  return request;
}

function hashBytes(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

test("request validator accepts only the exact reviewed request shape", () => {
  const request = validRequest();
  assert.equal(validateRequest(request), request);
  const withExtra = { ...request, surprise: true };
  assert.throws(() => validateRequest(withExtra), /unexpected or missing fields/);
});

test("request validator rejects mutable or wrong-repository artifacts", () => {
  assert.throws(
    () => validateRequest(mutate(["targetArtifacts", "api", "image"], "workforceosprodacr.azurecr.io/apex-api:latest")),
    /image is invalid/,
  );
  assert.throws(
    () => validateRequest(mutate(["targetArtifacts", "console", "image"], `evil.invalid/workforceos-fe@${DIGEST_C}`)),
    /image is invalid/,
  );
});

test("request validator rejects digest and OCI-source mismatches", () => {
  assert.throws(
    () => validateRequest(mutate(["targetArtifacts", "worker", "manifestDigest"], DIGEST_B)),
    /image and manifest digest differ/,
  );
  assert.throws(
    () => validateRequest(mutate(["targetArtifacts", "console", "ociRevision"], SHA_A)),
    /source or platform identity differs/,
  );
});

test("request validator rejects authority drift across exact resources", () => {
  assert.throws(
    () => validateRequest(mutate(["authority", "apiContainerAppResourceId"], `${RG}/providers/Microsoft.App/containerApps/not-api`)),
    /unexpected resource/,
  );
  assert.throws(
    () => validateRequest(mutate(["authority", "resourceGroupName"], "Other-rg")),
    /resource group is invalid/,
  );
  assert.throws(
    () => validateRequest(mutate(["authority", "subscriptionId"], "12345678-1234-4234-9234-123456789abc")),
    /fixed production authority subscription/,
  );
});

test("request validator rejects alternate state blobs and storage identities", () => {
  assert.throws(
    () => validateRequest(mutate(["storage", "blobName"], "workforce-os/another-state.json")),
    /fixed reviewed name/,
  );
  assert.throws(
    () => validateRequest(mutate(["storage", "resourceId"], `${RG}/providers/Microsoft.Storage/storageAccounts/otheraccount`)),
    /unexpected resource/,
  );
  const alternateAccount = validRequest();
  alternateAccount.storage.accountName = "otheraccount";
  alternateAccount.storage.resourceId =
    `${RG}/providers/Microsoft.Storage/storageAccounts/otheraccount`;
  assert.throws(
    () => validateRequest(alternateAccount),
    /storage identity is not the fixed production control store/,
  );
  assert.throws(
    () => validateRequest(mutate(["storage", "containerName"], "alternate-control")),
    /storage identity is not the fixed production control store/,
  );
});

test("Azure credential-drain readback is normalized from the exact blob response", () => {
  assert.deepEqual(productionAuthorityDrainCheckpointSnapshot({
    name: "workforce-os/initial-production-bootstrap/authority-drain-checkpoint-v1",
    properties: {
      lastModified: "2026-08-01T05:00:00Z",
      contentLength: 0,
      lease: { state: "available", status: "unlocked" },
    },
    metadata: { kind: "checkpoint" },
  }), {
    exists: true,
    blobName: "workforce-os/initial-production-bootstrap/authority-drain-checkpoint-v1",
    lastModified: "2026-08-01T05:00:00Z",
    contentLength: 0,
    leaseState: "available",
    leaseStatus: "unlocked",
    metadata: { kind: "checkpoint" },
  });
});

test("request validator enforces independent operator and approver", () => {
  assert.throws(
    () => validateRequest(mutate(["approver"], "release.operator@example.com")),
    /must differ/,
  );
});

test("Azure inherited role-assignment reads use the supported scoped CLI contract", () => {
  const request = validRequest();
  const scope = request.authority.apiContainerAppResourceId;
  assert.deepEqual(azureInheritedRoleAssignmentListArgs(request, scope), [
    "role", "assignment", "list",
    "--scope", scope,
    "--include-inherited",
    "--output", "json",
    "--subscription", SUBSCRIPTION,
    "--only-show-errors",
  ]);
});

test("Azure state authority reads target the exact control-container child scope", () => {
  const request = validRequest();
  assert.equal(
    azureControlContainerRoleAssignmentScope(request),
    `${request.storage.resourceId}/blobServices/default/containers/production-control`,
  );
});

test("request validator rejects an activation revision reused as disabled baseline", () => {
  assert.throws(
    () => validateRequest(mutate(["activationWorkerRevision"], validRequest().targetArtifacts.worker.plannedRevision)),
    /must differ/,
  );
});

test("delivery safety hashes are backed by strict attempt-bound protected evidence bytes", () => {
  const directory = mkdtempSync(join(tmpdir(), "bootstrap-delivery-evidence-"));
  try {
    const request = validRequest();
    const now = Math.floor(Date.now() / 1_000) * 1_000;
    const reviewedAt = new Date(now - 60_000).toISOString().replace(".000Z", "Z");
    const expiresAt = new Date(now + 30 * 60_000).toISOString().replace(".000Z", "Z");
    const outstanding = Buffer.from(`${JSON.stringify({
      schemaVersion: 1,
      environment: "production",
      kind: "production-outstanding-delivery-review",
      bootstrapAttemptId: request.attemptId,
      backendCandidateCommit: request.backendCandidate.commit,
      reviewer: request.approver,
      reviewedAt,
      expiresAt,
      outstandingDeliveryCount: 0,
      unresolvedDeliveryCount: 0,
      disposition: "no-outstanding-deliveries",
    })}\n`);
    const provider = Buffer.from(`${JSON.stringify({
      schemaVersion: 1,
      environment: "production",
      kind: "production-provider-delivery-drain",
      bootstrapAttemptId: request.attemptId,
      backendCandidateCommit: request.backendCandidate.commit,
      reviewer: request.approver,
      reviewedAt,
      expiresAt,
      providerScope: "all-configured-outbound-providers",
      inFlightDeliveryCount: 0,
      drainConfirmed: true,
    })}\n`);
    const outstandingPath = join(directory, "outstanding.json");
    const providerPath = join(directory, "provider.json");
    writeFileSync(outstandingPath, outstanding, { mode: 0o600 });
    writeFileSync(providerPath, provider, { mode: 0o600 });
    request.bootstrapEvidence.outstandingDeliveryReviewEvidenceHash = hashBytes(outstanding);
    request.bootstrapEvidence.providerDeliveryDrainEvidenceHash = hashBytes(provider);
    const evidence = verifyDeliverySafetyEvidence(request, {
      outstandingDeliveryReview: outstandingPath,
      providerDeliveryDrain: providerPath,
    });
    assert.equal(evidence.verifiedFromProtectedBytes, true);
    assert.equal(evidence.outstandingDeliveryReview.outstandingDeliveryCount, 0);
    assert.equal(evidence.providerDeliveryDrain.inFlightDeliveryCount, 0);

    const unsafeProvider = Buffer.from(provider.toString("utf8").replace(
      '"inFlightDeliveryCount":0',
      '"inFlightDeliveryCount":1',
    ));
    writeFileSync(providerPath, unsafeProvider, { mode: 0o600 });
    assert.throws(() => verifyDeliverySafetyEvidence(request, {
      outstandingDeliveryReview: outstandingPath,
      providerDeliveryDrain: providerPath,
    }), /do not match/);
    request.bootstrapEvidence.providerDeliveryDrainEvidenceHash = hashBytes(unsafeProvider);
    assert.throws(() => verifyDeliverySafetyEvidence(request, {
      outstandingDeliveryReview: outstandingPath,
      providerDeliveryDrain: providerPath,
    }), /in-flight deliveries/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("DDL authority and operational smoke claims are exact protected-byte bindings", () => {
  const directory = mkdtempSync(join(tmpdir(), "bootstrap-authority-evidence-"));
  try {
    const request = validRequest();
    const now = Math.floor(Date.now() / 1_000) * 1_000;
    const reviewedAt = new Date(now - 60_000).toISOString().replace(".000Z", "Z");
    const expiresAt = new Date(now + 30 * 60_000).toISOString().replace(".000Z", "Z");
    const ddl = Buffer.from(`${JSON.stringify({
      schemaVersion: 1,
      environment: "production",
      kind: "production-database-ddl-exclusive-authority",
      bootstrapAttemptId: request.attemptId,
      backendCandidateCommit: request.backendCandidate.commit,
      databaseIdentityHash: request.databaseIdentityHash,
      reviewer: request.approver,
      reviewedAt,
      expiresAt,
      authorityScope: "all-production-database-ddl-actors",
      exclusiveDdlAuthorityConfirmed: true,
    })}\n`);
    const failed = Buffer.from(`${JSON.stringify({
      schemaVersion: 1,
      environment: "production",
      kind: "production-failed-list-smoke",
      bootstrapAttemptId: request.attemptId,
      backendCandidateCommit: request.backendCandidate.commit,
      consoleCandidateCommit: request.consoleCandidate.commit,
      reviewer: request.approver,
      reviewedAt,
      expiresAt,
      scope: "api-failed-outreach-list",
      passed: true,
    })}\n`);
    const dashboard = Buffer.from(`${JSON.stringify({
      schemaVersion: 1,
      environment: "production",
      kind: "production-dashboard-policy-smoke",
      bootstrapAttemptId: request.attemptId,
      backendCandidateCommit: request.backendCandidate.commit,
      consoleCandidateCommit: request.consoleCandidate.commit,
      reviewer: request.approver,
      reviewedAt,
      expiresAt,
      scope: "console-dashboard-policy",
      passed: true,
    })}\n`);
    const ddlPath = join(directory, "ddl.json");
    const failedPath = join(directory, "failed.json");
    const dashboardPath = join(directory, "dashboard.json");
    writeFileSync(ddlPath, ddl, { mode: 0o600 });
    writeFileSync(failedPath, failed, { mode: 0o600 });
    writeFileSync(dashboardPath, dashboard, { mode: 0o600 });
    request.bootstrapEvidence.databaseDdlAuthorityEvidenceHash = hashBytes(ddl);
    request.bootstrapEvidence.failedListSmokeEvidenceHash = hashBytes(failed);
    request.bootstrapEvidence.dashboardPolicySmokeEvidenceHash = hashBytes(dashboard);

    const ddlBinding = verifyDatabaseDdlAuthorityEvidence(request, ddlPath);
    assert.equal(ddlBinding.bootstrapAttemptId, request.attemptId);
    assert.equal(ddlBinding.databaseIdentityHash, request.databaseIdentityHash);
    const smoke = verifyOperationalSmokeEvidence(request, {
      failedListSmokeEvidence: failedPath,
      dashboardPolicySmokeEvidence: dashboardPath,
    });
    assert.equal(smoke.failedList.evidenceHash, hashBytes(failed));
    assert.equal(smoke.dashboardPolicy.consoleCandidateCommit, request.consoleCandidate.commit);

    request.databaseIdentityHash = DIGEST_C;
    assert.throws(() => verifyDatabaseDdlAuthorityEvidence(request, ddlPath), /exact reviewed production window/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("attempt ID deterministically yields the Azure proposed lease UUID", () => {
  assert.equal(
    attemptLeaseId("0123456789abcdef0123456789abcdef"),
    "01234567-89ab-cdef-0123-456789abcdef",
  );
  assert.throws(() => attemptLeaseId("not-an-attempt"), /attemptId is invalid/);
});

test("Azure lease output accepts current string and legacy object response shapes", () => {
  const leaseId = attemptLeaseId("f8c1a08af7713932ec7a4a41288690e1");
  assert.equal(parseAzureLeaseCommandOutput(Buffer.from(JSON.stringify(leaseId))), leaseId);
  assert.equal(parseAzureLeaseCommandOutput(Buffer.from(JSON.stringify({ leaseId }))), leaseId);
  assert.equal(parseAzureLeaseCommandOutput(Buffer.from(JSON.stringify({ lease_id: leaseId.toUpperCase() }))), leaseId);
  assert.throws(() => parseAzureLeaseCommandOutput(Buffer.from("{}")), /Azure blob lease response is invalid/);
  assert.throws(
    () => parseAzureLeaseCommandOutput(Buffer.from(JSON.stringify("f8c1a08a-f771-3932-ec7a-4a41288690eg"))),
    /Azure blob lease response is invalid/,
  );
});

test("the controller exposes the complete bounded action set", () => {
  assert.deepEqual(ACTIONS, [
    "audit",
    "prepare",
    "invoke-clerk",
    "apply-schema",
    "deploy-compatible",
    "activate-first-class",
    "resume",
    "complete",
    "hold",
    "renew-hold",
  ]);
});

test("the controller fixes the exact nine-migration order", () => {
  assert.deepEqual(MIGRATIONS, [
    "docs/migrations/2026-08-13_clerk-identity-lifecycle-expand.sql",
    "docs/migrations/2026-06-01_outreach-artifact-unique.sql",
    "docs/migrations/2026-08-12_conversation-store-expand.sql",
    "docs/migrations/2026-08-12_outreach-delivery-unknown-expand.sql",
    "docs/migrations/2026-08-13_outreach-artifact-failed-expand.sql",
    "docs/migrations/2026-08-12_conversation-reply-single-flight-expand.sql",
    "docs/migrations/2026-08-12_graph-run-activity-expand.sql",
    "docs/migrations/2026-08-12_graph-run-lifecycle-expand.sql",
    "docs/migrations/2026-08-20_icp-exclusion-domains-expand.sql",
  ]);
});

test("ordered migration recovery resumes every persisted prefix from 2 through 9", () => {
  const ordered = MIGRATIONS.slice(1);
  for (let totalProgress = 2; totalProgress <= MIGRATIONS.length; totalProgress += 1) {
    const completed = MIGRATIONS.slice(1, totalProgress);
    const executed = [];
    const checkpoints = [];
    const result = runReplayableOrderedSteps({
      orderedSteps: ordered,
      completedSteps: completed,
      executeStep: (step) => executed.push(step),
      checkpoint: (prefix) => checkpoints.push(prefix),
    });
    assert.deepEqual(executed, ordered.slice(completed.length));
    assert.deepEqual(result, ordered);
    if (completed.length < ordered.length) assert.deepEqual(checkpoints.at(-1), ordered);
  }
});

test("lost migration acknowledgement is adopted before the durable prefix advances", () => {
  const ordered = MIGRATIONS.slice(1, 4);
  const database = new Set([ordered[0]]);
  let persisted = [ordered[0]];
  let inject = true;
  const execute = (step) => {
    database.add(step);
    if (step === ordered[1] && inject) {
      inject = false;
      throw new Error("synthetic lost psql acknowledgement");
    }
  };
  assert.throws(() => runReplayableOrderedSteps({
    orderedSteps: ordered,
    completedSteps: persisted,
    executeStep: execute,
    checkpoint: (prefix) => { persisted = prefix; },
  }), /lost psql acknowledgement/);
  assert.equal(database.has(ordered[1]), true);
  assert.deepEqual(persisted, [ordered[0]]);
  runReplayableOrderedSteps({
    orderedSteps: ordered,
    completedSteps: persisted,
    executeStep: execute,
    checkpoint: (prefix) => { persisted = prefix; },
  });
  assert.deepEqual(persisted, ordered);
  assert.deepEqual([...database], ordered);
});

test("B4 deployment replays adopt each partial or lost-ack cloud mutation", () => {
  const ordered = ["console", "api", "worker", "api-ingress-disabled"];
  for (const faultStep of ordered) {
    const live = new Set();
    let persisted = [];
    let inject = true;
    const executeStep = (step) => {
      const adopted = live.has(step);
      live.add(step);
      if (step === faultStep && inject) {
        inject = false;
        throw new Error(`synthetic ${step} lost acknowledgement`);
      }
      return { step, adopted };
    };
    assert.throws(() => runReplayableMutationSteps({
      orderedSteps: ordered,
      completedSteps: persisted,
      executeStep,
      checkpoint: (prefix) => { persisted = prefix; },
    }), /lost acknowledgement/);
    assert.equal(live.has(faultStep), true);
    runReplayableMutationSteps({
      orderedSteps: ordered,
      completedSteps: persisted,
      executeStep,
      checkpoint: (prefix) => { persisted = prefix; },
    });
    assert.deepEqual(persisted, ordered);
    assert.deepEqual([...live], ordered);
  }
});

test("B5 first-class worker mutation and persisted phase replay are executable", () => {
  assert.equal(classifyPreOpenActionReplay(
    { phase: "HELD", progressPhase: "B4_SCHEMA_VERIFIED" },
    "B4_SCHEMA_VERIFIED",
    "B5_COMPATIBLE_BASELINE",
  ), "first-attempt");
  assert.equal(classifyPreOpenActionReplay(
    { phase: "B5_COMPATIBLE_BASELINE", progressPhase: "B5_COMPATIBLE_BASELINE" },
    "B4_SCHEMA_VERIFIED",
    "B5_COMPATIBLE_BASELINE",
  ), "mutation-replay");
  assert.equal(classifyPreOpenActionReplay(
    { phase: "HELD", progressPhase: "B5_COMPATIBLE_BASELINE" },
    "B4_SCHEMA_VERIFIED",
    "B5_COMPATIBLE_BASELINE",
  ), "mutation-replay");
  assert.throws(() => classifyPreOpenActionReplay(
    { phase: "B6_FIRST_CLASS_ARMED", progressPhase: "B6_FIRST_CLASS_ARMED" },
    "B4_SCHEMA_VERIFIED",
    "B5_COMPATIBLE_BASELINE",
  ), /cannot enter/);

  const live = new Set();
  let persisted = [];
  let inject = true;
  const executeStep = (step) => {
    live.add(step);
    if (inject) {
      inject = false;
      throw new Error("synthetic worker lost acknowledgement");
    }
    return step;
  };
  assert.throws(() => runReplayableMutationSteps({
    orderedSteps: ["worker-first-class"],
    completedSteps: persisted,
    executeStep,
    checkpoint: (prefix) => { persisted = prefix; },
  }), /lost acknowledgement/);
  runReplayableMutationSteps({
    orderedSteps: ["worker-first-class"],
    completedSteps: persisted,
    executeStep,
    checkpoint: (prefix) => { persisted = prefix; },
  });
  assert.deepEqual(persisted, ["worker-first-class"]);
  assert.equal(live.has("worker-first-class"), true);
});

test("admission context removes the duplicate writer-fence epoch and preserves the closed state", () => {
  const request = validRequest();
  const writerFence = {
    schemaVersion: 1,
    target: "workforce-os-production",
    observedAt: "2026-08-14T10:00:10Z",
    generation: 3,
    state: {
      schemaVersion: 1,
      target: "workforce-os-production",
      mode: "closed",
      bootstrapAttemptId: request.attemptId,
      generation: 3,
      issuedAt: "2026-08-14T10:00:00Z",
      expiresAt: "2026-08-15T10:00:00Z",
    },
    epoch: {
      schemaVersion: 1,
      target: "workforce-os-production",
      mode: "closed",
      bootstrapAttemptId: request.attemptId,
      generation: 3,
      issuedAt: "2026-08-14T10:00:00Z",
      expiresAt: "2026-08-15T10:00:00Z",
    },
    stateHash: DIGEST_A,
    activeWriters: 0,
    activeComplianceWriters: 0,
    writerZero: true,
  };
  const queue = {
    name: "agent-runs",
    isPaused: true,
    workerCount: 0,
    waiting: 1,
    active: 0,
    delayed: 2,
    prioritized: 0,
    completed: 3,
    failed: 0,
    waitingChildren: 0,
    pausedJobs: 1,
  };
  const inventory = {
    databaseIdentityHash: request.databaseIdentityHash,
  };
  const first = {
    capturedAt: "2026-08-14T10:00:10Z",
    writerFence,
    queues: {
      agentRuns: queue,
      graphRuns: { ...queue, name: "graph-runs" },
      outreachSend: { ...queue, name: "outreach-send" },
    },
    database: inventory,
  };
  const second = structuredClone(first);
  second.capturedAt = "2026-08-14T10:00:15Z";
  second.writerFence.observedAt = "2026-08-14T10:00:15Z";
  const source = {
    sourceRollbackBaseline: {
      privateRestoreBundleHash: DIGEST_C,
    },
  };
  const context = buildAdmissionContext(
    request,
    source,
    first,
    second,
    "2026-08-14T09:59:59Z",
    { rawPlanSha256: DIGEST_A },
    {
      first: { api: { replicaCount: 0 }, worker: { replicaCount: 0 } },
      second: { api: { replicaCount: 0 }, worker: { replicaCount: 0 } },
      evidenceHash: DIGEST_B,
    },
    {
      schemaVersion: 1,
      target: "workforce-os-production",
      bootstrapAttemptId: request.attemptId,
      generation: 0,
      recoveredAt: "2026-08-14T10:00:09Z",
      stableZeroEvidenceHash: DIGEST_B,
      pre: {
        activeApplicationWriters: 0,
        activeComplianceWriters: 0,
        uncertainApplicationWriters: 1,
        uncertainComplianceWriters: 0,
        tokenSetHash: DIGEST_A,
      },
      post: {
        activeApplicationWriters: 0,
        activeComplianceWriters: 0,
        uncertainApplicationWriters: 0,
        uncertainComplianceWriters: 0,
        tokenSetHash: DIGEST_C,
      },
    },
  );
  assert.deepEqual(context.quiescedState.writerFence, {
    schemaVersion: second.writerFence.schemaVersion,
    target: second.writerFence.target,
    observedAt: second.writerFence.observedAt,
    generation: second.writerFence.generation,
    state: second.writerFence.state,
    stateHash: second.writerFence.stateHash,
    activeWriters: second.writerFence.activeWriters,
    activeComplianceWriters: second.writerFence.activeComplianceWriters,
    writerZero: second.writerFence.writerZero,
  });
  assert.equal(Object.hasOwn(context.quiescedState.writerFence, "epoch"), false);
  assert.equal(context.lease.generation, 3);
  assert.equal(context.quiescedState.orphanRecovery.post.uncertainApplicationWriters, 0);
  assert.equal(context.quiescedState.queueObservations[1].stableSince, first.capturedAt);
});

test("controller source never invokes the subsequent-rollout controller", () => {
  const source = readFileSync(CONTROLLER, "utf8");
  assert.doesNotMatch(source, /scripts\/deploy-prod\.sh/);
  assert.doesNotMatch(source, /\beval\s*\(/);
  assert.doesNotMatch(source, /shell:\s*true/);
  assert.doesNotMatch(source, /["'](?:bash|sh)["'],\s*\[\s*["']-c["']/);
  assert.match(source, /B3_SCHEMA_FORWARD_ONLY/);
  assert.match(source, /clerkInvocation: "uncertain"/);
  assert.match(source, /private-clerk-reconciliation-plan/);
});

test("migration execution is psql autocommit without an outer transaction flag", () => {
  const source = readFileSync(CONTROLLER, "utf8");
  const start = source.indexOf("function psqlMigration");
  const end = source.indexOf("function invokeClerk", start);
  const psqlSource = source.slice(start, end);
  assert.match(psqlSource, /"--no-psqlrc", "--set=ON_ERROR_STOP=1"/);
  assert.doesNotMatch(psqlSource, /"-1"/);
  assert.doesNotMatch(psqlSource, /--single-transaction/);
  assert.match(source, /PGPASSFILE must have mode 0600/);
});

test("post-Clerk catalog plans bind the exact next path and admitted SHA", () => {
  const plan = {
    contractHash: POST_CLERK_CATALOG_CONTRACT_HASH,
    migrationContractHash: POST_CLERK_MIGRATION_CONTRACT_HASH,
    admittedSequenceHash: DIGEST_A,
    catalogEvidenceHash: DIGEST_B,
    evidenceHash: DIGEST_C,
    outcome: "ready",
    reasonCode: "ABSENT_EXACT",
    nextPath: POST_CLERK_MIGRATIONS[0],
    nextMigrationSha256: POST_CLERK_MIGRATION_CONTRACT[0].sha256,
    nextClassification: "absent",
    action: "apply",
    lostAckAdopted: false,
    repairIndexes: [],
  };
  assert.equal(
    assertNextCatalogPlan(
      plan,
      0,
      POST_CLERK_MIGRATIONS[0],
      POST_CLERK_MIGRATION_CONTRACT[0].sha256,
    ),
    undefined,
  );
  assert.throws(
    () => assertNextCatalogPlan(
      plan,
      0,
      POST_CLERK_MIGRATIONS[1],
      POST_CLERK_MIGRATION_CONTRACT[0].sha256,
    ),
    /exact next migration/,
  );
  assert.throws(
    () => assertNextCatalogPlan(
      { ...plan, nextMigrationSha256: DIGEST_B },
      0,
      POST_CLERK_MIGRATIONS[0],
      POST_CLERK_MIGRATION_CONTRACT[0].sha256,
    ),
    /admitted next migration bytes/,
  );

  const complete = {
    ...plan,
    outcome: "complete",
    reasonCode: "SEQUENCE_COMPLETE",
    nextPath: null,
    nextMigrationSha256: null,
    nextClassification: "complete",
    action: "complete",
    lostAckAdopted: false,
  };
  assert.equal(
    assertPostClerkCatalogPlan(complete, POST_CLERK_MIGRATIONS.length),
    complete,
  );
});

test("controller delegates catalog decisions and performs bounded repair DDL separately", () => {
  const source = readFileSync(CONTROLLER, "utf8");
  assert.match(source, /verify-production-post-clerk-migration-catalog\.mjs/);
  assert.match(source, /planPostClerkMigrationCatalog/);
  assert.doesNotMatch(source, /MIGRATION_STATE_PROBES|probeMigrationState|ensureMigrationApplied/);

  const start = source.indexOf("function executePostClerkMigration");
  const end = source.indexOf("function invokeClerk", start);
  const execution = source.slice(start, end);
  const repairLoop = execution.indexOf("for (const indexName of preflight.plan.repairIndexes)");
  const drop = execution.indexOf(
    "psqlDropIndexConcurrently(runner, request, state, indexName)",
    repairLoop,
  );
  const reverify = execution.indexOf("readPostClerkCatalogPlan", drop);
  assert.ok(repairLoop >= 0 && repairLoop < drop && drop < reverify);

  const dropStart = source.indexOf("function psqlDropIndexConcurrently");
  const dropEnd = source.indexOf("function admittedPostClerkMigrations", dropStart);
  const dropFunction = source.slice(dropStart, dropEnd);
  assert.match(dropFunction, /DROP INDEX CONCURRENTLY \"public\"\.\"/);
  assert.equal((dropFunction.match(/DROP INDEX CONCURRENTLY/g) ?? []).length, 1);
  assert.doesNotMatch(dropFunction, /IF EXISTS/);
  const identity = dropFunction.indexOf("verifyProtectedPostgresIdentity(runner, request)");
  const lease = dropFunction.indexOf("verifyAzureLease(runner, request)", identity);
  const releaseLock = dropFunction.indexOf("verifyReleaseLock(runner, request)", lease);
  const mutation = dropFunction.indexOf('runner.run("psql"', releaseLock);
  assert.ok(identity >= 0 && identity < lease && lease < releaseLock && releaseLock < mutation);
});

test("controller state and evidence paths are external and non-overwriting", () => {
  const source = readFileSync(CONTROLLER, "utf8");
  assert.match(source, /must be outside the repository/);
  assert.match(source, /flag: "wx"/);
  assert.match(source, /state directory must have mode 0700/);
  assert.match(source, /bounded regular non-symlink single-link file/);
});

test("runtime resume is terminal-OPEN and ambiguity containment never recloses it", () => {
  const source = readFileSync(RUNTIME_CONTROL, "utf8");
  assert.match(source, /resumeProductionBootstrapQueues/);
  assert.match(source, /pauseProductionBootstrapQueues/);
  assert.match(source, /terminal OPEN writer-fence readback is ambiguous/);
  assert.match(source, /waitForPausedConnectedWorkers/);
  assert.match(source, /writerFenceReclosed: false/);
  assert.match(source, /terminal OPEN remains forward-only/);
  assert.doesNotMatch(source, /\breclose\b/);
});

test("lease cleanup occurs only after the B8 ledger transition", () => {
  const source = readFileSync(CONTROLLER, "utf8");
  const b8 = source.indexOf('toPhase: "B8_COMPLETE"');
  const releaseGit = source.indexOf("releaseReleaseLock(runner", b8);
  const releaseAzure = source.indexOf("releaseAzureLease(runner", b8);
  assert.ok(b8 > 0);
  assert.ok(releaseGit > b8);
  assert.ok(releaseAzure > releaseGit);
});

test("unsupported abort is absent from the bounded controller surface", () => {
  const source = readFileSync(CONTROLLER, "utf8");
  assert.doesNotMatch(source, /abort-before-schema/);
});

test("prepare replaces API and worker with zero-scale quiescence revisions before arming", () => {
  const source = readFileSync(CONTROLLER, "utf8");
  const start = source.indexOf("function prepare(");
  const end = source.indexOf("function materializeContext", start);
  const prepare = source.slice(start, end);
  const disable = prepare.indexOf("disableApiIngress(runner, request)");
  const pause = prepare.indexOf('"pause-only"');
  const apiStop = prepare.indexOf('"api",\n      quiescenceRevisionName(');
  const workerStop = prepare.indexOf('"worker",\n      quiescenceRevisionName(');
  const stableZero = prepare.indexOf("proveStableZeroExecutionReplicas(runner, request)");
  const orphanRecovery = prepare.indexOf('"recover-orphans"', stableZero);
  const arm = prepare.indexOf('"arm"');
  assert.ok(disable >= 0 && disable < pause);
  assert.ok(pause < apiStop && apiStop < workerStop);
  assert.ok(workerStop < stableZero && stableZero < orphanRecovery && orphanRecovery < arm);
  assert.match(prepare, /legacyReplicaEvidence\.evidenceHash/);
  assert.doesNotMatch(prepare, /containerapp", "revision", "deactivate/);
});

test("source live-send policy accepts exact empty but gates nonempty authority", () => {
  const source = readFileSync(CONTROLLER, "utf8");
  const start = source.indexOf("function captureSourceBaseline");
  const end = source.indexOf("function runRuntimeControl", start);
  const capture = source.slice(start, end);
  assert.match(capture, /originalAllowlist === null/);
  assert.match(capture, /entry\.trim\(\) === "\*"/);
  assert.match(capture, /originalAllowlistNonempty = originalAllowlist\.length > 0/);
  assert.match(capture, /OUTSTANDING_DELIVERY_REVIEW_CONFIRMED/);
  assert.match(capture, /PROVIDER_DELIVERY_DRAIN_CONFIRMED/);
  assert.doesNotMatch(capture, /nonempty, and non-wildcard/);
});

test("terminal OPEN crash boundaries are durably ordered and forward-only", () => {
  const source = readFileSync(CONTROLLER, "utf8");
  const start = source.indexOf("function resumeBootstrap");
  const end = source.indexOf("function completeBootstrap", start);
  const resume = source.slice(start, end);
  const b7 = resume.indexOf('toPhase: "B7_RESUMING"');
  const persistB7 = resume.indexOf("uploadState(runner, request, next, options.statePath)", b7);
  const renew = resume.indexOf('"renew"', persistB7);
  const persistRenewal = resume.indexOf("uploadState(runner, request, next, options.statePath)", renew);
  const intent = resume.indexOf("buildTerminalOpenIntent", persistRenewal);
  const persistIntent = resume.indexOf("uploadState(runner, request, next, options.statePath)", intent);
  const open = resume.indexOf('"resume"', persistIntent);
  const api = resume.indexOf("enableApiIngress", open);
  const completeContext = resume.indexOf('"bootstrap-complete"', api);
  assert.ok(b7 >= 0 && b7 < persistB7);
  assert.ok(persistB7 < renew && renew < persistRenewal);
  assert.ok(persistRenewal < intent && intent < persistIntent && persistIntent < open);
  assert.ok(open < api && api < completeContext);
  assert.match(resume, /TERMINAL_OPEN_FORWARD_ONLY_HOLD/);
  assert.match(resume, /quiesceAppWithParentWrite\(/);
  assert.match(resume, /proveStableZeroExecutionReplicas\(runner, request\)/);
  assert.doesNotMatch(resume, /["']reclose["']/);
});

test("B8 cleanup is checkpointed before conditional authority release", () => {
  const source = readFileSync(CONTROLLER, "utf8");
  const start = source.indexOf("function completeBootstrap");
  const end = source.indexOf("function holdCurrent", start);
  const complete = source.slice(start, end);
  const b8 = complete.indexOf('toPhase: "B8_COMPLETE"');
  const tombstoneUpload = complete.indexOf("uploadState(runner, request, next, options.statePath)", b8);
  const releaseGit = complete.indexOf("releaseReleaseLock(runner", tombstoneUpload);
  const gitCheckpoint = complete.indexOf("releaseLockReleased: true", releaseGit);
  const checkpointUpload = complete.indexOf("uploadState(runner, request, next, options.statePath)", gitCheckpoint);
  const releaseAzure = complete.indexOf("releaseAzureLease(runner", checkpointUpload);
  assert.ok(b8 >= 0 && b8 < tombstoneUpload);
  assert.ok(tombstoneUpload < releaseGit && releaseGit < gitCheckpoint);
  assert.ok(gitCheckpoint < checkpointUpload && checkpointUpload < releaseAzure);
  assert.match(complete, /cleanupReplay/);
  assert.match(complete, /B8 cleanup replay supplied different bootstrap-complete receipt bytes/);
});

test("B8 binds a fresh terminal-OPEN ACA, queue, database, ingress, and readiness proof", () => {
  const source = readFileSync(CONTROLLER, "utf8");
  const start = source.indexOf("function completeBootstrap");
  const end = source.indexOf("function holdCurrent", start);
  const complete = source.slice(start, end);
  const signedReceipt = complete.indexOf("verifyPhaseReceipt");
  const freshReadback = complete.indexOf("captureFreshCompletionReadback", signedReceipt);
  const b8 = complete.indexOf('toPhase: "B8_COMPLETE"', freshReadback);
  const binding = complete.indexOf("completionEvidenceHash: finalCompletionReadback.evidenceHash", b8);
  const stateUpload = complete.indexOf("uploadState(runner, request, next, options.statePath)", binding);
  const release = complete.indexOf("releaseReleaseLock(runner", stateUpload);
  assert.ok(signedReceipt >= 0 && signedReceipt < freshReadback);
  assert.ok(freshReadback < b8 && b8 < binding && binding < stateUpload && stateUpload < release);

  const freshStart = source.indexOf("function captureFreshCompletionReadback");
  const freshEnd = source.indexOf("function resumeBootstrap", freshStart);
  const fresh = source.slice(freshStart, freshEnd);
  assert.match(fresh, /"read-open"/);
  assert.match(fresh, /runtime\.database/);
  assert.match(fresh, /"waiting", "active", "delayed", "prioritized", "waitingChildren", "pausedJobs"/);
  assert.match(fresh, /deploymentEvidence/);
  assert.match(fresh, /verifyApiIngressLive/);
  assert.match(fresh, /verifyLiveReleaseConfiguration/);
  assert.match(fresh, /assertPersistedOperationalSmokeEvidence/);
  assert.match(fresh, /liveSendAllowlistEmpty: true/);
  assert.match(fresh, /completion API \/api\/health\/ready|verifyApiIngressLive/);
  const ingressStart = source.indexOf("function verifyApiIngressLive");
  const ingressEnd = source.indexOf("function bootstrapStep", ingressStart);
  const ingress = source.slice(ingressStart, ingressEnd);
  assert.match(ingress, /ingress\.allowInsecure === false/);
  assert.match(ingress, /ingress\.transport === expectedTransport/);
  assert.match(ingress, /activeRevisionsMode === "Single"/);
  assert.match(ingress, /traffic\[0\]\?\.latestRevision === true/);
  assert.match(ingress, /provisioningState === "Succeeded"/);
  assert.match(ingress, /API ingress enable readiness interval/);
  const enableStart = source.indexOf("function enableApiIngress");
  const enable = source.slice(enableStart, ingressStart);
  assert.match(enable, /"rest"/);
  assert.match(enable, /"--method", "patch"/);
  assert.match(enable, /configuration: \{ ingress \}/);
  assert.doesNotMatch(enable, /"ingress", "traffic", "set"/);
  assert.doesNotMatch(enable, /"containerapp", "ingress", "enable"|revisionSuffix/);

  const resumeStart = source.indexOf("function resumeBootstrap");
  const resumeEnd = source.indexOf("function completeBootstrap", resumeStart);
  const resume = source.slice(resumeStart, resumeEnd);
  assert.match(resume, /releaseConfigEvidenceHash: releaseConfiguration\.evidenceHash/);
  assert.match(resume, /failedListSmokeEvidenceHash: operationalSmokeEvidence\.failedList\.evidenceHash/);
  assert.doesNotMatch(resume, /apiReady:\s*true|workerReady:\s*true|consoleReady:\s*true/);
});

test("release-lock cleanup adopts absence and lost delete acknowledgement only after readback", () => {
  const source = readFileSync(CONTROLLER, "utf8");
  const start = source.indexOf("function releaseReleaseLock");
  const end = source.indexOf("function writeNewEvidence", start);
  const cleanup = source.slice(start, end);
  const preRead = cleanup.indexOf("readReleaseLock(runner)");
  const absentAdoption = cleanup.indexOf("existing === null", preRead);
  const conditionalDelete = cleanup.indexOf("--force-with-lease", absentAdoption);
  const lostAckRead = cleanup.indexOf("readReleaseLock(runner)", conditionalDelete);
  const finalRead = cleanup.indexOf("readReleaseLock(runner)", lostAckRead + 1);
  assert.ok(preRead >= 0 && preRead < absentAdoption);
  assert.ok(absentAdoption < conditionalDelete && conditionalDelete < lostAckRead);
  assert.ok(lostAckRead < finalRead);
  assert.match(cleanup, /acknowledgementUncertain: true/);
  assert.match(cleanup, /cleanup readback is ambiguous/);
});

test("same-commit release-lock adoption requires the exact leased attempt journal", () => {
  const source = readFileSync(CONTROLLER, "utf8");
  const start = source.indexOf("function acquireReleaseLock");
  const end = source.indexOf("function readReleaseLock", start);
  const lock = source.slice(start, end);
  const lease = lock.indexOf("verifyAzureLease(runner, request)");
  const leasedDocument = lock.indexOf("downloadLeasedDocumentMaybe", lease);
  const validateJournal = lock.indexOf("validatePreparationJournal", leasedDocument);
  const inspectRef = lock.indexOf("readReleaseLock(runner)", validateJournal);
  assert.ok(lease >= 0 && lease < leasedDocument);
  assert.ok(leasedDocument < validateJournal && validateJournal < inspectRef);
  assert.match(lock, /stale ref alone is therefore never authority/);
});

test("preparation rebind is limited to pre-mutation boundaries with live source readback", () => {
  const source = readFileSync(CONTROLLER, "utf8");
  const validatorStart = source.indexOf("function validateRebindablePreparationJournal");
  const validatorEnd = source.indexOf("function preparationJournal", validatorStart);
  const validator = source.slice(validatorStart, validatorEnd);
  assert.match(validator, /journal\.stage === "B0_SOURCE_CAPTURE_INTENT"/);
  assert.match(validator, /journal\.stage === "B0_API_INGRESS_DISABLE_INTENT"/);
  assert.match(validator, /journal\.stage === "B0_QUEUE_PAUSE_INTENT"/);
  assert.match(validator, /journal\.stage === "B0_APP_STOP_INTENT"/);
  assert.match(validator, /journal\.stage === "B0_WRITER_FENCE_ARMED"/);
  assert.match(validator, /journal\.intent\.operation === "capture-source-baseline"/);
  assert.match(validator, /journal\.intent\.operation === "disable-api-ingress"/);
  assert.match(validator, /journal\.intent\.operation === "pause-queues"/);
  assert.match(validator, /journal\.intent\.operation === "stop-app-revisions"/);
  assert.match(validator, /journal\.intent\.operation === "arm-writer-fence"/);
  assert.match(validator, /allowPartialQuiescence: appStopBoundary/);
  assert.match(validator, /requireHeldRuntime: writerFenceArmedBoundary/);
  assert.match(validator, /plan\.backendCandidateCommit === request\.backendCandidate\.commit/);

  const rebindStart = source.indexOf("function rebindReleaseLockForPreparation");
  const rebindEnd = source.indexOf("function readReleaseLock", rebindStart);
  const rebind = source.slice(rebindStart, rebindEnd);
  assert.match(rebind, /verifyAzureLease\(runner, request\)/);
  assert.match(rebind, /existing\.object\?\.sha !== previousBackendCommit/);
  assert.match(rebind, /--force-with-lease=\$\{RELEASE_LOCK_REF\}:\$\{previousBackendCommit\}/);
  assert.match(rebind, /verifyReleaseLock\(runner, request\)/);

  const prepareStart = source.indexOf("function prepare(");
  const prepareEnd = source.indexOf("function verifyReceiptEnvelope", prepareStart);
  const prepare = source.slice(prepareStart, prepareEnd);
  const validate = prepare.indexOf("validateRebindablePreparationJournal");
  const signatures = prepare.indexOf("verifySupersededPreparationSignatures", validate);
  const sourceReadback = prepare.indexOf("refreshCapturedSourceForRebind", signatures);
  const runtimeReadback = prepare.indexOf('"read",', sourceReadback);
  const lock = prepare.indexOf("rebindReleaseLockForPreparation", runtimeReadback);
  const journal = prepare.indexOf("preparationJournal(request, clerkReconciliation)", lock);
  const upload = prepare.indexOf("uploadState(runner, request, journal, options.statePath)", journal);
  assert.ok(validate >= 0 && validate < signatures && signatures < sourceReadback);
  assert.ok(sourceReadback < runtimeReadback && runtimeReadback < lock);
  assert.ok(lock < journal && journal < upload);
  assert.match(prepare, /superseded\.allowPartialQuiescence/);
  assert.match(prepare, /validateRebindablePreparedState/);
  assert.match(prepare, /options\.supersededRequest/);
  assert.match(prepare, /superseded prepared state still has connected queue workers/);
});

test("prepared-state rebind is limited to the duplicated CLOSED epoch defect before migration", () => {
  const source = readFileSync(CONTROLLER, "utf8");
  const start = source.indexOf("function validateRebindablePreparedState");
  const end = source.indexOf("function verifySupersededPreparationSignatures", start);
  const validator = source.slice(start, end);
  assert.match(validator, /B1_CONTROL_ACQUIRED/);
  assert.match(validator, /state\.migrationProgress\.length !== 0/);
  assert.match(validator, /Object\.keys\(state\.activeIdentities\)\.length !== 0/);
  assert.match(validator, /"activeComplianceWriters", "activeWriters", "epoch"/);
  assert.match(validator, /canonicalJson\(writerFence\.epoch\) !== canonicalJson\(writerFence\.state\)/);
  assert.match(validator, /superseded prepared state changed the console artifact/);
});

test("runtime control helpers are invoked through the Corepack-managed pnpm binary", () => {
  const source = readFileSync(CONTROLLER, "utf8");
  const runtimeStart = source.indexOf("function runRuntimeControl");
  const runtimeEnd = source.indexOf("function assertRuntimeHeldEvidence", runtimeStart);
  const runtime = source.slice(runtimeStart, runtimeEnd);
  const quiescenceStart = source.indexOf("function runQuiescence");
  const quiescenceEnd = source.indexOf("function azureMutation", quiescenceStart);
  const quiescence = source.slice(quiescenceStart, quiescenceEnd);
  assert.match(runtime, /runner\.run\("corepack", \["pnpm", \.\.\.args\]/);
  assert.match(quiescence, /runner\.run\("corepack", \["pnpm",/);
  assert.match(quiescence, /"--filter", "@apex\/api", "exec", "tsx"/);
  assert.match(quiescence, /production-bootstrap-quiescence\.cli\.ts/);
  assert.doesNotMatch(quiescence, /ops:production-bootstrap-quiescence/);
  assert.doesNotMatch(runtime, /runner\.run\("pnpm"/);
  assert.doesNotMatch(quiescence, /runner\.run\("pnpm"/);
});

test("API ingress disable uses a least-privilege PATCH and never requests secret values", () => {
  const source = readFileSync(CONTROLLER, "utf8");
  const start = source.indexOf("function disableApiIngress");
  const end = source.indexOf("function replicaObservation", start);
  const disable = source.slice(start, end);
  assert.match(disable, /"rest"/);
  assert.match(disable, /"--method", "patch"/);
  assert.match(disable, /configuration: \{ ingress: null \}/);
  assert.match(disable, /API ingress disable readiness interval/);
  assert.doesNotMatch(disable, /listSecrets|list-secrets|"ingress", "disable"/);
});

test("Container App updates use bounded parent mutation paths and deterministic recovery suffixes", () => {
  const source = readFileSync(CONTROLLER, "utf8");
  const quiesceStart = source.indexOf("function quiesceAppWithParentWrite");
  const quiesceEnd = source.indexOf("function disableApiIngress", quiesceStart);
  const updateStart = source.indexOf("function updateApp");
  const updateEnd = source.indexOf("function revisionEnv", updateStart);
  const mutationPaths = `${source.slice(quiesceStart, quiesceEnd)}\n${source.slice(updateStart, updateEnd)}`;
  assert.match(mutationPaths, /"rest"/);
  assert.match(mutationPaths, /"--method", "patch"/);
  assert.match(mutationPaths, /unhealthy bootstrap revision is not safely replaceable/);
  assert.match(mutationPaths, /before\.properties\?\.latestReadyRevisionName === revision/);
  assert.match(mutationPaths, /const recoveryRevision = `\$\{revision\}-r1`/);
  assert.match(mutationPaths, /recovery revision name exceeds the Azure limit/);
  assert.match(mutationPaths, /"containerapp", "revision", "copy"/);
  assert.match(mutationPaths, /"--from-revision", copyFromRevision/);
  assert.match(mutationPaths, /failed-parent revision-copy repair posture is invalid/);
  assert.match(mutationPaths, /before\.properties\?\.deploymentErrors !== expectedDeploymentError/);
  assert.doesNotMatch(mutationPaths, /"--method", "delete"/);
  assert.doesNotMatch(mutationPaths, /listSecrets|list-secrets|"containerapp", "update"|--show-secrets/);
  assert.doesNotMatch(source, /"containerapp", "revision", "deactivate"/);
});

test("disabled production baselines satisfy the API startup contract", () => {
  const source = readFileSync(CONTROLLER, "utf8");
  const start = source.indexOf("function deployCompatible");
  const end = source.indexOf("function activateFirstClass", start);
  const deploy = source.slice(start, end);
  assert.match(deploy, /"EVIDENCE_LEDGER_ENABLED=true"/);
  assert.match(deploy, /"OUTREACH_DELIVERY_UNKNOWN_WRITE_MODE=disabled"/);
  assert.match(deploy, /"OUTREACH_ROLLBACK_COMPATIBILITY_EPOCH",/);
  assert.doesNotMatch(
    deploy,
    /OUTREACH_ROLLBACK_COMPATIBILITY_EPOCH=outreach-delivery-unknown-v1/,
  );
});

test("first-class recovery restores captured entrypoints before consumers resume", () => {
  const source = readFileSync(CONTROLLER, "utf8");
  const activationStart = source.indexOf("function activateFirstClass");
  const activationEnd = source.indexOf("function verifyApiIngressLive", activationStart);
  const recoveryStart = source.indexOf("function ensureFirstClassDeploymentsForResume");
  const resumeStart = source.indexOf("function resumeBootstrap");
  const resumeEnd = source.indexOf("function completeBootstrap", resumeStart);
  const containmentStart = source.indexOf("function quiesceAppWithParentWrite");
  const containmentEnd = source.indexOf("function disableApiIngress", containmentStart);
  const activation = source.slice(activationStart, activationEnd);
  const recovery = source.slice(recoveryStart, resumeStart);
  const resume = source.slice(resumeStart, resumeEnd);
  const containment = source.slice(containmentStart, containmentEnd);
  assert.match(
    activation,
    /state\.privateRestoreBundle\.workerRevision\.properties\.template/,
  );
  assert.match(activation, /RETIRED_WORKER_ENVIRONMENT/);
  assert.match(resume, /ensureFirstClassDeploymentsForResume/);
  assert.match(resume, /activationRecovery: deploymentRecovery\.recovery/);
  assert.match(resume, /pausedRuntime\.evidenceHash/);
  assert.match(recovery, /CLERK_WEBHOOK_SECRET=secretref:clerk-webhook-secret/);
  assert.match(recovery, /workerSecretBinding/);
  assert.match(recovery, /boundedRecoverySequence/);
  assert.match(recovery, /partialRecoveryObserved/);
  assert.match(recovery, /workerQuiescent\.some\(Boolean\)/);
  assert.match(recovery, /allowIngressDisabledParentFailure: true/);
  assert.match(containment, /sourceRevisionName/);
  assert.match(containment, /bounded quiescence recovery sequence/);
});

test("stored recovery admits only the exact ingress-disabled API parent failure", () => {
  const source = readFileSync(CONTROLLER, "utf8");
  const start = source.indexOf("function deploymentEvidence");
  const end = source.indexOf("function validateFirstClassRecoveryEvidence", start);
  const deployment = source.slice(start, end);
  assert.match(deployment, /role === "api" && allowIngressDisabledParentFailure/);
  assert.match(deployment, /provisioningState === "Failed"/);
  assert.match(deployment, /configuration\?\.ingress === null/);
  assert.match(deployment, /activeRevisionsMode === "Single"/);
  assert.match(deployment, /latestReadyRevisionName === revisionName/);
  assert.match(deployment, /provisioningState !== "Succeeded" && !containedApiParentFailure/);
});

test("stored recovery rerolls exact successors when the ingress-disabled API parent remains failed", () => {
  const source = readFileSync(CONTROLLER, "utf8");
  const start = source.indexOf("function ensureFirstClassDeploymentsForResume");
  const end = source.indexOf("function disabledWriteGates", start);
  const recovery = source.slice(start, end);
  assert.match(recovery, /const apiParentRepairRequired =/);
  assert.match(recovery, /apiParent\.properties\?\.provisioningState === "Failed"/);
  assert.match(recovery, /apiParent\.properties\?\.configuration\?\.ingress === null/);
  assert.match(recovery, /activeRevisionsMode === "Single"/);
  assert.match(recovery, /latestReadyRevisionName === state\.activeIdentities\.api/);
  assert.match(recovery, /if \(!apiParentRepairRequired\) \{\s*return \{ state, recovery: validatedRecovery \};/);
  assert.match(recovery, /validatedStoredRecoveryParentRepair = true/);
  assert.match(recovery, /workerQuiescent\.some\(Boolean\) \|\| validatedStoredRecoveryParentRepair/);
  assert.match(recovery, /copyFromRevision: state\.activeIdentities\.api/);
  assert.match(recovery, /conflictingRevisionSuffix: `bootstrap-hold-\$\{terminalOpenGeneration\}`/);
  assert.match(recovery, /const partialRecoveryObserved =/);
  assert.match(recovery, /!partialRecoveryObserved/);
});

test("protected recovery snapshots are descendant-only and file-scope bounded", () => {
  const source = readFileSync(CONTROLLER, "utf8");
  const start = source.indexOf("function assertExactProtectedSnapshot");
  const end = source.indexOf("export function productionAuthorityDrainCheckpointSnapshot", start);
  const assertion = source.slice(start, end);
  assert.match(assertion, /merge-base", "--is-ancestor"/);
  assert.match(assertion, /changed\.some\(\(path\) => !allowed\.has\(path\)\)/);
  assert.match(assertion, /a recovery controller successor is permitted only after schema application/);
  assert.match(assertion, /scripts\/production-bootstrap-controller\.mjs/);
  assert.match(assertion, /docs\/ops\/production-bootstrap-phase-receipt\.schema\.json/);
  assert.match(assertion, /scripts\/tests\/production-bootstrap-phase-ledger\.test\.mjs/);
  assert.match(assertion, /scripts\/tests\/production-bootstrap-phase-receipt\.fixture\.mjs/);
});

test("B5 receipt contract permits only the exact first recovery revision suffix", () => {
  const source = readFileSync(PHASE_RECEIPT_CONTRACT, "utf8");
  assert.match(source, /actual === target \|\| actual === `\$\{target\}-r1`/);
  assert.doesNotMatch(source, /-r2/);
});

test("Container App PATCH templates omit readback-only template properties", () => {
  const source = {
    revisionSuffix: "old-revision",
    scale: {
      minReplicas: 1,
      maxReplicas: 1,
      cooldownPeriod: 300,
      pollingInterval: 30,
      rules: [],
    },
    containers: [{
      name: "api",
      image: "example.invalid/api@sha256:deadbeef",
      imageType: "ContainerImage",
      resources: { cpu: 1, memory: "2Gi", ephemeralStorage: "4Gi" },
    }],
  };
  const writable = writableRevisionTemplate(source);

  assert.deepEqual(writable, {
    scale: { minReplicas: 1, maxReplicas: 1, rules: [] },
    containers: [{
      name: "api",
      image: "example.invalid/api@sha256:deadbeef",
      resources: { cpu: 1, memory: "2Gi" },
    }],
  });
  assert.equal(source.revisionSuffix, "old-revision");
  assert.equal(source.scale.cooldownPeriod, 300);
  assert.equal(source.scale.pollingInterval, 30);
  assert.equal(source.containers[0].imageType, "ContainerImage");
  assert.equal(source.containers[0].resources.ephemeralStorage, "4Gi");
});

test("preparation rebind accepts only exact partial-quiescence revisions", () => {
  const image = `example.invalid/api@sha256:${"a".repeat(64)}`;
  const sourceTemplate = {
    revisionSuffix: "source",
    scale: { minReplicas: 1, maxReplicas: 3, rules: null, cooldownPeriod: 300 },
    containers: [{
      name: "api",
      image,
      imageType: "ContainerImage",
      env: [{ name: "NODE_ENV", value: "production" }],
      resources: { cpu: 1, memory: "2Gi", ephemeralStorage: "4Gi" },
    }],
  };
  const revision = {
    name: "apex-gtm-api--bootstrap-quiesce-f8c1a08",
    properties: {
      active: true,
      healthState: "Healthy",
      provisioningState: "Provisioned",
      template: {
        scale: { minReplicas: 0, maxReplicas: 1, rules: null },
        containers: [{
          name: "api",
          image,
          env: [
            { name: "GMAIL_WATCH_RENEWAL_ENABLED", value: "false" },
            { name: "GRAPH_RUN_WORKER_ENABLED", value: "false" },
            { name: "NODE_ENV", value: "production" },
            { name: "OUTREACH_WORKER_ENABLED", value: "false" },
            { name: "SCHEDULER_ENABLED", value: "false" },
            { name: "USAGE_ROLLUP_WORKER_ENABLED", value: "false" },
            { name: "WORKER_ENABLED", value: "false" },
          ],
          resources: { cpu: 1, memory: "2Gi" },
        }],
      },
    },
  };

  assert.equal(matchesCapturedQuiescenceRevision(
    revision,
    sourceTemplate,
    image,
    "apex-gtm-api",
    "api",
    "f8c1a08af7713932ec7a4a41288690e1",
  ), true);
  assert.equal(matchesCapturedQuiescenceRevision(
    revision,
    sourceTemplate,
    image,
    "apex-gtm-api",
    "console",
    "f8c1a08af7713932ec7a4a41288690e1",
  ), false);
  assert.equal(matchesCapturedQuiescenceRevision(
    { ...revision, name: "apex-gtm-api--bootstrap-quiesce-other" },
    sourceTemplate,
    image,
    "apex-gtm-api",
    "api",
    "f8c1a08af7713932ec7a4a41288690e1",
  ), false);

  const unhealthyRevision = {
    ...revision,
    properties: { ...revision.properties, healthState: null },
  };
  assert.equal(matchesCapturedQuiescenceRevision(
    unhealthyRevision,
    sourceTemplate,
    image,
    "apex-gtm-api",
    "api",
    "f8c1a08af7713932ec7a4a41288690e1",
  ), false);
  assert.equal(matchesCapturedQuiescenceRevision(
    unhealthyRevision,
    sourceTemplate,
    image,
    "apex-gtm-api",
    "api",
    "f8c1a08af7713932ec7a4a41288690e1",
    false,
  ), true);

  const workerSource = {
    ...sourceTemplate,
    containers: [{ ...sourceTemplate.containers[0], name: "worker" }],
  };
  const idleWorker = {
    name: "apex-gtm-worker--bootstrap-quiesce-idle-f8c1a08",
    properties: {
      active: true,
      healthState: "Healthy",
      provisioningState: "Provisioned",
      template: {
        scale: { minReplicas: 0, maxReplicas: 1, rules: null },
        containers: [{
          name: "worker",
          image,
          command: ["node"],
          args: [
            "-e",
            "require('node:http').createServer((_request, response) => { response.writeHead(200); response.end('ok'); }).listen(4000, '0.0.0.0')",
          ],
          env: revision.properties.template.containers[0].env,
          resources: { cpu: 1, memory: "2Gi" },
        }],
      },
    },
  };
  assert.equal(matchesCapturedQuiescenceRevision(
    idleWorker,
    workerSource,
    image,
    "apex-gtm-worker",
    "worker",
    "f8c1a08af7713932ec7a4a41288690e1",
  ), true);
  assert.equal(matchesCapturedQuiescenceRevision(
    {
      ...idleWorker,
      name: "apex-gtm-worker--bootstrap-quiesce-idle-f8c1a08-4065c76",
    },
    workerSource,
    image,
    "apex-gtm-worker",
    "worker",
    "f8c1a08af7713932ec7a4a41288690e1",
    true,
    "4065c7613d346cd0237eef6083e72a45b11196be",
  ), true);
  const commitBoundWorkerName = "apex-gtm-worker--bqi-f8c1a08-5ecb0ee";
  assert.ok(commitBoundWorkerName.length <= 54);
  assert.equal(matchesCapturedQuiescenceRevision(
    {
      ...idleWorker,
      name: commitBoundWorkerName,
    },
    workerSource,
    image,
    "apex-gtm-worker",
    "worker",
    "f8c1a08af7713932ec7a4a41288690e1",
    true,
    "5ecb0eef7025641db55630e1036b4d267bd95ade",
  ), true);
  assert.equal(matchesCapturedQuiescenceRevision(
    {
      ...idleWorker,
      properties: {
        ...idleWorker.properties,
        template: {
          ...idleWorker.properties.template,
          containers: [{
            ...idleWorker.properties.template.containers[0],
            args: ["-e", "process.exit(0)"],
          }],
        },
      },
    },
    workerSource,
    image,
    "apex-gtm-worker",
    "worker",
    "f8c1a08af7713932ec7a4a41288690e1",
  ), false);
});

test("superseded preparation admits only the exact two-revision interrupted replacement", () => {
  const source = readFileSync(CONTROLLER, "utf8");
  const start = source.indexOf("function refreshCapturedSourceForRebind");
  const end = source.indexOf("function inspectSourceImage", start);
  const rebind = source.slice(start, end);
  assert.match(rebind, /role === "worker" && activeRevisions\.length === 2/);
  assert.match(rebind, /activeRevisions\.length === 2/);
  assert.match(rebind, /activeRevisions\.filter\(sourceMatches\)\.length === 1/);
  assert.match(rebind, /quiescenceMatches\(revision, false\)/);
  assert.match(rebind, /!soleExactRevision && !exactInterruptedReplacement/);
});

test("every post-acquisition ACA mutation revalidates both Azure lease and Git release lock", () => {
  const source = readFileSync(CONTROLLER, "utf8");
  const start = source.indexOf("function azureMutation");
  const end = source.indexOf("function activateRevision", start);
  const mutation = source.slice(start, end);
  assert.match(mutation, /releaseLockRequired = true/);
  assert.match(mutation, /verifyAzureLease\(runner, request\)/);
  assert.match(mutation, /if \(releaseLockRequired\) verifyReleaseLock\(runner, request\)/);
  const deploy = source.slice(
    source.indexOf("function deployCompatible"),
    source.indexOf("function activateFirstClass"),
  );
  const activate = source.slice(
    source.indexOf("function activateFirstClass"),
    source.indexOf("function enableApiIngress"),
  );
  assert.match(deploy, /verifyReleaseLock\(runner, request\)/);
  assert.match(activate, /verifyReleaseLock\(runner, request\)/);
});

test("compatible console deployment pins the isolated production API origin", () => {
  const source = readFileSync(CONTROLLER, "utf8");
  assert.match(
    source,
    /CONSOLE_API_UPSTREAM_URL\s*=\s*\n\s*"https:\/\/apex-gtm-api\.braveflower-6d3bb66b\.eastus\.azurecontainerapps\.io"/,
  );
  const deploy = source.slice(
    source.indexOf("function deployCompatible"),
    source.indexOf("function activateFirstClass"),
  );
  assert.match(deploy, /`API_UPSTREAM_URL=\$\{CONSOLE_API_UPSTREAM_URL\}`/);
});

test("published-check admission is bounded and ignores unrelated skipped checks", () => {
  const source = readFileSync(CONTROLLER, "utf8");
  const start = source.indexOf("function verifyPublishedCandidates");
  const end = source.indexOf("function verifyArtifact", start);
  const checks = source.slice(start, end);
  assert.match(checks, /check-runs\?per_page=100&filter=latest/);
  assert.match(checks, /status\?per_page=100&page=1/);
  assert.match(checks, /checks\.total_count !== checks\.check_runs\.length/);
  assert.doesNotMatch(checks, /check_runs\.some/);
});

test("published-candidate admission uses workflow-readable protected branch metadata", () => {
  const source = readFileSync(CONTROLLER, "utf8");
  const start = source.indexOf("function verifyPublishedCandidates");
  const end = source.indexOf("function verifyArtifact", start);
  const admission = source.slice(start, end);
  assert.doesNotMatch(admission, /branches\/\$\{encodeURIComponent\(candidate\.branch\)\}\/protection/);
  assert.match(admission, /const protection = branch\.protection/);
  assert.match(admission, /branch\.protected !== true/);
  assert.match(admission, /branch\.commit\?\.sha !== candidate\.commit/);
  assert.match(admission, /protection\?\.enabled !== true/);
  assert.match(admission, /required_status_checks\?\.enforcement_level !== "everyone"/);
});

test("registry verification binds digests through Azure manifest metadata", () => {
  const source = readFileSync(CONTROLLER, "utf8");
  const start = source.indexOf("function verifyArtifact");
  const end = source.indexOf("function verifyContractClosure", start);
  const verification = source.slice(start, end);
  assert.match(verification, /"acr", "manifest", "show-metadata"/);
  assert.match(verification, /metadata\.digest \?\? metadata\.changeableAttributes\?\.digest/);
  assert.match(verification, /childMetadata\.digest \?\? childMetadata\.changeableAttributes\?\.digest/);
  assert.doesNotMatch(verification, /const observedDigest = manifest\.digest/);
});

test("legacy rollback provenance is accepted only for the exact pinned backend digest", () => {
  const source = readFileSync(CONTROLLER, "utf8");
  assert.match(
    source,
    /"workforceosprodacr\.azurecr\.io\/apex-api@sha256:111a470e65a22d27039d0d130d7d0c7aa33e7a23e0d8ce8fe7183c685dbf6f25":\s*\n\s*"324f831f31ca903f851b3e697ee94cc25af04217"/,
  );
  const start = source.indexOf("function inspectSourceImage");
  const end = source.indexOf("function captureSourceBaseline", start);
  const inspect = source.slice(start, end);
  assert.match(inspect, /Labels\?\.\["org\.opencontainers\.image\.revision"\] \?\?/);
  assert.match(inspect, /LEGACY_SOURCE_IMAGE_REVISIONS\[image\]/);
  assert.match(inspect, /string\(ociRevision, \/\^\[0-9a-f\]\{40\}\$\//);
});
