#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  FINAL_PHASE_RECEIPT_CONTRACT_VERSION,
  FINAL_PHASE_RECEIPT_SPECS,
  PHASE_MIGRATIONS,
  buildFinalPhaseContext,
  canonicalPhaseJson,
  phaseSha256Bytes,
} from "../production-bootstrap-phase-receipt-contracts.mjs";

const [outputDirectory, backendCommit, consoleCommit, nowText] = process.argv.slice(2);
const now = Number(nowText);
if (!outputDirectory || !/^[0-9a-f]{40}$/.test(backendCommit ?? "") ||
  !/^[0-9a-f]{40}$/.test(consoleCommit ?? "") || !Number.isSafeInteger(now)) {
  throw new Error("usage: fixture.mjs OUTPUT_DIR BACKEND_COMMIT CONSOLE_COMMIT NOW_EPOCH");
}

mkdirSync(outputDirectory, { recursive: true });
const hash = (character) => `sha256:${character.repeat(64)}`;
const iso = (offset) => new Date((now + offset) * 1000).toISOString().replace(".000Z", "Z");
const encode = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
const write = (name, bytes) => writeFileSync(resolve(outputDirectory, name), bytes, { mode: 0o600 });

const attemptId = "a".repeat(32);
const authority = {
  subscriptionId: "12345678-1234-4234-8234-123456789abc",
  resourceGroupName: "workforce-os-prod",
  resourceGroupResourceId:
    "/subscriptions/12345678-1234-4234-8234-123456789abc/resourceGroups/workforce-os-prod",
  apiContainerAppResourceId:
    "/subscriptions/12345678-1234-4234-8234-123456789abc/resourceGroups/workforce-os-prod/providers/Microsoft.App/containerApps/apex-gtm-api",
  workerContainerAppResourceId:
    "/subscriptions/12345678-1234-4234-8234-123456789abc/resourceGroups/workforce-os-prod/providers/Microsoft.App/containerApps/apex-gtm-worker",
  consoleContainerAppResourceId:
    "/subscriptions/12345678-1234-4234-8234-123456789abc/resourceGroups/workforce-os-prod/providers/Microsoft.App/containerApps/nikxius-web",
};
const candidate = {
  backendCommit,
  consoleCommit,
  apiImage: `workforceosprodacr.azurecr.io/apex-api@${hash("1")}`,
  workerImage: `workforceosprodacr.azurecr.io/apex-api@${hash("1")}`,
  consoleImage: `workforceosprodacr.azurecr.io/workforceos-fe@${hash("3")}`,
};
const identity = {
  attemptId,
  candidate,
  databaseIdentityHash: hash("d"),
  redisIdentityHash: hash("c"),
  azureIdentityHash: phaseSha256Bytes(Buffer.from(canonicalPhaseJson(authority), "utf8")),
  admissionContextHash: hash("a"),
};
const governance = {
  operator: "release.operator",
  approver: "release.approver",
  changeTicket: "CHG-2026-0814",
};
const clerkPlan = {
  rawPlanSha256: hash("1"),
  dryRunEvidenceSha256: hash("2"),
  inventoryEvidenceHash: hash("3"),
  minimumEventVersion: (now - 600) * 1000,
  expectedActiveOrganizationCount: 2,
  expectedActiveMembershipCount: 3,
  expectedActiveUserCount: 3,
  executor: {
    name: "workforce-production-clerk-reconciliation-executor",
    version: "v1",
    sha256: hash("4"),
  },
  dryRunPassed: true,
  approver: governance.approver,
  planSignatureSha256: hash("5"),
  signatureNamespace: "workforce-os-clerk-reconciliation-plan",
  independentApprovalEvidenceHash: hash("6"),
  verifiedAt: iso(-300),
  expiresAt: iso(3600),
};

