#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE = resolve(
  process.argv[2] ?? resolve(SCRIPT_DIR, "../deploy/azure-production-isolation-v2"),
);

function fail(message) {
  throw new Error(`production isolation package verification failed: ${message}`);
}

function read(path, label) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    fail(`${label} is unavailable`);
  }
}

function parseJson(source, label) {
  try {
    return JSON.parse(source);
  } catch {
    fail(`${label} is not valid JSON`);
  }
}

function same(actual, expected, label) {
  const stable = (value) => {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.keys(value).sort().map((key) => [key, stable(value[key])]),
      );
    }
    return value;
  };
  if (JSON.stringify(stable(actual)) !== JSON.stringify(stable(expected))) {
    fail(`${label} differs from the reviewed contract`);
  }
}

function sameSet(actual, expected, label) {
  if (!Array.isArray(actual) ||
    JSON.stringify([...actual].sort()) !== JSON.stringify([...expected].sort())) {
    fail(`${label} differs from the reviewed contract`);
  }
}

const contract = parseJson(
  read(resolve(PACKAGE, "authority-contract.json"), "authority contract"),
  "authority contract",
);
const mainSource = read(resolve(PACKAGE, "main.bicep"), "main Bicep");
const resourceSource = read(resolve(PACKAGE, "resources.bicep"), "resource Bicep");
const readme = read(resolve(PACKAGE, "README.md"), "package README");
const initializer = read(
  resolve(PACKAGE, "initialize-control-blob.sh"),
  "control-blob initializer",
);
const drainInitializer = read(
  resolve(PACKAGE, "initialize-authority-drain-checkpoint.sh"),
  "authority-drain initializer",
);

const expectedContract = {
  schemaVersion: 4,
  status: "reviewed-source",
  subscriptionId: "3171575e-f164-425c-9ee0-2fb10cf93884",
  resourceGroup: "workforce-os-prod",
  location: "eastus",
  registryName: "workforceosprodacr",
  controlStorageAccountName: "workforceosprodctrl",
  controlContainerName: "production-control",
  controlBlobName: "workforce-os/initial-production-bootstrap/state-v1.json",
  authorityDrainCheckpointBlobName:
    "workforce-os/initial-production-bootstrap/authority-drain-checkpoint-v1",
  logAnalyticsWorkspaceName: "workforce-os-prod-logs",
  containerAppsEnvironmentName: "workforce-os-prod-env",
  managedCertificates: {
    publicConsole: {
      name: "workforceos-root-v1",
      hostname: "workforceos.xyz",
      validation: "TXT",
    },
    publicApi: {
      name: "workforceos-api-v1",
      hostname: "api.workforceos.xyz",
      validation: "TXT",
    },
  },
  identityNamePrefix: "workforce-os-v2",
  github: {
    issuer: "https://token.actions.githubusercontent.com",
    audience: "api://AzureADTokenExchange",
    subjects: {
      backendBuild:
        "repo:Kloudedge-apex/apex-product:environment:workforce-os-production-build",
      consoleBuild:
        "repo:Kloudedge-apex/Workforce-OS:environment:workforce-os-production-build",
      backendRelease:
        "repo:Kloudedge-apex/apex-product:environment:workforce-os-production",
      consoleRelease:
        "repo:Kloudedge-apex/Workforce-OS:environment:workforce-os-production",
    },
  },
  credentialChannels: {
    acrAdminUserEnabled: false,
    acrAnonymousPullEnabled: false,
    storageSharedKeyEnabled: false,
    storageBlobPublicAccessEnabled: false,
    storageSftpEnabled: false,
    storageLocalUsersEnabled: false,
  },
  runtimeImagePull: {
    identityName: "workforce-os-v2-runtime-pull",
    acrRole: "AcrPull",
    githubFederationEnabled: false,
    deploymentStackExcludedPrincipal: false,
  },
  deploymentStack: {
    name: "workforce-os-production-isolation-v2",
    finalDenyMode: "denyWriteAndDelete",
    applyToChildScopes: true,
    actionOnUnmanage: "detachAll",
    excludedPrincipals: [
      "backendBuild",
      "consoleBuild",
      "backendRelease",
      "consoleRelease",
    ],
    humanPrincipalExcludedAfterBootstrap: false,
  },
  blobLeaseBoundary: {
    readWriteRestrictedToExactPaths: true,
    allowedBlobPaths: [
      "workforce-os/initial-production-bootstrap/state-v1.json",
      "workforce-os/initial-production-bootstrap/authority-drain-checkpoint-v1",
    ],
    deleteGranted: false,
    leaseBreakSeparableByRbac: false,
    controllerBreakCommandForbidden: true,
  },
};
same(contract, expectedContract, "authority contract");

