import assert from "node:assert/strict";
import test from "node:test";

import {
  PRODUCTION_AUTHORITY_DRAIN_CONTRACT,
  PRODUCTION_AZURE_AUTHORITY_CONTRACT,
  assertReadOnlyAzureAuditCommand,
  canonicalJson,
  evaluateProductionAuthorityDrainCheckpoint,
  evaluateProductionAzureMutationAuthority,
} from "../production-azure-mutation-authority-audit.mjs";

const CONTRACT = PRODUCTION_AZURE_AUTHORITY_CONTRACT;
const ROLE_ROOT = `/subscriptions/${CONTRACT.subscriptionId}/providers/Microsoft.Authorization/roleDefinitions`;
const ROLE_IDS = {
  registry: `${ROLE_ROOT}/11111111-1111-4111-8111-111111111111`,
  app: `${ROLE_ROOT}/22222222-2222-4222-8222-222222222222`,
  storage: `${ROLE_ROOT}/33333333-3333-4333-8333-333333333333`,
  owner: `${ROLE_ROOT}/44444444-4444-4444-8444-444444444444`,
  excluded: `${ROLE_ROOT}/55555555-5555-4555-8555-555555555555`,
};

const PRINCIPALS = {
  backendBuild: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
  consoleBuild: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
  backendRelease: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
  consoleRelease: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4",
  unexpected: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
};

const CLIENTS = {
  backendBuild: "cccccccc-cccc-4ccc-8ccc-ccccccccccc1",
  consoleBuild: "cccccccc-cccc-4ccc-8ccc-ccccccccccc2",
  backendRelease: "cccccccc-cccc-4ccc-8ccc-ccccccccccc3",
  consoleRelease: "cccccccc-cccc-4ccc-8ccc-ccccccccccc4",
};

function role(id, actions, dataActions = [], notActions = [], notDataActions = []) {
  return {
    id,
    roleName: "not retained in the report",
    permissions: [{ actions, notActions, dataActions, notDataActions }],
  };
}

function assignment(principalId, roleDefinitionId, scope, condition = null) {
  return {
    principalId,
    principalName: "person@example.invalid",
    principalType: "ServicePrincipal",
    roleDefinitionId,
    scope,
    condition,
    conditionVersion: condition === null ? null : "2.0",
  };
}

function blobCondition() {
  return `(
  (
    !(ActionMatches{'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read'})
    AND
    !(ActionMatches{'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/write'})
  )
  OR
  (
    @Resource[Microsoft.Storage/storageAccounts/blobServices/containers:name]
      StringEquals 'production-control'
    AND
    (
      @Resource[Microsoft.Storage/storageAccounts/blobServices/containers/blobs:path]
        StringEquals 'workforce-os/initial-production-bootstrap/state-v1.json'
      OR
      @Resource[Microsoft.Storage/storageAccounts/blobServices/containers/blobs:path]
        StringEquals 'workforce-os/initial-production-bootstrap/authority-drain-checkpoint-v1'
    )
  )
)`;
}

function identityId(key) {
  const name = CONTRACT.identities[key].name;
  return `${CONTRACT.resourceGroupId}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${name}`;
}

function requiredPimScopes() {
  return [...new Set([
    `/subscriptions/${CONTRACT.subscriptionId}`.toLowerCase(),
    CONTRACT.resourceGroupId.toLowerCase(),
    ...Object.values(CONTRACT.targets).map((target) => target.resourceId.toLowerCase()),
    CONTRACT.targets.stateStorage.storageAccountResourceId.toLowerCase(),
    CONTRACT.targets.stateStorage.blobServiceResourceId.toLowerCase(),
    ...Object.keys(CONTRACT.identities).map((key) => identityId(key).toLowerCase()),
  ])].sort();
}

function checkpointStructuralSnapshot(snapshot, lastModified = "2026-08-01T05:00:00Z") {
  delete snapshot.credentialDrainCheckpoint;
  const preDrain = evaluateProductionAzureMutationAuthority(snapshot);
  assert.equal(preDrain.summary.structuralExclusive, true);
  assert.match(preDrain.structuralEvidenceHash, /^sha256:[0-9a-f]{64}$/u);
  snapshot.credentialDrainCheckpoint = {
    exists: true,
    blobName: preDrain.credentialDrainCheckpointBlob,
    lastModified,
    contentLength: 0,
    leaseState: "available",
    leaseStatus: "unlocked",
    metadata: {
      kind: "workforce-os-production-authority-drain-checkpoint-v1",
      structural_evidence_sha256: preDrain.structuralEvidenceHash.replace("sha256:", ""),
      subscription_id: CONTRACT.subscriptionId,
    },
  };
  return snapshot;
}

