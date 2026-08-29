#!/usr/bin/env node

/**
 * Resumable one-time Workforce OS production bootstrap controller.
 *
 * This is deliberately separate from deploy-prod.sh. It advances one bounded
 * phase per protected workflow invocation and stores its private state under a
 * fixed infinite Azure blob lease shared by bootstrap and both repositories'
 * subsequent production release controllers. Any error after control acquisition leaves
 * the lease and release lock in place. The only release path is B8 COMPLETE.
 */

import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  advanceLedger,
  azureAuthorityIdentityHash,
  canonicalJson,
  createLedger,
  holdLedger,
  sha256Bytes,
  strictJsonParse,
  verifyLedgerBytes,
} from "./production-bootstrap-phase-ledger.mjs";
import {
  buildFinalPhaseContext,
  FINAL_PHASE_RECEIPT_SPECS,
  PHASE_MIGRATIONS,
} from "./production-bootstrap-phase-receipt-contracts.mjs";
import {
  PRODUCTION_DATABASE_IDENTITY_QUERY,
  assertProductionDatabaseIdentityOutput,
  productionDatabaseIdentityAssertionSql,
} from "./production-bootstrap-database-identity.mjs";
import {
  POST_CLERK_CATALOG_CONTRACT_HASH,
  POST_CLERK_MIGRATION_CONTRACT,
  POST_CLERK_MIGRATION_CONTRACT_HASH,
  POST_CLERK_MIGRATIONS,
  REPLY_REPAIR_INDEXES,
  planPostClerkMigrationCatalog,
} from "./verify-production-post-clerk-migration-catalog.mjs";
import {
  PRODUCTION_AUTHORITY_DRAIN_CONTRACT,
  PRODUCTION_AZURE_AUTHORITY_CONTRACT,
  evaluateProductionAuthorityDrainCheckpoint,
} from "./production-azure-mutation-authority-audit.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = realpathSync(resolve(dirname(SCRIPT_PATH), ".."));
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const COMMAND_MAX_BYTES = 8 * 1024 * 1024;
const ENVIRONMENT = "production";
const STATE_KIND = "initial-production-bootstrap-controller-state";
const PREPARATION_JOURNAL_KIND = "initial-production-bootstrap-preparation-journal";
const REQUEST_KIND = "initial-production-bootstrap-request";
const CONTEXT_KIND = "initial-bootstrap-admission-context";
const CONTROLLER_ID = "workforce-production-bootstrap-controller-v1";
const RELEASE_REPOSITORY = "Kloudedge-apex/apex-product";
const RELEASE_REPOSITORY_URL = "https://github.com/Kloudedge-apex/apex-product.git";
const RELEASE_LOCK_REF = "refs/heads/workforce-os-release-lock/production-gtm-platform";
const API_APP = "apex-gtm-api";
const WORKER_APP = "apex-gtm-worker";
const CONSOLE_APP = "nikxius-web";
const QUIESCENCE_DISABLED_WORKERS = Object.freeze([
  "GMAIL_WATCH_RENEWAL_ENABLED=false",
  "GRAPH_RUN_WORKER_ENABLED=false",
  "OUTREACH_WORKER_ENABLED=false",
  "SCHEDULER_ENABLED=false",
  "USAGE_ROLLUP_WORKER_ENABLED=false",
]);
const FIRST_CLASS_WORKER_ENVIRONMENT = Object.freeze([
  "GMAIL_WATCH_RENEWAL_ENABLED=true",
  "GRAPH_RUN_WORKER_ENABLED=true",
  "OUTREACH_WORKER_ENABLED=true",
  "SCHEDULER_ENABLED=false",
]);
const RETIRED_WORKER_ENVIRONMENT = Object.freeze([
  "WORKER_ENABLED",
  "OUTREACH_DELIVERY_UNKNOWN_STATUS_WRITES_ENABLED",
  "OUTREACH_DELIVERY_UNKNOWN_STATUS_WRITES_ACK",
]);
const WORKER_QUIESCENCE_COMMAND = Object.freeze(["node"]);
const WORKER_QUIESCENCE_ARGS = Object.freeze([
  "-e",
  "require('node:http').createServer((_request, response) => { response.writeHead(200); response.end('ok'); }).listen(4000, '0.0.0.0')",
]);
const CONSOLE_API_UPSTREAM_URL =
  "https://apex-gtm-api.braveflower-6d3bb66b.eastus.azurecontainerapps.io";
const LEGACY_SOURCE_IMAGE_REVISIONS = Object.freeze({
  "workforceosprodacr.azurecr.io/apex-api@sha256:111a470e65a22d27039d0d130d7d0c7aa33e7a23e0d8ce8fe7183c685dbf6f25":
    "324f831f31ca903f851b3e697ee94cc25af04217",
});
const RESOURCE_GROUP = "workforce-os-prod";
const REGISTRY = "workforceosprodacr";
const CLERK_EXECUTOR_PATH = "scripts/production-clerk-reconciliation-executor.mjs";
const POST_CLERK_CATALOG_VERIFIER_PATH =
  "scripts/verify-production-post-clerk-migration-catalog.mjs";
const DATABASE_IDENTITY_HELPER_PATH =
  "scripts/production-bootstrap-database-identity.mjs";
const MUTATION_AUTHORITY_HELPER_PATH =
  "scripts/production-bootstrap-mutation-authority.mjs";

export const ACTIONS = Object.freeze([
  "audit",
  "prepare",
  "invoke-clerk",
  "apply-schema",
  "deploy-compatible",
  "activate-first-class",
  "resume",
  "complete",
  "hold",
  "renew-hold",
]);

export const MIGRATIONS = Object.freeze([
  "docs/migrations/2026-08-13_clerk-identity-lifecycle-expand.sql",
  "docs/migrations/2026-06-01_outreach-artifact-unique.sql",
  "docs/migrations/2026-08-12_conversation-store-expand.sql",
  "docs/migrations/2026-08-12_outreach-delivery-unknown-expand.sql",
  "docs/migrations/2026-08-13_outreach-artifact-failed-expand.sql",
  "docs/migrations/2026-08-12_conversation-reply-single-flight-expand.sql",
  "docs/migrations/2026-08-12_graph-run-activity-expand.sql",
  "docs/migrations/2026-08-12_graph-run-lifecycle-expand.sql",
  "docs/migrations/2026-08-20_icp-exclusion-domains-expand.sql",
]);


// Final phase contracts are supplied by the dedicated receipt module. The
// controller intentionally names their public verifier only, never provisional
// receipt fields.
const REQUIRED_HELPERS = Object.freeze([
  "scripts/production-bootstrap-phase-ledger.mjs",
  "scripts/production-bootstrap-phase-receipt-contracts.mjs",
  "scripts/production-bootstrap-runtime-control.ts",
  "scripts/production-azure-mutation-authority-audit.mjs",
  DATABASE_IDENTITY_HELPER_PATH,
  MUTATION_AUTHORITY_HELPER_PATH,
  CLERK_EXECUTOR_PATH,
  POST_CLERK_CATALOG_VERIFIER_PATH,
  "scripts/verify-production-bootstrap-entry-receipt.sh",
  "scripts/verify-production-bootstrap-phase-receipt.sh",
  "scripts/verify-registry-api-image.sh",
  "scripts/verify-containerapp-release-config.sh",
  "docs/ops/production-migration-allowed-signers.sha256",
]);

const REQUEST_KEYS = Object.freeze([
  "schemaVersion",
  "environment",
  "kind",
  "attemptId",
  "backendCandidate",
  "consoleCandidate",
  "authority",
  "storage",
  "targetArtifacts",
  "bootstrapEvidence",
  "databaseIdentityHash",
  "redisIdentityHash",
  "operator",
  "approver",
  "changeTicket",
  "activationWorkerRevision",
]);

const CANDIDATE_KEYS = Object.freeze(["repository", "branch", "commit"]);
const AUTHORITY_KEYS = Object.freeze([
  "subscriptionId",
  "resourceGroupName",
  "resourceGroupResourceId",
  "apiContainerAppResourceId",
  "workerContainerAppResourceId",
  "consoleContainerAppResourceId",
]);
const STORAGE_KEYS = Object.freeze([
  "accountName",
  "containerName",
  "blobName",
  "resourceId",
]);
const TARGET_KEYS = Object.freeze(["api", "worker", "console"]);
const BOOTSTRAP_EVIDENCE_KEYS = Object.freeze([
  "stagingRehearsalEvidenceHash",
  "backupRestoreEvidenceHash",
  "failedListSmokeEvidenceHash",
  "dashboardPolicySmokeEvidenceHash",
  "azureMutationAuthorityEvidenceHash",
  "azureMutationAuthorityStructuralEvidenceHash",
  "databaseDdlAuthorityEvidenceHash",
  "outstandingDeliveryReviewEvidenceHash",
  "providerDeliveryDrainEvidenceHash",
]);
const DATABASE_DDL_AUTHORITY_KEYS = Object.freeze([
  "schemaVersion",
  "environment",
  "kind",
  "bootstrapAttemptId",
  "backendCandidateCommit",
  "databaseIdentityHash",
  "reviewer",
  "reviewedAt",
  "expiresAt",
  "authorityScope",
  "exclusiveDdlAuthorityConfirmed",
]);
const OPERATIONAL_SMOKE_EVIDENCE_KEYS = Object.freeze([
  "schemaVersion",
  "environment",
  "kind",
  "bootstrapAttemptId",
  "backendCandidateCommit",
  "consoleCandidateCommit",
  "reviewer",
  "reviewedAt",
  "expiresAt",
  "scope",
  "passed",
]);
const OUTSTANDING_DELIVERY_REVIEW_KEYS = Object.freeze([
  "schemaVersion",
  "environment",
  "kind",
  "bootstrapAttemptId",
  "backendCandidateCommit",
  "reviewer",
  "reviewedAt",
  "expiresAt",
  "outstandingDeliveryCount",
  "unresolvedDeliveryCount",
  "disposition",
]);
const PROVIDER_DELIVERY_DRAIN_KEYS = Object.freeze([
  "schemaVersion",
  "environment",
  "kind",
  "bootstrapAttemptId",
  "backendCandidateCommit",
  "reviewer",
  "reviewedAt",
  "expiresAt",
  "providerScope",
  "inFlightDeliveryCount",
  "drainConfirmed",
]);
const BACKEND_ARTIFACT_KEYS = Object.freeze([
  "image",
  "manifestDigest",
  "platformDigest",
  "ociRevision",
  "platform",
  "plannedRevision",
  "buildRunId",
  "buildEvidenceHash",
  "rehearsalEvidenceHash",
]);
const CONSOLE_ARTIFACT_KEYS = Object.freeze([
  ...BACKEND_ARTIFACT_KEYS,
  "clientConfigEvidenceHash",
  "smokeEvidenceHash",
]);

const STATE_KEYS = Object.freeze([
  "schemaVersion",
  "environment",
  "kind",
  "attemptId",
  "requestSha256",
  "azureLeaseTokenHash",
  "leaseIdHash",
  "fencingGeneration",
  "writerFenceGeneration",
  "phaseLedgerBase64",
  "phaseLedgerSha256",
  "sourceRollbackBaseline",
  "privateRestoreBundle",
  "admissionContextBase64",
  "admissionContextSha256",
  "clerkReconciliationPlanBase64",
  "clerkReconciliationPlanSignatureBase64",
  "clerkReconciliationDryRunBase64",
  "clerkReconciliationDryRunSignatureBase64",
  "clerkReconciliationPlanBinding",
  "migrationProgress",
  "phaseEvidence",
  "activeIdentities",
  "updatedAt",
]);

const PREPARATION_JOURNAL_KEYS = Object.freeze([
  "schemaVersion", "environment", "kind", "attemptId", "requestSha256",
  "azureLeaseTokenHash", "leaseIdHash", "stage", "intent",
  "clerkReconciliationPlanBase64", "clerkReconciliationPlanSignatureBase64",
  "clerkReconciliationDryRunBase64", "clerkReconciliationPlanBinding",
  "clerkReconciliationDryRunSignatureBase64",
  "source", "updatedAt",
]);

