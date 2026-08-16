#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE = resolve(
  process.argv[2] ?? resolve(SCRIPT_DIR, "../deploy/azure-production-runtime-v1"),
);

function fail(message) {
  throw new Error(`production runtime package verification failed: ${message}`);
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

const contract = parseJson(
  read(resolve(PACKAGE, "runtime-contract.json"), "runtime contract"),
  "runtime contract",
);
const source = read(resolve(PACKAGE, "main.bicep"), "runtime Bicep");
const readme = read(resolve(PACKAGE, "README.md"), "package README");

const expectedContract = {
  schemaVersion: 1,
  status: "reviewed-source",
  subscriptionId: "3171575e-f164-425c-9ee0-2fb10cf93884",
  sourceResourceGroup: "Ledgr-prod",
  targetResourceGroup: "workforce-os-prod",
  targetEnvironment: "workforce-os-prod-env",
  registryLoginServer: "workforceosprodacr.azurecr.io",
  runtimePullIdentity: "workforce-os-v2-runtime-pull",
  backendReleaseIdentity: "workforce-os-v2-backend-release",
  consoleReleaseIdentity: "workforce-os-v2-console-release",
  backendSourceImage:
    "workforceosprodacr.azurecr.io/apex-api@sha256:111a470e65a22d27039d0d130d7d0c7aa33e7a23e0d8ce8fe7183c685dbf6f25",
  consoleSourceImage:
    "workforceosprodacr.azurecr.io/workforceos-fe@sha256:c83bd7b774fa9ed7f83ffd2ad621c1c0edc2502e495d3feab43916e5378dd6ff",
  publicApiOrigin: "https://api.workforceos.xyz",
  publicConsoleOrigin: "https://workforceos.xyz",
  consoleSourceApiUpstreamOrigin:
    "https://apex-gtm-api.ashysmoke-fd2f7a7f.eastus.azurecontainerapps.io",
  secretMigration: {
    source: "server-side Microsoft.App/containerApps/listSecrets",
    valuesInDeploymentOutput: false,
    legacyRegistryPasswordCopied: false,
    plainMetricsTokenConvertedToSecretReference: true,
  },
  trafficAdmission: {
    publicDnsChangedByPackage: false,
    customDomainChangedByPackage: false,
    productionTrafficEnabledByPackage: false,
  },
};
same(contract, expectedContract, "runtime contract");

if (!source.includes("sourceApi.listSecrets().value") ||
  !source.includes("secret.name != oldRegistryPasswordSecretName") ||
  !source.includes("secret.name != metricsSecretName")) {
  fail("server-side secret migration boundary is absent");
}
if (/containerapp\s+secret\s+list/i.test(source)) {
  fail("a client-side or output secret channel is present");
}
if (!readme.includes("never parameters, outputs, files, logs, or client-side command")) {
  fail("README does not preserve the secret boundary");
}

const compile = spawnSync(
  "az",
  ["bicep", "build", "--file", resolve(PACKAGE, "main.bicep"), "--stdout"],
  { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
);
if (compile.error || compile.status !== 0) fail("Bicep compilation failed");
const template = parseJson(compile.stdout, "compiled Bicep");

const expectedDefaults = {
  sourceResourceGroupName: contract.sourceResourceGroup,
  sourceApiName: "apex-gtm-api",
  targetContainerAppsEnvironmentName: contract.targetEnvironment,
  registryLoginServer: contract.registryLoginServer,
  runtimePullIdentityName: contract.runtimePullIdentity,
  backendReleaseIdentityName: contract.backendReleaseIdentity,
  consoleReleaseIdentityName: contract.consoleReleaseIdentity,
  backendSourceImage: contract.backendSourceImage,
  consoleSourceImage: contract.consoleSourceImage,
  publicApiOrigin: contract.publicApiOrigin,
  publicConsoleOrigin: contract.publicConsoleOrigin,
  consoleSourceApiUpstreamOrigin: contract.consoleSourceApiUpstreamOrigin,
  clerkIssuer: "https://clerk.workforceos.xyz",
  clerkJwksUrl: "https://clerk.workforceos.xyz/.well-known/jwks.json",
};
for (const [name, expected] of Object.entries(expectedDefaults)) {
  if (template.parameters?.[name]?.defaultValue !== expected) {
    fail(`${name} default is not source-pinned`);
  }
}

const apps = template.resources.filter((resource) =>
  resource.type === "Microsoft.App/containerApps");
const roles = template.resources.filter((resource) =>
  resource.type === "Microsoft.Authorization/roleAssignments");
if (apps.length !== 3) fail("Container App count is not three");
if (roles.length !== 4) fail("release role-assignment count is not four");

same(
  [template.variables?.apiName, template.variables?.workerName, template.variables?.consoleName],
  ["apex-gtm-api", "apex-gtm-worker", "nikxius-web"],
  "Container App names",
);

for (const app of apps) {
  if (app.identity?.type !== "UserAssigned") fail("an app lacks the runtime identity");
  const identityKeys = Object.keys(app.identity.userAssignedIdentities ?? {});
  if (identityKeys.length !== 1 || !identityKeys[0].includes("runtimePullIdentityName")) {
    fail("an app has an unreviewed runtime identity");
  }
  if (app.properties?.configuration?.activeRevisionsMode !== "Single" ||
    app.properties?.configuration?.maxInactiveRevisions !== 10 ||
    app.properties?.template?.scale?.minReplicas !== 1) {
    fail("an app has an invalid rollback or availability policy");
  }
  const registries = app.properties?.configuration?.registries;
  if (!Array.isArray(registries) || registries.length !== 1 ||
    registries[0].server !== "[parameters('registryLoginServer')]" ||
    !String(registries[0].identity).includes("runtimePullIdentityName") ||
    "passwordSecretRef" in registries[0] || "username" in registries[0]) {
    fail("an app has a registry credential channel");
  }
}

const byName = Object.fromEntries(apps.map((app) => [app.name, app]));
const api = byName["[variables('apiName')]"].properties;
const worker = byName["[variables('workerName')]"].properties;
const console = byName["[variables('consoleName')]"].properties;
if (api.configuration?.ingress?.external !== true ||
  api.configuration?.ingress?.allowInsecure !== false ||
  api.configuration?.ingress?.targetPort !== 4000) {
  fail("API ingress contract is invalid");
}
if (worker.configuration?.ingress !== undefined) {
  fail("worker ingress must remain disabled");
}
if (console.configuration?.ingress?.external !== true ||
  console.configuration?.ingress?.targetPort !== 8080) {
  fail("console ingress contract is invalid");
}
const consoleEnvironment = console.template?.containers?.[0]?.env;
const consoleUpstream = Array.isArray(consoleEnvironment)
  ? consoleEnvironment.filter((item) => item.name === "API_UPSTREAM_URL")
  : [];
if (consoleUpstream.length !== 1 ||
  consoleUpstream[0].value !== "[parameters('consoleSourceApiUpstreamOrigin')]") {
  fail("console source upstream is not the reviewed immutable-image pin");
}

const secretExpression = String(api.configuration?.secrets ?? "");
if (!secretExpression.includes("listSecrets") ||
  !secretExpression.includes("oldRegistryPasswordSecretName") ||
  !secretExpression.includes("metricsSecretName") ||
  worker.configuration?.secrets !== api.configuration?.secrets) {
  fail("API/worker secret migration expressions differ or are unsafe");
}

const sharedSecrets = template.variables?.sharedSecretEnvironment;
const requiredSecretRefs = [
  "DATABASE_URL", "REDIS_URL", "CLERK_SECRET_KEY", "ENCRYPTION_KEY",
  "ADMIN_API_KEY", "GOOGLE_CLIENT_SECRET", "OAUTH_STATE_SECRET",
  "AZURE_OPENAI_KEY", "METRICS_AUTH_TOKEN",
];
if (!Array.isArray(sharedSecrets)) fail("shared secret environment is invalid");
for (const name of requiredSecretRefs) {
  const matches = sharedSecrets.filter((item) => item.name === name);
  if (matches.length !== 1 || typeof matches[0].secretRef !== "string" ||
    "value" in matches[0]) {
    fail(`${name} is not an exact secret reference`);
  }
}

const outputBytes = JSON.stringify(template.outputs ?? {});
if (/listSecrets|secretRef|secrets|METRICS_AUTH_TOKEN|sourceApi/i.test(outputBytes)) {
  fail("deployment outputs retain secret material or secret topology");
}
const compiledBytes = JSON.stringify(template);
if (compiledBytes.includes("ledgracrazurecrio-ledgracr\",\"value")) {
  fail("legacy registry password is copied into the target");
}

process.stdout.write("Production runtime package verified\n");
