import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  B8_COMMIT_FAULT_POINTS,
  HELD,
  PHASES,
  RECEIPT_SEQUENCE,
  advanceLedger,
  azureAuthorityIdentityHash,
  canonicalJson,
  createLedger,
  holdLedger,
  runCli,
  sha256Bytes,
  strictJsonParse,
  verifyLedgerBytes,
} from "../production-bootstrap-phase-ledger.mjs";
import {
  FINAL_PHASE_RECEIPT_CONTRACT_VERSION,
  FINAL_PHASE_RECEIPT_SPECS,
} from "../production-bootstrap-phase-receipt-contracts.mjs";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(TEST_DIR, "../production-bootstrap-phase-ledger.mjs");
const BASE_EPOCH = Date.parse("2026-08-14T00:00:00Z");

function hash(character) {
  return `sha256:${character.repeat(64)}`;
}

const AUTHORITY = Object.freeze({
  subscriptionId: "12345678-1234-4234-8234-123456789abc",
  resourceGroupName: "workforce-os-prod",
  resourceGroupResourceId: "/subscriptions/12345678-1234-4234-8234-123456789abc/resourceGroups/workforce-os-prod",
  apiContainerAppResourceId: "/subscriptions/12345678-1234-4234-8234-123456789abc/resourceGroups/workforce-os-prod/providers/Microsoft.App/containerApps/apex-gtm-api",
  workerContainerAppResourceId: "/subscriptions/12345678-1234-4234-8234-123456789abc/resourceGroups/workforce-os-prod/providers/Microsoft.App/containerApps/apex-gtm-worker",
  consoleContainerAppResourceId: "/subscriptions/12345678-1234-4234-8234-123456789abc/resourceGroups/workforce-os-prod/providers/Microsoft.App/containerApps/nikxius-web",
});

const IDENTITY = Object.freeze({
  attemptId: "a".repeat(32),
  candidate: Object.freeze({
    backendCommit: "b".repeat(40),
    consoleCommit: "c".repeat(40),
    apiImage: `workforceosprodacr.azurecr.io/apex-api@${hash("1")}`,
    workerImage: `workforceosprodacr.azurecr.io/apex-api@${hash("1")}`,
    consoleImage: `workforceosprodacr.azurecr.io/workforceos-fe@${hash("3")}`,
  }),
  databaseIdentityHash: hash("1"),
  redisIdentityHash: hash("2"),
  azureIdentityHash: azureAuthorityIdentityHash(AUTHORITY),
  admissionContextHash: hash("a"),
});

const GOVERNANCE = Object.freeze({
  operator: "release.operator",
  approver: "release.approver",
  changeTicket: "CHG-2026-0814",
});
const COMPLETION_EVIDENCE_HASH = hash("0");

function atMinute(minute) {
  return new Date(BASE_EPOCH + minute * 60_000).toISOString().replace(".000Z", "Z");
}

function makeInitial() {
  return createLedger({
    identity: structuredClone(IDENTITY),
    governance: structuredClone(GOVERNANCE),
    fencingGeneration: 1,
    at: atMinute(0),
  });
}

function sourceApp(image, manifestDigest, platformDigest, ociRevision, revision, hashes) {
  return {
    image,
    manifestDigest,
    platformDigest,
    ociRevision,
    platform: "linux/amd64",
    revision,
    configHash: hashes[0],
    templateHash: hashes[1],
    secretReferencesHash: hashes[2],
    activeRevisionsMode: "Single",
    maxInactiveRevisions: 10,
    healthy: true,
  };
}

function queueState(waiting, delayed, completed, failed, pausedJobs) {
  return {
    paused: true,
    waiting,
    active: 0,
    delayed,
    prioritized: 0,
    completed,
    failed,
    waitingChildren: 0,
    pausedJobs,
    workerCount: 0,
  };
}

function entryMigrations() {
  const entries = [
    ["docs/migrations/2026-08-13_clerk-identity-lifecycle-expand.sql", "observed", ["api:clerk-webhooks", "api:identity-membership"]],
    ["docs/migrations/2026-06-01_outreach-artifact-unique.sql", "observed", ["api:outreach-artifacts", "worker:outreach-artifacts"]],
    ["docs/migrations/2026-08-12_conversation-store-expand.sql", "not-required", []],
    ["docs/migrations/2026-08-12_outreach-delivery-unknown-expand.sql", "not-required", []],
    ["docs/migrations/2026-08-13_outreach-artifact-failed-expand.sql", "not-required", []],
    ["docs/migrations/2026-08-12_conversation-reply-single-flight-expand.sql", "observed", ["worker:gmail-reply-sync"]],
    ["docs/migrations/2026-08-12_graph-run-activity-expand.sql", "not-required", []],
    ["docs/migrations/2026-08-12_graph-run-lifecycle-expand.sql", "observed", ["api:graph-start", "scheduler:graph-start", "worker:graph-run"]],
    ["docs/migrations/2026-08-20_icp-exclusion-domains-expand.sql", "not-required", []],
  ];
  const repositoryRoot = resolve(TEST_DIR, "../..");
  return entries.map(([path, writerPause, writerScopes]) => ({
    path,
    sha256: sha256Bytes(readFileSync(resolve(repositoryRoot, path))),
    writerPause,
    writerScopes,
  }));
}