function fail(message) {
  throw new Error(message);
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} has unexpected or missing fields`);
  }
}

function string(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) fail(`${label} is invalid`);
  return value;
}

function safeInteger(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) fail(`${label} is invalid`);
  return value;
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonicalHash(value) {
  return sha256(Buffer.from(canonicalJson(value), "utf8"));
}

function nowSecond() {
  return new Date(Math.floor(Date.now() / 1000) * 1000).toISOString().replace(".000Z", "Z");
}

export function attemptLeaseId(attemptId) {
  string(attemptId, /^[0-9a-f]{32}$/, "attemptId");
  return [
    attemptId.slice(0, 8),
    attemptId.slice(8, 12),
    attemptId.slice(12, 16),
    attemptId.slice(16, 20),
    attemptId.slice(20),
  ].join("-");
}

function assertAbsoluteResourceId(value, suffix, label) {
  string(value, /^\/subscriptions\/[0-9a-f-]{36}\/resourceGroups\/[A-Za-z0-9._()-]+(?:\/providers\/[A-Za-z0-9.]+\/[A-Za-z0-9._()/-]+)?$/i, label);
  if (!value.toLowerCase().endsWith(suffix.toLowerCase())) fail(`${label} targets an unexpected resource`);
}

function validateCandidate(candidate, expectedRepository, label) {
  exactKeys(candidate, CANDIDATE_KEYS, label);
  if (candidate.repository !== expectedRepository) fail(`${label}.repository is invalid`);
  const requiredBranch = label.startsWith("backend") ? "master" : "main";
  if (candidate.branch !== requiredBranch) {
    fail(`${label}.branch must be the exact protected default branch ${requiredBranch}`);
  }
  string(candidate.commit, /^[0-9a-f]{40}$/, `${label}.commit`);
}

function validateArtifact(artifact, role, expectedCommit) {
  exactKeys(
    artifact,
    role === "console" ? CONSOLE_ARTIFACT_KEYS : BACKEND_ARTIFACT_KEYS,
    `targetArtifacts.${role}`,
  );
  const imagePattern = role === "console"
    ? /^workforceosprodacr\.azurecr\.io\/workforceos-fe@sha256:[0-9a-f]{64}$/
    : /^workforceosprodacr\.azurecr\.io\/apex-api@sha256:[0-9a-f]{64}$/;
  string(artifact.image, imagePattern, `targetArtifacts.${role}.image`);
  for (const key of ["manifestDigest", "platformDigest", "buildEvidenceHash", "rehearsalEvidenceHash"]) {
    string(artifact[key], /^sha256:[0-9a-f]{64}$/, `targetArtifacts.${role}.${key}`);
  }
  if (role === "console") {
    string(artifact.clientConfigEvidenceHash, /^sha256:[0-9a-f]{64}$/, "targetArtifacts.console.clientConfigEvidenceHash");
    string(artifact.smokeEvidenceHash, /^sha256:[0-9a-f]{64}$/, "targetArtifacts.console.smokeEvidenceHash");
  }
  if (artifact.image.split("@")[1] !== artifact.manifestDigest) {
    fail(`targetArtifacts.${role} image and manifest digest differ`);
  }
  if (artifact.ociRevision !== expectedCommit || artifact.platform !== "linux/amd64") {
    fail(`targetArtifacts.${role} source or platform identity differs`);
  }
  const revisionPattern = role === "api"
    ? /^apex-gtm-api--[a-z0-9][a-z0-9-]{0,62}$/
    : role === "worker"
      ? /^apex-gtm-worker--[a-z0-9][a-z0-9-]{0,62}$/
      : /^nikxius-web--[a-z0-9][a-z0-9-]{0,62}$/;
  string(artifact.plannedRevision, revisionPattern, `targetArtifacts.${role}.plannedRevision`);
  string(artifact.buildRunId, /^[1-9][0-9]{0,19}$/, `targetArtifacts.${role}.buildRunId`);
}

export function validateRequest(value) {
  exactKeys(value, REQUEST_KEYS, "request");
  if (value.schemaVersion !== 1 || value.environment !== ENVIRONMENT || value.kind !== REQUEST_KIND) {
    fail("request contract identity is invalid");
  }
  string(value.attemptId, /^[0-9a-f]{32}$/, "request.attemptId");
  validateCandidate(value.backendCandidate, RELEASE_REPOSITORY, "backendCandidate");
  validateCandidate(value.consoleCandidate, "Kloudedge-apex/Workforce-OS", "consoleCandidate");
  exactKeys(value.authority, AUTHORITY_KEYS, "request.authority");
  string(value.authority.subscriptionId, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, "request.authority.subscriptionId");
  if (value.authority.subscriptionId.toLowerCase() !==
    PRODUCTION_AZURE_AUTHORITY_CONTRACT.subscriptionId) {
    fail("request subscription is not the fixed production authority subscription");
  }
  if (value.authority.resourceGroupName !== RESOURCE_GROUP) fail("request resource group is invalid");
  const rgSuffix = `/resourceGroups/${RESOURCE_GROUP}`;
  assertAbsoluteResourceId(value.authority.resourceGroupResourceId, rgSuffix, "request.authority.resourceGroupResourceId");
  assertAbsoluteResourceId(value.authority.apiContainerAppResourceId, `/providers/Microsoft.App/containerApps/${API_APP}`, "request.authority.apiContainerAppResourceId");
  assertAbsoluteResourceId(value.authority.workerContainerAppResourceId, `/providers/Microsoft.App/containerApps/${WORKER_APP}`, "request.authority.workerContainerAppResourceId");
  assertAbsoluteResourceId(value.authority.consoleContainerAppResourceId, `/providers/Microsoft.App/containerApps/${CONSOLE_APP}`, "request.authority.consoleContainerAppResourceId");
  for (const resourceId of [
    value.authority.resourceGroupResourceId,
    value.authority.apiContainerAppResourceId,
    value.authority.workerContainerAppResourceId,
    value.authority.consoleContainerAppResourceId,
  ]) {
    if (!resourceId.toLowerCase().startsWith(`/subscriptions/${value.authority.subscriptionId.toLowerCase()}/resourcegroups/${RESOURCE_GROUP.toLowerCase()}`)) {
      fail("request Azure resources do not share the admitted subscription and resource group");
    }
  }
  const expectedAuthorityResources = {
    resourceGroupResourceId: PRODUCTION_AZURE_AUTHORITY_CONTRACT.resourceGroupId,
    apiContainerAppResourceId: PRODUCTION_AZURE_AUTHORITY_CONTRACT.targets.api.resourceId,
    workerContainerAppResourceId: PRODUCTION_AZURE_AUTHORITY_CONTRACT.targets.worker.resourceId,
    consoleContainerAppResourceId: PRODUCTION_AZURE_AUTHORITY_CONTRACT.targets.console.resourceId,
  };
  for (const [key, expected] of Object.entries(expectedAuthorityResources)) {
    if (value.authority[key].toLowerCase() !== expected.toLowerCase()) {
      fail(`request authority ${key} is not the fixed production resource`);
    }
  }
  exactKeys(value.storage, STORAGE_KEYS, "request.storage");
  string(value.storage.accountName, /^[a-z0-9]{3,24}$/, "request.storage.accountName");
  string(value.storage.containerName, /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/, "request.storage.containerName");
  if (value.storage.blobName !== "workforce-os/initial-production-bootstrap/state-v1.json") {
    fail("request storage blob name is not the fixed reviewed name");
  }
  assertAbsoluteResourceId(value.storage.resourceId, `/providers/Microsoft.Storage/storageAccounts/${value.storage.accountName}`, "request.storage.resourceId");
  if (!value.storage.resourceId.toLowerCase().startsWith(`/subscriptions/${value.authority.subscriptionId.toLowerCase()}/resourcegroups/`)) {
    fail("request storage account is outside the admitted subscription");
  }
  if (value.storage.accountName !== "workforceosprodctrl" ||
    value.storage.containerName !== PRODUCTION_AUTHORITY_DRAIN_CONTRACT.containerName ||
    value.storage.resourceId.toLowerCase() !==
      PRODUCTION_AZURE_AUTHORITY_CONTRACT.targets.stateStorage.storageAccountResourceId.toLowerCase()) {
    fail("request storage identity is not the fixed production control store");
  }
  exactKeys(value.targetArtifacts, TARGET_KEYS, "request.targetArtifacts");
  validateArtifact(value.targetArtifacts.api, "api", value.backendCandidate.commit);
  validateArtifact(value.targetArtifacts.worker, "worker", value.backendCandidate.commit);
  validateArtifact(value.targetArtifacts.console, "console", value.consoleCandidate.commit);
  for (const key of [
    "image", "manifestDigest", "platformDigest", "ociRevision", "platform",
    "buildRunId", "buildEvidenceHash", "rehearsalEvidenceHash",
  ]) {
    if (value.targetArtifacts.api[key] !== value.targetArtifacts.worker[key]) {
      fail(`targetArtifacts API and worker differ on ${key}`);
    }
  }
  exactKeys(value.bootstrapEvidence, BOOTSTRAP_EVIDENCE_KEYS, "request.bootstrapEvidence");
  for (const key of BOOTSTRAP_EVIDENCE_KEYS) {
    string(value.bootstrapEvidence[key], /^sha256:[0-9a-f]{64}$/, `request.bootstrapEvidence.${key}`);
  }
  for (const key of ["databaseIdentityHash", "redisIdentityHash"]) {
    string(value[key], /^sha256:[0-9a-f]{64}$/, `request.${key}`);
  }
  string(value.operator, /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}$/, "request.operator");
  string(value.approver, /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}$/, "request.approver");
  if (value.operator === value.approver) fail("request operator and approver must differ");
  string(value.changeTicket, /^.{1,256}$/s, "request.changeTicket");
  string(value.activationWorkerRevision, /^apex-gtm-worker--[a-z0-9][a-z0-9-]{0,62}$/, "request.activationWorkerRevision");
  if (value.activationWorkerRevision === value.targetArtifacts.worker.plannedRevision) {
    fail("activation worker revision must differ from disabled baseline revision");
  }
  return value;
}

function readBoundedJson(path, label) {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size < 2 || metadata.size > MAX_JSON_BYTES) {
    fail(`${label} must be a bounded regular non-symlink single-link file`);
  }
  return strictJsonParse(readFileSync(path), label);
}

function readBoundedEvidence(path, label) {
  validateExternalPath(path, label);
  const metadata = lstatSync(path);
  if (metadata.nlink !== 1 || metadata.size < 2 || metadata.size > MAX_JSON_BYTES) {
    fail(`${label} must be a bounded single-link file`);
  }
  return readFileSync(path);
}

function validateReviewWindow(value, label) {
  const reviewedMillis = canonicalTimestamp(value.reviewedAt, `${label} reviewedAt`);
  const expiresMillis = canonicalTimestamp(value.expiresAt, `${label} expiresAt`);
  const now = Date.now();
  if (reviewedMillis > now + 5 * 60 * 1_000 || expiresMillis <= now ||
    expiresMillis <= reviewedMillis || expiresMillis - reviewedMillis > 24 * 60 * 60 * 1_000) {
    fail(`${label} freshness window is invalid`);
  }
}

export function verifyDeliverySafetyEvidence(request, paths) {
  const outstandingBytes = readBoundedEvidence(
    paths.outstandingDeliveryReview,
    "outstanding delivery review evidence",
  );
  const providerBytes = readBoundedEvidence(
    paths.providerDeliveryDrain,
    "provider delivery drain evidence",
  );
  const outstandingHash = sha256(outstandingBytes);
  const providerHash = sha256(providerBytes);
  if (outstandingHash !== request.bootstrapEvidence.outstandingDeliveryReviewEvidenceHash ||
    providerHash !== request.bootstrapEvidence.providerDeliveryDrainEvidenceHash) {
    fail("protected delivery-safety evidence bytes do not match the admitted request hashes");
  }
  const outstanding = strictJsonParse(outstandingBytes, "outstanding delivery review evidence");
  const provider = strictJsonParse(providerBytes, "provider delivery drain evidence");
  exactKeys(outstanding, OUTSTANDING_DELIVERY_REVIEW_KEYS, "outstanding delivery review evidence");
  exactKeys(provider, PROVIDER_DELIVERY_DRAIN_KEYS, "provider delivery drain evidence");
  for (const [value, kind, label] of [
    [outstanding, "production-outstanding-delivery-review", "outstanding delivery review evidence"],
    [provider, "production-provider-delivery-drain", "provider delivery drain evidence"],
  ]) {
    if (value.schemaVersion !== 1 || value.environment !== ENVIRONMENT || value.kind !== kind ||
      value.bootstrapAttemptId !== request.attemptId ||
      value.backendCandidateCommit !== request.backendCandidate.commit ||
      value.reviewer !== request.approver) {
      fail(`${label} is not bound to the exact production attempt, candidate, and approver`);
    }
    string(value.reviewer, /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}$/, `${label} reviewer`);
    validateReviewWindow(value, label);
  }
  safeInteger(outstanding.outstandingDeliveryCount, "outstanding delivery count", 0);
  safeInteger(outstanding.unresolvedDeliveryCount, "unresolved delivery count", 0);
  if (outstanding.outstandingDeliveryCount !== 0 ||
    outstanding.unresolvedDeliveryCount !== 0 ||
    outstanding.disposition !== "no-outstanding-deliveries") {
    fail("outstanding delivery review does not prove an empty delivery inventory");
  }
  if (provider.providerScope !== "all-configured-outbound-providers" ||
    provider.drainConfirmed !== true) {
    fail("provider delivery evidence does not prove a complete provider drain");
  }
  safeInteger(provider.inFlightDeliveryCount, "provider in-flight delivery count", 0);
  if (provider.inFlightDeliveryCount !== 0) {
    fail("provider delivery evidence reports in-flight deliveries");
  }
  return {
    outstandingDeliveryReview: {
      evidenceHash: outstandingHash,
      reviewer: outstanding.reviewer,
      reviewedAt: outstanding.reviewedAt,
      expiresAt: outstanding.expiresAt,
      outstandingDeliveryCount: 0,
      unresolvedDeliveryCount: 0,
      disposition: outstanding.disposition,
    },
    providerDeliveryDrain: {
      evidenceHash: providerHash,
      reviewer: provider.reviewer,
      reviewedAt: provider.reviewedAt,
      expiresAt: provider.expiresAt,
      providerScope: provider.providerScope,
      inFlightDeliveryCount: 0,
      drainConfirmed: true,
    },
    verifiedFromProtectedBytes: true,
  };
}

export function verifyDatabaseDdlAuthorityEvidence(request, path) {
  const bytes = readBoundedEvidence(path, "database DDL authority evidence");
  const evidenceHash = sha256(bytes);
  if (evidenceHash !== request.bootstrapEvidence.databaseDdlAuthorityEvidenceHash) {
    fail("protected database DDL authority bytes do not match the admitted request hash");
  }
  const value = strictJsonParse(bytes, "database DDL authority evidence");
  exactKeys(value, DATABASE_DDL_AUTHORITY_KEYS, "database DDL authority evidence");
  if (value.schemaVersion !== 1 || value.environment !== ENVIRONMENT ||
    value.kind !== "production-database-ddl-exclusive-authority" ||
    value.bootstrapAttemptId !== request.attemptId ||
    value.backendCandidateCommit !== request.backendCandidate.commit ||
    value.databaseIdentityHash !== request.databaseIdentityHash ||
    value.reviewer !== request.approver ||
    value.authorityScope !== "all-production-database-ddl-actors" ||
    value.exclusiveDdlAuthorityConfirmed !== true) {
    fail("database DDL authority evidence is not bound to the exact reviewed production window");
  }
  string(value.reviewer, /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}$/,
    "database DDL authority reviewer");
  validateReviewWindow(value, "database DDL authority evidence");
  return {
    schemaVersion: 1,
    environment: ENVIRONMENT,
    kind: value.kind,
    bootstrapAttemptId: value.bootstrapAttemptId,
    backendCandidateCommit: value.backendCandidateCommit,
    evidenceHash,
    reviewer: value.reviewer,
    reviewedAt: value.reviewedAt,
    expiresAt: value.expiresAt,
    databaseIdentityHash: value.databaseIdentityHash,
    authorityScope: value.authorityScope,
    exclusiveDdlAuthorityConfirmed: true,
    verifiedFromProtectedBytes: true,
  };
}

export function verifyOperationalSmokeEvidence(request, paths) {
  const definitions = [
    {
      path: paths.failedListSmokeEvidence,
      label: "failed-list smoke evidence",
      kind: "production-failed-list-smoke",
      scope: "api-failed-outreach-list",
      expectedHash: request.bootstrapEvidence.failedListSmokeEvidenceHash,
      key: "failedList",
    },
    {
      path: paths.dashboardPolicySmokeEvidence,
      label: "dashboard-policy smoke evidence",
      kind: "production-dashboard-policy-smoke",
      scope: "console-dashboard-policy",
      expectedHash: request.bootstrapEvidence.dashboardPolicySmokeEvidenceHash,
      key: "dashboardPolicy",
    },
  ];
  const result = {};
  for (const definition of definitions) {
    const bytes = readBoundedEvidence(definition.path, definition.label);
    const evidenceHash = sha256(bytes);
    if (evidenceHash !== definition.expectedHash) {
      fail(`protected ${definition.label} bytes do not match the admitted request hash`);
    }
    const value = strictJsonParse(bytes, definition.label);
    exactKeys(value, OPERATIONAL_SMOKE_EVIDENCE_KEYS, definition.label);
    if (value.schemaVersion !== 1 || value.environment !== ENVIRONMENT ||
      value.kind !== definition.kind || value.bootstrapAttemptId !== request.attemptId ||
      value.backendCandidateCommit !== request.backendCandidate.commit ||
      value.consoleCandidateCommit !== request.consoleCandidate.commit ||
      value.reviewer !== request.approver || value.scope !== definition.scope ||
      value.passed !== true) {
      fail(`${definition.label} is not bound to the exact reviewed production candidates`);
    }
    string(value.reviewer, /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}$/,
      `${definition.label} reviewer`);
    validateReviewWindow(value, definition.label);
    result[definition.key] = {
      schemaVersion: 1,
      environment: ENVIRONMENT,
      kind: value.kind,
      bootstrapAttemptId: value.bootstrapAttemptId,
      backendCandidateCommit: value.backendCandidateCommit,
      consoleCandidateCommit: value.consoleCandidateCommit,
      evidenceHash,
      reviewer: value.reviewer,
      reviewedAt: value.reviewedAt,
      expiresAt: value.expiresAt,
      scope: value.scope,
      passed: true,
    };
  }
  return { ...result, verifiedFromProtectedBytes: true };
}

function inside(parent, candidate) {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function validateExternalPath(path, label, { mustExist = true, directory = false } = {}) {
  if (!isAbsolute(path)) fail(`${label} must be absolute`);
  const parent = realpathSync(mustExist ? path : dirname(path));
  const target = mustExist ? parent : resolve(parent, path.split("/").at(-1));
  if (inside(REPO_ROOT, target)) fail(`${label} must be outside the repository`);
  if (mustExist) {
    const metadata = lstatSync(target);
    if (metadata.isSymbolicLink() || (directory ? !metadata.isDirectory() : !metadata.isFile())) {
      fail(`${label} has an unsafe type`);
    }
  } else if (existsSync(target)) {
    fail(`${label} already exists`);
  }
  return target;
}

function requireSnapshotFile(relativePath, executable = false) {
  if (!/^[A-Za-z0-9._/-]+$/.test(relativePath) || relativePath.includes("..") || relativePath.startsWith("/")) {
    fail(`invalid trusted helper path ${relativePath}`);
  }
  const components = relativePath.split("/");
  let current = REPO_ROOT;
  for (let index = 0; index < components.length; index += 1) {
    current = join(current, components[index]);
    const metadata = lstatSync(current);
    if (metadata.isSymbolicLink() || (index < components.length - 1 ? !metadata.isDirectory() : !metadata.isFile())) {
      fail(`trusted helper has an unsafe path component: ${relativePath}`);
    }
  }
  if (executable && (statSync(current).mode & 0o111) === 0) fail(`trusted helper is not executable: ${relativePath}`);
  return current;
}

function sanitizeError(value) {
  return String(value)
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
    .replace(/((?:password|token|secret|key)=)[^\s&]+/gi, "$1[redacted]")
    .slice(0, 2000);
}

export class CommandRunner {
  run(command, args, options = {}) {
    if (typeof command !== "string" || !Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
      fail("invalid command invocation");
    }
    const result = spawnSync(command, args, {
      cwd: options.cwd ?? REPO_ROOT,
      env: options.env ?? process.env,
      input: options.input,
      encoding: null,
      maxBuffer: COMMAND_MAX_BYTES,
      timeout: options.timeoutMs,
      killSignal: "SIGTERM",
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    if (result.error) fail(`${options.label ?? command} could not start`);
    const status = result.status ?? 1;
    if (status !== 0 && !options.allowFailure) {
      const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8") : "";
      fail(`${options.label ?? command} failed: ${sanitizeError(stderr)}`);
    }
    return {
      status,
      stdout: Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.alloc(0),
      stderr: Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.alloc(0),
    };
  }

  json(command, args, options = {}) {
    const result = this.run(command, args, options);
    return strictJsonParse(result.stdout, options.label ?? command);
  }
}

function azArgs(request, tail) {
  return [
    ...tail,
    "--subscription",
    request.authority.subscriptionId,
    "--only-show-errors",
  ];
}

export function azureInheritedRoleAssignmentListArgs(request, scope) {
  return azArgs(request, [
    "role", "assignment", "list",
    "--scope", scope,
    "--include-inherited",
    "--output", "json",
  ]);
}

export function azureControlContainerRoleAssignmentScope(request) {
  return `${request.storage.resourceId}/blobServices/default/containers/${request.storage.containerName}`;
}

function blobLeaseArgs(request) {
  return [
    "--account-name", request.storage.accountName,
    "--container-name", request.storage.containerName,
    "--blob-name", request.storage.blobName,
    "--auth-mode", "login",
  ];
}

function blobDataArgs(request) {
  return [
    "--account-name", request.storage.accountName,
    "--container-name", request.storage.containerName,
    "--name", request.storage.blobName,
    "--auth-mode", "login",
  ];
}

function leaseIdHash(request) {
  return sha256(Buffer.from(`azure-blob-lease-id-v1\0${attemptLeaseId(request.attemptId)}`, "utf8"));
}

function leaseTokenHash(request) {
  return sha256(Buffer.from(
    `azure-blob-lease-token-v1\0${attemptLeaseId(request.attemptId)}\0${request.storage.resourceId}\0${request.storage.containerName}\0${request.storage.blobName}`,
    "utf8",
  ));
}

export function parseAzureLeaseCommandOutput(bytes, label = "Azure blob lease response") {
  const value = strictJsonParse(bytes, label);
  const leaseId = typeof value === "string"
    ? value
    : value && typeof value === "object" && !Array.isArray(value)
      ? value.leaseId ?? value.lease_id
      : undefined;
  string(leaseId, /^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/, label);
  return leaseId.toLowerCase();
}

function acquireAzureLease(runner, request) {
  const result = runner.run("az", azArgs(request, [
    "storage", "blob", "lease", "acquire",
    ...blobLeaseArgs(request),
    "--lease-duration", "-1",
    "--proposed-lease-id", attemptLeaseId(request.attemptId),
    "--output", "json",
  ]), { label: "Azure bootstrap lease acquisition", allowFailure: true });
  if (result.status === 0) {
    if (parseAzureLeaseCommandOutput(result.stdout) !== attemptLeaseId(request.attemptId)) {
      fail("Azure bootstrap lease did not return the proposed attempt identity");
    }
    return { adopted: false };
  }
  // Acquisition may have succeeded while its response was lost, or a prior
  // exact-attempt invocation may already own the infinite lease. Renewal with
  // the deterministic attempt UUID proves ownership without breaking it.
  verifyAzureLease(runner, request);
  return { adopted: true, acknowledgementUncertain: true };
}

function verifyAzureLease(runner, request) {
  const result = runner.run("az", azArgs(request, [
    "storage", "blob", "lease", "renew",
    ...blobLeaseArgs(request),
    "--lease-id", attemptLeaseId(request.attemptId),
    "--output", "json",
  ]), { label: "Azure bootstrap lease readback" });
  if (parseAzureLeaseCommandOutput(result.stdout) !== attemptLeaseId(request.attemptId)) {
    fail("Azure bootstrap lease is absent or owned by another attempt");
  }
}

function downloadState(runner, request, localPath) {
  runner.run("az", azArgs(request, [
    "storage", "blob", "download",
    ...blobDataArgs(request),
    "--lease-id", attemptLeaseId(request.attemptId),
    "--file", localPath,
    "--overwrite", "true",
    "--output", "none",
  ]), { label: "bootstrap state download" });
  chmodSync(localPath, 0o600);
  return readBoundedJson(localPath, "bootstrap controller state");
}

function downloadStateWithoutLease(runner, request, localPath) {
  runner.run("az", azArgs(request, [
    "storage", "blob", "download",
    ...blobDataArgs(request),
    "--file", localPath,
    "--overwrite", "true",
    "--output", "none",
  ]), { label: "completed bootstrap state download" });
  chmodSync(localPath, 0o600);
  return readBoundedJson(localPath, "completed bootstrap controller state");
}

function inspectAzureLease(runner, request) {
  const lease = runner.json("az", azArgs(request, [
    "storage", "blob", "show",
    ...blobDataArgs(request),
    "--query", "properties.lease",
    "--output", "json",
  ]), { label: "Azure bootstrap lease status inspection" });
  const status = lease?.status;
  const state = lease?.state;
  if (status === "locked") {
    if (state !== "leased") fail("Azure bootstrap blob has an ambiguous locked lease state");
    verifyAzureLease(runner, request);
    return { owned: true, released: false };
  }
  if (status === "unlocked" && new Set(["available", "expired", "broken"]).has(state)) {
    return { owned: false, released: true };
  }
  fail("Azure bootstrap blob lease status is ambiguous");
}

function downloadLeasedDocumentMaybe(runner, request, localPath) {
  runner.run("az", azArgs(request, [
    "storage", "blob", "download",
    ...blobDataArgs(request),
    "--lease-id", attemptLeaseId(request.attemptId),
    "--file", localPath,
    "--overwrite", "true",
    "--output", "none",
  ]), { label: "bootstrap leased journal download" });
  chmodSync(localPath, 0o600);
  const metadata = lstatSync(localPath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 ||
    metadata.size > MAX_JSON_BYTES) {
    fail("bootstrap leased document has an unsafe type or size");
  }
  if (metadata.size === 0) return null;
  return strictJsonParse(readFileSync(localPath), "bootstrap leased document");
}

function uploadState(runner, request, state, localPath) {
  const bytes = Buffer.from(`${canonicalJson(state)}\n`, "utf8");
  if (bytes.length > MAX_JSON_BYTES) fail("bootstrap controller state exceeds its size bound");
  writeFileSync(localPath, bytes, { mode: 0o600, flag: "w" });
  runner.run("az", azArgs(request, [
    "storage", "blob", "upload",
    ...blobDataArgs(request),
    "--lease-id", attemptLeaseId(request.attemptId),
    "--file", localPath,
    "--overwrite", "true",
    "--content-type", "application/json",
    "--output", "none",
  ]), { label: "bootstrap state upload" });
  verifyAzureLease(runner, request);
}

function releaseAzureLease(runner, request) {
  runner.run("az", azArgs(request, [
    "storage", "blob", "lease", "release",
    ...blobLeaseArgs(request),
    "--lease-id", attemptLeaseId(request.attemptId),
    "--output", "none",
  ]), { label: "Azure bootstrap lease release" });
}

function validateState(state, request) {
  exactKeys(state, STATE_KEYS, "controller state");
  if (state.schemaVersion !== 1 || state.environment !== ENVIRONMENT || state.kind !== STATE_KIND || state.attemptId !== request.attemptId) {
    fail("controller state identity is invalid");
  }
  if (state.requestSha256 !== canonicalHash(request) || state.leaseIdHash !== leaseIdHash(request) || state.azureLeaseTokenHash !== leaseTokenHash(request)) {
    fail("controller state request or lease identity drift detected");
  }
  safeInteger(state.fencingGeneration, "state.fencingGeneration", 1);
  safeInteger(state.writerFenceGeneration, "state.writerFenceGeneration", 1);
  string(state.phaseLedgerBase64, /^[A-Za-z0-9+/]+={0,2}$/, "state.phaseLedgerBase64");
  string(state.phaseLedgerSha256, /^sha256:[0-9a-f]{64}$/, "state.phaseLedgerSha256");
  for (const key of [
    "clerkReconciliationPlanBase64",
    "clerkReconciliationPlanSignatureBase64",
    "clerkReconciliationDryRunBase64",
    "clerkReconciliationDryRunSignatureBase64",
  ]) {
    string(state[key], /^[A-Za-z0-9+/]+={0,2}$/, `state.${key}`);
  }
  if (!state.clerkReconciliationPlanBinding ||
    typeof state.clerkReconciliationPlanBinding !== "object" ||
    Array.isArray(state.clerkReconciliationPlanBinding)) {
    fail("controller state Clerk reconciliation binding is invalid");
  }
  const ledgerBytes = Buffer.from(state.phaseLedgerBase64, "base64");
  if (sha256Bytes(ledgerBytes) !== state.phaseLedgerSha256) fail("controller state ledger bytes are corrupt");
  let tombstoneBytes;
  if (state.phaseEvidence?.tombstoneBase64 !== undefined) {
    string(state.phaseEvidence.tombstoneBase64, /^[A-Za-z0-9+/]+={0,2}$/, "state tombstone bytes");
    tombstoneBytes = Buffer.from(state.phaseEvidence.tombstoneBase64, "base64");
  }
  const verified = verifyLedgerBytes(
    ledgerBytes,
    tombstoneBytes === undefined ? {} : { tombstoneBytes },
  );
  if (verified.ledger.identity.attemptId !== request.attemptId || verified.ledgerSha256 !== state.phaseLedgerSha256 || verified.ledger.fencingGeneration !== state.fencingGeneration) {
    fail("controller state and phase ledger disagree");
  }
  if (!Array.isArray(state.migrationProgress) || state.migrationProgress.some((path, index) => path !== MIGRATIONS[index])) {
    fail("controller state migration progress is not an ordered prefix");
  }
  if (!state.phaseEvidence || typeof state.phaseEvidence !== "object" || Array.isArray(state.phaseEvidence)) fail("controller state phaseEvidence is invalid");
  if (!state.activeIdentities || typeof state.activeIdentities !== "object" || Array.isArray(state.activeIdentities)) fail("controller state activeIdentities is invalid");
  string(state.updatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, "state.updatedAt");
  return { state, ledgerBytes, ledger: verified.ledger };
}

function validatePreparationJournal(journal, request) {
  exactKeys(journal, PREPARATION_JOURNAL_KEYS, "preparation journal");
  if (journal.schemaVersion !== 1 || journal.environment !== ENVIRONMENT ||
    journal.kind !== PREPARATION_JOURNAL_KIND || journal.attemptId !== request.attemptId ||
    journal.requestSha256 !== canonicalHash(request) ||
    journal.azureLeaseTokenHash !== leaseTokenHash(request) ||
    journal.leaseIdHash !== leaseIdHash(request)) {
    fail("preparation journal identity drift detected");
  }
  string(journal.stage, /^B0_[A-Z0-9_]+$/, "preparation journal stage");
  if (journal.intent !== null) {
    exactKeys(journal.intent, ["operation", "status", "at"], "preparation journal intent");
    string(journal.intent.operation, /^[a-z][a-z0-9-]{0,63}$/, "preparation intent operation");
    if (!new Set(["started", "completed"]).has(journal.intent.status)) fail("preparation intent status is invalid");
    canonicalTimestamp(journal.intent.at, "preparation intent time");
  }
  for (const key of [
    "clerkReconciliationPlanBase64", "clerkReconciliationPlanSignatureBase64",
    "clerkReconciliationDryRunBase64", "clerkReconciliationDryRunSignatureBase64",
  ]) string(journal[key], /^[A-Za-z0-9+/]+={0,2}$/, `preparation journal ${key}`);
  if (!journal.clerkReconciliationPlanBinding || typeof journal.clerkReconciliationPlanBinding !== "object" ||
    Array.isArray(journal.clerkReconciliationPlanBinding)) fail("preparation Clerk binding is invalid");
  if (journal.source !== null && (!journal.source || typeof journal.source !== "object" || Array.isArray(journal.source))) {
    fail("preparation source baseline is invalid");
  }
  canonicalTimestamp(journal.updatedAt, "preparation journal updatedAt");
  return journal;
}

function validateRebindablePreparationJournal(journal, request) {
  exactKeys(journal, PREPARATION_JOURNAL_KEYS, "superseded preparation journal");
  if (journal.schemaVersion !== 1 || journal.environment !== ENVIRONMENT ||
    journal.kind !== PREPARATION_JOURNAL_KIND || journal.attemptId !== request.attemptId ||
    journal.azureLeaseTokenHash !== leaseTokenHash(request) ||
    journal.leaseIdHash !== leaseIdHash(request) ||
    journal.requestSha256 === canonicalHash(request)) {
    fail("superseded preparation journal identity is not rebindable");
  }
  string(journal.requestSha256, /^sha256:[0-9a-f]{64}$/, "superseded preparation request hash");
  exactKeys(journal.intent, ["operation", "status", "at"], "superseded preparation intent");
  const sourceCaptureBoundary = journal.stage === "B0_SOURCE_CAPTURE_INTENT" &&
    journal.source === null && journal.intent.operation === "capture-source-baseline" &&
    journal.intent.status === "started";
  const ingressDisableBoundary = journal.stage === "B0_API_INGRESS_DISABLE_INTENT" &&
    journal.source !== null && journal.intent.operation === "disable-api-ingress" &&
    journal.intent.status === "started";
  const queuePauseBoundary = journal.stage === "B0_QUEUE_PAUSE_INTENT" &&
    journal.source !== null && journal.intent.operation === "pause-queues" &&
    journal.intent.status === "started";
  const appStopBoundary = journal.stage === "B0_APP_STOP_INTENT" &&
    journal.source !== null && journal.intent.operation === "stop-app-revisions" &&
    journal.intent.status === "started";
  const writerFenceArmedBoundary = journal.stage === "B0_WRITER_FENCE_ARMED" &&
    journal.source !== null && journal.intent.operation === "arm-writer-fence" &&
    journal.intent.status === "completed";
  if (!sourceCaptureBoundary && !ingressDisableBoundary && !queuePauseBoundary &&
    !appStopBoundary && !writerFenceArmedBoundary) {
    fail("superseded preparation journal advanced beyond a provably rebindable boundary");
  }
  canonicalTimestamp(journal.intent.at, "superseded preparation intent time");
  canonicalTimestamp(journal.updatedAt, "superseded preparation updatedAt");
  for (const key of [
    "clerkReconciliationPlanBase64", "clerkReconciliationPlanSignatureBase64",
    "clerkReconciliationDryRunBase64", "clerkReconciliationDryRunSignatureBase64",
  ]) string(journal[key], /^[A-Za-z0-9+/]+={0,2}$/, `superseded preparation journal ${key}`);
  if (!journal.clerkReconciliationPlanBinding ||
    typeof journal.clerkReconciliationPlanBinding !== "object" ||
    Array.isArray(journal.clerkReconciliationPlanBinding)) {
    fail("superseded preparation Clerk binding is invalid");
  }
  const planBytes = Buffer.from(journal.clerkReconciliationPlanBase64, "base64");
  const signatureBytes = Buffer.from(journal.clerkReconciliationPlanSignatureBase64, "base64");
  const dryRunBytes = Buffer.from(journal.clerkReconciliationDryRunBase64, "base64");
  const dryRunSignatureBytes = Buffer.from(
    journal.clerkReconciliationDryRunSignatureBase64,
    "base64",
  );
  if (planBytes.length < 2 || planBytes.length > MAX_JSON_BYTES ||
    signatureBytes.length < 2 || signatureBytes.length > 64 * 1024 ||
    dryRunBytes.length < 2 || dryRunBytes.length > MAX_JSON_BYTES ||
    dryRunSignatureBytes.length < 2 || dryRunSignatureBytes.length > 64 * 1024) {
    fail("superseded preparation Clerk authority is outside its size bound");
  }
  const plan = strictJsonParse(planBytes, "superseded private Clerk reconciliation plan");
  const dryRun = strictJsonParse(dryRunBytes, "superseded Clerk reconciliation dry-run");
  exactKeys(plan, [
    "schemaVersion", "environment", "kind", "attemptId", "backendCandidateCommit",
    "databaseIdentityHash", "approver", "executor", "cutover", "operations",
  ], "superseded private Clerk reconciliation plan");
  if (plan.schemaVersion !== 1 || plan.environment !== ENVIRONMENT ||
    plan.kind !== "private-clerk-reconciliation-plan" ||
    plan.attemptId !== request.attemptId ||
    plan.databaseIdentityHash !== request.databaseIdentityHash ||
    plan.approver !== request.approver) {
    fail("superseded private Clerk reconciliation plan identity drift detected");
  }
  string(plan.backendCandidateCommit, /^[0-9a-f]{40}$/, "superseded backend candidate commit");
  if (plan.backendCandidateCommit === request.backendCandidate.commit ||
    journal.clerkReconciliationPlanBinding.rawPlanSha256 !== sha256(planBytes) ||
    journal.clerkReconciliationPlanBinding.approver !== request.approver ||
    dryRun.attemptId !== request.attemptId ||
    dryRun.databaseIdentityHash !== request.databaseIdentityHash ||
    dryRun.rawPlanSha256 !== sha256(planBytes)) {
    fail("superseded preparation Clerk authority is not bound to the prior candidate");
  }
  return {
    journal,
    planBytes,
    signatureBytes,
    dryRunBytes,
    dryRunSignatureBytes,
    previousBackendCommit: plan.backendCandidateCommit,
    sourceReadbackPosture: ingressDisableBoundary
      ? "enabled"
      : queuePauseBoundary || appStopBoundary || writerFenceArmedBoundary
        ? "disabled"
        : null,
    allowPartialQuiescence: appStopBoundary || writerFenceArmedBoundary,
    requireHeldRuntime: writerFenceArmedBoundary,
  };
}

function validateRebindablePreparedState(state, request, supersededRequest) {
  if (!supersededRequest) {
    fail("superseded prepared state requires the exact prior bootstrap request");
  }
  const previous = validateRequest(readBoundedJson(
    supersededRequest,
    "superseded bootstrap request",
  ));
  const stableKeys = [
    "schemaVersion", "environment", "kind", "attemptId", "authority", "storage",
    "databaseIdentityHash", "redisIdentityHash", "consoleCandidate", "operator",
    "approver", "changeTicket",
  ];
  for (const key of stableKeys) {
    if (canonicalJson(previous[key]) !== canonicalJson(request[key])) {
      fail(`superseded prepared state changed stable request field ${key}`);
    }
  }
  if (previous.backendCandidate.repository !== request.backendCandidate.repository ||
    previous.backendCandidate.branch !== request.backendCandidate.branch ||
    previous.backendCandidate.commit === request.backendCandidate.commit) {
    fail("superseded prepared state backend transition is invalid");
  }
  if (canonicalJson(previous.targetArtifacts.console) !==
    canonicalJson(request.targetArtifacts.console)) {
    fail("superseded prepared state changed the console artifact");
  }
  const verified = validateState(state, previous);
  if (verified.ledger.phase !== "B1_CONTROL_ACQUIRED" ||
    state.migrationProgress.length !== 0 || Object.keys(state.activeIdentities).length !== 0) {
    fail("only an unadvanced B1 prepared state can be rebound");
  }
  const contextBytes = Buffer.from(state.admissionContextBase64, "base64");
  if (sha256(contextBytes) !== state.admissionContextSha256 ||
    verified.ledger.identity.admissionContextHash !== state.admissionContextSha256) {
    fail("superseded prepared state admission context is corrupt");
  }
  const context = strictJsonParse(contextBytes, "superseded admission context");
  if (context.bootstrapAttemptId !== previous.attemptId ||
    context.backendCandidateCommit !== previous.backendCandidate.commit ||
    context.consoleCandidateCommit !== previous.consoleCandidate.commit ||
    canonicalJson(context.targetArtifacts) !== canonicalJson(previous.targetArtifacts) ||
    canonicalJson(context.sourceRollbackBaseline) !== canonicalJson(state.sourceRollbackBaseline) ||
    canonicalJson(context.clerkReconciliationPlan) !==
      canonicalJson(state.clerkReconciliationPlanBinding)) {
    fail("superseded prepared state context binding is invalid");
  }
  const writerFence = context.quiescedState?.writerFence;
  exactKeys(writerFence, [
    "activeComplianceWriters", "activeWriters", "epoch", "generation", "observedAt",
    "schemaVersion", "state", "stateHash", "target", "writerZero",
  ], "superseded admission writer fence");
  if (canonicalJson(writerFence.epoch) !== canonicalJson(writerFence.state)) {
    fail("superseded admission writer-fence epoch is not the duplicated CLOSED state");
  }
  return {
    request: previous,
    previousBackendCommit: previous.backendCandidate.commit,
    source: {
      sourceRollbackBaseline: state.sourceRollbackBaseline,
      privateRestoreBundle: state.privateRestoreBundle,
    },
    planBytes: Buffer.from(state.clerkReconciliationPlanBase64, "base64"),
    signatureBytes: Buffer.from(state.clerkReconciliationPlanSignatureBase64, "base64"),
    dryRunBytes: Buffer.from(state.clerkReconciliationDryRunBase64, "base64"),
    dryRunSignatureBytes: Buffer.from(
      state.clerkReconciliationDryRunSignatureBase64,
      "base64",
    ),
  };
}

function verifySupersededPreparationSignatures(runner, request, options, superseded) {
  const paths = {
    plan: join(options.stateDir, "superseded-clerk-plan.json"),
    planSignature: join(options.stateDir, "superseded-clerk-plan.sig"),
    dryRun: join(options.stateDir, "superseded-clerk-dry-run.json"),
    dryRunSignature: join(options.stateDir, "superseded-clerk-dry-run.sig"),
  };
  for (const [path, bytes] of [
    [paths.plan, superseded.planBytes],
    [paths.planSignature, superseded.signatureBytes],
    [paths.dryRun, superseded.dryRunBytes],
    [paths.dryRunSignature, superseded.dryRunSignatureBytes],
  ]) writeFileSync(path, bytes, { mode: 0o600, flag: "wx" });
  runner.run("ssh-keygen", [
    "-Y", "verify", "-f", options.allowedSigners, "-I", request.approver,
    "-n", "workforce-os-clerk-reconciliation-plan", "-s", paths.planSignature,
  ], { input: superseded.planBytes, label: "superseded Clerk plan signature verification" });
  runner.run("ssh-keygen", [
    "-Y", "verify", "-f", options.allowedSigners, "-I", request.approver,
    "-n", "workforce-os-clerk-reconciliation-dry-run", "-s", paths.dryRunSignature,
  ], { input: superseded.dryRunBytes, label: "superseded Clerk dry-run signature verification" });
}

function preparationJournal(request, clerkReconciliation) {
  return {
    schemaVersion: 1,
    environment: ENVIRONMENT,
    kind: PREPARATION_JOURNAL_KIND,
    attemptId: request.attemptId,
    requestSha256: canonicalHash(request),
    azureLeaseTokenHash: leaseTokenHash(request),
    leaseIdHash: leaseIdHash(request),
    stage: "B0_LEASE_ACQUIRED",
    intent: null,
    clerkReconciliationPlanBase64: clerkReconciliation.planBytes.toString("base64"),
    clerkReconciliationPlanSignatureBase64: clerkReconciliation.signatureBytes.toString("base64"),
    clerkReconciliationDryRunBase64: clerkReconciliation.dryRunBytes.toString("base64"),
    clerkReconciliationDryRunSignatureBase64:
      clerkReconciliation.dryRunSignatureBytes.toString("base64"),
    clerkReconciliationPlanBinding: clerkReconciliation.binding,
    source: null,
    updatedAt: nowSecond(),
  };
}

function journalMutation(runner, request, options, journal, operation, status, stage, extra = {}) {
  const next = {
    ...journal,
    ...extra,
    stage,
    intent: { operation, status, at: nowSecond() },
    updatedAt: nowSecond(),
  };
  validatePreparationJournal(next, request);
  uploadState(runner, request, next, options.statePath);
  return next;
}

function nextGeneration(state) {
  return safeInteger(state.fencingGeneration + 1, "next fencing generation", 1);
}

function replaceLedger(state, result, extra = {}) {
  return {
    ...state,
    ...extra,
    fencingGeneration: result.ledger.fencingGeneration,
    phaseLedgerBase64: Buffer.from(result.ledgerBytes).toString("base64"),
    phaseLedgerSha256: result.ledgerSha256,
    updatedAt: result.ledger.updatedAt,
  };
}

function holdState(state, reasonCode, evidence) {
  const result = holdLedger(Buffer.from(state.phaseLedgerBase64, "base64"), {
    fencingGeneration: Math.max(
      nextGeneration(state),
      safeInteger(state.writerFenceGeneration + 1, "held writer-fence generation", 1),
    ),
    reasonCode,
    evidenceSha256: canonicalHash(evidence),
    at: nowSecond(),
  });
  return replaceLedger(state, result, {
    phaseEvidence: { ...state.phaseEvidence, held: evidence },
  });
}

function assertProtectedRuntime(action) {
  if (action === "audit") return;
  const expected = {
    GITHUB_ACTIONS: "true",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/master",
    GITHUB_REF_PROTECTED: "true",
    WORKFORCE_PRODUCTION_BOOTSTRAP_AUTHORITY_CONFIRMED: "true",
    ACA_EXCLUSIVE_MUTATION_AUTHORITY_CONFIRMED: "true",
  };
  for (const [name, value] of Object.entries(expected)) {
    if (process.env[name] !== value) fail(`protected runtime invariant ${name} is absent`);
  }
  for (const name of ["AZURE_CLIENT_ID", "AZURE_TENANT_ID", "AZURE_SUBSCRIPTION_ID", "AZURE_PRINCIPAL_OBJECT_ID"]) {
    string(process.env[name], /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/, `protected runtime ${name}`);
  }
}

function assertExactProtectedSnapshot(runner, request, action) {
  if (action === "audit" && process.env.GITHUB_ACTIONS !== "true") return;
  const snapshotCommit = process.env.WORKFORCE_BOOTSTRAP_SNAPSHOT_COMMIT;
  if (process.env.WORKFORCE_BOOTSTRAP_EXACT_SNAPSHOT !== "true" ||
    !/^[0-9a-f]{40}$/.test(snapshotCommit ?? "") ||
    process.env.GITHUB_SHA !== snapshotCommit) {
    fail("controller is not executing from the exact protected snapshot");
  }
  const snapshotRoot = process.env.WORKFORCE_BOOTSTRAP_SNAPSHOT_ROOT;
  const root = validateExternalPath(snapshotRoot, "private source snapshot", { directory: true });
  if ((statSync(root).mode & 0o777) !== 0o700 || !inside(root, REPO_ROOT)) {
    fail("private exact-commit source snapshot is not mode 0700 or does not contain the controller");
  }
  const git = requireSnapshotFile("scripts/run-release-git.sh", true);
  const head = runner.run(git, ["-C", REPO_ROOT, "rev-parse", "HEAD"], {
    label: "private snapshot HEAD",
  }).stdout.toString("utf8").trim();
  if (head !== snapshotCommit) fail("private snapshot HEAD drift detected");
  const status = runner.run(git, [
    "-C", REPO_ROOT, "status", "--porcelain", "--untracked-files=no",
  ], { label: "private snapshot tracked status" }).stdout.toString("utf8");
  if (status !== "") fail("private snapshot tracked bytes are dirty");
  const replacements = runner.run(git, [
    "-C", REPO_ROOT, "for-each-ref", "--format=%(refname)", "refs/replace/",
  ], { label: "private snapshot replacement refs" }).stdout.toString("utf8").trim();
  if (replacements !== "") fail("private snapshot contains forbidden replacement refs");
  const controllerBytes = readFileSync(requireSnapshotFile("scripts/production-bootstrap-controller.mjs", true));
  const committedController = runner.run(git, [
    "-C", REPO_ROOT, "show", `${snapshotCommit}:scripts/production-bootstrap-controller.mjs`,
  ], { label: "exact committed bootstrap controller" }).stdout;
  if (!controllerBytes.equals(committedController)) fail("executing controller bytes differ from the admitted commit");
  if (snapshotCommit === request.backendCandidate.commit) return;

  const recoveryActions = new Set([
    "deploy-compatible", "activate-first-class", "resume", "complete", "hold", "renew-hold",
  ]);
  if (!recoveryActions.has(action)) {
    fail("a recovery controller successor is permitted only after schema application");
  }
  const ancestor = runner.run(git, [
    "-C", REPO_ROOT, "merge-base", "--is-ancestor", request.backendCandidate.commit, snapshotCommit,
  ], { label: "recovery controller ancestry", allowFailure: true });
  if (ancestor.status !== 0) fail("recovery controller is not a descendant of the admitted candidate");
  const changed = runner.run(git, [
    "-C", REPO_ROOT, "diff", "--name-only", request.backendCandidate.commit, snapshotCommit, "--",
  ], { label: "recovery controller scope" }).stdout.toString("utf8").trim().split("\n").filter(Boolean);
  const allowed = new Set([
    ".github/workflows/bootstrap-production.yml",
    "docs/ops/initial-production-bootstrap-controller.md",
    "docs/ops/production-bootstrap-phase-receipt.schema.json",
    "scripts/production-bootstrap-controller.mjs",
    "scripts/production-bootstrap-phase-receipt-contracts.mjs",
    "scripts/verify-containerapp-release-config.sh",
    "scripts/verify-production-bootstrap-phase-receipt.sh",
    "scripts/verify-production-bootstrap-workflow.sh",
    "scripts/tests/production-bootstrap-controller.test.mjs",
    "scripts/tests/production-bootstrap-phase-ledger.test.mjs",
    "scripts/tests/production-bootstrap-phase-receipt.fixture.mjs",
    "scripts/tests/production-bootstrap-phase-receipt.test.sh",
    "scripts/tests/release-scripts.test.sh",
  ]);
  if (changed.length === 0 || !changed.includes("scripts/production-bootstrap-controller.mjs") ||
    changed.some((path) => !allowed.has(path))) {
    fail("protected recovery controller successor changed files outside the reviewed recovery scope");
  }
}

export function productionAuthorityDrainCheckpointSnapshot(value) {
  return {
    exists: true,
    blobName: value?.name ?? null,
    lastModified: value?.properties?.lastModified ?? null,
    contentLength: value?.properties?.contentLength ?? null,
    leaseState: value?.properties?.lease?.state ?? null,
    leaseStatus: value?.properties?.lease?.status ?? null,
    metadata: value?.metadata ?? null,
  };
}

function verifyAzureIdentity(runner, request) {
  const account = runner.json("az", ["account", "show", "--output", "json", "--only-show-errors"], { label: "Azure OIDC identity" });
  if (
    String(account.id).toLowerCase() !== request.authority.subscriptionId.toLowerCase() ||
    String(account.id).toLowerCase() !== process.env.AZURE_SUBSCRIPTION_ID.toLowerCase() ||
    String(account.tenantId).toLowerCase() !== process.env.AZURE_TENANT_ID.toLowerCase() ||
    account.user?.type !== "servicePrincipal" ||
    String(account.user?.name).toLowerCase() !== process.env.AZURE_CLIENT_ID.toLowerCase()
  ) {
    fail("Azure session is not the protected environment OIDC principal");
  }
  const storage = runner.json("az", azArgs(request, ["resource", "show", "--ids", request.storage.resourceId, "--output", "json"]), { label: "bootstrap storage identity" });
  if (String(storage.id).toLowerCase() !== request.storage.resourceId.toLowerCase()) fail("bootstrap storage identity drift detected");
  if (process.env.ACA_EXCLUSIVE_MUTATION_AUTHORITY_CONFIRMED !== "true") {
    fail("exclusive Container Apps and bootstrap-state mutation authority is not attested by the protected environment");
  }
  const principalObjectId = String(process.env.AZURE_PRINCIPAL_OBJECT_ID).toLowerCase();
  const scopes = {
    api: request.authority.apiContainerAppResourceId,
    worker: request.authority.workerContainerAppResourceId,
    console: request.authority.consoleContainerAppResourceId,
    // Query the exact container so --include-inherited captures both the
    // expected conditioned storage-account assignments and any direct child-
    // scope assignment that could bypass the account-level inventory.
    stateStorage: azureControlContainerRoleAssignmentScope(request),
  };
  const assignmentsByScope = {};
  for (const [label, scope] of Object.entries(scopes)) {
    const assignments = runner.json(
      "az",
      azureInheritedRoleAssignmentListArgs(request, scope),
      { label: `${label} exact live mutation-authority assignments` },
    );
    if (!Array.isArray(assignments)) fail(`${label} mutation-authority assignments are invalid`);
    const normalized = assignments.map((assignment) => ({
      condition: assignment.condition ?? null,
      conditionVersion: assignment.conditionVersion ?? null,
      principalId: String(assignment.principalId ?? "").toLowerCase(),
      principalType: assignment.principalType,
      roleDefinitionId: String(assignment.roleDefinitionId ?? "").toLowerCase(),
      scope: String(assignment.scope ?? "").toLowerCase(),
    })).sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
    if (!normalized.some((assignment) => assignment.principalId === principalObjectId)) {
      fail(`${label} has no reviewed effective assignment for the protected OIDC principal`);
    }
    assignmentsByScope[label] = normalized;
  }
  const checkpoint = runner.json("az", [
    "storage", "blob", "show",
    "--auth-mode", "login",
    "--account-name", request.storage.accountName,
    "--container-name", request.storage.containerName,
    "--name", PRODUCTION_AUTHORITY_DRAIN_CONTRACT.blobName,
    "--subscription", request.authority.subscriptionId,
    "--output", "json",
    "--only-show-errors",
  ], { label: "production authority credential-drain checkpoint" });
  const checkpointResult = evaluateProductionAuthorityDrainCheckpoint(
    productionAuthorityDrainCheckpointSnapshot(checkpoint),
    nowSecond(),
    request.bootstrapEvidence.azureMutationAuthorityStructuralEvidenceHash,
  );
  if (checkpointResult.finding || !checkpointResult.evidence) {
    fail(`production authority credential-drain checkpoint is not admitted: ${checkpointResult.finding?.code ?? "invalid"}`);
  }
  const mutationAuthorityEvidence = {
    schemaVersion: 2,
    clientId: process.env.AZURE_CLIENT_ID.toLowerCase(),
    principalObjectId,
    subscriptionId: request.authority.subscriptionId,
    protectedExclusiveAuthorityAttested: true,
    structuralEvidenceHash:
      request.bootstrapEvidence.azureMutationAuthorityStructuralEvidenceHash,
    credentialDrainCheckpoint: checkpointResult.evidence,
    assignmentsByScope,
  };
  if (canonicalHash(mutationAuthorityEvidence) !==
    request.bootstrapEvidence.azureMutationAuthorityEvidenceHash) {
    fail("live Azure mutation-authority RBAC differs from the independently reviewed request evidence");
  }
}

function verifyPublishedCandidates(runner, request) {
  for (const [candidate, artifact, label] of [
    [request.backendCandidate, request.targetArtifacts.api, "backend"],
    [request.consoleCandidate, request.targetArtifacts.console, "console"],
  ]) {
    const repository = runner.json("gh", ["api", `repos/${candidate.repository}`], {
      label: `${label} repository metadata`,
    });
    if (repository.default_branch !== candidate.branch) {
      fail(`${label} candidate is not the exact default branch`);
    }
    const branch = runner.json("gh", [
      "api", `repos/${candidate.repository}/branches/${encodeURIComponent(candidate.branch)}`,
    ], { label: `published ${label} candidate` });
    if (branch.protected !== true || branch.commit?.sha !== candidate.commit) {
      fail(`${label} candidate is not the protected exact published head`);
    }
    // GITHUB_TOKEN cannot read the repository-administration `/protection`
    // endpoint, even when the workflow has access to the protected branch.
    // The ordinary branch response exposes the effective required checks and
    // their enforcement level and is available to this read-only workflow.
    // Exact-head equality plus fresh successful required checks closes the
    // strict-update requirement without an unusable administration grant.
    const protection = branch.protection;
    const requiredContexts = protection?.required_status_checks?.contexts ?? [];
    const requiredChecks = protection?.required_status_checks?.checks ?? [];
    if (protection?.enabled !== true ||
      protection.required_status_checks?.enforcement_level !== "everyone" ||
      requiredChecks.length + requiredContexts.length < 1) {
      fail(`${label} default branch lacks enforced required CI protection`);
    }
    const checks = runner.json("gh", [
      "api", `repos/${candidate.repository}/commits/${candidate.commit}/check-runs?per_page=100&filter=latest`,
    ], { label: `${label} exact-head CI checks` });
    if (!Array.isArray(checks.check_runs) || !Number.isSafeInteger(checks.total_count) ||
      checks.check_runs.length < 1 || checks.total_count !== checks.check_runs.length ||
      checks.total_count > 100) {
      fail(`${label} exact-head CI check inventory is empty, truncated, or ambiguous`);
    }
    const combinedStatus = runner.json("gh", [
      "api", `repos/${candidate.repository}/commits/${candidate.commit}/status?per_page=100&page=1`,
    ], { label: `${label} exact-head legacy statuses` });
    const statuses = Array.isArray(combinedStatus.statuses) ? combinedStatus.statuses : [];
    if (statuses.length >= 100) {
      fail(`${label} exact-head legacy status inventory may be paginated or truncated`);
    }
    const now = Date.now();
    const fresh = (timestamp) => {
      const milliseconds = Date.parse(timestamp ?? "");
      return Number.isFinite(milliseconds) && milliseconds <= now && now - milliseconds <= 24 * 60 * 60 * 1000;
    };
    for (const context of requiredContexts) {
      const status = statuses.find((entry) => entry.context === context && entry.state === "success" && fresh(entry.updated_at));
      const check = checks.check_runs.find((entry) => entry.name === context &&
        entry.status === "completed" && entry.conclusion === "success" && fresh(entry.completed_at));
      if (!status && !check) fail(`${label} exact head is missing fresh required check ${context}`);
    }
    for (const required of requiredChecks) {
      const check = checks.check_runs.find((entry) => entry.name === required.context &&
        entry.app?.id === required.app_id && entry.status === "completed" &&
        entry.conclusion === "success" && fresh(entry.completed_at));
      if (!check) fail(`${label} exact head is missing a fresh required app-bound check`);
    }
    const buildRun = runner.json("gh", [
      "api", `repos/${candidate.repository}/actions/runs/${artifact.buildRunId}`,
    ], { label: `${label} candidate build run` });
    if (String(buildRun.id) !== artifact.buildRunId || buildRun.head_sha !== candidate.commit ||
      buildRun.status !== "completed" || buildRun.conclusion !== "success" || !fresh(buildRun.updated_at)) {
      fail(`${label} artifact build run is not a fresh successful exact-head run`);
    }
    const buildEvidence = {
      repository: candidate.repository,
      runId: String(buildRun.id),
      runAttempt: buildRun.run_attempt,
      headSha: buildRun.head_sha,
      event: buildRun.event,
      workflowId: buildRun.workflow_id,
      conclusion: buildRun.conclusion,
      updatedAt: buildRun.updated_at,
    };
    if (canonicalHash(buildEvidence) !== artifact.buildEvidenceHash) {
      fail(`${label} artifact build-evidence hash does not bind the exact successful run`);
    }
  }
}

function verifyArtifact(runner, artifact, role) {
  const repository = role === "console" ? "workforceos-fe" : "apex-api";
  const metadata = runner.json("az", [
    "acr", "manifest", "show-metadata",
    "--registry", REGISTRY,
    "--name", `${repository}@${artifact.manifestDigest}`,
    "--output", "json",
    "--only-show-errors",
  ], { label: `${role} registry manifest metadata` });
  const observedDigest = metadata.digest ?? metadata.changeableAttributes?.digest;
  if (observedDigest !== artifact.manifestDigest) fail(`${role} registry manifest digest drift detected`);
  const manifest = runner.json("az", [
    "acr", "manifest", "show",
    "--registry", REGISTRY,
    "--name", `${repository}@${artifact.manifestDigest}`,
    "--output", "json",
    "--only-show-errors",
  ], { label: `${role} registry manifest` });
  let platformManifest = manifest;
  if (Array.isArray(manifest.manifests)) {
    const descriptors = manifest.manifests.filter((descriptor) =>
      descriptor?.platform?.os === "linux" && descriptor?.platform?.architecture === "amd64");
    if (descriptors.length !== 1 || !/^sha256:[0-9a-f]{64}$/.test(descriptors[0]?.digest ?? "")) {
      fail(`${role} registry index does not select exactly one linux/amd64 manifest`);
    }
    const childMetadata = runner.json("az", [
      "acr", "manifest", "show-metadata",
      "--registry", REGISTRY,
      "--name", `${repository}@${descriptors[0].digest}`,
      "--output", "json",
      "--only-show-errors",
    ], { label: `${role} registry linux/amd64 manifest metadata` });
    const childMetadataDigest = childMetadata.digest ?? childMetadata.changeableAttributes?.digest;
    if (childMetadataDigest !== descriptors[0].digest) {
      fail(`${role} registry platform descriptor does not bind the fetched manifest`);
    }
    platformManifest = runner.json("az", [
      "acr", "manifest", "show",
      "--registry", REGISTRY,
      "--name", `${repository}@${descriptors[0].digest}`,
      "--output", "json",
      "--only-show-errors",
    ], { label: `${role} registry linux/amd64 manifest` });
  }
  if (platformManifest?.config?.digest !== artifact.platformDigest) {
    fail(`${role} registry platform manifest does not bind the admitted image config digest`);
  }
  runner.run("docker", ["pull", "--platform", "linux/amd64", artifact.image], { label: `${role} immutable image pull` });
  const image = runner.json("docker", ["image", "inspect", artifact.image], { label: `${role} image inspection` });
  if (!Array.isArray(image) || image.length !== 1) fail(`${role} image inspection returned an invalid shape`);
  const inspected = image[0];
  const revision = inspected?.Config?.Labels?.["org.opencontainers.image.revision"];
  if (inspected?.Architecture !== "amd64" || inspected?.Os !== "linux" ||
    revision !== artifact.ociRevision || inspected?.Id !== artifact.platformDigest) {
    fail(`${role} image platform or OCI revision drift detected`);
  }
  const repoDigests = inspected?.RepoDigests;
  if (!Array.isArray(repoDigests) || !repoDigests.includes(artifact.image)) fail(`${role} image is not bound to the admitted digest`);
}

function verifyContractClosure() {
  for (const path of REQUIRED_HELPERS) requireSnapshotFile(path, path.startsWith("scripts/"));
  const phasePostClerkContract = PHASE_MIGRATIONS.slice(1).map(({ path, sha256 }) => ({
    path,
    sha256,
  }));
  if (canonicalJson(MIGRATIONS.slice(1)) !== canonicalJson(POST_CLERK_MIGRATIONS) ||
    canonicalJson(phasePostClerkContract) !==
      canonicalJson(POST_CLERK_MIGRATION_CONTRACT)) {
    fail("post-Clerk migration paths or reviewed SHA contract drifted across helpers");
  }
  const pin = readFileSync(requireSnapshotFile("docs/ops/production-migration-allowed-signers.sha256"), "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  if (pin.length !== 1 || !/^[0-9a-f]{64}$/.test(pin[0])) fail("production receipt signer pin is unconfigured or malformed");
}

function reviewedSignerPin() {
  const lines = readFileSync(
    requireSnapshotFile("docs/ops/production-migration-allowed-signers.sha256"),
    "utf8",
  )
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  if (lines.length !== 1 || !/^[0-9a-f]{64}$/.test(lines[0])) {
    fail("production receipt signer pin is unconfigured or malformed");
  }
  return `sha256:${lines[0]}`;
}

function verifyAllowedSignersBytes(path) {
  validateExternalPath(path, "allowed signers");
  const bytes = readFileSync(path);
  if (sha256(bytes) !== reviewedSignerPin()) {
    fail("allowed-signers bytes do not match the reviewed source pin");
  }
  return bytes;
}

function canonicalTimestamp(value, label) {
  string(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, label);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value.replace(/Z$/, ".000Z")) {
    fail(`${label} is invalid`);
  }
  return date.getTime();
}

export function validateClerkReconciliationDryRunEvidence(
  plan,
  planBytes,
  dryRun,
  request,
  observedNow = Date.now(),
) {
  exactKeys(dryRun, [
    "schemaVersion", "environment", "kind", "attemptId", "rawPlanSha256",
    "databaseIdentityHash", "executorSha256", "inventoryEvidenceHash",
    "minimumEventVersion", "expectedActiveOrganizationCount",
    "expectedActiveMembershipCount", "expectedActiveUserCount", "status",
    "verifiedAt", "expiresAt", "invariants", "evidenceHash",
  ], "Clerk reconciliation dry-run evidence");
  const rawPlanSha256 = sha256(planBytes);
  if (dryRun.schemaVersion !== 1 || dryRun.environment !== ENVIRONMENT ||
    dryRun.kind !== "clerk-reconciliation-dry-run" ||
    dryRun.attemptId !== request.attemptId ||
    dryRun.rawPlanSha256 !== rawPlanSha256 ||
    dryRun.databaseIdentityHash !== request.databaseIdentityHash ||
    dryRun.executorSha256 !== plan.executor.sha256 ||
    dryRun.inventoryEvidenceHash !== plan.cutover.inventoryEvidenceHash ||
    dryRun.minimumEventVersion !== plan.cutover.minimumEventVersion ||
    dryRun.expectedActiveOrganizationCount !== plan.cutover.expectedActiveOrganizationCount ||
    dryRun.expectedActiveMembershipCount !== plan.cutover.expectedActiveMembershipCount ||
    dryRun.expectedActiveUserCount !== plan.cutover.expectedActiveUserCount ||
    dryRun.status !== "verified-no-write") {
    fail("Clerk reconciliation dry-run evidence does not bind the exact plan");
  }
  string(dryRun.evidenceHash, /^sha256:[0-9a-f]{64}$/, "Clerk reconciliation dry-run evidence hash");
  exactKeys(dryRun.invariants, [
    "organizationCount", "membershipCount", "userCount", "projectionMismatchRows",
    "orphanActiveAuthorityRows", "readinessViolationRows",
  ], "Clerk reconciliation dry-run invariants");
  if (dryRun.invariants.organizationCount !== plan.cutover.expectedActiveOrganizationCount ||
    dryRun.invariants.membershipCount !== plan.cutover.expectedActiveMembershipCount ||
    dryRun.invariants.userCount !== plan.cutover.expectedActiveUserCount ||
    dryRun.invariants.projectionMismatchRows !== 0 ||
    dryRun.invariants.orphanActiveAuthorityRows !== 0 ||
    dryRun.invariants.readinessViolationRows !== 0) {
    fail("Clerk reconciliation dry-run invariants do not match the frozen plan");
  }
  const dryRunWithoutHash = { ...dryRun };
  delete dryRunWithoutHash.evidenceHash;
  if (sha256(Buffer.from(canonicalJson(dryRunWithoutHash), "utf8")) !== dryRun.evidenceHash) {
    fail("Clerk reconciliation dry-run evidence hash is invalid");
  }
  const verifiedAt = canonicalTimestamp(dryRun.verifiedAt, "Clerk reconciliation dry-run verifiedAt");
  const expiresAt = canonicalTimestamp(dryRun.expiresAt, "Clerk reconciliation dry-run expiresAt");
  if (verifiedAt > observedNow || expiresAt <= observedNow || expiresAt <= verifiedAt ||
    expiresAt - verifiedAt > 60 * 60 * 1000) {
    fail("Clerk reconciliation dry-run evidence is stale or has an invalid lifetime");
  }
  return rawPlanSha256;
}

function verifyClerkReconciliationPlan(runner, request, options) {
  for (const [path, label] of [
    [options.clerkPlan, "private Clerk reconciliation plan"],
    [options.clerkPlanSignature, "Clerk reconciliation plan signature"],
    [options.clerkPlanDryRun, "Clerk reconciliation dry-run evidence"],
    [options.clerkPlanDryRunSignature, "Clerk reconciliation dry-run signature"],
    [options.allowedSigners, "allowed signers"],
  ]) {
    validateExternalPath(path, label);
  }
  verifyAllowedSignersBytes(options.allowedSigners);
  const planBytes = readFileSync(options.clerkPlan);
  const signatureBytes = readFileSync(options.clerkPlanSignature);
  const dryRunBytes = readFileSync(options.clerkPlanDryRun);
  const dryRunSignatureBytes = readFileSync(options.clerkPlanDryRunSignature);
  if (planBytes.length < 2 || planBytes.length > MAX_JSON_BYTES ||
    signatureBytes.length < 2 || signatureBytes.length > 64 * 1024 ||
    dryRunBytes.length < 2 || dryRunBytes.length > MAX_JSON_BYTES ||
    dryRunSignatureBytes.length < 2 || dryRunSignatureBytes.length > 64 * 1024) {
    fail("Clerk reconciliation plan evidence is outside its size bound");
  }
  const plan = strictJsonParse(planBytes, "private Clerk reconciliation plan");
  const dryRun = strictJsonParse(dryRunBytes, "Clerk reconciliation dry-run evidence");
  exactKeys(plan, [
    "schemaVersion", "environment", "kind", "attemptId", "backendCandidateCommit",
    "databaseIdentityHash", "approver", "executor", "cutover", "operations",
  ], "private Clerk reconciliation plan");
  if (plan.schemaVersion !== 1 || plan.environment !== ENVIRONMENT ||
    plan.kind !== "private-clerk-reconciliation-plan" ||
    plan.attemptId !== request.attemptId ||
    plan.backendCandidateCommit !== request.backendCandidate.commit ||
    plan.databaseIdentityHash !== request.databaseIdentityHash ||
    plan.approver !== request.approver) {
    fail("private Clerk reconciliation plan identity drift detected");
  }
  exactKeys(plan.executor, ["name", "version", "sha256"], "Clerk reconciliation executor");
  if (plan.executor.name !== "workforce-production-clerk-reconciliation-executor" ||
    plan.executor.version !== "v1") {
    fail("Clerk reconciliation executor identity is not the reviewed v1 executor");
  }
  string(plan.executor.sha256, /^sha256:[0-9a-f]{64}$/, "Clerk reconciliation executor hash");
  const committedExecutor = runner.run(
    requireSnapshotFile("scripts/run-release-git.sh", true),
    ["-C", REPO_ROOT, "show", `${request.backendCandidate.commit}:${CLERK_EXECUTOR_PATH}`],
    { label: "exact Clerk reconciliation executor source" },
  ).stdout;
  const snapshotExecutor = readFileSync(requireSnapshotFile(CLERK_EXECUTOR_PATH, true));
  if (sha256(committedExecutor) !== plan.executor.sha256 ||
    !committedExecutor.equals(snapshotExecutor)) {
    fail("Clerk reconciliation executor does not match the exact admitted commit bytes");
  }
  exactKeys(plan.cutover, [
    "minimumEventVersion", "inventoryEvidenceHash", "expectedActiveOrganizationCount",
    "expectedActiveMembershipCount", "expectedActiveUserCount",
  ], "Clerk reconciliation cutover");
  safeInteger(plan.cutover.minimumEventVersion, "Clerk reconciliation minimumEventVersion", 1);
  if (plan.cutover.minimumEventVersion > Number.MAX_SAFE_INTEGER) fail("Clerk reconciliation cutoff is not JS-safe");
  string(plan.cutover.inventoryEvidenceHash, /^sha256:[0-9a-f]{64}$/, "Clerk reconciliation inventory evidence hash");
  for (const key of ["expectedActiveOrganizationCount", "expectedActiveMembershipCount", "expectedActiveUserCount"]) {
    safeInteger(plan.cutover[key], `Clerk reconciliation ${key}`, 0);
  }
  if (!Array.isArray(plan.operations) || plan.operations.length < 1 || plan.operations.length > 100000) {
    fail("private Clerk reconciliation plan operations are empty or unbounded");
  }
  // Do not inspect, serialize, or log row-bearing operations after strict JSON
  // parsing. Their exact bytes are the signed authority.
  const rawPlanSha256 = validateClerkReconciliationDryRunEvidence(
    plan,
    planBytes,
    dryRun,
    request,
  );
  runner.run("ssh-keygen", [
    "-Y", "verify",
    "-f", options.allowedSigners,
    "-I", request.approver,
    "-n", "workforce-os-clerk-reconciliation-plan",
    "-s", options.clerkPlanSignature,
  ], { input: planBytes, label: "Clerk reconciliation plan signature verification" });
  runner.run("ssh-keygen", [
    "-Y", "verify",
    "-f", options.allowedSigners,
    "-I", request.approver,
    "-n", "workforce-os-clerk-reconciliation-dry-run",
    "-s", options.clerkPlanDryRunSignature,
  ], { input: dryRunBytes, label: "Clerk reconciliation dry-run signature verification" });
  return {
    planBytes,
    signatureBytes,
    dryRunBytes,
    dryRunSignatureBytes,
    binding: {
      rawPlanSha256,
      dryRunEvidenceSha256: sha256(dryRunBytes),
      inventoryEvidenceHash: plan.cutover.inventoryEvidenceHash,
      minimumEventVersion: plan.cutover.minimumEventVersion,
      expectedActiveOrganizationCount: plan.cutover.expectedActiveOrganizationCount,
      expectedActiveMembershipCount: plan.cutover.expectedActiveMembershipCount,
      expectedActiveUserCount: plan.cutover.expectedActiveUserCount,
      executor: {
        name: plan.executor.name,
        version: plan.executor.version,
        sha256: plan.executor.sha256,
      },
      dryRunPassed: true,
      approver: plan.approver,
      planSignatureSha256: sha256(signatureBytes),
      signatureNamespace: "workforce-os-clerk-reconciliation-plan",
      independentApprovalEvidenceHash: sha256(dryRunSignatureBytes),
      verifiedAt: dryRun.verifiedAt,
      expiresAt: dryRun.expiresAt,
    },
  };
}

export function auditPreconditions(runner, request, { verifyImages = true } = {}) {
  verifyContractClosure();
  verifyPublishedCandidates(runner, request);
  if (process.env.GITHUB_ACTIONS === "true") verifyAzureIdentity(runner, request);
  if (verifyImages) {
    verifyArtifact(runner, request.targetArtifacts.api, "api");
    verifyArtifact(runner, request.targetArtifacts.worker, "worker");
    verifyArtifact(runner, request.targetArtifacts.console, "console");
  }
  return {
    schemaVersion: 1,
    kind: "initial-production-bootstrap-audit",
    environment: ENVIRONMENT,
    attemptId: request.attemptId,
    requestSha256: canonicalHash(request),
    authorityIdentityHash: azureAuthorityIdentityHash(request.authority),
    exactPublishedCandidates: true,
    immutableArtifactsVerified: verifyImages,
    finalReceiptVerifierPresent: true,
    signerPinConfigured: true,
  };
}

function appState(runner, request, resourceId, label) {
  const state = runner.json("az", azArgs(request, ["containerapp", "show", "--ids", resourceId, "--output", "json"]), { label });
  if (String(state.id).toLowerCase() !== resourceId.toLowerCase()) fail(`${label} resource identity drift detected`);
  if (!Array.isArray(state.properties?.template?.containers) || state.properties.template.containers.length !== 1) fail(`${label} must have exactly one container`);
  return state;
}

function revisionList(runner, request, appName, includeInactive = false) {
  const args = [
    "containerapp", "revision", "list",
    "--name", appName,
    "--resource-group", RESOURCE_GROUP,
  ];
  if (includeInactive) args.push("--all");
  args.push("--output", "json");
  const list = runner.json("az", azArgs(request, args), {
    label: `${appName} revision list${includeInactive ? " including inactive" : ""}`,
  });
  if (!Array.isArray(list)) fail(`${appName} revision list is invalid`);
  return list;
}

function resourceProviderAppState(runner, request, resourceId, apiVersion, label) {
  const state = runner.json("az", azArgs(request, [
    "rest",
    "--method", "get",
    "--url", `${resourceId}?api-version=${apiVersion}`,
    "--output", "json",
  ]), { label });
  if (String(state.id).toLowerCase() !== resourceId.toLowerCase()) {
    fail(`${label} resource identity drift detected`);
  }
  if (!Array.isArray(state.properties?.template?.containers) ||
    state.properties.template.containers.length !== 1) {
    fail(`${label} must have exactly one container`);
  }
  return state;
}

function activeRevision(revisions, appName) {
  const active = revisions.filter((entry) => entry?.properties?.active === true);
  if (active.length !== 1) fail(`${appName} must have exactly one active source revision`);
  const revision = active[0];
  if (revision.name !== revision.properties?.template?.revisionSuffix && !String(revision.name).startsWith(`${appName}--`)) {
    fail(`${appName} returned an invalid source revision name`);
  }
  const image = revision.properties?.template?.containers?.[0]?.image;
  if (typeof image !== "string" || !/@sha256:[0-9a-f]{64}$/.test(image)) fail(`${appName} source revision is not immutable`);
  return revision;
}

function plainEnv(container, name) {
  const entries = (container.env ?? []).filter((entry) => entry?.name === name);
  if (entries.length === 0) return null;
  if (entries.length !== 1 || entries[0].secretRef || typeof entries[0].value !== "string") fail(`${name} must be one plain environment value`);
  return entries[0].value;
}

function sourceSnapshot(app, revision, role, imageMetadata) {
  const container = revision.properties.template.containers[0];
  const configuration = app.properties.configuration;
  const secretReferences = (container.env ?? [])
    .filter((entry) => typeof entry?.secretRef === "string")
    .map((entry) => ({ name: entry.name, secretRef: entry.secretRef }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const health = revision.properties?.healthState ?? revision.properties?.runningState;
  if (!new Set(["Healthy", "Running", "Provisioned"]).has(health)) fail(`${role} source revision is not healthy`);
  return {
    image: container.image,
    manifestDigest: container.image.split("@")[1],
    platformDigest: imageMetadata.platformDigest,
    ociRevision: imageMetadata.ociRevision,
    platform: "linux/amd64",
    revision: revision.name,
    configHash: canonicalHash(configuration),
    templateHash: canonicalHash(revision.properties.template),
    secretReferencesHash: canonicalHash(secretReferences),
    activeRevisionsMode: configuration.activeRevisionsMode,
    maxInactiveRevisions: configuration.maxInactiveRevisions,
    healthy: true,
  };
}

function refreshCapturedSourceForRebind(
  runner,
  request,
  options,
  source,
  apiIngressPosture,
  allowPartialQuiescence,
  previousBackendCommit,
) {
  if (!source || typeof source !== "object" || Array.isArray(source) ||
    !source.privateRestoreBundle || typeof source.privateRestoreBundle !== "object" ||
    Array.isArray(source.privateRestoreBundle) ||
    !source.sourceRollbackBaseline || typeof source.sourceRollbackBaseline !== "object" ||
    Array.isArray(source.sourceRollbackBaseline)) {
    fail("superseded preparation source baseline is invalid");
  }
  const bundle = source.privateRestoreBundle;
  const baseline = source.sourceRollbackBaseline;
  if (!new Set(["enabled", "disabled"]).has(apiIngressPosture)) {
    fail("superseded preparation API ingress posture is invalid");
  }
  if (baseline.privateRestoreBundleHash !== canonicalHash(bundle)) {
    fail("superseded preparation source restore bundle is corrupt");
  }
  for (const [role, appName, resourceId, storedApp, storedRevision] of [
    ["api", API_APP, request.authority.apiContainerAppResourceId, bundle.apiResource, bundle.apiRevision],
    ["worker", WORKER_APP, request.authority.workerContainerAppResourceId, bundle.workerResource, bundle.workerRevision],
    ["console", CONSOLE_APP, request.authority.consoleContainerAppResourceId, bundle.consoleResource, bundle.consoleRevision],
  ]) {
    const snapshot = baseline[role];
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot) ||
      String(storedApp?.id).toLowerCase() !== resourceId.toLowerCase() ||
      storedRevision?.name !== snapshot.revision ||
      storedRevision?.properties?.template?.containers?.[0]?.image !== snapshot.image) {
      fail(`superseded preparation ${role} source binding is invalid`);
    }
    const liveApp = appState(runner, request, resourceId, `rebindable source ${role}`);
    const activeRevisions = revisionList(runner, request, appName)
      .filter((entry) => entry?.properties?.active === true);
    const liveConfiguration = structuredClone(liveApp.properties?.configuration);
    if (role === "api" && apiIngressPosture === "disabled") {
      if (liveConfiguration?.ingress !== null) {
        fail("superseded preparation API ingress is not disabled");
      }
      liveConfiguration.ingress = structuredClone(
        bundle.apiResource?.properties?.configuration?.ingress,
      );
    }
    const sourceMatches = (revision) => revision?.name === snapshot.revision &&
      revision?.properties?.template?.containers?.[0]?.image === snapshot.image &&
      canonicalHash(revision?.properties?.template) === snapshot.templateHash;
    const quiescenceMatches = (revision, requireHealthy) => allowPartialQuiescence &&
      matchesCapturedQuiescenceRevision(
        revision,
        storedApp.properties?.template,
        snapshot.image,
        appName,
        role,
        request.attemptId,
        requireHealthy,
        previousBackendCommit,
      );
    const soleExactRevision = activeRevisions.length === 1 &&
      (sourceMatches(activeRevisions[0]) || quiescenceMatches(activeRevisions[0], true));
    const exactInterruptedReplacement = role === "worker" && activeRevisions.length === 2 &&
      activeRevisions.filter(sourceMatches).length === 1 &&
      activeRevisions.filter((revision) => quiescenceMatches(revision, false)).length === 1;
    if (canonicalHash(liveConfiguration) !== snapshot.configHash ||
      (!soleExactRevision && !exactInterruptedReplacement)) {
      fail(`superseded preparation ${role} source changed after capture`);
    }
  }
  const ingress = appState(
    runner,
    request,
    request.authority.apiContainerAppResourceId,
    "rebindable source API ingress",
  ).properties?.configuration?.ingress;
  if ((apiIngressPosture === "enabled" &&
      (ingress?.external !== true || typeof ingress.fqdn !== "string" || ingress.fqdn.length < 1)) ||
    (apiIngressPosture === "disabled" && ingress !== null)) {
    fail("superseded preparation API ingress does not match its journal boundary");
  }
  return {
    ...source,
    sourceRollbackBaseline: {
      ...baseline,
      deliverySafetyEvidence: verifyDeliverySafetyEvidence(request, options),
      databaseDdlAuthorityEvidence: verifyDatabaseDdlAuthorityEvidence(
        request,
        options.databaseDdlAuthorityEvidence,
      ),
      operationalSmokeEvidence: verifyOperationalSmokeEvidence(request, options),
    },
  };
}

function inspectSourceImage(runner, image, label) {
  runner.run("docker", ["pull", "--platform", "linux/amd64", image], { label: `${label} source image pull` });
  const values = runner.json("docker", ["image", "inspect", image], { label: `${label} source image inspection` });
  if (!Array.isArray(values) || values.length !== 1) fail(`${label} source image inspection is invalid`);
  const value = values[0];
  const ociRevision = value?.Config?.Labels?.["org.opencontainers.image.revision"] ??
    LEGACY_SOURCE_IMAGE_REVISIONS[image];
  string(ociRevision, /^[0-9a-f]{40}$/, `${label} source OCI revision`);
  if (value.Architecture !== "amd64" || value.Os !== "linux") fail(`${label} source image is not linux/amd64`);
  const platformDigest = value.Id?.replace(/^sha256:/, "sha256:");
  string(platformDigest, /^sha256:[0-9a-f]{64}$/, `${label} source platform digest`);
  return { ociRevision, platformDigest };
}

function captureSourceBaseline(runner, request, options) {
  const apiApp = appState(runner, request, request.authority.apiContainerAppResourceId, "source API");
  const workerApp = appState(runner, request, request.authority.workerContainerAppResourceId, "source worker");
  const consoleApp = appState(runner, request, request.authority.consoleContainerAppResourceId, "source console");
  const apiRevision = activeRevision(revisionList(runner, request, API_APP), API_APP);
  const workerRevision = activeRevision(revisionList(runner, request, WORKER_APP), WORKER_APP);
  const consoleRevision = activeRevision(revisionList(runner, request, CONSOLE_APP), CONSOLE_APP);
  for (const [app, role] of [[apiApp, "api"], [workerApp, "worker"], [consoleApp, "console"]]) {
    if (app.properties?.configuration?.activeRevisionsMode !== "Single" || !Number.isSafeInteger(app.properties?.configuration?.maxInactiveRevisions) || app.properties.configuration.maxInactiveRevisions < 1) {
      fail(`${role} source app does not retain an exact inactive rollback revision`);
    }
  }
  const workerContainer = workerRevision.properties.template.containers[0];
  const originalAllowlist = plainEnv(workerContainer, "OUTREACH_LIVE_FOR_ORGS");
  if (originalAllowlist === null ||
    (originalAllowlist.length > 0 && originalAllowlist.trim() === "") ||
    originalAllowlist.split(",").some((entry) => entry.trim() === "*")) {
    fail("source worker live-send allowlist must be present and non-wildcard");
  }
  const originalAllowlistNonempty = originalAllowlist.length > 0;
  if (originalAllowlistNonempty &&
    (process.env.OUTSTANDING_DELIVERY_REVIEW_CONFIRMED !== "true" ||
      process.env.PROVIDER_DELIVERY_DRAIN_CONFIRMED !== "true")) {
    fail("a nonempty source live-send allowlist requires reviewed outstanding delivery and provider-drain evidence");
  }
  const deliverySafetyEvidence = verifyDeliverySafetyEvidence(request, options);
  if (process.env.DATABASE_DDL_EXCLUSIVE_AUTHORITY_CONFIRMED !== "true") {
    fail("protected environment has not confirmed exclusive database DDL authority");
  }
  const databaseDdlAuthorityEvidence = verifyDatabaseDdlAuthorityEvidence(
    request,
    options.databaseDdlAuthorityEvidence,
  );
  const operationalSmokeEvidence = verifyOperationalSmokeEvidence(request, options);
  const imageMetadata = {
    api: inspectSourceImage(runner, apiRevision.properties.template.containers[0].image, "api"),
    worker: inspectSourceImage(runner, workerRevision.properties.template.containers[0].image, "worker"),
    console: inspectSourceImage(runner, consoleRevision.properties.template.containers[0].image, "console"),
  };
  const privateRestoreBundle = {
    schemaVersion: 1,
    kind: "initial-bootstrap-private-source-restore-bundle",
    attemptId: request.attemptId,
    originalAllowlist,
    apiResource: apiApp,
    workerResource: workerApp,
    consoleResource: consoleApp,
    apiRevision: apiRevision,
    workerRevision: workerRevision,
    consoleRevision: consoleRevision,
  };
  const privateRestoreBundleHash = canonicalHash(privateRestoreBundle);
  return {
    privateRestoreBundle,
    sourceRollbackBaseline: {
      compatibilityState: "legacy-readers-no-new-enum-values-v1",
      rollbackPermittedUntil: "before-first-clerk-migration-invocation-only",
      originalAllowlistNonempty,
      originalAllowlistHash: sha256(Buffer.from(originalAllowlist, "utf8")),
      deliverySafetyEvidence,
      databaseDdlAuthorityEvidence,
      operationalSmokeEvidence,
      privateRestoreBundleHash,
      api: sourceSnapshot(apiApp, apiRevision, "api", imageMetadata.api),
      worker: sourceSnapshot(workerApp, workerRevision, "worker", imageMetadata.worker),
      console: sourceSnapshot(consoleApp, consoleRevision, "console", imageMetadata.console),
    },
  };
}

function runRuntimeControl(
  runner,
  request,
  stateDir,
  action,
  generation,
  nextGeneration,
  previousStateHash,
  stableZeroEvidenceHash,
) {
  let ordinal = 1;
  let output = join(stateDir, `runtime-${action}-${generation}-${ordinal}.json`);
  while (existsSync(output)) {
    ordinal += 1;
    output = join(stateDir, `runtime-${action}-${generation}-${ordinal}.json`);
  }
  const args = [
    "--filter", "@apex/api", "exec", "tsx",
    requireSnapshotFile("scripts/production-bootstrap-runtime-control.ts"),
    "--action", action,
    "--attempt-id", request.attemptId,
    "--generation", String(generation),
    "--expected-redis-identity-hash", request.redisIdentityHash,
    "--expected-database-identity-hash", request.databaseIdentityHash,
    "--expected-backend-commit", request.backendCandidate.commit,
    "--authority-subscription-id", request.authority.subscriptionId,
    "--authority-storage-account", request.storage.accountName,
    "--authority-storage-container", request.storage.containerName,
    "--authority-storage-blob", request.storage.blobName,
  ];
  if (nextGeneration !== undefined) {
    if (action !== "renew") fail("only runtime renew accepts a next generation");
    args.push("--next-generation", String(nextGeneration));
  }
  if (previousStateHash !== undefined) {
    if (action !== "resume") fail("only runtime resume accepts a previous state hash");
    args.push("--previous-state-hash", previousStateHash);
  }
  if (stableZeroEvidenceHash !== undefined) {
    if (action !== "recover-orphans") fail("only orphan recovery accepts stable-zero evidence");
    string(stableZeroEvidenceHash, /^sha256:[0-9a-f]{64}$/, "stable-zero evidence hash");
    args.push("--stable-zero-evidence-hash", stableZeroEvidenceHash);
  } else if (action === "recover-orphans") {
    fail("orphan recovery requires stable-zero evidence");
  }
  args.push("--output", output, "--yes");
  if (!new Set(["read", "read-open"]).has(action)) {
    verifyAzureLease(runner, request);
    verifyReleaseLock(runner, request);
  }
  runner.run("corepack", ["pnpm", ...args], {
    label: `production runtime ${action}`,
    env: { ...process.env, WORKFORCE_PRODUCTION_BOOTSTRAP_AUTHORITY_CONFIRMED: "true" },
  });
  return readBoundedJson(output, `runtime ${action} evidence`);
}

function assertRuntimeHeldEvidence(evidence, request, generation) {
  if (
    evidence.bootstrapAttemptId !== request.attemptId ||
    evidence.writerFence?.generation !== generation ||
    evidence.writerFence?.writerZero !== true ||
    evidence.writerFence?.activeWriters !== 0 ||
    evidence.writerFence?.activeComplianceWriters !== 0
  ) {
    fail("runtime hold evidence does not prove the exact closed writer fence");
  }
  for (const key of ["agentRuns", "graphRuns", "outreachSend"]) {
    const queue = evidence.queues?.[key];
    if (queue?.isPaused !== true || queue?.active !== 0) {
      fail(`runtime hold evidence does not prove ${key} paused and idle`);
    }
    // A candidate worker may be connected after B5. Only the B2 entry
    // contract requires all worker counts to be zero. The retired AgentRun
    // queue is the exception and must remain worker-free in every phase.
    safeInteger(queue.workerCount, `runtime hold ${key}.workerCount`, 0);
    if (key === "agentRuns" && queue.workerCount !== 0) {
      fail("runtime hold evidence retains a worker on retired agentRuns");
    }
  }
  string(evidence.evidenceHash, /^sha256:[0-9a-f]{64}$/, "runtime hold evidence hash");
  return evidence;
}

function runQuiescence(
  runner,
  request,
  stateDir,
  action,
  schemaPhase,
  generation,
  workerPosture,
  ordinal,
) {
  if (workerPosture !== "stopped" && workerPosture !== "connected") {
    fail("quiescence worker posture must be explicit");
  }
  const output = join(stateDir, `quiescence-${action}-${schemaPhase}-${ordinal}.json`);
  if (action === "pause") {
    verifyAzureLease(runner, request);
    verifyReleaseLock(runner, request);
  }
  runner.run("corepack", ["pnpm",
    "--filter", "@apex/api", "exec", "tsx",
    requireSnapshotFile("apps/api/src/ops/production-bootstrap-quiescence.cli.ts"),
    "--action", action,
    "--attempt-id", request.attemptId,
    "--schema-phase", schemaPhase,
    "--worker-posture", workerPosture,
    "--expected-redis-identity-hash", request.redisIdentityHash,
    "--expected-database-identity-hash", request.databaseIdentityHash,
    "--expected-backend-commit", request.backendCandidate.commit,
    "--authority-subscription-id", request.authority.subscriptionId,
    "--authority-storage-account", request.storage.accountName,
    "--authority-storage-container", request.storage.containerName,
    "--authority-storage-blob", request.storage.blobName,
    "--writer-fence-generation", String(generation),
    "--output", output,
    "--yes",
  ], {
    label: `production quiescence ${action}`,
    env: { ...process.env, WORKFORCE_PRODUCTION_BOOTSTRAP_AUTHORITY_CONFIRMED: "true" },
  });
  return readBoundedJson(output, `quiescence ${action} evidence`);
}

function azureMutation(runner, request, args, label, releaseLockRequired = true) {
  verifyAzureLease(runner, request);
  if (releaseLockRequired) verifyReleaseLock(runner, request);
  return runner.run("az", azArgs(request, args), { label });
}

function activateRevision(runner, request, role, revision, releaseLockRequired = true) {
  const app = role === "api" ? API_APP : role === "worker" ? WORKER_APP : CONSOLE_APP;
  const existing = revisionList(runner, request, app, true)
    .find((entry) => entry?.name === revision);
  if (!existing) fail(`${app} revision ${revision} is absent`);
  const expectedImage = request.targetArtifacts[role].image;
  if (existing.properties?.template?.containers?.[0]?.image !== expectedImage) {
    fail(`${app} revision ${revision} does not use the admitted image`);
  }
  const expectedTemplate = writableRevisionTemplate(existing.properties.template);
  if (Array.isArray(expectedTemplate.containers?.[0]?.env)) {
    expectedTemplate.containers[0].env.sort((left, right) =>
      String(left?.name).localeCompare(String(right?.name)));
  }
  const initiallyAdopted = existing.properties?.active === true &&
    revisionList(runner, request, app)
      .filter((entry) => entry?.properties?.active === true).length === 1;
  if (!initiallyAdopted) {
    azureMutation(runner, request, [
      "containerapp", "revision", "activate",
      "--name", app,
      "--resource-group", RESOURCE_GROUP,
      "--revision", revision,
      "--output", "none",
    ], `${app} exact revision activation`, releaseLockRequired);
  }
  for (let observation = 0; observation < 36; observation += 1) {
    const revisions = revisionList(runner, request, app);
    const candidate = revisions.find((entry) => entry?.name === revision);
    const activeRevisions = revisions.filter((entry) => entry?.properties?.active === true);
    const health = candidate?.properties?.healthState ?? candidate?.properties?.runningState;
    const provisioned = candidate?.properties?.provisioningState === undefined ||
      candidate.properties.provisioningState === "Provisioned";
    const healthy = candidate?.properties?.active === true && provisioned &&
      new Set(["Healthy", "Running", "Provisioned"]).has(health);
    if (healthy && activeRevisions.length === 1) {
      assertRevisionMatchesUpdate(candidate, expectedTemplate, expectedImage, role);
      return { adopted: initiallyAdopted };
    }
    runner.run("sleep", ["5"], { label: `${role} exact revision activation interval` });
  }
  fail(`${app} exact revision activation did not become solely healthy`);
}

function quiesceAppWithParentWrite(
  runner,
  request,
  role,
  revision,
  sourceRevisionName,
) {
  const app = role === "api" ? API_APP : WORKER_APP;
  const resourceId = role === "api"
    ? request.authority.apiContainerAppResourceId
    : request.authority.workerContainerAppResourceId;
  const before = appState(runner, request, resourceId, `${role} pre-quiescence application`);
  if (before.properties?.configuration?.activeRevisionsMode !== "Single") {
    fail(`${role} quiescence requires single revision mode`);
  }
  let sourceTemplate = before.properties?.template;
  if (sourceRevisionName !== undefined) {
    const sourceRevision = revisionList(runner, request, app)
      .find((entry) => entry?.name === sourceRevisionName);
    if (!sourceRevision || sourceRevision.properties?.active !== true) {
      fail(`${role} containment source revision is absent or inactive`);
    }
    sourceTemplate = sourceRevision.properties?.template;
  }
  const image = sourceTemplate?.containers?.[0]?.image;
  string(
    image,
    /^[a-z0-9.-]+\/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$/,
    `${role} quiescence source image`,
  );
  const expectedTemplate = expectedQuiescenceTemplate(
    sourceTemplate,
    image,
    role,
    sourceRevisionName === undefined,
  );
  const revisionsBefore = revisionList(runner, request, app, true);
  const baseRevision = revision;
  let preexisting;
  for (let attempt = 0; attempt <= 9; attempt += 1) {
    const candidateName = attempt === 0 ? baseRevision : `${baseRevision}-r${attempt}`;
    if (candidateName.length > 54) {
      fail(`${role} quiescence recovery revision name exceeds the Azure limit`);
    }
    const candidate = revisionsBefore.find((entry) => entry?.name === candidateName);
    if (!candidate) {
      revision = candidateName;
      preexisting = undefined;
      break;
    }
    const actual = writableRevisionTemplate(candidate.properties?.template ?? {});
    if (Array.isArray(actual.containers?.[0]?.env)) {
      actual.containers[0].env.sort((left, right) =>
        String(left?.name).localeCompare(String(right?.name)));
    }
    const health = candidate.properties?.healthState ?? candidate.properties?.runningState;
    const healthy = new Set(["Healthy", "Running", "Provisioned"]).has(health) &&
      (candidate.properties?.provisioningState === undefined ||
        candidate.properties.provisioningState === "Provisioned");
    if (candidate.properties?.active === true && healthy &&
      canonicalJson(actual) === canonicalJson(expectedTemplate)) {
      revision = candidateName;
      preexisting = candidate;
      break;
    }
    if (attempt === 9) fail(`${role} exhausted the bounded quiescence recovery sequence`);
  }
  if (!preexisting) {
    azureMutation(runner, request, [
      "rest",
      "--method", "patch",
      "--url", `${resourceId}?api-version=2024-03-01`,
      "--body", canonicalJson({
        properties: {
          template: {
            ...expectedTemplate,
            revisionSuffix: plannedSuffix(revision, app),
          },
        },
      }),
      "--output", "none",
    ], `${role} zero-scale quiescence revision`);
  }
  for (let observation = 0; observation < 36; observation += 1) {
    const revisions = revisionList(runner, request, app);
    const candidate = revisions.find((entry) => entry?.name === revision);
    const active = revisions.filter((entry) => entry?.properties?.active === true);
    const health = candidate?.properties?.healthState ?? candidate?.properties?.runningState;
    const provisioned = candidate?.properties?.provisioningState === undefined ||
      candidate.properties.provisioningState === "Provisioned";
    if (candidate?.properties?.active === true && active.length === 1 && provisioned &&
      new Set(["Healthy", "Running", "Provisioned"]).has(health)) {
      assertRevisionMatchesUpdate(candidate, expectedTemplate, image, `${role} quiescence`);
      assertExactActiveRevision(runner, request, app, revision, image);
      return revision;
    }
    runner.run("sleep", ["5"], { label: `${role} quiescence revision readiness interval` });
  }
  fail(`${role} zero-scale quiescence revision did not become solely active and healthy`);
}

function disableApiIngress(runner, request, releaseLockRequired = true) {
  const before = appState(runner, request, request.authority.apiContainerAppResourceId, "API ingress pre-disable");
  if (before.properties?.configuration?.ingress === null) return { adopted: true };
  azureMutation(runner, request, [
    "rest",
    "--method", "patch",
    "--url", `${request.authority.apiContainerAppResourceId}?api-version=2024-03-01`,
    "--body", canonicalJson({ properties: { configuration: { ingress: null } } }),
    "--output", "none",
  ], "API ingress disable", releaseLockRequired);
  for (let observation = 0; observation < 36; observation += 1) {
    const state = appState(
      runner,
      request,
      request.authority.apiContainerAppResourceId,
      "quiesced API",
    );
    if (state.properties?.configuration?.ingress === null) return { adopted: false };
    runner.run("sleep", ["5"], { label: "API ingress disable readiness interval" });
  }
  fail("API ingress disable readback is ambiguous");
}

function replicaObservation(runner, request, app) {
  const revisions = revisionList(runner, request, app);
  const counts = {};
  for (const revision of revisions) {
    string(revision?.name, /^[a-z0-9][a-z0-9-]{0,62}$/, `${app} revision name`);
    const replicas = runner.json("az", azArgs(request, [
      "containerapp", "replica", "list",
      "--name", app,
      "--resource-group", RESOURCE_GROUP,
      "--revision", revision.name,
      "--output", "json",
    ]), { label: `${app} ${revision.name} replica inventory` });
    if (!Array.isArray(replicas)) fail(`${app} ${revision.name} replica inventory is invalid`);
    counts[revision.name] = replicas.length;
  }
  return {
    observedAt: nowSecond(),
    replicaCount: Object.values(counts).reduce((total, count) => total + count, 0),
    revisions: counts,
  };
}

function proveStableZeroExecutionReplicas(runner, request) {
  const observe = () => ({
    api: replicaObservation(runner, request, API_APP),
    worker: replicaObservation(runner, request, WORKER_APP),
  });
  let first = null;
  for (let observation = 0; observation < 60; observation += 1) {
    const candidate = observe();
    if (candidate.api.replicaCount === 0 && candidate.worker.replicaCount === 0) {
      first = candidate;
      break;
    }
    runner.run("sleep", ["5"], { label: "zero-replica quiescence interval" });
  }
  if (first === null) fail("API or worker replicas did not scale to zero after quiescence");
  runner.run("sleep", ["5"], { label: "stable zero-replica observation interval" });
  const second = observe();
  if (second.api.replicaCount !== 0 || second.worker.replicaCount !== 0) {
    fail("API or worker replicas reappeared after zero-scale quiescence");
  }
  const value = { first, second };
  return { ...value, evidenceHash: canonicalHash(value) };
}

function assertOrphanRecoveryEvidence(runtime, request, stableZeroEvidenceHash) {
  const recovery = runtime?.recovery;
  exactKeys(recovery, [
    "schemaVersion", "target", "bootstrapAttemptId", "generation", "recoveredAt",
    "stableZeroEvidenceHash", "pre", "post",
  ], "orphan writer-token recovery evidence");
  if (runtime.bootstrapAttemptId !== request.attemptId ||
    recovery.schemaVersion !== 1 || recovery.target !== "workforce-os-production" ||
    recovery.bootstrapAttemptId !== request.attemptId ||
    recovery.stableZeroEvidenceHash !== stableZeroEvidenceHash) {
    fail("orphan writer-token recovery identity or stable-zero binding is invalid");
  }
  safeInteger(recovery.generation, "orphan recovery generation", 0);
  canonicalTimestamp(recovery.recoveredAt, "orphan recovery time");
  const keys = [
    "activeApplicationWriters", "activeComplianceWriters",
    "uncertainApplicationWriters", "uncertainComplianceWriters", "tokenSetHash",
  ];
  exactKeys(recovery.pre, keys, "orphan recovery pre-state");
  exactKeys(recovery.post, keys, "orphan recovery post-state");
  for (const section of ["pre", "post"]) {
    for (const key of keys.slice(0, -1)) {
      safeInteger(recovery[section][key], `orphan recovery ${section}.${key}`, 0);
    }
    string(recovery[section].tokenSetHash, /^sha256:[0-9a-f]{64}$/, `orphan recovery ${section} token hash`);
  }
  if (keys.slice(0, -1).some((key) => recovery.post[key] !== 0)) {
    fail("orphan writer-token recovery did not prove all token sets empty");
  }
  string(runtime.evidenceHash, /^sha256:[0-9a-f]{64}$/, "orphan recovery envelope hash");
  return recovery;
}

function queueState(queue) {
  return {
    paused: queue.isPaused,
    waiting: queue.waiting,
    active: queue.active,
    delayed: queue.delayed,
    prioritized: queue.prioritized,
    completed: queue.completed,
    failed: queue.failed,
    waitingChildren: queue.waitingChildren,
    pausedJobs: queue.pausedJobs,
    workerCount: queue.workerCount,
  };
}

function queueObservation(snapshot, stableSince) {
  const queues = {
    agentRuns: queueState(snapshot.queues.agentRuns),
    graphRuns: queueState(snapshot.queues.graphRuns),
    outreachSend: queueState(snapshot.queues.outreachSend),
  };
  return {
    observedAt: snapshot.capturedAt,
    stableSince,
    evidenceHash: canonicalHash(queues),
    queues,
  };
}

function closedWriterFenceEvidence(readback) {
  const state = readback?.state;
  if (!state) fail("closed writer-fence evidence is absent");
  return {
    schemaVersion: state.schemaVersion,
    target: state.target,
    mode: state.mode,
    bootstrapAttemptId: state.bootstrapAttemptId,
    generation: state.generation,
    issuedAt: state.issuedAt,
    observedAt: readback.observedAt,
    expiresAt: state.expiresAt,
    stateHash: readback.stateHash,
    activeWriters: readback.activeWriters,
    activeComplianceWriters: readback.activeComplianceWriters,
  };
}

function closedQuiescence(first, second) {
  const value = {
    nonComplianceApiMutationsBlocked: true,
    liveSendAllowlistEmpty: true,
    queueObservations: [
      queueObservation(first, first.capturedAt),
      queueObservation(second, first.capturedAt),
    ],
    writerFence: closedWriterFenceEvidence(second.writerFence),
  };
  return { ...value, evidenceHash: canonicalHash(value) };
}

function phaseContext(state, request, receiptKind, evidence, fencingGeneration, observedAt) {
  const ledger = verifyLedgerBytes(Buffer.from(state.phaseLedgerBase64, "base64")).ledger;
  const previousReceiptSha256 = ledger.receipts.at(-1)?.sha256;
  if (!previousReceiptSha256) fail(`${receiptKind} context has no predecessor receipt`);
  return buildFinalPhaseContext({
    receiptKind,
    identity: ledger.identity,
    fencingGeneration,
    previousReceiptSha256,
    observedAt,
    evidence,
  });
}

export function buildAdmissionContext(
  request,
  source,
  firstSnapshot,
  secondSnapshot,
  leaseObservedAt,
  clerkReconciliationPlan,
  legacyReplicaEvidence,
  orphanRecoveryEvidence,
) {
  const firstObservation = queueObservation(firstSnapshot, firstSnapshot.capturedAt);
  const secondObservation = queueObservation(secondSnapshot, firstSnapshot.capturedAt);
  const privateRestoreBundleHash = source.sourceRollbackBaseline.privateRestoreBundleHash;
  const quiescenceWithoutHash = {
    api: {
      stopped: true,
      activeRevisionCount: 1,
      replicaCount: legacyReplicaEvidence.second.api.replicaCount,
      ingressDisabled: true,
    },
    worker: {
      stopped: true,
      activeRevisionCount: 1,
      replicaCount: legacyReplicaEvidence.second.worker.replicaCount,
      consumersDisabled: true,
    },
    queueObservations: [firstObservation, secondObservation],
    writerFence: {
      schemaVersion: secondSnapshot.writerFence.schemaVersion,
      target: secondSnapshot.writerFence.target,
      observedAt: secondSnapshot.writerFence.observedAt,
      generation: secondSnapshot.writerFence.generation,
      state: secondSnapshot.writerFence.state,
      stateHash: secondSnapshot.writerFence.stateHash,
      activeWriters: secondSnapshot.writerFence.activeWriters,
      activeComplianceWriters: secondSnapshot.writerFence.activeComplianceWriters,
      writerZero: secondSnapshot.writerFence.writerZero,
    },
    orphanRecovery: orphanRecoveryEvidence,
    inventory: secondSnapshot.database,
    liveSendAllowlistEmpty: true,
    privateRestoreBundleHash,
  };
  const quiescedState = { ...quiescenceWithoutHash, evidenceHash: canonicalHash(quiescenceWithoutHash) };
  if (quiescedState.api.replicaCount !== 0 || quiescedState.worker.replicaCount !== 0) {
    fail("admission context requires observed stable zero API and worker replicas");
  }
  const writerExpiry = secondSnapshot.writerFence?.state?.expiresAt;
  string(writerExpiry, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, "writer fence expiry");
  return {
    schemaVersion: 1,
    environment: ENVIRONMENT,
    kind: CONTEXT_KIND,
    generatedBy: CONTROLLER_ID,
    bootstrapAttemptId: request.attemptId,
    backendCandidateCommit: request.backendCandidate.commit,
    consoleCandidateCommit: request.consoleCandidate.commit,
    authority: request.authority,
    releaseLock: {
      repository: RELEASE_REPOSITORY_URL,
      ref: RELEASE_LOCK_REF,
      objectSha: request.backendCandidate.commit,
    },
    redisIdentityHash: request.redisIdentityHash,
    databaseIdentityHash: request.databaseIdentityHash,
    lease: {
      token: leaseTokenHash(request).slice("sha256:".length),
      generation: 3,
      observedAt: leaseObservedAt,
      expiresAt: writerExpiry,
    },
    targetArtifacts: request.targetArtifacts,
    sourceRollbackBaseline: source.sourceRollbackBaseline,
    clerkReconciliationPlan,
    quiescedState,
  };
}

function acquireReleaseLock(runner, request, stateDir) {
  // The Git ref intentionally points to the admitted candidate commit so it
  // remains compatible with the signed entry contract. Attempt identity is
  // supplied by the stronger fixed-blob control: the exact attempt must own
  // the infinite Azure lease and its request-bound journal before a same-SHA
  // ref can be adopted. A stale ref alone is therefore never authority.
  verifyAzureLease(runner, request);
  const adoptionDocument = downloadLeasedDocumentMaybe(
    runner,
    request,
    join(stateDir, "release-lock-adoption-authority.json"),
  );
  if (adoptionDocument?.kind === PREPARATION_JOURNAL_KIND) {
    validatePreparationJournal(adoptionDocument, request);
  } else if (adoptionDocument?.kind === STATE_KIND) {
    validateState(adoptionDocument, request);
  } else {
    fail("release-lock adoption lacks the exact leased attempt journal");
  }
  const existing = readReleaseLock(runner);
  if (existing !== null) {
    if (existing.ref === RELEASE_LOCK_REF && existing.object?.sha === request.backendCandidate.commit &&
      existing.object?.type === "commit") return { adopted: true };
    fail("production release lock is already owned by a different object");
  }
  const lockDir = join(stateDir, "release-lock.git");
  mkdirSync(lockDir, { mode: 0o700 });
  runner.run("git", ["init", "--bare", "--template=", lockDir], { label: "release lock repository initialization" });
  const credentialArgs = ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"];
  runner.run(requireSnapshotFile("scripts/run-release-git.sh", true), [...credentialArgs, "--git-dir", lockDir, "fetch", "--no-tags", "--depth=1", RELEASE_REPOSITORY_URL, request.backendCandidate.commit], { label: "release lock source fetch" });
  const fetched = runner.run(requireSnapshotFile("scripts/run-release-git.sh", true), ["--git-dir", lockDir, "rev-parse", "FETCH_HEAD"], { label: "release lock source identity" }).stdout.toString("utf8").trim();
  if (fetched !== request.backendCandidate.commit) fail("release lock fetched a different source commit");
  try {
    runner.run(requireSnapshotFile("scripts/run-release-git.sh", true), [
      ...credentialArgs,
      "--git-dir", lockDir,
      "push", `--force-with-lease=${RELEASE_LOCK_REF}:`,
      RELEASE_REPOSITORY_URL,
      `${request.backendCandidate.commit}:${RELEASE_LOCK_REF}`,
    ], { label: "production release lock acquisition" });
  } catch (error) {
    // A lost push acknowledgement is safe to adopt only when the remote ref
    // now names the exact admitted commit. Any other result remains fatal.
    const after = readReleaseLock(runner);
    if (after?.ref !== RELEASE_LOCK_REF || after.object?.sha !== request.backendCandidate.commit ||
      after.object?.type !== "commit") throw error;
    return { adopted: true, acknowledgementUncertain: true };
  }
  verifyReleaseLock(runner, request);
  return { adopted: false };
}

function rebindReleaseLockForPreparation(runner, request, stateDir, previousBackendCommit) {
  verifyAzureLease(runner, request);
  const existing = readReleaseLock(runner);
  if (existing?.ref === RELEASE_LOCK_REF &&
    existing.object?.sha === request.backendCandidate.commit &&
    existing.object?.type === "commit") {
    return { adopted: true };
  }
  if (existing?.ref !== RELEASE_LOCK_REF || existing.object?.sha !== previousBackendCommit ||
    existing.object?.type !== "commit") {
    fail("superseded production release lock does not match the rebindable journal");
  }
  const lockDir = join(stateDir, "release-lock-rebind.git");
  mkdirSync(lockDir, { mode: 0o700 });
  runner.run("git", ["init", "--bare", "--template=", lockDir], {
    label: "release lock rebind repository initialization",
  });
  const credentialArgs = ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"];
  runner.run(requireSnapshotFile("scripts/run-release-git.sh", true), [
    ...credentialArgs, "--git-dir", lockDir, "fetch", "--no-tags", "--depth=1",
    RELEASE_REPOSITORY_URL, request.backendCandidate.commit,
  ], { label: "release lock rebind source fetch" });
  const fetched = runner.run(requireSnapshotFile("scripts/run-release-git.sh", true), [
    "--git-dir", lockDir, "rev-parse", "FETCH_HEAD",
  ], { label: "release lock rebind source identity" }).stdout.toString("utf8").trim();
  if (fetched !== request.backendCandidate.commit) fail("release lock rebind fetched a different source commit");
  try {
    runner.run(requireSnapshotFile("scripts/run-release-git.sh", true), [
      ...credentialArgs,
      "--git-dir", lockDir,
      "push", `--force-with-lease=${RELEASE_LOCK_REF}:${previousBackendCommit}`,
      RELEASE_REPOSITORY_URL,
      `${request.backendCandidate.commit}:${RELEASE_LOCK_REF}`,
    ], { label: "production release lock pre-mutation rebind" });
  } catch (error) {
    const after = readReleaseLock(runner);
    if (after?.ref !== RELEASE_LOCK_REF || after.object?.sha !== request.backendCandidate.commit ||
      after.object?.type !== "commit") throw error;
    return { adopted: true, acknowledgementUncertain: true };
  }
  verifyReleaseLock(runner, request);
  return { adopted: false };
}

function readReleaseLock(runner) {
  const result = runner.run("gh", [
    "api", `repos/${RELEASE_REPOSITORY}/git/ref/${RELEASE_LOCK_REF.replace("refs/", "")}`,
  ], { label: "production release lock inspection", allowFailure: true });
  if (result.status !== 0 && /HTTP 404\b/.test(result.stderr.toString("utf8"))) return null;
  if (result.status !== 0) fail("production release lock inspection failed");
  return strictJsonParse(result.stdout, "production release lock inspection");
}

function verifyReleaseLock(runner, request) {
  const value = readReleaseLock(runner);
  if (value?.ref !== RELEASE_LOCK_REF || value.object?.sha !== request.backendCandidate.commit || value.object?.type !== "commit") fail("production release lock is absent or changed");
}

function releaseReleaseLock(runner, request, stateDir) {
  const existing = readReleaseLock(runner);
  if (existing === null) return { adopted: true };
  if (existing.ref !== RELEASE_LOCK_REF || existing.object?.sha !== request.backendCandidate.commit ||
    existing.object?.type !== "commit") {
    fail("production release lock changed before conditional cleanup");
  }
  const lockDir = join(stateDir, "release-lock-cleanup.git");
  mkdirSync(lockDir, { mode: 0o700 });
  if (!existsSync(join(lockDir, "HEAD"))) {
    runner.run("git", ["init", "--bare", "--template=", lockDir], { label: "release lock cleanup repository initialization" });
  }
  try {
    runner.run(requireSnapshotFile("scripts/run-release-git.sh", true), [
      "-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential",
      "--git-dir", lockDir,
      "push", `--force-with-lease=${RELEASE_LOCK_REF}:${request.backendCandidate.commit}`,
      RELEASE_REPOSITORY_URL,
      `:${RELEASE_LOCK_REF}`,
    ], { label: "production release lock conditional release" });
  } catch (error) {
    if (readReleaseLock(runner) !== null) throw error;
    return { adopted: true, acknowledgementUncertain: true };
  }
  if (readReleaseLock(runner) !== null) fail("production release lock cleanup readback is ambiguous");
  return { adopted: false };
}

function writeNewEvidence(path, value) {
  validateExternalPath(path, "evidence output", { mustExist: false });
  writeFileSync(path, `${canonicalJson(value)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
}