function exclusiveSnapshot() {
  const identities = Object.fromEntries(Object.keys(CONTRACT.identities).map((key) => [key, {
    exists: true,
    resourceId: identityId(key),
    clientId: CLIENTS[key],
    principalId: PRINCIPALS[key],
    federatedCredentials: [{
      issuer: "https://token.actions.githubusercontent.com",
      audiences: ["api://AzureADTokenExchange"],
      subject: CONTRACT.identities[key].subject,
    }],
  }]));
  const resources = Object.fromEntries(Object.entries(CONTRACT.targets).map(([key, target]) => [key, {
    exists: true,
    resourceId: target.resourceId,
  }]));
  resources.registry.adminUserEnabled = false;
  resources.stateStorage.allowSharedKeyAccess = false;
  resources.stateStorage.isSftpEnabled = false;
  const registryAssignments = CONTRACT.targets.registry.expectedIdentityKeys.map((key) =>
    assignment(PRINCIPALS[key], ROLE_IDS.registry, CONTRACT.targets.registry.expectedAssignmentScope));
  const appAssignments = (target) => CONTRACT.targets[target].expectedIdentityKeys.map((key) =>
    assignment(PRINCIPALS[key], ROLE_IDS.app, CONTRACT.targets[target].expectedAssignmentScope));
  const storageAssignments = CONTRACT.targets.stateStorage.expectedIdentityKeys.map((key) =>
    assignment(
      PRINCIPALS[key],
      ROLE_IDS.storage,
      CONTRACT.targets.stateStorage.expectedAssignmentScope,
      blobCondition(),
    ));
  const snapshot = {
    schemaVersion: 1,
    subscriptionId: CONTRACT.subscriptionId,
    observedAt: "2026-08-15T05:00:00Z",
    resources,
    identities,
    activeAssignmentsByScope: {
      registry: registryAssignments,
      api: appAssignments("api"),
      worker: appAssignments("worker"),
      console: appAssignments("console"),
      stateStorage: storageAssignments,
      backendBuildIdentity: [],
      consoleBuildIdentity: [],
      backendReleaseIdentity: [],
      consoleReleaseIdentity: [],
    },
    roleDefinitions: {
      [ROLE_IDS.registry]: role(ROLE_IDS.registry, [
        "Microsoft.ContainerRegistry/registries/read",
        "Microsoft.ContainerRegistry/registries/listBuildSourceUploadUrl/action",
        "Microsoft.ContainerRegistry/registries/scheduleRun/action",
        "Microsoft.ContainerRegistry/registries/runs/read",
      ]),
      [ROLE_IDS.app]: role(ROLE_IDS.app, [
        "Microsoft.App/containerApps/read",
        "Microsoft.App/containerApps/write",
        "Microsoft.App/containerApps/revisions/read",
        "Microsoft.App/containerApps/revisions/activate/action",
        "Microsoft.Authorization/roleAssignments/read",
      ]),
      [ROLE_IDS.storage]: role(ROLE_IDS.storage, [
        "Microsoft.Storage/storageAccounts/read",
        "Microsoft.Authorization/roleAssignments/read",
      ], [
        "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read",
        "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/write",
      ]),
    },
    pim: {
      managementGroupScopes: [],
      eligibilityQueriedScopes: requiredPimScopes(),
      activeQueriedScopes: requiredPimScopes(),
      eligible: [],
      active: [],
    },
    nonRbacAuthority: {
      enabledRegistryTokenCount: 0,
      enabledRegistryTaskCount: 0,
      storageLocalUserCount: 0,
      storageManagementPolicyRules: [],
      storageObjectReplicationPolicies: [],
    },
    collectionIssues: [],
  };
  return checkpointStructuralSnapshot(snapshot);
}

function codes(report) {
  return new Set(report.findings.map((finding) => finding.code));
}

