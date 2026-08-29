import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, "../..");
const VERIFIER = resolve(REPO_ROOT, "scripts/verify-production-domain-promotion.mjs");

function verify(root = REPO_ROOT) {
  return spawnSync(process.execPath, [VERIFIER, root], { encoding: "utf8" });
}

function rejected(label, file, mutate) {
  test(label, () => {
    const root = mkdtempSync(resolve(tmpdir(), "workforce-domain-promotion-"));
    try {
      cpSync(resolve(REPO_ROOT, ".github"), resolve(root, ".github"), { recursive: true });
      cpSync(resolve(REPO_ROOT, "scripts"), resolve(root, "scripts"), { recursive: true });
      const path = resolve(root, file);
      const source = readFileSync(path, "utf8");
      const changed = mutate(source);
      assert.notEqual(changed, source, "fixture mutation must change source");
      writeFileSync(path, changed, { mode: 0o700 });
      const result = verify(root);
      assert.notEqual(result.status, 0, result.stdout || result.stderr);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("canonical production domain promotion verifies", () => {
  const result = verify();
  assert.equal(result.status, 0, result.stderr);
});

rejected("an unprotected branch is rejected", ".github/workflows/promote-production-domains.yml",
  (source) => source.replace("refs/heads/master", "refs/heads/release"));

rejected("a mutable image is rejected", "scripts/promote-production-custom-domains.sh",
  (source) => source.replace("apex-api@sha256:", "apex-api:latest # sha256:"));

rejected("a legacy application mutation is rejected", "scripts/promote-production-custom-domains.sh",
  (source) => `${source}\naz containerapp update -g Ledgr-prod -n apex-gtm-api\n`);

rejected("a DNS mutation is rejected", "scripts/promote-production-custom-domains.sh",
  (source) => `${source}\ncurl https://api.cloudflare.com/client/v4/dns_records\n`);

rejected("rollback removal is required", "scripts/promote-production-custom-domains.sh",
  (source) => source.replace("az containerapp hostname delete", "echo skipped hostname delete"));