function createInitialState(
  request,
  source,
  context,
  ledgerResult,
  clerkReconciliation,
) {
  const contextBytes = Buffer.from(`${canonicalJson(context)}\n`, "utf8");
  return {
    schemaVersion: 1,
    environment: ENVIRONMENT,
    kind: STATE_KIND,
    attemptId: request.attemptId,
    requestSha256: canonicalHash(request),
    azureLeaseTokenHash: leaseTokenHash(request),
    leaseIdHash: leaseIdHash(request),
    fencingGeneration: ledgerResult.ledger.fencingGeneration,
    writerFenceGeneration: 3,
    phaseLedgerBase64: Buffer.from(ledgerResult.ledgerBytes).toString("base64"),
    phaseLedgerSha256: ledgerResult.ledgerSha256,
    sourceRollbackBaseline: source.sourceRollbackBaseline,
    privateRestoreBundle: source.privateRestoreBundle,
    admissionContextBase64: contextBytes.toString("base64"),
    admissionContextSha256: sha256(contextBytes),
    clerkReconciliationPlanBase64: clerkReconciliation.planBytes.toString("base64"),
    clerkReconciliationPlanSignatureBase64:
      clerkReconciliation.signatureBytes.toString("base64"),
    clerkReconciliationDryRunBase64: clerkReconciliation.dryRunBytes.toString("base64"),
    clerkReconciliationDryRunSignatureBase64:
      clerkReconciliation.dryRunSignatureBytes.toString("base64"),
    clerkReconciliationPlanBinding: clerkReconciliation.binding,
    migrationProgress: [],
    phaseEvidence: { prepared: context.quiescedState.evidenceHash },
    activeIdentities: {},
    updatedAt: ledgerResult.ledger.updatedAt,
  };
}

