import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, "../..");
const SOURCE = resolve(REPO_ROOT, "deploy/azure-production-isolation-v2");
const VERIFIER = resolve(REPO_ROOT, "scripts/verify-production-isolation-package.mjs");

function verify(packagePath = SOURCE) {
  return spawnSync(process.execPath, [VERIFIER, packagePath], {
    encoding: "utf8",
    env: process.env,
    maxBuffer: 12 * 1024 * 1024,
  });
}

function rejected(label, file, mutate) {
  test(label, () => {
    const root = mkdtempSync(resolve(tmpdir(), "workforce-isolation-package-"));
    const packagePath = resolve(root, "package");
    try {
      cpSync(SOURCE, packagePath, { recursive: true });
      const path = resolve(packagePath, file);
      const source = readFileSync(path, "utf8");
      const changed = mutate(source);
      assert.notEqual(changed, source, "fixture mutation must change source");
      writeFileSync(path, changed, { mode: 0o600 });
      const result = verify(packagePath);
      assert.notEqual(result.status, 0, result.stdout || result.stderr);
      assert.match(
        result.stderr,
        /production isolation package verification failed/u,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("canonical isolated production package compiles and verifies", () => {
  const result = verify();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Production isolation package verified/u);
});

rejected("ACR admin credentials are rejected", "resources.bicep", (source) =>
  source.replace("adminUserEnabled: false", "adminUserEnabled: true"));

rejected("Storage shared-key credentials are rejected", "resources.bicep", (source) =>
  source.replace("allowSharedKeyAccess: false", "allowSharedKeyAccess: true"));

rejected("public blob access is rejected", "resources.bicep", (source) =>
  source.replace("allowBlobPublicAccess: false", "allowBlobPublicAccess: true"));

rejected("a wildcard build role is rejected", "main.bicep", (source) =>
  source.replace(
    "'Microsoft.ContainerRegistry/registries/read'",
    "'Microsoft.ContainerRegistry/registries/*'",
  ));

rejected("blob delete authority is rejected", "main.bicep", (source) =>
  source.replace(
    "'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read'",
    "'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/delete'",
  ));

rejected("a wrong console OIDC repository is rejected", "main.bicep", (source) =>
  source.replace(
    "param consoleRepository string = 'Workforce-OS'",
    "param consoleRepository string = 'wrong-console'",
  ));

rejected("a missing runtime AcrPull assignment is rejected", "resources.bicep", (source) =>
  source.replace(
    "resource runtimeImagePullAcrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {",
    "resource runtimeImagePullAcrPullDisabled 'Microsoft.Authorization/locks@2020-05-01' = {",
  ));

rejected("GitHub federation on the runtime pull identity is rejected", "resources.bicep", (source) =>
  source.replace(
    "parent: backendBuildIdentity\n  name: 'github-environment'",
    "parent: runtimeImagePullIdentity\n  name: 'github-environment'",
  ));

rejected("a human deny exclusion is rejected", "authority-contract.json", (source) =>
  source.replace(
    '"humanPrincipalExcludedAfterBootstrap": false',
    '"humanPrincipalExcludedAfterBootstrap": true',
  ));

rejected("a destructive unmanage policy is rejected", "README.md", (source) =>
  source.replace("`detachAll` on unmanage", "`deleteAll` on unmanage"));