test("an exact exclusive authority snapshot emits controller-compatible evidence", () => {
  const report = evaluateProductionAzureMutationAuthority(exclusiveSnapshot());
  assert.equal(report.status, "GO");
  assert.equal(report.summary.exclusive, true);
  assert.equal(report.summary.structuralExclusive, true);
  assert.equal(report.summary.credentialDrainComplete, true);
  assert.deepEqual(report.findings, []);
  assert.equal(report.controllerEvidence.clientId, CLIENTS.backendRelease);
  assert.equal(report.controllerEvidence.principalObjectId, PRINCIPALS.backendRelease);
  assert.equal(report.controllerEvidence.schemaVersion, 2);
  assert.equal(report.controllerEvidence.structuralEvidenceHash, report.structuralEvidenceHash);
  assert.deepEqual(report.controllerEvidence.credentialDrainCheckpoint, {
    schemaVersion: 1,
    kind: PRODUCTION_AUTHORITY_DRAIN_CONTRACT.kind,
    subscriptionId: CONTRACT.subscriptionId,
    containerName: PRODUCTION_AUTHORITY_DRAIN_CONTRACT.containerName,
    blobName: PRODUCTION_AUTHORITY_DRAIN_CONTRACT.blobName,
    structuralEvidenceHash: report.structuralEvidenceHash,
    checkpointLastModified: "2026-08-01T05:00:00Z",
    minimumAgeSeconds: 864000,
  });
  assert.match(report.controllerEvidenceHash, /^sha256:[0-9a-f]{64}$/u);
  assert.deepEqual(Object.keys(report.controllerEvidence.assignmentsByScope), [
    "api", "worker", "console", "stateStorage",
  ]);
});

test("a structurally exclusive snapshot without a server-timed checkpoint remains NO-GO", () => {
  const snapshot = exclusiveSnapshot();
  delete snapshot.credentialDrainCheckpoint;
  const report = evaluateProductionAzureMutationAuthority(snapshot);
  assert.equal(report.status, "NO-GO");
  assert.equal(report.summary.structuralExclusive, true);
  assert.match(report.structuralEvidenceHash, /^sha256:[0-9a-f]{64}$/u);
  assert(codes(report).has("credential-drain-checkpoint-missing"));
  assert.equal(report.controllerEvidence, null);
});

test("a checkpoint younger than the ten-day credential drain remains NO-GO", () => {
  const snapshot = exclusiveSnapshot();
  snapshot.credentialDrainCheckpoint.lastModified = "2026-08-10T05:00:01Z";
  const report = evaluateProductionAzureMutationAuthority(snapshot);
  assert(codes(report).has("credential-drain-window-open"));
  assert.equal(report.summary.minimumCredentialDrainAgeSeconds, 864000);
});

test("a checkpoint for a different structural authority snapshot fails closed", () => {
  const snapshot = exclusiveSnapshot();
  snapshot.credentialDrainCheckpoint.metadata.structural_evidence_sha256 = "0".repeat(64);
  assert(codes(evaluateProductionAzureMutationAuthority(snapshot))
    .has("credential-drain-structure-mismatch"));
});

test("the controller evidence hash is deterministic across assignment ordering", () => {
  const first = exclusiveSnapshot();
  const second = structuredClone(first);
  second.activeAssignmentsByScope.console.reverse();
  assert.equal(
    evaluateProductionAzureMutationAuthority(first).controllerEvidenceHash,
    evaluateProductionAzureMutationAuthority(second).controllerEvidenceHash,
  );
});

test("the controller evidence hash changes when the checkpoint is reset", () => {
  const first = exclusiveSnapshot();
  const second = structuredClone(first);
  second.credentialDrainCheckpoint.lastModified = "2026-08-02T05:00:00Z";
  assert.notEqual(
    evaluateProductionAzureMutationAuthority(first).controllerEvidenceHash,
    evaluateProductionAzureMutationAuthority(second).controllerEvidenceHash,
  );
});

test("standalone controller checkpoint evaluation requires the reviewed structural hash", () => {
  const snapshot = exclusiveSnapshot();
  const report = evaluateProductionAzureMutationAuthority(snapshot);
  const valid = evaluateProductionAuthorityDrainCheckpoint(
    snapshot.credentialDrainCheckpoint,
    snapshot.observedAt,
    report.structuralEvidenceHash,
  );
  assert.equal(valid.finding, null);
  assert.equal(valid.evidence.structuralEvidenceHash, report.structuralEvidenceHash);
  const mismatch = evaluateProductionAuthorityDrainCheckpoint(
    snapshot.credentialDrainCheckpoint,
    snapshot.observedAt,
    `sha256:${"0".repeat(64)}`,
  );
  assert.equal(mismatch.evidence, null);
  assert.equal(mismatch.finding.code, "credential-drain-structure-mismatch");
});

test("a missing expected identity fails closed", () => {
  const snapshot = exclusiveSnapshot();
  snapshot.identities.backendRelease.exists = false;
  const report = evaluateProductionAzureMutationAuthority(snapshot);
  assert.equal(report.status, "NO-GO");
  assert(codes(report).has("missing-or-invalid-expected-identity"));
  assert.equal(report.controllerEvidence, null);
});

