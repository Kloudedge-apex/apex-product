import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, "../..");
const WORKFLOW = resolve(REPO_ROOT, ".github/workflows/bootstrap-production.yml");
const VERIFIER = resolve(REPO_ROOT, "scripts/verify-production-bootstrap-workflow.sh");
const SOURCE = readFileSync(WORKFLOW, "utf8");

function verify(source = SOURCE) {
  const root = mkdtempSync(resolve(tmpdir(), "workforce-bootstrap-workflow-"));
  const path = resolve(root, "bootstrap-production.yml");
  try {
    writeFileSync(path, source, { mode: 0o600 });
    return spawnSync("/bin/bash", [VERIFIER, path], {
      encoding: "utf8",
      env: process.env,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function rejected(label, mutate) {
  test(label, () => {
    const source = mutate(SOURCE);
    assert.notEqual(source, SOURCE, "fixture mutation must change the workflow");
    const result = verify(source);
    assert.notEqual(result.status, 0, result.stdout || result.stderr);
  });
}

test("canonical bootstrap workflow passes its source contract", () => {
  const result = verify();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Production bootstrap workflow contract verified/u);
});

rejected("a reviewer-gated production environment is rejected", (source) =>
  source.replace(
    '.type != "required_reviewers"',
    '.type == "required_reviewers"',
  ));

rejected("repository-level variable fallback is rejected", (source) =>
  source.replace(
    "${{ steps.production_environment.outputs.azure_client_id }}",
    "${{ vars.AZURE_CLIENT_ID }}",
  ));

rejected("repository variable metadata cannot replace environment metadata", (source) =>
  source.replace(
    "environments/workforce-os-production/variables/${name}",
    "actions/variables/${name}",
  ));

rejected("repository secret metadata cannot replace environment metadata", (source) =>
  source.replace(
    "environments/workforce-os-production/secrets/${name}",
    "actions/secrets/${name}",
  ));

rejected("the action-scoped request secret must be environment-proven", (source) =>
  source.replace(
    '          verify_environment_secret "PRODUCTION_BOOTSTRAP_REQUEST_B64"\n',
    "",
  ));

rejected("the audited Azure principal object ID cannot be bypassed", (source) =>
  source.replace(
    "AZURE_PRINCIPAL_OBJECT_ID: ${{ steps.production_environment.outputs.azure_principal_object_id }}",
    "AZURE_PRINCIPAL_OBJECT_ID: 00000000-0000-0000-0000-000000000000",
  ));

rejected("the audited DDL authority output cannot be hard-coded", (source) =>
  source.replace(
    "steps.production_environment.outputs.exclusive_ddl_authority",
    "true",
  ));
