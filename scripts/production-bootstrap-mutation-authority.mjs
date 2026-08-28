#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const ATTEMPT = /^[0-9a-f]{32}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const SUBSCRIPTION = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const STORAGE_ACCOUNT = /^[a-z0-9]{3,24}$/u;
const STORAGE_CONTAINER = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/u;
const STORAGE_BLOB = /^[A-Za-z0-9._/-]{1,256}$/u;
const RELEASE_REPOSITORY = "Kloudedge-apex/apex-product";
const RELEASE_LOCK_REF = "refs/heads/workforce-os-release-lock/production-gtm-platform";

function fail(message) {
  throw new Error(message);
}

function match(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) fail(`${label} is invalid`);
  return value;
}

function leaseId(attemptId) {
  match(attemptId, ATTEMPT, "bootstrap attempt ID");
  return [
    attemptId.slice(0, 8),
    attemptId.slice(8, 12),
    attemptId.slice(12, 16),
    attemptId.slice(16, 20),
    attemptId.slice(20),
  ].join("-");
}

function boundedJson(bytes, label) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 2 || bytes.length > 64 * 1024) {
    fail(`${label} response is invalid`);
  }
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    fail(`${label} response is invalid`);
  }
}

function run(command, args, environment, label) {
  const result = spawnSync(command, args, {
    encoding: null,
    maxBuffer: 64 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    env: environment,
  });
  if (result.error || result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
    fail(`${label} validation failed`);
  }
  return result.stdout;
}

function renewAzureLease(args, environment, expectedLeaseId) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = spawnSync("az", args, {
      encoding: null,
      maxBuffer: 64 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      env: environment,
    });
    if (!result.error && result.status === 0 && Buffer.isBuffer(result.stdout)) {
      const raw = result.stdout.toString("utf8").trim();
      let value = raw;
      try {
        value = JSON.parse(raw);
      } catch {
        // Azure CLI versions may emit the UUID directly even for JSON output.
      }
      const leaseId = typeof value === "string"
        ? value
        : value && typeof value === "object"
          ? value.leaseId ?? value.lease_id
          : null;
      if (typeof leaseId === "string" && leaseId.toLowerCase() === expectedLeaseId) {
        return;
      }
    }
  }
  fail("Azure bootstrap lease validation failed");
}

/**
 * Revalidate both durable mutation authorities from inside the child process,
 * immediately before its bounded Redis/PostgreSQL mutation. Command output is
 * never forwarded so credentials and remote diagnostics cannot enter evidence.
 */
export function verifyProductionBootstrapMutationAuthority(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    fail("production mutation authority options are invalid");
  }
  const attemptId = match(options.attemptId, ATTEMPT, "bootstrap attempt ID");
  const expectedBackendCommit = match(
    options.expectedBackendCommit,
    COMMIT,
    "expected backend commit",
  );
  const subscriptionId = match(options.subscriptionId, SUBSCRIPTION, "subscription ID");
  const storageAccount = match(options.storageAccount, STORAGE_ACCOUNT, "storage account");
  const storageContainer = match(options.storageContainer, STORAGE_CONTAINER, "storage container");
  const storageBlob = match(options.storageBlob, STORAGE_BLOB, "storage blob");
  if (storageBlob.includes("..") || storageBlob.startsWith("/") || storageBlob.endsWith("/")) {
    fail("storage blob is invalid");
  }
  const environment = options.environment ?? process.env;
  const expectedLeaseId = leaseId(attemptId);
  renewAzureLease([
    "storage", "blob", "lease", "renew",
    "--subscription", subscriptionId,
    "--account-name", storageAccount,
    "--container-name", storageContainer,
    "--blob-name", storageBlob,
    "--auth-mode", "login",
    "--lease-id", expectedLeaseId,
    "--output", "json",
    "--only-show-errors",
  ], environment, expectedLeaseId);

  const release = boundedJson(run("gh", [
    "api",
    `repos/${RELEASE_REPOSITORY}/git/ref/${RELEASE_LOCK_REF.replace("refs/", "")}`,
  ], environment, "GitHub production release lock"), "GitHub production release lock");
  if (release?.ref !== RELEASE_LOCK_REF || release?.object?.type !== "commit" ||
    release?.object?.sha !== expectedBackendCommit) {
    fail("GitHub production release lock validation failed");
  }
  return true;
}
