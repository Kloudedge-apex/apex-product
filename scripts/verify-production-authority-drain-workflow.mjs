#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const workflow = resolve(
  process.argv[2] ?? ".github/workflows/initialize-production-authority-drain.yml",
);
const sealWorkflow = resolve(
  process.argv[3] ?? ".github/workflows/seal-production-runtime-authority.yml",
);
const auditWorkflow = resolve(
  process.argv[4] ?? ".github/workflows/audit-production-authority.yml",
);

function fail(message) {
  throw new Error(`production authority-drain workflow verification failed: ${message}`);
}

let source;
let sealSource;
let auditSource;
try {
  source = readFileSync(workflow, "utf8");
  sealSource = readFileSync(sealWorkflow, "utf8");
  auditSource = readFileSync(auditWorkflow, "utf8");
} catch {
  fail("workflow source set is unavailable");
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
  "node scripts/verify-production-runtime-package.mjs",
  "azure/login@a457da9ea143d694b1b9c7c869ebb04ebe844ef5",
  "client-id: 2efd64b0-87c1-43a7-a064-30679ce8b764",
  "tenant-id: d4b3813d-146f-4d03-96b8-d6e5862d58a2",
  "subscription-id: 3171575e-f164-425c-9ee0-2fb10cf93884",
  "az stack group show",
  "--resource-group workforce-os-prod",
  "--name workforce-os-production-runtime-v1",
  ".deny.mode == \"denyWriteAndDelete\"",
  ".deny.applyToChildScopes == true",
  "containerapps/apex-gtm-api",
  "containerapps/apex-gtm-worker",
  "containerapps/nikxius-web",
  "deploy/azure-production-isolation-v2/initialize-authority-drain-checkpoint.sh",
  "--confirmation 'CREATE WORKFORCE OS AUTHORITY DRAIN CHECKPOINT'",
  '(.mode == "create" or .mode == "existing")',
  'sub("\\\\+00:00$"; "Z")',
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
  [/stack\s+group\s+(create|delete)/iu, "runtime stack mutation"],
  [/RESET WORKFORCE OS AUTHORITY DRAIN CHECKPOINT/u, "checkpoint reset"],
]) {
  if (pattern.test(source)) fail(`${label} is present`);
}

const counts = (needle) => source.split(needle).length - 1;
if (counts("azure/login@") !== 1 ||
  counts("az stack group show") !== 1 ||
  counts("initialize-authority-drain-checkpoint.sh") !== 1 ||
  counts("environment: workforce-os-production") !== 1) {
  fail("workflow contains duplicate authority or mutation steps");
}

for (const literal of [
  "workflow_dispatch:",
  "contents: read",
  "id-token: write",
  "group: workforce-os-production-runtime-authority",
  "cancel-in-progress: false",
  "environment: workforce-os-production",
  '"${GITHUB_REF}" != "refs/heads/master"',
  '"${REF_PROTECTED}" != "true"',
  '"${CONFIRMATION}" != "SEAL WORKFORCE OS RUNTIME AUTHORITY"',
  ".protected == true and .commit.sha == $sha",
  "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
  "persist-credentials: false",
  "node scripts/verify-production-runtime-package.mjs",
  "azure/login@a457da9ea143d694b1b9c7c869ebb04ebe844ef5",
  "client-id: 2efd64b0-87c1-43a7-a064-30679ce8b764",
  "tenant-id: d4b3813d-146f-4d03-96b8-d6e5862d58a2",
  "subscription-id: 3171575e-f164-425c-9ee0-2fb10cf93884",
  "az stack group create",
  "--resource-group workforce-os-prod",
  "--name workforce-os-production-runtime-v1",
  "--template-file deploy/azure-production-runtime-v1/main.bicep",
  "--deny-settings-mode denyWriteAndDelete",
  "--deny-settings-apply-to-child-scopes",
  "abc0d6b0-35ae-4d33-bcea-237fdca83a94 0bc83fa6-91a2-4d94-9dff-f55c104cb425 509039c1-8cfd-4df4-9bb0-cc659b5a7e22 b1d6b4c9-4596-4fa4-9ad8-6cc8e17ff89a",
  "--action-on-unmanage detachAll",
  ".deny.mode == \"denyWriteAndDelete\"",
  ".deny.applyToChildScopes == true",
]) {
  if (!sealSource.includes(literal)) fail(`required runtime-seal source pin is absent: ${literal}`);
}