function prepare(runner, request, options) {
  // Freeze and verify the row-bearing reconciliation authority before any
  // cloud, queue, application, or database mutation.
  const clerkReconciliation = verifyClerkReconciliationPlan(
    runner,
    request,
    options,
  );
  auditPreconditions(runner, request);
  acquireAzureLease(runner, request);
  const leaseObservedAt = nowSecond();
  const existing = downloadLeasedDocumentMaybe(runner, request, options.statePath);
  let journal;
  if (existing === null) {
    journal = preparationJournal(request, clerkReconciliation);
    // This is the first durable write after the deterministic lease. It makes
    // an acknowledged-uncertain lease acquisition resumable without a break.
    uploadState(runner, request, journal, options.statePath);
  } else if (existing.kind === PREPARATION_JOURNAL_KIND) {
    if (existing.requestSha256 === canonicalHash(request)) {
      journal = validatePreparationJournal(existing, request);
    } else {
      const superseded = validateRebindablePreparationJournal(existing, request);
      verifySupersededPreparationSignatures(runner, request, options, superseded);
      const reboundSource = superseded.sourceReadbackPosture === null
        ? null
        : refreshCapturedSourceForRebind(
          runner,
          request,
          options,
          superseded.journal.source,
          superseded.sourceReadbackPosture,
          superseded.allowPartialQuiescence,
          superseded.previousBackendCommit,
        );
      if (superseded.requireHeldRuntime) {
        const previousRequest = {
          ...request,
          backendCandidate: {
            ...request.backendCandidate,
            commit: superseded.previousBackendCommit,
          },
        };
        const held = assertRuntimeHeldEvidence(
          runRuntimeControl(
            runner,
            previousRequest,
            options.stateDir,
            "read",
            3,
          ),
          previousRequest,
          3,
        );
        if (["agentRuns", "graphRuns", "outreachSend"]
          .some((key) => held.queues[key].workerCount !== 0)) {
          fail("superseded preparation runtime still has connected queue workers");
        }
      }
      rebindReleaseLockForPreparation(
        runner,
        request,
        options.stateDir,
        superseded.previousBackendCommit,
      );
      journal = {
        ...preparationJournal(request, clerkReconciliation),
        source: reboundSource,
      };
      uploadState(runner, request, journal, options.statePath);
    }
    if (journal.clerkReconciliationPlanBase64 !== clerkReconciliation.planBytes.toString("base64") ||
      journal.clerkReconciliationPlanSignatureBase64 !== clerkReconciliation.signatureBytes.toString("base64") ||
      journal.clerkReconciliationDryRunBase64 !== clerkReconciliation.dryRunBytes.toString("base64") ||
      journal.clerkReconciliationDryRunSignatureBase64 !== clerkReconciliation.dryRunSignatureBytes.toString("base64") ||
      canonicalJson(journal.clerkReconciliationPlanBinding) !== canonicalJson(clerkReconciliation.binding)) {
      fail("resumed preparation supplied different Clerk reconciliation authority");
    }
  } else if (existing.kind === STATE_KIND) {
    if (existing.requestSha256 === canonicalHash(request)) {
      const resumed = validateState(existing, request);
      if (resumed.ledger.phase !== "B1_CONTROL_ACQUIRED") {
        fail("prepare cannot replace an already advanced or consumed bootstrap state");
      }
      materializeContext(existing, options.output);
      return { phase: "B1_CONTROL_ACQUIRED", alreadyPrepared: true, controlsHeld: true };
    }
    const superseded = validateRebindablePreparedState(
      existing,
      request,
      options.supersededRequest,
    );
    verifySupersededPreparationSignatures(runner, request, options, superseded);
    const reboundSource = refreshCapturedSourceForRebind(
      runner,
      request,
      options,
      superseded.source,
      "disabled",
      true,
      superseded.previousBackendCommit,
    );
    const held = assertRuntimeHeldEvidence(
      runRuntimeControl(
        runner,
        superseded.request,
        options.stateDir,
        "read",
        existing.writerFenceGeneration,
      ),
      superseded.request,
      existing.writerFenceGeneration,
    );
    if (["agentRuns", "graphRuns", "outreachSend"]
      .some((key) => held.queues[key].workerCount !== 0)) {
      fail("superseded prepared state still has connected queue workers");
    }
    rebindReleaseLockForPreparation(
      runner,
      request,
      options.stateDir,
      superseded.previousBackendCommit,
    );
    journal = {
      ...preparationJournal(request, clerkReconciliation),
      source: reboundSource,
    };
    uploadState(runner, request, journal, options.statePath);
  } else {
    fail("leased bootstrap blob contains an unknown or stale document");
  }
  let controlsMutated = false;
  try {
    journal = journalMutation(runner, request, options, journal, "acquire-release-lock", "started", "B0_RELEASE_LOCK_INTENT");
    acquireReleaseLock(runner, request, options.stateDir);
    verifyReleaseLock(runner, request);
    journal = journalMutation(runner, request, options, journal, "acquire-release-lock", "completed", "B0_RELEASE_LOCK_ACQUIRED");
    let source = journal.source;
    if (source === null) {
      journal = journalMutation(runner, request, options, journal, "capture-source-baseline", "started", "B0_SOURCE_CAPTURE_INTENT");
      source = captureSourceBaseline(runner, request, options);
      journal = journalMutation(runner, request, options, journal, "capture-source-baseline", "completed", "B0_SOURCE_CAPTURED", { source });
    }
    journal = journalMutation(runner, request, options, journal, "disable-api-ingress", "started", "B0_API_INGRESS_DISABLE_INTENT");
    // From the first possible side effect onward, any lost acknowledgement
    // leaves the deterministic lease and release lock held for exact replay.
    controlsMutated = true;
    disableApiIngress(runner, request);
    journal = journalMutation(runner, request, options, journal, "disable-api-ingress", "completed", "B0_API_INGRESS_DISABLED");
    journal = journalMutation(runner, request, options, journal, "pause-queues", "started", "B0_QUEUE_PAUSE_INTENT");
    runRuntimeControl(runner, request, options.stateDir, "pause-only", 3);
    journal = journalMutation(runner, request, options, journal, "pause-queues", "completed", "B0_QUEUES_PAUSED");
    journal = journalMutation(runner, request, options, journal, "stop-app-revisions", "started", "B0_APP_STOP_INTENT");
    quiesceAppWithParentWrite(
      runner,
      request,
      "api",
      quiescenceRevisionName(
        API_APP,
        "api",
        request.attemptId,
        request.backendCandidate.commit,
      ),
    );
    quiesceAppWithParentWrite(
      runner,
      request,
      "worker",
      quiescenceRevisionName(
        WORKER_APP,
        "worker",
        request.attemptId,
        request.backendCandidate.commit,
      ),
    );
    const legacyReplicaEvidence = proveStableZeroExecutionReplicas(runner, request);
    journal = journalMutation(runner, request, options, journal, "stop-app-revisions", "completed", "B0_APPS_STOPPED");
    journal = journalMutation(runner, request, options, journal, "recover-orphan-writer-tokens", "started", "B0_ORPHAN_RECOVERY_INTENT");
    const orphanRecoveryEvidence = assertOrphanRecoveryEvidence(
      runRuntimeControl(
        runner,
        request,
        options.stateDir,
        "recover-orphans",
        3,
        undefined,
        undefined,
        legacyReplicaEvidence.evidenceHash,
      ),
      request,
      legacyReplicaEvidence.evidenceHash,
    );
    journal = journalMutation(runner, request, options, journal, "recover-orphan-writer-tokens", "completed", "B0_ORPHAN_TOKENS_RECOVERED");
    // Queue claims are now globally paused and drained, legacy execution
    // replicas are stably zero, and ingress is disabled. Only now may the
    // atomic application writer fence close; it rejects any surviving lease.
    journal = journalMutation(runner, request, options, journal, "arm-writer-fence", "started", "B0_WRITER_FENCE_INTENT");
    runRuntimeControl(runner, request, options.stateDir, "arm", 3);
    journal = journalMutation(runner, request, options, journal, "arm-writer-fence", "completed", "B0_WRITER_FENCE_ARMED");
    const first = runQuiescence(runner, request, options.stateDir, "verify", "pre-migration", 3, "stopped", 1);
    runner.run("sleep", ["5"], { label: "stable queue observation interval" });
    const second = runQuiescence(runner, request, options.stateDir, "verify", "pre-migration", 3, "stopped", 2);
    const context = buildAdmissionContext(
      request,
      source,
      first,
      second,
      leaseObservedAt,
      clerkReconciliation.binding,
      legacyReplicaEvidence,
      orphanRecoveryEvidence,
    );
    const contextBytes = Buffer.from(`${canonicalJson(context)}\n`, "utf8");
    const admissionContextHash = sha256(contextBytes);
    let ledgerResult = createLedger({
      identity: {
        attemptId: request.attemptId,
        candidate: {
          backendCommit: request.backendCandidate.commit,
          consoleCommit: request.consoleCandidate.commit,
          apiImage: request.targetArtifacts.api.image,
          workerImage: request.targetArtifacts.worker.image,
          consoleImage: request.targetArtifacts.console.image,
        },
        databaseIdentityHash: request.databaseIdentityHash,
        redisIdentityHash: request.redisIdentityHash,
        azureIdentityHash: azureAuthorityIdentityHash(request.authority),
        admissionContextHash,
      },
      governance: { operator: request.operator, approver: request.approver, changeTicket: request.changeTicket },
      fencingGeneration: 1,
      at: nowSecond(),
    });
    ledgerResult = advanceLedger(ledgerResult.ledgerBytes, {
      toPhase: "B1_CONTROL_ACQUIRED",
      fencingGeneration: 2,
      at: nowSecond(),
    });
    const state = createInitialState(
      request,
      source,
      context,
      ledgerResult,
      clerkReconciliation,
    );
    uploadState(runner, request, state, options.statePath);
    writeNewEvidence(options.output, context);
    return { phase: "B1_CONTROL_ACQUIRED", admissionContextSha256: admissionContextHash, controlsHeld: true };
  } catch (error) {
    // Once any durable control changes, cleanup is forbidden: the next exact
    // attempt invocation must inspect and hold/restore it. Azure lease remains.
    if (controlsMutated) {
      process.stderr.write("ERROR: bootstrap preparation is uncertain; retaining Azure lease, release lock, writer fence, and queue controls\n");
    }
    throw error;
  }
}

function materializeContext(state, path) {
  const bytes = Buffer.from(state.admissionContextBase64, "base64");
  if (sha256(bytes) !== state.admissionContextSha256) fail("stored admission context bytes are corrupt");
  writeFileSync(path, bytes, { mode: 0o600, flag: "wx" });
}

function reverifyFrozenClerkPlan(runner, request, state, options) {
  const paths = {
    clerkPlan: join(options.stateDir, "clerk-reconciliation-plan-stored.json"),
    clerkPlanSignature: join(options.stateDir, "clerk-reconciliation-plan-stored.sig"),
    clerkPlanDryRun: join(options.stateDir, "clerk-reconciliation-dry-run-stored.json"),
    clerkPlanDryRunSignature: join(options.stateDir, "clerk-reconciliation-dry-run-stored.sig"),
    allowedSigners: options.allowedSigners,
  };
  for (const [key, stateKey] of [
    ["clerkPlan", "clerkReconciliationPlanBase64"],
    ["clerkPlanSignature", "clerkReconciliationPlanSignatureBase64"],
    ["clerkPlanDryRun", "clerkReconciliationDryRunBase64"],
    ["clerkPlanDryRunSignature", "clerkReconciliationDryRunSignatureBase64"],
  ]) {
    writeFileSync(paths[key], Buffer.from(state[stateKey], "base64"), {
      mode: 0o600,
      flag: "wx",
    });
  }
  const verified = verifyClerkReconciliationPlan(runner, request, paths);
  if (canonicalJson(verified.binding) !== canonicalJson(state.clerkReconciliationPlanBinding)) {
    fail("stored Clerk reconciliation authority drift detected");
  }
  return { ...verified, paths };
}

function verifyEntryReceipt(runner, request, state, options) {
  for (const [path, label] of [[options.receipt, "entry receipt"], [options.signature, "entry signature"], [options.allowedSigners, "allowed signers"]]) {
    validateExternalPath(path, label);
  }
  const contextPath = join(options.stateDir, "admission-context-stored.json");
  materializeContext(state, contextPath);
  runner.run(requireSnapshotFile("scripts/verify-production-bootstrap-entry-receipt.sh", true), [
    options.receipt,
    options.signature,
    options.allowedSigners,
    request.backendCandidate.commit,
    request.consoleCandidate.commit,
    request.attemptId,
    contextPath,
  ], { label: "signed bootstrap entry verification" });
  return readFileSync(options.receipt);
}

function verifyPhaseReceipt(
  runner,
  request,
  state,
  options,
  kind,
  evidencePath,
  predecessorOffset = 1,
) {
  for (const [path, label] of [[options.receipt, `${kind} receipt`], [options.signature, `${kind} signature`], [options.allowedSigners, "allowed signers"], [evidencePath, `${kind} evidence context`]]) {
    validateExternalPath(path, label);
  }
  const verifiedLedger = verifyLedgerBytes(Buffer.from(state.phaseLedgerBase64, "base64"));
  safeInteger(predecessorOffset, `${kind} predecessor receipt offset`, 1);
  const previousReceipt = verifiedLedger.ledger.receipts.at(-predecessorOffset);
  if (!previousReceipt?.bytesBase64) fail(`${kind} has no exact predecessor receipt bytes`);
  const previousReceiptPath = join(options.stateDir, `${kind}-previous-receipt.json`);
  writeFileSync(previousReceiptPath, Buffer.from(previousReceipt.bytesBase64, "base64"), {
    mode: 0o600,
    flag: "wx",
  });
  const args = [
    options.receipt,
    options.signature,
    options.allowedSigners,
    request.backendCandidate.commit,
    request.consoleCandidate.commit,
    request.attemptId,
    kind,
    previousReceiptPath,
    evidencePath,
  ];
  if (predecessorOffset > 1) {
    const admitted = verifiedLedger.ledger.receipts.at(-1);
    if (admitted?.kind !== kind ||
      admitted.bytesBase64 !== readFileSync(options.receipt).toString("base64")) {
      fail(`${kind} replay receipt is not the exact historically admitted receipt`);
    }
    const admittedEpoch = Math.floor(
      Date.parse(admitted.admittedAt) / 1000,
    );
    if (!Number.isSafeInteger(admittedEpoch) || admittedEpoch < 1) {
      fail(`${kind} replay admission time is invalid`);
    }
    args.push(String(admittedEpoch));
  }
  runner.run(requireSnapshotFile("scripts/verify-production-bootstrap-phase-receipt.sh", true), args, { label: `signed ${kind} verification` });
  return readFileSync(options.receipt);
}

function extractMigration(runner, request, stateDir, path, expectedHash) {
  const result = runner.run(requireSnapshotFile("scripts/run-release-git.sh", true), ["-C", REPO_ROOT, "show", `${request.backendCandidate.commit}:${path}`], { label: `exact migration ${path}` });
  const actualHash = sha256(result.stdout);
  if (actualHash !== expectedHash) fail(`exact migration hash mismatch for ${path}`);
  const output = join(stateDir, `migration-${MIGRATIONS.indexOf(path) + 1}.sql`);
  writeFileSync(output, result.stdout, { mode: 0o600, flag: "wx" });
  return output;
}

function assertProtectedPostgresEnvironment() {
  for (const name of ["PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGSSLMODE", "PGPASSFILE"]) {
    if (!process.env[name]) fail(`protected PostgreSQL environment ${name} is absent`);
  }
  if (process.env.PGSSLMODE === "verify-full" && process.env.PGSSLROOTCERT !== "system") {
    fail("protected PostgreSQL verify-full mode requires the system trust store");
  }
  validateExternalPath(process.env.PGPASSFILE, "PGPASSFILE");
  const passMode = statSync(process.env.PGPASSFILE).mode & 0o777;
  if (passMode !== 0o600) fail("PGPASSFILE must have mode 0600");
}

function protectedPostgresCommandEnvironment() {
  return {
    ...process.env,
    PGAPPNAME: "workforce-production-bootstrap-controller",
    PGCONNECT_TIMEOUT: "5",
    // Never inherit a caller-controlled search_path into DDL/DML sessions.
    // PostgreSQL implicitly searches pg_catalog before this literal schema.
    PGOPTIONS: "-c search_path=public,pg_temp -c lock_timeout=5000 -c statement_timeout=900000 -c idle_in_transaction_session_timeout=60000",
  };
}

function assertPersistedDatabaseDdlAuthority(request, state) {
  if (process.env.DATABASE_DDL_EXCLUSIVE_AUTHORITY_CONFIRMED !== "true") {
    fail("protected environment no longer confirms exclusive database DDL authority");
  }
  const binding = state.sourceRollbackBaseline?.databaseDdlAuthorityEvidence;
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
    fail("controller state has no persisted database DDL authority binding");
  }
  exactKeys(binding, [
    "schemaVersion", "environment", "kind", "bootstrapAttemptId",
    "backendCandidateCommit", "evidenceHash", "reviewer", "reviewedAt", "expiresAt", "databaseIdentityHash",
    "authorityScope", "exclusiveDdlAuthorityConfirmed", "verifiedFromProtectedBytes",
  ], "persisted database DDL authority");
  if (binding.schemaVersion !== 1 || binding.environment !== ENVIRONMENT ||
    binding.kind !== "production-database-ddl-exclusive-authority" ||
    binding.bootstrapAttemptId !== request.attemptId ||
    binding.backendCandidateCommit !== request.backendCandidate.commit ||
    binding.evidenceHash !== request.bootstrapEvidence.databaseDdlAuthorityEvidenceHash ||
    binding.reviewer !== request.approver ||
    binding.databaseIdentityHash !== request.databaseIdentityHash ||
    binding.authorityScope !== "all-production-database-ddl-actors" ||
    binding.exclusiveDdlAuthorityConfirmed !== true ||
    binding.verifiedFromProtectedBytes !== true) {
    fail("persisted database DDL authority does not bind this exact attempt");
  }
  validateReviewWindow(binding, "persisted database DDL authority");
  return binding;
}

function assertPersistedOperationalSmokeEvidence(request, state) {
  const evidence = state.sourceRollbackBaseline?.operationalSmokeEvidence;
  exactKeys(evidence, ["failedList", "dashboardPolicy", "verifiedFromProtectedBytes"],
    "persisted operational smoke evidence");
  if (evidence.verifiedFromProtectedBytes !== true) {
    fail("persisted operational smoke evidence was not verified from protected bytes");
  }
  const definitions = [
    [
      evidence.failedList,
      "production-failed-list-smoke",
      "api-failed-outreach-list",
      request.bootstrapEvidence.failedListSmokeEvidenceHash,
      "persisted failed-list smoke evidence",
    ],
    [
      evidence.dashboardPolicy,
      "production-dashboard-policy-smoke",
      "console-dashboard-policy",
      request.bootstrapEvidence.dashboardPolicySmokeEvidenceHash,
      "persisted dashboard-policy smoke evidence",
    ],
  ];
  for (const [value, kind, scope, expectedHash, label] of definitions) {
    exactKeys(value, [
      "schemaVersion", "environment", "kind", "bootstrapAttemptId",
      "backendCandidateCommit", "consoleCandidateCommit", "evidenceHash", "reviewer",
      "reviewedAt", "expiresAt", "scope", "passed",
    ], label);
    if (value.schemaVersion !== 1 || value.environment !== ENVIRONMENT ||
      value.kind !== kind || value.bootstrapAttemptId !== request.attemptId ||
      value.backendCandidateCommit !== request.backendCandidate.commit ||
      value.consoleCandidateCommit !== request.consoleCandidate.commit ||
      value.evidenceHash !== expectedHash || value.reviewer !== request.approver ||
      value.scope !== scope || value.passed !== true) {
      fail(`${label} does not bind the exact admitted production candidates`);
    }
    validateReviewWindow(value, label);
  }
  return evidence;
}