function entryReceiptFor(fencingGeneration, minute, overrides = {}) {
  const queues = {
    agentRuns: queueState(2, 1, 10, 1, 2),
    graphRuns: queueState(1, 0, 20, 2, 1),
    outreachSend: queueState(3, 2, 30, 3, 3),
  };
  const targetBackend = (revision) => ({
    image: IDENTITY.candidate.apiImage,
    manifestDigest: hash("1"),
    platformDigest: hash("2"),
    ociRevision: IDENTITY.candidate.backendCommit,
    platform: "linux/amd64",
    plannedRevision: revision,
    buildRunId: "acr-backend-123",
    buildEvidenceHash: hash("a"),
    rehearsalEvidenceHash: hash("b"),
  });
  const sourceRollbackBaseline = {
    compatibilityState: "legacy-readers-no-new-enum-values-v1",
    rollbackPermittedUntil: "before-first-clerk-migration-invocation-only",
    originalAllowlistNonempty: false,
    originalAllowlistHash: hash("e"),
    privateRestoreBundleHash: hash("f"),
    deliverySafetyEvidence: {
      outstandingDeliveryReview: {
        evidenceHash: hash("1"),
        reviewer: GOVERNANCE.approver,
        reviewedAt: atMinute(minute - 3),
        expiresAt: atMinute(minute + 20),
        outstandingDeliveryCount: 0,
        unresolvedDeliveryCount: 0,
        disposition: "no-outstanding-deliveries",
      },
      providerDeliveryDrain: {
        evidenceHash: hash("2"),
        reviewer: GOVERNANCE.approver,
        reviewedAt: atMinute(minute - 3),
        expiresAt: atMinute(minute + 20),
        providerScope: "all-configured-outbound-providers",
        inFlightDeliveryCount: 0,
        drainConfirmed: true,
      },
      verifiedFromProtectedBytes: true,
    },
    databaseDdlAuthorityEvidence: {
      schemaVersion: 1,
      environment: "production",
      kind: "production-database-ddl-exclusive-authority",
      bootstrapAttemptId: IDENTITY.attemptId,
      backendCandidateCommit: IDENTITY.candidate.backendCommit,
      databaseIdentityHash: IDENTITY.databaseIdentityHash,
      evidenceHash: hash("3"),
      reviewer: GOVERNANCE.approver,
      reviewedAt: atMinute(minute - 3),
      expiresAt: atMinute(minute + 40),
      authorityScope: "all-production-database-ddl-actors",
      exclusiveDdlAuthorityConfirmed: true,
      verifiedFromProtectedBytes: true,
    },
    operationalSmokeEvidence: {
      failedList: {
        schemaVersion: 1,
        environment: "production",
        kind: "production-failed-list-smoke",
        bootstrapAttemptId: IDENTITY.attemptId,
        backendCandidateCommit: IDENTITY.candidate.backendCommit,
        consoleCandidateCommit: IDENTITY.candidate.consoleCommit,
        evidenceHash: hash("4"),
        reviewer: GOVERNANCE.approver,
        reviewedAt: atMinute(minute - 3),
        expiresAt: atMinute(minute + 40),
        scope: "api-failed-outreach-list",
        passed: true,
      },
      dashboardPolicy: {
        schemaVersion: 1,
        environment: "production",
        kind: "production-dashboard-policy-smoke",
        bootstrapAttemptId: IDENTITY.attemptId,
        backendCandidateCommit: IDENTITY.candidate.backendCommit,
        consoleCandidateCommit: IDENTITY.candidate.consoleCommit,
        evidenceHash: hash("5"),
        reviewer: GOVERNANCE.approver,
        reviewedAt: atMinute(minute - 3),
        expiresAt: atMinute(minute + 40),
        scope: "console-dashboard-policy",
        passed: true,
      },
      verifiedFromProtectedBytes: true,
    },
    api: sourceApp(
      `workforceosprodacr.azurecr.io/apex-api@${hash("5")}`,
      hash("5"), hash("6"), "d".repeat(40), "apex-gtm-api--legacy-a",
      [hash("9"), hash("a"), hash("b")],
    ),
    worker: sourceApp(
      `workforceosprodacr.azurecr.io/apex-api@${hash("5")}`,
      hash("5"), hash("6"), "d".repeat(40), "apex-gtm-worker--legacy-a",
      [hash("c"), hash("d"), hash("e")],
    ),
    console: sourceApp(
      `workforceosprodacr.azurecr.io/workforceos-fe@${hash("7")}`,
      hash("7"), hash("8"), "e".repeat(40), "nikxius-web--legacy-a",
      [hash("9"), hash("a"), hash("b")],
    ),
  };
  const receipt = {
    schemaVersion: 2,
    environment: "production",
    kind: "initial-bootstrap-entry",
    authorizationScope: "bootstrap-entry-admission-only",
    bootstrapAttemptId: IDENTITY.attemptId,
    backendCandidateCommit: IDENTITY.candidate.backendCommit,
    consoleCandidateCommit: IDENTITY.candidate.consoleCommit,
    status: "prepared-and-quiesced",
    preparedAt: atMinute(minute - 0.5),
    expiresAt: atMinute(minute + 30),
    operator: GOVERNANCE.operator,
    approver: GOVERNANCE.approver,
    changeTicket: GOVERNANCE.changeTicket,
    admissionContextHash: IDENTITY.admissionContextHash,
    authority: structuredClone(AUTHORITY),
    releaseLock: {
      repository: "https://github.com/Kloudedge-apex/apex-product.git",
      ref: "refs/heads/workforce-os-release-lock/production-gtm-platform",
      objectSha: IDENTITY.candidate.backendCommit,
    },
    redisIdentityHash: IDENTITY.redisIdentityHash,
    databaseIdentityHash: IDENTITY.databaseIdentityHash,
    lease: {
      token: "f".repeat(64),
      generation: fencingGeneration,
      observedAt: atMinute(minute - 2),
      expiresAt: atMinute(minute + 40),
    },
    targetArtifacts: {
      api: targetBackend("apex-gtm-api--candidate-a"),
      worker: targetBackend("apex-gtm-worker--candidate-a"),
      console: {
        image: IDENTITY.candidate.consoleImage,
        manifestDigest: hash("3"),
        platformDigest: hash("4"),
        ociRevision: IDENTITY.candidate.consoleCommit,
        platform: "linux/amd64",
        plannedRevision: "nikxius-web--candidate-a",
        buildRunId: "acr-console-456",
        buildEvidenceHash: hash("c"),
        rehearsalEvidenceHash: hash("d"),
        clientConfigEvidenceHash: hash("e"),
        smokeEvidenceHash: hash("f"),
      },
    },
    clerkReconciliationPlan: {
      rawPlanSha256: hash("1"),
      dryRunEvidenceSha256: hash("2"),
      inventoryEvidenceHash: hash("3"),
      minimumEventVersion: Date.parse(atMinute(minute - 5)),
      expectedActiveOrganizationCount: 2,
      expectedActiveMembershipCount: 3,
      expectedActiveUserCount: 3,
      executor: {
        name: "workforce-production-clerk-reconciliation-executor",
        version: "v1",
        sha256: hash("4"),
      },
      dryRunPassed: true,
      approver: GOVERNANCE.approver,
      planSignatureSha256: hash("5"),
      signatureNamespace: "workforce-os-clerk-reconciliation-plan",
      independentApprovalEvidenceHash: hash("6"),
      verifiedAt: atMinute(minute - 4),
      expiresAt: atMinute(minute + 40),
    },
    sourceRollbackBaseline,
    quiescedState: {
      api: { stopped: true, activeRevisionCount: 0, replicaCount: 0, ingressDisabled: true },
      worker: { stopped: true, activeRevisionCount: 0, replicaCount: 0, consumersDisabled: true },
      queueObservations: [
        {
          observedAt: atMinute(minute - 1.5),
          stableSince: atMinute(minute - 2),
          evidenceHash: hash("9"),
          queues,
        },
        {
          observedAt: atMinute(minute - 1),
          stableSince: atMinute(minute - 2),
          evidenceHash: hash("a"),
          queues: structuredClone(queues),
        },
      ],
      writerFence: {
        schemaVersion: 1,
        target: "workforce-os-production",
        observedAt: atMinute(minute - 0.75),
        generation: fencingGeneration,
        state: {
          schemaVersion: 1,
          target: "workforce-os-production",
          mode: "closed",
          bootstrapAttemptId: IDENTITY.attemptId,
          generation: fencingGeneration,
          issuedAt: atMinute(minute - 2),
          expiresAt: atMinute(minute + 40),
        },
        stateHash: hash("b"),
        activeWriters: 0,
        activeComplianceWriters: 0,
        writerZero: true,
      },
      orphanRecovery: {
        schemaVersion: 1,
        target: "workforce-os-production",
        bootstrapAttemptId: IDENTITY.attemptId,
        generation: 0,
        recoveredAt: atMinute(minute - 2.5),
        stableZeroEvidenceHash: hash("1"),
        pre: {
          activeApplicationWriters: 0,
          activeComplianceWriters: 0,
          uncertainApplicationWriters: 1,
          uncertainComplianceWriters: 0,
          tokenSetHash: hash("2"),
        },
        post: {
          activeApplicationWriters: 0,
          activeComplianceWriters: 0,
          uncertainApplicationWriters: 0,
          uncertainComplianceWriters: 0,
          tokenSetHash: hash("3"),
        },
      },
      inventory: {
        databaseIdentityHash: IDENTITY.databaseIdentityHash,
        sendingRows: 0,
        firstClassDeliveryUnknownRows: 0,
        legacyDeliveryUnknownMarkerRows: 0,
        firstClassFailedRows: 0,
        legacyAutoFailedMarkerRows: 2,
        outreachIdempotencyDuplicateGroups: 0,
        legacyGmailReplySequenceStopRows: 1,
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
        duplicateInventoryEvidenceHash: hash("d"),
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
        clerkReadinessViolationCount: null,
      },
      liveSendAllowlistEmpty: true,
      privateRestoreBundleHash: hash("f"),
      evidenceHash: hash("e"),
    },
    migrations: entryMigrations(),
    ...overrides,
  };
  return Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
}

function closedQuiescence(fencingGeneration, minute) {
  const queues = {
    agentRuns: queueState(2, 1, 10, 1, 2),
    graphRuns: queueState(1, 0, 20, 2, 1),
    outreachSend: queueState(3, 2, 30, 3, 3),
  };
  return {
    nonComplianceApiMutationsBlocked: true,
    liveSendAllowlistEmpty: true,
    queueObservations: [
      { observedAt: atMinute(minute - 2), stableSince: atMinute(minute - 3), evidenceHash: hash("1"), queues },
      { observedAt: atMinute(minute - 1), stableSince: atMinute(minute - 3), evidenceHash: hash("2"), queues: structuredClone(queues) },
    ],
    writerFence: {
      schemaVersion: 1,
      target: "workforce-os-production",
      mode: "closed",
      bootstrapAttemptId: IDENTITY.attemptId,
      generation: fencingGeneration,
      issuedAt: atMinute(minute - 3),
      observedAt: atMinute(minute - 0.75),
      expiresAt: atMinute(minute + 12),
      stateHash: hash("3"),
      activeWriters: 0,
      activeComplianceWriters: 0,
    },
    evidenceHash: hash("4"),
  };
}

