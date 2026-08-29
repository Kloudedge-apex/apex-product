#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(process.argv[2] ?? resolve(SCRIPT_DIR, ".."));
const workflow = readFileSync(
  resolve(ROOT, ".github/workflows/promote-production-domains.yml"),
  "utf8",
);
const promotion = readFileSync(
  resolve(ROOT, "scripts/promote-production-custom-domains.sh"),
  "utf8",
);

function fail(message) {
  throw new Error(`production domain promotion verification failed: ${message}`);
}

function requireLiteral(source, literal, label) {
  if (!source.includes(literal)) fail(`${label} is absent`);
}

const syntax = spawnSync("bash", ["-n", resolve(ROOT,
  "scripts/promote-production-custom-domains.sh")], { encoding: "utf8" });
if (syntax.error || syntax.status !== 0) fail("promotion script syntax is invalid");

for (const literal of [
  "workflow_dispatch:",
  "contents: read",
  "id-token: write",
  "environment: workforce-os-production",
  "refs/heads/master",
  "github.ref_protected",
  "PROMOTE WORKFORCE OS PUBLIC DOMAINS",
  "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
  "azure/login@a457da9ea143d694b1b9c7c869ebb04ebe844ef5",
  "client-id: 2efd64b0-87c1-43a7-a064-30679ce8b764",
  "node scripts/verify-production-isolation-package.mjs",
  "scripts/promote-production-custom-domains.sh",
  "--apply",
]) requireLiteral(workflow, literal, `workflow literal ${literal}`);

if (/^\s*(push|pull_request|schedule):/mu.test(workflow) ||
  /secrets\./u.test(workflow) ||
  /persist-credentials:\s*true/u.test(workflow)) {
  fail("workflow trigger, credential, or checkout authority is broader than reviewed");
}

for (const literal of [
  'SUBSCRIPTION_ID="3171575e-f164-425c-9ee0-2fb10cf93884"',
  'RESOURCE_GROUP="workforce-os-prod"',
  'ENVIRONMENT_NAME="workforce-os-prod-env"',
  'API_APP="apex-gtm-api"',
  'WORKER_APP="apex-gtm-worker"',
  'CONSOLE_APP="nikxius-web"',
  'API_HOSTNAME="api.workforceos.xyz"',
  'CONSOLE_HOSTNAME="workforceos.xyz"',
  'API_CERTIFICATE_NAME="workforceos-api-v1"',
  'CONSOLE_CERTIFICATE_NAME="workforceos-root-v1"',
  'BACKEND_IMAGE="workforceosprodacr.azurecr.io/apex-api@sha256:6eb0734c3e27a7c4eaec61aa69ccc37e325ab227a4a19789ac64e5efbac9f699"',
  'CONSOLE_IMAGE="workforceosprodacr.azurecr.io/workforceos-fe@sha256:892c308dcf991214a2ac4b4ea95a58c2eb1481524f6f83b1e0734f4c424fe30c"',
  'API_REVISION="apex-gtm-api--bootstrap-api-0767c74-r1-r4"',
  'WORKER_REVISION="apex-gtm-worker--bootstrap-first-class-629881c-r4"',
  'CONSOLE_REVISION="nikxius-web--bootstrap-console-1b930e4"',
  'CONFIRMATION_PHRASE="PROMOTE WORKFORCE OS PUBLIC DOMAINS"',
  "domainControlValidation == \"TXT\"",
  "properties.provisioningState == \"Succeeded\"",
  "/api/health/live",
  "/api/health/ready",
  "/api/healthz",
  "az containerapp hostname bind",
  "rollback_partial_binding",
  "dnsChanged:false",
  "legacyBindingsChanged:false",
]) requireLiteral(promotion, literal, `promotion literal ${literal}`);

if (/Ledgr-prod|cloudflare|dns_records|az\s+containerapp\s+(update|delete)/iu.test(promotion)) {
  fail("promotion may not mutate legacy apps, DNS, or application revisions");
}
if ((promotion.match(/az containerapp hostname bind/gu) ?? []).length !== 2 ||
  (promotion.match(/az containerapp hostname delete/gu) ?? []).length !== 2) {
  fail("promotion bind and rollback command counts are not exact");
}

console.log(`Production domain promotion verified: ${ROOT}`);