function verifyProtectedPostgresIdentity(runner, request) {
  assertProtectedPostgresEnvironment();
  const result = runner.run("psql", [
    "--no-psqlrc", "--set=ON_ERROR_STOP=1", "--quiet", "--tuples-only", "--no-align",
    "--command", PRODUCTION_DATABASE_IDENTITY_QUERY,
  ], {
    label: "protected PostgreSQL identity probe",
    env: protectedPostgresCommandEnvironment(),
    allowFailure: true,
    timeoutMs: 30 * 1_000,
  });
  if (result.status !== 0) fail("protected PostgreSQL identity probe failed");
  return assertProductionDatabaseIdentityOutput(result.stdout, request.databaseIdentityHash);
}

function psqlMigration(runner, request, state, migrationPath) {
  assertPersistedDatabaseDdlAuthority(request, state);
  const identity = verifyProtectedPostgresIdentity(runner, request);
  verifyAzureLease(runner, request);
  verifyReleaseLock(runner, request);
  const result = runner.run("psql", [
    "--no-psqlrc", "--set=ON_ERROR_STOP=1",
    "--command", productionDatabaseIdentityAssertionSql(identity),
    `--file=${migrationPath}`,
  ], {
    label: `production migration ${migrationPath}`,
    env: protectedPostgresCommandEnvironment(),
    allowFailure: true,
    timeoutMs: 16 * 60 * 1_000,
  });
  if (result.status !== 0) fail(`production migration ${migrationPath} failed`);
  return result;
}

function psqlDropIndexConcurrently(runner, request, state, indexName) {
  if (!REPLY_REPAIR_INDEXES.includes(indexName)) {
    fail("reply single-flight repair index is outside the fixed verifier allowlist");
  }
  assertPersistedDatabaseDdlAuthority(request, state);
  const identity = verifyProtectedPostgresIdentity(runner, request);
  verifyAzureLease(runner, request);
  verifyReleaseLock(runner, request);
  const result = runner.run("psql", [
    "--no-psqlrc",
    "--set=ON_ERROR_STOP=1",
    "--command",
    productionDatabaseIdentityAssertionSql(identity),
    "--command",
    'DROP INDEX CONCURRENTLY "public"."' + indexName + '";',
  ], {
    label: "bounded concurrent index repair " + indexName,
    env: protectedPostgresCommandEnvironment(),
    allowFailure: true,
    timeoutMs: 16 * 60 * 1_000,
  });
  if (result.status !== 0) fail("bounded concurrent index repair failed");
  return result;
}

function admittedPostClerkMigrations(entryReceipt) {
  const admitted = entryReceipt.migrations?.slice(1);
  if (!Array.isArray(admitted) || admitted.length !== POST_CLERK_MIGRATIONS.length) {
    fail("entry receipt does not contain the exact seven post-Clerk migrations");
  }
  return admitted.map((migration, index) => {
    if (migration?.path !== POST_CLERK_MIGRATIONS[index] ||
      migration?.sha256 !== POST_CLERK_MIGRATION_CONTRACT[index].sha256) {
      fail("entry receipt post-Clerk migration authority is invalid at position " + (index + 1));
    }
    return { path: migration.path, sha256: migration.sha256 };
  });
}

function readPostClerkCatalogPlan(
  runner,
  request,
  state,
  entryReceipt,
  persistedPrefixLength,
) {
  assertProtectedPostgresEnvironment();
  assertPersistedDatabaseDdlAuthority(request, state);
  verifyProtectedPostgresIdentity(runner, request);
  const result = runner.run("node", [
    requireSnapshotFile(POST_CLERK_CATALOG_VERIFIER_PATH, true),
  ], { label: "exact post-Clerk PostgreSQL catalog verification" });
  const report = strictJsonParse(result.stdout, "post-Clerk PostgreSQL catalog report");
  const admitted = admittedPostClerkMigrations(entryReceipt);
  const plan = planPostClerkMigrationCatalog(report, persistedPrefixLength, admitted);
  verifyProtectedPostgresIdentity(runner, request);
  if (plan.contractHash !== POST_CLERK_CATALOG_CONTRACT_HASH ||
    plan.migrationContractHash !== POST_CLERK_MIGRATION_CONTRACT_HASH) {
    fail("post-Clerk catalog plan contract hash drift detected");
  }
  return { report, plan };
}

export function assertPostClerkCatalogPlan(plan, persistedPrefixLength, expectedMigration = null) {
  safeInteger(
    persistedPrefixLength,
    "persisted post-Clerk migration prefix length",
    0,
  );
  if (persistedPrefixLength > POST_CLERK_MIGRATIONS.length) {
    fail("persisted post-Clerk migration prefix length exceeds the reviewed sequence");
  }
  if (plan?.contractHash !== POST_CLERK_CATALOG_CONTRACT_HASH ||
    plan?.migrationContractHash !== POST_CLERK_MIGRATION_CONTRACT_HASH) {
    fail("post-Clerk catalog plan has the wrong verifier contract");
  }
  if (expectedMigration === null) {
    if (persistedPrefixLength !== POST_CLERK_MIGRATIONS.length ||
      plan.outcome !== "complete" || plan.reasonCode !== "SEQUENCE_COMPLETE" ||
      plan.nextPath !== null || plan.nextMigrationSha256 !== null ||
      plan.nextClassification !== "complete" || plan.action !== "complete" ||
      plan.lostAckAdopted !== false ||
      !Array.isArray(plan.repairIndexes) || plan.repairIndexes.length !== 0) {
      fail("post-Clerk catalog sequence is not exactly complete");
    }
    return plan;
  }
  const expected = POST_CLERK_MIGRATIONS[persistedPrefixLength];
  if (expectedMigration !== expected || plan.outcome !== "ready" ||
    plan.nextPath !== expectedMigration ||
    !/^sha256:[0-9a-f]{64}$/.test(plan.nextMigrationSha256 ?? "") ||
    !new Set(["adopt", "apply", "replay", "repair"]).has(plan.action)) {
    fail("post-Clerk catalog plan does not authorize the exact next migration");
  }
  return plan;
}

function validateStoredPostClerkCatalogProgress(state, entryReceipt) {
  const expectedLength = state.migrationProgress.length - 1;
  const stored = state.phaseEvidence.postClerkMigrationCatalog;
  if (stored === undefined) {
    if (expectedLength !== 0) {
      fail("persisted post-Clerk migration prefix has no bound catalog evidence");
    }
    if (state.phaseEvidence.postClerkMigrationCatalogCompletion !== undefined) {
      fail("post-Clerk sequence completion exists before any catalog evidence");
    }
    return [];
  }
  if (!Array.isArray(stored) || stored.length !== expectedLength) {
    fail("stored post-Clerk catalog evidence is not the exact persisted prefix");
  }
  const admitted = admittedPostClerkMigrations(entryReceipt);
  const admittedSequenceHash = canonicalHash(admitted);
  stored.forEach((record, index) => {
    exactKeys(record, [
      "schemaVersion", "kind", "path", "sha256", "contractHash", "migrationContractHash",
      "admittedSequenceHash", "preflightCatalogEvidenceHash",
      "preflightPlanEvidenceHash", "preflightAction", "lostAckAdopted",
      "repairIndexes", "repairCatalogEvidenceHash", "repairPlanEvidenceHash",
      "postconditionCatalogEvidenceHash", "postconditionPlanEvidenceHash",
      "verifiedAt",
    ], "stored post-Clerk catalog evidence");
    if (record.schemaVersion !== 1 ||
      record.kind !== "production-post-clerk-migration-completion" ||
      record.path !== POST_CLERK_MIGRATIONS[index] ||
      record.sha256 !== admitted[index].sha256 ||
      record.contractHash !== POST_CLERK_CATALOG_CONTRACT_HASH ||
      record.migrationContractHash !== POST_CLERK_MIGRATION_CONTRACT_HASH ||
      record.admittedSequenceHash !== admittedSequenceHash ||
      !/^sha256:[0-9a-f]{64}$/.test(record.preflightCatalogEvidenceHash) ||
      !/^sha256:[0-9a-f]{64}$/.test(record.preflightPlanEvidenceHash) ||
      !/^sha256:[0-9a-f]{64}$/.test(record.postconditionCatalogEvidenceHash) ||
      !/^sha256:[0-9a-f]{64}$/.test(record.postconditionPlanEvidenceHash) ||
      !new Set(["adopt", "apply", "replay", "repair"]).has(record.preflightAction) ||
      typeof record.lostAckAdopted !== "boolean" ||
      record.lostAckAdopted !== (record.preflightAction === "adopt")) {
      fail("stored post-Clerk catalog evidence identity is invalid");
    }
    if (!Array.isArray(record.repairIndexes) ||
      record.repairIndexes.some((name, repairIndex) =>
        !REPLY_REPAIR_INDEXES.includes(name) ||
        record.repairIndexes.indexOf(name) !== repairIndex ||
        (repairIndex > 0 &&
          REPLY_REPAIR_INDEXES.indexOf(record.repairIndexes[repairIndex - 1]) >=
            REPLY_REPAIR_INDEXES.indexOf(name))) ||
      (record.preflightAction === "repair") !== (record.repairIndexes.length > 0)) {
      fail("stored post-Clerk repair evidence is invalid");
    }
    const repairHashesPresent = record.repairCatalogEvidenceHash !== null &&
      record.repairPlanEvidenceHash !== null;
    if (repairHashesPresent !== (record.preflightAction === "repair") ||
      (repairHashesPresent &&
        (!/^sha256:[0-9a-f]{64}$/.test(record.repairCatalogEvidenceHash) ||
          !/^sha256:[0-9a-f]{64}$/.test(record.repairPlanEvidenceHash))) ||
      (!repairHashesPresent &&
        (record.repairCatalogEvidenceHash !== null ||
          record.repairPlanEvidenceHash !== null))) {
      fail("stored post-Clerk repair transition hashes are invalid");
    }
    canonicalTimestamp(record.verifiedAt, "stored post-Clerk catalog evidence verifiedAt");
  });
  const sequenceCompletion = state.phaseEvidence.postClerkMigrationCatalogCompletion;
  if (expectedLength < POST_CLERK_MIGRATIONS.length && sequenceCompletion !== undefined) {
    fail("post-Clerk sequence completion exists before the exact migration prefix is complete");
  }
  if (sequenceCompletion !== undefined) {
    exactKeys(sequenceCompletion, [
      "schemaVersion", "kind", "contractHash", "migrationContractHash",
      "admittedSequenceHash",
      "catalogEvidenceHash", "planEvidenceHash", "verifiedAt",
    ], "stored post-Clerk sequence completion");
    if (sequenceCompletion.schemaVersion !== 1 ||
      sequenceCompletion.kind !== "production-post-clerk-migration-sequence-completion" ||
      sequenceCompletion.contractHash !== POST_CLERK_CATALOG_CONTRACT_HASH ||
      sequenceCompletion.migrationContractHash !== POST_CLERK_MIGRATION_CONTRACT_HASH ||
      sequenceCompletion.admittedSequenceHash !== admittedSequenceHash ||
      !/^sha256:[0-9a-f]{64}$/.test(sequenceCompletion.catalogEvidenceHash) ||
      !/^sha256:[0-9a-f]{64}$/.test(sequenceCompletion.planEvidenceHash)) {
      fail("stored post-Clerk sequence completion identity is invalid");
    }
    canonicalTimestamp(
      sequenceCompletion.verifiedAt,
      "stored post-Clerk sequence completion verifiedAt",
    );
  }
  return stored;
}

export function assertNextCatalogPlan(
  plan,
  persistedPrefixLength,
  migrationPath,
  migrationSha256,
) {
  assertPostClerkCatalogPlan(plan, persistedPrefixLength, migrationPath);
  if (plan.nextMigrationSha256 !== migrationSha256) {
    fail("post-Clerk catalog plan does not bind the admitted next migration bytes");
  }
}

function executePostClerkMigration(
  runner,
  request,
  state,
  options,
  entryReceipt,
  migrationPath,
  persistedPrefixLength,
) {
  const authority = admittedPostClerkMigrations(entryReceipt)[persistedPrefixLength];
  if (authority.path !== migrationPath) {
    fail("post-Clerk execution path differs from admitted migration order");
  }
  const preflight = readPostClerkCatalogPlan(
    runner,
    request,
    state,
    entryReceipt,
    persistedPrefixLength,
  );
  assertNextCatalogPlan(
    preflight.plan,
    persistedPrefixLength,
    migrationPath,
    authority.sha256,
  );

  let repair = null;
  if (preflight.plan.action === "repair") {
    for (const indexName of preflight.plan.repairIndexes) {
      psqlDropIndexConcurrently(runner, request, state, indexName);
    }
    repair = readPostClerkCatalogPlan(
      runner,
      request,
      state,
      entryReceipt,
      persistedPrefixLength,
    );
    assertNextCatalogPlan(
      repair.plan,
      persistedPrefixLength,
      migrationPath,
      authority.sha256,
    );
    if (repair.plan.action !== "apply" || repair.plan.repairIndexes.length !== 0) {
      fail("reply single-flight repair did not return to the exact absent catalog state");
    }
  }

  if (preflight.plan.action !== "adopt") {
    const executionPlan = repair?.plan ?? preflight.plan;
    if (!new Set(["apply", "replay"]).has(executionPlan.action)) {
      fail("post-Clerk catalog plan does not authorize immutable SQL execution");
    }
    verifyAzureLease(runner, request);
    verifyReleaseLock(runner, request);
    const migrationFile = extractMigration(
      runner,
      request,
      options.stateDir,
      migrationPath,
      authority.sha256,
    );
    psqlMigration(runner, request, state, migrationFile);
  }

  const postcondition = readPostClerkCatalogPlan(
    runner,
    request,
    state,
    entryReceipt,
    persistedPrefixLength,
  );
  assertNextCatalogPlan(
    postcondition.plan,
    persistedPrefixLength,
    migrationPath,
    authority.sha256,
  );
  if (postcondition.plan.action !== "adopt" ||
    postcondition.plan.nextClassification !== "complete" ||
    postcondition.plan.lostAckAdopted !== true ||
    postcondition.plan.repairIndexes.length !== 0) {
    fail("post-Clerk migration exact catalog postcondition is not complete");
  }

  return {
    schemaVersion: 1,
    kind: "production-post-clerk-migration-completion",
    path: migrationPath,
    sha256: authority.sha256,
    contractHash: postcondition.plan.contractHash,
    migrationContractHash: postcondition.plan.migrationContractHash,
    admittedSequenceHash: postcondition.plan.admittedSequenceHash,
    preflightCatalogEvidenceHash: preflight.plan.catalogEvidenceHash,
    preflightPlanEvidenceHash: preflight.plan.evidenceHash,
    preflightAction: preflight.plan.action,
    lostAckAdopted: preflight.plan.lostAckAdopted,
    repairIndexes: [...preflight.plan.repairIndexes],
    repairCatalogEvidenceHash: repair?.plan.catalogEvidenceHash ?? null,
    repairPlanEvidenceHash: repair?.plan.evidenceHash ?? null,
    postconditionCatalogEvidenceHash: postcondition.plan.catalogEvidenceHash,
    postconditionPlanEvidenceHash: postcondition.plan.evidenceHash,
    verifiedAt: nowSecond(),
  };
}


function invokeClerk(runner, request, state, options) {
  const verified = validateState(state, request);
  const firstInvocation = verified.ledger.phase === "B1_CONTROL_ACQUIRED" && state.migrationProgress.length === 0;
  const uncertainRetry = verified.ledger.progressPhase === "B3_SCHEMA_FORWARD_ONLY" &&
    state.migrationProgress.length <= 1;
  if (!firstInvocation && !uncertainRetry) {
    fail("invoke-clerk requires prepared B1 or an uncertain B3 Clerk recovery state");
  }
  verifyAzureLease(runner, request);
  verifyReleaseLock(runner, request);
  runRuntimeControl(
    runner,
    request,
    options.stateDir,
    "hold",
    state.writerFenceGeneration,
  );
  const receiptBytes = verifyEntryReceipt(runner, request, state, options);
  const clerkAuthority = reverifyFrozenClerkPlan(runner, request, state, options);
  const receipt = strictJsonParse(receiptBytes, "entry receipt");
  if (canonicalJson(receipt.clerkReconciliationPlan) !== canonicalJson(clerkAuthority.binding)) {
    fail("entry receipt does not bind the exact independently approved Clerk reconciliation plan");
  }
  let next = state;
  if (firstInvocation) {
    let result = advanceLedger(verified.ledgerBytes, {
      toPhase: "B2_LEGACY_QUIESCED",
      fencingGeneration: state.writerFenceGeneration,
      receiptBytes,
      at: nowSecond(),
    });
    result = advanceLedger(result.ledgerBytes, {
      toPhase: "B3_SCHEMA_FORWARD_ONLY",
      fencingGeneration: state.writerFenceGeneration + 1,
      clerkInvocation: "uncertain",
      at: nowSecond(),
    });
    next = replaceLedger(state, result);
    // Persist the irreversible floor before invoking the first migration.
    uploadState(runner, request, next, options.statePath);
  } else {
    const embedded = verified.ledger.receipts[0];
    if (!embedded || embedded.sha256 !== sha256(receiptBytes)) {
      fail("uncertain Clerk retry supplied different entry receipt bytes");
    }
  }
  const migration = receipt.migrations?.[0];
  if (migration?.path !== MIGRATIONS[0]) fail("entry receipt does not bind the first exact Clerk migration");
  const path = extractMigration(runner, request, options.stateDir, MIGRATIONS[0], migration.sha256);
  const execution = psqlMigration(runner, request, next, path);
  const reconciliationOutput = join(options.stateDir, "clerk-reconciliation-result.json");
  assertPersistedDatabaseDdlAuthority(request, next);
  verifyProtectedPostgresIdentity(runner, request);
  verifyAzureLease(runner, request);
  verifyReleaseLock(runner, request);
  runner.run("node", [
    requireSnapshotFile(CLERK_EXECUTOR_PATH, true),
    "--mode", "apply",
    "--plan", clerkAuthority.paths.clerkPlan,
    "--attempt-id", request.attemptId,
    "--database-identity-hash", request.databaseIdentityHash,
    "--executor-sha256", clerkAuthority.binding.executor.sha256,
    "--expected-backend-commit", request.backendCandidate.commit,
    "--authority-subscription-id", request.authority.subscriptionId,
    "--authority-storage-account", request.storage.accountName,
    "--authority-storage-container", request.storage.containerName,
    "--authority-storage-blob", request.storage.blobName,
    "--output", reconciliationOutput,
    "--yes",
  ], { label: "exact Clerk reconciliation execution" });
  const reconciliation = readBoundedJson(reconciliationOutput, "Clerk reconciliation result");
  if (reconciliation.mode !== "apply" ||
    reconciliation.rawPlanSha256 !== clerkAuthority.binding.rawPlanSha256 ||
    reconciliation.executorSha256 !== clerkAuthority.binding.executor.sha256 ||
    reconciliation.cutover?.minimumEventVersion !== clerkAuthority.binding.minimumEventVersion ||
    reconciliation.cutover?.inventoryEvidenceHash !== clerkAuthority.binding.inventoryEvidenceHash ||
    reconciliation.cutover?.expectedActiveOrganizationCount !== clerkAuthority.binding.expectedActiveOrganizationCount ||
    reconciliation.cutover?.expectedActiveMembershipCount !== clerkAuthority.binding.expectedActiveMembershipCount ||
    reconciliation.cutover?.expectedActiveUserCount !== clerkAuthority.binding.expectedActiveUserCount) {
    fail("Clerk reconciliation executor result does not bind the frozen authority");
  }
  const evidence = {
    schemaVersion: 1,
    kind: "clerk-schema-invocation-result",
    attemptId: request.attemptId,
    migration: MIGRATIONS[0],
    migrationSha256: migration.sha256,
    invokedAt: nowSecond(),
    psqlExitStatus: execution.status,
    forwardOnly: true,
    reconciliationRequired: false,
    reconciliationEvidenceHash: reconciliation.evidenceHash,
  };
  next = { ...next, migrationProgress: [MIGRATIONS[0]], phaseEvidence: { ...next.phaseEvidence, clerkInvocation: evidence } };
  if (verified.ledger.phase !== "HELD") {
    next = holdState(next, "CLERK_RECONCILIATION_VERIFIED", evidence);
  } else {
    next = { ...next, phaseEvidence: { ...next.phaseEvidence, held: evidence } };
  }
  uploadState(runner, request, next, options.statePath);
  writeNewEvidence(options.output, evidence);
  return { phase: "HELD", progressPhase: "B3_SCHEMA_FORWARD_ONLY", rollbackFloor: "forward-recovery-only" };
}

function assertClerkReady(snapshot) {
  const value = snapshot.database;
  if (
    value.clerkIdentitySchemaReady !== true ||
    value.clerkCutoverRowCount !== 1 ||
    value.clerkCutoverReady !== true ||
    !Number.isSafeInteger(value.clerkMinimumEventVersion) || value.clerkMinimumEventVersion < 1 ||
    !/^sha256:[0-9a-f]{64}$/.test(value.clerkInventoryEvidenceHash ?? "") ||
    value.clerkExpectedActiveOrganizationCount !== value.clerkActiveOrganizationCount ||
    value.clerkExpectedActiveMembershipCount !== value.clerkActiveMembershipCount ||
    value.clerkExpectedActiveUserCount !== value.clerkActiveUserCount ||
    value.clerkProjectionMismatchRows !== 0 ||
    value.clerkOrphanActiveAuthorityRows !== 0 ||
    value.clerkReadinessViolationCount !== 0
  ) {
    fail("Clerk reconciliation is not armed with exact zero-violation inventory");
  }
}

function applySchema(runner, request, state, options) {
  const verified = validateState(state, request);
  if (verified.ledger.phase !== "HELD" ||
    verified.ledger.progressPhase !== "B3_SCHEMA_FORWARD_ONLY" ||
    state.migrationProgress.length < 1 || state.migrationProgress.length > MIGRATIONS.length) {
    fail("apply-schema requires the held post-Clerk B3 state with an exact persisted migration prefix");
  }
  verifyAzureLease(runner, request);
  verifyReleaseLock(runner, request);
  runRuntimeControl(
    runner,
    request,
    options.stateDir,
    "hold",
    state.writerFenceGeneration,
  );
  const clerkSnapshot = runQuiescence(
    runner,
    request,
    options.stateDir,
    "verify",
    "pre-migration",
    state.writerFenceGeneration,
    "stopped",
    "clerk-ready",
  );
  assertClerkReady(clerkSnapshot);
  const storedReceipt = verifyLedgerBytes(verified.ledgerBytes).ledger.receipts[0];
  const entryReceipt = strictJsonParse(Buffer.from(storedReceipt.bytesBase64, "base64"), "stored entry receipt");
  let next = state;
  for (let index = 0; index < MIGRATIONS.length; index += 1) {
    const migration = entryReceipt.migrations?.[index];
    if (migration?.path !== MIGRATIONS[index] ||
      migration?.sha256 !== PHASE_MIGRATIONS[index].sha256) {
      fail(`entry receipt migration ${index + 1} is invalid`);
    }
  }
  let catalogProgress = [...validateStoredPostClerkCatalogProgress(state, entryReceipt)];
  const persistedPostClerkPrefixLength = state.migrationProgress.length - 1;
  const currentCatalog = readPostClerkCatalogPlan(
    runner,
    request,
    next,
    entryReceipt,
    persistedPostClerkPrefixLength,
  );
  if (persistedPostClerkPrefixLength === POST_CLERK_MIGRATIONS.length) {
    assertPostClerkCatalogPlan(currentCatalog.plan, persistedPostClerkPrefixLength);
  } else {
    const authority = admittedPostClerkMigrations(entryReceipt)[persistedPostClerkPrefixLength];
    assertNextCatalogPlan(
      currentCatalog.plan,
      persistedPostClerkPrefixLength,
      authority.path,
      authority.sha256,
    );
  }
  runReplayableOrderedSteps({
    orderedSteps: POST_CLERK_MIGRATIONS,
    completedSteps: state.migrationProgress.slice(1),
    executeStep: (migrationPath, relativeIndex) => executePostClerkMigration(
      runner,
      request,
      next,
      options,
      entryReceipt,
      migrationPath,
      relativeIndex,
    ),
    checkpoint: (completedSteps, _migrationPath, relativeIndex, completion) => {
      if (relativeIndex !== catalogProgress.length) {
        fail("post-Clerk catalog evidence checkpoint is not the next exact prefix");
      }
      catalogProgress = [...catalogProgress, completion];
      next = {
        ...next,
        migrationProgress: [MIGRATIONS[0], ...completedSteps],
        phaseEvidence: {
          ...next.phaseEvidence,
          postClerkMigrationCatalog: catalogProgress,
        },
        updatedAt: nowSecond(),
      };
      uploadState(runner, request, next, options.statePath);
    },
  });
  const finalCatalog = readPostClerkCatalogPlan(
    runner,
    request,
    next,
    entryReceipt,
    POST_CLERK_MIGRATIONS.length,
  );
  assertPostClerkCatalogPlan(finalCatalog.plan, POST_CLERK_MIGRATIONS.length);
  const storedCatalogCompletion = next.phaseEvidence.postClerkMigrationCatalogCompletion;
  if (storedCatalogCompletion !== undefined &&
    (storedCatalogCompletion.contractHash !== finalCatalog.plan.contractHash ||
      storedCatalogCompletion.migrationContractHash !==
        finalCatalog.plan.migrationContractHash ||
      storedCatalogCompletion.admittedSequenceHash !== finalCatalog.plan.admittedSequenceHash ||
      storedCatalogCompletion.catalogEvidenceHash !== finalCatalog.plan.catalogEvidenceHash ||
      storedCatalogCompletion.planEvidenceHash !== finalCatalog.plan.evidenceHash)) {
    fail("stored post-Clerk sequence completion differs from fresh exact catalog proof");
  }
  next = {
    ...next,
    phaseEvidence: {
      ...next.phaseEvidence,
      postClerkMigrationCatalogCompletion: {
        schemaVersion: 1,
        kind: "production-post-clerk-migration-sequence-completion",
        contractHash: finalCatalog.plan.contractHash,
        migrationContractHash: finalCatalog.plan.migrationContractHash,
        admittedSequenceHash: finalCatalog.plan.admittedSequenceHash,
        catalogEvidenceHash: finalCatalog.plan.catalogEvidenceHash,
        planEvidenceHash: finalCatalog.plan.evidenceHash,
        verifiedAt: nowSecond(),
      },
    },
    updatedAt: nowSecond(),
  };
  uploadState(runner, request, next, options.statePath);
  if (next.phaseEvidence.schemaResult !== undefined) {
    if (next.phaseEvidence.schemaResult.fencingGeneration !== next.writerFenceGeneration) {
      fail("stored schema result does not match the current closed writer-fence generation");
    }
    const adopted = runQuiescence(
      runner,
      request,
      options.stateDir,
      "verify",
      "post-migration",
      next.writerFenceGeneration,
      "stopped",
      "schema-result-adopted",
    );
    assertClerkReady(adopted);
    writeNewEvidence(options.output, next.phaseEvidence.schemaResult);
    return {
      phase: "HELD",
      progressPhase: "B3_SCHEMA_FORWARD_ONLY",
      schemaVerifiedLocally: true,
      replayAdopted: true,
    };
  }
  const receiptGeneration = next.writerFenceGeneration > next.fencingGeneration
    ? next.writerFenceGeneration
    : Math.max(next.fencingGeneration + 1, next.writerFenceGeneration + 1);
  if (receiptGeneration !== next.writerFenceGeneration) {
    runRuntimeControl(
      runner,
      request,
      options.stateDir,
      "renew",
      next.writerFenceGeneration,
      receiptGeneration,
    );
    next = { ...next, writerFenceGeneration: receiptGeneration };
    uploadState(runner, request, next, options.statePath);
  }
  const firstPostSnapshot = runQuiescence(
    runner,
    request,
    options.stateDir,
    "verify",
    "post-migration",
    receiptGeneration,
    "stopped",
    "schema-result-1",
  );
  runner.run("sleep", ["5"], { label: "stable post-schema queue observation interval" });
  const postSnapshot = runQuiescence(
    runner,
    request,
    options.stateDir,
    "verify",
    "post-migration",
    receiptGeneration,
    "stopped",
    "schema-result-2",
  );
  assertClerkReady(postSnapshot);
  const inventory = postSnapshot.database;
  const clerkInvocation = next.phaseEvidence.clerkInvocation;
  if (!clerkInvocation || typeof clerkInvocation !== "object" ||
    clerkInvocation.kind !== "clerk-schema-invocation-result") {
    fail("Clerk migration has no durable exact invocation evidence");
  }
  const migrationExecution = PHASE_MIGRATIONS.map((migration, index) => {
    const catalogProof = index === 0 ? null : catalogProgress[index - 1];
    const preflightPassed = index === 0
      ? clerkInvocation.migration === migration.path &&
        clerkInvocation.migrationSha256 === migration.sha256 &&
        clerkInvocation.attemptId === request.attemptId
      : catalogProof?.path === migration.path &&
        catalogProof.sha256 === migration.sha256 &&
        catalogProof.contractHash === POST_CLERK_CATALOG_CONTRACT_HASH &&
        catalogProof.migrationContractHash === POST_CLERK_MIGRATION_CONTRACT_HASH &&
        /^sha256:[0-9a-f]{64}$/.test(catalogProof.preflightPlanEvidenceHash);
    const invocationVerified = index === 0
      ? clerkInvocation.psqlExitStatus === 0 && clerkInvocation.forwardOnly === true &&
        clerkInvocation.reconciliationRequired === false &&
        /^sha256:[0-9a-f]{64}$/.test(clerkInvocation.reconciliationEvidenceHash ?? "")
      : new Set(["adopt", "apply", "replay", "repair"]).has(catalogProof.preflightAction) &&
        catalogProof.lostAckAdopted === (catalogProof.preflightAction === "adopt");
    const applied = index === 0
      ? inventory.clerkIdentitySchemaReady === true && inventory.clerkCutoverReady === true
      : /^sha256:[0-9a-f]{64}$/.test(catalogProof.postconditionCatalogEvidenceHash) &&
        /^sha256:[0-9a-f]{64}$/.test(catalogProof.postconditionPlanEvidenceHash);
    const postconditionsPassed = index === 0
      ? inventory.clerkProjectionMismatchRows === 0 &&
        inventory.clerkOrphanActiveAuthorityRows === 0 &&
        inventory.clerkReadinessViolationCount === 0
      : catalogProgress.length === POST_CLERK_MIGRATIONS.length &&
        finalCatalog.plan.outcome === "complete" &&
        finalCatalog.plan.contractHash === catalogProof.contractHash &&
        finalCatalog.plan.migrationContractHash === catalogProof.migrationContractHash &&
        finalCatalog.plan.admittedSequenceHash === catalogProof.admittedSequenceHash;
    if (!preflightPassed || !invocationVerified || !applied || !postconditionsPassed) {
      fail("migration execution evidence is incomplete for " + migration.path);
    }
    return {
      path: migration.path,
      sha256: migration.sha256,
      preflightPassed,
      invocationVerified,
      applied,
      postconditionsPassed,
      writerPause: migration.writerPause,
      writerScopes: migration.writerScopes,
      duplicateInventoryHash: inventory.duplicateInventoryEvidenceHash,
      postconditionEvidenceHash: canonicalHash({
        migration: migration.path,
        executionEvidenceHash: canonicalHash(index === 0 ? clerkInvocation : catalogProof),
        finalCatalogPlanEvidenceHash: finalCatalog.plan.evidenceHash,
        snapshotEvidenceHash: postSnapshot.evidenceHash,
        duplicateInventoryEvidenceHash: inventory.duplicateInventoryEvidenceHash,
      }),
    };
  });
  const legacyMarkerInventoryEvidenceHash = canonicalHash({
    legacyDeliveryUnknownMarkerRows: inventory.legacyDeliveryUnknownMarkerRows,
    legacyAutoFailedMarkerRows: inventory.legacyAutoFailedMarkerRows,
  });
  const b4Evidence = {
    targetRevisions: {
      api: request.targetArtifacts.api.plannedRevision,
      worker: request.targetArtifacts.worker.plannedRevision,
      console: request.targetArtifacts.console.plannedRevision,
    },
    migrationExecution,
    clerkReconciliationPlan: state.clerkReconciliationPlanBinding,
    clerkCutover: {
      schemaReady: inventory.clerkIdentitySchemaReady,
      rowCount: inventory.clerkCutoverRowCount,
      ready: inventory.clerkCutoverReady,
      minimumEventVersion: inventory.clerkMinimumEventVersion,
      inventoryEvidenceHash: inventory.clerkInventoryEvidenceHash,
      expectedActiveOrganizationCount: inventory.clerkExpectedActiveOrganizationCount,
      expectedActiveMembershipCount: inventory.clerkExpectedActiveMembershipCount,
      expectedActiveUserCount: inventory.clerkExpectedActiveUserCount,
      activeOrganizationCount: inventory.clerkActiveOrganizationCount,
      activeMembershipCount: inventory.clerkActiveMembershipCount,
      activeUserCount: inventory.clerkActiveUserCount,
      projectionMismatchRows: inventory.clerkProjectionMismatchRows,
      orphanActiveAuthorityRows: inventory.clerkOrphanActiveAuthorityRows,
      readinessViolationRows: inventory.clerkReadinessViolationCount,
      invariantEvidenceHash: canonicalHash({
        inventoryEvidenceHash: inventory.clerkInventoryEvidenceHash,
        snapshotEvidenceHash: postSnapshot.evidenceHash,
      }),
    },
    schemaInventory: {
      outreachIdempotencyDuplicateGroups: inventory.outreachIdempotencyDuplicateGroups,
      legacyGmailReplySequenceStopRows: inventory.legacyGmailReplySequenceStopRows,
      managerRoleRows: inventory.managerRoleRows,
      graphRunRunningRows: inventory.graphRunRunningRows,
      graphRunAwaitingApprovalRows: inventory.graphRunAwaitingApprovalRows,
      graphActiveOrgDuplicateGroups: inventory.graphActiveOrgDuplicateGroups,
      graphActiveWithoutRecoveryStateRows: inventory.graphActiveWithoutRecoveryStateRows,
      graphLifecycleSchemaReady: inventory.graphLifecycleSchemaReady,
      replySchemaReady: inventory.replySchemaReady,
      replySourceDuplicateGroups: inventory.replySourceDuplicateGroups,
      replyConversationDuplicateGroups: inventory.replyConversationDuplicateGroups,
      nullSourceReplyRows: inventory.nullSourceReplyRows,
      replySlotDuplicateRows: inventory.replySlotDuplicateRows,
      duplicateInventoryEvidenceHash: inventory.duplicateInventoryEvidenceHash,
    },
    deliveryState: {
      deliveryUnknownEnumReady: true,
      failedEnumReady: true,
      deliveryUnknownWriteMode: "disabled",
      deliveryUnknownWriteAck: null,
      failedStatusWritesEnabled: false,
      failedStatusWritesAck: null,
      sendingRows: inventory.sendingRows,
      firstClassDeliveryUnknownRows: inventory.firstClassDeliveryUnknownRows,
      firstClassFailedRows: inventory.firstClassFailedRows,
      legacyDeliveryUnknownMarkerRows: inventory.legacyDeliveryUnknownMarkerRows,
      legacyAutoFailedMarkerRows: inventory.legacyAutoFailedMarkerRows,
      legacyMarkerInventoryEvidenceHash,
    },
    quiescence: closedQuiescence(firstPostSnapshot, postSnapshot),
    stagingRehearsalEvidenceHash: request.bootstrapEvidence.stagingRehearsalEvidenceHash,
    productionApplyEvidenceHash: canonicalHash(migrationExecution),
    backupRestoreEvidenceHash: request.bootstrapEvidence.backupRestoreEvidenceHash,
    schemaEvidenceHash: canonicalHash({
      migrationExecution,
      inventory,
      quiescenceEvidenceHash: postSnapshot.evidenceHash,
    }),
  };
  const context = phaseContext(
    next,
    request,
    "production-schema-result",
    b4Evidence,
    receiptGeneration,
    postSnapshot.capturedAt,
  );
  next = { ...next, phaseEvidence: { ...next.phaseEvidence, schemaResult: context } };
  // It may already be HELD from the Clerk reconciliation wait. Do not append a
  // second hold event; keep B3 held and persist the stronger result evidence.
  uploadState(runner, request, next, options.statePath);
  writeNewEvidence(options.output, context);
  return { phase: "HELD", progressPhase: "B3_SCHEMA_FORWARD_ONLY", schemaVerifiedLocally: true };
}

function plannedSuffix(revision, app) {
  const prefix = `${app}--`;
  if (!revision.startsWith(prefix)) fail(`planned revision is not for ${app}`);
  return revision.slice(prefix.length);
}

export function writableRevisionTemplate(sourceTemplate) {
  const template = structuredClone(sourceTemplate);
  delete template.revisionSuffix;
  if (template.scale && typeof template.scale === "object" && !Array.isArray(template.scale)) {
    // Azure includes these preview-only values in Container App readbacks, but
    // the pinned 2024-03-01 write API rejects them in ContainerAppScale.
    delete template.scale.cooldownPeriod;
    delete template.scale.pollingInterval;
  }
  for (const container of template.containers ?? []) {
    // Azure includes these server-derived values on the parent Container App
    // template, but omits them from revision readbacks. They are not part of
    // the caller-controlled revision contract and must not create false drift.
    delete container.imageType;
    if (container.resources && typeof container.resources === "object" &&
      !Array.isArray(container.resources)) {
      delete container.resources.ephemeralStorage;
    }
  }
  return template;
}