test("an additional federation on an expected identity fails closed", () => {
  const snapshot = exclusiveSnapshot();
  snapshot.identities.consoleRelease.federatedCredentials.push({
    issuer: "https://token.actions.githubusercontent.com",
    audiences: ["api://AzureADTokenExchange"],
    subject: "repo:other/repository:environment:production",
  });
  const report = evaluateProductionAzureMutationAuthority(snapshot);
  assert(codes(report).has("unexpected-federated-identity-credential"));
});

test("an inherited wildcard writer and delegator fails closed", () => {
  const snapshot = exclusiveSnapshot();
  snapshot.roleDefinitions[ROLE_IDS.owner] = role(ROLE_IDS.owner, ["*"]);
  snapshot.activeAssignmentsByScope.api.push(assignment(
    PRINCIPALS.unexpected,
    ROLE_IDS.owner,
    `/subscriptions/${CONTRACT.subscriptionId}`,
  ));
  const report = evaluateProductionAzureMutationAuthority(snapshot);
  assert(codes(report).has("unexpected-active-writer"));
  assert(codes(report).has("unexpected-authority-delegator"));
});

test("NotActions exclusions are honored when classifying a wildcard role", () => {
  const snapshot = exclusiveSnapshot();
  snapshot.roleDefinitions[ROLE_IDS.excluded] = role(
    ROLE_IDS.excluded,
    ["*"],
    [],
    ["Microsoft.App/containerApps/*", "Microsoft.Authorization/*"],
  );
  snapshot.activeAssignmentsByScope.api.push(assignment(
    PRINCIPALS.unexpected,
    ROLE_IDS.excluded,
    CONTRACT.targets.api.resourceId,
  ));
  checkpointStructuralSnapshot(snapshot);
  assert.equal(evaluateProductionAzureMutationAuthority(snapshot).status, "GO");
});

test("a group writer at the control-container child scope fails closed", () => {
  const snapshot = exclusiveSnapshot();
  const extra = assignment(
    PRINCIPALS.unexpected,
    ROLE_IDS.storage,
    CONTRACT.targets.stateStorage.resourceId,
    blobCondition(),
  );
  extra.principalType = "Group";
  snapshot.activeAssignmentsByScope.stateStorage.push(extra);
  assert(codes(evaluateProductionAzureMutationAuthority(snapshot)).has("unexpected-active-writer"));
});

test("a widened storage condition fails closed", () => {
  const snapshot = exclusiveSnapshot();
  snapshot.activeAssignmentsByScope.stateStorage[0].condition = blobCondition()
    .replace("state-v1.json", "*");
  const report = evaluateProductionAzureMutationAuthority(snapshot);
  assert(codes(report).has("unsupported-authority-condition"));
  assert(codes(report).has("unexpected-active-writer"));
});

test("eligible PIM mutation authority fails closed", () => {
  const snapshot = exclusiveSnapshot();
  snapshot.roleDefinitions[ROLE_IDS.owner] = role(ROLE_IDS.owner, ["*"]);
  snapshot.pim.eligible.push(assignment(
    PRINCIPALS.unexpected,
    ROLE_IDS.owner,
    CONTRACT.resourceGroupId,
  ));
  assert(codes(evaluateProductionAzureMutationAuthority(snapshot)).has("eligible-pim-authority"));
});

test("incomplete PIM coverage fails closed", () => {
  const snapshot = exclusiveSnapshot();
  snapshot.pim.eligibilityQueriedScopes.pop();
  assert(codes(evaluateProductionAzureMutationAuthority(snapshot))
    .has("pim-eligibility-coverage-incomplete"));
});

test("an unresolved role definition fails closed", () => {
  const snapshot = exclusiveSnapshot();
  delete snapshot.roleDefinitions[ROLE_IDS.app];
  assert(codes(evaluateProductionAzureMutationAuthority(snapshot)).has("unresolved-role-definition"));
});

test("non-RBAC credential and task channels fail closed", () => {
  const snapshot = exclusiveSnapshot();
  snapshot.resources.registry.adminUserEnabled = true;
  snapshot.resources.stateStorage.allowSharedKeyAccess = true;
  snapshot.resources.stateStorage.isSftpEnabled = true;
  snapshot.nonRbacAuthority.enabledRegistryTokenCount = 1;
  snapshot.nonRbacAuthority.enabledRegistryTaskCount = 1;
  snapshot.nonRbacAuthority.storageLocalUserCount = 1;
  const found = codes(evaluateProductionAzureMutationAuthority(snapshot));
  for (const code of [
    "registry-admin-credential-channel-enabled",
    "storage-shared-key-channel-enabled",
    "storage-sftp-channel-enabled",
    "registry-token-authority-present",
    "registry-task-authority-present",
    "storage-local-user-authority-present",
  ]) assert(found.has(code), code);
});

