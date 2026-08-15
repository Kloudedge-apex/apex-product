#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SUBSCRIPTION_ID = "3171575e-f164-425c-9ee0-2fb10cf93884";
const RESOURCE_GROUP = "Ledgr-prod";
const RESOURCE_GROUP_ID = `/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}`;
const ISSUER = "https://token.actions.githubusercontent.com";
const AUDIENCE = "api://AzureADTokenExchange";
const CONTROL_CONTAINER = "production-control";
const CONTROL_BLOB = "workforce-os/initial-production-bootstrap/state-v1.json";
const CONTROL_OBJECT_PATH = `${CONTROL_CONTAINER}/${CONTROL_BLOB}`;
const CREDENTIAL_DRAIN_CHECKPOINT_BLOB =
  "workforce-os/initial-production-bootstrap/authority-drain-checkpoint-v1";
const CREDENTIAL_DRAIN_CHECKPOINT_KIND =
  "workforce-os-production-authority-drain-checkpoint-v1";
const MINIMUM_CREDENTIAL_DRAIN_AGE_SECONDS = 10 * 24 * 60 * 60;

function resourceId(provider, type, name) {
  return `${RESOURCE_GROUP_ID}/providers/${provider}/${type}/${name}`;
}

export const PRODUCTION_AZURE_AUTHORITY_CONTRACT = Object.freeze({
  schemaVersion: 1,
  subscriptionId: SUBSCRIPTION_ID,
  resourceGroup: RESOURCE_GROUP,
  resourceGroupId: RESOURCE_GROUP_ID,
  identities: {
    backendBuild: {
      name: "workforce-os-backend-build",
      subject: "repo:Kloudedge-apex/apex-product:environment:workforce-os-production-build",
    },
    consoleBuild: {
      name: "workforce-os-console-build",
      subject: "repo:Kloudedge-apex/Workforce-OS:environment:workforce-os-production-build",
    },
    backendRelease: {
      name: "workforce-os-backend-release",
      subject: "repo:Kloudedge-apex/apex-product:environment:workforce-os-production",
    },
    consoleRelease: {
      name: "workforce-os-console-release",
      subject: "repo:Kloudedge-apex/Workforce-OS:environment:workforce-os-production",
    },
  },
  targets: {
    registry: {
      resourceId: resourceId("Microsoft.ContainerRegistry", "registries", "ledgracr"),
      expectedIdentityKeys: ["backendBuild", "consoleBuild", "backendRelease", "consoleRelease"],
      expectedAssignmentScope: resourceId("Microsoft.ContainerRegistry", "registries", "ledgracr"),
      role: "registryBuild",
    },
    api: {
      resourceId: resourceId("Microsoft.App", "containerApps", "apex-gtm-api"),
      expectedIdentityKeys: ["backendRelease"],
      expectedAssignmentScope: resourceId("Microsoft.App", "containerApps", "apex-gtm-api"),
      role: "containerAppRelease",
    },
    worker: {
      resourceId: resourceId("Microsoft.App", "containerApps", "apex-gtm-worker"),
      expectedIdentityKeys: ["backendRelease"],
      expectedAssignmentScope: resourceId("Microsoft.App", "containerApps", "apex-gtm-worker"),
      role: "containerAppRelease",
    },
    console: {
      resourceId: resourceId("Microsoft.App", "containerApps", "nikxius-web"),
      expectedIdentityKeys: ["backendRelease", "consoleRelease"],
      expectedAssignmentScope: resourceId("Microsoft.App", "containerApps", "nikxius-web"),
      role: "containerAppRelease",
    },
    stateStorage: {
      resourceId: `${resourceId("Microsoft.Storage", "storageAccounts", "ledgrstorage")}/blobServices/default/containers/${CONTROL_CONTAINER}`,
      storageAccountResourceId: resourceId("Microsoft.Storage", "storageAccounts", "ledgrstorage"),
      blobServiceResourceId: `${resourceId("Microsoft.Storage", "storageAccounts", "ledgrstorage")}/blobServices/default`,
      expectedIdentityKeys: ["backendRelease", "consoleRelease"],
      expectedAssignmentScope: resourceId("Microsoft.Storage", "storageAccounts", "ledgrstorage"),
      role: "controlBlobOperator",
    },
  },
});

const EXPECTED_ROLES = Object.freeze({
  registryBuild: {
    actions: [
      "Microsoft.ContainerRegistry/registries/read",
      "Microsoft.ContainerRegistry/registries/listBuildSourceUploadUrl/action",
      "Microsoft.ContainerRegistry/registries/scheduleRun/action",
      "Microsoft.ContainerRegistry/registries/runs/read",
    ],
    dataActions: [],
  },
  containerAppRelease: {
    actions: [
      "Microsoft.App/containerApps/read",
      "Microsoft.App/containerApps/write",
      "Microsoft.App/containerApps/revisions/read",
      "Microsoft.App/containerApps/revisions/activate/action",
      "Microsoft.Authorization/roleAssignments/read",
    ],
    dataActions: [],
  },
  controlBlobOperator: {
    actions: [
      "Microsoft.Storage/storageAccounts/read",
      "Microsoft.Authorization/roleAssignments/read",
    ],
    dataActions: [
      "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read",
      "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/write",
    ],
  },
});

