#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import { verifyProductionBootstrapMutationAuthority } from
  "../production-bootstrap-mutation-authority.mjs";

const ATTEMPT = "0123456789abcdef0123456789abcdef";
const COMMIT = "a".repeat(40);
const LEASE = "01234567-89ab-cdef-0123-456789abcdef";

test("child mutation authority rechecks exact Azure lease and Git ref", () => {
  const root = mkdtempSync(join(tmpdir(), "bootstrap-authority-helper-"));
  try {
    const bin = join(root, "bin");
    const log = join(root, "commands.log");
    mkdirSync(bin, { mode: 0o700 });
    const az = join(bin, "az");
    const gh = join(bin, "gh");
    writeFileSync(az, `#!/usr/bin/env bash
set -euo pipefail
printf 'az' >>"\${AUTHORITY_LOG}"
printf '\\t%s' "$@" >>"\${AUTHORITY_LOG}"
printf '\\n' >>"\${AUTHORITY_LOG}"
printf '{"leaseId":"%s"}\\n' "\${EXPECTED_LEASE}"
`, { mode: 0o700 });
    writeFileSync(gh, `#!/usr/bin/env bash
set -euo pipefail
printf 'gh' >>"\${AUTHORITY_LOG}"
printf '\\t%s' "$@" >>"\${AUTHORITY_LOG}"
printf '\\n' >>"\${AUTHORITY_LOG}"
printf '{"ref":"refs/heads/workforce-os-release-lock/production-gtm-platform","object":{"type":"commit","sha":"%s"}}\\n' "\${EXPECTED_COMMIT}"
`, { mode: 0o700 });
    chmodSync(az, 0o700);
    chmodSync(gh, 0o700);
    const environment = {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
      AUTHORITY_LOG: log,
      EXPECTED_LEASE: LEASE,
      EXPECTED_COMMIT: COMMIT,
    };
    assert.equal(verifyProductionBootstrapMutationAuthority({
      attemptId: ATTEMPT,
      expectedBackendCommit: COMMIT,
      subscriptionId: "12345678-1234-4234-9234-123456789abc",
      storageAccount: "workforcebootstrap",
      storageContainer: "production-control",
      storageBlob: "workforce-os/initial-production-bootstrap/state-v1.json",
      environment,
    }), true);
    const [azure, github] = readFileSync(log, "utf8").trim().split("\n")
      .map((line) => line.split("\t"));
    assert.deepEqual(azure, [
      "az", "storage", "blob", "lease", "renew",
      "--subscription", "12345678-1234-4234-9234-123456789abc",
      "--account-name", "workforcebootstrap",
      "--container-name", "production-control",
      "--blob-name", "workforce-os/initial-production-bootstrap/state-v1.json",
      "--auth-mode", "login",
      "--lease-id", LEASE,
      "--output", "json",
      "--only-show-errors",
    ]);
    assert.deepEqual(github, [
      "gh", "api",
      "repos/Kloudedge-apex/apex-product/git/ref/heads/workforce-os-release-lock/production-gtm-platform",
    ]);
    assert.equal(azure.includes("--name"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