export function matchesCapturedQuiescenceRevision(
  liveRevision,
  sourceTemplate,
  sourceImage,
  appName,
  role,
  attemptId,
  requireHealthy = true,
  backendCommit,
) {
  const legacyName = `${appName}--bootstrap-quiesce-${attemptId.slice(0, 7)}`;
  const idleWorkerName = `${appName}--bootstrap-quiesce-idle-${attemptId.slice(0, 7)}`;
  const revisionNames = new Set([legacyName]);
  if (role === "worker") revisionNames.add(idleWorkerName);
  if (backendCommit !== undefined) {
    string(backendCommit, /^[0-9a-f]{40}$/, "quiescence backend commit");
    revisionNames.add(`${legacyName}-${backendCommit.slice(0, 7)}`);
    revisionNames.add(quiescenceRevisionName(appName, role, attemptId, backendCommit));
    if (role === "worker") {
      revisionNames.add(`${idleWorkerName}-${backendCommit.slice(0, 7)}`);
    }
  }
  if (role === "console" || !revisionNames.has(liveRevision?.name) ||
    liveRevision.properties?.active !== true) return false;
  const actual = writableRevisionTemplate(liveRevision.properties?.template ?? {});
  const container = actual.containers?.[0];
  if (!container || actual.containers.length !== 1 || container.image !== sourceImage) return false;
  if (Array.isArray(container.env)) {
    container.env.sort((left, right) => String(left?.name).localeCompare(String(right?.name)));
  }
  const expected = liveRevision.name.startsWith(`${appName}--bootstrap-quiesce-idle-`) ||
    liveRevision.name.startsWith(`${appName}--bqi-`)
    ? expectedQuiescenceTemplate(sourceTemplate, sourceImage, role)
    : expectedRevisionTemplate(
      sourceTemplate,
      sourceImage,
      [...QUIESCENCE_DISABLED_WORKERS, "WORKER_ENABLED=false"],
      [],
      0,
      role,
    );
  const health = liveRevision.properties?.healthState ?? liveRevision.properties?.runningState;
  const provisioned = liveRevision.properties?.provisioningState === undefined ||
    liveRevision.properties.provisioningState === "Provisioned";
  return canonicalJson(actual) === canonicalJson(expected) && provisioned &&
    (!requireHealthy || new Set(["Healthy", "Running", "Provisioned"]).has(health));
}

function quiescenceRevisionName(appName, role, attemptId, backendCommit) {
  string(attemptId, /^[0-9a-f]{32}$/, "quiescence attempt ID");
  string(backendCommit, /^[0-9a-f]{40}$/, "quiescence backend commit");
  const marker = role === "worker" ? "bqi" : "bq";
  const revisionName =
    `${appName}--${marker}-${attemptId.slice(0, 7)}-${backendCommit.slice(0, 7)}`;
  if (revisionName.length > 54) {
    fail(`${role} quiescence revision name exceeds the Azure limit`);
  }
  return revisionName;
}

function expectedRevisionTemplate(sourceTemplate, image, envValues, removeEnvValues, minReplicas, role) {
  if (!sourceTemplate || typeof sourceTemplate !== "object" || Array.isArray(sourceTemplate)) {
    fail(`${role} source template is absent`);
  }
  const expected = writableRevisionTemplate(sourceTemplate);
  if (!Array.isArray(expected.containers) || expected.containers.length !== 1) {
    fail(`${role} source template must contain exactly one container`);
  }
  const container = expected.containers[0];
  container.image = image;
  const environment = new Map();
  for (const entry of container.env ?? []) {
    if (!entry || typeof entry.name !== "string" || environment.has(entry.name)) {
      fail(`${role} source environment is ambiguous`);
    }
    environment.set(entry.name, structuredClone(entry));
  }
  for (const setting of envValues) {
    const separator = setting.indexOf("=");
    if (separator < 1) fail(`${role} candidate environment setting is invalid`);
    const name = setting.slice(0, separator);
    const value = setting.slice(separator + 1);
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) fail(`${role} candidate environment name is invalid`);
    if (value.startsWith("secretref:")) {
      const secretRef = value.slice("secretref:".length);
      string(secretRef, /^[a-z0-9][a-z0-9-]{0,62}$/, `${role} candidate secret reference`);
      environment.set(name, { name, secretRef });
    } else {
      environment.set(name, { name, value });
    }
  }
  for (const name of removeEnvValues) environment.delete(name);
  container.env = [...environment.values()].sort((left, right) => left.name.localeCompare(right.name));
  if (role !== "console") {
    expected.scale = { ...(expected.scale ?? {}), minReplicas, maxReplicas: 1 };
  }
  return expected;
}

function expectedQuiescenceTemplate(
  sourceTemplate,
  image,
  role,
  retainLegacyWorkerGate = true,
) {
  const environment = retainLegacyWorkerGate
    ? [...QUIESCENCE_DISABLED_WORKERS, "WORKER_ENABLED=false"]
    : QUIESCENCE_DISABLED_WORKERS;
  const expected = expectedRevisionTemplate(
    sourceTemplate,
    image,
    environment,
    retainLegacyWorkerGate ? [] : ["WORKER_ENABLED"],
    0,
    role,
  );
  if (role === "worker") {
    expected.containers[0].command = [...WORKER_QUIESCENCE_COMMAND];
    expected.containers[0].args = [...WORKER_QUIESCENCE_ARGS];
  }
  return expected;
}

function assertRevisionMatchesUpdate(revision, expectedTemplate, image, role) {
  if (!revision || revision.properties?.active !== true) {
    fail(`${role} bootstrap revision is absent or inactive`);
  }
  const actual = writableRevisionTemplate(revision.properties?.template ?? {});
  const container = actual.containers?.[0];
  if (!container || actual.containers.length !== 1 || container.image !== image) {
    fail(`${role} bootstrap revision container or image drift detected`);
  }
  if (Array.isArray(container.env)) {
    container.env.sort((left, right) => String(left?.name).localeCompare(String(right?.name)));
  }
  if (canonicalJson(actual) !== canonicalJson(expectedTemplate)) {
    fail(`${role} bootstrap revision environment, secret references, scale, or template configuration drift detected`);
  }
  const health = revision.properties?.healthState ?? revision.properties?.runningState;
  if (!new Set(["Healthy", "Running", "Provisioned"]).has(health) ||
    (revision.properties?.provisioningState !== undefined &&
      revision.properties.provisioningState !== "Provisioned")) {
    fail(`${role} bootstrap revision is not healthy and provisioned`);
  }
}

function updateApp(
  runner,
  request,
  role,
  image,
  revision,
  envValues,
  minReplicas,
  removeEnvValues = [],
  releaseLockRequired = true,
  sourceTemplate,
  failedParentRepair,
) {
  const app = role === "api" ? API_APP : role === "worker" ? WORKER_APP : CONSOLE_APP;
  const resourceId = role === "api"
    ? request.authority.apiContainerAppResourceId
    : role === "worker"
      ? request.authority.workerContainerAppResourceId
      : request.authority.consoleContainerAppResourceId;
  const before = appState(runner, request, resourceId, `${role} pre-update application`);
  if (before.properties?.configuration?.activeRevisionsMode !== "Single") {
    fail(`${role} bootstrap update requires single revision mode`);
  }
  const expectedTemplate = expectedRevisionTemplate(
    sourceTemplate ?? before.properties?.template,
    image,
    envValues,
    removeEnvValues,
    minReplicas,
    role,
  );
  let preexisting = revisionList(runner, request, app, true)
    .find((entry) => entry?.name === revision);
  if (preexisting) {
    const health = preexisting.properties?.healthState ?? preexisting.properties?.runningState;
    const healthy = new Set(["Healthy", "Running", "Provisioned"]).has(health) &&
      (preexisting.properties?.provisioningState === undefined ||
        preexisting.properties.provisioningState === "Provisioned");
    if (!healthy) {
      const active = revisionList(runner, request, app)
        .filter((entry) => entry?.properties?.active === true);
      const fallback = active.find((entry) => entry.name !== revision &&
        new Set(["Healthy", "Running", "Provisioned"]).has(
          entry.properties?.healthState ?? entry.properties?.runningState,
        ));
      if (preexisting.properties?.template?.containers?.[0]?.image !== image || !fallback ||
        before.properties?.latestReadyRevisionName === revision) {
        fail(`${role} unhealthy bootstrap revision is not safely replaceable`);
      }
      const recoveryRevision = `${revision}-r1`;
      if (recoveryRevision.length > 54) {
        fail(`${role} recovery revision name exceeds the Azure limit`);
      }
      revision = recoveryRevision;
      preexisting = revisionList(runner, request, app, true)
        .find((entry) => entry?.name === revision);
    }
  }
  if (preexisting) {
    const actual = writableRevisionTemplate(preexisting.properties?.template ?? {});
    if (Array.isArray(actual.containers?.[0]?.env)) {
      actual.containers[0].env.sort((left, right) =>
        String(left?.name).localeCompare(String(right?.name)));
    }
    if (canonicalJson(actual) !== canonicalJson(expectedTemplate)) {
      fail(`${role} preexisting bootstrap revision differs from the exact expected template`);
    }
    activateRevision(runner, request, role, revision, releaseLockRequired);
  }
  if (!preexisting) {
    if (failedParentRepair !== undefined) {
      exactKeys(
        failedParentRepair,
        ["copyFromRevision", "conflictingRevisionSuffix"],
        "failed-parent revision-copy repair",
      );
      const { copyFromRevision, conflictingRevisionSuffix } = failedParentRepair;
      const expectedDeploymentError =
        "The following field(s) are either invalid or missing. " +
        `Field 'template.revisionsuffix' is invalid with details: 'Invalid value: ` +
        `\"${conflictingRevisionSuffix}\": revision with suffix ` +
        `${conflictingRevisionSuffix} already exists.';.`;
      const repairParent = resourceProviderAppState(
        runner,
        request,
        resourceId,
        "2025-02-02-preview",
        `${role} failed-parent resource-provider readback`,
      );
      const conflictingRevisionName = `${app}--${conflictingRevisionSuffix}`;
      const conflictingRevision = revisionList(runner, request, app, true)
        .find((entry) => entry?.name === conflictingRevisionName);
      const conflictHealth = conflictingRevision?.properties?.healthState ??
        conflictingRevision?.properties?.runningState;
      if (role !== "api" ||
        repairParent.properties?.provisioningState !== "Failed" ||
        repairParent.properties?.configuration?.ingress !== null ||
        repairParent.properties?.configuration?.activeRevisionsMode !== "Single" ||
        repairParent.properties?.latestReadyRevisionName !== copyFromRevision ||
        repairParent.properties?.deploymentErrors !== expectedDeploymentError ||
        conflictingRevision?.properties?.active !== false ||
        conflictingRevision.properties?.provisioningState !== "Provisioned" ||
        !new Set(["Healthy", "Running", "Provisioned"]).has(conflictHealth) ||
        conflictingRevision.properties?.template?.containers?.[0]?.image !== image) {
        fail("failed-parent revision-copy repair posture is invalid");
      }
      assertExactActiveRevision(runner, request, app, copyFromRevision, image);
      const copyArgs = [
        "containerapp", "revision", "copy",
        "--name", app,
        "--resource-group", RESOURCE_GROUP,
        "--from-revision", copyFromRevision,
        "--revision-suffix", plannedSuffix(revision, app),
        "--image", image,
        "--container-name", app,
        "--min-replicas", String(expectedTemplate.scale?.minReplicas),
        "--max-replicas", String(expectedTemplate.scale?.maxReplicas),
      ];
      if (envValues.length > 0) copyArgs.push("--set-env-vars", ...envValues);
      if (removeEnvValues.length > 0) {
        copyArgs.push("--remove-env-vars", ...removeEnvValues);
      }
      copyArgs.push("--output", "none");
      azureMutation(
        runner,
        request,
        copyArgs,
        `${role} failed-parent revision-copy repair`,
        releaseLockRequired,
      );
    } else {
      azureMutation(runner, request, [
        "rest",
        "--method", "patch",
        "--url", `${resourceId}?api-version=2024-03-01`,
        "--body", canonicalJson({
          properties: {
            template: {
              ...expectedTemplate,
              revisionSuffix: plannedSuffix(revision, app),
            },
          },
        }),
        "--output", "none",
      ], `${role} bootstrap revision update`, releaseLockRequired);
    }
  }
  let expected = null;
  for (let observation = 0; observation < 36; observation += 1) {
    const revisions = revisionList(runner, request, app);
    const candidate = revisions.find((entry) => entry.name === revision);
    const active = revisions.filter((entry) => entry?.properties?.active === true);
    const health = candidate?.properties?.healthState ?? candidate?.properties?.runningState;
    const provisioned = candidate?.properties?.provisioningState === undefined ||
      candidate.properties.provisioningState === "Provisioned";
    if (candidate?.properties?.active === true && active.length === 1 && provisioned &&
      new Set(["Healthy", "Running", "Provisioned"]).has(health)) {
      expected = candidate;
      break;
    }
    runner.run("sleep", ["5"], { label: `${role} bootstrap revision readiness interval` });
  }
  if (expected === null) fail(`${role} bootstrap revision did not become solely active and healthy`);
  assertRevisionMatchesUpdate(expected, expectedTemplate, image, role);
  assertExactActiveRevision(runner, request, app, revision, image);
  const after = appState(runner, request, resourceId, `${role} post-update application`);
  if ((after.properties?.provisioningState !== undefined && after.properties.provisioningState !== "Succeeded") ||
    (after.properties?.latestReadyRevisionName !== undefined &&
      after.properties.latestReadyRevisionName !== revision)) {
    fail(`${role} bootstrap application health/readiness adoption failed`);
  }
  return revision;
}

function revisionEnv(revision, name) {
  const entries = (revision.properties?.template?.containers?.[0]?.env ?? [])
    .filter((entry) => entry?.name === name);
  if (entries.length === 0) return null;
  if (entries.length !== 1 || entries[0].secretRef || typeof entries[0].value !== "string") {
    fail(`${revision.name} ${name} must be one plain non-secret environment value`);
  }
  return entries[0].value;
}

function assertExactActiveRevision(runner, request, app, revisionName, image) {
  const revisions = revisionList(runner, request, app, true);
  const active = revisions.filter((entry) => entry?.properties?.active === true);
  if (active.length !== 1 || active[0].name !== revisionName) {
    fail(`${app} does not have exactly the admitted active revision`);
  }
  const revision = active[0];
  if (revision.properties?.template?.containers?.[0]?.image !== image) {
    fail(`${app} active revision image differs from the admitted digest`);
  }
  return revision;
}

function verifyCandidateWriterGuard(revision, request, minimumGeneration, role) {
  if (revisionEnv(revision, "WORKFORCE_PRODUCTION_BOOTSTRAP_ATTEMPT_ID") !== request.attemptId ||
    revisionEnv(revision, "WORKFORCE_PRODUCTION_BOOTSTRAP_MIN_WRITER_FENCE_GENERATION") !== String(minimumGeneration)) {
    fail(`${role} candidate does not carry the exact fail-closed bootstrap writer guard`);
  }
}

function verifyDisabledBaselineLive(runner, request, identities, minimumGeneration) {
  const api = assertExactActiveRevision(
    runner,
    request,
    API_APP,
    identities.api,
    request.targetArtifacts.api.image,
  );
  const worker = assertExactActiveRevision(
    runner,
    request,
    WORKER_APP,
    identities.worker,
    request.targetArtifacts.worker.image,
  );
  assertExactActiveRevision(
    runner,
    request,
    CONSOLE_APP,
    identities.console,
    request.targetArtifacts.console.image,
  );
  for (const [revision, role] of [[api, "api"], [worker, "worker"]]) {
    verifyCandidateWriterGuard(revision, request, minimumGeneration, role);
    for (const gate of ["GMAIL_WATCH_RENEWAL_ENABLED", "GRAPH_RUN_WORKER_ENABLED", "OUTREACH_WORKER_ENABLED", "SCHEDULER_ENABLED"]) {
      if (revisionEnv(revision, gate) !== "false") fail(`${role} disabled baseline ${gate} is not false`);
    }
    if (revisionEnv(revision, "WORKER_ENABLED") !== null) {
      fail(`${role} disabled baseline retains retired WORKER_ENABLED`);
    }
    if ((revisionEnv(revision, "OUTREACH_LIVE_FOR_ORGS") ?? "") !== "") {
      fail(`${role} disabled baseline live-send allowlist is not empty`);
    }
    if ((revisionEnv(revision, "OUTREACH_DELIVERY_UNKNOWN_WRITE_MODE") ?? "disabled") !== "disabled") {
      fail(`${role} DELIVERY_UNKNOWN mode is not disabled`);
    }
    if ((revisionEnv(revision, "OUTREACH_FAILED_STATUS_WRITES_ENABLED") ?? "false") !== "false") {
      fail(`${role} FAILED mode is not disabled`);
    }
    if (revisionEnv(revision, "EVIDENCE_LEDGER_ENABLED") !== "true") {
      fail(`${role} disabled baseline evidence ledger is not enabled`);
    }
    for (const forbidden of [
      "OUTREACH_DELIVERY_UNKNOWN_WRITE_ACK",
      "OUTREACH_ROLLBACK_COMPATIBILITY_EPOCH",
      "OUTREACH_FAILED_STATUS_WRITES_ACK",
      "OUTREACH_DELIVERY_UNKNOWN_STATUS_WRITES_ENABLED",
      "OUTREACH_DELIVERY_UNKNOWN_STATUS_WRITES_ACK",
    ]) {
      if (revisionEnv(revision, forbidden) !== null) fail(`${role} disabled baseline retains ${forbidden}`);
    }
  }
}

function containerEntrypoint(template, label) {
  const container = template?.containers?.[0];
  if (!container || !Array.isArray(template.containers) || template.containers.length !== 1) {
    fail(`${label} must contain exactly one container`);
  }
  const normalize = (value, field) => {
    if (value === undefined || value === null) return null;
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
      fail(`${label} ${field} is invalid`);
    }
    return [...value];
  };
  return {
    command: normalize(container.command, "command"),
    args: normalize(container.args, "args"),
  };
}

function verifyFirstClassWorkerLive(
  runner,
  request,
  revisionName,
  minimumGeneration,
  sourceTemplate,
) {
  const worker = assertExactActiveRevision(
    runner,
    request,
    WORKER_APP,
    revisionName,
    request.targetArtifacts.worker.image,
  );
  verifyCandidateWriterGuard(worker, request, minimumGeneration, "first-class worker");
  for (const gate of ["GMAIL_WATCH_RENEWAL_ENABLED", "GRAPH_RUN_WORKER_ENABLED", "OUTREACH_WORKER_ENABLED"]) {
    if (revisionEnv(worker, gate) !== "true") fail(`first-class worker ${gate} is not true`);
  }
  if (revisionEnv(worker, "WORKER_ENABLED") !== null) {
    fail("first-class worker retains retired WORKER_ENABLED");
  }
  if (revisionEnv(worker, "SCHEDULER_ENABLED") !== "false") fail("first-class worker scheduler is not disabled");
  if (revisionEnv(worker, "OUTREACH_LIVE_FOR_ORGS") !== "") {
    fail("first-class worker live-send allowlist must remain empty through bootstrap completion");
  }
  if (revisionEnv(worker, "OUTREACH_DELIVERY_UNKNOWN_WRITE_MODE") !== "first-class" ||
    revisionEnv(worker, "OUTREACH_DELIVERY_UNKNOWN_WRITE_ACK") !== "readers-drained-rollback-baselines-verified-v1" ||
    revisionEnv(worker, "OUTREACH_ROLLBACK_COMPATIBILITY_EPOCH") !== "outreach-delivery-unknown-v1") {
    fail("first-class DELIVERY_UNKNOWN activation is incomplete");
  }
  if (revisionEnv(worker, "OUTREACH_FAILED_STATUS_WRITES_ENABLED") !== "true" ||
    revisionEnv(worker, "OUTREACH_FAILED_STATUS_WRITES_ACK") !== "readers-drained-legacy-inventory-reviewed-v1") {
    fail("first-class FAILED activation is incomplete");
  }
  if (sourceTemplate !== undefined && canonicalJson(containerEntrypoint(
    worker.properties?.template,
    "first-class worker template",
  )) !== canonicalJson(containerEntrypoint(sourceTemplate, "captured source worker template"))) {
    fail("first-class worker did not restore the captured application entrypoint");
  }
}