function deploymentIdentity(role, revision, variant = "5") {
  const console = role === "console";
  return {
    image: console ? IDENTITY.candidate.consoleImage : IDENTITY.candidate.apiImage,
    manifestDigest: console ? hash("3") : hash("1"),
    platformDigest: console ? hash("4") : hash("2"),
    ociRevision: console ? IDENTITY.candidate.consoleCommit : IDENTITY.candidate.backendCommit,
    platform: "linux/amd64",
    revision,
    configHash: hash(variant),
    templateHash: hash(variant === "5" ? "6" : "7"),
    secretReferencesHash: hash(variant === "5" ? "7" : "8"),
  };
}

function disabledDeployments() {
  return {
    api: {
      identity: deploymentIdentity("api", "apex-gtm-api--candidate-a", "5"),
      active: true, soleActiveRevision: true, healthy: true, provisioned: true,
    },
    worker: {
      identity: deploymentIdentity("worker", "apex-gtm-worker--candidate-a", "6"),
      active: true, soleActiveRevision: true, healthy: true, provisioned: true,
    },
    console: {
      identity: deploymentIdentity("console", "nikxius-web--candidate-a", "7"),
      active: true, soleActiveRevision: true, healthy: true, provisioned: true,
    },
  };
}

function writeGates(active) {
  const api = {
    deliveryUnknownWriteMode: "disabled",
    deliveryUnknownWriteAck: null,
    compatibilityEpoch: "outreach-delivery-unknown-v1",
    failedStatusWritesEnabled: false,
    failedStatusWritesAck: null,
  };
  return {
    api,
    worker: active ? {
      deliveryUnknownWriteMode: "first-class",
      deliveryUnknownWriteAck: "readers-drained-rollback-baselines-verified-v1",
      compatibilityEpoch: "outreach-delivery-unknown-v1",
      failedStatusWritesEnabled: true,
      failedStatusWritesAck: "readers-drained-legacy-inventory-reviewed-v1",
    } : structuredClone(api),
  };
}

function rollbackBaseline(disabled) {
  return {
    compatibilityAttestation: "enum-aware-api-worker-console-baseline-v1",
    compatibilityEpoch: "outreach-delivery-unknown-v1",
    deliveryUnknownWriteMode: "disabled",
    failedStatusWritesEnabled: false,
    api: { identity: structuredClone(disabled.api.identity), available: true, active: true },
    worker: { identity: structuredClone(disabled.worker.identity), available: true, active: false },
    console: { identity: structuredClone(disabled.console.identity), available: true, active: true },
    evidenceHash: hash("9"),
  };
}

function phaseEvidence(state, targetPhase, fencingGeneration, minute) {
  const previous = JSON.parse(Buffer.from(state.ledger.receipts.at(-1).bytesBase64, "base64").toString("utf8"));
  if (targetPhase === "B4_SCHEMA_VERIFIED") {
    return {
      targetRevisions: {
        api: previous.targetArtifacts.api.plannedRevision,
        worker: previous.targetArtifacts.worker.plannedRevision,
        console: previous.targetArtifacts.console.plannedRevision,
      },
      migrationExecution: entryMigrations().map((migration, index) => ({
        ...migration,
        preflightPassed: true,
        invocationVerified: true,
        applied: true,
        postconditionsPassed: true,
        duplicateInventoryHash: hash(String((index + 1) % 10)),
        postconditionEvidenceHash: hash(String((index + 2) % 10)),
      })),
      clerkReconciliationPlan: structuredClone(previous.clerkReconciliationPlan),
      clerkCutover: {
        schemaReady: true, rowCount: 1, ready: true,
        minimumEventVersion: previous.clerkReconciliationPlan.minimumEventVersion,
        inventoryEvidenceHash: previous.clerkReconciliationPlan.inventoryEvidenceHash,
        expectedActiveOrganizationCount: previous.clerkReconciliationPlan.expectedActiveOrganizationCount,
        expectedActiveMembershipCount: previous.clerkReconciliationPlan.expectedActiveMembershipCount,
        expectedActiveUserCount: previous.clerkReconciliationPlan.expectedActiveUserCount,
        activeOrganizationCount: 2, activeMembershipCount: 3, activeUserCount: 3,
        projectionMismatchRows: 0, orphanActiveAuthorityRows: 0, readinessViolationRows: 0,
        invariantEvidenceHash: hash("6"),
      },
      schemaInventory: {
        outreachIdempotencyDuplicateGroups: 0, legacyGmailReplySequenceStopRows: 1,
        managerRoleRows: 1, graphRunRunningRows: 0, graphRunAwaitingApprovalRows: 1,
        graphActiveOrgDuplicateGroups: 0, graphActiveWithoutRecoveryStateRows: 0,
        graphLifecycleSchemaReady: true, replySchemaReady: true,
        replySourceDuplicateGroups: 0, replyConversationDuplicateGroups: 0,
        nullSourceReplyRows: 0, replySlotDuplicateRows: 0,
        duplicateInventoryEvidenceHash: hash("7"),
      },
      deliveryState: {
        deliveryUnknownEnumReady: true, failedEnumReady: true,
        deliveryUnknownWriteMode: "disabled", deliveryUnknownWriteAck: null,
        failedStatusWritesEnabled: false, failedStatusWritesAck: null,
        sendingRows: 0, firstClassDeliveryUnknownRows: 0, firstClassFailedRows: 0,
        legacyDeliveryUnknownMarkerRows: 0, legacyAutoFailedMarkerRows: 2,
        legacyMarkerInventoryEvidenceHash: hash("8"),
      },
      quiescence: closedQuiescence(fencingGeneration, minute),
      stagingRehearsalEvidenceHash: hash("9"),
      productionApplyEvidenceHash: hash("a"),
      backupRestoreEvidenceHash: hash("b"),
      schemaEvidenceHash: hash("c"),
    };
  }
  if (targetPhase === "B5_COMPATIBLE_BASELINE") {
    return {
      deployments: disabledDeployments(),
      writeGates: writeGates(false),
      legacyRevisions: {
        allLegacyRevisionsInactive: true,
        apiActiveLegacyRevisionCount: 0,
        workerActiveLegacyRevisionCount: 0,
        consoleActiveLegacyRevisionCount: 0,
        evidenceHash: hash("d"),
      },
      quiescence: closedQuiescence(fencingGeneration, minute),
      compatibilityAttestation: "enum-aware-api-worker-console-baseline-v1",
      baselineEvidenceHash: hash("e"),
    };
  }
  if (targetPhase === "B6_FIRST_CLASS_ARMED") {
    const disabled = previous.evidence.deployments;
    const deployments = structuredClone(disabled);
    deployments.worker.identity = deploymentIdentity("worker", "apex-gtm-worker--first-class-a", "8");
    return {
      deployments,
      writeGates: writeGates(true),
      rollbackBaseline: rollbackBaseline(disabled),
      readerDrain: {
        legacyApiReadersActive: 0, legacyWorkerWritersActive: 0,
        legacyConsoleReadersActive: 0, evidenceHash: hash("f"),
      },
      deliveryUnknownActivation: {
        readersDrained: true, rollbackBaselinesVerified: true,
        firstClassDeliveryUnknownRows: 0, evidenceHash: hash("1"),
      },
      failedActivation: {
        readersDrained: true, legacyInventoryReviewed: true,
        unreviewedHistoricalMarkersPromotedRows: 0, firstClassFailedRows: 0,
        legacyInventoryEvidenceHash: hash("2"), evidenceHash: hash("3"),
      },
      quiescence: closedQuiescence(fencingGeneration, minute),
      activationEvidenceHash: hash("4"),
    };
  }
  const actions = [
    "release-writer-fence", "start-first-class-consumers", "resume-graph-runs",
    "resume-outreach-send", "unblock-api-mutations",
  ];
  const steps = actions.map((action, index) => ({
    sequence: index + 1,
    action,
    startedAt: atMinute(minute - 2.4 + index * 0.35),
    completedAt: atMinute(minute - 2.3 + index * 0.35),
    evidenceHash: hash(String((index + 5) % 10)),
  }));
  const resumedQueue = (waiting) => ({
    paused: false, waiting, active: 0, delayed: 0, prioritized: 0,
    completed: 10, failed: 0, waitingChildren: 0, pausedJobs: 0, workerCount: 1,
  });
  const pausedQueue = (waiting) => ({
    paused: true, waiting, active: 0, delayed: 0, prioritized: 0,
    completed: 10, failed: 0, waitingChildren: 0, pausedJobs: 0, workerCount: 1,
  });
  const retiredQueue = (waiting) => ({ ...pausedQueue(waiting), workerCount: 0 });
  return {
    deployments: structuredClone(previous.evidence.deployments),
    writeGates: structuredClone(previous.evidence.writeGates),
    rollbackBaseline: structuredClone(previous.evidence.rollbackBaseline),
    resume: {
      terminalOpenIntent: {
        bootstrapAttemptId: IDENTITY.attemptId,
        generation: fencingGeneration,
        previousStateHash: hash("3"),
        persistedAt: atMinute(minute - 2.5),
        forwardOnly: true,
        evidenceHash: hash("9"),
      },
      steps,
      pausedConsumerProof: {
        queues: {
          agentRuns: retiredQueue(0), graphRuns: pausedQueue(0), outreachSend: pausedQueue(0),
        },
        provedAt: steps[1].completedAt,
        evidenceHash: hash("8"),
      },
      queues: {
        agentRuns: retiredQueue(0), graphRuns: resumedQueue(0), outreachSend: resumedQueue(0),
      },
      writerFenceRelease: {
        bootstrapAttemptId: IDENTITY.attemptId, generation: fencingGeneration,
        previousStateHash: hash("3"), releasedAt: steps[0].completedAt,
        openEpoch: {
          schemaVersion: 1, target: "workforce-os-production", mode: "open",
          bootstrapAttemptId: IDENTITY.attemptId, generation: fencingGeneration,
        },
        openStateHash: hash("4"), terminalOpen: true, evidenceHash: hash("a"),
      },
      apiMutations: {
        blocked: false, ingressEnabled: true, readinessPassed: true,
        restoredAt: steps[4].completedAt, evidenceHash: hash("b"),
      },
      ambiguityControl: {
        policy: "repause-deactivate-stable-zero-and-hold-terminal-open-forward-only-v1",
        containmentReady: true,
        ambiguousPartialResumeDetected: false,
        allQueuesRePauseRequired: true,
        apiAndWorkerDeactivateRequired: true,
        stableZeroReplicasRequired: true,
        terminalOpenRecloseForbidden: true,
        holdForwardOnlyRequired: true,
        evidenceHash: hash("f"),
      },
      liveSendAllowlistEmpty: true,
      evidenceHash: hash("c"),
    },
    health: {
      apiReady: true, workerReady: true, consoleReady: true, releaseConfigVerified: true,
      failedListSmokePassed: true, dashboardPolicySmokePassed: true,
      releaseConfigEvidenceHash: hash("1"), failedListSmokeEvidenceHash: hash("2"),
      dashboardPolicySmokeEvidenceHash: hash("3"), evidenceHash: hash("d"),
    },
    finalInventory: {
      sendingRows: 0, firstClassDeliveryUnknownRows: 0, firstClassFailedRows: 0,
      unreviewedHistoricalMarkersPromotedRows: 0, evidenceHash: hash("e"),
    },
    bootstrapEvidenceHash: hash("f"),
  };
}