const entry = {
  schemaVersion: 2,
  environment: "production",
  kind: "initial-bootstrap-entry",
  authorizationScope: "bootstrap-entry-admission-only",
  bootstrapAttemptId: attemptId,
  backendCandidateCommit: backendCommit,
  consoleCandidateCommit: consoleCommit,
  status: "prepared-and-quiesced",
  preparedAt: iso(-120),
  expiresAt: iso(900),
  ...governance,
  admissionContextHash: identity.admissionContextHash,
  authority,
  redisIdentityHash: identity.redisIdentityHash,
  databaseIdentityHash: identity.databaseIdentityHash,
  lease: { generation: 1 },
  targetArtifacts: {
    api: { image: candidate.apiImage, plannedRevision: "apex-gtm-api--candidate-a" },
    worker: { image: candidate.workerImage, plannedRevision: "apex-gtm-worker--candidate-a" },
    console: { image: candidate.consoleImage, plannedRevision: "nikxius-web--candidate-a" },
  },
  clerkReconciliationPlan: clerkPlan,
};
let previousBytes = encode(entry);
write("entry.json", previousBytes);

function queueState(paused, workerCount) {
  return {
    paused,
    waiting: 0,
    active: 0,
    delayed: 0,
    prioritized: 0,
    completed: 10,
    failed: 0,
    waitingChildren: 0,
    pausedJobs: 0,
    workerCount,
  };
}

function closedQuiescence(generation, issuedOffset) {
  const queues = {
    agentRuns: queueState(true, 0),
    graphRuns: queueState(true, 0),
    outreachSend: queueState(true, 0),
  };
  return {
    nonComplianceApiMutationsBlocked: true,
    liveSendAllowlistEmpty: true,
    queueObservations: [
      {
        observedAt: iso(issuedOffset - 30),
        stableSince: iso(issuedOffset - 40),
        evidenceHash: hash("1"),
        queues,
      },
      {
        observedAt: iso(issuedOffset - 20),
        stableSince: iso(issuedOffset - 40),
        evidenceHash: hash("2"),
        queues: structuredClone(queues),
      },
    ],
    writerFence: {
      schemaVersion: 1,
      target: "workforce-os-production",
      mode: "closed",
      bootstrapAttemptId: attemptId,
      generation,
      issuedAt: iso(issuedOffset - 60),
      observedAt: iso(issuedOffset - 10),
      expiresAt: iso(1200),
      stateHash: hash("3"),
      activeWriters: 0,
      activeComplianceWriters: 0,
    },
    evidenceHash: hash("4"),
  };
}