const compile = spawnSync(
  "az",
  ["bicep", "build", "--file", resolve(PACKAGE, "main.bicep"), "--stdout"],
  { encoding: "utf8", maxBuffer: 12 * 1024 * 1024 },
);
if (compile.error || compile.status !== 0) fail("Bicep compilation failed");
const template = parseJson(compile.stdout, "compiled Bicep");

const expectedDefaults = {
  productionResourceGroupName: contract.resourceGroup,
  location: contract.location,
  registryName: contract.registryName,
  controlStorageAccountName: contract.controlStorageAccountName,
  controlContainerName: contract.controlContainerName,
  controlBlobName: contract.controlBlobName,
  authorityDrainCheckpointBlobName: contract.authorityDrainCheckpointBlobName,
  logAnalyticsWorkspaceName: contract.logAnalyticsWorkspaceName,
  containerAppsEnvironmentName: contract.containerAppsEnvironmentName,
  publicConsoleHostname: contract.managedCertificates.publicConsole.hostname,
  publicApiHostname: contract.managedCertificates.publicApi.hostname,
  publicConsoleCertificateName: contract.managedCertificates.publicConsole.name,
  publicApiCertificateName: contract.managedCertificates.publicApi.name,
  identityNamePrefix: contract.identityNamePrefix,
  githubOwner: "Kloudedge-apex",
  backendRepository: "apex-product",
  consoleRepository: "Workforce-OS",
  buildEnvironmentName: "workforce-os-production-build",
  releaseEnvironmentName: "workforce-os-production",
};
for (const [name, value] of Object.entries(expectedDefaults)) {
  if (template.parameters?.[name]?.defaultValue !== value) {
    fail(`${name} default is not source-pinned`);
  }
}