function deploymentEvidence(
  runner,
  request,
  role,
  revisionName,
  { allowIngressDisabledParentFailure = false } = {},
) {
  const appName = role === "api" ? API_APP : role === "worker" ? WORKER_APP : CONSOLE_APP;
  const resourceId = role === "api"
    ? request.authority.apiContainerAppResourceId
    : role === "worker"
      ? request.authority.workerContainerAppResourceId
      : request.authority.consoleContainerAppResourceId;
  const artifact = request.targetArtifacts[role];
  const app = appState(runner, request, resourceId, `${role} candidate deployment`);
  const revision = assertExactActiveRevision(runner, request, appName, revisionName, artifact.image);
  const template = revision.properties?.template;
  const container = template?.containers?.[0];
  if (!template || !container) fail(`${role} deployment template is absent`);
  const secrets = (container.env ?? [])
    .filter((entry) => typeof entry?.secretRef === "string")
    .map((entry) => ({ name: entry.name, secretRef: entry.secretRef }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const health = revision.properties?.healthState ?? revision.properties?.runningState;
  if (!new Set(["Healthy", "Running", "Provisioned"]).has(health)) {
    fail(`${role} candidate revision is not healthy`);
  }
  const containedApiParentFailure = role === "api" && allowIngressDisabledParentFailure &&
    app.properties?.provisioningState === "Failed" &&
    app.properties?.configuration?.ingress === null &&
    app.properties?.configuration?.activeRevisionsMode === "Single" &&
    app.properties?.latestReadyRevisionName === revisionName;
  if (app.properties?.provisioningState !== "Succeeded" && !containedApiParentFailure) {
    fail(`${role} candidate application is not provisioned`);
  }
  return {
    identity: {
      image: artifact.image,
      manifestDigest: artifact.manifestDigest,
      platformDigest: artifact.platformDigest,
      ociRevision: artifact.ociRevision,
      platform: artifact.platform,
      revision: revisionName,
      configHash: canonicalHash({
        containers: template.containers,
        scale: template.scale ?? null,
      }),
      templateHash: canonicalHash(template),
      secretReferencesHash: canonicalHash(secrets),
    },
    active: true,
    soleActiveRevision: true,
    healthy: true,
    provisioned: true,
  };
}

function validateFirstClassRecoveryEvidence(state, recovery, liveDeployments) {
  exactKeys(recovery, [
    "schemaVersion", "kind", "reasonCodes", "predecessors", "successors",
    "sourceEntrypointHashes", "workerSecretBinding", "pausedQueueEvidenceHash",
    "queuesRemainedPaused", "liveSendAllowlistEmpty", "recoveredAt", "evidenceHash",
  ], "first-class deployment recovery evidence");
  if (recovery.schemaVersion !== 1 ||
    recovery.kind !== "first-class-api-worker-template-recovery" ||
    recovery.queuesRemainedPaused !== true || recovery.liveSendAllowlistEmpty !== true) {
    fail("first-class deployment recovery evidence identity is invalid");
  }
  exactKeys(recovery.reasonCodes, ["api", "worker"], "first-class recovery reasons");
  exactKeys(recovery.predecessors, ["api", "worker"], "first-class recovery predecessors");
  exactKeys(recovery.successors, ["api", "worker"], "first-class recovery successors");
  exactKeys(recovery.sourceEntrypointHashes, ["api", "worker"],
    "first-class recovery entrypoint hashes");
  if (recovery.reasonCodes.api !== "containment-revision-supersession" ||
    recovery.reasonCodes.worker !== "quiescence-entrypoint-inheritance") {
    fail("first-class deployment recovery reasons are invalid");
  }
  exactKeys(recovery.workerSecretBinding, ["name", "secretRef"],
    "first-class recovery worker secret binding");
  if (recovery.workerSecretBinding.name !== "CLERK_WEBHOOK_SECRET" ||
    recovery.workerSecretBinding.secretRef !== "clerk-webhook-secret") {
    fail("first-class recovery worker secret binding is invalid");
  }
  for (const [value, label] of [
    [recovery.sourceEntrypointHashes.api, "API recovery source entrypoint hash"],
    [recovery.sourceEntrypointHashes.worker, "worker recovery source entrypoint hash"],
    [recovery.pausedQueueEvidenceHash, "first-class recovery paused-queue hash"],
    [recovery.evidenceHash, "first-class recovery evidence hash"],
  ]) string(value, /^sha256:[0-9a-f]{64}$/, label);
  canonicalTimestamp(recovery.recoveredAt, "first-class recovery time");
  const armed = state.phaseEvidence.firstClassActivation?.evidence?.deployments;
  if (!armed) fail("signed first-class deployment evidence is absent");
  for (const role of ["api", "worker"]) {
    const predecessor = recovery.predecessors[role];
    const successor = recovery.successors[role];
    if (canonicalJson(predecessor) !== canonicalJson(armed[role]) ||
      canonicalJson(successor) !== canonicalJson(liveDeployments[role]) ||
      !new RegExp(`^${predecessor.identity?.revision}-r[1-9]$`).test(
        successor.identity?.revision ?? "",
      )) {
      fail(`first-class ${role} recovery does not bind the signed predecessor and live successor`);
    }
    for (const key of [
      "image", "manifestDigest", "platformDigest", "ociRevision", "platform",
      ...(role === "api" ? ["secretReferencesHash"] : []),
    ]) {
      if (successor.identity[key] !== predecessor.identity[key]) {
        fail(`first-class ${role} recovery changed immutable ${key}`);
      }
    }
  }
  if (recovery.successors.api.identity.configHash ===
      recovery.predecessors.api.identity.configHash ||
    recovery.successors.api.identity.templateHash ===
      recovery.predecessors.api.identity.templateHash ||
    recovery.successors.worker.identity.configHash ===
      recovery.predecessors.worker.identity.configHash ||
    recovery.successors.worker.identity.templateHash ===
      recovery.predecessors.worker.identity.templateHash ||
    recovery.successors.worker.identity.secretReferencesHash ===
      recovery.predecessors.worker.identity.secretReferencesHash) {
    fail("first-class recovery did not create fresh API and worker revision templates");
  }
  const { evidenceHash, ...withoutHash } = recovery;
  if (evidenceHash !== canonicalHash(withoutHash)) {
    fail("first-class worker recovery evidence hash is invalid");
  }
  return recovery;
}

function boundedRecoverySequence(revision, predecessorName, image, sourceEntrypoint) {
  if (revision?.properties?.active !== true ||
    revision.properties?.template?.containers?.[0]?.image !== image ||
    canonicalJson(containerEntrypoint(
      revision.properties?.template,
      `${predecessorName} recovery successor template`,
    )) !== canonicalJson(sourceEntrypoint)) {
    return null;
  }
  for (let sequence = 1; sequence <= 9; sequence += 1) {
    if (revision.name === `${predecessorName}-r${sequence}`) return sequence;
  }
  return null;
}

function isForwardOnlyHoldRevision(revision, app, generation, image) {
  if (revision?.properties?.active !== true ||
    revision.properties?.template?.containers?.[0]?.image !== image ||
    canonicalJson(containerEntrypoint(
      revision.properties?.template,
      `${app} forward-only hold template`,
    )) !== canonicalJson({
      command: [...WORKER_QUIESCENCE_COMMAND],
      args: [...WORKER_QUIESCENCE_ARGS],
    })) {
    return false;
  }
  const base = `${app}--bootstrap-hold-${generation}`;
  if (revision.name === base) return true;
  for (let sequence = 1; sequence <= 9; sequence += 1) {
    if (revision.name === `${base}-r${sequence}`) return true;
  }
  return false;
}

function nextRecoveryRevision(
  runner,
  request,
  app,
  predecessorName,
  allowSoleActiveAdoption = true,
) {
  const revisions = revisionList(runner, request, app, true);
  const active = revisions.filter((entry) => entry?.properties?.active === true);
  for (let attempt = 1; attempt <= 9; attempt += 1) {
    const candidateName = `${predecessorName}-r${attempt}`;
    if (candidateName.length > 54) fail(`${app} recovery revision name exceeds the Azure limit`);
    const existing = revisions.find((entry) => entry?.name === candidateName);
    if (!existing || (allowSoleActiveAdoption &&
      existing.properties?.active === true && active.length === 1)) {
      return { name: candidateName, sequence: attempt };
    }
  }
  fail(`${app} exhausted the bounded recovery revision sequence`);
}

function ensureFirstClassDeploymentsForResume(
  runner,
  request,
  state,
  receipt,
  pausedQueueEvidenceHash,
  options,
) {
  const armed = state.phaseEvidence.firstClassActivation?.evidence?.deployments;
  if (!armed) fail("signed first-class activation evidence is absent");
  const apiPredecessorName = armed.api.identity?.revision;
  const workerPredecessorName = armed.worker.identity?.revision;
  const apiSourceTemplate = state.privateRestoreBundle.apiRevision?.properties?.template;
  const workerSourceTemplate = state.privateRestoreBundle.workerRevision?.properties?.template;
  const apiSourceEntrypoint = containerEntrypoint(apiSourceTemplate, "captured API source template");
  const workerSourceEntrypoint = containerEntrypoint(
    workerSourceTemplate,
    "captured source worker template",
  );
  const terminalOpenGeneration = state.phaseEvidence.terminalOpenIntent?.generation;
  if (!Number.isSafeInteger(terminalOpenGeneration) || terminalOpenGeneration < 1) {
    fail("terminal OPEN generation is absent during first-class deployment recovery");
  }
  const apiActive = revisionList(runner, request, API_APP)
    .filter((entry) => entry?.properties?.active === true);
  const workerActive = revisionList(runner, request, WORKER_APP)
    .filter((entry) => entry?.properties?.active === true);
  const storedRecovery = state.phaseEvidence.firstClassRecovery;
  let validatedStoredRecoveryParentRepair = false;
  if (storedRecovery !== undefined &&
    state.activeIdentities.api === storedRecovery.successors?.api?.identity?.revision &&
    state.activeIdentities.worker === storedRecovery.successors?.worker?.identity?.revision &&
    apiActive.length === 1 && apiActive[0].name === state.activeIdentities.api &&
    workerActive.length === 1 && workerActive[0].name === state.activeIdentities.worker) {
    const apiParent = appState(
      runner,
      request,
      request.authority.apiContainerAppResourceId,
      "stored recovery API parent",
    );
    const apiParentRepairRequired =
      apiParent.properties?.provisioningState === "Failed" &&
      apiParent.properties?.configuration?.ingress === null &&
      apiParent.properties?.configuration?.activeRevisionsMode === "Single" &&
      apiParent.properties?.latestReadyRevisionName === state.activeIdentities.api;
    const current = {
      api: deploymentEvidence(
        runner,
        request,
        "api",
        state.activeIdentities.api,
        { allowIngressDisabledParentFailure: true },
      ),
      worker: deploymentEvidence(runner, request, "worker", state.activeIdentities.worker),
    };
    verifyFirstClassWorkerLive(
      runner,
      request,
      state.activeIdentities.worker,
      receipt.fencingGeneration,
      workerSourceTemplate,
    );
    const validatedRecovery = validateFirstClassRecoveryEvidence(state, storedRecovery, current);
    if (!apiParentRepairRequired) {
      return { state, recovery: validatedRecovery };
    }
    validatedStoredRecoveryParentRepair = true;
    // An ingress-only write cannot repair an already-failed Container App
    // parent. Fall through to the bounded successor path while queues and
    // ingress remain contained; the fresh exact templates repair both parent
    // resources before ingress is enabled.
  }

  if (apiActive.length === 1 && apiActive[0].name === apiPredecessorName &&
    workerActive.length === 1 && workerActive[0].name === workerPredecessorName &&
    canonicalJson(containerEntrypoint(
      workerActive[0].properties?.template,
      "active signed first-class worker template",
    )) === canonicalJson(workerSourceEntrypoint)) {
    verifyFirstClassWorkerLive(
      runner,
      request,
      workerPredecessorName,
      receipt.fencingGeneration,
      workerSourceTemplate,
    );
    return { state, recovery: null };
  }
  const apiRecoverySequences = apiActive.map((revision) => boundedRecoverySequence(
    revision,
    apiPredecessorName,
    request.targetArtifacts.api.image,
    apiSourceEntrypoint,
  ));
  const workerRecoverySequences = workerActive.map((revision) => boundedRecoverySequence(
    revision,
    workerPredecessorName,
    request.targetArtifacts.worker.image,
    workerSourceEntrypoint,
  ));
  const apiContained = apiActive.length === 1 && (
    isForwardOnlyHoldRevision(
      apiActive[0],
      API_APP,
      terminalOpenGeneration,
      request.targetArtifacts.api.image,
    ) ||
    (apiActive[0].name === apiPredecessorName &&
      apiActive[0].properties?.template?.containers?.[0]?.image ===
        request.targetArtifacts.api.image)
  );
  const workerQuiescent = workerActive.map((revision) =>
    isForwardOnlyHoldRevision(
      revision,
      WORKER_APP,
      terminalOpenGeneration,
      request.targetArtifacts.worker.image,
    ) ||
    (revision.name === workerPredecessorName &&
      revision.properties?.template?.containers?.[0]?.image ===
        request.targetArtifacts.worker.image &&
      canonicalJson(containerEntrypoint(
        revision.properties?.template,
        "contained signed first-class worker template",
      )) === canonicalJson({
        command: [...WORKER_QUIESCENCE_COMMAND],
        args: [...WORKER_QUIESCENCE_ARGS],
      })),
  );
  const apiRecoverable = apiActive.length === 1 &&
    (apiContained || apiRecoverySequences[0] !== null);
  const workerRecoverable = workerActive.length >= 1 && workerActive.length <= 10 &&
    (workerQuiescent.some(Boolean) || validatedStoredRecoveryParentRepair) &&
    workerActive.every((_, index) =>
      workerQuiescent[index] || workerRecoverySequences[index] !== null);
  if (!apiRecoverable || !workerRecoverable) {
    fail("active deployment posture is not the reviewed API/worker containment state");
  }
  // A previous attempt may have durably created only one successor before the
  // other role failed readiness. Never reuse either side of that asymmetric
  // state: advance both bounded suffixes so one parent write repairs each app
  // and the resulting evidence binds one fresh, coherent successor pair.
  const partialRecoveryObserved = apiRecoverySequences.some((value) => value !== null) ||
    workerRecoverySequences.some((value) => value !== null);
  const apiRecovery = nextRecoveryRevision(
    runner,
    request,
    API_APP,
    apiPredecessorName,
    !partialRecoveryObserved,
  );
  const workerRecovery = nextRecoveryRevision(
    runner,
    request,
    WORKER_APP,
    workerPredecessorName,
    !partialRecoveryObserved,
  );
  const apiRevision = updateApp(
    runner,
    request,
    "api",
    request.targetArtifacts.api.image,
    apiRecovery.name,
    [
      "GMAIL_WATCH_RENEWAL_ENABLED=false",
      "GRAPH_RUN_WORKER_ENABLED=false",
      "OUTREACH_WORKER_ENABLED=false",
      "SCHEDULER_ENABLED=false",
      `WORKFORCE_PRODUCTION_BOOTSTRAP_ATTEMPT_ID=${request.attemptId}`,
      `WORKFORCE_PRODUCTION_BOOTSTRAP_MIN_WRITER_FENCE_GENERATION=${receipt.fencingGeneration}`,
      `WORKFORCE_PRODUCTION_BOOTSTRAP_RECOVERY_SEQUENCE=${apiRecovery.sequence}`,
      "OUTREACH_LIVE_FOR_ORGS=",
      "OUTREACH_DELIVERY_UNKNOWN_WRITE_MODE=disabled",
      "OUTREACH_FAILED_STATUS_WRITES_ENABLED=false",
      "EVIDENCE_LEDGER_ENABLED=true",
    ],
    1,
    [
      ...RETIRED_WORKER_ENVIRONMENT,
      "OUTREACH_DELIVERY_UNKNOWN_WRITE_ACK",
      "OUTREACH_ROLLBACK_COMPATIBILITY_EPOCH",
      "OUTREACH_FAILED_STATUS_WRITES_ACK",
    ],
    true,
    apiSourceTemplate,
    validatedStoredRecoveryParentRepair
      ? {
          copyFromRevision: state.activeIdentities.api,
          conflictingRevisionSuffix: `bootstrap-hold-${terminalOpenGeneration}`,
        }
      : undefined,
  );
  const workerRevision = updateApp(
    runner,
    request,
    "worker",
    request.targetArtifacts.worker.image,
    workerRecovery.name,
    [
      ...firstClassWorkerEnvironment(request, receipt.fencingGeneration),
      `WORKFORCE_PRODUCTION_BOOTSTRAP_RECOVERY_SEQUENCE=${workerRecovery.sequence}`,
      "CLERK_WEBHOOK_SECRET=secretref:clerk-webhook-secret",
    ],
    1,
    RETIRED_WORKER_ENVIRONMENT,
    true,
    workerSourceTemplate,
  );
  const api = assertExactActiveRevision(
    runner,
    request,
    API_APP,
    apiRevision,
    request.targetArtifacts.api.image,
  );
  verifyCandidateWriterGuard(api, request, receipt.fencingGeneration, "recovered API");
  for (const gate of [
    "GMAIL_WATCH_RENEWAL_ENABLED", "GRAPH_RUN_WORKER_ENABLED",
    "OUTREACH_WORKER_ENABLED", "SCHEDULER_ENABLED",
  ]) {
    if (revisionEnv(api, gate) !== "false") fail(`recovered API ${gate} is not false`);
  }
  if (revisionEnv(api, "WORKFORCE_PRODUCTION_BOOTSTRAP_RECOVERY_SEQUENCE") !==
    String(apiRecovery.sequence) ||
    canonicalJson(containerEntrypoint(api.properties?.template, "recovered API template")) !==
      canonicalJson(apiSourceEntrypoint)) {
    fail("recovered API marker or captured entrypoint is invalid");
  }
  verifyFirstClassWorkerLive(
    runner,
    request,
    workerRevision,
    receipt.fencingGeneration,
    workerSourceTemplate,
  );
  const recoveredWorker = assertExactActiveRevision(
    runner,
    request,
    WORKER_APP,
    workerRevision,
    request.targetArtifacts.worker.image,
  );
  if (revisionEnv(recoveredWorker, "WORKFORCE_PRODUCTION_BOOTSTRAP_RECOVERY_SEQUENCE") !==
    String(workerRecovery.sequence)) {
    fail("recovered worker sequence marker is invalid");
  }
  const workerWebhookBindings = (recoveredWorker.properties?.template?.containers?.[0]?.env ?? [])
    .filter((entry) => entry?.name === "CLERK_WEBHOOK_SECRET");
  if (workerWebhookBindings.length !== 1 ||
    workerWebhookBindings[0].secretRef !== "clerk-webhook-secret" ||
    workerWebhookBindings[0].value !== undefined) {
    fail("recovered worker Clerk webhook secret binding is invalid");
  }
  const successors = {
    api: deploymentEvidence(runner, request, "api", apiRevision),
    worker: deploymentEvidence(runner, request, "worker", workerRevision),
  };
  const withoutHash = {
    schemaVersion: 1,
    kind: "first-class-api-worker-template-recovery",
    reasonCodes: {
      api: "containment-revision-supersession",
      worker: "quiescence-entrypoint-inheritance",
    },
    predecessors: { api: structuredClone(armed.api), worker: structuredClone(armed.worker) },
    successors,
    sourceEntrypointHashes: {
      api: canonicalHash(apiSourceEntrypoint),
      worker: canonicalHash(workerSourceEntrypoint),
    },
    workerSecretBinding: {
      name: "CLERK_WEBHOOK_SECRET",
      secretRef: "clerk-webhook-secret",
    },
    pausedQueueEvidenceHash,
    queuesRemainedPaused: true,
    liveSendAllowlistEmpty: true,
    recoveredAt: nowSecond(),
  };
  const recovery = { ...withoutHash, evidenceHash: canonicalHash(withoutHash) };
  const next = {
    ...state,
    activeIdentities: {
      ...state.activeIdentities,
      api: apiRevision,
      worker: workerRevision,
    },
    phaseEvidence: { ...state.phaseEvidence, firstClassRecovery: recovery },
    updatedAt: nowSecond(),
  };
  uploadState(runner, request, next, options.statePath);
  return { state: next, recovery };
}

function disabledWriteGates() {
  const gate = {
    deliveryUnknownWriteMode: "disabled",
    deliveryUnknownWriteAck: null,
    compatibilityEpoch: "outreach-delivery-unknown-v1",
    failedStatusWritesEnabled: false,
    failedStatusWritesAck: null,
  };
  return { api: gate, worker: { ...gate } };
}

function firstClassWriteGates() {
  return {
    api: disabledWriteGates().api,
    worker: {
      deliveryUnknownWriteMode: "first-class",
      deliveryUnknownWriteAck: "readers-drained-rollback-baselines-verified-v1",
      compatibilityEpoch: "outreach-delivery-unknown-v1",
      failedStatusWritesEnabled: true,
      failedStatusWritesAck: "readers-drained-legacy-inventory-reviewed-v1",
    },
  };
}

function phaseEvidencePath(state, options, key) {
  const evidence = state.phaseEvidence[key];
  if (!evidence) fail(`controller state has no ${key} evidence`);
  const path = join(options.stateDir, `${key}-context.json`);
  writeFileSync(path, `${canonicalJson(evidence)}\n`, { mode: 0o600, flag: "wx" });
  return path;
}

export function runReplayableOrderedSteps({
  orderedSteps,
  completedSteps,
  executeStep,
  checkpoint,
}) {
  if (!Array.isArray(orderedSteps) || !Array.isArray(completedSteps) ||
    completedSteps.some((step, index) => step !== orderedSteps[index])) {
    fail("replayable ordered-step progress is not an exact prefix");
  }
  let progress = [...completedSteps];
  for (let index = progress.length; index < orderedSteps.length; index += 1) {
    const step = orderedSteps[index];
    const result = executeStep(step, index);
    progress = orderedSteps.slice(0, index + 1);
    checkpoint([...progress], step, index, result);
  }
  return progress;
}

export function runReplayableMutationSteps({
  orderedSteps,
  completedSteps,
  executeStep,
  checkpoint,
}) {
  if (!Array.isArray(orderedSteps) || !Array.isArray(completedSteps) ||
    completedSteps.some((step, index) => step !== orderedSteps[index])) {
    fail("replayable mutation progress is not an exact prefix");
  }
  let progress = [...completedSteps];
  const results = Object.create(null);
  orderedSteps.forEach((step, index) => {
    // Completed steps are deliberately executed in adoption/readback mode on
    // every replay. This detects drift instead of trusting a stale journal.
    results[step] = executeStep(step, index, index < progress.length);
    if (index >= progress.length) {
      progress = orderedSteps.slice(0, index + 1);
      checkpoint([...progress], step, index, results[step]);
    }
  });
  return { completedSteps: progress, results };
}

function preOpenMutationJournal(state, key, kind, receiptSha256, generation, orderedSteps) {
  const existing = state.phaseEvidence[key];
  if (existing === undefined) {
    return {
      schemaVersion: 1,
      kind,
      receiptSha256,
      generation,
      orderedSteps: [...orderedSteps],
      completedSteps: [],
      updatedAt: nowSecond(),
    };
  }
  exactKeys(existing, [
    "schemaVersion", "kind", "receiptSha256", "generation", "orderedSteps",
    "completedSteps", "updatedAt",
  ], `${kind} progress`);
  if (existing.schemaVersion !== 1 || existing.kind !== kind ||
    existing.receiptSha256 !== receiptSha256 || existing.generation !== generation ||
    canonicalJson(existing.orderedSteps) !== canonicalJson(orderedSteps) ||
    !Array.isArray(existing.completedSteps) ||
    existing.completedSteps.some((step, index) => step !== orderedSteps[index])) {
    fail(`${kind} progress does not match the exact replay authority`);
  }
  canonicalTimestamp(existing.updatedAt, `${kind} progress updatedAt`);
  return existing;
}

function withPreOpenProgress(state, key, journal, completedSteps = journal.completedSteps) {
  return {
    ...state,
    phaseEvidence: {
      ...state.phaseEvidence,
      [key]: { ...journal, completedSteps, updatedAt: nowSecond() },
    },
    updatedAt: nowSecond(),
  };
}

export function classifyPreOpenActionReplay(
  ledger,
  initialProgressPhase,
  replayProgressPhase,
) {
  if (ledger?.phase === "HELD" && ledger.progressPhase === initialProgressPhase) {
    return "first-attempt";
  }
  if (ledger?.progressPhase === replayProgressPhase &&
    (ledger.phase === replayProgressPhase || ledger.phase === "HELD")) {
    return "mutation-replay";
  }
  fail(`pre-OPEN action cannot enter from ${String(ledger?.phase)}/${String(ledger?.progressPhase)}`);
}

function firstClassWorkerEnvironment(request, minimumGeneration) {
  return [
    ...FIRST_CLASS_WORKER_ENVIRONMENT,
    `WORKFORCE_PRODUCTION_BOOTSTRAP_ATTEMPT_ID=${request.attemptId}`,
    `WORKFORCE_PRODUCTION_BOOTSTRAP_MIN_WRITER_FENCE_GENERATION=${minimumGeneration}`,
    "OUTREACH_LIVE_FOR_ORGS=",
    "OUTREACH_DELIVERY_UNKNOWN_WRITE_MODE=first-class",
    "OUTREACH_DELIVERY_UNKNOWN_WRITE_ACK=readers-drained-rollback-baselines-verified-v1",
    "OUTREACH_ROLLBACK_COMPATIBILITY_EPOCH=outreach-delivery-unknown-v1",
    "OUTREACH_FAILED_STATUS_WRITES_ENABLED=true",
    "OUTREACH_FAILED_STATUS_WRITES_ACK=readers-drained-legacy-inventory-reviewed-v1",
    "EVIDENCE_LEDGER_ENABLED=true",
  ];
}

function deployCompatible(runner, request, state, options) {
  const verified = validateState(state, request);
  const replayMode = classifyPreOpenActionReplay(
    verified.ledger,
    "B3_SCHEMA_FORWARD_ONLY",
    "B4_SCHEMA_VERIFIED",
  );
  const firstAttempt = replayMode === "first-attempt";
  const mutationReplay = replayMode === "mutation-replay";
  if (state.migrationProgress.length !== MIGRATIONS.length) {
    fail("deploy-compatible requires all nine exact migrations or an exact persisted B4 replay");
  }
  verifyAzureLease(runner, request);
  verifyReleaseLock(runner, request);
  const evidencePath = phaseEvidencePath(state, options, "schemaResult");
  const receiptBytes = verifyPhaseReceipt(
    runner,
    request,
    state,
    options,
    "production-schema-result",
    evidencePath,
    mutationReplay ? 2 : 1,
  );
  const receipt = strictJsonParse(receiptBytes, "production-schema-result receipt");
  if (state.phaseEvidence.schemaResult?.fencingGeneration !== receipt.fencingGeneration) {
    fail("production-schema-result receipt does not bind the proven schema result generation");
  }
  let next = state;
  if (firstAttempt) {
    if (receipt.fencingGeneration !== state.writerFenceGeneration) {
      fail("production-schema-result receipt does not bind the current writer-fence generation");
    }
    const result = advanceLedger(verified.ledgerBytes, {
      toPhase: "B4_SCHEMA_VERIFIED",
      fencingGeneration: receipt.fencingGeneration,
      receiptBytes,
      at: nowSecond(),
    });
    next = replaceLedger(state, result);
  } else {
    const storedReceipt = verified.ledger.receipts.at(-1);
    if (storedReceipt?.kind !== "production-schema-result" ||
      storedReceipt.sha256 !== sha256(receiptBytes) ||
      storedReceipt.bytesBase64 !== Buffer.from(receiptBytes).toString("base64")) {
      fail("B4 mutation replay supplied different production-schema-result receipt bytes");
    }
  }
  const deploymentSteps = ["console", "api", "worker", "api-ingress-disabled"];
  const deploymentJournal = preOpenMutationJournal(
    next,
    "compatibleDeploymentProgress",
    "compatible-deployment-progress",
    sha256(receiptBytes),
    receipt.fencingGeneration,
    deploymentSteps,
  );
  if (next.phaseEvidence.compatibleDeploymentProgress === undefined) {
    next = withPreOpenProgress(
      next,
      "compatibleDeploymentProgress",
      deploymentJournal,
    );
    // The B4 ledger transition and exact mutation journal are durable before
    // the first Container Apps mutation.
    uploadState(runner, request, next, options.statePath);
  }
  runRuntimeControl(
    runner,
    request,
    options.stateDir,
    "hold",
    next.writerFenceGeneration,
  );
  const deploymentRun = runReplayableMutationSteps({
    orderedSteps: deploymentSteps,
    completedSteps: deploymentJournal.completedSteps,
    executeStep: (step) => {
      if (step === "console") {
        return updateApp(
          runner,
          request,
          "console",
          request.targetArtifacts.console.image,
          request.targetArtifacts.console.plannedRevision,
          [`API_UPSTREAM_URL=${CONSOLE_API_UPSTREAM_URL}`],
          1,
          [],
          true,
        );
      }
      if (step === "api") {
        return updateApp(runner, request, "api", request.targetArtifacts.api.image, request.targetArtifacts.api.plannedRevision, [
          "GMAIL_WATCH_RENEWAL_ENABLED=false", "GRAPH_RUN_WORKER_ENABLED=false", "OUTREACH_WORKER_ENABLED=false", "SCHEDULER_ENABLED=false",
          `WORKFORCE_PRODUCTION_BOOTSTRAP_ATTEMPT_ID=${request.attemptId}`,
          `WORKFORCE_PRODUCTION_BOOTSTRAP_MIN_WRITER_FENCE_GENERATION=${receipt.fencingGeneration}`,
          "OUTREACH_LIVE_FOR_ORGS=", "OUTREACH_DELIVERY_UNKNOWN_WRITE_MODE=disabled", "OUTREACH_FAILED_STATUS_WRITES_ENABLED=false", "EVIDENCE_LEDGER_ENABLED=true",
        ], 1, [
          "WORKER_ENABLED",
          "OUTREACH_DELIVERY_UNKNOWN_WRITE_ACK",
          "OUTREACH_ROLLBACK_COMPATIBILITY_EPOCH",
          "OUTREACH_FAILED_STATUS_WRITES_ACK",
          "OUTREACH_DELIVERY_UNKNOWN_STATUS_WRITES_ENABLED",
          "OUTREACH_DELIVERY_UNKNOWN_STATUS_WRITES_ACK",
        ], true);
      }
      if (step === "worker") {
        return updateApp(runner, request, "worker", request.targetArtifacts.worker.image, request.targetArtifacts.worker.plannedRevision, [
          "GMAIL_WATCH_RENEWAL_ENABLED=false", "GRAPH_RUN_WORKER_ENABLED=false", "OUTREACH_WORKER_ENABLED=false", "SCHEDULER_ENABLED=false",
          `WORKFORCE_PRODUCTION_BOOTSTRAP_ATTEMPT_ID=${request.attemptId}`,
          `WORKFORCE_PRODUCTION_BOOTSTRAP_MIN_WRITER_FENCE_GENERATION=${receipt.fencingGeneration}`,
          "OUTREACH_LIVE_FOR_ORGS=", "OUTREACH_DELIVERY_UNKNOWN_WRITE_MODE=disabled", "OUTREACH_FAILED_STATUS_WRITES_ENABLED=false", "EVIDENCE_LEDGER_ENABLED=true",
        ], 0, [
          "WORKER_ENABLED",
          "OUTREACH_DELIVERY_UNKNOWN_WRITE_ACK",
          "OUTREACH_ROLLBACK_COMPATIBILITY_EPOCH",
          "OUTREACH_FAILED_STATUS_WRITES_ACK",
          "OUTREACH_DELIVERY_UNKNOWN_STATUS_WRITES_ENABLED",
          "OUTREACH_DELIVERY_UNKNOWN_STATUS_WRITES_ACK",
        ], true);
      }
      if (step === "api-ingress-disabled") {
        disableApiIngress(runner, request, true);
        return true;
      }
      fail(`unknown compatible deployment step ${step}`);
    },
    checkpoint: (completedSteps, step, _index, result) => {
      const activeIdentities = { ...next.activeIdentities };
      if (step === "console" || step === "api" || step === "worker") {
        activeIdentities[step] = result;
      }
      next = withPreOpenProgress(
        { ...next, activeIdentities },
        "compatibleDeploymentProgress",
        deploymentJournal,
        completedSteps,
      );
      uploadState(runner, request, next, options.statePath);
    },
  });
  const consoleRevision = deploymentRun.results.console;
  const apiRevision = deploymentRun.results.api;
  const workerRevision = deploymentRun.results.worker;
  verifyDisabledBaselineLive(runner, request, {
    api: apiRevision,
    worker: workerRevision,
    console: consoleRevision,
  }, receipt.fencingGeneration);
  const runtimeHeld = assertRuntimeHeldEvidence(
    runRuntimeControl(
      runner,
      request,
      options.stateDir,
      "read",
      next.writerFenceGeneration,
    ),
    request,
    next.writerFenceGeneration,
  );
  const deployments = {
    api: deploymentEvidence(runner, request, "api", apiRevision),
    worker: deploymentEvidence(runner, request, "worker", workerRevision),
    console: deploymentEvidence(runner, request, "console", consoleRevision),
  };
  const legacyCounts = {
    apiActiveLegacyRevisionCount: revisionList(runner, request, API_APP)
      .filter((entry) => entry?.properties?.active === true && entry.name !== apiRevision).length,
    workerActiveLegacyRevisionCount: revisionList(runner, request, WORKER_APP)
      .filter((entry) => entry?.properties?.active === true && entry.name !== workerRevision).length,
    consoleActiveLegacyRevisionCount: revisionList(runner, request, CONSOLE_APP)
      .filter((entry) => entry?.properties?.active === true && entry.name !== consoleRevision).length,
  };
  next = { ...next, activeIdentities: { api: apiRevision, worker: workerRevision, console: consoleRevision } };
  if (next.phaseEvidence.compatibleBaseline !== undefined) {
    const stored = next.phaseEvidence.compatibleBaseline;
    if (stored.fencingGeneration !== next.writerFenceGeneration ||
      canonicalJson(stored.evidence?.deployments) !== canonicalJson(deployments) ||
      !Object.values(legacyCounts).every((count) => count === 0)) {
      fail("stored compatible baseline cannot be adopted from the fresh live readback");
    }
    writeNewEvidence(options.output, stored);
    return {
      phase: "HELD",
      progressPhase: "B4_SCHEMA_VERIFIED",
      compatibleBaselineReady: true,
      replayAdopted: true,
    };
  }
  const currentLedger = verifyLedgerBytes(Buffer.from(next.phaseLedgerBase64, "base64")).ledger;
  if (currentLedger.phase !== "HELD") {
    next = holdState(next, "COMPATIBLE_BASELINE_APPROVAL_REQUIRED", {
      schemaVersion: 1,
      kind: "compatible-baseline-created",
      attemptId: request.attemptId,
      deploymentEvidenceHash: canonicalHash(deployments),
    });
  }
  let b5Generation = next.writerFenceGeneration;
  if (b5Generation <= next.fencingGeneration) {
    b5Generation = Math.max(next.fencingGeneration + 1, next.writerFenceGeneration + 1);
    runRuntimeControl(
      runner,
      request,
      options.stateDir,
      "renew",
      next.writerFenceGeneration,
      b5Generation,
    );
    next = { ...next, writerFenceGeneration: b5Generation };
    uploadState(runner, request, next, options.statePath);
  }
  const first = runQuiescence(runner, request, options.stateDir, "verify", "post-migration", b5Generation, "stopped", "b5-1");
  runner.run("sleep", ["5"], { label: "stable disabled-baseline queue observation interval" });
  const second = runQuiescence(runner, request, options.stateDir, "verify", "post-migration", b5Generation, "stopped", "b5-2");
  const legacyRevisions = {
    allLegacyRevisionsInactive: Object.values(legacyCounts).every((count) => count === 0),
    ...legacyCounts,
    evidenceHash: canonicalHash(legacyCounts),
  };
  const b5EvidenceWithoutHash = {
    deployments,
    writeGates: disabledWriteGates(),
    legacyRevisions,
    quiescence: closedQuiescence(first, second),
    compatibilityAttestation: "enum-aware-api-worker-console-baseline-v1",
  };
  const b5Evidence = {
    ...b5EvidenceWithoutHash,
    baselineEvidenceHash: canonicalHash({ ...b5EvidenceWithoutHash, runtimeHoldEvidenceHash: runtimeHeld.evidenceHash }),
  };
  const context = phaseContext(next, request, "enum-aware-disabled-baseline", b5Evidence, b5Generation, second.capturedAt);
  next = { ...next, phaseEvidence: { ...next.phaseEvidence, compatibleBaseline: context } };
  uploadState(runner, request, next, options.statePath);
  writeNewEvidence(options.output, context);
  return { phase: "HELD", progressPhase: "B4_SCHEMA_VERIFIED", compatibleBaselineReady: true };
}

function activateFirstClass(runner, request, state, options) {
  const verified = validateState(state, request);
  const replayMode = classifyPreOpenActionReplay(
    verified.ledger,
    "B4_SCHEMA_VERIFIED",
    "B5_COMPATIBLE_BASELINE",
  );
  const firstAttempt = replayMode === "first-attempt";
  const mutationReplay = replayMode === "mutation-replay";
  verifyAzureLease(runner, request);
  verifyReleaseLock(runner, request);
  const evidencePath = phaseEvidencePath(state, options, "compatibleBaseline");
  const receiptBytes = verifyPhaseReceipt(
    runner,
    request,
    state,
    options,
    "enum-aware-disabled-baseline",
    evidencePath,
    mutationReplay ? 2 : 1,
  );
  const receipt = strictJsonParse(receiptBytes, "enum-aware-disabled-baseline receipt");
  if (state.phaseEvidence.compatibleBaseline?.fencingGeneration !== receipt.fencingGeneration) {
    fail("enum-aware-disabled-baseline receipt does not bind the compatible baseline generation");
  }
  let next = state;
  if (firstAttempt) {
    if (receipt.fencingGeneration !== state.writerFenceGeneration) {
      fail("enum-aware-disabled-baseline receipt does not bind the current writer-fence generation");
    }
    const result = advanceLedger(verified.ledgerBytes, {
      toPhase: "B5_COMPATIBLE_BASELINE",
      fencingGeneration: receipt.fencingGeneration,
      receiptBytes,
      at: nowSecond(),
    });
    next = replaceLedger(state, result);
  } else {
    const storedReceipt = verified.ledger.receipts.at(-1);
    if (storedReceipt?.kind !== "enum-aware-disabled-baseline" ||
      storedReceipt.sha256 !== sha256(receiptBytes) ||
      storedReceipt.bytesBase64 !== Buffer.from(receiptBytes).toString("base64")) {
      fail("B5 mutation replay supplied different enum-aware-disabled-baseline receipt bytes");
    }
  }
  const activationSteps = ["worker-first-class"];
  const activationJournal = preOpenMutationJournal(
    next,
    "firstClassMutationProgress",
    "first-class-mutation-progress",
    sha256(receiptBytes),
    receipt.fencingGeneration,
    activationSteps,
  );
  if (next.phaseEvidence.firstClassMutationProgress === undefined) {
    next = withPreOpenProgress(
      next,
      "firstClassMutationProgress",
      activationJournal,
    );
    uploadState(runner, request, next, options.statePath);
  }
  runRuntimeControl(
    runner,
    request,
    options.stateDir,
    "hold",
    next.writerFenceGeneration,
  );
  const activationRun = runReplayableMutationSteps({
    orderedSteps: activationSteps,
    completedSteps: activationJournal.completedSteps,
    executeStep: () => updateApp(
      runner,
      request,
      "worker",
      request.targetArtifacts.worker.image,
      request.activationWorkerRevision,
      firstClassWorkerEnvironment(request, receipt.fencingGeneration),
      1,
      RETIRED_WORKER_ENVIRONMENT,
      true,
      state.privateRestoreBundle.workerRevision.properties.template,
    ),
    checkpoint: (completedSteps, _step, _index, revision) => {
      next = withPreOpenProgress(
        {
          ...next,
          activeIdentities: { ...next.activeIdentities, worker: revision },
        },
        "firstClassMutationProgress",
        activationJournal,
        completedSteps,
      );
      uploadState(runner, request, next, options.statePath);
    },
  });
  const revision = activationRun.results["worker-first-class"];
  verifyFirstClassWorkerLive(
    runner,
    request,
    revision,
    receipt.fencingGeneration,
    state.privateRestoreBundle.workerRevision.properties.template,
  );
  next = { ...next, activeIdentities: { ...next.activeIdentities, worker: revision } };
  const deployments = {
    api: deploymentEvidence(runner, request, "api", next.activeIdentities.api),
    worker: deploymentEvidence(runner, request, "worker", revision),
    console: deploymentEvidence(runner, request, "console", next.activeIdentities.console),
  };
  if (next.phaseEvidence.firstClassActivation !== undefined) {
    const stored = next.phaseEvidence.firstClassActivation;
    if (stored.fencingGeneration !== next.writerFenceGeneration ||
      canonicalJson(stored.evidence?.deployments) !== canonicalJson(deployments)) {
      fail("stored first-class activation cannot be adopted from the fresh live readback");
    }
    runQuiescence(
      runner,
      request,
      options.stateDir,
      "verify",
      "post-migration",
      next.writerFenceGeneration,
      "stopped",
      "b6-adopted",
    );
    writeNewEvidence(options.output, stored);
    return {
      phase: "HELD",
      progressPhase: "B5_COMPATIBLE_BASELINE",
      activationAttempted: true,
      replayAdopted: true,
    };
  }
  const currentLedger = verifyLedgerBytes(Buffer.from(next.phaseLedgerBase64, "base64")).ledger;
  if (currentLedger.phase !== "HELD") {
    next = holdState(next, "FIRST_CLASS_ACTIVATION_APPROVAL_REQUIRED", {
      schemaVersion: 1,
      kind: "first-class-worker-created",
      attemptId: request.attemptId,
      revision,
      evidenceHash: canonicalHash({ revision, image: request.targetArtifacts.worker.image }),
    });
  }
  let b6Generation = next.writerFenceGeneration;
  if (b6Generation <= next.fencingGeneration) {
    b6Generation = Math.max(next.fencingGeneration + 1, next.writerFenceGeneration + 1);
    runRuntimeControl(
      runner,
      request,
      options.stateDir,
      "renew",
      next.writerFenceGeneration,
      b6Generation,
    );
    next = { ...next, writerFenceGeneration: b6Generation };
    uploadState(runner, request, next, options.statePath);
  }
  const first = runQuiescence(runner, request, options.stateDir, "verify", "post-migration", b6Generation, "stopped", "b6-1");
  runner.run("sleep", ["5"], { label: "stable first-class queue observation interval" });
  const second = runQuiescence(runner, request, options.stateDir, "verify", "post-migration", b6Generation, "stopped", "b6-2");
  const b5Deployments = state.phaseEvidence.compatibleBaseline.evidence.deployments;
  const rollbackWithoutHash = {
    compatibilityAttestation: "enum-aware-api-worker-console-baseline-v1",
    compatibilityEpoch: "outreach-delivery-unknown-v1",
    deliveryUnknownWriteMode: "disabled",
    failedStatusWritesEnabled: false,
    api: { identity: b5Deployments.api.identity, available: true, active: true },
    worker: { identity: b5Deployments.worker.identity, available: true, active: false },
    console: { identity: b5Deployments.console.identity, available: true, active: true },
  };
  const rollbackBaseline = { ...rollbackWithoutHash, evidenceHash: canonicalHash(rollbackWithoutHash) };
  const inventory = second.database;
  const b6EvidenceWithoutHash = {
    deployments,
    writeGates: firstClassWriteGates(),
    rollbackBaseline,
    readerDrain: {
      legacyApiReadersActive: 0,
      legacyWorkerWritersActive: 0,
      legacyConsoleReadersActive: 0,
      evidenceHash: canonicalHash({ api: 0, worker: 0, console: 0 }),
    },
    deliveryUnknownActivation: {
      readersDrained: true,
      rollbackBaselinesVerified: true,
      firstClassDeliveryUnknownRows: inventory.firstClassDeliveryUnknownRows,
      evidenceHash: canonicalHash({
        firstClassDeliveryUnknownRows: inventory.firstClassDeliveryUnknownRows,
        snapshotEvidenceHash: second.evidenceHash,
      }),
    },
    failedActivation: {
      readersDrained: true,
      legacyInventoryReviewed: true,
      unreviewedHistoricalMarkersPromotedRows: 0,
      firstClassFailedRows: inventory.firstClassFailedRows,
      legacyInventoryEvidenceHash: canonicalHash({
        legacyDeliveryUnknownMarkerRows: inventory.legacyDeliveryUnknownMarkerRows,
        legacyAutoFailedMarkerRows: inventory.legacyAutoFailedMarkerRows,
      }),
      evidenceHash: canonicalHash({
        firstClassFailedRows: inventory.firstClassFailedRows,
        snapshotEvidenceHash: second.evidenceHash,
      }),
    },
    quiescence: closedQuiescence(first, second),
  };
  const b6Evidence = {
    ...b6EvidenceWithoutHash,
    activationEvidenceHash: canonicalHash(b6EvidenceWithoutHash),
  };
  const context = phaseContext(next, request, "first-class-activation", b6Evidence, b6Generation, second.capturedAt);
  next = { ...next, phaseEvidence: { ...next.phaseEvidence, firstClassActivation: context } };
  uploadState(runner, request, next, options.statePath);
  writeNewEvidence(options.output, context);
  return { phase: "HELD", progressPhase: "B5_COMPATIBLE_BASELINE", activationAttempted: true };
}

function enableApiIngress(runner, request, state) {
  const originalIngress = state.privateRestoreBundle.apiResource.properties?.configuration?.ingress;
  const targetPort = originalIngress?.targetPort;
  if (!Number.isSafeInteger(targetPort) || targetPort < 1 || targetPort > 65535 || originalIngress?.external !== true) fail("private source API ingress contract is invalid");
  const before = appState(
    runner,
    request,
    request.authority.apiContainerAppResourceId,
    "API ingress pre-enable",
  );
  if (before.properties?.configuration?.activeRevisionsMode !== "Single") {
    fail("API ingress enable requires single revision mode");
  }
  assertExactActiveRevision(
    runner,
    request,
    API_APP,
    state.activeIdentities.api,
    request.targetArtifacts.api.image,
  );
  const ingress = {
    external: true,
    targetPort,
    transport: originalIngress.transport ?? "auto",
    allowInsecure: false,
    traffic: [{ latestRevision: true, weight: 100 }],
  };
  for (const key of [
    "additionalPortMappings", "clientCertificateMode", "corsPolicy", "customDomains",
    "exposedPort", "ipSecurityRestrictions", "stickySessions",
  ]) {
    if (originalIngress[key] !== undefined && originalIngress[key] !== null) {
      ingress[key] = structuredClone(originalIngress[key]);
    }
  }
  azureMutation(runner, request, [
    "rest",
    "--method", "patch",
    "--url", `${request.authority.apiContainerAppResourceId}?api-version=2024-03-01`,
    "--body", canonicalJson({ properties: { configuration: { ingress } } }),
    "--output", "none",
  ], "API ingress enable");

  return verifyApiIngressLive(runner, request, state, "resumed API");
}

function verifyApiIngressLive(runner, request, state, label = "API") {
  const originalIngress = state.privateRestoreBundle.apiResource.properties?.configuration?.ingress;
  const targetPort = originalIngress?.targetPort;
  if (!Number.isSafeInteger(targetPort) || targetPort < 1 || targetPort > 65535 ||
    originalIngress?.external !== true) {
    fail("private source API ingress contract is invalid");
  }
  const expectedTransport = originalIngress.transport ?? "auto";
  let readback = null;
  for (let observation = 0; observation < 36; observation += 1) {
    const candidate = appState(
      runner,
      request,
      request.authority.apiContainerAppResourceId,
      `${label} ingress`,
    );
    const ingress = candidate.properties?.configuration?.ingress;
    const traffic = ingress?.traffic;
    if (candidate.properties?.provisioningState === "Succeeded" &&
      candidate.properties?.configuration?.activeRevisionsMode === "Single" &&
      ingress?.external === true && Array.isArray(traffic) && traffic.length === 1 &&
      ingress.targetPort === targetPort && ingress.transport === expectedTransport &&
      ingress.allowInsecure === false &&
      traffic[0]?.weight === 100 && traffic[0]?.latestRevision === true &&
      (traffic[0]?.revisionName === undefined || traffic[0]?.revisionName === null) &&
      candidate.properties?.latestReadyRevisionName === state.activeIdentities.api) {
      readback = candidate;
      break;
    }
    runner.run("sleep", ["5"], { label: "API ingress enable readiness interval" });
  }
  if (readback === null) {
    fail("API ingress or exact revision traffic readback is ambiguous");
  }
  assertExactActiveRevision(
    runner,
    request,
    API_APP,
    state.activeIdentities.api,
    request.targetArtifacts.api.image,
  );
  const fqdn = string(
    readback.properties.configuration.ingress.fqdn,
    /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/,
    "resumed API FQDN",
  );
  runner.run("curl", [
    "--fail", "--silent", "--show-error", "--max-time", "20",
    "--proto", "=https", `https://${fqdn}/api/health/ready`,
  ], { label: `${label} /api/health/ready` });
  const value = {
    external: true,
    targetPort,
    fqdn,
    revision: state.activeIdentities.api,
    trafficWeight: 100,
    latestReadyRevision: state.activeIdentities.api,
    readinessPassed: true,
    observedAt: nowSecond(),
  };
  return { ...value, evidenceHash: canonicalHash(value) };
}

function verifyLiveReleaseConfiguration(runner, request) {
  const helper = requireSnapshotFile("scripts/verify-containerapp-release-config.sh", true);
  const result = runner.run(helper, [
    request.targetArtifacts.api.image,
    request.targetArtifacts.worker.image,
  ], { label: "live production Container App release configuration" });
  const withoutHash = {
    schemaVersion: 1,
    kind: "production-containerapp-release-configuration-readback",
    bootstrapAttemptId: request.attemptId,
    backendCandidateCommit: request.backendCandidate.commit,
    apiImage: request.targetArtifacts.api.image,
    workerImage: request.targetArtifacts.worker.image,
    helperSha256: sha256(readFileSync(helper)),
    outputSha256: sha256(result.stdout),
    verifiedAt: nowSecond(),
    verified: true,
  };
  return { ...withoutHash, evidenceHash: canonicalHash(withoutHash) };
}

function bootstrapStep(sequence, action, startedAt, completedAt) {
  const value = { sequence, action, startedAt, completedAt };
  canonicalTimestamp(startedAt, `${action} start`);
  canonicalTimestamp(completedAt, `${action} completion`);
  if (Date.parse(completedAt) < Date.parse(startedAt)) fail(`${action} completed before it started`);
  return { ...value, evidenceHash: canonicalHash(value) };
}

function assertResumeQueueSet(queues, paused, label) {
  exactKeys(queues, ["agentRuns", "graphRuns", "outreachSend"], label);
  for (const key of ["agentRuns", "graphRuns", "outreachSend"]) {
    const queue = queues[key];
    exactKeys(queue, [
      "paused", "waiting", "active", "delayed", "prioritized", "completed",
      "failed", "waitingChildren", "pausedJobs", "workerCount",
    ], `${label}.${key}`);
    const expectedPaused = key === "agentRuns" ? true : paused;
    if (queue.paused !== expectedPaused) fail(`${label}.${key} pause state is invalid`);
    for (const count of [
      "waiting", "active", "delayed", "prioritized", "completed", "failed",
      "waitingChildren", "pausedJobs", "workerCount",
    ]) safeInteger(queue[count], `${label}.${key}.${count}`, 0);
    if (key === "agentRuns") {
      if (queue.active !== 0 || queue.workerCount !== 0) {
        fail(`${label}.${key} does not prove the retired queue paused, idle, and worker-free`);
      }
    } else if ((paused && queue.active !== 0) || queue.workerCount < 1) {
      fail(`${label}.${key} does not prove a connected, drained supported consumer`);
    }
  }
  return queues;
}

function buildTerminalOpenIntent(request, generation, previousStateHash) {
  const value = {
    bootstrapAttemptId: request.attemptId,
    generation,
    previousStateHash,
    persistedAt: nowSecond(),
    forwardOnly: true,
  };
  return { ...value, evidenceHash: canonicalHash(value) };
}

function validateTerminalOpenIntent(intent, request) {
  exactKeys(intent, [
    "bootstrapAttemptId", "generation", "previousStateHash", "persistedAt",
    "forwardOnly", "evidenceHash",
  ], "terminal OPEN intent");
  if (intent.bootstrapAttemptId !== request.attemptId || intent.forwardOnly !== true) {
    fail("terminal OPEN intent identity is invalid");
  }
  safeInteger(intent.generation, "terminal OPEN intent generation", 1);
  string(intent.previousStateHash, /^sha256:[0-9a-f]{64}$/, "terminal OPEN previous state hash");
  canonicalTimestamp(intent.persistedAt, "terminal OPEN intent persistence time");
  const { evidenceHash, ...withoutHash } = intent;
  if (evidenceHash !== canonicalHash(withoutHash)) fail("terminal OPEN intent evidence hash is invalid");
  return intent;
}

function assertRuntimeResumeEvidence(runtime, request, intent) {
  if (runtime.bootstrapAttemptId !== request.attemptId || runtime.queuesResumed !== true) {
    fail("runtime resume evidence identity is invalid");
  }
  if (!Array.isArray(runtime.steps) || runtime.steps.length !== 4) {
    fail("runtime resume evidence does not contain the exact four runtime steps");
  }
  const actions = [
    "release-writer-fence", "start-first-class-consumers", "resume-graph-runs",
    "resume-outreach-send",
  ];
  let previousCompletion = null;
  runtime.steps.forEach((step, index) => {
    exactKeys(step, ["sequence", "action", "startedAt", "completedAt", "evidenceHash"], `runtime resume step ${index + 1}`);
    if (step.sequence !== index + 1 || step.action !== actions[index]) {
      fail(`runtime resume step ${index + 1} is out of order`);
    }
    canonicalTimestamp(step.startedAt, `runtime resume step ${index + 1} start`);
    canonicalTimestamp(step.completedAt, `runtime resume step ${index + 1} completion`);
    if (Date.parse(step.completedAt) < Date.parse(step.startedAt) ||
      (previousCompletion !== null && Date.parse(step.startedAt) < previousCompletion)) {
      fail(`runtime resume step ${index + 1} has an invalid time order`);
    }
    previousCompletion = Date.parse(step.completedAt);
    string(step.evidenceHash, /^sha256:[0-9a-f]{64}$/, `runtime resume step ${index + 1} evidence hash`);
  });
  assertResumeQueueSet(runtime.pausedConnectedQueues, true, "paused connected consumers");
  assertResumeQueueSet(runtime.queues, false, "resumed queues");
  const release = runtime.writerFenceRelease;
  exactKeys(release, [
    "bootstrapAttemptId", "generation", "previousStateHash", "openEpoch",
    "openStateHash", "releasedAt", "terminalOpen", "evidenceHash",
  ], "runtime terminal OPEN release");
  exactKeys(release.openEpoch, [
    "schemaVersion", "target", "mode", "bootstrapAttemptId", "generation",
  ], "runtime terminal OPEN epoch");
  if (release.bootstrapAttemptId !== request.attemptId ||
    release.generation !== intent.generation ||
    release.previousStateHash !== intent.previousStateHash ||
    release.terminalOpen !== true ||
    release.releasedAt !== runtime.steps[0].completedAt ||
    release.openEpoch.schemaVersion !== 1 ||
    release.openEpoch.target !== "workforce-os-production" ||
    release.openEpoch.mode !== "open" ||
    release.openEpoch.bootstrapAttemptId !== request.attemptId ||
    release.openEpoch.generation !== intent.generation) {
    fail("runtime resume did not prove the exact durable terminal OPEN intent");
  }
  for (const [value, label] of [
    [release.openStateHash, "runtime terminal OPEN state hash"],
    [release.evidenceHash, "runtime terminal OPEN evidence hash"],
  ]) string(value, /^sha256:[0-9a-f]{64}$/, label);
  if (runtime.database?.databaseIdentityHash !== request.databaseIdentityHash) {
    fail("runtime resume database identity drift detected");
  }
  return runtime;
}

function guardedRevisionGeneration(revision, request, role) {
  const value = revisionEnv(
    revision,
    "WORKFORCE_PRODUCTION_BOOTSTRAP_MIN_WRITER_FENCE_GENERATION",
  );
  string(value, /^[1-9][0-9]*$/, `${role} writer-fence generation`);
  const generation = Number(value);
  safeInteger(generation, `${role} writer-fence generation`, 1);
  verifyCandidateWriterGuard(revision, request, generation, role);
  return generation;
}

function captureFreshCompletionReadback(runner, request, state, options) {
  verifyAzureLease(runner, request);
  verifyReleaseLock(runner, request);
  const intent = validateTerminalOpenIntent(state.phaseEvidence.terminalOpenIntent, request);
  if (intent.generation !== state.writerFenceGeneration) {
    fail("fresh completion readback has no exact terminal OPEN generation");
  }
  const runtime = runRuntimeControl(
    runner,
    request,
    options.stateDir,
    "read-open",
    intent.generation,
  );
  if (runtime.schemaVersion !== 1 ||
    runtime.kind !== "production-bootstrap-runtime-open-readback" ||
    runtime.bootstrapAttemptId !== request.attemptId ||
    runtime.writerFence?.state !== null ||
    runtime.writerFence?.epoch?.mode !== "open" ||
    runtime.writerFence?.epoch?.bootstrapAttemptId !== request.attemptId ||
    runtime.writerFence?.epoch?.generation !== intent.generation ||
    runtime.writerFence?.generation !== intent.generation ||
    runtime.writerFence?.activeWriters !== 0 ||
    runtime.writerFence?.activeComplianceWriters !== 0) {
    fail("fresh completion readback does not prove the exact zero-writer terminal OPEN epoch");
  }
  assertResumeQueueSet(runtime.queues, false, "fresh completion queues");
  for (const [name, queue] of Object.entries(runtime.queues)) {
    for (const field of [
      "waiting", "active", "delayed", "prioritized", "waitingChildren", "pausedJobs",
    ]) {
      if (queue[field] !== 0) {
        fail(`fresh completion queue ${name}.${field} is not idle`);
      }
    }
  }
  if (runtime.database?.databaseIdentityHash !== request.databaseIdentityHash) {
    fail("fresh completion database identity drift detected");
  }
  for (const field of [
    "sendingRows",
    "firstClassDeliveryUnknownRows",
    "firstClassFailedRows",
  ]) {
    if (runtime.database[field] !== 0) {
      fail(`fresh completion database inventory ${field} must be zero`);
    }
  }

  const api = assertExactActiveRevision(
    runner,
    request,
    API_APP,
    state.activeIdentities.api,
    request.targetArtifacts.api.image,
  );
  const worker = assertExactActiveRevision(
    runner,
    request,
    WORKER_APP,
    state.activeIdentities.worker,
    request.targetArtifacts.worker.image,
  );
  assertExactActiveRevision(
    runner,
    request,
    CONSOLE_APP,
    state.activeIdentities.console,
    request.targetArtifacts.console.image,
  );
  const apiGuardGeneration = guardedRevisionGeneration(api, request, "completion API");
  const workerGuardGeneration = guardedRevisionGeneration(worker, request, "completion worker");
  if (apiGuardGeneration > intent.generation || workerGuardGeneration > intent.generation) {
    fail("fresh completion revision requires a writer-fence generation newer than terminal OPEN");
  }
  for (const gate of [
    "GMAIL_WATCH_RENEWAL_ENABLED", "GRAPH_RUN_WORKER_ENABLED", "OUTREACH_WORKER_ENABLED",
    "SCHEDULER_ENABLED",
  ]) {
    if (revisionEnv(api, gate) !== "false") fail(`completion API ${gate} is not false`);
  }
  if (revisionEnv(api, "WORKER_ENABLED") !== null) {
    fail("completion API retains retired WORKER_ENABLED");
  }
  if (revisionEnv(api, "OUTREACH_LIVE_FOR_ORGS") !== "" ||
    revisionEnv(api, "OUTREACH_DELIVERY_UNKNOWN_WRITE_MODE") !== "disabled" ||
    revisionEnv(api, "OUTREACH_FAILED_STATUS_WRITES_ENABLED") !== "false") {
    fail("completion API write gates or live-send allowlist drifted");
  }
  verifyFirstClassWorkerLive(
    runner,
    request,
    state.activeIdentities.worker,
    workerGuardGeneration,
    state.privateRestoreBundle.workerRevision.properties.template,
  );
  const deployments = {
    api: deploymentEvidence(runner, request, "api", state.activeIdentities.api),
    worker: deploymentEvidence(runner, request, "worker", state.activeIdentities.worker),
    console: deploymentEvidence(runner, request, "console", state.activeIdentities.console),
  };
  const signedDeployments = state.phaseEvidence.complete?.evidence?.deployments;
  if (canonicalJson(deployments) !== canonicalJson(signedDeployments)) {
    fail("fresh completion ACA revisions, images, templates, or environment drifted from signed approval");
  }
  const apiIngress = verifyApiIngressLive(runner, request, state, "completion API");
  const releaseConfiguration = verifyLiveReleaseConfiguration(runner, request);
  const operationalSmokeEvidence = assertPersistedOperationalSmokeEvidence(request, state);
  const signedHealth = state.phaseEvidence.complete?.evidence?.health;
  if (signedHealth?.releaseConfigVerified !== true ||
    !/^sha256:[0-9a-f]{64}$/.test(signedHealth.releaseConfigEvidenceHash ?? "") ||
    signedHealth.failedListSmokeEvidenceHash !== operationalSmokeEvidence.failedList.evidenceHash ||
    signedHealth.dashboardPolicySmokeEvidenceHash !==
      operationalSmokeEvidence.dashboardPolicy.evidenceHash) {
    fail("fresh completion health evidence does not match the signed protected bindings");
  }
  verifyAzureLease(runner, request);
  verifyReleaseLock(runner, request);
  const withoutHash = {
    schemaVersion: 1,
    kind: "bootstrap-complete-fresh-live-readback",
    bootstrapAttemptId: request.attemptId,
    capturedAt: nowSecond(),
    terminalOpen: {
      generation: intent.generation,
      stateHash: runtime.writerFence.stateHash,
      activeWriters: 0,
      activeComplianceWriters: 0,
    },
    queues: runtime.queues,
    database: runtime.database,
    deployments,
    apiIngress,
    releaseConfiguration,
    operationalSmokeEvidenceHashes: {
      failedList: operationalSmokeEvidence.failedList.evidenceHash,
      dashboardPolicy: operationalSmokeEvidence.dashboardPolicy.evidenceHash,
    },
    liveSendAllowlistEmpty: true,
  };
  return { ...withoutHash, evidenceHash: canonicalHash(withoutHash) };
}

function resumeBootstrap(runner, request, state, options) {
  const verified = validateState(state, request);
  const firstAttempt = verified.ledger.phase === "HELD" &&
    verified.ledger.progressPhase === "B5_COMPATIBLE_BASELINE";
  const forwardRetry = verified.ledger.progressPhase === "B7_RESUMING" &&
    (verified.ledger.phase === "B7_RESUMING" || verified.ledger.phase === "HELD");
  if (!firstAttempt && !forwardRetry) {
    fail("resume requires held B5 activation state or an exact forward-only B7 retry");
  }
  if (state.phaseEvidence.pendingContextInvalidatedAtGeneration !== undefined) {
    fail("resume context was invalidated by a hold renewal and must be regenerated");
  }
  const evidencePath = phaseEvidencePath(state, options, "firstClassActivation");
  const receiptBytes = verifyPhaseReceipt(
    runner,
    request,
    state,
    options,
    "first-class-activation",
    evidencePath,
    forwardRetry ? 2 : 1,
  );
  const receipt = strictJsonParse(receiptBytes, "first-class-activation receipt");
  let next = state;
  if (firstAttempt) {
    if (receipt.fencingGeneration !== state.writerFenceGeneration ||
      state.phaseEvidence.firstClassActivation?.fencingGeneration !== receipt.fencingGeneration) {
      fail("first-class activation receipt does not bind the current CLOSED writer fence");
    }
    let result = advanceLedger(verified.ledgerBytes, {
      toPhase: "B6_FIRST_CLASS_ARMED",
      fencingGeneration: receipt.fencingGeneration,
      receiptBytes,
      at: nowSecond(),
    });
    result = advanceLedger(result.ledgerBytes, {
      toPhase: "B7_RESUMING",
      fencingGeneration: receipt.fencingGeneration + 1,
      at: nowSecond(),
    });
    next = replaceLedger(state, result);
    uploadState(runner, request, next, options.statePath);
  } else {
    const storedReceipt = verified.ledger.receipts.at(-1);
    if (storedReceipt?.kind !== "first-class-activation" ||
      storedReceipt.sha256 !== sha256(receiptBytes) ||
      storedReceipt.bytesBase64 !== Buffer.from(receiptBytes).toString("base64")) {
      fail("forward-only B7 retry supplied different first-class activation receipt bytes");
    }
    if (state.phaseEvidence.complete) {
      writeNewEvidence(options.output, state.phaseEvidence.complete);
      return { phase: verified.ledger.phase, progressPhase: "B7_RESUMING", alreadyResumed: true };
    }
  }
  verifyAzureLease(runner, request);
  verifyReleaseLock(runner, request);

  let terminalOpenIntent = next.phaseEvidence.terminalOpenIntent;
  if (terminalOpenIntent === undefined) {
    const openGeneration = Math.max(
      next.fencingGeneration + 1,
      next.writerFenceGeneration + 1,
    );
    const renewed = runRuntimeControl(
      runner,
      request,
      options.stateDir,
      "renew",
      next.writerFenceGeneration,
      openGeneration,
    );
    assertRuntimeHeldEvidence(renewed, request, openGeneration);
    const previousStateHash = renewed.writerFence?.stateHash;
    string(previousStateHash, /^sha256:[0-9a-f]{64}$/, "terminal OPEN previous CLOSED state hash");
    next = { ...next, writerFenceGeneration: openGeneration };
    uploadState(runner, request, next, options.statePath);
    terminalOpenIntent = buildTerminalOpenIntent(request, openGeneration, previousStateHash);
    next = {
      ...next,
      phaseEvidence: { ...next.phaseEvidence, terminalOpenIntent },
    };
    // The one-way intent is durable before the CLOSED -> OPEN compare-and-set.
    uploadState(runner, request, next, options.statePath);
  } else {
    validateTerminalOpenIntent(terminalOpenIntent, request);
    if (next.writerFenceGeneration !== terminalOpenIntent.generation) {
      fail("stored terminal OPEN intent and writer-fence generation disagree");
    }
  }

  try {
    // Every retry first contains any lost-ack partial resume. The terminal
    // OPEN epoch remains one-way; only ingress and queues are re-contained.
    disableApiIngress(runner, request);
    const pausedRuntime = runRuntimeControl(
      runner,
      request,
      options.stateDir,
      "pause-only",
      terminalOpenIntent.generation,
    );
    string(
      pausedRuntime.evidenceHash,
      /^sha256:[0-9a-f]{64}$/,
      "pre-resume paused queue evidence hash",
    );
    const deploymentRecovery = ensureFirstClassDeploymentsForResume(
      runner,
      request,
      next,
      receipt,
      pausedRuntime.evidenceHash,
      options,
    );
    next = deploymentRecovery.state;
    const runtime = assertRuntimeResumeEvidence(
      runRuntimeControl(
        runner,
        request,
        options.stateDir,
        "resume",
        terminalOpenIntent.generation,
        undefined,
        terminalOpenIntent.previousStateHash,
      ),
      request,
      terminalOpenIntent,
    );

    const apiStartedAt = nowSecond();
    const apiIngress = enableApiIngress(runner, request, next);
    const apiCompletedAt = nowSecond();
    const apiStep = bootstrapStep(
      5,
      "unblock-api-mutations",
      apiStartedAt,
      apiCompletedAt,
    );
    if (Date.parse(apiStartedAt) < Date.parse(runtime.steps.at(-1).completedAt)) {
      fail("API ingress was restored before queue resume completed");
    }

    const armed = next.phaseEvidence.firstClassActivation?.evidence;
    if (!armed) fail("signed first-class activation evidence is absent");
    const liveDeployments = {
      api: deploymentEvidence(runner, request, "api", next.activeIdentities.api),
      worker: deploymentEvidence(runner, request, "worker", next.activeIdentities.worker),
      console: deploymentEvidence(runner, request, "console", next.activeIdentities.console),
    };
    if (deploymentRecovery.recovery === null) {
      if (canonicalJson(liveDeployments) !== canonicalJson(armed.deployments)) {
        fail("resumed live deployments drifted from the signed first-class activation evidence");
      }
    } else {
      validateFirstClassRecoveryEvidence(next, deploymentRecovery.recovery, liveDeployments);
      if (canonicalJson(liveDeployments.console) !== canonicalJson(armed.deployments.console)) {
        fail("first-class deployment recovery changed the signed console deployment");
      }
    }
    const releaseConfiguration = verifyLiveReleaseConfiguration(runner, request);
    const operationalSmokeEvidence = assertPersistedOperationalSmokeEvidence(request, next);

    const pausedProofWithoutHash = {
      queues: runtime.pausedConnectedQueues,
      provedAt: runtime.steps[1].completedAt,
    };
    const pausedConsumerProof = {
      ...pausedProofWithoutHash,
      evidenceHash: canonicalHash(pausedProofWithoutHash),
    };
    const apiWithoutHash = {
      blocked: false,
      ingressEnabled: true,
      readinessPassed: apiIngress.readinessPassed,
      restoredAt: apiCompletedAt,
    };
    const apiMutations = { ...apiWithoutHash, evidenceHash: canonicalHash(apiWithoutHash) };
    const ambiguityWithoutHash = {
      policy: "repause-zero-scale-stable-zero-and-hold-terminal-open-forward-only-v1",
      containmentReady: true,
      ambiguousPartialResumeDetected: false,
      allQueuesRePauseRequired: true,
      apiAndWorkerZeroScaleRequired: true,
      stableZeroReplicasRequired: true,
      terminalOpenRecloseForbidden: true,
      holdForwardOnlyRequired: true,
    };
    const ambiguityControl = {
      ...ambiguityWithoutHash,
      evidenceHash: canonicalHash(ambiguityWithoutHash),
    };
    const resumeWithoutHash = {
      terminalOpenIntent,
      steps: [...runtime.steps, apiStep],
      pausedConsumerProof,
      queues: runtime.queues,
      writerFenceRelease: runtime.writerFenceRelease,
      apiMutations,
      ambiguityControl,
      liveSendAllowlistEmpty: true,
    };
    const resume = { ...resumeWithoutHash, evidenceHash: canonicalHash(resumeWithoutHash) };
    const healthWithoutHash = {
      apiReady: liveDeployments.api.active === true &&
        liveDeployments.api.soleActiveRevision === true &&
        liveDeployments.api.healthy === true && liveDeployments.api.provisioned === true &&
        apiIngress.readinessPassed === true,
      workerReady: liveDeployments.worker.active === true &&
        liveDeployments.worker.soleActiveRevision === true &&
        liveDeployments.worker.healthy === true && liveDeployments.worker.provisioned === true,
      consoleReady: liveDeployments.console.active === true &&
        liveDeployments.console.soleActiveRevision === true &&
        liveDeployments.console.healthy === true && liveDeployments.console.provisioned === true,
      releaseConfigVerified: releaseConfiguration.verified === true,
      failedListSmokePassed: operationalSmokeEvidence.failedList.passed === true,
      dashboardPolicySmokePassed: operationalSmokeEvidence.dashboardPolicy.passed === true,
      releaseConfigEvidenceHash: releaseConfiguration.evidenceHash,
      failedListSmokeEvidenceHash: operationalSmokeEvidence.failedList.evidenceHash,
      dashboardPolicySmokeEvidenceHash: operationalSmokeEvidence.dashboardPolicy.evidenceHash,
    };
    for (const [claim, proved] of Object.entries(healthWithoutHash)) {
      if (claim.endsWith("Ready") || claim.endsWith("Verified") || claim.endsWith("Passed")) {
        if (proved !== true) fail(`bootstrap completion health claim ${claim} was not proved`);
      }
    }
    const health = { ...healthWithoutHash, evidenceHash: canonicalHash(healthWithoutHash) };
    const inventoryWithoutHash = {
      sendingRows: runtime.database.sendingRows,
      firstClassDeliveryUnknownRows: runtime.database.firstClassDeliveryUnknownRows,
      firstClassFailedRows: runtime.database.firstClassFailedRows,
      unreviewedHistoricalMarkersPromotedRows:
        armed.failedActivation.unreviewedHistoricalMarkersPromotedRows,
    };
    for (const [name, value] of Object.entries(inventoryWithoutHash)) {
      if (value !== 0) fail(`final production inventory ${name} must be zero`);
    }
    const finalInventory = {
      ...inventoryWithoutHash,
      evidenceHash: canonicalHash(inventoryWithoutHash),
    };
    const b8Evidence = {
      deployments: structuredClone(liveDeployments),
      activationRecovery: deploymentRecovery.recovery === null
        ? null
        : structuredClone(deploymentRecovery.recovery),
      writeGates: structuredClone(armed.writeGates),
      rollbackBaseline: structuredClone(armed.rollbackBaseline),
      resume,
      health,
      finalInventory,
      bootstrapEvidenceHash: canonicalHash(request.bootstrapEvidence),
    };
    const completionGeneration = Math.max(
      next.fencingGeneration + 1,
      terminalOpenIntent.generation,
    );
    const context = phaseContext(
      next,
      request,
      "bootstrap-complete",
      b8Evidence,
      completionGeneration,
      apiCompletedAt,
    );
    next = { ...next, phaseEvidence: { ...next.phaseEvidence, complete: context } };
    uploadState(runner, request, next, options.statePath);
    writeNewEvidence(options.output, context);
    return {
      phase: verifyLedgerBytes(Buffer.from(next.phaseLedgerBase64, "base64")).ledger.phase,
      progressPhase: "B7_RESUMING",
      completionApprovalRequired: true,
      terminalOpen: true,
    };
  } catch (error) {
    const containmentFailures = [];
    try {
      disableApiIngress(runner, request);
    } catch (containmentError) {
      containmentFailures.push(`api:${sanitizeError(containmentError.message)}`);
    }
    try {
      runRuntimeControl(
        runner,
        request,
        options.stateDir,
        "pause-only",
        terminalOpenIntent.generation,
      );
    } catch (containmentError) {
      containmentFailures.push(`runtime:${sanitizeError(containmentError.message)}`);
    }
    try {
      const activeContainmentSource = (role, app) => {
        const active = revisionList(runner, request, app)
          .filter((entry) => entry?.properties?.active === true &&
            entry.properties?.template?.containers?.[0]?.image ===
              request.targetArtifacts[role].image);
        if (active.length !== 1) {
          fail(`${role} containment source is not one exact active candidate revision`);
        }
        return active[0].name;
      };
      quiesceAppWithParentWrite(
        runner,
        request,
        "api",
        `${API_APP}--bootstrap-hold-${terminalOpenIntent.generation}`,
        activeContainmentSource("api", API_APP),
      );
      quiesceAppWithParentWrite(
        runner,
        request,
        "worker",
        `${WORKER_APP}--bootstrap-hold-${terminalOpenIntent.generation}`,
        activeContainmentSource("worker", WORKER_APP),
      );
    } catch (containmentError) {
      containmentFailures.push(`revisions:${sanitizeError(containmentError.message)}`);
    }
    let stableZeroEvidenceHash = null;
    try {
      stableZeroEvidenceHash = proveStableZeroExecutionReplicas(runner, request).evidenceHash;
    } catch (containmentError) {
      containmentFailures.push(`replicas:${sanitizeError(containmentError.message)}`);
    }
    const heldEvidenceWithoutHash = {
      schemaVersion: 1,
      kind: "terminal-open-forward-only-hold",
      attemptId: request.attemptId,
      generation: terminalOpenIntent.generation,
      heldAt: nowSecond(),
      resumeError: sanitizeError(error.message),
      terminalOpenReclosed: false,
      apiIngressDisabled: !containmentFailures.some((value) => value.startsWith("api:")),
      queuesPaused: !containmentFailures.some((value) => value.startsWith("runtime:")),
      executionRevisionsDeactivated:
        !containmentFailures.some((value) => value.startsWith("revisions:")),
      stableZeroEvidenceHash,
      containmentFailures,
    };
    const heldEvidence = {
      ...heldEvidenceWithoutHash,
      evidenceHash: canonicalHash(heldEvidenceWithoutHash),
    };
    const currentLedger = verifyLedgerBytes(Buffer.from(next.phaseLedgerBase64, "base64")).ledger;
    if (currentLedger.phase !== "HELD") {
      next = holdState(next, "TERMINAL_OPEN_FORWARD_ONLY_HOLD", heldEvidence);
    } else {
      next = {
        ...next,
        phaseEvidence: { ...next.phaseEvidence, held: heldEvidence },
        updatedAt: nowSecond(),
      };
    }
    uploadState(runner, request, next, options.statePath);
    const rootCause = sanitizeError(error.message);
    fail(containmentFailures.length === 0
      ? `resume was not proven (${rootCause}); ingress and queues are contained, execution replicas are stably zero, and terminal OPEN remains forward-only`
      : `resume was not proven (${rootCause}) and containment is incomplete (${containmentFailures.join(";")}); terminal OPEN remains forward-only under the retained Azure lease`);
  }
}

function completeBootstrap(runner, request, state, options, leaseStatus) {
  const verified = validateState(state, request);
  const awaitingReceipt = verified.ledger.progressPhase === "B7_RESUMING" &&
    (verified.ledger.phase === "B7_RESUMING" || verified.ledger.phase === "HELD");
  const cleanupReplay = verified.ledger.phase === "B8_COMPLETE" &&
    verified.ledger.progressPhase === "B8_COMPLETE" && verified.ledger.consumed === true;
  if (!awaitingReceipt && !cleanupReplay) {
    fail("complete requires B7 completion approval or an exact consumed B8 cleanup replay");
  }
  if (awaitingReceipt) verifyReleaseLock(runner, request);
  const evidencePath = phaseEvidencePath(state, options, "complete");
  const receiptBytes = verifyPhaseReceipt(
    runner,
    request,
    state,
    options,
    "bootstrap-complete",
    evidencePath,
    cleanupReplay ? 2 : 1,
  );
  const receipt = strictJsonParse(receiptBytes, "bootstrap-complete receipt");
  let next = state;
  let completion;
  if (awaitingReceipt) {
    if (!leaseStatus.owned) fail("B8 ledger admission requires the exact Azure lease");
    if (receipt.fencingGeneration <= verified.ledger.fencingGeneration ||
      state.phaseEvidence.complete?.fencingGeneration !== receipt.fencingGeneration) {
      fail("bootstrap-complete receipt does not bind the reserved completion generation");
    }
    // This proof is captured after signed-receipt verification and immediately
    // before the consumed B8 transition. Its hash is part of the B8 ledger
    // event and tombstone, so cleanup cannot substitute the older B7 snapshot.
    const finalCompletionReadback = captureFreshCompletionReadback(
      runner,
      request,
      state,
      options,
    );
    const result = advanceLedger(verified.ledgerBytes, {
      toPhase: "B8_COMPLETE",
      fencingGeneration: receipt.fencingGeneration,
      receiptBytes,
      completionEvidenceHash: finalCompletionReadback.evidenceHash,
      at: nowSecond(),
    });
    completion = {
      ledgerSha256: result.ledgerSha256,
      tombstoneSha256: sha256Bytes(result.tombstoneBytes),
      completionEvidenceHash: finalCompletionReadback.evidenceHash,
      completedAt: result.ledger.updatedAt,
    };
    next = replaceLedger(state, result, {
      phaseEvidence: {
        ...state.phaseEvidence,
        finalCompletionReadback,
        tombstoneBase64: Buffer.from(result.tombstoneBytes).toString("base64"),
        completionCleanup: {
          releaseLockReleased: false,
          azureLeaseReleasePending: true,
        },
      },
    });
    // The consumed ledger and tombstone are durable before either authority
    // is released. All subsequent cleanup is exact, conditional, and replayable.
    uploadState(runner, request, next, options.statePath);
  } else {
    const storedReceipt = verified.ledger.receipts.at(-1);
    if (storedReceipt?.kind !== "bootstrap-complete" ||
      storedReceipt.sha256 !== sha256(receiptBytes) ||
      storedReceipt.bytesBase64 !== Buffer.from(receiptBytes).toString("base64")) {
      fail("B8 cleanup replay supplied different bootstrap-complete receipt bytes");
    }
    const tombstoneBytes = Buffer.from(state.phaseEvidence.tombstoneBase64, "base64");
    const finalCompletionReadback = state.phaseEvidence.finalCompletionReadback;
    if (!finalCompletionReadback || typeof finalCompletionReadback !== "object" ||
      Array.isArray(finalCompletionReadback)) {
      fail("consumed B8 state has no fresh completion readback");
    }
    const { evidenceHash, ...withoutHash } = finalCompletionReadback;
    string(evidenceHash, /^sha256:[0-9a-f]{64}$/, "fresh completion readback hash");
    if (evidenceHash !== canonicalHash(withoutHash) ||
      verified.ledger.events.at(-1)?.completionEvidenceHash !== evidenceHash) {
      fail("consumed B8 fresh completion readback is not bound to the ledger");
    }
    completion = {
      ledgerSha256: state.phaseLedgerSha256,
      tombstoneSha256: sha256Bytes(tombstoneBytes),
      completionEvidenceHash: evidenceHash,
      completedAt: verified.ledger.updatedAt,
    };
    if (!next.phaseEvidence.completionCleanup) {
      fail("consumed B8 state has no durable cleanup checkpoint");
    }
  }
  exactKeys(next.phaseEvidence.completionCleanup, [
    "releaseLockReleased", "azureLeaseReleasePending",
  ], "B8 cleanup checkpoint");
  if (typeof next.phaseEvidence.completionCleanup.releaseLockReleased !== "boolean" ||
    next.phaseEvidence.completionCleanup.azureLeaseReleasePending !== true) {
    fail("B8 cleanup checkpoint is invalid");
  }

  // Conditional Git cleanup happens while the stronger Azure lease is still
  // held. A lost Git acknowledgement is adopted only after an absent-ref
  // readback; the checkpoint is uploaded before releasing the Azure lease.
  if (!leaseStatus.owned && readReleaseLock(runner) !== null) {
    fail("release lock remains while the Azure cleanup lease is absent");
  }
  releaseReleaseLock(runner, request, options.stateDir);
  if (next.phaseEvidence.completionCleanup.releaseLockReleased !== true) {
    if (!leaseStatus.owned) {
      fail("released Azure lease cannot precede the durable Git cleanup checkpoint");
    }
    next = {
      ...next,
      phaseEvidence: {
        ...next.phaseEvidence,
        completionCleanup: {
          releaseLockReleased: true,
          azureLeaseReleasePending: true,
        },
      },
      updatedAt: nowSecond(),
    };
    uploadState(runner, request, next, options.statePath);
  }
  if (leaseStatus.owned) releaseAzureLease(runner, request);
  const finalLeaseStatus = inspectAzureLease(runner, request);
  if (!finalLeaseStatus.released) fail("Azure bootstrap lease release readback is ambiguous");
  writeNewEvidence(options.output, {
    schemaVersion: 1,
    kind: "initial-production-bootstrap-completed",
    attemptId: request.attemptId,
    completedAt: completion.completedAt,
    ledgerSha256: completion.ledgerSha256,
    tombstoneSha256: completion.tombstoneSha256,
    completionEvidenceHash: completion.completionEvidenceHash,
    releaseLockReleased: true,
    azureLeaseReleased: true,
  });
  return { phase: "B8_COMPLETE", consumed: true, cleanupReplayed: cleanupReplay };
}

function holdCurrent(runner, request, state, options) {
  const verified = validateState(state, request);
  verifyAzureLease(runner, request);
  const generation = state.writerFenceGeneration;
  const runtime = runRuntimeControl(runner, request, options.stateDir, "hold", generation);
  if (verified.ledger.phase === "HELD") return { phase: "HELD", alreadyHeld: true };
  const next = holdState(state, "OPERATOR_HOLD", runtime);
  uploadState(runner, request, next, options.statePath);
  return { phase: "HELD", controlsHeld: true };
}

function renewHold(runner, request, state, options) {
  const verified = validateState(state, request);
  if (verified.ledger.phase !== "HELD" || verified.ledger.progressPhase === "B8_COMPLETE") {
    fail("renew-hold requires an unconsumed HELD bootstrap state");
  }
  verifyAzureLease(runner, request);
  verifyReleaseLock(runner, request);
  const nextWriterGeneration = Math.max(
    state.writerFenceGeneration + 1,
    state.fencingGeneration + 1,
  );
  const runtime = runRuntimeControl(
    runner,
    request,
    options.stateDir,
    "renew",
    state.writerFenceGeneration,
    nextWriterGeneration,
  );
  const evidence = {
    schemaVersion: 1,
    kind: "bootstrap-held-writer-fence-renewal",
    attemptId: request.attemptId,
    previousGeneration: state.writerFenceGeneration,
    nextGeneration: nextWriterGeneration,
    renewedAt: nowSecond(),
    runtimeEvidenceHash: runtime.evidenceHash,
    pendingPhaseContextInvalidated: true,
  };
  const next = {
    ...state,
    writerFenceGeneration: nextWriterGeneration,
    phaseEvidence: {
      ...state.phaseEvidence,
      renewal: evidence,
      pendingContextInvalidatedAtGeneration: nextWriterGeneration,
    },
  };
  uploadState(runner, request, next, options.statePath);
  writeNewEvidence(options.output, evidence);
  return { phase: "HELD", writerFenceGeneration: nextWriterGeneration, contextRegenerationRequired: true };
}

function parseOptions(argv) {
  const values = Object.create(null);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--") || token === "--") fail(`unexpected argument ${token}`);
    const key = token.slice(2);
    if (Object.hasOwn(values, key)) fail(`duplicate option --${key}`);
    if (key === "yes") {
      values[key] = true;
      continue;
    }
    const value = argv[++index];
    if (!value || value.startsWith("--")) fail(`option --${key} requires a value`);
    values[key] = value;
  }
  const allowed = new Set([
    "action", "request", "state-dir", "output", "receipt", "signature",
    "allowed-signers", "superseded-request", "clerk-plan", "clerk-plan-signature",
    "clerk-plan-dry-run", "clerk-plan-dry-run-signature",
    "outstanding-delivery-review", "provider-delivery-drain",
    "database-ddl-authority-evidence", "failed-list-smoke-evidence",
    "dashboard-policy-smoke-evidence", "yes",
  ]);
  for (const key of Object.keys(values)) if (!allowed.has(key)) fail(`unknown option --${key}`);
  if (!ACTIONS.includes(values.action) || !values.request || !values["state-dir"] || !values.output) {
    fail("usage: production-bootstrap-controller.mjs --action ACTION --request ABSOLUTE_JSON --state-dir ABSOLUTE_DIR --output ABSOLUTE_JSON [--receipt FILE --signature FILE --allowed-signers FILE] [--clerk-plan FILE --clerk-plan-signature FILE --clerk-plan-dry-run FILE] --yes");
  }
  if (values.yes !== true) fail("controller execution requires explicit --yes");
  const needsReceipt = new Set(["invoke-clerk", "deploy-compatible", "activate-first-class", "resume", "complete"]).has(values.action);
  for (const key of ["receipt", "signature"]) {
    if (needsReceipt && !values[key]) fail(`${values.action} requires --${key}`);
    if (!needsReceipt && values[key]) fail(`--${key} is not valid for ${values.action}`);
  }
  const needsAllowedSigners = needsReceipt || values.action === "prepare";
  if (needsAllowedSigners && !values["allowed-signers"]) {
    fail(`${values.action} requires --allowed-signers`);
  }
  if (!needsAllowedSigners && values["allowed-signers"]) {
    fail(`--allowed-signers is not valid for ${values.action}`);
  }
  for (const key of ["clerk-plan", "clerk-plan-signature", "clerk-plan-dry-run", "clerk-plan-dry-run-signature"]) {
    if (values.action === "prepare" && !values[key]) fail(`prepare requires --${key}`);
    if (values.action !== "prepare" && values[key]) fail(`--${key} is not valid for ${values.action}`);
  }
  if (values["superseded-request"] && values.action !== "prepare") {
    fail("--superseded-request is valid only for prepare");
  }
  for (const key of [
    "outstanding-delivery-review", "provider-delivery-drain",
    "database-ddl-authority-evidence", "failed-list-smoke-evidence",
    "dashboard-policy-smoke-evidence",
  ]) {
    if (values.action === "prepare" && !values[key]) fail(`prepare requires --${key}`);
    if (values.action !== "prepare" && values[key]) fail(`--${key} is not valid for ${values.action}`);
  }
  const stateDir = validateExternalPath(values["state-dir"], "state directory", { directory: true });
  if ((statSync(stateDir).mode & 0o777) !== 0o700) fail("state directory must have mode 0700");
  return {
    action: values.action,
    request: validateExternalPath(values.request, "request file"),
    stateDir,
    statePath: join(stateDir, "controller-state.json"),
    output: values.output,
    receipt: values.receipt,
    signature: values.signature,
    allowedSigners: values["allowed-signers"],
    supersededRequest: values["superseded-request"] === undefined
      ? undefined
      : validateExternalPath(values["superseded-request"], "superseded bootstrap request"),
    clerkPlan: values["clerk-plan"],
    clerkPlanSignature: values["clerk-plan-signature"],
    clerkPlanDryRun: values["clerk-plan-dry-run"],
    clerkPlanDryRunSignature: values["clerk-plan-dry-run-signature"],
    outstandingDeliveryReview: values["outstanding-delivery-review"],
    providerDeliveryDrain: values["provider-delivery-drain"],
    databaseDdlAuthorityEvidence: values["database-ddl-authority-evidence"],
    failedListSmokeEvidence: values["failed-list-smoke-evidence"],
    dashboardPolicySmokeEvidence: values["dashboard-policy-smoke-evidence"],
  };
}

export function runController(argv, runner = new CommandRunner()) {
  const options = parseOptions(argv);
  const request = validateRequest(readBoundedJson(options.request, "bootstrap request"));
  assertProtectedRuntime(options.action);
  assertExactProtectedSnapshot(runner, request, options.action);
  if (options.action === "audit") {
    const result = auditPreconditions(runner, request);
    writeNewEvidence(options.output, result);
    return result;
  }
  verifyAzureIdentity(runner, request);
  if (options.action === "prepare") return prepare(runner, request, options);
  if (options.action === "complete") {
    const leaseStatus = inspectAzureLease(runner, request);
    const state = leaseStatus.owned
      ? downloadState(runner, request, options.statePath)
      : downloadStateWithoutLease(runner, request, options.statePath);
    validateState(state, request);
    return completeBootstrap(runner, request, state, options, leaseStatus);
  }
  verifyAzureLease(runner, request);
  const state = downloadState(runner, request, options.statePath);
  validateState(state, request);
  switch (options.action) {
    case "invoke-clerk": return invokeClerk(runner, request, state, options);
    case "apply-schema": return applySchema(runner, request, state, options);
    case "deploy-compatible": return deployCompatible(runner, request, state, options);
    case "activate-first-class": return activateFirstClass(runner, request, state, options);
    case "resume": return resumeBootstrap(runner, request, state, options);
    case "hold": return holdCurrent(runner, request, state, options);
    case "renew-hold": return renewHold(runner, request, state, options);
    default: fail(`unsupported action ${options.action}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  try {
    const result = runController(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`ERROR: ${sanitizeError(error instanceof Error ? error.message : error)}\n`);
    process.exitCode = 1;
  }
}