function receiptFor(state, targetPhase, fencingGeneration, minute, overrides = {}) {
  const sequenceIndex = RECEIPT_SEQUENCE.findIndex((entry) => entry.phase === targetPhase);
  assert.notEqual(sequenceIndex, -1, `missing test receipt rule for ${targetPhase}`);
  const rule = RECEIPT_SEQUENCE[sequenceIndex];
  if (targetPhase === "B2_LEGACY_QUIESCED") {
    return entryReceiptFor(fencingGeneration, minute, overrides);
  }
  const previousReceiptSha256 = state.ledger.receipts.at(-1)?.sha256 ?? null;
  const finalSpec = FINAL_PHASE_RECEIPT_SPECS.find((entry) => entry.phase === targetPhase);
  assert.ok(finalSpec, `missing final receipt spec for ${targetPhase}`);
  const receipt = {
    schemaVersion: 1,
    receiptContractVersion: FINAL_PHASE_RECEIPT_CONTRACT_VERSION,
    environment: "production",
    kind: rule.kind,
    authorizationScope: finalSpec.authorizationScope,
    attemptId: IDENTITY.attemptId,
    candidate: structuredClone(IDENTITY.candidate),
    databaseIdentityHash: IDENTITY.databaseIdentityHash,
    redisIdentityHash: IDENTITY.redisIdentityHash,
    azureIdentityHash: IDENTITY.azureIdentityHash,
    admissionContextHash: IDENTITY.admissionContextHash,
    fencingGeneration,
    sequence: sequenceIndex + 1,
    previousReceiptSha256,
    phase: rule.phase,
    status: rule.status,
    rollbackPolicy: structuredClone(finalSpec.rollbackPolicy),
    clerkInvocation: rule.clerkInvocation,
    phaseContextHash: hash(String((sequenceIndex + 5) % 10)),
    issuedAt: atMinute(minute - 0.5),
    expiresAt: atMinute(minute + 10),
    operator: GOVERNANCE.operator,
    approver: GOVERNANCE.approver,
    changeTicket: GOVERNANCE.changeTicket,
    evidence: phaseEvidence(state, targetPhase, fencingGeneration, minute),
    ...overrides,
  };
  return Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
}

function nextState(state, targetPhase, minute, options = {}) {
  const fencingGeneration = options.fencingGeneration ?? state.ledger.fencingGeneration + 1;
  const receiptBytes = RECEIPT_SEQUENCE.some((entry) => entry.phase === targetPhase)
    ? (options.receiptBytes ?? receiptFor(state, targetPhase, fencingGeneration, minute, options.receiptOverrides))
    : options.receiptBytes;
  return advanceLedger(state.ledgerBytes, {
    toPhase: targetPhase,
    fencingGeneration,
    clerkInvocation: targetPhase === "B3_SCHEMA_FORWARD_ONLY"
      ? (options.clerkInvocation ?? "invoked")
      : options.clerkInvocation,
    receiptBytes,
    completionEvidenceHash: targetPhase === "B8_COMPLETE"
      ? (options.completionEvidenceHash ?? COMPLETION_EVIDENCE_HASH)
      : options.completionEvidenceHash,
    at: atMinute(minute),
  });
}

function buildThrough(targetPhase, options = {}) {
  let state = makeInitial();
  const states = new Map([["B0_ARTIFACT_READY", state]]);
  const targetIndex = PHASES.indexOf(targetPhase);
  for (let index = 1; index <= targetIndex; index += 1) {
    const phase = PHASES[index];
    state = nextState(state, phase, index, phase === "B3_SCHEMA_FORWARD_ONLY"
      ? { clerkInvocation: options.clerkInvocation ?? "invoked" }
      : {});
    states.set(phase, state);
  }
  return { state, states };
}

function errorMatches(callback, pattern) {
  assert.throws(callback, pattern);
}

