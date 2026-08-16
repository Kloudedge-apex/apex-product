#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const workflow = resolve(
  process.argv[2] ?? ".github/workflows/initialize-production-authority-drain.yml",
);

function fail(message) {
  throw new Error(`production authority-drain workflow verification failed: ${message}`);
}

let source;
try {
  source = readFileSync(workflow, "utf8");
} catch {
  fail("workflow source is unavailable");
}

for (const literal of [
  "workflow_dispatch:",
  "contents: read",
  "id-token: write",
  "group: workforce-os-production-authority-drain",
  "cancel-in-progress: false",
  "environment: workforce-os-production",
  '"${GITHUB_REF}" != "refs/heads/master"',
  '"${REF_PROTECTED}" != "true"',
  '"${CONFIRMATION}" != "CREATE WORKFORCE OS AUTHORITY DRAIN CHECKPOINT"',
  ".protected == true and .commit.sha == $sha",
  "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
  "persist-credentials: false",
  "node scripts/verify-production-isolation-package.mjs",
  "azure/login@a457da9ea143d694b1b9c7c869ebb04ebe844ef5",
  "client-id: 2efd64b0-87c1-43a7-a064-30679ce8b764",
  "tenant-id: d4b3813d-146f-4d03-96b8-d6e5862d58a2",
  "subscription-id: 3171575e-f164-425c-9ee0-2fb10cf93884",
  "deploy/azure-production-isolation-v2/initialize-authority-drain-checkpoint.sh",
  "--confirmation 'CREATE WORKFORCE OS AUTHORITY DRAIN CHECKPOINT'",
  "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
]) {
  if (!source.includes(literal)) fail(`required source pin is absent: ${literal}`);
}

for (const [pattern, label] of [
  [/^\s*(push|pull_request|schedule|repository_dispatch):/mu, "non-manual trigger"],
  [/permissions:\s*[\s\S]*?contents:\s*write/u, "content write permission"],
  [/client-secret|AZURE_CREDENTIALS|account-key|connection-string/iu, "credential channel"],
  [/containerapp\s+secret\s+list|storage\s+account\s+keys\s+list/iu, "secret read"],
  [/storage\s+blob\s+(delete|metadata\s+update)|lease\s+break/iu, "destructive reset"],
  [/RESET WORKFORCE OS AUTHORITY DRAIN CHECKPOINT/u, "checkpoint reset"],
]) {
  if (pattern.test(source)) fail(`${label} is present`);
}

const counts = (needle) => source.split(needle).length - 1;
if (counts("azure/login@") !== 1 ||
  counts("initialize-authority-drain-checkpoint.sh") !== 1 ||
  counts("environment: workforce-os-production") !== 1) {
  fail("workflow contains duplicate authority or mutation steps");
}

process.stdout.write("Production authority-drain workflow verified\n");
