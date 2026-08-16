import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, "../..");
const SOURCE = resolve(REPO_ROOT, "deploy/azure-production-runtime-v1");
const VERIFIER = resolve(REPO_ROOT, "scripts/verify-production-runtime-package.mjs");

function verify(packagePath = SOURCE) {
  return spawnSync(process.execPath, [VERIFIER, packagePath], {
    encoding: "utf8",
    env: process.env,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function rejected(label, file, mutate) {
  test(label, () => {
    const root = mkdtempSync(resolve(tmpdir(), "workforce-runtime-package-"));
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
      assert.match(result.stderr, /production runtime package verification failed/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("canonical isolated production runtime compiles and verifies", () => {
  const result = verify();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Production runtime package verified/u);
});

rejected("an inline metrics token is rejected", "main.bicep", (source) =>
  source.replace(
    "{ name: 'METRICS_AUTH_TOKEN', secretRef: metricsSecretName }",
    "{ name: 'METRICS_AUTH_TOKEN', value: 'unsafe-inline' }",
  ));

rejected("copying the legacy registry password is rejected", "main.bicep", (source) =>
  source.replace(
    "secret.name != oldRegistryPasswordSecretName && secret.name != metricsSecretName",
    "secret.name != metricsSecretName",
  ));

rejected("a registry password channel is rejected", "main.bicep", (source) =>
  source.replace(
    "identity: runtimePullIdentity.id",
    "passwordSecretRef: 'legacy-registry-password'",
  ));

rejected("worker ingress is rejected", "main.bicep", (source) =>
  source.replace(
    "maxInactiveRevisions: 10\n      registries:",
    "maxInactiveRevisions: 10\n      ingress: { external: true, targetPort: 4000 }\n      registries:",
  ));

rejected("traffic admission by the package is rejected", "runtime-contract.json", (source) =>
  source.replace('"productionTrafficEnabledByPackage": false', '"productionTrafficEnabledByPackage": true'));