test("walks the exact B0-B8 state machine and admits the ordered receipt chain", () => {
  const { state, states } = buildThrough("B8_COMPLETE");
  const expectedFloors = {
    B0_ARTIFACT_READY: "legacy-allowed",
    B1_CONTROL_ACQUIRED: "legacy-allowed",
    B2_LEGACY_QUIESCED: "legacy-allowed",
    B3_SCHEMA_FORWARD_ONLY: "forward-only",
    B4_SCHEMA_VERIFIED: "forward-only",
    B5_COMPATIBLE_BASELINE: "enum-aware-disabled",
    B6_FIRST_CLASS_ARMED: "activation-attempted",
    B7_RESUMING: "activation-attempted",
    B8_COMPLETE: "activation-attempted",
  };
  for (const phase of PHASES) {
    assert.equal(states.get(phase).ledger.rollbackFloor, expectedFloors[phase]);
  }
  assert.equal(states.get("B5_COMPATIBLE_BASELINE").ledger.resumeEligibility, "denied");
  assert.equal(states.get("B6_FIRST_CLASS_ARMED").ledger.resumeEligibility, "activation-chain-verified");
  assert.equal(states.get("B7_RESUMING").ledger.resumeEligibility, "activation-chain-verified");
  assert.equal(state.ledger.resumeEligibility, "complete-chain-verified");
  assert.deepEqual(state.ledger.receipts.map((receipt) => receipt.kind),
    RECEIPT_SEQUENCE.map((receipt) => receipt.kind));
  assert.equal(state.ledger.consumed, true);
  assert.equal(state.ledger.events.at(-1).completionEvidenceHash, COMPLETION_EVIDENCE_HASH);
  assert.equal(
    state.ledger.events.at(-1).previousLedgerSha256,
    states.get("B7_RESUMING").ledgerSha256,
  );
  const verified = verifyLedgerBytes(state.ledgerBytes, { tombstoneBytes: state.tombstoneBytes });
  assert.equal(verified.ledgerSha256, state.ledgerSha256);
  assert.equal(verified.tombstone.completedLedgerSha256, state.ledgerSha256);
  assert.equal(verified.tombstone.completionEvidenceHash, COMPLETION_EVIDENCE_HASH);
});

test("requires each exact next phase and rejects skipped, replayed, and downgraded transitions", () => {
  const initial = makeInitial();
  errorMatches(() => nextState(initial, "B2_LEGACY_QUIESCED", 1), /exactly the next/);
  const b1 = nextState(initial, "B1_CONTROL_ACQUIRED", 1);
  errorMatches(() => nextState(b1, "B1_CONTROL_ACQUIRED", 2), /exactly the next/);
  const b2 = nextState(b1, "B2_LEGACY_QUIESCED", 2);
  errorMatches(() => advanceLedger(b2.ledgerBytes, {
    toPhase: "B1_CONTROL_ACQUIRED",
    fencingGeneration: 4,
    at: atMinute(3),
  }), /exactly the next/);
});

test("requires a strictly increasing fencing generation for advance and hold", () => {
  const initial = makeInitial();
  errorMatches(() => nextState(initial, "B1_CONTROL_ACQUIRED", 1, { fencingGeneration: 1 }),
    /fencing generation must increase/);
  errorMatches(() => holdLedger(initial.ledgerBytes, {
    fencingGeneration: 0,
    reasonCode: "OPERATOR_HOLD",
    evidenceSha256: hash("9"),
    at: atMinute(1),
  }), /positive safe integer/);
});

test("holds without weakening the rollback floor and resumes only at the next phase", () => {
  const { state: b3 } = buildThrough("B3_SCHEMA_FORWARD_ONLY", { clerkInvocation: "uncertain" });
  assert.equal(b3.ledger.clerkInvocation, "uncertain");
  assert.equal(b3.ledger.rollbackFloor, "forward-only");
  const held = holdLedger(b3.ledgerBytes, {
    fencingGeneration: 5,
    reasonCode: "SCHEMA_RESULT_UNCERTAIN",
    evidenceSha256: hash("8"),
    at: atMinute(4),
  });
  assert.equal(held.ledger.phase, HELD);
  assert.equal(held.ledger.progressPhase, "B3_SCHEMA_FORWARD_ONLY");
  assert.equal(held.ledger.rollbackFloor, "forward-only");
  assert.equal(held.ledger.clerkInvocation, "uncertain");
  errorMatches(() => holdLedger(held.ledgerBytes, {
    fencingGeneration: 6,
    reasonCode: "SECOND_HOLD",
    evidenceSha256: hash("7"),
    at: atMinute(5),
  }), /already held/);
  const b4 = nextState(held, "B4_SCHEMA_VERIFIED", 5, { fencingGeneration: 6 });
  assert.equal(b4.ledger.phase, "B4_SCHEMA_VERIFIED");
  assert.equal(b4.ledger.clerkInvocation, "verified");
  assert.equal(b4.ledger.rollbackFloor, "forward-only");
});

test("never restores legacy rollback after Clerk invocation is invoked or uncertain", () => {
  const { state: b3 } = buildThrough("B3_SCHEMA_FORWARD_ONLY", { clerkInvocation: "uncertain" });
  const document = JSON.parse(b3.ledgerBytes.toString("utf8"));
  document.rollbackFloor = "legacy-allowed";
  errorMatches(() => verifyLedgerBytes(Buffer.from(JSON.stringify(document))),
    /summary fields do not match/);
  document.rollbackFloor = "forward-only";
  document.events.at(-1).rollbackFloor = "legacy-allowed";
  errorMatches(() => verifyLedgerBytes(Buffer.from(JSON.stringify(document))),
    /hash chain is invalid/);
});

test("rejects candidate, database, Redis, Azure, and context identity drift in receipts", () => {
  const b1 = nextState(makeInitial(), "B1_CONTROL_ACQUIRED", 1);
  const drifts = [
    { backendCandidateCommit: "9".repeat(40) },
    { databaseIdentityHash: hash("8") },
    { redisIdentityHash: hash("8") },
    { admissionContextHash: hash("8") },
    { authority: { ...AUTHORITY, resourceGroupName: "Other-prod" } },
  ];
  for (const drift of drifts) {
    const bytes = receiptFor(b1, "B2_LEGACY_QUIESCED", 3, 2, drift);
    errorMatches(() => nextState(b1, "B2_LEGACY_QUIESCED", 2, { receiptBytes: bytes }),
      /identity drift|production resource identity/);
  }
});

test("B2 consumes the exact signed entry v2 contract and rejects generic adapters or weakened evidence", () => {
  const b1 = nextState(makeInitial(), "B1_CONTROL_ACQUIRED", 1);
  const valid = JSON.parse(entryReceiptFor(3, 2).toString("utf8"));
  assert.equal(valid.schemaVersion, 2);
  assert.equal(valid.kind, "initial-bootstrap-entry");
  assert.equal(Object.hasOwn(valid, "sequence"), false);
  assert.equal(Object.hasOwn(valid, "previousReceiptSha256"), false);
  assert.equal(Object.hasOwn(valid, "candidate"), false);

  const variants = [
    (receipt) => { receipt.sequence = 1; },
    (receipt) => { receipt.lease.generation = 4; },
    (receipt) => { receipt.releaseLock.ref = "refs/heads/not-production"; },
    (receipt) => { receipt.quiescedState.queueObservations[1].queues.graphRuns.workerCount = 1; },
    (receipt) => {
      receipt.quiescedState.queueObservations[1].observedAt =
        receipt.quiescedState.queueObservations[0].observedAt;
    },
    (receipt) => { receipt.quiescedState.writerFence.state.bootstrapAttemptId = "0".repeat(32); },
    (receipt) => { receipt.quiescedState.inventory.databaseIdentityHash = hash("8"); },
    (receipt) => { receipt.quiescedState.inventory.replySourceDuplicateGroups = 0; },
    (receipt) => { receipt.migrations[0].writerScopes = []; },
    (receipt) => {
      receipt.sourceRollbackBaseline.deliverySafetyEvidence.providerDeliveryDrain.drainConfirmed = false;
    },
    (receipt) => {
      receipt.sourceRollbackBaseline.databaseDdlAuthorityEvidence.databaseIdentityHash = hash("8");
    },
    (receipt) => {
      receipt.sourceRollbackBaseline.databaseDdlAuthorityEvidence.expiresAt = receipt.preparedAt;
    },
    (receipt) => {
      receipt.sourceRollbackBaseline.operationalSmokeEvidence.failedList.consoleCandidateCommit =
        "8".repeat(40);
    },
    (receipt) => {
      receipt.sourceRollbackBaseline.operationalSmokeEvidence.dashboardPolicy.passed = false;
    },
    (receipt) => { receipt.targetArtifacts.console.image = `workforceosprodacr.azurecr.io/workforceos-fe@${hash("8")}`; },
  ];
  for (const mutate of variants) {
    const receipt = structuredClone(valid);
    mutate(receipt);
    errorMatches(() => nextState(b1, "B2_LEGACY_QUIESCED", 2, {
      receiptBytes: Buffer.from(JSON.stringify(receipt)),
    }), /unknown or missing fields|generation|release lock|worker-free|stale or inconsistent|exact bootstrap attempt|database identity drift|replySchemaReady|reviewed contract|provider-delivery drain|production entry identity|operational smoke|does not cover receipt validity|candidate provenance|artifact identity drift/);
  }
});