const expectedRoles = new Map([
  ["Workforce OS Isolated ACR Build Runner v2", {
    actions: [
      "Microsoft.ContainerRegistry/registries/read",
      "Microsoft.ContainerRegistry/registries/listBuildSourceUploadUrl/action",
      "Microsoft.ContainerRegistry/registries/scheduleRun/action",
      "Microsoft.ContainerRegistry/registries/runs/read",
    ],
    dataActions: [],
  }],
  ["Workforce OS Isolated Container App Release v2", {
    actions: [
      "Microsoft.App/containerApps/read",
      "Microsoft.App/containerApps/write",
      "Microsoft.App/containerApps/listCustomHostNameAnalysis/action",
      "Microsoft.App/containerApps/listSecrets/action",
      "Microsoft.App/containerApps/revisions/read",
      "Microsoft.App/containerApps/revisions/activate/action",
      "Microsoft.Authorization/roleAssignments/read",
    ],
    dataActions: [],
  }],
  ["Workforce OS Isolated Control Blob Operator v2", {
    actions: [
      "Microsoft.Storage/storageAccounts/read",
      "Microsoft.Authorization/roleAssignments/read",
    ],
    dataActions: [
      "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read",
      "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/write",
    ],
  }],
  ["Workforce OS Isolated Authority Audit Reader v2", {
    actions: [
      "Microsoft.Resources/subscriptions/read",
      "Microsoft.Resources/subscriptions/resourceGroups/read",
      "Microsoft.Resources/deploymentStacks/read",
      "Microsoft.Authorization/roleAssignments/read",
      "Microsoft.Authorization/roleDefinitions/read",
      "Microsoft.Authorization/denyAssignments/read",
      "Microsoft.App/containerApps/read",
      "Microsoft.App/managedEnvironments/read",
      "Microsoft.App/managedEnvironments/managedCertificates/read",
      "Microsoft.ManagedIdentity/userAssignedIdentities/read",
      "Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials/read",
      "Microsoft.ContainerRegistry/registries/read",
      "Microsoft.ContainerRegistry/registries/tokens/read",
      "Microsoft.ContainerRegistry/registries/tasks/read",
      "Microsoft.Storage/storageAccounts/read",
      "Microsoft.Storage/storageAccounts/blobServices/read",
      "Microsoft.Storage/storageAccounts/blobServices/containers/read",
      "Microsoft.Storage/storageAccounts/localusers/read",
      "Microsoft.Storage/storageAccounts/managementPolicies/read",
      "Microsoft.Storage/storageAccounts/objectReplicationPolicies/read",
    ],
    dataActions: [],
  }],
]);
const roles = template.resources.filter((item) =>
  item.type === "Microsoft.Authorization/roleDefinitions");
if (roles.length !== expectedRoles.size) fail("custom-role count is not four");
for (const role of roles) {
  const expected = expectedRoles.get(role.properties?.roleName);
  if (!expected) fail("an unreviewed custom role is present");
  const permissions = role.properties?.permissions;
  if (!Array.isArray(permissions) || permissions.length !== 1) {
    fail(`${role.properties.roleName} has an invalid permission block`);
  }
  const permission = permissions[0];
  sameSet(permission.actions, expected.actions, `${role.properties.roleName} actions`);
  sameSet(
    permission.dataActions,
    expected.dataActions,
    `${role.properties.roleName} data actions`,
  );
  sameSet(permission.notActions, [], `${role.properties.roleName} notActions`);
  sameSet(permission.notDataActions, [], `${role.properties.roleName} notDataActions`);
  if ([...permission.actions, ...permission.dataActions].some((item) => item.includes("*"))) {
    fail(`${role.properties.roleName} contains wildcard authority`);
  }
}

const deployment = template.resources.find((item) =>
  item.type === "Microsoft.Resources/deployments" &&
  item.name === "workforce-os-production-isolation-v2");
if (!deployment) fail("isolated resource deployment module is absent");
const resources = deployment.properties?.template?.resources;
if (!Array.isArray(resources)) fail("compiled resource module is invalid");
const byType = (type) => resources.filter((item) => item.type === type);
const exactCount = (type, count) => {
  if (byType(type).length !== count) fail(`${type} count is not ${count}`);
};
exactCount("Microsoft.ContainerRegistry/registries", 1);
exactCount("Microsoft.Storage/storageAccounts", 1);
exactCount("Microsoft.Storage/storageAccounts/blobServices/containers", 1);
exactCount("Microsoft.OperationalInsights/workspaces", 1);
exactCount("Microsoft.App/managedEnvironments", 1);
exactCount("Microsoft.App/managedEnvironments/managedCertificates", 2);
exactCount("Microsoft.ManagedIdentity/userAssignedIdentities", 5);
exactCount(
  "Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials",
  4,
);
exactCount("Microsoft.Authorization/roleAssignments", 11);
if (resources.some((item) => [
  "Microsoft.App/containerApps",
  "Microsoft.Cache/Redis",
  "Microsoft.DBforPostgreSQL/flexibleServers",
].includes(item.type))) {
  fail("initial isolation package may not mutate application or data-plane runtimes");
}

