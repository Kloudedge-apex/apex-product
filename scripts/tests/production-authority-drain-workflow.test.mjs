import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, "../..");
const SOURCE = resolve(REPO_ROOT, ".github/workflows/initialize-production-authority-drain.yml");
const VERIFIER = resolve(REPO_ROOT, "scripts/verify-production-authority-drain-workflow.mjs");

function verify(path = SOURCE) {
  return spawnSync(process.execPath, [VERIFIER, path], {
    encoding: "utf8",
    env: process.env,
  });
}

function rejected(label, mutate) {
  test(label, () => {
    const root = mkdtempSync(resolve(tmpdir(), "workforce-authority-drain-workflow-"));
    const path = resolve(root, "workflow.yml");
    try {
      const source = readFileSync(SOURCE, "utf8");
      const changed = mutate(source);
      assert.notEqual(changed, source, "fixture mutation must change source");
      writeFileSync(path, changed, { mode: 0o600 });
      const result = verify(path);
      assert.notEqual(result.status, 0, result.stdout || result.stderr);
      assert.match(
        result.stderr,
        /production authority-drain workflow verification failed/u,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("canonical protected authority-drain workflow verifies", () => {
  const result = verify();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Production authority-drain workflow verified/u);
});

rejected("a push trigger is rejected", (source) =>
  source.replace("  workflow_dispatch:", "  push:\n  workflow_dispatch:"));

rejected("a client-secret login is rejected", (source) =>
  source.replace(
    "client-id: 2efd64b0-87c1-43a7-a064-30679ce8b764",
    "client-secret: unreviewed",
  ));

rejected("a checkpoint reset is rejected", (source) =>
  `${source}\n# RESET WORKFORCE OS AUTHORITY DRAIN CHECKPOINT\n`);

rejected("a writable checkout token is rejected", (source) =>
  source.replace("contents: read", "contents: write"));

rejected("an unprotected ref is rejected", (source) =>
  source.replace('"${REF_PROTECTED}" != "true"', '"${REF_PROTECTED}" != "false"'));

rejected("runtime authority without final deny is rejected", (source) =>
  source.replace("--deny-settings-mode denyWriteAndDelete", "--deny-settings-mode none"));

rejected("runtime authority without the reviewed template is rejected", (source) =>
  source.replace(
    "--template-file deploy/azure-production-runtime-v1/main.bicep",
    "--template-file unreviewed.bicep",
  ));

rejected("destructive runtime unmanage is rejected", (source) =>
  source.replace("--action-on-unmanage detachAll", "--action-on-unmanage deleteAll"));