test("rejects identity changes in the ledger even if summary fields look plausible", () => {
  const initial = makeInitial();
  const document = JSON.parse(initial.ledgerBytes.toString("utf8"));
  document.identity.azureIdentityHash = hash("9");
  errorMatches(() => verifyLedgerBytes(Buffer.from(JSON.stringify(document))), /hash chain is invalid/);
});

test("rejects a receipt replay and a broken previous-receipt digest", () => {
  const { state: b3, states } = buildThrough("B3_SCHEMA_FORWARD_ONLY");
  const entryBytes = Buffer.from(states.get("B2_LEGACY_QUIESCED").ledger.receipts[0].bytesBase64, "base64");
  errorMatches(() => nextState(b3, "B4_SCHEMA_VERIFIED", 4, {
    fencingGeneration: 5,
    receiptBytes: entryBytes,
  }), /unknown or missing fields|required sequence entry 2/);
  const broken = receiptFor(b3, "B4_SCHEMA_VERIFIED", 5, 4, {
    previousReceiptSha256: hash("9"),
  });
  errorMatches(() => nextState(b3, "B4_SCHEMA_VERIFIED", 4, {
    fencingGeneration: 5,
    receiptBytes: broken,
  }), /hash chain is invalid/);
});

test("enforces receipt freshness, expiry, future-date, and one-hour lifetime", () => {
  const b1 = nextState(makeInitial(), "B1_CONTROL_ACQUIRED", 1);
  const cases = [
    { preparedAt: atMinute(-10), expiresAt: atMinute(2) },
    { preparedAt: atMinute(3), expiresAt: atMinute(20) },
    { preparedAt: atMinute(1), expiresAt: atMinute(62) },
    { preparedAt: atMinute(2), expiresAt: atMinute(2) },
  ];
  for (const timestamps of cases) {
    const bytes = receiptFor(b1, "B2_LEGACY_QUIESCED", 3, 2, timestamps);
    errorMatches(() => nextState(b1, "B2_LEGACY_QUIESCED", 2, { receiptBytes: bytes }),
      /stale or inconsistent|stale, future-dated, or cutoff-inconsistent|stale, future-dated, or does not cover receipt validity/);
  }
});

test("requires a distinct operator and approver in governance and every receipt", () => {
  errorMatches(() => createLedger({
    identity: structuredClone(IDENTITY),
    governance: { operator: "same", approver: "same", changeTicket: "CHG-1" },
    fencingGeneration: 1,
    at: atMinute(0),
  }), /different principals/);
  const b1 = nextState(makeInitial(), "B1_CONTROL_ACQUIRED", 1);
  const receipt = receiptFor(b1, "B2_LEGACY_QUIESCED", 3, 2, { approver: GOVERNANCE.operator });
  errorMatches(() => nextState(b1, "B2_LEGACY_QUIESCED", 2, { receiptBytes: receipt }),
    /governance identity drift/);
});

test("hashes exact receipt bytes and detects embedded-byte tampering", () => {
  const b1 = nextState(makeInitial(), "B1_CONTROL_ACQUIRED", 1);
  const pretty = receiptFor(b1, "B2_LEGACY_QUIESCED", 3, 2);
  const compact = Buffer.from(JSON.stringify(JSON.parse(pretty.toString("utf8"))), "utf8");
  assert.notEqual(sha256Bytes(pretty), sha256Bytes(compact));
  const b2 = nextState(b1, "B2_LEGACY_QUIESCED", 2, { receiptBytes: pretty });
  assert.equal(b2.ledger.receipts[0].sha256, sha256Bytes(pretty));
  const document = JSON.parse(b2.ledgerBytes.toString("utf8"));
  document.receipts[0].bytesBase64 = compact.toString("base64");
  errorMatches(() => verifyLedgerBytes(Buffer.from(JSON.stringify(document))), /exact-byte digest is invalid/);
});

test("strict JSON rejects duplicate keys, trailing content, unsafe numbers, and unknown fields", () => {
  errorMatches(() => strictJsonParse(Buffer.from('{"a":1,"a":2}'), "fixture"), /duplicate key/);
  errorMatches(() => strictJsonParse(Buffer.from('{"a":1} true'), "fixture"), /trailing content/);
  errorMatches(() => strictJsonParse(Buffer.from('{"a":9007199254740992}'), "fixture"), /safe integer/);
  errorMatches(() => strictJsonParse(Buffer.from('{"a":-0}'), "fixture"), /safe integer/);
  const initial = makeInitial();
  const document = JSON.parse(initial.ledgerBytes.toString("utf8"));
  document.unexpected = true;
  errorMatches(() => verifyLedgerBytes(Buffer.from(JSON.stringify(document))), /unknown or missing fields/);
});

test("strict and canonical JSON accept finite provider decimal numbers", () => {
  const parsed = strictJsonParse(Buffer.from('{"memory":1.0,"cpu":0.5,"ratio":2.5e-1}'), "fixture");
  assert.deepEqual({ ...parsed }, { memory: 1, cpu: 0.5, ratio: 0.25 });
  assert.equal(canonicalJson(parsed), '{"cpu":0.5,"memory":1,"ratio":0.25}');
  errorMatches(() => strictJsonParse(Buffer.from('{"cpu":1e400}'), "fixture"), /finite numbers/);
});

test("denies resume evidence before activation and requires the activation receipt", () => {
  const { state: b5 } = buildThrough("B5_COMPATIBLE_BASELINE");
  assert.equal(b5.ledger.resumeEligibility, "denied");
  errorMatches(() => advanceLedger(b5.ledgerBytes, {
    toPhase: "B6_FIRST_CLASS_ARMED",
    fencingGeneration: 7,
    at: atMinute(6),
  }), /requires first-class-activation/);
  const document = JSON.parse(b5.ledgerBytes.toString("utf8"));
  document.resumeEligibility = "activation-chain-verified";
  errorMatches(() => verifyLedgerBytes(Buffer.from(JSON.stringify(document))), /summary fields do not match/);
  const b6 = nextState(b5, "B6_FIRST_CLASS_ARMED", 6);
  assert.equal(b6.ledger.resumeEligibility, "activation-chain-verified");
});

test("requires the consumed-attempt tombstone and rejects final-ledger replay or further mutation", () => {
  const { state: complete, states } = buildThrough("B8_COMPLETE");
  errorMatches(() => verifyLedgerBytes(complete.ledgerBytes), /missing its consumed-attempt tombstone/);
  assert.equal(verifyLedgerBytes(complete.ledgerBytes, { tombstoneBytes: complete.tombstoneBytes }).ledger.consumed, true);
  errorMatches(() => advanceLedger(complete.ledgerBytes, {
    currentTombstoneBytes: complete.tombstoneBytes,
    toPhase: "B8_COMPLETE",
    fencingGeneration: 10,
    at: atMinute(9),
  }), /consumed bootstrap attempt cannot advance/);
  errorMatches(() => holdLedger(complete.ledgerBytes, {
    fencingGeneration: 10,
    reasonCode: "IMPOSSIBLE_HOLD",
    evidenceSha256: hash("7"),
    at: atMinute(9),
  }), /missing its consumed-attempt tombstone/);
  errorMatches(() => verifyLedgerBytes(states.get("B7_RESUMING").ledgerBytes, {
    tombstoneBytes: complete.tombstoneBytes,
  }), /unconsumed ledger must not have/);
  const alteredTombstone = JSON.parse(complete.tombstoneBytes.toString("utf8"));
  alteredTombstone.completedLedgerSha256 = hash("0");
  errorMatches(() => verifyLedgerBytes(complete.ledgerBytes, {
    tombstoneBytes: Buffer.from(JSON.stringify(alteredTombstone)),
  }), /does not match/);
  const alteredPredecessor = JSON.parse(complete.tombstoneBytes.toString("utf8"));
  alteredPredecessor.previousLedgerSha256 = hash("2");
  errorMatches(() => verifyLedgerBytes(complete.ledgerBytes, {
    tombstoneBytes: Buffer.from(JSON.stringify(alteredPredecessor)),
  }), /does not match/);
});

