#!/usr/bin/env node

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function command(name, args, options = {}) {
  return spawnSync(name, args, { encoding: "utf8", maxBuffer: 2 * 1024 * 1024, ...options });
}

test("a hostile wrong Redis identity creates no BullMQ or fence keys", async (t) => {
  if (command("docker", ["info"]).status !== 0) {
    t.skip("Docker is unavailable");
    return;
  }
  const container = `workforce-bootstrap-redis-${process.pid}-${randomBytes(4).toString("hex")}`;
  const root = mkdtempSync(join(tmpdir(), "bootstrap-redis-target-"));
  try {
    const started = command("docker", [
      "run", "--detach", "--rm", "--name", container,
      "--publish", "127.0.0.1::6379",
      process.env.BOOTSTRAP_TEST_REDIS_IMAGE ??
        "redis:7.4.6-alpine@sha256:3b73847e72874be07e6657b129a94761662b79bc0f679273757d4218573b2a98",
    ]);
    assert.equal(started.status, 0, started.stderr);
    const mapping = command("docker", ["port", container, "6379/tcp"]);
    assert.equal(mapping.status, 0, mapping.stderr);
    const port = mapping.stdout.trim().match(/:(\d+)$/u)?.[1];
    assert.ok(port);
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (command("docker", ["exec", container, "redis-cli", "PING"]).stdout.trim() === "PONG") {
        ready = true;
        break;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
    assert.equal(ready, true, "disposable Redis did not become ready");

    const probe = join(root, "wrong-target.ts");
    writeFileSync(probe, `
import { createProductionBootstrapRuntime } from ${JSON.stringify(
      resolve(REPO_ROOT, "apps/api/src/ops/production-bootstrap-quiescence.ts"),
    )};
async function main() {
  let rejected = false;
  try {
    createProductionBootstrapRuntime("sha256:${"f".repeat(64)}");
  } catch (error) {
    rejected = error instanceof Error && error.message.includes("Redis identity does not match");
  }
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  if (!rejected) process.exitCode = 1;
}
void main();
`, { mode: 0o600 });
    chmodSync(probe, 0o600);
    const result = command("pnpm", ["--filter", "@apex/api", "exec", "tsx", probe], {
      cwd: REPO_ROOT,
      env: { ...process.env, REDIS_URL: `redis://127.0.0.1:${port}/0` },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const size = command("docker", ["exec", container, "redis-cli", "DBSIZE"]);
    assert.equal(size.status, 0, size.stderr);
    assert.equal(size.stdout.trim(), "0", "wrong Redis identity received bootstrap keys");
  } finally {
    command("docker", ["rm", "--force", container]);
    rmSync(root, { recursive: true, force: true });
  }
});
