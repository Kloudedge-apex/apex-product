#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PACKAGE = resolve(
  SCRIPT_DIR,
  "../deploy/azure-production-authority-v1",
);

function fail(message) {
  throw new Error("production authority package verification failed: " + message);
}

function read(path, label) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    fail(label + " is unavailable");
  }
}

function parseJson(source, label) {
  try {
    return JSON.parse(source);
  } catch {
    fail(label + " is not valid JSON");
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
    fail(label + " differs from the reviewed contract");
  }
}

function sameArray(actual, expected, label) {
  if (!Array.isArray(actual) ||
    JSON.stringify([...actual].sort()) !== JSON.stringify([...expected].sort())) {
    fail(label + " differs from the reviewed contract");
  }
}

function requireLiteral(source, literal, label) {
  if (!source.includes(literal)) fail(label + " is absent");
}

const EXPECTED_CONTRACT = {
  schemaVersion: 1,
  status: "source-only-no-apply",
  subscriptionId: "3171575e-f164-425c-9ee0-2fb10cf93884",
  resourceGroup: "Ledgr-prod",
  location: "eastus",
  registryName: "ledgracr",
  controlStorageAccountName: "ledgrstorage",
  controlContainerName: "production-control",
  controlBlobName: "workforce-os/initial-production-bootstrap/state-v1.json",
  authorityDrainCheckpointBlobName:
    "workforce-os/initial-production-bootstrap/authority-drain-checkpoint-v1",
  github: {
    issuer: "https://token.actions.githubusercontent.com",
    audience: "api://AzureADTokenExchange",
    subjects: {
      backendBuild: "repo:Kloudedge-apex/apex-product:environment:workforce-os-production-build",
      consoleBuild: "repo:Kloudedge-apex/Workforce-OS:environment:workforce-os-production-build",
      backendRelease: "repo:Kloudedge-apex/apex-product:environment:workforce-os-production",
      consoleRelease: "repo:Kloudedge-apex/Workforce-OS:environment:workforce-os-production",
    },
  },
  customRoles: {
    acrBuildRunner: {
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
      conditionVersion: "2.0",
      conditionResourceAttributes: [
        "Microsoft.Storage/storageAccounts/blobServices/containers:name",
        "Microsoft.Storage/storageAccounts/blobServices/containers/blobs:path",
      ],
    },
  },
  builtInRoles: {
    acrPull: "7f951dda-4ed3-4680-a7ca-43fe172d538d",
  },
  containerAppAssignments: {
    backendRelease: ["apex-gtm-api", "apex-gtm-worker", "nikxius-web"],
    consoleRelease: ["nikxius-web"],
    backendBuild: [],
    consoleBuild: [],
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

const ROLE_NAMES = {
  "Workforce OS ACR Build Runner v1": "acrBuildRunner",
  "Workforce OS Container App Release v1": "containerAppRelease",
  "Workforce OS Control Blob Operator v1": "controlBlobOperator",
};

function compile(mainPath) {
  const result = spawnSync(
    "az",
    ["bicep", "build", "--file", mainPath, "--stdout"],
    { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
  );
  if (result.error || result.status !== 0) {
    fail("Bicep compilation failed");
  }
  return parseJson(result.stdout, "compiled Bicep");
}

function verifyRoleDefinitions(template, contract) {
  const roles = template.resources.filter(
    (resource) => resource.type === "Microsoft.Authorization/roleDefinitions",
  );
  if (roles.length !== 3) fail("compiled custom-role count is not three");
  for (const role of roles) {
    const key = ROLE_NAMES[role.properties?.roleName];
    if (!key) fail("compiled an unreviewed custom role");
    const permission = role.properties?.permissions?.[0];
    if (!permission || role.properties.permissions.length !== 1) {
      fail(key + " has an invalid permission block");
    }
    sameArray(permission.actions, contract.customRoles[key].actions, key + " actions");
    sameArray(
      permission.dataActions,
      contract.customRoles[key].dataActions,
      key + " data actions",
    );
    sameArray(permission.notActions, [], key + " notActions");
    sameArray(permission.notDataActions, [], key + " notDataActions");
    if (permission.actions.some((action) => action.includes("*")) ||
      permission.dataActions.some((action) => action.includes("*"))) {
      fail(key + " contains a wildcard permission");
    }
  }
}

function assignmentMatches(resource, identity, scope) {
  const identityMarker = "{0}-" + identity;
  return resource.scope === scope &&
    resource.name?.includes(identityMarker) &&
    resource.properties?.principalId?.includes(identityMarker) &&
    resource.properties?.principalType === "ServicePrincipal";
}

function verifyAssignmentSet(assignments, roleDefinitionId, expected, label) {
  const selected = assignments.filter((resource) =>
    resource.properties?.roleDefinitionId === roleDefinitionId);
  if (selected.length !== expected.length) {
    fail(label + " assignment count differs from the reviewed package");
  }
  for (const item of expected) {
    if (!selected.some((resource) =>
      assignmentMatches(resource, item.identity, item.scope))) {
      fail(label + " lacks the reviewed assignment for " + item.identity);
    }
  }
  return selected;
}

function verifyNestedTemplate(template) {
  const deployment = template.resources.find(
    (resource) => resource.type === "Microsoft.Resources/deployments",
  );
  const nested = deployment?.properties?.template;
  if (!nested) fail("resource-group authority module is absent");
  const resources = nested.resources ?? [];
  const count = (type) => resources.filter((resource) => resource.type === type).length;
  if (count("Microsoft.Storage/storageAccounts/blobServices/containers") !== 1 ||
    count("Microsoft.ManagedIdentity/userAssignedIdentities") !== 4 ||
    count("Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials") !== 4 ||
    count("Microsoft.Authorization/roleAssignments") !== 14) {
    fail("compiled resource inventory differs from the reviewed package");
  }

  const controlContainer = resources.find((resource) =>
    resource.type === "Microsoft.Storage/storageAccounts/blobServices/containers");
  if (controlContainer.name !==
      "[format('{0}/{1}/{2}', parameters('controlStorageAccountName'), 'default', parameters('controlContainerName'))]" ||
    controlContainer.properties?.publicAccess !== "None") {
    fail("control container identity or privacy differs from the reviewed package");
  }

  const federations = resources.filter((resource) =>
    resource.type ===
      "Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials");
  const expectedFederations = [
    ["backend-build", "backendRepository", "buildEnvironmentName"],
    ["console-build", "consoleRepository", "buildEnvironmentName"],
    ["backend-release", "backendRepository", "releaseEnvironmentName"],
    ["console-release", "consoleRepository", "releaseEnvironmentName"],
  ];
  for (const [identity, repository, environment] of expectedFederations) {
    const expectedSubject =
      "[format('repo:{0}/{1}:environment:{2}', parameters('githubOwner'), " +
      "parameters('" + repository + "'), parameters('" + environment + "'))]";
    const federation = federations.find((resource) =>
      resource.name?.includes("{0}-" + identity));
    if (!federation ||
      federation.properties?.issuer !== "[variables('issuer')]" ||
      JSON.stringify(federation.properties?.audiences) !==
        JSON.stringify(["[variables('audience')]"]) ||
      federation.properties?.subject !== expectedSubject) {
      fail("OIDC federation differs from the reviewed mapping for " + identity);
    }
  }

  const assignments = resources.filter(
    (resource) => resource.type === "Microsoft.Authorization/roleAssignments",
  );
  const registryScope =
    "[resourceId('Microsoft.ContainerRegistry/registries', parameters('registryName'))]";
  const registryAssignments = [
    { identity: "backend-build", scope: registryScope },
    { identity: "console-build", scope: registryScope },
    { identity: "backend-release", scope: registryScope },
    { identity: "console-release", scope: registryScope },
  ];
  verifyAssignmentSet(
    assignments,
    "[parameters('acrBuildRunnerRoleDefinitionId')]",
    registryAssignments,
    "ACR build",
  );
  verifyAssignmentSet(
    assignments,
    "[parameters('acrPullRoleDefinitionId')]",
    registryAssignments,
    "ACR pull",
  );

  verifyAssignmentSet(
    assignments,
    "[parameters('containerAppReleaseRoleDefinitionId')]",
    [
      {
        identity: "backend-release",
        scope: "[resourceId('Microsoft.App/containerApps', variables('apiAppName'))]",
      },
      {
        identity: "backend-release",
        scope: "[resourceId('Microsoft.App/containerApps', variables('workerAppName'))]",
      },
      {
        identity: "backend-release",
        scope: "[resourceId('Microsoft.App/containerApps', variables('consoleAppName'))]",
      },
      {
        identity: "console-release",
        scope: "[resourceId('Microsoft.App/containerApps', variables('consoleAppName'))]",
      },
    ],
    "Container App",
  );

  const storageScope =
    "[resourceId('Microsoft.Storage/storageAccounts', parameters('controlStorageAccountName'))]";
  const blobAssignments = verifyAssignmentSet(
    assignments,
    "[parameters('controlBlobOperatorRoleDefinitionId')]",
    [
      { identity: "backend-release", scope: storageScope },
      { identity: "console-release", scope: storageScope },
    ],
    "control blob",
  );
  if (blobAssignments.some((resource) =>
      resource.properties.conditionVersion !== "2.0" ||
      resource.properties.condition !== "[variables('controlBlobCondition')]")) {
    fail("control-blob assignments are not exact release-only conditioned roles");
  }
  const condition = nested.variables?.controlBlobCondition;
  if (typeof condition !== "string" ||
    !condition.includes("blobs/read") ||
    !condition.includes("blobs/write") ||
    !condition.includes("containers:name") ||
    !condition.includes("blobs:path") ||
    !condition.includes("StringEquals ''{1}''") ||
    !condition.includes("StringEquals ''{2}''") ||
    !condition.includes("parameters('controlContainerName')") ||
    !condition.includes("parameters('controlBlobName')") ||
    !condition.includes("parameters('authorityDrainCheckpointBlobName')") ||
    condition.includes("blobs/delete")) {
    fail("compiled exact-path blob condition is invalid");
  }
  return nested;
}

function verifyDefaults(template, contract) {
  const expected = {
    productionResourceGroupName: contract.resourceGroup,
    location: contract.location,
    registryName: contract.registryName,
    controlStorageAccountName: contract.controlStorageAccountName,
    controlContainerName: contract.controlContainerName,
    controlBlobName: contract.controlBlobName,
    authorityDrainCheckpointBlobName: contract.authorityDrainCheckpointBlobName,
    githubOwner: "Kloudedge-apex",
    backendRepository: "apex-product",
    consoleRepository: "Workforce-OS",
    buildEnvironmentName: "workforce-os-production-build",
    releaseEnvironmentName: "workforce-os-production",
  };
  for (const [name, value] of Object.entries(expected)) {
    if (template.parameters?.[name]?.defaultValue !== value) {
      fail(name + " default differs from the reviewed contract");
    }
  }
}

function verifyInitializer(source) {
  for (const literal of [
    'SUBSCRIPTION_ID="3171575e-f164-425c-9ee0-2fb10cf93884"',
    'STORAGE_ACCOUNT="ledgrstorage"',
    'CONTAINER="production-control"',
    'BLOB="workforce-os/initial-production-bootstrap/state-v1.json"',
    'INITIALIZE WORKFORCE OS PRODUCTION CONTROL BLOB',
    '--overwrite false',
    "--if-none-match '*'",
    '.properties.contentLength == 0',
    '.properties.lease.status == "unlocked"',
    '.properties.lease.state == "available"',
  ]) {
    requireLiteral(source, literal, "initializer invariant");
  }
  for (const forbidden of [
    "--overwrite true",
    "storage blob delete",
    "storage container delete",
    "storage blob lease break",
    "storage blob lease acquire",
  ]) {
    if (source.includes(forbidden)) fail("initializer contains forbidden operation: " + forbidden);
  }
}

function verifyDrainCheckpointInitializer(source) {
  for (const literal of [
    'SUBSCRIPTION_ID="3171575e-f164-425c-9ee0-2fb10cf93884"',
    'STORAGE_ACCOUNT="ledgrstorage"',
    'CONTAINER="production-control"',
    'BLOB="workforce-os/initial-production-bootstrap/authority-drain-checkpoint-v1"',
    'CHECKPOINT_KIND="workforce-os-production-authority-drain-checkpoint-v1"',
    'CREATE WORKFORCE OS AUTHORITY DRAIN CHECKPOINT',
    'RESET WORKFORCE OS AUTHORITY DRAIN CHECKPOINT',
    'production-azure-mutation-authority-audit.mjs',
    '.summary.structuralExclusive == true',
    '.summary.minimumCredentialDrainAgeSeconds == 864000',
    '.structuralEvidenceHash | test("^sha256:[0-9a-f]{64}$")',
    '.identities.backendRelease.clientId',
    '.identities.consoleRelease.clientId',
    '.user.type == "servicePrincipal"',
    '--auth-mode login',
    '--overwrite false',
    "--if-none-match '*'",
    'az storage blob metadata update',
    '--if-match "${checkpoint_etag}"',
    '.properties.contentLength == 0',
    '.properties.lease.state == "available"',
    '.properties.lease.status == "unlocked"',
  ]) {
    requireLiteral(source, literal, "authority-drain initializer invariant");
  }
  for (const forbidden of [
    "--overwrite true",
    "--auth-mode key",
    "storage blob delete",
    "storage container delete",
    "storage account keys list",
    "storage account revoke-delegation-keys",
    "storage blob lease break",
    "storage blob lease acquire",
  ]) {
    if (source.includes(forbidden)) {
      fail("authority-drain initializer contains forbidden operation: " + forbidden);
    }
  }
}

export function verifyProductionAuthorityPackage(packagePath = DEFAULT_PACKAGE) {
  const root = resolve(packagePath);
  const contract = parseJson(
    read(resolve(root, "authority-contract.json"), "authority contract"),
    "authority contract",
  );
  same(contract, EXPECTED_CONTRACT, "authority contract");
  const main = read(resolve(root, "main.bicep"), "main Bicep");
  const resources = read(resolve(root, "resources.bicep"), "resource Bicep");
  const initializer = read(
    resolve(root, "initialize-control-blob.sh"),
    "control-blob initializer",
  );
  const drainCheckpointInitializer = read(
    resolve(root, "initialize-authority-drain-checkpoint.sh"),
    "authority-drain checkpoint initializer",
  );

  for (const literal of [
    "param productionResourceGroupName string = 'Ledgr-prod'",
    "param location string = 'eastus'",
    "param registryName string = 'ledgracr'",
    "param controlStorageAccountName string = 'ledgrstorage'",
    "param controlContainerName string = 'production-control'",
    "param controlBlobName string = 'workforce-os/initial-production-bootstrap/state-v1.json'",
    "param authorityDrainCheckpointBlobName string = 'workforce-os/initial-production-bootstrap/authority-drain-checkpoint-v1'",
    "param githubOwner string = 'Kloudedge-apex'",
    "param backendRepository string = 'apex-product'",
    "param consoleRepository string = 'Workforce-OS'",
    "param buildEnvironmentName string = 'workforce-os-production-build'",
    "param releaseEnvironmentName string = 'workforce-os-production'",
  ]) {
    requireLiteral(main, literal, "main Bicep invariant");
  }
  for (const literal of [
    "repo:{0}/{1}:environment:{2}",
    "backendBuildIdentity",
    "consoleBuildIdentity",
    "backendReleaseIdentity",
    "consoleReleaseIdentity",
    "controlBlobCondition",
    "StringEquals '{0}'",
    "StringEquals '{1}'",
    "StringEquals '{2}'",
    "conditionVersion: '2.0'",
    "backendApiRelease",
    "backendWorkerRelease",
    "backendConsoleRelease",
    "consoleConsoleRelease",
  ]) {
    requireLiteral(resources, literal, "resource Bicep invariant");
  }
  for (const forbidden of [
    "containerApps/delete",
    "containerApps/listsecrets",
    "containerApps/exec",
    "containers/blobs/delete",
    "roleAssignments/write",
    "listCredentials/action",
    "regenerateCredential/action",
  ]) {
    if ((main + resources).includes(forbidden)) {
      fail("Bicep contains forbidden authority: " + forbidden);
    }
  }
  const reviewedActions = Object.values(contract.customRoles)
    .flatMap((role) => [...role.actions, ...role.dataActions]);
  const sourceActions = [...main.matchAll(/'(Microsoft\.[^']+)'/gu)]
    .map((match) => match[1])
    .filter((action) => /\/(?:read|write|action)$/u.test(action));
  sameArray(sourceActions, reviewedActions, "Bicep permission literals");
  verifyInitializer(initializer);
  verifyDrainCheckpointInitializer(drainCheckpointInitializer);

  const template = compile(resolve(root, "main.bicep"));
  verifyDefaults(template, contract);
  verifyRoleDefinitions(template, contract);
  verifyNestedTemplate(template);
  return true;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 3) fail("usage: verify-production-authority-package.mjs [package-dir]");
  verifyProductionAuthorityPackage(process.argv[2]);
  process.stdout.write("Production authority package verified\n");
}