const TARGET_OPERATIONS = Object.freeze({
  registry: {
    actions: [
      "Microsoft.ContainerRegistry/registries/write",
      "Microsoft.ContainerRegistry/registries/delete",
      "Microsoft.ContainerRegistry/registries/listCredentials/action",
      "Microsoft.ContainerRegistry/registries/regenerateCredential/action",
      "Microsoft.ContainerRegistry/registries/importImage/action",
      "Microsoft.ContainerRegistry/registries/listBuildSourceUploadUrl/action",
      "Microsoft.ContainerRegistry/registries/scheduleRun/action",
    ],
    dataActions: [
      "Microsoft.ContainerRegistry/registries/repositories/content/write",
      "Microsoft.ContainerRegistry/registries/repositories/content/delete",
      "Microsoft.ContainerRegistry/registries/repositories/metadata/write",
      "Microsoft.ContainerRegistry/registries/repositories/metadata/delete",
    ],
  },
  containerApp: {
    actions: [
      "Microsoft.App/containerApps/write",
      "Microsoft.App/containerApps/delete",
      "Microsoft.App/containerApps/revisions/activate/action",
      "Microsoft.App/containerApps/revisions/deactivate/action",
    ],
    dataActions: [],
  },
  storage: {
    actions: [
      "Microsoft.Storage/storageAccounts/write",
      "Microsoft.Storage/storageAccounts/delete",
      "Microsoft.Storage/storageAccounts/listkeys/action",
      "Microsoft.Storage/storageAccounts/regeneratekey/action",
      "Microsoft.Storage/storageAccounts/blobServices/containers/write",
      "Microsoft.Storage/storageAccounts/blobServices/containers/delete",
    ],
    dataActions: [
      "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/write",
      "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/delete",
      "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/add/action",
      "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/move/action",
      "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/permanentDelete/action",
      "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/modifyPermissions/action",
    ],
  },
  identity: {
    actions: [
      "Microsoft.ManagedIdentity/userAssignedIdentities/write",
      "Microsoft.ManagedIdentity/userAssignedIdentities/delete",
      "Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials/write",
      "Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials/delete",
    ],
    dataActions: [],
  },
});

