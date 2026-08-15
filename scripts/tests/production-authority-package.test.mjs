import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, "../..");
const SOURCE_PACKAGE = resolve(REPO_ROOT, "deploy/azure-production-authority-v1");
const VERIFIER = resolve(REPO_ROOT, "scripts/verify-production-authority-package.mjs");

function run(packagePath) {
  return spawnSync(process.execPath, [VERIFIER, packagePath], {
    encoding: "utf8",
    env: process.env,
    maxBuffer: 8 * 1024 * 1024,
  });
}

function rejected(label, file, mutate) {
  test(label, () => {
    const root = mkdtempSync(resolve(tmpdir(), "workforce-authority-package-"));
    const packagePath = resolve(root, "package");
    try {
      cpSync(SOURCE_PACKAGE, packagePath, { recursive: true });
      const target = resolve(packagePath, file);
      const source = readFileSync(target, "utf8");
      const changed = mutate(source);
      assert.notEqual(changed, source, "fixture mutation must change the source");
      writeFileSync(target, changed, { mode: 0o600 });
      const result = run(packagePath);
      assert.notEqual(result.status, 0, result.stdout || result.stderr);
      assert.match(
        result.stderr,
        /production authority package verification failed/u,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("canonical source-only Azure authority package compiles and verifies", () => {
  const result = run(SOURCE_PACKAGE);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Production authority package verified/u);
});

rejected("a wildcard ACR permission is rejected", "main.bicep", (source) =>
  source.replace(
    "'Microsoft.ContainerRegistry/registries/read'",
    "'Microsoft.ContainerRegistry/registries/*'",
  ));

rejected("blob deletion authority is rejected", "main.bicep", (source) =>
  source.replace(
    "'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read'",
    "'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/delete'",
  ));

rejected("Container App live RBAC audit read is required", "main.bicep", (source) =>
  source.replace("          'Microsoft.Authorization/roleAssignments/read'\n", ""));

rejected("storage identity read is required", "main.bicep", (source) =>
  source.replace("          'Microsoft.Storage/storageAccounts/read'\n", ""));

rejected("authority audit federation read is required", "main.bicep", (source) =>
  source.replace(
    "          'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials/read'\n",
    "",
  ));

rejected("the exact authority-audit management group is required", "main.bicep", (source) =>
  source.replace(
    "param authorityAuditManagementGroupId string = 'd4b3813d-146f-4d03-96b8-d6e5862d58a2'",
    "param authorityAuditManagementGroupId string = 'other-management-group'",
  ));

rejected(
  "management-group eligible-PIM read is required",
  "management-group-audit-reader.bicep",
  (source) => source.replace(
    "          'Microsoft.Authorization/roleEligibilityScheduleInstances/read'\n",
    "",
  ),
);

rejected(
  "management-group assignable scope is fixed",
  "management-group-audit-reader.bicep",
  (source) => source.replace(
    "var authorityAuditManagementGroupScope = '/providers/Microsoft.Management/managementGroups/d4b3813d-146f-4d03-96b8-d6e5862d58a2'",
    "var authorityAuditManagementGroupScope = '/providers/Microsoft.Management/managementGroups/other-management-group'",
  ),
);

rejected("build identity audit-reader authority is rejected", "main.bicep", (source) =>
  source.replace(
    "principalId: authorityResources.outputs.authority.backendRelease.principalId",
    "principalId: authorityResources.outputs.authority.backendBuild.principalId",
  ));

rejected("a wrong console repository OIDC subject is rejected", "main.bicep", (source) =>
  source.replace(
    "param consoleRepository string = 'Workforce-OS'",
    "param consoleRepository string = 'wrong-console'",
  ));

rejected("a nonexact container condition is rejected", "resources.bicep", (source) =>
  source.replace("StringEquals '{0}'", "StringEquals 'other.json'"));

rejected("a nonexact blob condition is rejected", "resources.bicep", (source) =>
  source.replace("StringEquals '{1}'", "StringEquals 'other.json'"));

rejected("a nonexact drain checkpoint condition is rejected", "resources.bicep", (source) =>
  source.replace("StringEquals '{2}'", "StringEquals 'other-checkpoint'"));

rejected("unescaped ABAC ActionMatches braces are rejected", "resources.bicep", (source) =>
  source.replace(
    "ActionMatches{{'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read'}}",
    "ActionMatches{'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read'}",
  ));

rejected("build identity Container App authority is rejected", "resources.bicep", (source) =>
  source.replace(
    "resource backendApiRelease 'Microsoft.Authorization/roleAssignments@2022-04-01' = {\n" +
      "  name: guid(apiApp.id, backendReleaseIdentity.name, containerAppReleaseRoleDefinitionId)\n" +
      "  scope: apiApp\n" +
      "  properties: {\n" +
      "    principalId: backendReleaseIdentity.properties.principalId",
    "resource backendApiRelease 'Microsoft.Authorization/roleAssignments@2022-04-01' = {\n" +
      "  name: guid(apiApp.id, backendBuildIdentity.name, containerAppReleaseRoleDefinitionId)\n" +
      "  scope: apiApp\n" +
      "  properties: {\n" +
      "    principalId: backendBuildIdentity.properties.principalId",
  ));

rejected("a widened control-blob assignment scope is rejected", "resources.bicep", (source) =>
  source.replace(
    "scope: controlStorage\n  properties: {\n    principalId: backendReleaseIdentity.properties.principalId",
    "scope: resourceGroup()\n  properties: {\n    principalId: backendReleaseIdentity.properties.principalId",
  ));

rejected("false no-break RBAC capability is rejected", "authority-contract.json", (source) =>
  source.replace('"leaseBreakSeparableByRbac": false', '"leaseBreakSeparableByRbac": true'));

rejected("control blob overwrite is rejected", "initialize-control-blob.sh", (source) =>
  source.replace("--overwrite false", "--overwrite true"));

rejected(
  "authority-drain checkpoint overwrite is rejected",
  "initialize-authority-drain-checkpoint.sh",
  (source) => source.replace("--overwrite false", "--overwrite true"),
);

rejected(
  "authority-drain account-key fallback is rejected",
  "initialize-authority-drain-checkpoint.sh",
  (source) => source.replace("--auth-mode login", "--auth-mode key"),
);

rejected(
  "authority-drain structural exclusivity bypass is rejected",
  "initialize-authority-drain-checkpoint.sh",
  (source) => source.replace(
    ".summary.structuralExclusive == true",
    ".summary.structuralExclusive != true",
  ),
);

rejected(
  "authority-drain human Azure session bypass is rejected",
  "initialize-authority-drain-checkpoint.sh",
  (source) => source.replace(
    '.user.type == "servicePrincipal"',
    '.user.type != "servicePrincipal"',
  ),
);