const managedCertificates = byType(
  "Microsoft.App/managedEnvironments/managedCertificates",
);
for (const [key, expected] of Object.entries(contract.managedCertificates)) {
  const prefix = key === "publicConsole" ? "publicConsole" : "publicApi";
  const certificateName =
    `[format('{0}/{1}', parameters('containerAppsEnvironmentName'), ` +
    `parameters('${prefix}CertificateName'))]`;
  const certificate = managedCertificates.find((item) =>
    item.name === certificateName);
  if (!certificate ||
    certificate.properties?.subjectName !== `[parameters('${prefix}Hostname')]` ||
    certificate.properties?.domainControlValidation !== expected.validation ||
    certificate.location !== "[parameters('location')]") {
    fail(`managed certificate is invalid for ${expected.hostname}`);
  }
}

const registry = byType("Microsoft.ContainerRegistry/registries")[0];
if (registry.properties?.adminUserEnabled !== false ||
  registry.properties?.dataEndpointEnabled !== false ||
  registry.properties?.publicNetworkAccess !== "Enabled" ||
  registry.sku?.name !== "Basic") {
  fail("registry credential or network contract is invalid");
}
const storage = byType("Microsoft.Storage/storageAccounts")[0];
for (const [key, value] of Object.entries({
  allowBlobPublicAccess: false,
  allowCrossTenantReplication: false,
  allowSharedKeyAccess: false,
  defaultToOAuthAuthentication: true,
  isHnsEnabled: false,
  isLocalUserEnabled: false,
  isSftpEnabled: false,
  minimumTlsVersion: "TLS1_2",
  publicNetworkAccess: "Enabled",
  supportsHttpsTrafficOnly: true,
})) {
  if (storage.properties?.[key] !== value) fail(`storage ${key} is invalid`);
}
const container = byType(
  "Microsoft.Storage/storageAccounts/blobServices/containers",
)[0];
if (container.properties?.publicAccess !== "None") {
  fail("production-control container is not private");
}

const federations = byType(
  "Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials",
);
const runtimeIdentity = byType("Microsoft.ManagedIdentity/userAssignedIdentities")
  .find((item) => item.name === "[format('{0}-runtime-pull', parameters('identityNamePrefix'))]");
if (!runtimeIdentity || runtimeIdentity.tags?.authority !== "runtime-image-pull") {
  fail("non-federated runtime image-pull identity is absent");
}
if (federations.some((item) => item.name?.includes("format('{0}-runtime-pull'"))) {
  fail("runtime image-pull identity may not trust GitHub OIDC");
}
if (!mainSource.includes("'7f951dda-4ed3-4680-a7ca-43fe172d538d'")) {
  fail("built-in AcrPull role ID is not source-pinned");
}
const acrPullRoleId = "[parameters('acrPullRoleDefinitionId')]";
const runtimePrincipalId = "[reference(resourceId('Microsoft.ManagedIdentity/userAssignedIdentities', format('{0}-runtime-pull', parameters('identityNamePrefix'))), '2023-01-31').principalId]";
const runtimePullAssignments = byType("Microsoft.Authorization/roleAssignments")
  .filter((item) => item.properties?.principalId === runtimePrincipalId);
if (runtimePullAssignments.length !== 1 ||
  runtimePullAssignments[0].scope !== "[resourceId('Microsoft.ContainerRegistry/registries', parameters('registryName'))]" ||
  runtimePullAssignments[0].properties?.roleDefinitionId !== acrPullRoleId) {
  fail("runtime identity authority is not exactly isolated-registry AcrPull");
}
if (federations.some((item) =>
  item.properties?.issuer !== "[variables('issuer')]" ||
  JSON.stringify(item.properties?.audiences) !==
    JSON.stringify(["[variables('audience')]"]))) {
  fail("federated identity issuer or audience is invalid");
}
for (const subject of Object.values(contract.github.subjects)) {
  const [repository, environment] = subject
    .replace("repo:Kloudedge-apex/", "")
    .split(":environment:");
  if (!mainSource.includes(`param ${repository === "apex-product" ? "backendRepository" : "consoleRepository"} string = '${repository}'`) ||
    !mainSource.includes(`'${environment}'`)) {
    fail(`OIDC subject source pin is absent for ${subject}`);
  }
}