test("a lifecycle rule that can tier or delete the exact control blob fails closed", () => {
  const snapshot = exclusiveSnapshot();
  snapshot.nonRbacAuthority.storageManagementPolicyRules.push({
    enabled: true,
    definition: {
      filters: {
        blobTypes: ["blockBlob"],
        prefixMatch: ["production-control/workforce-os/initial-production-bootstrap/"],
      },
      actions: { baseBlob: { delete: { daysAfterModificationGreaterThan: 30 } } },
    },
  });
  assert(codes(evaluateProductionAzureMutationAuthority(snapshot))
    .has("storage-control-blob-lifecycle-authority-present"));
});

test("a lifecycle rule scoped away from the control blob is permitted", () => {
  const snapshot = exclusiveSnapshot();
  snapshot.nonRbacAuthority.storageManagementPolicyRules.push({
    enabled: true,
    definition: {
      filters: { blobTypes: ["blockBlob"], prefixMatch: ["unrelated-container/"] },
      actions: { baseBlob: { delete: { daysAfterModificationGreaterThan: 30 } } },
    },
  });
  checkpointStructuralSnapshot(snapshot);
  assert.equal(evaluateProductionAzureMutationAuthority(snapshot).status, "GO");
});

test("object replication into the control container fails closed", () => {
  const snapshot = exclusiveSnapshot();
  snapshot.nonRbacAuthority.storageObjectReplicationPolicies.push({
    rules: [{ sourceContainer: "incoming", destinationContainer: "production-control" }],
  });
  assert(codes(evaluateProductionAzureMutationAuthority(snapshot))
    .has("storage-control-container-object-replication-authority-present"));
});

test("malformed autonomous storage policy inventory fails closed", () => {
  const snapshot = exclusiveSnapshot();
  snapshot.nonRbacAuthority.storageManagementPolicyRules = [{ enabled: true }];
  snapshot.nonRbacAuthority.storageObjectReplicationPolicies = [{ rules: [{}] }];
  const found = codes(evaluateProductionAzureMutationAuthority(snapshot));
  assert(found.has("invalid-storage-management-policy-inventory"));
  assert(found.has("invalid-storage-object-replication-inventory"));
});

test("the report never retains principal names, role names, or email addresses", () => {
  const snapshot = exclusiveSnapshot();
  snapshot.roleDefinitions[ROLE_IDS.owner] = role(ROLE_IDS.owner, ["*"]);
  snapshot.activeAssignmentsByScope.api.push(assignment(
    PRINCIPALS.unexpected,
    ROLE_IDS.owner,
    CONTRACT.targets.api.resourceId,
  ));
  const bytes = canonicalJson(evaluateProductionAzureMutationAuthority(snapshot));
  assert.equal(bytes.includes("person@example.invalid"), false);
  assert.equal(bytes.includes("not retained in the report"), false);
  assert.equal(bytes.includes("principalName"), false);
  assert.equal(bytes.includes("roleName"), false);
});

test("the live collector command boundary permits queries and rejects mutations", () => {
  assert.equal(assertReadOnlyAzureAuditCommand([
    "role", "assignment", "list", "--scope", CONTRACT.targets.api.resourceId,
  ]), true);
  assert.equal(assertReadOnlyAzureAuditCommand([
    "storage", "blob", "show", "--auth-mode", "login",
  ]), true);
  assert.equal(assertReadOnlyAzureAuditCommand([
    "rest", "--method", "post",
    "--url", "https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01",
    "--body", JSON.stringify({
      subscriptions: [CONTRACT.subscriptionId],
      query: "AuthorizationResources | summarize count()",
    }),
  ]), true);
  assert.throws(
    () => assertReadOnlyAzureAuditCommand(["role", "assignment", "create"]),
    /read-only audit allowlist/u,
  );
  assert.throws(
    () => assertReadOnlyAzureAuditCommand(["storage", "blob", "delete"]),
    /read-only audit allowlist/u,
  );
  assert.throws(
    () => assertReadOnlyAzureAuditCommand(["storage", "blob", "metadata", "update"]),
    /read-only audit allowlist/u,
  );
  assert.throws(
    () => assertReadOnlyAzureAuditCommand([
      "rest", "--method", "put", "--url", "https://management.azure.com/unsafe",
    ]),
    /read-only audit allowlist/u,
  );
});