function deploymentIdentity(role, revision, variant) {
  const console = role === "console";
  return {
    image: console ? candidate.consoleImage : candidate.apiImage,
    manifestDigest: console ? hash("3") : hash("1"),
    platformDigest: console ? hash("4") : hash("2"),
    ociRevision: console ? consoleCommit : backendCommit,
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

const disabled = disabledDeployments();
let armed;

function evidenceFor(kind, generation, issuedOffset) {
  if (kind === "production-schema-result") {
    return {
      targetRevisions: {
        api: entry.targetArtifacts.api.plannedRevision,
        worker: entry.targetArtifacts.worker.plannedRevision,
        console: entry.targetArtifacts.console.plannedRevision,
      },
      migrationExecution: PHASE_MIGRATIONS.map((migration, index) => ({
        ...migration,
        writerScopes: [...migration.writerScopes],
        preflightPassed: true,
        invocationVerified: true,
        applied: true,
        postconditionsPassed: true,
        duplicateInventoryHash: hash(String((index + 1) % 10)),
        postconditionEvidenceHash: hash(String((index + 2) % 10)),
      })),
      clerkReconciliationPlan: structuredClone(clerkPlan),
      clerkCutover: {
        schemaReady: true,
        rowCount: 1,
        ready: true,
        minimumEventVersion: clerkPlan.minimumEventVersion,
        inventoryEvidenceHash: clerkPlan.inventoryEvidenceHash,
        expectedActiveOrganizationCount: 2,
        expectedActiveMembershipCount: 3,
        expectedActiveUserCount: 3,
        activeOrganizationCount: 2,
        activeMembershipCount: 3,
        activeUserCount: 3,
        projectionMismatchRows: 0,
        orphanActiveAuthorityRows: 0,
        readinessViolationRows: 0,
        invariantEvidenceHash: hash("6"),
      },
      schemaInventory: {
        outreachIdempotencyDuplicateGroups: 0,
        legacyGmailReplySequenceStopRows: 1,
        managerRoleRows: 1,
        graphRunRunningRows: 0,
        graphRunAwaitingApprovalRows: 1,
        graphActiveOrgDuplicateGroups: 0,
        graphActiveWithoutRecoveryStateRows: 0,
        graphLifecycleSchemaReady: true,
        replySchemaReady: true,
        replySourceDuplicateGroups: 0,
        replyConversationDuplicateGroups: 0,
        nullSourceReplyRows: 0,
        replySlotDuplicateRows: 0,
        duplicateInventoryEvidenceHash: hash("7"),
      },
      deliveryState: {
        deliveryUnknownEnumReady: true,
        failedEnumReady: true,
        deliveryUnknownWriteMode: "disabled",
        deliveryUnknownWriteAck: null,
        failedStatusWritesEnabled: false,
        failedStatusWritesAck: null,
        sendingRows: 0,
        firstClassDeliveryUnknownRows: 0,
        firstClassFailedRows: 0,
        legacyDeliveryUnknownMarkerRows: 0,
        legacyAutoFailedMarkerRows: 2,
        legacyMarkerInventoryEvidenceHash: hash("8"),
      },
      quiescence: closedQuiescence(generation, issuedOffset),
      stagingRehearsalEvidenceHash: hash("9"),
      productionApplyEvidenceHash: hash("a"),
      backupRestoreEvidenceHash: hash("b"),
      schemaEvidenceHash: hash("c"),
    };
  }
  if (kind === "enum-aware-disabled-baseline") {
    return {
      deployments: structuredClone(disabled),
      writeGates: writeGates(false),
      legacyRevisions: {
        allLegacyRevisionsInactive: true,
        apiActiveLegacyRevisionCount: 0,
        workerActiveLegacyRevisionCount: 0,
        consoleActiveLegacyRevisionCount: 0,
        evidenceHash: hash("d"),
      },
      quiescence: closedQuiescence(generation, issuedOffset),
      compatibilityAttestation: "enum-aware-api-worker-console-baseline-v1",
      baselineEvidenceHash: hash("e"),
    };
  }
  if (kind === "first-class-activation") {
    const deployments = structuredClone(disabled);
    deployments.worker.identity = deploymentIdentity(
      "worker", "apex-gtm-worker--first-class-a", "8",
    );
    armed = {
      deployments,
      writeGates: writeGates(true),
      rollbackBaseline: rollbackBaseline(disabled),
    };
    return {
      ...structuredClone(armed),
      readerDrain: {
        legacyApiReadersActive: 0,
        legacyWorkerWritersActive: 0,
        legacyConsoleReadersActive: 0,
        evidenceHash: hash("f"),
      },
      deliveryUnknownActivation: {
        readersDrained: true,
        rollbackBaselinesVerified: true,
        firstClassDeliveryUnknownRows: 0,
        evidenceHash: hash("1"),
      },
      failedActivation: {
        readersDrained: true,
        legacyInventoryReviewed: true,
        unreviewedHistoricalMarkersPromotedRows: 0,
        firstClassFailedRows: 0,
        legacyInventoryEvidenceHash: hash("2"),
        evidenceHash: hash("3"),
      },
      quiescence: closedQuiescence(generation, issuedOffset),
      activationEvidenceHash: hash("4"),
    };
  }

  const actions = [
    "release-writer-fence",
    "start-first-class-consumers",
    "resume-agent-runs",
    "resume-graph-runs",
    "resume-outreach-send",
    "unblock-api-mutations",
  ];
  const steps = actions.map((action, index) => ({
    sequence: index + 1,
    action,
    startedAt: iso(-29 + index * 4),
    completedAt: iso(-27 + index * 4),
    evidenceHash: hash(String((index + 5) % 10)),
  }));
  const resumed = () => queueState(false, 1);
  const paused = () => queueState(true, 1);
  return {
    ...structuredClone(armed),
    resume: {
      terminalOpenIntent: {
        bootstrapAttemptId: attemptId,
        generation,
        previousStateHash: hash("3"),
        persistedAt: iso(-30),
        forwardOnly: true,
        evidenceHash: hash("9"),
      },
      steps,
      pausedConsumerProof: {
        queues: {
          agentRuns: paused(),
          graphRuns: paused(),
          outreachSend: paused(),
        },
        provedAt: steps[1].completedAt,
        evidenceHash: hash("8"),
      },
      queues: {
        agentRuns: resumed(),
        graphRuns: resumed(),
        outreachSend: resumed(),
      },
      writerFenceRelease: {
        bootstrapAttemptId: attemptId,
        generation,
        previousStateHash: hash("3"),
        openEpoch: {
          schemaVersion: 1,
          target: "workforce-os-production",
          mode: "open",
          bootstrapAttemptId: attemptId,
          generation,
        },
        openStateHash: hash("4"),
        releasedAt: steps[0].completedAt,
        terminalOpen: true,
        evidenceHash: hash("a"),
      },
      apiMutations: {
        blocked: false,
        ingressEnabled: true,
        readinessPassed: true,
        restoredAt: steps[5].completedAt,
        evidenceHash: hash("b"),
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
      apiReady: true,
      workerReady: true,
      consoleReady: true,
      releaseConfigVerified: true,
      failedListSmokePassed: true,
      dashboardPolicySmokePassed: true,
      releaseConfigEvidenceHash: hash("1"),
      failedListSmokeEvidenceHash: hash("2"),
      dashboardPolicySmokeEvidenceHash: hash("3"),
      evidenceHash: hash("d"),
    },
    finalInventory: {
      sendingRows: 0,
      firstClassDeliveryUnknownRows: 0,
      firstClassFailedRows: 0,
      unreviewedHistoricalMarkersPromotedRows: 0,
      evidenceHash: hash("e"),
    },
    bootstrapEvidenceHash: hash("f"),
  };
}

const issuedOffsets = [-90, -60, -30, -5];
FINAL_PHASE_RECEIPT_SPECS.forEach((spec, index) => {
  const generation = index + 2;
  const issuedOffset = issuedOffsets[index];
  const previousReceiptSha256 = phaseSha256Bytes(previousBytes);
  const evidence = evidenceFor(spec.kind, generation, issuedOffset);
  const context = buildFinalPhaseContext({
    receiptKind: spec.kind,
    identity: structuredClone(identity),
    fencingGeneration: generation,
    previousReceiptSha256,
    observedAt: iso(issuedOffset - 2),
    evidence: structuredClone(evidence),
  });
  const contextBytes = encode(context);
  const receipt = {
    schemaVersion: 1,
    receiptContractVersion: FINAL_PHASE_RECEIPT_CONTRACT_VERSION,
    environment: "production",
    kind: spec.kind,
    authorizationScope: spec.authorizationScope,
    ...structuredClone(identity),
    fencingGeneration: generation,
    sequence: spec.sequence,
    previousReceiptSha256,
    phase: spec.phase,
    status: spec.status,
    rollbackPolicy: structuredClone(spec.rollbackPolicy),
    clerkInvocation: "verified",
    phaseContextHash: phaseSha256Bytes(contextBytes),
    issuedAt: iso(issuedOffset),
    expiresAt: iso(600),
    ...governance,
    evidence,
  };
  const receiptBytes = encode(receipt);
  write(`${spec.kind}.context.json`, contextBytes);
  write(`${spec.kind}.json`, receiptBytes);
  previousBytes = receiptBytes;
});