test("binds a required completion evidence hash only to the consumed B8 event and tombstone", () => {
  const { state: b7 } = buildThrough("B7_RESUMING");
  const receiptBytes = receiptFor(b7, "B8_COMPLETE", 9, 8);
  errorMatches(() => advanceLedger(b7.ledgerBytes, {
    toPhase: "B8_COMPLETE",
    fencingGeneration: 9,
    receiptBytes,
    at: atMinute(8),
  }), /completionEvidenceHash/);
  errorMatches(() => nextState(makeInitial(), "B1_CONTROL_ACQUIRED", 1, {
    completionEvidenceHash: COMPLETION_EVIDENCE_HASH,
  }), /only be supplied when entering B8/);

  const complete = advanceLedger(b7.ledgerBytes, {
    toPhase: "B8_COMPLETE",
    fencingGeneration: 9,
    receiptBytes,
    completionEvidenceHash: COMPLETION_EVIDENCE_HASH,
    at: atMinute(8),
  });
  assert.equal(complete.ledger.events.at(-1).completionEvidenceHash, COMPLETION_EVIDENCE_HASH);
  assert.equal(complete.ledger.events.at(-1).previousLedgerSha256, b7.ledgerSha256);
  assert.equal(complete.tombstone.completionEvidenceHash, COMPLETION_EVIDENCE_HASH);

  const alteredTombstone = JSON.parse(complete.tombstoneBytes.toString("utf8"));
  alteredTombstone.completionEvidenceHash = hash("1");
  errorMatches(() => verifyLedgerBytes(complete.ledgerBytes, {
    tombstoneBytes: Buffer.from(JSON.stringify(alteredTombstone)),
  }), /does not match/);
});

test("rejects corrupt ledgers and event-chain modification", () => {
  errorMatches(() => verifyLedgerBytes(Buffer.from('{"broken":')), /invalid/);
  const b1 = nextState(makeInitial(), "B1_CONTROL_ACQUIRED", 1);
  const document = JSON.parse(b1.ledgerBytes.toString("utf8"));
  document.events[0].fencingGeneration = 99;
  errorMatches(() => verifyLedgerBytes(Buffer.from(JSON.stringify(document))), /hash chain is invalid/);
  const truncated = b1.ledgerBytes.subarray(0, b1.ledgerBytes.length - 20);
  errorMatches(() => verifyLedgerBytes(truncated), /unterminated|invalid/);
});

function cliCreateArguments(ledgerPath, includeYes = true) {
  const args = [
    SCRIPT,
    "create",
    "--ledger", ledgerPath,
    "--attempt-id", IDENTITY.attemptId,
    "--backend-commit", IDENTITY.candidate.backendCommit,
    "--console-commit", IDENTITY.candidate.consoleCommit,
    "--api-image", IDENTITY.candidate.apiImage,
    "--worker-image", IDENTITY.candidate.workerImage,
    "--console-image", IDENTITY.candidate.consoleImage,
    "--database-identity-hash", IDENTITY.databaseIdentityHash,
    "--redis-identity-hash", IDENTITY.redisIdentityHash,
    "--azure-identity-hash", IDENTITY.azureIdentityHash,
    "--admission-context-hash", IDENTITY.admissionContextHash,
    "--operator", GOVERNANCE.operator,
    "--approver", GOVERNANCE.approver,
    "--change-ticket", GOVERNANCE.changeTicket,
    "--fencing-generation", "1",
  ];
  if (includeYes) {
    args.push("--yes");
  }
  return args;
}

function b8CliFixture(directory) {
  const { state: b7 } = buildThrough("B7_RESUMING");
  const ledgerPath = join(directory, "phase-ledger.json");
  const receiptPath = join(directory, "bootstrap-complete-receipt.json");
  const fencingGeneration = b7.ledger.fencingGeneration + 1;
  const currentMinute = Math.floor((Date.now() - BASE_EPOCH) / 60_000);
  const receiptBytes = receiptFor(
    b7,
    "B8_COMPLETE",
    fencingGeneration,
    currentMinute,
  );
  writeFileSync(ledgerPath, b7.ledgerBytes);
  writeFileSync(receiptPath, receiptBytes);
  const argumentsList = [
    "advance",
    "--ledger", ledgerPath,
    "--expected-ledger-sha256", b7.ledgerSha256,
    "--to", "B8_COMPLETE",
    "--fencing-generation", String(fencingGeneration),
    "--receipt", receiptPath,
    "--completion-evidence-sha256", COMPLETION_EVIDENCE_HASH,
    "--yes",
  ];
  return {
    argumentsList,
    b7,
    ledgerPath,
    receiptBytes,
    receiptPath,
    tombstonePath: `${ledgerPath}.consumed.json`,
  };
}

function argumentsWithValue(argumentsList, flag, value) {
  const copy = [...argumentsList];
  const index = copy.indexOf(flag);
  assert.notEqual(index, -1, `missing fixture argument ${flag}`);
  copy[index + 1] = value;
  return copy;
}

function spawnResult(argumentsList) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, argumentsList, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

