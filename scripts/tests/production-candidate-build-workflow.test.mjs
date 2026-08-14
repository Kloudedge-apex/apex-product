import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, "../..");
const WORKFLOW = resolve(REPO_ROOT, ".github/workflows/build-production-candidate.yml");
const VERIFIER = resolve(REPO_ROOT, "scripts/verify-production-candidate-build-workflow.sh");
const SOURCE = readFileSync(WORKFLOW, "utf8");

function verify(source = SOURCE) {
  const root = mkdtempSync(resolve(tmpdir(), "workforce-candidate-build-"));
  const workflow = resolve(root, "candidate.yml");
  try {
    writeFileSync(workflow, source, { mode: 0o600 });
    return spawnSync("/bin/bash", [VERIFIER, workflow], {
      encoding: "utf8",
      env: process.env,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function rejected(label, mutate) {
  test(label, () => {
    const fixture = mutate(SOURCE);
    assert.notEqual(fixture, SOURCE, "fixture mutation must change the workflow");
    const result = verify(fixture);
    assert.notEqual(result.status, 0, result.stdout || result.stderr);
  });
}

test("canonical backend candidate-build workflow passes", () => {
  const result = verify();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /candidate-build workflow contract verified/u);
});

rejected("a mutable action reference is rejected", (source) =>
  source.replace(
    "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
    "actions/checkout@v4",
  ));

rejected("repository variable fallback is rejected", (source) =>
  source.replace(
    "${{ steps.build_environment.outputs.azure_client_id }}",
    "${{ vars.AZURE_CLIENT_ID }}",
  ));

rejected("a backend build secret is rejected", (source) =>
  source.replace(
    "SOURCE_SHA: ${{ github.sha }}",
    "SOURCE_SHA: ${{ secrets.SOURCE_SHA }}",
  ));

rejected("Container App mutation is rejected", (source) =>
  source.replace(
    "          acr_run_id=\"$(az acr build \\\n",
    "          az containerapp update --name apex-gtm-api\n          acr_run_id=\"$(az acr build \\\n",
  ));

rejected("registry deletion is rejected", (source) =>
  source.replace(
    "          existing=\"$(az acr repository show-tags \\\n",
    "          az acr repository delete --name ledgracr --repository apex-api\n          existing=\"$(az acr repository show-tags \\\n",
  ));

rejected("a pre-existing commit tag may not be overwritten", (source) =>
  source.replace(
    '          if [[ "${existing}" != "0" ]]; then',
    '          if [[ "${existing}" == "0" ]]; then',
  ));

rejected("ACR logs may not expose build material", (source) =>
  source.replace("            --no-logs \\\n", ""));

rejected("exact source CI verification is mandatory", (source) =>
  source.replace(
    '        run: scripts/verify-github-release-ci.sh "${SOURCE_SHA}"',
    "        run: true",
  ));

rejected("write access to repository contents is rejected", (source) =>
  source.replace("  contents: read", "  contents: write"));