const DELEGATION_OPERATIONS = Object.freeze([
  "Microsoft.Authorization/roleAssignments/write",
  "Microsoft.Authorization/roleAssignments/delete",
  "Microsoft.Authorization/roleDefinitions/write",
  "Microsoft.Authorization/roleDefinitions/delete",
  "Microsoft.Authorization/roleAssignmentScheduleRequests/write",
  "Microsoft.Authorization/roleAssignmentScheduleRequests/delete",
  "Microsoft.Authorization/roleEligibilityScheduleRequests/write",
  "Microsoft.Authorization/roleEligibilityScheduleRequests/delete",
  "Microsoft.Authorization/roleManagementPolicyAssignments/write",
  "Microsoft.Authorization/roleManagementPolicyAssignments/delete",
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const RESOURCE_ID = /^\/(?:subscriptions\/[0-9a-f-]{36}|providers\/Microsoft\.Management\/managementGroups\/[A-Za-z0-9._()-]+)(?:\/[A-Za-z0-9._()/-]+)*$/iu;

function fail(message) {
  throw new Error(`production Azure mutation-authority audit failed: ${message}`);
}

function lower(value) {
  return String(value ?? "").toLowerCase();
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function stableUnique(values) {
  return [...new Set(values)].sort();
}

function stableValue(value) {
  if (Array.isArray(value)) {
    return value.map(stableValue)
      .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value ?? null;
}

function globMatches(pattern, operation) {
  if (typeof pattern !== "string" || pattern.length < 1 || pattern.length > 512) return false;
  const expression = `^${pattern.replace(/[.+?^${}()|[\]\\]/gu, "\\$&").replace(/\*/gu, ".*")}$`;
  return new RegExp(expression, "iu").test(operation);
}

function permissionGrants(permission, operation, dataPlane) {
  const grants = dataPlane ? permission?.dataActions : permission?.actions;
  const exclusions = dataPlane ? permission?.notDataActions : permission?.notActions;
  return Array.isArray(grants) && grants.some((pattern) => globMatches(pattern, operation)) &&
    !(Array.isArray(exclusions) && exclusions.some((pattern) => globMatches(pattern, operation)));
}

function roleGrants(role, operation, dataPlane = false) {
  return Array.isArray(role?.permissions) &&
    role.permissions.some((permission) => permissionGrants(permission, operation, dataPlane));
}

function grantsAny(role, operations) {
  return operations.actions.some((operation) => roleGrants(role, operation, false)) ||
    operations.dataActions.some((operation) => roleGrants(role, operation, true));
}

function rolePermissionInventory(role) {
  const permissions = Array.isArray(role?.permissions) ? role.permissions : [];
  return {
    actions: stableUnique(permissions.flatMap((item) => item.actions ?? [])),
    notActions: stableUnique(permissions.flatMap((item) => item.notActions ?? [])),
    dataActions: stableUnique(permissions.flatMap((item) => item.dataActions ?? [])),
    notDataActions: stableUnique(permissions.flatMap((item) => item.notDataActions ?? [])),
  };
}

function exactRole(role, expected) {
  const inventory = rolePermissionInventory(role);
  return canonicalJson(inventory) === canonicalJson({
    actions: [...expected.actions].sort(),
    notActions: [],
    dataActions: [...expected.dataActions].sort(),
    notDataActions: [],
  });
}

function expectedBlobCondition() {
  return `(
  (
    !(ActionMatches{'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read'})
    AND
    !(ActionMatches{'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/write'})
  )
  OR
  (
    @Resource[Microsoft.Storage/storageAccounts/blobServices/containers:name]
      StringEquals '${CONTROL_CONTAINER}'
    AND
    (
      @Resource[Microsoft.Storage/storageAccounts/blobServices/containers/blobs:path]
        StringEquals '${CONTROL_BLOB}'
      OR
      @Resource[Microsoft.Storage/storageAccounts/blobServices/containers/blobs:path]
        StringEquals '${CREDENTIAL_DRAIN_CHECKPOINT_BLOB}'
    )
  )
)`;
}

function normalizedCondition(value) {
  return String(value ?? "").replace(/\s+/gu, "").toLowerCase();
}

function exactBlobCondition(assignment) {
  return assignment.conditionVersion === "2.0" &&
    normalizedCondition(assignment.condition) === normalizedCondition(expectedBlobCondition());
}

function normalizeAssignment(value) {
  const principalId = lower(value?.principalId);
  const roleDefinitionId = lower(value?.roleDefinitionId);
  const scope = lower(value?.scope);
  return {
    condition: value?.condition ?? null,
    conditionVersion: value?.conditionVersion ?? null,
    principalId,
    principalType: typeof value?.principalType === "string" ? value.principalType : null,
    roleDefinitionId,
    scope,
  };
}

function safeFinding(code, target, assignment, extra = {}) {
  return {
    code,
    target,
    principalId: UUID.test(assignment.principalId) ? assignment.principalId : null,
    principalType: typeof assignment.principalType === "string" ? assignment.principalType : null,
    roleDefinitionId: RESOURCE_ID.test(assignment.roleDefinitionId) ? assignment.roleDefinitionId : null,
    scope: RESOURCE_ID.test(assignment.scope) ? assignment.scope : null,
    ...extra,
  };
}

function targetOperations(target) {
  if (target === "registry") return TARGET_OPERATIONS.registry;
  if (target === "stateStorage") return TARGET_OPERATIONS.storage;
  if (target.endsWith("Identity")) return TARGET_OPERATIONS.identity;
  return TARGET_OPERATIONS.containerApp;
}

function targetResource(contract, target, identities) {
  if (target.endsWith("Identity")) {
    return identities[target.replace(/Identity$/u, "")]?.resourceId ?? "";
  }
  return contract.targets[target]?.resourceId ?? "";
}

function appliesToTarget(scope, targetId, managementGroupScopes) {
  const normalizedScope = lower(scope);
  const normalizedTarget = lower(targetId);
  if (managementGroupScopes.map(lower).includes(normalizedScope)) return true;
  return normalizedTarget === normalizedScope || normalizedTarget.startsWith(`${normalizedScope}/`);
}

function normalizeRoleDefinitions(roleDefinitions, findings) {
  const result = new Map();
  for (const [key, role] of Object.entries(roleDefinitions ?? {})) {
    const id = lower(role?.id ?? key);
    if (!RESOURCE_ID.test(id) || !Array.isArray(role?.permissions)) {
      findings.push({ code: "invalid-role-definition", roleDefinitionId: RESOURCE_ID.test(id) ? id : null });
      continue;
    }
    result.set(id, role);
  }
  return result;
}

function inspectAssignment({ assignment, target, roleDefinitions, allowedPrincipalIds, expectedScope, expectedRole, expectedCounts, findings }) {
  const normalized = normalizeAssignment(assignment);
  if (!UUID.test(normalized.principalId) || !RESOURCE_ID.test(normalized.roleDefinitionId) ||
    !RESOURCE_ID.test(normalized.scope)) {
    findings.push(safeFinding("invalid-assignment", target, normalized));
    return;
  }
  const role = roleDefinitions.get(normalized.roleDefinitionId);
  if (!role) {
    findings.push(safeFinding("unresolved-role-definition", target, normalized));
    return;
  }
  const mutatesTarget = grantsAny(role, targetOperations(target));
  const delegatesAuthority = DELEGATION_OPERATIONS.some((operation) => roleGrants(role, operation));
  if (!mutatesTarget && !delegatesAuthority) return;
  const conditionAllowed = target === "stateStorage" && exactBlobCondition(normalized);
  if (normalized.condition !== null && !conditionAllowed) {
    findings.push(safeFinding("unsupported-authority-condition", target, normalized, {
      conditionSha256: sha256(Buffer.from(String(normalized.condition), "utf8")),
    }));
  }
  if (delegatesAuthority) {
    findings.push(safeFinding("unexpected-authority-delegator", target, normalized));
  }
  if (!mutatesTarget) return;
  const exactExpected = allowedPrincipalIds.has(normalized.principalId) &&
    normalized.principalType === "ServicePrincipal" &&
    normalized.scope === lower(expectedScope) &&
    exactRole(role, expectedRole) &&
    (target !== "stateStorage" || conditionAllowed) &&
    (target === "stateStorage" || normalized.condition === null);
  if (exactExpected) {
    expectedCounts.set(normalized.principalId, (expectedCounts.get(normalized.principalId) ?? 0) + 1);
    return;
  }
  findings.push(safeFinding("unexpected-active-writer", target, normalized));
}

function requiredPimScopes(contract, identities, managementGroupScopes) {
  return stableUnique([
    ...managementGroupScopes.map(lower),
    `/subscriptions/${contract.subscriptionId}`.toLowerCase(),
    contract.resourceGroupId.toLowerCase(),
    ...Object.values(contract.targets).map((target) => lower(target.resourceId)),
    lower(contract.targets.stateStorage.storageAccountResourceId),
    lower(contract.targets.stateStorage.blobServiceResourceId),
    ...Object.values(identities).map((identity) => lower(identity.resourceId)).filter(Boolean),
  ]);
}

function inspectPim(items, kind, contract, identities, managementGroupScopes, roleDefinitions, findings) {
  const targetNames = [
    ...Object.keys(contract.targets),
    ...Object.keys(contract.identities).map((key) => `${key}Identity`),
  ];
  const seen = new Set();
  for (const item of items ?? []) {
    const assignment = normalizeAssignment(item);
    const itemKey = canonicalJson(assignment);
    if (seen.has(itemKey)) continue;
    seen.add(itemKey);
    const role = roleDefinitions.get(assignment.roleDefinitionId);
    if (!role) {
      findings.push(safeFinding("unresolved-pim-role-definition", "azure", assignment));
      continue;
    }
    for (const target of targetNames) {
      const targetId = targetResource(contract, target, identities);
      if (!targetId || !appliesToTarget(assignment.scope, targetId, managementGroupScopes)) continue;
      const relevant = grantsAny(role, targetOperations(target)) ||
        DELEGATION_OPERATIONS.some((operation) => roleGrants(role, operation));
      if (!relevant) continue;
      findings.push(safeFinding(
        kind === "eligible" ? "eligible-pim-authority" : "scheduled-pim-authority",
        target,
        assignment,
      ));
    }
  }
}

function validateIdentity(key, identity, expected, findings) {
  const expectedId = `${RESOURCE_GROUP_ID}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${expected.name}`;
  if (identity?.exists !== true || lower(identity.resourceId) !== lower(expectedId) ||
    !UUID.test(String(identity.clientId ?? "")) || !UUID.test(String(identity.principalId ?? ""))) {
    findings.push({ code: "missing-or-invalid-expected-identity", identity: key });
    return null;
  }
  const credentials = Array.isArray(identity.federatedCredentials)
    ? identity.federatedCredentials
    : [];
  const exactCredentials = credentials.filter((credential) =>
    credential?.issuer === ISSUER && credential?.subject === expected.subject &&
    canonicalJson(credential?.audiences) === canonicalJson([AUDIENCE]));
  if (credentials.length !== 1 || exactCredentials.length !== 1) {
    findings.push({ code: "unexpected-federated-identity-credential", identity: key });
  }
  return {
    clientId: lower(identity.clientId),
    principalId: lower(identity.principalId),
    resourceId: lower(identity.resourceId),
  };
}

function validateResources(snapshot, contract, findings) {
  for (const [target, expected] of Object.entries(contract.targets)) {
    const actual = snapshot.resources?.[target];
    if (actual?.exists !== true || lower(actual.resourceId) !== lower(expected.resourceId)) {
      findings.push({ code: "missing-or-invalid-target-resource", target });
    }
  }
  const registry = snapshot.resources?.registry ?? {};
  const storage = snapshot.resources?.stateStorage ?? {};
  if (registry.adminUserEnabled !== false) {
    findings.push({ code: "registry-admin-credential-channel-enabled", target: "registry" });
  }
  if (storage.allowSharedKeyAccess !== false) {
    findings.push({ code: "storage-shared-key-channel-enabled", target: "stateStorage" });
  }
  if (storage.isSftpEnabled !== false) {
    findings.push({ code: "storage-sftp-channel-enabled", target: "stateStorage" });
  }
  for (const [field, code, target] of [
    ["enabledRegistryTokenCount", "registry-token-authority-present", "registry"],
    ["enabledRegistryTaskCount", "registry-task-authority-present", "registry"],
    ["storageLocalUserCount", "storage-local-user-authority-present", "stateStorage"],
  ]) {
    const count = snapshot.nonRbacAuthority?.[field];
    if (!Number.isSafeInteger(count) || count < 0) {
      findings.push({ code: "invalid-non-rbac-inventory", target, inventory: field });
    } else if (count > 0) {
      findings.push({ code, target, count });
    }
  }
}

function configuredAction(value) {
  if (Array.isArray(value)) return value.some(configuredAction);
  if (value && typeof value === "object") return Object.values(value).some(configuredAction);
  return value !== null && value !== undefined;
}

function inspectStorageAutomation(snapshot, findings) {
  const lifecycleRules = snapshot.nonRbacAuthority?.storageManagementPolicyRules;
  if (!Array.isArray(lifecycleRules)) {
    findings.push({
      code: "invalid-non-rbac-inventory",
      target: "stateStorage",
      inventory: "storageManagementPolicyRules",
    });
  } else {
    let affectingRuleCount = 0;
    let invalidRuleCount = 0;
    for (const rule of lifecycleRules) {
      if (!rule || typeof rule !== "object" || Array.isArray(rule) ||
        typeof rule.enabled !== "boolean" ||
        !rule.definition || typeof rule.definition !== "object" ||
        Array.isArray(rule.definition)) {
        invalidRuleCount += 1;
        continue;
      }
      if (!rule.enabled) continue;
      const filters = rule.definition.filters;
      const actions = rule.definition.actions;
      const blobTypes = filters?.blobTypes;
      const prefixes = filters?.prefixMatch;
      if (!filters || typeof filters !== "object" || Array.isArray(filters) ||
        !Array.isArray(blobTypes) || blobTypes.some((value) => typeof value !== "string") ||
        (prefixes !== undefined &&
          (!Array.isArray(prefixes) || prefixes.some((value) => typeof value !== "string"))) ||
        !actions || typeof actions !== "object" || Array.isArray(actions)) {
        invalidRuleCount += 1;
        continue;
      }
      const appliesToBlockBlobs = blobTypes.some((value) => lower(value) === "blockblob");
      const appliesToControlObject = prefixes === undefined || prefixes.length === 0 ||
        prefixes.some((prefix) => CONTROL_OBJECT_PATH.startsWith(prefix));
      if (appliesToBlockBlobs && appliesToControlObject && configuredAction(actions)) {
        affectingRuleCount += 1;
      }
    }
    if (invalidRuleCount > 0) {
      findings.push({
        code: "invalid-storage-management-policy-inventory",
        target: "stateStorage",
        count: invalidRuleCount,
      });
    }
    if (affectingRuleCount > 0) {
      findings.push({
        code: "storage-control-blob-lifecycle-authority-present",
        target: "stateStorage",
        count: affectingRuleCount,
      });
    }
  }

  const replicationPolicies = snapshot.nonRbacAuthority?.storageObjectReplicationPolicies;
  if (!Array.isArray(replicationPolicies)) {
    findings.push({
      code: "invalid-non-rbac-inventory",
      target: "stateStorage",
      inventory: "storageObjectReplicationPolicies",
    });
    return;
  }
  let affectingRuleCount = 0;
  let invalidPolicyCount = 0;
  for (const policy of replicationPolicies) {
    const rules = policy?.rules;
    if (!Array.isArray(rules)) {
      invalidPolicyCount += 1;
      continue;
    }
    for (const rule of rules) {
      const destination = rule?.destinationContainer;
      if (typeof destination !== "string") {
        invalidPolicyCount += 1;
      } else if (lower(destination) === CONTROL_CONTAINER) {
        affectingRuleCount += 1;
      }
    }
  }
  if (invalidPolicyCount > 0) {
    findings.push({
      code: "invalid-storage-object-replication-inventory",
      target: "stateStorage",
      count: invalidPolicyCount,
    });
  }
  if (affectingRuleCount > 0) {
    findings.push({
      code: "storage-control-container-object-replication-authority-present",
      target: "stateStorage",
      count: affectingRuleCount,
    });
  }
}

function structuralEvidenceHash(snapshot) {
  const activeAssignmentsByScope = Object.fromEntries(Object.entries(
    snapshot.activeAssignmentsByScope ?? {},
  ).map(([scope, assignments]) => [
    scope,
    Array.isArray(assignments) ? assignments.map(normalizeAssignment) : null,
  ]));
  const roleDefinitions = Object.fromEntries(Object.entries(snapshot.roleDefinitions ?? {})
    .map(([key, role]) => [lower(role?.id ?? key), rolePermissionInventory(role)]));
  const identities = Object.fromEntries(Object.entries(snapshot.identities ?? {}).map(([key, value]) => [
    key,
    {
      exists: value?.exists ?? null,
      resourceId: lower(value?.resourceId),
      clientId: lower(value?.clientId),
      principalId: lower(value?.principalId),
      federatedCredentials: Array.isArray(value?.federatedCredentials)
        ? value.federatedCredentials.map((credential) => ({
          issuer: credential?.issuer ?? null,
          audiences: credential?.audiences ?? null,
          subject: credential?.subject ?? null,
        }))
        : null,
    },
  ]));
  const pim = {
    managementGroupScopes: snapshot.pim?.managementGroupScopes ?? null,
    eligibilityQueriedScopes: snapshot.pim?.eligibilityQueriedScopes ?? null,
    activeQueriedScopes: snapshot.pim?.activeQueriedScopes ?? null,
    eligible: Array.isArray(snapshot.pim?.eligible)
      ? snapshot.pim.eligible.map(normalizeAssignment)
      : null,
    active: Array.isArray(snapshot.pim?.active)
      ? snapshot.pim.active.map(normalizeAssignment)
      : null,
  };
  const evidence = stableValue({
    schemaVersion: snapshot.schemaVersion,
    subscriptionId: snapshot.subscriptionId,
    resources: snapshot.resources ?? null,
    identities,
    activeAssignmentsByScope,
    roleDefinitions,
    pim,
    nonRbacAuthority: snapshot.nonRbacAuthority ?? null,
  });
  return sha256(Buffer.from(canonicalJson(evidence), "utf8"));
}

function validateCredentialDrain(snapshot, expectedStructuralHash, findings) {
  const checkpoint = snapshot.credentialDrainCheckpoint;
  if (checkpoint?.exists !== true) {
    findings.push({ code: "credential-drain-checkpoint-missing", target: "stateStorage" });
    return;
  }
  const metadata = checkpoint.metadata;
  const metadataKeys = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? Object.keys(metadata).sort()
    : [];
  const exactMetadataKeys = ["kind", "structural_evidence_sha256", "subscription_id"];
  const expectedHex = expectedStructuralHash.replace(/^sha256:/u, "");
  const validShape = checkpoint.blobName === CREDENTIAL_DRAIN_CHECKPOINT_BLOB &&
    checkpoint.contentLength === 0 && checkpoint.leaseState === "available" &&
    checkpoint.leaseStatus === "unlocked" &&
    canonicalJson(metadataKeys) === canonicalJson(exactMetadataKeys) &&
    metadata.kind === CREDENTIAL_DRAIN_CHECKPOINT_KIND &&
    lower(metadata.subscription_id) === SUBSCRIPTION_ID &&
    /^[0-9a-f]{64}$/u.test(metadata.structural_evidence_sha256 ?? "");
  if (!validShape) {
    findings.push({ code: "credential-drain-checkpoint-invalid", target: "stateStorage" });
    return;
  }
  if (metadata.structural_evidence_sha256 !== expectedHex) {
    findings.push({ code: "credential-drain-structure-mismatch", target: "stateStorage" });
    return;
  }
  const observedAt = Date.parse(snapshot.observedAt ?? "");
  const lastModified = Date.parse(checkpoint.lastModified ?? "");
  if (!Number.isFinite(observedAt) || !Number.isFinite(lastModified) || lastModified > observedAt) {
    findings.push({ code: "credential-drain-checkpoint-invalid", target: "stateStorage" });
    return;
  }
  if ((observedAt - lastModified) / 1000 < MINIMUM_CREDENTIAL_DRAIN_AGE_SECONDS) {
    findings.push({
      code: "credential-drain-window-open",
      target: "stateStorage",
      minimumAgeSeconds: MINIMUM_CREDENTIAL_DRAIN_AGE_SECONDS,
    });
  }
}

export function evaluateProductionAzureMutationAuthority(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    fail("snapshot is invalid");
  }
  const contract = PRODUCTION_AZURE_AUTHORITY_CONTRACT;
  const findings = [];
  if (snapshot.schemaVersion !== 1 || snapshot.subscriptionId !== contract.subscriptionId ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(snapshot.observedAt ?? "")) {
    findings.push({ code: "invalid-snapshot-envelope", target: "azure" });
  }
  for (const issue of stableUnique(snapshot.collectionIssues ?? [])) {
    findings.push({ code: "collection-incomplete", target: "azure", issue: String(issue).slice(0, 80) });
  }
  validateResources(snapshot, contract, findings);
  inspectStorageAutomation(snapshot, findings);

  const identities = {};
  for (const [key, expected] of Object.entries(contract.identities)) {
    const identity = validateIdentity(key, snapshot.identities?.[key], expected, findings);
    if (identity) identities[key] = identity;
  }
  const roleDefinitions = normalizeRoleDefinitions(snapshot.roleDefinitions, findings);
  const activeByScope = snapshot.activeAssignmentsByScope ?? {};
  for (const [target, expected] of Object.entries(contract.targets)) {
    const expectedCounts = new Map();
    const allowedPrincipalIds = new Set(expected.expectedIdentityKeys
      .map((key) => identities[key]?.principalId)
      .filter(Boolean));
    const assignments = activeByScope[target];
    if (!Array.isArray(assignments)) {
      findings.push({ code: "active-assignment-scope-unavailable", target });
      continue;
    }
    for (const assignment of assignments) {
      inspectAssignment({
        assignment,
        target,
        roleDefinitions,
        allowedPrincipalIds,
        expectedScope: expected.expectedAssignmentScope,
        expectedRole: EXPECTED_ROLES[expected.role],
        expectedCounts,
        findings,
      });
    }
    for (const key of expected.expectedIdentityKeys) {
      const principalId = identities[key]?.principalId;
      if (!principalId || expectedCounts.get(principalId) !== 1) {
        findings.push({ code: "expected-active-writer-missing-or-duplicated", target, identity: key });
      }
    }
  }

  for (const key of Object.keys(contract.identities)) {
    const target = `${key}Identity`;
    const assignments = activeByScope[target];
    if (!Array.isArray(assignments)) {
      findings.push({ code: "active-assignment-scope-unavailable", target });
      continue;
    }
    for (const assignment of assignments) {
      inspectAssignment({
        assignment,
        target,
        roleDefinitions,
        allowedPrincipalIds: new Set(),
        expectedScope: "",
        expectedRole: { actions: [], dataActions: [] },
        expectedCounts: new Map(),
        findings,
      });
    }
  }

  const managementGroupScopes = Array.isArray(snapshot.pim?.managementGroupScopes)
    ? snapshot.pim.managementGroupScopes
    : [];
  const requiredScopes = requiredPimScopes(contract, identities, managementGroupScopes);
  for (const [field, code] of [
    ["eligibilityQueriedScopes", "pim-eligibility-coverage-incomplete"],
    ["activeQueriedScopes", "pim-active-coverage-incomplete"],
  ]) {
    const queried = new Set((snapshot.pim?.[field] ?? []).map(lower));
    if (requiredScopes.some((scope) => !queried.has(scope))) {
      findings.push({ code, target: "azure" });
    }
  }
  inspectPim(snapshot.pim?.eligible, "eligible", contract, identities,
    managementGroupScopes, roleDefinitions, findings);
  inspectPim(snapshot.pim?.active, "active", contract, identities,
    managementGroupScopes, roleDefinitions, findings);

  const structuralFindings = [...new Map(findings.map((finding) =>
    [canonicalJson(finding), finding])).values()]
    .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  const structuralExclusive = structuralFindings.length === 0;
  const structuralHash = structuralExclusive ? structuralEvidenceHash(snapshot) : null;
  if (structuralExclusive) validateCredentialDrain(snapshot, structuralHash, findings);
  const sortedFindings = [...new Map(findings.map((finding) =>
    [canonicalJson(finding), finding])).values()]
    .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  const exclusive = sortedFindings.length === 0;
  let controllerEvidence = null;
  let controllerEvidenceHash = null;
  if (exclusive) {
    const backendRelease = identities.backendRelease;
    const assignmentsByScope = {};
    for (const target of ["api", "worker", "console", "stateStorage"]) {
      assignmentsByScope[target] = activeByScope[target].map(normalizeAssignment)
        .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
    }
    controllerEvidence = {
      schemaVersion: 1,
      clientId: backendRelease.clientId,
      principalObjectId: backendRelease.principalId,
      subscriptionId: contract.subscriptionId,
      protectedExclusiveAuthorityAttested: true,
      assignmentsByScope,
    };
    controllerEvidenceHash = sha256(Buffer.from(canonicalJson(controllerEvidence), "utf8"));
  }
  const safeIdentities = Object.fromEntries(Object.entries(identities).map(([key, value]) => [key, value]));
  return {
    schemaVersion: 1,
    kind: "workforce-os-production-azure-mutation-authority-audit",
    status: exclusive ? "GO" : "NO-GO",
    observedAt: snapshot.observedAt ?? null,
    subscriptionId: contract.subscriptionId,
    resourceGroup: contract.resourceGroup,
    identities: safeIdentities,
    findings: sortedFindings,
    summary: {
      exclusive,
      structuralExclusive,
      credentialDrainComplete: exclusive,
      minimumCredentialDrainAgeSeconds: MINIMUM_CREDENTIAL_DRAIN_AGE_SECONDS,
      findingCount: sortedFindings.length,
      activeScopeCount: Object.keys(activeByScope).length,
      eligiblePimCount: Array.isArray(snapshot.pim?.eligible) ? snapshot.pim.eligible.length : 0,
      activePimCount: Array.isArray(snapshot.pim?.active) ? snapshot.pim.active.length : 0,
    },
    structuralEvidenceHash: structuralHash,
    credentialDrainCheckpointBlob: CREDENTIAL_DRAIN_CHECKPOINT_BLOB,
    controllerEvidence,
    controllerEvidenceHash,
  };
}

export function assertReadOnlyAzureAuditCommand(args) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    fail("Azure command is invalid");
  }
  const allowedPrefixes = [
    ["account", "show"],
    ["identity", "show"],
    ["identity", "federated-credential", "list"],
    ["acr", "show"],
    ["acr", "token", "list"],
    ["acr", "task", "list"],
    ["storage", "account", "show"],
    ["storage", "account", "local-user", "list"],
    ["storage", "account", "management-policy", "show"],
    ["storage", "account", "or-policy", "list"],
    ["storage", "blob", "show"],
    ["resource", "show"],
    ["role", "assignment", "list"],
    ["role", "definition", "list"],
  ];
  if (allowedPrefixes.some((prefix) =>
    prefix.every((part, index) => args[index] === part))) return true;
  if (args[0] !== "rest" || args[1] !== "--method" || args[2] !== "post") {
    fail("Azure command is not in the read-only audit allowlist");
  }
  const urlIndex = args.indexOf("--url");
  const bodyIndex = args.indexOf("--body");
  if (urlIndex < 0 || bodyIndex < 0 ||
    args[urlIndex + 1] !==
      "https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01") {
    fail("Azure REST command is not the reviewed Resource Graph query");
  }
  let body;
  try {
    body = JSON.parse(args[bodyIndex + 1]);
  } catch {
    fail("Azure Resource Graph body is invalid");
  }
  const keys = Object.keys(body).sort();
  if (!keys.every((key) => ["managementGroups", "options", "query", "subscriptions"].includes(key)) ||
    typeof body.query !== "string" ||
    !/^(?:AuthorizationResources|ResourceContainers)\b/u.test(body.query)) {
    fail("Azure Resource Graph body is outside the read-only audit contract");
  }
  return true;
}

function runAz(args) {
  assertReadOnlyAzureAuditCommand(args);
  const result = spawnSync("az", args, {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) {
    return { ok: false, status: result.status, stderr: result.stderr ?? "" };
  }
  try {
    return { ok: true, value: JSON.parse(result.stdout) };
  } catch {
    return { ok: false, status: result.status, stderr: result.stderr ?? "" };
  }
}

function azJson(args, issues, issueCode) {
  const result = runAz([...args, "--only-show-errors", "--output", "json"]);
  if (!result.ok) {
    issues.push(issueCode);
    return null;
  }
  return result.value;
}

function azJsonOptionalNotFound(args, issues, issueCode, notFoundCodes) {
  const result = runAz([...args, "--only-show-errors", "--output", "json"]);
  if (result.ok) return { exists: true, value: result.value };
  if (notFoundCodes.some((code) => result.stderr.includes(code))) {
    return { exists: false, value: null };
  }
  issues.push(issueCode);
  return { exists: null, value: null };
}

function identityResourceId(name) {
  return `${RESOURCE_GROUP_ID}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${name}`;
}

function assignmentArray(value, issues, issueCode) {
  if (!Array.isArray(value)) {
    issues.push(issueCode);
    return [];
  }
  return value.map(normalizeAssignment);
}

function collectManagementGroupScopes(issues) {
  const query = "ResourceContainers | where type =~ 'microsoft.resources/subscriptions' " +
    `| where subscriptionId == '${SUBSCRIPTION_ID}' ` +
    "| project ancestors=properties.managementGroupAncestorsChain";
  const response = azJson([
    "rest", "--method", "post",
    "--url", "https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01",
    "--body", JSON.stringify({ subscriptions: [SUBSCRIPTION_ID], query }),
  ], issues, "management-group-ancestry-query-failed");
  const ancestors = response?.data?.[0]?.ancestors;
  if (!Array.isArray(ancestors)) {
    issues.push("management-group-ancestry-unavailable");
    return [];
  }
  const scopes = [];
  for (const ancestor of ancestors) {
    if (typeof ancestor?.name !== "string" || !/^[A-Za-z0-9._()-]+$/u.test(ancestor.name)) {
      issues.push("management-group-ancestry-invalid");
      continue;
    }
    scopes.push(`/providers/Microsoft.Management/managementGroups/${ancestor.name}`);
  }
  return stableUnique(scopes.map(lower));
}

function collectPimGraph(resourceType, managementGroupScopes, issues, issueCode) {
  const query = `AuthorizationResources | where type =~ '${resourceType}' | project properties`;
  const authorities = [
    { subscriptions: [SUBSCRIPTION_ID] },
    ...managementGroupScopes.map((scope) => ({ managementGroups: [scope.split("/").at(-1)] })),
  ];
  const items = [];
  let complete = true;
  for (const authority of authorities) {
    let skipToken = null;
    let pages = 0;
    do {
      const body = { ...authority, query };
      if (skipToken) body.options = { "$skipToken": skipToken };
      const response = azJson([
        "rest", "--method", "post",
        "--url", "https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01",
        "--body", JSON.stringify(body),
      ], issues, issueCode);
      if (!response || !Array.isArray(response.data)) {
        complete = false;
        break;
      }
      items.push(...response.data.map((item) => normalizeAssignment(item.properties ?? item)));
      skipToken = response.$skipToken ?? null;
      pages += 1;
      if (pages >= 100 && skipToken) {
        issues.push(`${issueCode}-pagination-limit`);
        complete = false;
        break;
      }
    } while (skipToken);
  }
  return { items, complete };
}

function collectRoleDefinition(id, issues) {
  const value = azJson([
    "role", "definition", "list", "--name", id.split("/").at(-1),
    "--subscription", SUBSCRIPTION_ID,
  ], issues, "role-definition-query-failed");
  if (!Array.isArray(value) || value.length !== 1) {
    issues.push("role-definition-unresolved");
    return null;
  }
  return value[0];
}

export function collectProductionAzureMutationAuthoritySnapshot() {
  const issues = [];
  const account = azJson([
    "account", "show", "--subscription", SUBSCRIPTION_ID,
  ], issues, "azure-account-query-failed");
  if (lower(account?.id) !== SUBSCRIPTION_ID) issues.push("wrong-azure-subscription");
  const contract = PRODUCTION_AZURE_AUTHORITY_CONTRACT;
  const identities = {};
  for (const [key, expected] of Object.entries(contract.identities)) {
    const identity = azJson([
      "identity", "show", "--resource-group", RESOURCE_GROUP, "--name", expected.name,
      "--subscription", SUBSCRIPTION_ID,
    ], issues, `${key}-identity-query-failed`);
    const federatedCredentials = identity ? azJson([
      "identity", "federated-credential", "list",
      "--resource-group", RESOURCE_GROUP,
      "--identity-name", expected.name,
      "--subscription", SUBSCRIPTION_ID,
    ], issues, `${key}-federation-query-failed`) : [];
    identities[key] = {
      exists: Boolean(identity),
      resourceId: identity ? lower(identity.id) : lower(identityResourceId(expected.name)),
      clientId: identity?.clientId ?? null,
      principalId: identity?.principalId ?? null,
      federatedCredentials: Array.isArray(federatedCredentials)
        ? federatedCredentials.map((credential) => ({
          issuer: credential.issuer,
          audiences: credential.audiences,
          subject: credential.subject,
        }))
        : [],
    };
  }

  const registry = azJson([
    "acr", "show", "--name", "ledgracr", "--resource-group", RESOURCE_GROUP,
    "--subscription", SUBSCRIPTION_ID,
  ], issues, "registry-query-failed");
  const storage = azJson([
    "storage", "account", "show", "--name", "ledgrstorage", "--resource-group", RESOURCE_GROUP,
    "--subscription", SUBSCRIPTION_ID,
  ], issues, "storage-query-failed");
  const resources = {};
  for (const target of ["api", "worker", "console"]) {
    const value = azJson([
      "resource", "show", "--ids", contract.targets[target].resourceId,
      "--subscription", SUBSCRIPTION_ID,
    ], issues, `${target}-resource-query-failed`);
    resources[target] = { exists: Boolean(value), resourceId: lower(value?.id ?? contract.targets[target].resourceId) };
  }
  const container = azJson([
    "resource", "show", "--ids", contract.targets.stateStorage.resourceId,
    "--api-version", "2023-05-01", "--subscription", SUBSCRIPTION_ID,
  ], issues, "control-container-query-failed");
  resources.registry = {
    exists: Boolean(registry),
    resourceId: lower(registry?.id ?? contract.targets.registry.resourceId),
    adminUserEnabled: registry?.adminUserEnabled,
  };
  resources.stateStorage = {
    exists: Boolean(container) && Boolean(storage),
    resourceId: lower(container?.id ?? contract.targets.stateStorage.resourceId),
    allowSharedKeyAccess: storage?.allowSharedKeyAccess,
    isSftpEnabled: storage?.isSftpEnabled ?? false,
  };

  const registryTokens = azJson([
    "acr", "token", "list", "--registry", "ledgracr", "--subscription", SUBSCRIPTION_ID,
  ], issues, "registry-token-query-failed");
  const registryTasks = azJson([
    "acr", "task", "list", "--registry", "ledgracr", "--subscription", SUBSCRIPTION_ID,
  ], issues, "registry-task-query-failed");
  const localUsers = azJson([
    "storage", "account", "local-user", "list", "--account-name", "ledgrstorage",
    "--resource-group", RESOURCE_GROUP, "--subscription", SUBSCRIPTION_ID,
  ], issues, "storage-local-user-query-failed");
  const managementPolicy = azJsonOptionalNotFound([
    "storage", "account", "management-policy", "show",
    "--account-name", "ledgrstorage", "--resource-group", RESOURCE_GROUP,
    "--subscription", SUBSCRIPTION_ID,
  ], issues, "storage-management-policy-query-failed", ["ManagementPolicyNotFound"]);
  const objectReplicationPolicies = azJson([
    "storage", "account", "or-policy", "list",
    "--account-name", "ledgrstorage", "--resource-group", RESOURCE_GROUP,
    "--subscription", SUBSCRIPTION_ID,
  ], issues, "storage-object-replication-query-failed");
  const drainCheckpoint = azJsonOptionalNotFound([
    "storage", "blob", "show", "--auth-mode", "login",
    "--account-name", "ledgrstorage", "--container-name", CONTROL_CONTAINER,
    "--name", CREDENTIAL_DRAIN_CHECKPOINT_BLOB, "--subscription", SUBSCRIPTION_ID,
  ], issues, "credential-drain-checkpoint-query-failed", ["BlobNotFound"]);

  const activeAssignmentsByScope = {};
  const assignmentScopes = {
    ...Object.fromEntries(Object.entries(contract.targets).map(([key, value]) => [key, value.resourceId])),
    ...Object.fromEntries(Object.entries(contract.identities).map(([key, value]) =>
      [`${key}Identity`, identityResourceId(value.name)])),
  };
  for (const [key, scope] of Object.entries(assignmentScopes)) {
    const assignments = azJson([
      "role", "assignment", "list", "--scope", scope, "--include-inherited",
      "--subscription", SUBSCRIPTION_ID,
    ], issues, `${key}-role-assignment-query-failed`);
    activeAssignmentsByScope[key] = assignmentArray(
      assignments,
      issues,
      `${key}-role-assignment-response-invalid`,
    );
  }

  const managementGroupScopes = collectManagementGroupScopes(issues);
  const pimScopes = requiredPimScopes(contract, Object.fromEntries(Object.entries(identities).map(
    ([key, value]) => [key, { resourceId: value.resourceId }],
  )), managementGroupScopes);
  const pim = {
    managementGroupScopes,
    eligibilityQueriedScopes: [],
    activeQueriedScopes: [],
    eligible: [],
    active: [],
  };
  const eligiblePim = collectPimGraph(
    "microsoft.authorization/roleeligibilityscheduleinstances",
    managementGroupScopes,
    issues,
    "pim-eligibility-query-failed",
  );
  const activePim = collectPimGraph(
    "microsoft.authorization/roleassignmentscheduleinstances",
    managementGroupScopes,
    issues,
    "pim-active-query-failed",
  );
  if (eligiblePim.complete) pim.eligibilityQueriedScopes = pimScopes;
  if (activePim.complete) pim.activeQueriedScopes = pimScopes;
  pim.eligible = eligiblePim.items;
  pim.active = activePim.items;

  const roleIds = stableUnique([
    ...Object.values(activeAssignmentsByScope).flat().map((item) => item.roleDefinitionId),
    ...pim.eligible.map((item) => item.roleDefinitionId),
    ...pim.active.map((item) => item.roleDefinitionId),
  ].filter((id) => RESOURCE_ID.test(id)));
  const roleDefinitions = {};
  for (const id of roleIds) {
    const role = collectRoleDefinition(id, issues);
    if (role) roleDefinitions[id] = role;
  }
  return {
    schemaVersion: 1,
    subscriptionId: SUBSCRIPTION_ID,
    observedAt: new Date(Math.floor(Date.now() / 1000) * 1000).toISOString().replace(".000Z", "Z"),
    resources,
    identities,
    activeAssignmentsByScope,
    roleDefinitions,
    pim,
    nonRbacAuthority: {
      enabledRegistryTokenCount: Array.isArray(registryTokens)
        ? registryTokens.filter((item) => lower(item.status) !== "disabled").length
        : -1,
      enabledRegistryTaskCount: Array.isArray(registryTasks)
        ? registryTasks.filter((item) => lower(item.status) !== "disabled").length
        : -1,
      storageLocalUserCount: Array.isArray(localUsers) ? localUsers.length : -1,
      storageManagementPolicyRules: managementPolicy.exists === false
        ? []
        : managementPolicy.value?.policy?.rules,
      storageObjectReplicationPolicies: objectReplicationPolicies,
    },
    credentialDrainCheckpoint: {
      exists: drainCheckpoint.exists === true,
      blobName: drainCheckpoint.value?.name ?? CREDENTIAL_DRAIN_CHECKPOINT_BLOB,
      lastModified: drainCheckpoint.value?.properties?.lastModified ?? null,
      contentLength: drainCheckpoint.value?.properties?.contentLength ?? null,
      leaseState: drainCheckpoint.value?.properties?.lease?.state ?? null,
      leaseStatus: drainCheckpoint.value?.properties?.lease?.status ?? null,
      metadata: drainCheckpoint.value?.metadata ?? null,
    },
    collectionIssues: stableUnique(issues),
  };
}

function main() {
  if (process.argv.length !== 2) fail("usage: production-azure-mutation-authority-audit.mjs");
  const report = evaluateProductionAzureMutationAuthority(
    collectProductionAzureMutationAuthoritySnapshot(),
  );
  process.stdout.write(`${canonicalJson(report)}\n`);
  if (report.status !== "GO") process.exitCode = 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