test("CLI requires --yes, refuses overwrite, and compare-and-swap serializes concurrent writers", async () => {
  const realTemp = realpathSync(tmpdir());
  const directory = mkdtempSync(join(realTemp, "workforce-bootstrap-ledger-test-"));
  const ledgerPath = join(directory, "phase-ledger.json");
  try {
    const denied = spawnSync(process.execPath, cliCreateArguments(ledgerPath, false), { encoding: "utf8" });
    assert.notEqual(denied.status, 0);
    assert.match(denied.stderr, /required option --yes|explicit --yes/);

    const created = spawnSync(process.execPath, cliCreateArguments(ledgerPath), { encoding: "utf8" });
    assert.equal(created.status, 0, created.stderr);
    const summary = JSON.parse(created.stdout);
    assert.equal(summary.phase, "B0_ARTIFACT_READY");
    assert.equal(summary.resumeEligibility, "denied");

    const overwrite = spawnSync(process.execPath, cliCreateArguments(ledgerPath), { encoding: "utf8" });
    assert.notEqual(overwrite.status, 0);
    assert.match(overwrite.stderr, /refuses to overwrite/);

    const advanceArguments = [
      SCRIPT, "advance",
      "--ledger", ledgerPath,
      "--expected-ledger-sha256", summary.ledgerSha256,
      "--to", "B1_CONTROL_ACQUIRED",
      "--fencing-generation", "2",
      "--yes",
    ];
    const [first, second] = await Promise.all([
      spawnResult(advanceArguments),
      spawnResult(advanceArguments),
    ]);
    const successes = [first, second].filter((result) => result.code === 0);
    const failures = [first, second].filter((result) => result.code !== 0);
    assert.equal(successes.length, 1, JSON.stringify({ first, second }));
    assert.equal(failures.length, 1, JSON.stringify({ first, second }));
    assert.match(failures[0].stderr, /exclusive ledger lock|compare-and-swap failed/);

    const inspected = JSON.parse(execFileSync(process.execPath, [
      SCRIPT, "inspect", "--ledger", ledgerPath,
    ], { encoding: "utf8" }));
    assert.equal(inspected.phase, "B1_CONTROL_ACQUIRED");
    assert.equal(inspected.fencingGeneration, 2);
    assert.equal(readdirSync(directory).filter((name) => name.endsWith(".tmp")).length, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("CLI refuses corrupt current state without replacing it", () => {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), "workforce-bootstrap-corrupt-test-"));
  const ledgerPath = join(directory, "phase-ledger.json");
  try {
    const created = spawnSync(process.execPath, cliCreateArguments(ledgerPath), { encoding: "utf8" });
    assert.equal(created.status, 0, created.stderr);
    const corruptBytes = Buffer.from('{"schemaVersion":1,"schemaVersion":2}\n');
    writeFileSync(ledgerPath, corruptBytes);
    const before = readFileSync(ledgerPath);
    const result = spawnSync(process.execPath, [
      SCRIPT, "advance",
      "--ledger", ledgerPath,
      "--expected-ledger-sha256", sha256Bytes(before),
      "--to", "B1_CONTROL_ACQUIRED",
      "--fencing-generation", "2",
      "--yes",
    ], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /duplicate key/);
    assert.deepEqual(readFileSync(ledgerPath), before);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("CLI hold is fail-closed, preserves progress, and repository output is forbidden", () => {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), "workforce-bootstrap-hold-test-"));
  const ledgerPath = join(directory, "phase-ledger.json");
  try {
    const created = spawnSync(process.execPath, cliCreateArguments(ledgerPath), { encoding: "utf8" });
    assert.equal(created.status, 0, created.stderr);
    const initial = JSON.parse(created.stdout);

    const missingYes = spawnSync(process.execPath, [
      SCRIPT, "hold",
      "--ledger", ledgerPath,
      "--expected-ledger-sha256", initial.ledgerSha256,
      "--fencing-generation", "2",
      "--reason-code", "OPERATOR_HOLD",
      "--evidence-sha256", hash("9"),
    ], { encoding: "utf8" });
    assert.notEqual(missingYes.status, 0);
    assert.match(missingYes.stderr, /required option --yes|explicit --yes/);

    const heldResult = spawnSync(process.execPath, [
      SCRIPT, "hold",
      "--ledger", ledgerPath,
      "--expected-ledger-sha256", initial.ledgerSha256,
      "--fencing-generation", "2",
      "--reason-code", "OPERATOR_HOLD",
      "--evidence-sha256", hash("9"),
      "--yes",
    ], { encoding: "utf8" });
    assert.equal(heldResult.status, 0, heldResult.stderr);
    const held = JSON.parse(heldResult.stdout);
    assert.equal(held.phase, HELD);
    assert.equal(held.progressPhase, "B0_ARTIFACT_READY");
    assert.equal(held.rollbackFloor, "legacy-allowed");

    const resumed = spawnSync(process.execPath, [
      SCRIPT, "advance",
      "--ledger", ledgerPath,
      "--expected-ledger-sha256", held.ledgerSha256,
      "--to", "B1_CONTROL_ACQUIRED",
      "--fencing-generation", "3",
      "--yes",
    ], { encoding: "utf8" });
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal(JSON.parse(resumed.stdout).phase, "B1_CONTROL_ACQUIRED");

    const repositoryPath = join(resolve(TEST_DIR, "../.."), "forbidden-bootstrap-ledger-output.json");
    const forbidden = spawnSync(process.execPath, cliCreateArguments(repositoryPath), { encoding: "utf8" });
    assert.notEqual(forbidden.status, 0);
    assert.match(forbidden.stderr, /outside the repository/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("CLI recovers a B8 transaction interrupted after the tombstone becomes durable", () => {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), "workforce-bootstrap-b8-recovery-test-"));
  const fixture = b8CliFixture(directory);
  try {
    assert.throws(() => runCli(fixture.argumentsList, {
      faultInjector(point) {
        if (point === B8_COMMIT_FAULT_POINTS.afterTombstoneWrite) {
          throw new Error("injected crash after durable B8 tombstone");
        }
      },
    }), /injected crash after durable B8 tombstone/);

    assert.deepEqual(readFileSync(fixture.ledgerPath), fixture.b7.ledgerBytes);
    assert.equal(existsSync(fixture.tombstonePath), true);
    assert.equal(existsSync(`${fixture.ledgerPath}.lock`), false);
    const tombstoneBytes = readFileSync(fixture.tombstonePath);
    const tombstone = JSON.parse(tombstoneBytes.toString("utf8"));
    assert.equal(tombstone.previousLedgerSha256, fixture.b7.ledgerSha256);
    assert.equal(tombstone.completionEvidenceHash, COMPLETION_EVIDENCE_HASH);

    const wrongCas = argumentsWithValue(
      fixture.argumentsList,
      "--expected-ledger-sha256",
      hash("9"),
    );
    assert.throws(() => runCli(wrongCas), /compare-and-swap failed/);
    assert.deepEqual(readFileSync(fixture.ledgerPath), fixture.b7.ledgerBytes);
    assert.deepEqual(readFileSync(fixture.tombstonePath), tombstoneBytes);

    const alteredReceiptBytes = Buffer.from(
      JSON.stringify(JSON.parse(fixture.receiptBytes.toString("utf8"))),
      "utf8",
    );
    assert.notEqual(sha256Bytes(alteredReceiptBytes), sha256Bytes(fixture.receiptBytes));
    writeFileSync(fixture.receiptPath, alteredReceiptBytes);
    assert.throws(
      () => runCli(fixture.argumentsList),
      /pending B8 transaction does not match the exact replay inputs/,
    );
    assert.deepEqual(readFileSync(fixture.ledgerPath), fixture.b7.ledgerBytes);
    assert.deepEqual(readFileSync(fixture.tombstonePath), tombstoneBytes);

    writeFileSync(fixture.receiptPath, fixture.receiptBytes);
    const recovered = runCli(fixture.argumentsList);
    assert.equal(recovered.phase, "B8_COMPLETE");
    assert.equal(recovered.consumed, true);
    const completedBytes = readFileSync(fixture.ledgerPath);
    const verified = verifyLedgerBytes(completedBytes, { tombstoneBytes });
    assert.equal(verified.ledgerSha256, tombstone.completedLedgerSha256);
    assert.equal(verified.tombstone.previousLedgerSha256, fixture.b7.ledgerSha256);
    assert.equal(readdirSync(directory).some((name) => name.endsWith(".tmp")), false);
    assert.equal(existsSync(`${fixture.ledgerPath}.lock`), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("CLI adopts an exact completed B8 replay after the success acknowledgement is lost", () => {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), "workforce-bootstrap-b8-ack-test-"));
  const fixture = b8CliFixture(directory);
  try {
    assert.throws(() => runCli(fixture.argumentsList, {
      faultInjector(point) {
        if (point === B8_COMMIT_FAULT_POINTS.afterLedgerReplace) {
          throw new Error("injected lost B8 success acknowledgement");
        }
      },
    }), /injected lost B8 success acknowledgement/);

    const completedBytes = readFileSync(fixture.ledgerPath);
    const tombstoneBytes = readFileSync(fixture.tombstonePath);
    const completed = verifyLedgerBytes(completedBytes, { tombstoneBytes });
    assert.equal(completed.ledger.phase, "B8_COMPLETE");
    assert.equal(completed.ledger.consumed, true);
    assert.equal(completed.tombstone.previousLedgerSha256, fixture.b7.ledgerSha256);

    const replayed = runCli(fixture.argumentsList);
    assert.equal(replayed.phase, "B8_COMPLETE");
    assert.equal(replayed.ledgerSha256, completed.ledgerSha256);
    assert.deepEqual(readFileSync(fixture.ledgerPath), completedBytes);
    assert.deepEqual(readFileSync(fixture.tombstonePath), tombstoneBytes);

    const differentEvidence = argumentsWithValue(
      fixture.argumentsList,
      "--completion-evidence-sha256",
      hash("1"),
    );
    assert.throws(
      () => runCli(differentEvidence),
      /completion evidence does not match the durable transaction/,
    );
    assert.deepEqual(readFileSync(fixture.ledgerPath), completedBytes);
    assert.deepEqual(readFileSync(fixture.tombstonePath), tombstoneBytes);
    assert.equal(readdirSync(directory).some((name) => name.endsWith(".tmp")), false);
    assert.equal(existsSync(`${fixture.ledgerPath}.lock`), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