const conditionedAssignments = byType("Microsoft.Authorization/roleAssignments")
  .filter((item) => item.properties?.conditionVersion === "2.0");
if (conditionedAssignments.length !== 2 || conditionedAssignments.some((item) =>
  item.scope !== "[resourceId('Microsoft.Storage/storageAccounts', parameters('controlStorageAccountName'))]" ||
  item.properties?.principalType !== "ServicePrincipal")) {
  fail("exact-path control-blob assignment set is invalid");
}
for (const path of contract.blobLeaseBoundary.allowedBlobPaths) {
  if (!resourceSource.includes(`StringEquals '${path === contract.controlBlobName ? "{1}" : "{2}"}'`)) {
    fail(`control-blob path condition is absent for ${path}`);
  }
}
if (resourceSource.includes("containers/blobs/delete") ||
  resourceSource.includes("az storage blob lease break")) {
  fail("destructive control-blob authority is present");
}
if (!readme.includes("`denyWriteAndDelete`") ||
  !readme.includes("no human principal exclusion") ||
  !readme.includes("runtime pull identity is not excluded") ||
  !readme.includes("`detachAll` on unmanage")) {
  fail("deployment-stack deny boundary is not documented exactly");
}

for (const literal of [
  'SUBSCRIPTION_ID="3171575e-f164-425c-9ee0-2fb10cf93884"',
  'RESOURCE_GROUP="workforce-os-prod"',
  'STORAGE_ACCOUNT="workforceosprodctrl"',
  'CONTAINER="production-control"',
  'BLOB="workforce-os/initial-production-bootstrap/state-v1.json"',
  '--auth-mode login',
  '--overwrite false',
  "--if-none-match '*'",
]) {
  if (!initializer.includes(literal)) {
    fail(`control-blob initializer is missing: ${literal}`);
  }
}
if (initializer.includes("--overwrite true") ||
  /--account-key|--connection-string|storage account keys list/u.test(initializer) ||
  /storage blob (delete|lease break)/u.test(initializer)) {
  fail("control-blob initializer contains destructive or credential authority");
}

for (const literal of [
  'SUBSCRIPTION_ID="3171575e-f164-425c-9ee0-2fb10cf93884"',
  'RESOURCE_GROUP="workforce-os-prod"',
  'STORAGE_ACCOUNT="workforceosprodctrl"',
  'CONTAINER="production-control"',
  'BLOB="workforce-os/initial-production-bootstrap/authority-drain-checkpoint-v1"',
  'CONFIRMATION_PHRASE="CREATE WORKFORCE OS AUTHORITY DRAIN CHECKPOINT"',
  'and .summary.structuralExclusive == true',
  '.findings[0].code == "credential-drain-checkpoint-missing"',
  '.findings[0].code == "credential-drain-window-open"',
  '"existing"',
  '--auth-mode login',
  '--overwrite false',
  "--if-none-match '*'",
]) {
  if (!drainInitializer.includes(literal)) {
    fail(`authority-drain initializer is missing: ${literal}`);
  }
}
if (/--account-key|--connection-string|storage account keys list/u.test(drainInitializer) ||
  /storage blob (delete|metadata update|lease break)/u.test(drainInitializer) ||
  /RESET WORKFORCE OS AUTHORITY DRAIN CHECKPOINT/u.test(drainInitializer)) {
  fail("authority-drain initializer contains reset, destructive, or credential authority");
}

console.log(`Production isolation package verified: ${PACKAGE}`);