for (const [pattern, label] of [
  [/^\s*(push|pull_request|schedule|repository_dispatch):/mu, "non-manual runtime-seal trigger"],
  [/permissions:\s*[\s\S]*?contents:\s*write/u, "runtime-seal content write permission"],
  [/client-secret|AZURE_CREDENTIALS|account-key|connection-string/iu, "runtime-seal credential channel"],
  [/containerapp\s+secret\s+list|storage\s+account\s+keys\s+list/iu, "runtime-seal secret read"],
  [/stack\s+group\s+delete|--action-on-unmanage\s+delete/iu, "destructive runtime-seal authority"],
  [/initialize-authority-drain-checkpoint\.sh|storage\s+blob\s+(upload|delete)/iu, "checkpoint authority in runtime seal"],
]) {
  if (pattern.test(sealSource)) fail(`${label} is present`);
}

const sealCounts = (needle) => sealSource.split(needle).length - 1;
if (sealCounts("azure/login@") !== 1 ||
  sealCounts("az stack group create") !== 1 ||
  sealCounts("environment: workforce-os-production") !== 1) {
  fail("runtime-seal workflow contains duplicate authority or mutation steps");
}

for (const literal of [
  "workflow_dispatch:",
  "contents: read",
  "id-token: write",
  "group: workforce-os-production-authority-audit",
  "cancel-in-progress: false",
  "environment: workforce-os-production",
  '"${GITHUB_REF}" != "refs/heads/master"',
  '"${REF_PROTECTED}" != "true"',
  '"${CONFIRMATION}" != "AUDIT WORKFORCE OS PRODUCTION AUTHORITY"',
  ".protected == true and .commit.sha == $sha",
  "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
  "persist-credentials: false",
  "node scripts/verify-production-isolation-package.mjs",
  "node scripts/verify-production-runtime-package.mjs",
  "node scripts/verify-production-authority-package.mjs",
  "azure/login@a457da9ea143d694b1b9c7c869ebb04ebe844ef5",
  "client-id: 2efd64b0-87c1-43a7-a064-30679ce8b764",
  "tenant-id: d4b3813d-146f-4d03-96b8-d6e5862d58a2",
  "subscription-id: 3171575e-f164-425c-9ee0-2fb10cf93884",
  'node scripts/production-azure-mutation-authority-audit.mjs >"${report}"',
  'printf \'report=%s\\n\' "${report}" >>"${GITHUB_OUTPUT}"',
  'echo "ERROR: production authority audit returned NO-GO"',
  '.status == "GO"',
  ".summary.structuralExclusive == true",
  ".summary.credentialDrainComplete == true",
  ".controllerEvidence | type == \"object\"",
  ".findings | type == \"array\" and length == 0",
  "always() && steps.authority_audit.outputs.report != ''",
  "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
]) {
  if (!auditSource.includes(literal)) fail(`required production-audit source pin is absent: ${literal}`);
}

for (const [pattern, label] of [
  [/^\s*(push|pull_request|schedule|repository_dispatch):/mu, "non-manual production-audit trigger"],
  [/permissions:\s*[\s\S]*?contents:\s*write/u, "production-audit content write permission"],
  [/client-secret|AZURE_CREDENTIALS|account-key|connection-string/iu, "production-audit credential channel"],
  [/\$\{\{\s*(secrets|vars)\./u, "production-audit secret or variable input"],
  [/containerapp\s+(create|update|delete)|role\s+assignment\s+(create|delete)|storage\s+blob\s+(upload|delete)|stack\s+group\s+(create|delete)|lease\s+(acquire|break|release)/iu, "production-audit mutation command"],
  [/containerapp\s+secret\s+list|storage\s+account\s+keys\s+list/iu, "production-audit secret read"],
  [/continue-on-error\s*:\s*true/iu, "production-audit ignored failure"],
]) {
  if (pattern.test(auditSource)) fail(`${label} is present`);
}

const auditCounts = (needle) => auditSource.split(needle).length - 1;
if (auditCounts("azure/login@") !== 1 ||
  auditCounts("production-azure-mutation-authority-audit.mjs") !== 1 ||
  auditCounts("environment: workforce-os-production") !== 1 ||
  auditCounts("actions/upload-artifact@") !== 1) {
  fail("production-audit workflow contains duplicate authority or evidence steps");
}

process.stdout.write("Production authority-drain, runtime-seal, and audit workflows verified\n");
