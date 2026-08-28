#!/usr/bin/env node

/**
 * Offline, fail-closed state ledger for the one-time production bootstrap.
 *
 * This program deliberately has no Azure, PostgreSQL, Redis, queue, or resume
 * capability. It only admits an ordered, identity-bound receipt chain and
 * records monotonic state. A deployment controller must independently verify
 * live state before treating `resumeEligibility` as evidence.
 */

import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";
import {
  FINAL_PHASE_RECEIPT_SPECS,
  validateFinalPhaseReceiptObject,
} from "./production-bootstrap-phase-receipt-contracts.mjs";

export const PHASES = Object.freeze([
  "B0_ARTIFACT_READY",
  "B1_CONTROL_ACQUIRED",
  "B2_LEGACY_QUIESCED",
  "B3_SCHEMA_FORWARD_ONLY",
  "B4_SCHEMA_VERIFIED",
  "B5_COMPATIBLE_BASELINE",
  "B6_FIRST_CLASS_ARMED",
  "B7_RESUMING",
  "B8_COMPLETE",
]);

export const HELD = "HELD";

export const B8_COMMIT_FAULT_POINTS = Object.freeze({
  afterTombstoneWrite: "after-b8-tombstone-write",
  afterLedgerReplace: "after-b8-ledger-replace",
});

// B2 consumes the real, independently signature-verified entry v2 bytes. B4,
// B5, B6, and B8 consume the final phase-v1 contracts. Detached OpenSSH
// signatures are verified by the protected controller before ledger admission;
// this ledger independently revalidates every signed receipt byte and invariant.
export const RECEIPT_SEQUENCE = Object.freeze([
  Object.freeze({
    kind: "initial-bootstrap-entry",
    contractVersion: "signed-entry-v2",
    phase: "B2_LEGACY_QUIESCED",
    status: "prepared-and-quiesced",
    clerkInvocation: "not-invoked",
  }),
  Object.freeze({
    kind: "production-schema-result",
    contractVersion: "signed-phase-v1",
    phase: "B4_SCHEMA_VERIFIED",
    status: "applied-and-verified",
    clerkInvocation: "verified",
  }),
  Object.freeze({
    kind: "enum-aware-disabled-baseline",
    contractVersion: "signed-phase-v1",
    phase: "B5_COMPATIBLE_BASELINE",
    status: "verified-disabled",
    clerkInvocation: "verified",
  }),
  Object.freeze({
    kind: "first-class-activation",
    contractVersion: "signed-phase-v1",
    phase: "B6_FIRST_CLASS_ARMED",
    status: "verified-first-class-armed",
    clerkInvocation: "verified",
  }),
  Object.freeze({
    kind: "bootstrap-complete",
    contractVersion: "signed-phase-v1",
    phase: "B8_COMPLETE",
    status: "verified-complete",
    clerkInvocation: "verified",
  }),
]);

if (FINAL_PHASE_RECEIPT_SPECS.length !== 4 ||
  FINAL_PHASE_RECEIPT_SPECS.some((spec, index) => {
    const ledgerSpec = RECEIPT_SEQUENCE[index + 1];
    return spec.kind !== ledgerSpec.kind || spec.phase !== ledgerSpec.phase ||
      spec.status !== ledgerSpec.status || spec.sequence !== index + 2;
  })) {
  throw new Error("final phase receipt specifications disagree with the ledger sequence");
}

const LEDGER_SCHEMA_VERSION = 1;
const LEDGER_KIND = "initial-bootstrap-phase-ledger";
const TOMBSTONE_KIND = "initial-bootstrap-attempt-consumed";
const ENVIRONMENT = "production";
const MAX_LEDGER_BYTES = 2 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 128 * 1024;
const MAX_RECEIPT_LIFETIME_SECONDS = 60 * 60;
const MAX_JSON_DEPTH = 64;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const ATTEMPT_PATTERN = /^[0-9a-f]{32}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const PRINCIPAL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}$/;
const REASON_PATTERN = /^[A-Z0-9][A-Z0-9_-]{0,63}$/;
const API_IMAGE_PATTERN = /^workforceosprodacr\.azurecr\.io\/apex-api@sha256:[0-9a-f]{64}$/;
const CONSOLE_IMAGE_PATTERN = /^workforceosprodacr\.azurecr\.io\/workforceos-fe@sha256:[0-9a-f]{64}$/;
const API_REVISION_PATTERN = /^apex-gtm-api--[a-z0-9][a-z0-9-]{0,62}$/;
const WORKER_REVISION_PATTERN = /^apex-gtm-worker--[a-z0-9][a-z0-9-]{0,62}$/;
const CONSOLE_REVISION_PATTERN = /^nikxius-web--[a-z0-9][a-z0-9-]{0,62}$/;
const BUILD_RUN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SUBSCRIPTION_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RESOURCE_GROUP_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._()-]{0,89}$/;

const PHASE_INDEX = new Map(PHASES.map((phase, index) => [phase, index]));
const RECEIPT_BY_PHASE = new Map(RECEIPT_SEQUENCE.map((entry, index) => [
  entry.phase,
  { ...entry, sequence: index + 1 },
]));

const LEDGER_KEYS = [
  "schemaVersion",
  "environment",
  "kind",
  "identity",
  "governance",
  "phase",
  "progressPhase",
  "rollbackFloor",
  "clerkInvocation",
  "fencingGeneration",
  "resumeEligibility",
  "consumed",
  "createdAt",
  "updatedAt",
  "held",
  "receipts",
  "events",
];
const IDENTITY_KEYS = [
  "attemptId",
  "candidate",
  "databaseIdentityHash",
  "redisIdentityHash",
  "azureIdentityHash",
  "admissionContextHash",
];
const CANDIDATE_KEYS = [
  "backendCommit",
  "consoleCommit",
  "apiImage",
  "workerImage",
  "consoleImage",
];
const GOVERNANCE_KEYS = ["operator", "approver", "changeTicket"];
const ENTRY_RECEIPT_KEYS = [
  "schemaVersion",
  "environment",
  "kind",
  "authorizationScope",
  "bootstrapAttemptId",
  "backendCandidateCommit",
  "consoleCandidateCommit",
  "status",
  "preparedAt",
  "expiresAt",
  "operator",
  "approver",
  "changeTicket",
  "admissionContextHash",
  "authority",
  "releaseLock",
  "redisIdentityHash",
  "databaseIdentityHash",
  "lease",
  "targetArtifacts",
  "clerkReconciliationPlan",
  "sourceRollbackBaseline",
  "quiescedState",
  "migrations",
];
const AUTHORITY_KEYS = [
  "subscriptionId",
  "resourceGroupName",
  "resourceGroupResourceId",
  "apiContainerAppResourceId",
  "workerContainerAppResourceId",
  "consoleContainerAppResourceId",
];
const RELEASE_LOCK_KEYS = ["repository", "ref", "objectSha"];
const LEASE_KEYS = ["token", "generation", "observedAt", "expiresAt"];
const TARGET_ARTIFACT_KEYS = ["api", "worker", "console"];
const TARGET_BACKEND_KEYS = [
  "image", "manifestDigest", "platformDigest", "ociRevision", "platform",
  "plannedRevision", "buildRunId", "buildEvidenceHash", "rehearsalEvidenceHash",
];
const TARGET_CONSOLE_KEYS = [
  ...TARGET_BACKEND_KEYS,
  "clientConfigEvidenceHash",
  "smokeEvidenceHash",
];
const CLERK_RECONCILIATION_PLAN_KEYS = [
  "rawPlanSha256", "dryRunEvidenceSha256", "inventoryEvidenceHash",
  "minimumEventVersion", "expectedActiveOrganizationCount",
  "expectedActiveMembershipCount", "expectedActiveUserCount", "executor",
  "dryRunPassed", "approver", "planSignatureSha256", "signatureNamespace",
  "independentApprovalEvidenceHash", "verifiedAt", "expiresAt",
];
const CLERK_RECONCILIATION_EXECUTOR_KEYS = ["name", "version", "sha256"];
const SOURCE_BASELINE_KEYS = [
  "compatibilityState", "rollbackPermittedUntil", "originalAllowlistNonempty",
  "originalAllowlistHash", "privateRestoreBundleHash", "deliverySafetyEvidence",
  "databaseDdlAuthorityEvidence", "operationalSmokeEvidence", "api", "worker", "console",
];
const DELIVERY_SAFETY_EVIDENCE_KEYS = [
  "outstandingDeliveryReview", "providerDeliveryDrain", "verifiedFromProtectedBytes",
];
const OUTSTANDING_DELIVERY_REVIEW_KEYS = [
  "evidenceHash", "reviewer", "reviewedAt", "expiresAt",
  "outstandingDeliveryCount", "unresolvedDeliveryCount", "disposition",
];
const PROVIDER_DELIVERY_DRAIN_KEYS = [
  "evidenceHash", "reviewer", "reviewedAt", "expiresAt", "providerScope",
  "inFlightDeliveryCount", "drainConfirmed",
];
const DATABASE_DDL_AUTHORITY_EVIDENCE_KEYS = [
  "schemaVersion", "environment", "kind", "bootstrapAttemptId", "backendCandidateCommit",
  "databaseIdentityHash", "evidenceHash", "reviewer", "reviewedAt", "expiresAt",
  "authorityScope", "exclusiveDdlAuthorityConfirmed", "verifiedFromProtectedBytes",
];
const OPERATIONAL_SMOKE_EVIDENCE_KEYS = [
  "failedList", "dashboardPolicy", "verifiedFromProtectedBytes",
];
const OPERATIONAL_SMOKE_RESULT_KEYS = [
  "schemaVersion", "environment", "kind", "bootstrapAttemptId", "backendCandidateCommit",
  "consoleCandidateCommit", "evidenceHash", "reviewer", "reviewedAt", "expiresAt", "scope",
  "passed",
];
const SOURCE_APP_KEYS = [
  "image", "manifestDigest", "platformDigest", "ociRevision", "platform",
  "revision", "configHash", "templateHash", "secretReferencesHash",
  "activeRevisionsMode", "maxInactiveRevisions", "healthy",
];
const QUIESCED_STATE_KEYS = [
  "api", "worker", "queueObservations", "writerFence", "orphanRecovery", "inventory",
  "liveSendAllowlistEmpty", "privateRestoreBundleHash", "evidenceHash",
];
const QUIESCED_API_KEYS = ["stopped", "activeRevisionCount", "replicaCount", "ingressDisabled"];
const QUIESCED_WORKER_KEYS = ["stopped", "activeRevisionCount", "replicaCount", "consumersDisabled"];
const QUEUE_OBSERVATION_KEYS = ["observedAt", "stableSince", "evidenceHash", "queues"];
const QUEUES_KEYS = ["agentRuns", "graphRuns", "outreachSend"];
const QUEUE_STATE_KEYS = [
  "paused", "waiting", "active", "delayed", "prioritized", "completed", "failed",
  "waitingChildren", "pausedJobs", "workerCount",
];
const WRITER_FENCE_KEYS = [
  "schemaVersion", "target", "observedAt", "generation", "state", "stateHash",
  "activeWriters", "activeComplianceWriters", "writerZero",
];
const WRITER_FENCE_STATE_KEYS = [
  "schemaVersion", "target", "mode", "bootstrapAttemptId", "generation", "issuedAt", "expiresAt",
];
const ORPHAN_RECOVERY_KEYS = [
  "schemaVersion", "target", "bootstrapAttemptId", "generation", "recoveredAt",
  "stableZeroEvidenceHash", "pre", "post",
];
const ORPHAN_RECOVERY_TOKEN_KEYS = [
  "activeApplicationWriters", "activeComplianceWriters",
  "uncertainApplicationWriters", "uncertainComplianceWriters", "tokenSetHash",
];
const INVENTORY_KEYS = [
  "databaseIdentityHash",
  "sendingRows", "firstClassDeliveryUnknownRows", "legacyDeliveryUnknownMarkerRows",
  "firstClassFailedRows", "legacyAutoFailedMarkerRows", "outreachIdempotencyDuplicateGroups",
  "legacyGmailReplySequenceStopRows", "managerRoleRows", "graphRunRunningRows",
  "graphRunAwaitingApprovalRows", "graphActiveOrgDuplicateGroups",
  "graphActiveWithoutRecoveryStateRows", "graphLifecycleSchemaReady", "replySchemaReady",
  "replySourceDuplicateGroups", "replyConversationDuplicateGroups", "nullSourceReplyRows",
  "replySlotDuplicateRows", "duplicateInventoryEvidenceHash", "clerkIdentitySchemaReady",
  "clerkCutoverRowCount", "clerkCutoverReady", "clerkMinimumEventVersion",
  "clerkInventoryEvidenceHash", "clerkExpectedActiveOrganizationCount",
  "clerkExpectedActiveMembershipCount", "clerkExpectedActiveUserCount",
  "clerkActiveOrganizationCount", "clerkActiveMembershipCount", "clerkActiveUserCount",
  "clerkProjectionMismatchRows", "clerkOrphanActiveAuthorityRows", "clerkReadinessViolationCount",
];
const MIGRATION_KEYS = ["path", "sha256", "writerPause", "writerScopes"];
const ENTRY_MIGRATIONS = Object.freeze([
  Object.freeze({
    path: "docs/migrations/2026-08-13_clerk-identity-lifecycle-expand.sql",
    sha256: "sha256:c6aae895548ab702908d7844a71fd45351ccdc0c9461616993a3b596b6bf5a41",
    writerPause: "observed",
    writerScopes: ["api:clerk-webhooks", "api:identity-membership"],
  }),
  Object.freeze({
    path: "docs/migrations/2026-06-01_outreach-artifact-unique.sql",
    sha256: "sha256:5653818552e1e52bf71229fa3c485dd284da331ee50a69669e98bc65e1a35fb2",
    writerPause: "observed",
    writerScopes: ["api:outreach-artifacts", "worker:outreach-artifacts"],
  }),
  Object.freeze({
    path: "docs/migrations/2026-08-12_conversation-store-expand.sql",
    sha256: "sha256:b34ff5fc9dbd4d4c4adcf7adb044e238d6d427f7e03fd2dec1b356807a7408ba",
    writerPause: "not-required",
    writerScopes: [],
  }),
  Object.freeze({
    path: "docs/migrations/2026-08-12_outreach-delivery-unknown-expand.sql",
    sha256: "sha256:4f5b687b4dad2969e554432b4812c0f57c1b07a6549eecf469997da45a44d14a",
    writerPause: "not-required",
    writerScopes: [],
  }),
  Object.freeze({
    path: "docs/migrations/2026-08-13_outreach-artifact-failed-expand.sql",
    sha256: "sha256:4d51befaa3ac27824ba15ae503a63051cbcb716d2da6e0fd1c49010b2a846d14",
    writerPause: "not-required",
    writerScopes: [],
  }),
  Object.freeze({
    path: "docs/migrations/2026-08-12_conversation-reply-single-flight-expand.sql",
    sha256: "sha256:6cbfa5769455220d1b7341bef566cd1258286e8456fde1ad45266a2d8d2be999",
    writerPause: "observed",
    writerScopes: ["worker:gmail-reply-sync"],
  }),
  Object.freeze({
    path: "docs/migrations/2026-08-12_graph-run-activity-expand.sql",
    sha256: "sha256:8f18edbde210e3520a5bc49d02cd7fb618205edfdf0e0f08f70ee80614530056",
    writerPause: "not-required",
    writerScopes: [],
  }),
  Object.freeze({
    path: "docs/migrations/2026-08-12_graph-run-lifecycle-expand.sql",
    sha256: "sha256:a502874d67c222332b253859b40699a679daf24c27c9b0bbedbd3c63e8254e2b",
    writerPause: "observed",
    writerScopes: ["api:graph-start", "scheduler:graph-start", "worker:graph-run"],
  }),
  Object.freeze({
    path: "docs/migrations/2026-08-20_icp-exclusion-domains-expand.sql",
    sha256: "sha256:0b29f8654efa3e21e3c0bfa29a5c8caf3a029967c9446e26b6340a68899b83db",
    writerPause: "not-required",
    writerScopes: [],
  }),
]);
const EMBEDDED_RECEIPT_KEYS = [
  "kind",
  "sequence",
  "sha256",
  "admittedAt",
  "bytesBase64",
];
const EVENT_KEYS = [
  "sequence",
  "action",
  "fromPhase",
  "toPhase",
  "progressPhase",
  "rollbackFloor",
  "clerkInvocation",
  "fencingGeneration",
  "at",
  "receiptSha256",
  "holdReasonCode",
  "holdEvidenceSha256",
  "identitySha256",
  "previousEventSha256",
  "eventSha256",
];
const B8_EVENT_KEYS = [...EVENT_KEYS, "completionEvidenceHash", "previousLedgerSha256"];
const HELD_KEYS = ["fromPhase", "reasonCode", "evidenceSha256", "heldAt"];
const TOMBSTONE_KEYS = [
  "schemaVersion",
  "environment",
  "kind",
  "attemptId",
  "identitySha256",
  "completedAt",
  "fencingGeneration",
  "completionEvidenceHash",
  "previousLedgerSha256",
  "completedLedgerSha256",
];

function fail(message) {
  throw new Error(message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value, expected, label) {
  if (!isPlainObject(value)) {
    fail(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} has unknown or missing fields`);
  }
}

function assertString(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) {
    fail(`${label} is invalid`);
  }
}

function assertPositiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail(`${label} must be a positive safe integer`);
  }
}

function assertNonnegativeSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(`${label} must be a nonnegative safe integer`);
  }
}

function assertChangeTicket(value, label) {
  if (typeof value !== "string" || [...value].length < 1 || [...value].length > 256) {
    fail(`${label} must contain between 1 and 256 characters`);
  }
}

function sameJson(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

export function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0) ||
      (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      fail("canonical JSON only permits finite numbers and safe integers");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(",")}}`;
  }
  fail("canonical JSON received an unsupported value");
}

export function sha256Bytes(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
}

function sha256Canonical(value) {
  return sha256Bytes(Buffer.from(canonicalJson(value), "utf8"));
}

function decodeUtf8(bytes, label) {
  try {
    return UTF8_DECODER.decode(bytes);
  } catch {
    fail(`${label} is not valid UTF-8`);
  }
}

/** Parse JSON while rejecting duplicate keys, excessive depth, and non-JSON. */
export function strictJsonParse(bytes, label = "JSON") {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const text = decodeUtf8(buffer, label);
  let index = 0;

  function whitespace() {
    while (index < text.length && /[\u0009\u000a\u000d\u0020]/.test(text[index])) {
      index += 1;
    }
  }

  function parseString() {
    const start = index;
    index += 1;
    while (index < text.length) {
      const character = text[index];
      if (character === '"') {
        index += 1;
        try {
          return JSON.parse(text.slice(start, index));
        } catch {
          fail(`${label} contains an invalid string`);
        }
      }
      if (character === "\\") {
        index += 1;
        if (index >= text.length) {
          break;
        }
        if (text[index] === "u") {
          const escape = text.slice(index + 1, index + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(escape)) {
            fail(`${label} contains an invalid Unicode escape`);
          }
          index += 5;
          continue;
        }
        if (!/["\\/bfnrt]/.test(text[index])) {
          fail(`${label} contains an invalid escape`);
        }
        index += 1;
        continue;
      }
      if (character.charCodeAt(0) <= 0x1f) {
        fail(`${label} contains an unescaped control character`);
      }
      index += 1;
    }
    fail(`${label} contains an unterminated string`);
  }

  function parseValue(depth) {
    if (depth > MAX_JSON_DEPTH) {
      fail(`${label} exceeds the maximum nesting depth`);
    }
    whitespace();
    const character = text[index];
    if (character === '"') {
      return parseString();
    }
    if (character === "{") {
      index += 1;
      const result = Object.create(null);
      const keys = new Set();
      whitespace();
      if (text[index] === "}") {
        index += 1;
        return result;
      }
      for (;;) {
        whitespace();
        if (text[index] !== '"') {
          fail(`${label} contains an invalid object key`);
        }
        const key = parseString();
        if (keys.has(key)) {
          fail(`${label} contains duplicate key ${JSON.stringify(key)}`);
        }
        keys.add(key);
        whitespace();
        if (text[index] !== ":") {
          fail(`${label} contains an invalid object separator`);
        }
        index += 1;
        result[key] = parseValue(depth + 1);
        whitespace();
        if (text[index] === "}") {
          index += 1;
          return result;
        }
        if (text[index] !== ",") {
          fail(`${label} contains an invalid object delimiter`);
        }
        index += 1;
      }
    }
    if (character === "[") {
      index += 1;
      const result = [];
      whitespace();
      if (text[index] === "]") {
        index += 1;
        return result;
      }
      for (;;) {
        result.push(parseValue(depth + 1));
        whitespace();
        if (text[index] === "]") {
          index += 1;
          return result;
        }
        if (text[index] !== ",") {
          fail(`${label} contains an invalid array delimiter`);
        }
        index += 1;
      }
    }
    for (const [literal, value] of [["true", true], ["false", false], ["null", null]]) {
      if (text.startsWith(literal, index)) {
        index += literal.length;
        return value;
      }
    }
    const numberMatch = text.slice(index).match(
      /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/,
    );
    if (numberMatch) {
      index += numberMatch[0].length;
      const value = Number(numberMatch[0]);
      if (!Number.isFinite(value) || Object.is(value, -0) ||
        (Number.isInteger(value) && !Number.isSafeInteger(value))) {
        fail(`${label} only permits finite numbers and safe integers`);
      }
      return value;
    }
    fail(`${label} contains an invalid value`);
  }

  if (buffer.length === 0) {
    fail(`${label} is empty`);
  }
  if (text.charCodeAt(0) === 0xfeff) {
    fail(`${label} must not contain a byte-order mark`);
  }
  const value = parseValue(0);
  whitespace();
  if (index !== text.length) {
    fail(`${label} has trailing content`);
  }
  return value;
}

function parseIsoSecond(value, label) {
  if (typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) {
    fail(`${label} must be an RFC 3339 UTC timestamp with second precision`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== `${value.slice(0, -1)}.000Z`) {
    fail(`${label} is not a real UTC timestamp`);
  }
  return milliseconds;
}

function nowIsoSecond() {
  return new Date(Math.floor(Date.now() / 1000) * 1000).toISOString().replace(".000Z", "Z");
}

function validateCandidate(candidate, label = "candidate") {
  assertExactKeys(candidate, CANDIDATE_KEYS, label);
  assertString(candidate.backendCommit, COMMIT_PATTERN, `${label}.backendCommit`);
  assertString(candidate.consoleCommit, COMMIT_PATTERN, `${label}.consoleCommit`);
  assertString(candidate.apiImage, API_IMAGE_PATTERN, `${label}.apiImage`);
  assertString(candidate.workerImage, API_IMAGE_PATTERN, `${label}.workerImage`);
  assertString(candidate.consoleImage, CONSOLE_IMAGE_PATTERN, `${label}.consoleImage`);
}

function validateIdentity(identity) {
  assertExactKeys(identity, IDENTITY_KEYS, "identity");
  assertString(identity.attemptId, ATTEMPT_PATTERN, "identity.attemptId");
  validateCandidate(identity.candidate, "identity.candidate");
  assertString(identity.databaseIdentityHash, SHA256_PATTERN, "identity.databaseIdentityHash");
  assertString(identity.redisIdentityHash, SHA256_PATTERN, "identity.redisIdentityHash");
  assertString(identity.azureIdentityHash, SHA256_PATTERN, "identity.azureIdentityHash");
  assertString(identity.admissionContextHash, SHA256_PATTERN, "identity.admissionContextHash");
}

function validateGovernance(governance) {
  assertExactKeys(governance, GOVERNANCE_KEYS, "governance");
  assertString(governance.operator, PRINCIPAL_PATTERN, "governance.operator");
  assertString(governance.approver, PRINCIPAL_PATTERN, "governance.approver");
  if (governance.operator === governance.approver) {
    fail("operator and approver must be different principals");
  }
  assertChangeTicket(governance.changeTicket, "governance.changeTicket");
}

function rollbackFloorFor(phase, clerkInvocation) {
  const phaseIndex = PHASE_INDEX.get(phase);
  if (phaseIndex === undefined) {
    fail(`unknown progress phase ${phase}`);
  }
  if (phaseIndex <= PHASE_INDEX.get("B2_LEGACY_QUIESCED")) {
    if (clerkInvocation !== "not-invoked") {
      fail("legacy rollback is permitted only before Clerk migration invocation");
    }
    return "legacy-allowed";
  }
  if (phaseIndex <= PHASE_INDEX.get("B4_SCHEMA_VERIFIED")) {
    if (!["invoked", "uncertain", "verified"].includes(clerkInvocation)) {
      fail("the schema-forward-only floor requires invoked, uncertain, or verified Clerk state");
    }
    return "forward-only";
  }
  if (phaseIndex === PHASE_INDEX.get("B5_COMPATIBLE_BASELINE")) {
    if (clerkInvocation !== "verified") {
      fail("the enum-aware disabled baseline requires verified schema state");
    }
    return "enum-aware-disabled";
  }
  if (clerkInvocation !== "verified") {
    fail("activation phases require verified schema state");
  }
  return "activation-attempted";
}

function resumeEligibilityFor(phase, receiptKinds) {
  const activationIndex = receiptKinds.indexOf("first-class-activation");
  const completeIndex = receiptKinds.indexOf("bootstrap-complete");
  if (phase === "B8_COMPLETE") {
    if (completeIndex !== RECEIPT_SEQUENCE.length - 1) {
      fail("complete state requires the verified complete receipt chain");
    }
    return "complete-chain-verified";
  }
  if (PHASE_INDEX.get(phase) >= PHASE_INDEX.get("B6_FIRST_CLASS_ARMED")) {
    if (activationIndex !== 3) {
      fail("resume eligibility requires the verified activation receipt chain");
    }
    return "activation-chain-verified";
  }
  return "denied";
}

function expectedReceiptCountForPhase(phase) {
  const phaseIndex = PHASE_INDEX.get(phase);
  return RECEIPT_SEQUENCE.filter((entry) => PHASE_INDEX.get(entry.phase) <= phaseIndex).length;
}

function eventHash(event) {
  const payload = { ...event };
  delete payload.eventSha256;
  return sha256Canonical(payload);
}

function buildEvent(fields) {
  const event = { ...fields, eventSha256: null };
  event.eventSha256 = eventHash(event);
  return event;
}

function strictBase64Decode(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    fail(`${label} is not canonical base64`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    fail(`${label} is not canonical base64`);
  }
  return decoded;
}

function validateAuthority(authority) {
  assertExactKeys(authority, AUTHORITY_KEYS, "entry receipt authority");
  assertString(authority.subscriptionId, SUBSCRIPTION_PATTERN, "entry receipt authority.subscriptionId");
  assertString(authority.resourceGroupName, RESOURCE_GROUP_PATTERN, "entry receipt authority.resourceGroupName");
  const resourceGroupId = `/subscriptions/${authority.subscriptionId}/resourceGroups/${authority.resourceGroupName}`;
  const expected = {
    resourceGroupResourceId: resourceGroupId,
    apiContainerAppResourceId: `${resourceGroupId}/providers/Microsoft.App/containerApps/apex-gtm-api`,
    workerContainerAppResourceId: `${resourceGroupId}/providers/Microsoft.App/containerApps/apex-gtm-worker`,
    consoleContainerAppResourceId: `${resourceGroupId}/providers/Microsoft.App/containerApps/nikxius-web`,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (typeof authority[key] !== "string" || authority[key].toLowerCase() !== value.toLowerCase()) {
      fail(`entry receipt authority.${key} is not the exact production resource identity`);
    }
  }
}

/** Deterministic Azure identity bound by the signed authority object. */
export function azureAuthorityIdentityHash(authority) {
  validateAuthority(authority);
  return sha256Canonical(authority);
}

function validateReleaseLock(releaseLock, backendCommit) {
  assertExactKeys(releaseLock, RELEASE_LOCK_KEYS, "entry receipt releaseLock");
  if (releaseLock.repository !== "https://github.com/Kloudedge-apex/apex-product.git" ||
    releaseLock.ref !== "refs/heads/workforce-os-release-lock/production-gtm-platform" ||
    releaseLock.objectSha !== backendCommit) {
    fail("entry receipt release lock is not the exact backend candidate lock");
  }
}

function validateTargetBackendArtifact(artifact, revisionPattern, expectedCommit, label) {
  assertExactKeys(artifact, TARGET_BACKEND_KEYS, label);
  assertString(artifact.image, API_IMAGE_PATTERN, `${label}.image`);
  assertString(artifact.manifestDigest, SHA256_PATTERN, `${label}.manifestDigest`);
  assertString(artifact.platformDigest, SHA256_PATTERN, `${label}.platformDigest`);
  assertString(artifact.ociRevision, COMMIT_PATTERN, `${label}.ociRevision`);
  assertString(artifact.plannedRevision, revisionPattern, `${label}.plannedRevision`);
  assertString(artifact.buildRunId, BUILD_RUN_PATTERN, `${label}.buildRunId`);
  assertString(artifact.buildEvidenceHash, SHA256_PATTERN, `${label}.buildEvidenceHash`);
  assertString(artifact.rehearsalEvidenceHash, SHA256_PATTERN, `${label}.rehearsalEvidenceHash`);
  if (artifact.image !== `workforceosprodacr.azurecr.io/apex-api@${artifact.manifestDigest}` ||
    artifact.ociRevision !== expectedCommit || artifact.platform !== "linux/amd64") {
    fail(`${label} does not match its immutable candidate provenance`);
  }
}

function validateTargetConsoleArtifact(artifact, expectedCommit) {
  const label = "entry receipt targetArtifacts.console";
  assertExactKeys(artifact, TARGET_CONSOLE_KEYS, label);
  assertString(artifact.image, CONSOLE_IMAGE_PATTERN, `${label}.image`);
  assertString(artifact.manifestDigest, SHA256_PATTERN, `${label}.manifestDigest`);
  assertString(artifact.platformDigest, SHA256_PATTERN, `${label}.platformDigest`);
  assertString(artifact.ociRevision, COMMIT_PATTERN, `${label}.ociRevision`);
  assertString(artifact.plannedRevision, CONSOLE_REVISION_PATTERN, `${label}.plannedRevision`);
  assertString(artifact.buildRunId, BUILD_RUN_PATTERN, `${label}.buildRunId`);
  for (const key of [
    "buildEvidenceHash", "rehearsalEvidenceHash", "clientConfigEvidenceHash", "smokeEvidenceHash",
  ]) {
    assertString(artifact[key], SHA256_PATTERN, `${label}.${key}`);
  }
  if (artifact.image !== `workforceosprodacr.azurecr.io/workforceos-fe@${artifact.manifestDigest}` ||
    artifact.ociRevision !== expectedCommit || artifact.platform !== "linux/amd64") {
    fail(`${label} does not match its immutable candidate provenance`);
  }
}

function validateTargetArtifacts(targetArtifacts, identity) {
  assertExactKeys(targetArtifacts, TARGET_ARTIFACT_KEYS, "entry receipt targetArtifacts");
  validateTargetBackendArtifact(
    targetArtifacts.api,
    API_REVISION_PATTERN,
    identity.candidate.backendCommit,
    "entry receipt targetArtifacts.api",
  );
  validateTargetBackendArtifact(
    targetArtifacts.worker,
    WORKER_REVISION_PATTERN,
    identity.candidate.backendCommit,
    "entry receipt targetArtifacts.worker",
  );
  validateTargetConsoleArtifact(targetArtifacts.console, identity.candidate.consoleCommit);
  if (targetArtifacts.api.image !== identity.candidate.apiImage ||
    targetArtifacts.worker.image !== identity.candidate.workerImage ||
    targetArtifacts.console.image !== identity.candidate.consoleImage) {
    fail("entry receipt candidate artifact identity drift detected");
  }
  for (const key of [
    "image", "manifestDigest", "platformDigest", "ociRevision", "buildRunId",
    "buildEvidenceHash", "rehearsalEvidenceHash",
  ]) {
    if (targetArtifacts.api[key] !== targetArtifacts.worker[key]) {
      fail(`entry receipt API and worker target artifacts disagree on ${key}`);
    }
  }
}

function validateClerkReconciliationPlan(plan, receiptApprover, preparedAt, receiptExpiresAt) {
  assertExactKeys(plan, CLERK_RECONCILIATION_PLAN_KEYS, "entry receipt clerkReconciliationPlan");
  for (const key of [
    "rawPlanSha256", "dryRunEvidenceSha256", "inventoryEvidenceHash",
    "planSignatureSha256", "independentApprovalEvidenceHash",
  ]) assertString(plan[key], SHA256_PATTERN, `entry receipt clerkReconciliationPlan.${key}`);
  assertPositiveSafeInteger(plan.minimumEventVersion,
    "entry receipt clerkReconciliationPlan.minimumEventVersion");
  for (const key of [
    "expectedActiveOrganizationCount", "expectedActiveMembershipCount", "expectedActiveUserCount",
  ]) assertNonnegativeSafeInteger(plan[key], `entry receipt clerkReconciliationPlan.${key}`);
  assertExactKeys(plan.executor, CLERK_RECONCILIATION_EXECUTOR_KEYS,
    "entry receipt clerkReconciliationPlan.executor");
  if (plan.executor.name !== "workforce-production-clerk-reconciliation-executor" ||
    plan.executor.version !== "v1") {
    fail("entry receipt Clerk reconciliation executor contract is invalid");
  }
  assertString(plan.executor.sha256, SHA256_PATTERN,
    "entry receipt clerkReconciliationPlan.executor.sha256");
  assertString(plan.approver, PRINCIPAL_PATTERN, "entry receipt clerkReconciliationPlan.approver");
  if (plan.dryRunPassed !== true || plan.approver !== receiptApprover ||
    plan.signatureNamespace !== "workforce-os-clerk-reconciliation-plan") {
    fail("entry receipt Clerk reconciliation plan is not independently signed, dry-run verified, and approver-bound");
  }
  const verifiedAt = parseIsoSecond(plan.verifiedAt,
    "entry receipt clerkReconciliationPlan.verifiedAt");
  const expiresAt = parseIsoSecond(plan.expiresAt,
    "entry receipt clerkReconciliationPlan.expiresAt");
  if (expiresAt <= verifiedAt || expiresAt - verifiedAt > 86_400_000 ||
    verifiedAt > preparedAt || preparedAt >= expiresAt || receiptExpiresAt > expiresAt ||
    plan.minimumEventVersion > verifiedAt ||
    verifiedAt - plan.minimumEventVersion > 86_400_000) {
    fail("entry receipt Clerk reconciliation plan is stale, future-dated, or cutoff-inconsistent");
  }
}

function validateSourceApp(app, options) {
  assertExactKeys(app, SOURCE_APP_KEYS, options.label);
  assertString(app.image, options.imagePattern, `${options.label}.image`);
  assertString(app.manifestDigest, SHA256_PATTERN, `${options.label}.manifestDigest`);
  assertString(app.platformDigest, SHA256_PATTERN, `${options.label}.platformDigest`);
  assertString(app.ociRevision, COMMIT_PATTERN, `${options.label}.ociRevision`);
  assertString(app.revision, options.revisionPattern, `${options.label}.revision`);
  for (const key of ["configHash", "templateHash", "secretReferencesHash"]) {
    assertString(app[key], SHA256_PATTERN, `${options.label}.${key}`);
  }
  assertPositiveSafeInteger(app.maxInactiveRevisions, `${options.label}.maxInactiveRevisions`);
  if (app.image !== `${options.repository}@${app.manifestDigest}` ||
    app.platform !== "linux/amd64" || app.activeRevisionsMode !== "Single" || app.healthy !== true) {
    fail(`${options.label} is not an exact healthy immutable source baseline`);
  }
}

function validateEntryEvidenceWindow(value, label, preparedAt, receiptExpiresAt) {
  const reviewedAt = parseIsoSecond(value.reviewedAt, `${label}.reviewedAt`);
  const expiresAt = parseIsoSecond(value.expiresAt, `${label}.expiresAt`);
  if (expiresAt <= reviewedAt || expiresAt - reviewedAt > 86_400_000 ||
    reviewedAt > preparedAt || expiresAt < receiptExpiresAt) {
    fail(`${label} is stale, future-dated, or does not cover receipt validity`);
  }
}

function validateOperationalSmokeResult(value, expected, binding) {
  assertExactKeys(value, OPERATIONAL_SMOKE_RESULT_KEYS, expected.label);
  assertString(value.evidenceHash, SHA256_PATTERN, `${expected.label}.evidenceHash`);
  assertString(value.reviewer, PRINCIPAL_PATTERN, `${expected.label}.reviewer`);
  if (value.schemaVersion !== 1 || value.environment !== ENVIRONMENT ||
    value.kind !== expected.kind || value.scope !== expected.scope || value.passed !== true ||
    value.bootstrapAttemptId !== binding.attemptId ||
    value.backendCandidateCommit !== binding.backendCommit ||
    value.consoleCandidateCommit !== binding.consoleCommit ||
    value.reviewer !== binding.approver) {
    fail(`${expected.label} is not bound to the exact production entry identity`);
  }
  validateEntryEvidenceWindow(
    value,
    expected.label,
    binding.preparedAt,
    binding.receiptExpiresAt,
  );
}

function validateSourceBaseline(source, binding) {
  assertExactKeys(source, SOURCE_BASELINE_KEYS, "entry receipt sourceRollbackBaseline");
  if (source.compatibilityState !== "legacy-readers-no-new-enum-values-v1" ||
    source.rollbackPermittedUntil !== "before-first-clerk-migration-invocation-only" ||
    typeof source.originalAllowlistNonempty !== "boolean") {
    fail("entry receipt source rollback policy is invalid");
  }
  for (const key of ["originalAllowlistHash", "privateRestoreBundleHash"]) {
    assertString(source[key], SHA256_PATTERN, `entry receipt sourceRollbackBaseline.${key}`);
  }
  assertExactKeys(
    source.deliverySafetyEvidence,
    DELIVERY_SAFETY_EVIDENCE_KEYS,
    "entry receipt sourceRollbackBaseline.deliverySafetyEvidence",
  );
  const outstandingReview = source.deliverySafetyEvidence.outstandingDeliveryReview;
  assertExactKeys(
    outstandingReview,
    OUTSTANDING_DELIVERY_REVIEW_KEYS,
    "entry receipt outstanding-delivery review",
  );
  assertString(outstandingReview.evidenceHash, SHA256_PATTERN,
    "entry receipt outstanding-delivery review evidenceHash");
  assertString(outstandingReview.reviewer, PRINCIPAL_PATTERN,
    "entry receipt outstanding-delivery review reviewer");
  const outstandingReviewedAt = parseIsoSecond(
    outstandingReview.reviewedAt,
    "entry receipt outstanding-delivery review reviewedAt",
  );
  const outstandingExpiresAt = parseIsoSecond(
    outstandingReview.expiresAt,
    "entry receipt outstanding-delivery review expiresAt",
  );
  if (outstandingExpiresAt <= outstandingReviewedAt ||
    outstandingExpiresAt - outstandingReviewedAt > 86_400_000 ||
    outstandingReview.outstandingDeliveryCount !== 0 ||
    outstandingReview.unresolvedDeliveryCount !== 0 ||
    outstandingReview.disposition !== "no-outstanding-deliveries") {
    fail("entry receipt outstanding-delivery review is invalid");
  }

  const providerDrain = source.deliverySafetyEvidence.providerDeliveryDrain;
  assertExactKeys(
    providerDrain,
    PROVIDER_DELIVERY_DRAIN_KEYS,
    "entry receipt provider-delivery drain",
  );
  assertString(providerDrain.evidenceHash, SHA256_PATTERN,
    "entry receipt provider-delivery drain evidenceHash");
  assertString(providerDrain.reviewer, PRINCIPAL_PATTERN,
    "entry receipt provider-delivery drain reviewer");
  const providerReviewedAt = parseIsoSecond(
    providerDrain.reviewedAt,
    "entry receipt provider-delivery drain reviewedAt",
  );
  const providerExpiresAt = parseIsoSecond(
    providerDrain.expiresAt,
    "entry receipt provider-delivery drain expiresAt",
  );
  if (providerExpiresAt <= providerReviewedAt ||
    providerExpiresAt - providerReviewedAt > 86_400_000 ||
    providerDrain.providerScope !== "all-configured-outbound-providers" ||
    providerDrain.inFlightDeliveryCount !== 0 || providerDrain.drainConfirmed !== true) {
    fail("entry receipt provider-delivery drain is invalid");
  }
  if (source.deliverySafetyEvidence.verifiedFromProtectedBytes !== true) {
    fail("entry receipt delivery-safety evidence must be verified from protected bytes");
  }
  const databaseDdl = source.databaseDdlAuthorityEvidence;
  assertExactKeys(
    databaseDdl,
    DATABASE_DDL_AUTHORITY_EVIDENCE_KEYS,
    "entry receipt database DDL authority evidence",
  );
  assertString(databaseDdl.evidenceHash, SHA256_PATTERN,
    "entry receipt database DDL authority evidenceHash");
  assertString(databaseDdl.databaseIdentityHash, SHA256_PATTERN,
    "entry receipt database DDL authority databaseIdentityHash");
  assertString(databaseDdl.reviewer, PRINCIPAL_PATTERN,
    "entry receipt database DDL authority reviewer");
  if (databaseDdl.schemaVersion !== 1 || databaseDdl.environment !== ENVIRONMENT ||
    databaseDdl.kind !== "production-database-ddl-exclusive-authority" ||
    databaseDdl.bootstrapAttemptId !== binding.attemptId ||
    databaseDdl.backendCandidateCommit !== binding.backendCommit ||
    databaseDdl.databaseIdentityHash !== binding.databaseIdentityHash ||
    databaseDdl.reviewer !== binding.approver ||
    databaseDdl.authorityScope !== "all-production-database-ddl-actors" ||
    databaseDdl.exclusiveDdlAuthorityConfirmed !== true ||
    databaseDdl.verifiedFromProtectedBytes !== true) {
    fail("entry receipt database DDL authority is not bound to the exact production entry identity");
  }
  validateEntryEvidenceWindow(
    databaseDdl,
    "entry receipt database DDL authority",
    binding.preparedAt,
    binding.receiptExpiresAt,
  );

  assertExactKeys(
    source.operationalSmokeEvidence,
    OPERATIONAL_SMOKE_EVIDENCE_KEYS,
    "entry receipt operational smoke evidence",
  );
  if (source.operationalSmokeEvidence.verifiedFromProtectedBytes !== true) {
    fail("entry receipt operational smoke evidence must be verified from protected bytes");
  }
  validateOperationalSmokeResult(source.operationalSmokeEvidence.failedList, {
    label: "entry receipt failed-list smoke evidence",
    kind: "production-failed-list-smoke",
    scope: "api-failed-outreach-list",
  }, binding);
  validateOperationalSmokeResult(source.operationalSmokeEvidence.dashboardPolicy, {
    label: "entry receipt dashboard-policy smoke evidence",
    kind: "production-dashboard-policy-smoke",
    scope: "console-dashboard-policy",
  }, binding);
  validateSourceApp(source.api, {
    label: "entry receipt sourceRollbackBaseline.api",
    imagePattern: API_IMAGE_PATTERN,
    revisionPattern: API_REVISION_PATTERN,
    repository: "workforceosprodacr.azurecr.io/apex-api",
  });
  validateSourceApp(source.worker, {
    label: "entry receipt sourceRollbackBaseline.worker",
    imagePattern: API_IMAGE_PATTERN,
    revisionPattern: WORKER_REVISION_PATTERN,
    repository: "workforceosprodacr.azurecr.io/apex-api",
  });
  validateSourceApp(source.console, {
    label: "entry receipt sourceRollbackBaseline.console",
    imagePattern: CONSOLE_IMAGE_PATTERN,
    revisionPattern: CONSOLE_REVISION_PATTERN,
    repository: "workforceosprodacr.azurecr.io/workforceos-fe",
  });
  for (const key of ["image", "manifestDigest", "platformDigest", "ociRevision"]) {
    if (source.api[key] !== source.worker[key]) {
      fail(`entry receipt API and worker source baselines disagree on ${key}`);
    }
  }
}

function validateQueueState(queue, label) {
  assertExactKeys(queue, QUEUE_STATE_KEYS, label);
  if (queue.paused !== true || queue.active !== 0 || queue.workerCount !== 0) {
    fail(`${label} is not globally paused, drained, and worker-free`);
  }
  for (const key of [
    "waiting", "delayed", "prioritized", "completed", "failed", "waitingChildren", "pausedJobs",
  ]) {
    assertNonnegativeSafeInteger(queue[key], `${label}.${key}`);
  }
}

function validateQueueObservation(observation, label) {
  assertExactKeys(observation, QUEUE_OBSERVATION_KEYS, label);
  parseIsoSecond(observation.observedAt, `${label}.observedAt`);
  parseIsoSecond(observation.stableSince, `${label}.stableSince`);
  assertString(observation.evidenceHash, SHA256_PATTERN, `${label}.evidenceHash`);
  assertExactKeys(observation.queues, QUEUES_KEYS, `${label}.queues`);
  for (const queue of QUEUES_KEYS) {
    validateQueueState(observation.queues[queue], `${label}.queues.${queue}`);
  }
}

function validateQuiescedState(quiescedState, sourceBaseline, context) {
  assertExactKeys(quiescedState, QUIESCED_STATE_KEYS, "entry receipt quiescedState");
  assertExactKeys(quiescedState.api, QUIESCED_API_KEYS, "entry receipt quiescedState.api");
  if (quiescedState.api.stopped !== true || quiescedState.api.activeRevisionCount !== 1 ||
    quiescedState.api.replicaCount !== 0 || quiescedState.api.ingressDisabled !== true) {
    fail("entry receipt API is not proven stopped and ingress-disabled");
  }
  assertExactKeys(quiescedState.worker, QUIESCED_WORKER_KEYS, "entry receipt quiescedState.worker");
  if (quiescedState.worker.stopped !== true || quiescedState.worker.activeRevisionCount !== 1 ||
    quiescedState.worker.replicaCount !== 0 || quiescedState.worker.consumersDisabled !== true) {
    fail("entry receipt worker is not proven stopped and consumer-disabled");
  }
  if (!Array.isArray(quiescedState.queueObservations) || quiescedState.queueObservations.length !== 2) {
    fail("entry receipt requires exactly two stable queue observations");
  }
  validateQueueObservation(quiescedState.queueObservations[0], "entry receipt first queue observation");
  validateQueueObservation(quiescedState.queueObservations[1], "entry receipt second queue observation");
  if (!sameJson(quiescedState.queueObservations[0].queues, quiescedState.queueObservations[1].queues)) {
    fail("entry receipt queue observations are not stable");
  }
  const writerFence = quiescedState.writerFence;
  assertExactKeys(writerFence, WRITER_FENCE_KEYS, "entry receipt writerFence");
  assertPositiveSafeInteger(writerFence.generation, "entry receipt writerFence.generation");
  parseIsoSecond(writerFence.observedAt, "entry receipt writerFence.observedAt");
  assertString(writerFence.stateHash, SHA256_PATTERN, "entry receipt writerFence.stateHash");
  if (writerFence.schemaVersion !== 1 || writerFence.target !== "workforce-os-production" ||
    writerFence.generation !== context.fencingGeneration || writerFence.activeWriters !== 0 ||
    writerFence.activeComplianceWriters !== 0 || writerFence.writerZero !== true) {
    fail("entry receipt writer fence readback is not closed at the exact fencing generation");
  }
  assertExactKeys(writerFence.state, WRITER_FENCE_STATE_KEYS, "entry receipt writerFence.state");
  assertPositiveSafeInteger(writerFence.state.generation, "entry receipt writerFence.state.generation");
  parseIsoSecond(writerFence.state.issuedAt, "entry receipt writerFence.state.issuedAt");
  parseIsoSecond(writerFence.state.expiresAt, "entry receipt writerFence.state.expiresAt");
  if (writerFence.state.schemaVersion !== 1 || writerFence.state.target !== "workforce-os-production" ||
    writerFence.state.mode !== "closed" ||
    writerFence.state.bootstrapAttemptId !== context.identity.attemptId ||
    writerFence.state.generation !== context.fencingGeneration) {
    fail("entry receipt writer fence state is not bound to the exact bootstrap attempt");
  }
  const recovery = quiescedState.orphanRecovery;
  assertExactKeys(recovery, ORPHAN_RECOVERY_KEYS, "entry receipt orphanRecovery");
  assertNonnegativeSafeInteger(recovery.generation, "entry receipt orphanRecovery.generation");
  parseIsoSecond(recovery.recoveredAt, "entry receipt orphanRecovery.recoveredAt");
  assertString(recovery.stableZeroEvidenceHash, SHA256_PATTERN,
    "entry receipt orphanRecovery.stableZeroEvidenceHash");
  if (recovery.schemaVersion !== 1 || recovery.target !== "workforce-os-production" ||
    recovery.bootstrapAttemptId !== context.identity.attemptId ||
    ![0, context.fencingGeneration].includes(recovery.generation)) {
    fail("entry receipt orphan recovery is not bound to the bootstrap attempt and pre-arm generation");
  }
  for (const section of ["pre", "post"]) {
    assertExactKeys(recovery[section], ORPHAN_RECOVERY_TOKEN_KEYS,
      `entry receipt orphanRecovery.${section}`);
    for (const key of ORPHAN_RECOVERY_TOKEN_KEYS.slice(0, -1)) {
      assertNonnegativeSafeInteger(recovery[section][key],
        `entry receipt orphanRecovery.${section}.${key}`);
    }
    assertString(recovery[section].tokenSetHash, SHA256_PATTERN,
      `entry receipt orphanRecovery.${section}.tokenSetHash`);
  }
  if (ORPHAN_RECOVERY_TOKEN_KEYS.slice(0, -1)
    .some((key) => recovery.post[key] !== 0)) {
    fail("entry receipt orphan recovery did not prove all writer token sets empty");
  }
  assertExactKeys(quiescedState.inventory, INVENTORY_KEYS, "entry receipt inventory");
  if (quiescedState.inventory.databaseIdentityHash !== context.identity.databaseIdentityHash) {
    fail("entry receipt inventory database identity drift detected");
  }
  for (const key of [
    "sendingRows", "firstClassDeliveryUnknownRows", "legacyDeliveryUnknownMarkerRows",
    "firstClassFailedRows", "outreachIdempotencyDuplicateGroups", "managerRoleRows",
    "graphRunRunningRows", "graphActiveOrgDuplicateGroups",
    "graphActiveWithoutRecoveryStateRows",
  ]) {
    if (quiescedState.inventory[key] !== 0) {
      fail(`entry receipt inventory.${key} must be zero`);
    }
  }
  for (const key of [
    "legacyAutoFailedMarkerRows", "legacyGmailReplySequenceStopRows", "graphRunAwaitingApprovalRows",
  ]) {
    assertNonnegativeSafeInteger(quiescedState.inventory[key], `entry receipt inventory.${key}`);
  }
  if (quiescedState.inventory.graphLifecycleSchemaReady !== false) {
    fail("entry receipt must prove the Graph lifecycle schema is absent before invocation");
  }
  if (typeof quiescedState.inventory.replySchemaReady !== "boolean") {
    fail("entry receipt inventory.replySchemaReady must be boolean");
  }
  const replyInventoryKeys = [
    "replySourceDuplicateGroups", "replyConversationDuplicateGroups", "nullSourceReplyRows",
    "replySlotDuplicateRows",
  ];
  const expectedReplyValue = quiescedState.inventory.replySchemaReady ? 0 : null;
  for (const key of replyInventoryKeys) {
    if (quiescedState.inventory[key] !== expectedReplyValue) {
      fail(`entry receipt inventory.${key} is inconsistent with replySchemaReady`);
    }
  }
  assertString(
    quiescedState.inventory.duplicateInventoryEvidenceHash,
    SHA256_PATTERN,
    "entry receipt inventory.duplicateInventoryEvidenceHash",
  );
  if (quiescedState.inventory.clerkIdentitySchemaReady !== false) {
    fail("entry receipt must prove the Clerk identity schema is absent before invocation");
  }
  for (const key of [
    "clerkCutoverRowCount", "clerkCutoverReady", "clerkMinimumEventVersion",
    "clerkInventoryEvidenceHash", "clerkExpectedActiveOrganizationCount",
    "clerkExpectedActiveMembershipCount", "clerkExpectedActiveUserCount",
    "clerkActiveOrganizationCount", "clerkActiveMembershipCount", "clerkActiveUserCount",
    "clerkProjectionMismatchRows", "clerkOrphanActiveAuthorityRows", "clerkReadinessViolationCount",
  ]) {
    if (quiescedState.inventory[key] !== null) {
      fail(`entry receipt inventory.${key} must be null before the Clerk schema exists`);
    }
  }
  if (quiescedState.liveSendAllowlistEmpty !== true ||
    quiescedState.privateRestoreBundleHash !== sourceBaseline.privateRestoreBundleHash) {
    fail("entry receipt quiescence does not bind the empty allowlist and restore bundle");
  }
  assertString(quiescedState.privateRestoreBundleHash, SHA256_PATTERN, "entry receipt quiescedState.privateRestoreBundleHash");
  assertString(quiescedState.evidenceHash, SHA256_PATTERN, "entry receipt quiescedState.evidenceHash");
}

function validateEntryMigrations(migrations) {
  if (!Array.isArray(migrations) || migrations.length !== ENTRY_MIGRATIONS.length) {
    fail("entry receipt must bind exactly nine ordered migrations");
  }
  migrations.forEach((migration, index) => {
    assertExactKeys(migration, MIGRATION_KEYS, `entry receipt migration ${index}`);
    if (!sameJson(migration, ENTRY_MIGRATIONS[index])) {
      fail(`entry receipt migration ${index} does not match the reviewed contract`);
    }
  });
}

function validateEntryReceipt(receipt, context) {
  assertExactKeys(receipt, ENTRY_RECEIPT_KEYS, "initial-bootstrap-entry receipt");
  if (context.expected.sequence !== 1 || context.previousReceiptSha256 !== null) {
    fail("initial-bootstrap-entry must be the first exact-byte receipt in the chain");
  }
  if (receipt.schemaVersion !== 2 || receipt.environment !== ENVIRONMENT ||
    receipt.kind !== "initial-bootstrap-entry" ||
    receipt.authorizationScope !== "bootstrap-entry-admission-only" ||
    receipt.status !== "prepared-and-quiesced") {
    fail("initial-bootstrap-entry receipt contract identity is invalid");
  }
  if (receipt.bootstrapAttemptId !== context.identity.attemptId ||
    receipt.backendCandidateCommit !== context.identity.candidate.backendCommit ||
    receipt.consoleCandidateCommit !== context.identity.candidate.consoleCommit ||
    receipt.databaseIdentityHash !== context.identity.databaseIdentityHash ||
    receipt.redisIdentityHash !== context.identity.redisIdentityHash ||
    receipt.admissionContextHash !== context.identity.admissionContextHash) {
    fail("initial-bootstrap-entry receipt identity drift detected");
  }
  if (receipt.operator !== context.governance.operator ||
    receipt.approver !== context.governance.approver ||
    receipt.changeTicket !== context.governance.changeTicket) {
    fail("initial-bootstrap-entry receipt governance identity drift detected");
  }
  assertString(receipt.operator, PRINCIPAL_PATTERN, "entry receipt operator");
  assertString(receipt.approver, PRINCIPAL_PATTERN, "entry receipt approver");
  if (receipt.operator === receipt.approver) {
    fail("entry receipt operator and approver must be different principals");
  }
  assertChangeTicket(receipt.changeTicket, "entry receipt changeTicket");
  validateAuthority(receipt.authority);
  if (azureAuthorityIdentityHash(receipt.authority) !== context.identity.azureIdentityHash) {
    fail("initial-bootstrap-entry Azure authority identity drift detected");
  }
  validateReleaseLock(receipt.releaseLock, context.identity.candidate.backendCommit);
  assertExactKeys(receipt.lease, LEASE_KEYS, "entry receipt lease");
  assertString(receipt.lease.token, /^[0-9a-f]{64}$/, "entry receipt lease.token");
  assertPositiveSafeInteger(receipt.lease.generation, "entry receipt lease.generation");
  if (receipt.lease.generation !== context.fencingGeneration) {
    fail("entry receipt lease generation does not match the B2 fencing generation");
  }
  const preparedAt = parseIsoSecond(receipt.preparedAt, "entry receipt preparedAt");
  const expiresAt = parseIsoSecond(receipt.expiresAt, "entry receipt expiresAt");
  validateTargetArtifacts(receipt.targetArtifacts, context.identity);
  validateSourceBaseline(receipt.sourceRollbackBaseline, {
    attemptId: receipt.bootstrapAttemptId,
    backendCommit: receipt.backendCandidateCommit,
    consoleCommit: receipt.consoleCandidateCommit,
    databaseIdentityHash: receipt.databaseIdentityHash,
    approver: receipt.approver,
    preparedAt,
    receiptExpiresAt: expiresAt,
  });
  validateQuiescedState(receipt.quiescedState, receipt.sourceRollbackBaseline, context);
  validateEntryMigrations(receipt.migrations);

  const admittedAt = parseIsoSecond(context.admittedAt, "entry receipt admission time");
  const leaseObservedAt = parseIsoSecond(receipt.lease.observedAt, "entry receipt lease.observedAt");
  const leaseExpiresAt = parseIsoSecond(receipt.lease.expiresAt, "entry receipt lease.expiresAt");
  const firstQueueAt = parseIsoSecond(
    receipt.quiescedState.queueObservations[0].observedAt,
    "entry receipt first queue observedAt",
  );
  const secondQueueAt = parseIsoSecond(
    receipt.quiescedState.queueObservations[1].observedAt,
    "entry receipt second queue observedAt",
  );
  const firstQueueStableSince = parseIsoSecond(
    receipt.quiescedState.queueObservations[0].stableSince,
    "entry receipt first queue stableSince",
  );
  const secondQueueStableSince = parseIsoSecond(
    receipt.quiescedState.queueObservations[1].stableSince,
    "entry receipt second queue stableSince",
  );
  const writerFenceObservedAt = parseIsoSecond(
    receipt.quiescedState.writerFence.observedAt,
    "entry receipt writerFence.observedAt",
  );
  const writerFenceIssuedAt = parseIsoSecond(
    receipt.quiescedState.writerFence.state.issuedAt,
    "entry receipt writerFence.state.issuedAt",
  );
  const writerFenceExpiresAt = parseIsoSecond(
    receipt.quiescedState.writerFence.state.expiresAt,
    "entry receipt writerFence.state.expiresAt",
  );
  const orphanRecoveryAt = parseIsoSecond(
    receipt.quiescedState.orphanRecovery.recoveredAt,
    "entry receipt orphanRecovery.recoveredAt",
  );
  validateClerkReconciliationPlan(
    receipt.clerkReconciliationPlan,
    receipt.approver,
    preparedAt,
    expiresAt,
  );
  if (expiresAt <= preparedAt || expiresAt - preparedAt > MAX_RECEIPT_LIFETIME_SECONDS * 1000 ||
    preparedAt > admittedAt || admittedAt >= expiresAt ||
    leaseObservedAt > preparedAt || leaseExpiresAt < expiresAt || leaseExpiresAt <= leaseObservedAt ||
    firstQueueStableSince > firstQueueAt || secondQueueStableSince > secondQueueAt ||
    secondQueueAt - firstQueueAt < 5_000 || secondQueueAt > writerFenceObservedAt ||
    orphanRecoveryAt > firstQueueAt || orphanRecoveryAt > writerFenceObservedAt ||
    writerFenceIssuedAt > writerFenceObservedAt || writerFenceObservedAt > preparedAt ||
    writerFenceExpiresAt < expiresAt || writerFenceExpiresAt <= writerFenceObservedAt) {
    fail("entry receipt, lease, or stable queue observations are stale or inconsistent");
  }
}

function validateReceiptBytes(receiptBytes, context) {
  const bytes = Buffer.isBuffer(receiptBytes) ? receiptBytes : Buffer.from(receiptBytes);
  if (bytes.length === 0 || bytes.length > MAX_RECEIPT_BYTES) {
    fail("receipt size is outside the permitted range");
  }
  const receipt = strictJsonParse(bytes, `${context.expected.kind} receipt`);
  if (context.expected.contractVersion === "signed-entry-v2") {
    validateEntryReceipt(receipt, context);
  } else if (context.expected.contractVersion === "signed-phase-v1") {
    validateFinalPhaseReceiptObject(receipt, {
      expectedKind: context.expected.kind,
      previousReceiptBytes: context.previousReceiptBytes,
      previousReceiptSha256: context.previousReceiptSha256,
      identity: context.identity,
      governance: context.governance,
      fencingGeneration: context.fencingGeneration,
      admittedAt: context.admittedAt,
    });
  } else {
    fail(`unsupported receipt contract ${context.expected.contractVersion}`);
  }
  return { receipt, sha256: sha256Bytes(bytes), bytes };
}

function embeddedReceipt(receiptBytes, admittedAt, context) {
  const verified = validateReceiptBytes(receiptBytes, { ...context, admittedAt });
  return {
    kind: verified.receipt.kind,
    sequence: context.expected.sequence,
    sha256: verified.sha256,
    admittedAt,
    bytesBase64: verified.bytes.toString("base64"),
  };
}

function parseLedgerBytes(ledgerBytes) {
  const bytes = Buffer.isBuffer(ledgerBytes) ? ledgerBytes : Buffer.from(ledgerBytes);
  if (bytes.length === 0 || bytes.length > MAX_LEDGER_BYTES) {
    fail("ledger size is outside the permitted range");
  }
  return { bytes, ledger: strictJsonParse(bytes, "bootstrap phase ledger") };
}

function parseTombstoneBytes(tombstoneBytes) {
  if (!tombstoneBytes) {
    fail("complete bootstrap ledger is missing its consumed-attempt tombstone");
  }
  const bytes = Buffer.isBuffer(tombstoneBytes) ? tombstoneBytes : Buffer.from(tombstoneBytes);
  if (bytes.length === 0 || bytes.length > MAX_LEDGER_BYTES) {
    fail("consumed-attempt tombstone size is outside the permitted range");
  }
  const tombstone = strictJsonParse(bytes, "consumed-attempt tombstone");
  assertExactKeys(tombstone, TOMBSTONE_KEYS, "consumed-attempt tombstone");
  if (tombstone.schemaVersion !== 1 || tombstone.environment !== ENVIRONMENT ||
    tombstone.kind !== TOMBSTONE_KIND) {
    fail("consumed-attempt tombstone schema version, environment, or kind is invalid");
  }
  assertString(tombstone.attemptId, ATTEMPT_PATTERN, "tombstone.attemptId");
  assertString(tombstone.identitySha256, SHA256_PATTERN, "tombstone.identitySha256");
  assertPositiveSafeInteger(tombstone.fencingGeneration, "tombstone.fencingGeneration");
  assertString(tombstone.completionEvidenceHash, SHA256_PATTERN, "tombstone.completionEvidenceHash");
  assertString(tombstone.previousLedgerSha256, SHA256_PATTERN, "tombstone.previousLedgerSha256");
  assertString(tombstone.completedLedgerSha256, SHA256_PATTERN, "tombstone.completedLedgerSha256");
  parseIsoSecond(tombstone.completedAt, "tombstone.completedAt");
  if (tombstone.previousLedgerSha256 === tombstone.completedLedgerSha256) {
    fail("consumed-attempt tombstone before and after ledger hashes must differ");
  }
  return { bytes, tombstone };
}

function validateTombstone(tombstoneBytes, ledger, ledgerSha256) {
  const { tombstone } = parseTombstoneBytes(tombstoneBytes);
  if (
    tombstone.attemptId !== ledger.identity.attemptId ||
    tombstone.identitySha256 !== sha256Canonical(ledger.identity) ||
    tombstone.completedAt !== ledger.updatedAt ||
    tombstone.fencingGeneration !== ledger.fencingGeneration ||
    tombstone.completionEvidenceHash !== ledger.events.at(-1).completionEvidenceHash ||
    tombstone.previousLedgerSha256 !== ledger.events.at(-1).previousLedgerSha256 ||
    tombstone.completedLedgerSha256 !== ledgerSha256) {
    fail("consumed-attempt tombstone does not match the completed ledger");
  }
  return tombstone;
}

function validatePendingTombstone(tombstoneBytes, ledger, ledgerSha256) {
  const { tombstone } = parseTombstoneBytes(tombstoneBytes);
  if (ledger.consumed || tombstone.attemptId !== ledger.identity.attemptId ||
    tombstone.identitySha256 !== sha256Canonical(ledger.identity) ||
    tombstone.previousLedgerSha256 !== ledgerSha256 ||
    tombstone.fencingGeneration <= ledger.fencingGeneration ||
    parseIsoSecond(tombstone.completedAt, "tombstone.completedAt") <
      parseIsoSecond(ledger.updatedAt, "ledger.updatedAt")) {
    fail("consumed-attempt tombstone does not match the pending ledger transition");
  }
  return tombstone;
}

/**
 * Verify the complete ledger and embedded exact-byte receipt chain.
 * Historical receipts are checked at their recorded admission time so an
 * inspect performed days later does not invalidate durable evidence.
 */
export function verifyLedgerBytes(ledgerBytes, options = {}) {
  const { bytes, ledger } = parseLedgerBytes(ledgerBytes);
  assertExactKeys(ledger, LEDGER_KEYS, "bootstrap phase ledger");
  if (ledger.schemaVersion !== LEDGER_SCHEMA_VERSION ||
    ledger.environment !== ENVIRONMENT || ledger.kind !== LEDGER_KIND) {
    fail("ledger schema version, environment, or kind is invalid");
  }
  validateIdentity(ledger.identity);
  validateGovernance(ledger.governance);
  if (!Array.isArray(ledger.receipts) || ledger.receipts.length > RECEIPT_SEQUENCE.length) {
    fail("ledger receipts must be a bounded array");
  }
  if (!Array.isArray(ledger.events) || ledger.events.length < 1 || ledger.events.length > 32) {
    fail("ledger events must be a bounded non-empty array");
  }
  if (ledger.held !== null) {
    assertExactKeys(ledger.held, HELD_KEYS, "ledger held state");
  }

  const identitySha256 = sha256Canonical(ledger.identity);
  let state = null;
  let previousEventSha256 = null;
  let previousAt = null;
  let receiptCursor = 0;
  let held = null;

  for (let index = 0; index < ledger.events.length; index += 1) {
    const event = ledger.events[index];
    const eventKeys = event.action === "advance" && event.toPhase === "B8_COMPLETE"
      ? B8_EVENT_KEYS
      : EVENT_KEYS;
    assertExactKeys(event, eventKeys, `ledger event ${index}`);
    if (event.sequence !== index || event.identitySha256 !== identitySha256 ||
      event.previousEventSha256 !== previousEventSha256 ||
      !SHA256_PATTERN.test(event.eventSha256) || event.eventSha256 !== eventHash(event)) {
      fail(`ledger event ${index} hash chain is invalid`);
    }
    assertPositiveSafeInteger(event.fencingGeneration, `ledger event ${index} fencingGeneration`);
    const eventAt = parseIsoSecond(event.at, `ledger event ${index} at`);
    if (previousAt !== null && eventAt < previousAt) {
      fail("ledger event time moved backwards");
    }

    if (index === 0) {
      if (event.action !== "create" || event.fromPhase !== null ||
        event.toPhase !== "B0_ARTIFACT_READY" ||
        event.progressPhase !== "B0_ARTIFACT_READY" ||
        event.rollbackFloor !== "legacy-allowed" ||
        event.clerkInvocation !== "not-invoked" ||
        event.receiptSha256 !== null || event.holdReasonCode !== null ||
        event.holdEvidenceSha256 !== null) {
        fail("ledger creation event is invalid");
      }
      state = {
        phase: event.toPhase,
        progressPhase: event.progressPhase,
        rollbackFloor: event.rollbackFloor,
        clerkInvocation: event.clerkInvocation,
        fencingGeneration: event.fencingGeneration,
      };
    } else {
      if (event.fencingGeneration <= state.fencingGeneration) {
        fail("fencing generation did not increase monotonically");
      }
      if (event.action === "hold") {
        if (state.phase === HELD || state.progressPhase === "B8_COMPLETE" ||
          event.fromPhase !== state.phase || event.toPhase !== HELD ||
          event.progressPhase !== state.progressPhase ||
          event.rollbackFloor !== state.rollbackFloor ||
          event.clerkInvocation !== state.clerkInvocation ||
          event.receiptSha256 !== null) {
          fail(`ledger hold event ${index} is invalid`);
        }
        assertString(event.holdReasonCode, REASON_PATTERN, `ledger event ${index} holdReasonCode`);
        assertString(event.holdEvidenceSha256, SHA256_PATTERN, `ledger event ${index} holdEvidenceSha256`);
        held = {
          fromPhase: state.progressPhase,
          reasonCode: event.holdReasonCode,
          evidenceSha256: event.holdEvidenceSha256,
          heldAt: event.at,
        };
        state = { ...state, phase: HELD, fencingGeneration: event.fencingGeneration };
      } else if (event.action === "advance") {
        if (event.holdReasonCode !== null || event.holdEvidenceSha256 !== null ||
          event.fromPhase !== state.phase) {
          fail(`ledger advance event ${index} is invalid`);
        }
        const currentIndex = PHASE_INDEX.get(state.progressPhase);
        const expectedPhase = PHASES[currentIndex + 1];
        if (!expectedPhase || event.toPhase !== expectedPhase || event.progressPhase !== expectedPhase) {
          fail("ledger transition skipped, replayed, or downgraded a phase");
        }
        let expectedClerkInvocation = state.clerkInvocation;
        if (expectedPhase === "B3_SCHEMA_FORWARD_ONLY") {
          if (!["invoked", "uncertain"].includes(event.clerkInvocation)) {
            fail("entry to schema-forward-only must record invoked or uncertain Clerk state");
          }
          expectedClerkInvocation = event.clerkInvocation;
        } else if (expectedPhase === "B4_SCHEMA_VERIFIED") {
          expectedClerkInvocation = "verified";
        }
        if (event.clerkInvocation !== expectedClerkInvocation ||
          event.rollbackFloor !== rollbackFloorFor(expectedPhase, expectedClerkInvocation)) {
          fail("ledger rollback floor or Clerk invocation state is invalid");
        }
        if (expectedPhase === "B8_COMPLETE") {
          assertString(
            event.completionEvidenceHash,
            SHA256_PATTERN,
            `ledger event ${index} completionEvidenceHash`,
          );
          assertString(
            event.previousLedgerSha256,
            SHA256_PATTERN,
            `ledger event ${index} previousLedgerSha256`,
          );
        } else if (event.completionEvidenceHash !== undefined) {
          fail("completion evidence may only be bound when entering B8");
        }
        const receiptRule = RECEIPT_BY_PHASE.get(expectedPhase);
        if (receiptRule) {
          const embedded = ledger.receipts[receiptCursor];
          if (!embedded) {
            fail(`transition to ${expectedPhase} is missing its required receipt`);
          }
          assertExactKeys(embedded, EMBEDDED_RECEIPT_KEYS, `embedded receipt ${receiptCursor}`);
          if (embedded.kind !== receiptRule.kind || embedded.sequence !== receiptRule.sequence ||
            embedded.admittedAt !== event.at) {
            fail(`embedded receipt ${receiptCursor} metadata is invalid`);
          }
          const receiptBytes = strictBase64Decode(embedded.bytesBase64, `embedded receipt ${receiptCursor} bytes`);
          const priorReceiptSha256 = receiptCursor === 0 ? null : ledger.receipts[receiptCursor - 1].sha256;
          const priorReceiptBytes = receiptCursor === 0 ? null : strictBase64Decode(
            ledger.receipts[receiptCursor - 1].bytesBase64,
            `embedded receipt ${receiptCursor - 1} predecessor bytes`,
          );
          const verified = validateReceiptBytes(receiptBytes, {
            expected: receiptRule,
            identity: ledger.identity,
            governance: ledger.governance,
            fencingGeneration: event.fencingGeneration,
            previousReceiptSha256: priorReceiptSha256,
            previousReceiptBytes: priorReceiptBytes,
            admittedAt: event.at,
          });
          if (embedded.sha256 !== verified.sha256 || event.receiptSha256 !== verified.sha256) {
            fail(`embedded receipt ${receiptCursor} exact-byte digest is invalid`);
          }
          receiptCursor += 1;
        } else if (event.receiptSha256 !== null) {
          fail(`transition to ${expectedPhase} must not admit a receipt`);
        }
        state = {
          phase: expectedPhase,
          progressPhase: expectedPhase,
          rollbackFloor: event.rollbackFloor,
          clerkInvocation: event.clerkInvocation,
          fencingGeneration: event.fencingGeneration,
        };
        held = null;
      } else {
        fail(`ledger event ${index} action is invalid`);
      }
    }
    previousEventSha256 = event.eventSha256;
    previousAt = eventAt;
  }

  if (receiptCursor !== ledger.receipts.length ||
    receiptCursor !== expectedReceiptCountForPhase(state.progressPhase)) {
    fail("ledger receipt count does not match its progress phase");
  }
  const receiptKinds = ledger.receipts.map((entry) => entry.kind);
  const expectedResumeEligibility = resumeEligibilityFor(state.progressPhase, receiptKinds);
  const expectedConsumed = state.progressPhase === "B8_COMPLETE";
  if (ledger.phase !== state.phase || ledger.progressPhase !== state.progressPhase ||
    ledger.rollbackFloor !== state.rollbackFloor ||
    ledger.clerkInvocation !== state.clerkInvocation ||
    ledger.fencingGeneration !== state.fencingGeneration ||
    ledger.resumeEligibility !== expectedResumeEligibility ||
    ledger.consumed !== expectedConsumed ||
    ledger.createdAt !== ledger.events[0].at ||
    ledger.updatedAt !== ledger.events.at(-1).at ||
    !sameJson(ledger.held, held)) {
    fail("ledger summary fields do not match the reconstructed event chain");
  }
  parseIsoSecond(ledger.createdAt, "ledger.createdAt");
  parseIsoSecond(ledger.updatedAt, "ledger.updatedAt");

  const ledgerSha256 = sha256Bytes(bytes);
  let tombstone = null;
  if (expectedConsumed) {
    if (!options.allowMissingTombstone) {
      tombstone = validateTombstone(options.tombstoneBytes, ledger, ledgerSha256);
    }
  } else if (options.tombstoneBytes) {
    fail("an unconsumed ledger must not have a consumed-attempt tombstone");
  }

  return {
    ledger,
    ledgerSha256,
    identitySha256,
    receiptKinds,
    resumeEligibility: expectedResumeEligibility,
    tombstone,
  };
}

function serializeDocument(document) {
  return Buffer.from(`${JSON.stringify(document, null, 2)}\n`, "utf8");
}

export function createLedger(input) {
  validateIdentity(input.identity);
  validateGovernance(input.governance);
  assertPositiveSafeInteger(input.fencingGeneration, "fencingGeneration");
  parseIsoSecond(input.at, "create time");
  const identitySha256 = sha256Canonical(input.identity);
  const event = buildEvent({
    sequence: 0,
    action: "create",
    fromPhase: null,
    toPhase: "B0_ARTIFACT_READY",
    progressPhase: "B0_ARTIFACT_READY",
    rollbackFloor: "legacy-allowed",
    clerkInvocation: "not-invoked",
    fencingGeneration: input.fencingGeneration,
    at: input.at,
    receiptSha256: null,
    holdReasonCode: null,
    holdEvidenceSha256: null,
    identitySha256,
    previousEventSha256: null,
  });
  const ledger = {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    environment: ENVIRONMENT,
    kind: LEDGER_KIND,
    identity: input.identity,
    governance: input.governance,
    phase: "B0_ARTIFACT_READY",
    progressPhase: "B0_ARTIFACT_READY",
    rollbackFloor: "legacy-allowed",
    clerkInvocation: "not-invoked",
    fencingGeneration: input.fencingGeneration,
    resumeEligibility: "denied",
    consumed: false,
    createdAt: input.at,
    updatedAt: input.at,
    held: null,
    receipts: [],
    events: [event],
  };
  const ledgerBytes = serializeDocument(ledger);
  verifyLedgerBytes(ledgerBytes);
  return { ledger, ledgerBytes, ledgerSha256: sha256Bytes(ledgerBytes) };
}

export function advanceLedger(currentLedgerBytes, input) {
  const current = verifyLedgerBytes(currentLedgerBytes, input.currentTombstoneBytes
    ? { tombstoneBytes: input.currentTombstoneBytes }
    : {});
  const ledger = current.ledger;
  if (ledger.consumed) {
    fail("consumed bootstrap attempt cannot advance");
  }
  assertPositiveSafeInteger(input.fencingGeneration, "fencingGeneration");
  if (input.fencingGeneration <= ledger.fencingGeneration) {
    fail("fencing generation must increase before every ledger mutation");
  }
  parseIsoSecond(input.at, "advance time");
  if (parseIsoSecond(input.at, "advance time") < parseIsoSecond(ledger.updatedAt, "ledger.updatedAt")) {
    fail("advance time cannot move backwards");
  }
  const currentIndex = PHASE_INDEX.get(ledger.progressPhase);
  const expectedPhase = PHASES[currentIndex + 1];
  if (!expectedPhase || input.toPhase !== expectedPhase) {
    fail("advance must target exactly the next bootstrap phase");
  }
  let clerkInvocation = ledger.clerkInvocation;
  if (expectedPhase === "B3_SCHEMA_FORWARD_ONLY") {
    if (!["invoked", "uncertain"].includes(input.clerkInvocation)) {
      fail("B3 requires --clerk-invocation invoked or uncertain");
    }
    clerkInvocation = input.clerkInvocation;
  } else if (input.clerkInvocation !== undefined) {
    fail("Clerk invocation state may only be supplied when entering B3");
  }
  if (expectedPhase === "B4_SCHEMA_VERIFIED") {
    clerkInvocation = "verified";
  }
  let completionEvidenceHash = null;
  if (expectedPhase === "B8_COMPLETE") {
    assertString(input.completionEvidenceHash, SHA256_PATTERN, "completionEvidenceHash");
    completionEvidenceHash = input.completionEvidenceHash;
  } else if (input.completionEvidenceHash !== undefined) {
    fail("completionEvidenceHash may only be supplied when entering B8");
  }
  const rollbackFloor = rollbackFloorFor(expectedPhase, clerkInvocation);
  const receiptRule = RECEIPT_BY_PHASE.get(expectedPhase);
  let admittedReceipt = null;
  if (receiptRule) {
    if (!input.receiptBytes) {
      fail(`transition to ${expectedPhase} requires ${receiptRule.kind} receipt bytes`);
    }
    const previousReceiptSha256 = ledger.receipts.length === 0
      ? null
      : ledger.receipts.at(-1).sha256;
    const previousReceiptBytes = ledger.receipts.length === 0
      ? null
      : strictBase64Decode(ledger.receipts.at(-1).bytesBase64, "previous embedded receipt bytes");
    admittedReceipt = embeddedReceipt(input.receiptBytes, input.at, {
      expected: receiptRule,
      identity: ledger.identity,
      governance: ledger.governance,
      fencingGeneration: input.fencingGeneration,
      previousReceiptSha256,
      previousReceiptBytes,
    });
  } else if (input.receiptBytes) {
    fail(`transition to ${expectedPhase} must not include receipt bytes`);
  }
  const event = buildEvent({
    sequence: ledger.events.length,
    action: "advance",
    fromPhase: ledger.phase,
    toPhase: expectedPhase,
    progressPhase: expectedPhase,
    rollbackFloor,
    clerkInvocation,
    fencingGeneration: input.fencingGeneration,
    at: input.at,
    receiptSha256: admittedReceipt?.sha256 ?? null,
    ...(completionEvidenceHash
      ? { completionEvidenceHash, previousLedgerSha256: current.ledgerSha256 }
      : {}),
    holdReasonCode: null,
    holdEvidenceSha256: null,
    identitySha256: current.identitySha256,
    previousEventSha256: ledger.events.at(-1).eventSha256,
  });
  const receipts = admittedReceipt ? [...ledger.receipts, admittedReceipt] : [...ledger.receipts];
  const next = {
    ...ledger,
    phase: expectedPhase,
    progressPhase: expectedPhase,
    rollbackFloor,
    clerkInvocation,
    fencingGeneration: input.fencingGeneration,
    resumeEligibility: resumeEligibilityFor(expectedPhase, receipts.map((entry) => entry.kind)),
    consumed: expectedPhase === "B8_COMPLETE",
    updatedAt: input.at,
    held: null,
    receipts,
    events: [...ledger.events, event],
  };
  const ledgerBytes = serializeDocument(next);
  verifyLedgerBytes(ledgerBytes, { allowMissingTombstone: expectedPhase === "B8_COMPLETE" });
  let tombstone = null;
  let tombstoneBytes = null;
  if (expectedPhase === "B8_COMPLETE") {
    tombstone = {
      schemaVersion: 1,
      environment: ENVIRONMENT,
      kind: TOMBSTONE_KIND,
      attemptId: next.identity.attemptId,
      identitySha256: current.identitySha256,
      completedAt: input.at,
      fencingGeneration: input.fencingGeneration,
      completionEvidenceHash,
      previousLedgerSha256: current.ledgerSha256,
      completedLedgerSha256: sha256Bytes(ledgerBytes),
    };
    tombstoneBytes = serializeDocument(tombstone);
    verifyLedgerBytes(ledgerBytes, { tombstoneBytes });
  }
  return {
    ledger: next,
    ledgerBytes,
    ledgerSha256: sha256Bytes(ledgerBytes),
    tombstone,
    tombstoneBytes,
  };
}

export function holdLedger(currentLedgerBytes, input) {
  const current = verifyLedgerBytes(currentLedgerBytes);
  const ledger = current.ledger;
  if (ledger.consumed) {
    fail("consumed bootstrap attempt cannot be held");
  }
  if (ledger.phase === HELD) {
    fail("ledger is already held");
  }
  assertPositiveSafeInteger(input.fencingGeneration, "fencingGeneration");
  if (input.fencingGeneration <= ledger.fencingGeneration) {
    fail("fencing generation must increase before every ledger mutation");
  }
  assertString(input.reasonCode, REASON_PATTERN, "hold reasonCode");
  assertString(input.evidenceSha256, SHA256_PATTERN, "hold evidenceSha256");
  const at = parseIsoSecond(input.at, "hold time");
  if (at < parseIsoSecond(ledger.updatedAt, "ledger.updatedAt")) {
    fail("hold time cannot move backwards");
  }
  const event = buildEvent({
    sequence: ledger.events.length,
    action: "hold",
    fromPhase: ledger.phase,
    toPhase: HELD,
    progressPhase: ledger.progressPhase,
    rollbackFloor: ledger.rollbackFloor,
    clerkInvocation: ledger.clerkInvocation,
    fencingGeneration: input.fencingGeneration,
    at: input.at,
    receiptSha256: null,
    holdReasonCode: input.reasonCode,
    holdEvidenceSha256: input.evidenceSha256,
    identitySha256: current.identitySha256,
    previousEventSha256: ledger.events.at(-1).eventSha256,
  });
  const held = {
    fromPhase: ledger.progressPhase,
    reasonCode: input.reasonCode,
    evidenceSha256: input.evidenceSha256,
    heldAt: input.at,
  };
  const next = {
    ...ledger,
    phase: HELD,
    fencingGeneration: input.fencingGeneration,
    updatedAt: input.at,
    held,
    events: [...ledger.events, event],
  };
  const ledgerBytes = serializeDocument(next);
  verifyLedgerBytes(ledgerBytes);
  return { ledger: next, ledgerBytes, ledgerSha256: sha256Bytes(ledgerBytes) };
}

function safeRegularFile(path, label) {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    fail(`${label} must be a regular, non-symlink, single-link file`);
  }
  return metadata;
}

function readBoundedFile(path, maximumBytes, label) {
  const metadata = safeRegularFile(path, label);
  if (metadata.size < 1 || metadata.size > maximumBytes) {
    fail(`${label} size is outside the permitted range`);
  }
  return readFileSync(path);
}

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SCRIPT_PATH), "..");

function validateMutationPath(path) {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path) {
    fail("ledger mutation path must be absolute and normalized");
  }
  const parent = dirname(path);
  if (realpathSync(parent) !== parent || !statSync(parent).isDirectory()) {
    fail("ledger parent must be an existing, non-symlink directory");
  }
  if (path === REPO_ROOT || path.startsWith(`${REPO_ROOT}${sep}`)) {
    fail("mutable bootstrap ledgers must be stored outside the repository");
  }
}

function tombstonePathFor(ledgerPath) {
  return `${ledgerPath}.consumed.json`;
}

function acquireLock(ledgerPath) {
  const lockPath = `${ledgerPath}.lock`;
  let descriptor;
  try {
    descriptor = openSync(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    writeFileSync(descriptor, `${process.pid}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* best effort */ }
    }
    fail(`could not acquire exclusive ledger lock: ${error.message}`);
  }
  return () => {
    try { unlinkSync(lockPath); } catch { /* a stale missing lock remains fail-closed */ }
  };
}

function fsyncDirectory(path) {
  const descriptor = openSync(path, fsConstants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function writeTemp(parent, baseName, bytes) {
  const tempPath = join(parent, `.${baseName}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  const descriptor = openSync(tempPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  try {
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  return tempPath;
}

function writeNewAtomic(path, bytes) {
  const parent = dirname(path);
  const tempPath = writeTemp(parent, path.slice(parent.length + 1), bytes);
  try {
    linkSync(tempPath, path);
    fsyncDirectory(parent);
  } finally {
    try { unlinkSync(tempPath); } catch { /* preserve original failure */ }
  }
}

function replaceAtomic(path, bytes) {
  safeRegularFile(path, "existing ledger");
  const parent = dirname(path);
  const tempPath = writeTemp(parent, path.slice(parent.length + 1), bytes);
  try {
    renameSync(tempPath, path);
    fsyncDirectory(parent);
  } catch (error) {
    try { unlinkSync(tempPath); } catch { /* preserve original failure */ }
    throw error;
  }
}

function assertExpectedLedgerHash(bytes, expected) {
  assertString(expected, SHA256_PATTERN, "expected ledger SHA-256");
  const actual = sha256Bytes(bytes);
  if (actual !== expected) {
    fail(`ledger compare-and-swap failed: expected ${expected}, found ${actual}`);
  }
}

function parseFlags(argumentsList) {
  const flags = Object.create(null);
  for (let index = 0; index < argumentsList.length; index += 1) {
    const token = argumentsList[index];
    if (!token.startsWith("--") || token === "--") {
      fail(`unexpected argument ${token}`);
    }
    const name = token.slice(2);
    if (Object.hasOwn(flags, name)) {
      fail(`duplicate option --${name}`);
    }
    if (name === "yes") {
      flags[name] = true;
      continue;
    }
    const value = argumentsList[index + 1];
    if (value === undefined || value.startsWith("--")) {
      fail(`option --${name} requires a value`);
    }
    flags[name] = value;
    index += 1;
  }
  return flags;
}

function requireOnlyFlags(flags, allowed, required) {
  for (const key of Object.keys(flags)) {
    if (!allowed.includes(key)) {
      fail(`unknown option --${key}`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(flags, key)) {
      fail(`missing required option --${key}`);
    }
  }
}

function integerFlag(value, label) {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) {
    fail(`${label} must be a positive decimal integer`);
  }
  const parsed = Number(value);
  assertPositiveSafeInteger(parsed, label);
  return parsed;
}

function requireMutationConfirmation(flags) {
  if (flags.yes !== true) {
    fail("mutation requires the explicit --yes acknowledgement");
  }
}

function inspectFile(ledgerPath) {
  const ledgerBytes = readBoundedFile(ledgerPath, MAX_LEDGER_BYTES, "ledger");
  const parsed = parseLedgerBytes(ledgerBytes).ledger;
  const tombstonePath = tombstonePathFor(ledgerPath);
  const tombstoneBytes = existsSync(tombstonePath)
    ? readBoundedFile(tombstonePath, MAX_LEDGER_BYTES, "consumed-attempt tombstone")
    : null;
  const verified = verifyLedgerBytes(ledgerBytes, parsed?.consumed ? { tombstoneBytes } : { tombstoneBytes });
  return {
    ledgerSha256: verified.ledgerSha256,
    attemptId: verified.ledger.identity.attemptId,
    phase: verified.ledger.phase,
    progressPhase: verified.ledger.progressPhase,
    rollbackFloor: verified.ledger.rollbackFloor,
    clerkInvocation: verified.ledger.clerkInvocation,
    fencingGeneration: verified.ledger.fencingGeneration,
    resumeEligibility: verified.resumeEligibility,
    receiptKinds: verified.receiptKinds,
    consumed: verified.ledger.consumed,
    tombstoneSha256: tombstoneBytes ? sha256Bytes(tombstoneBytes) : null,
  };
}

function createFile(flags) {
  const allowed = [
    "ledger", "attempt-id", "backend-commit", "console-commit", "api-image",
    "worker-image", "console-image", "database-identity-hash", "redis-identity-hash",
    "azure-identity-hash", "admission-context-hash", "operator", "approver", "change-ticket",
    "fencing-generation", "yes",
  ];
  requireOnlyFlags(flags, allowed, allowed);
  requireMutationConfirmation(flags);
  validateMutationPath(flags.ledger);
  const release = acquireLock(flags.ledger);
  try {
    if (existsSync(flags.ledger) || existsSync(tombstonePathFor(flags.ledger))) {
      fail("create refuses to overwrite an existing ledger or consumed-attempt tombstone");
    }
    const result = createLedger({
      identity: {
        attemptId: flags["attempt-id"],
        candidate: {
          backendCommit: flags["backend-commit"],
          consoleCommit: flags["console-commit"],
          apiImage: flags["api-image"],
          workerImage: flags["worker-image"],
          consoleImage: flags["console-image"],
        },
        databaseIdentityHash: flags["database-identity-hash"],
        redisIdentityHash: flags["redis-identity-hash"],
        azureIdentityHash: flags["azure-identity-hash"],
        admissionContextHash: flags["admission-context-hash"],
      },
      governance: {
        operator: flags.operator,
        approver: flags.approver,
        changeTicket: flags["change-ticket"],
      },
      fencingGeneration: integerFlag(flags["fencing-generation"], "fencing generation"),
      at: nowIsoSecond(),
    });
    writeNewAtomic(flags.ledger, result.ledgerBytes);
    return inspectFile(flags.ledger);
  } finally {
    release();
  }
}

function injectB8CommitFault(options, point) {
  if (options.faultInjector) {
    options.faultInjector(point);
  }
}

function assertExactB8ReplayRequest(flags, tombstone, receiptBytes, fencingGeneration) {
  if (flags.to !== "B8_COMPLETE") {
    fail("consumed-attempt tombstone permits only an exact B8 replay");
  }
  if (flags["clerk-invocation"] !== undefined) {
    fail("Clerk invocation state may only be supplied when entering B3");
  }
  if (!receiptBytes) {
    fail("transition to B8_COMPLETE requires bootstrap-complete receipt bytes");
  }
  assertString(
    flags["completion-evidence-sha256"],
    SHA256_PATTERN,
    "completion evidence SHA-256",
  );
  if (flags["completion-evidence-sha256"] !== tombstone.completionEvidenceHash) {
    fail("B8 replay completion evidence does not match the durable transaction");
  }
  assertString(flags["expected-ledger-sha256"], SHA256_PATTERN, "expected ledger SHA-256");
  if (flags["expected-ledger-sha256"] !== tombstone.previousLedgerSha256) {
    fail(
      `ledger compare-and-swap failed: B8 transaction began from ${tombstone.previousLedgerSha256}, ` +
      `replay supplied ${flags["expected-ledger-sha256"]}`,
    );
  }
  if (fencingGeneration !== tombstone.fencingGeneration) {
    fail("B8 replay fencing generation does not match the durable transaction");
  }
}

function assertExactCompletedReceipt(ledger, receiptBytes) {
  const embedded = ledger.receipts.at(-1);
  if (embedded?.kind !== "bootstrap-complete" ||
    embedded.sha256 !== sha256Bytes(receiptBytes) ||
    embedded.bytesBase64 !== Buffer.from(receiptBytes).toString("base64")) {
    fail("B8 replay receipt bytes do not match the completed ledger");
  }
}

// The tombstone is a write-ahead B8 transaction record. Its hashes are bound
// into the completed event: a pre-replacement retry must reconstruct the exact
// after-image, while a post-replacement retry must present the original CAS
// token and exact receipt, generation, and completion evidence.
function recoverOrReplayB8(flags, currentBytes, tombstoneBytes, receiptBytes, fencingGeneration, options) {
  const parsed = parseLedgerBytes(currentBytes).ledger;
  if (parsed.consumed === true) {
    const completed = verifyLedgerBytes(currentBytes, { tombstoneBytes });
    assertExactB8ReplayRequest(flags, completed.tombstone, receiptBytes, fencingGeneration);
    assertExactCompletedReceipt(completed.ledger, receiptBytes);
    return inspectFile(flags.ledger);
  }

  assertExpectedLedgerHash(currentBytes, flags["expected-ledger-sha256"]);
  const current = verifyLedgerBytes(currentBytes);
  const tombstone = validatePendingTombstone(
    tombstoneBytes,
    current.ledger,
    current.ledgerSha256,
  );
  assertExactB8ReplayRequest(flags, tombstone, receiptBytes, fencingGeneration);
  const result = advanceLedger(currentBytes, {
    toPhase: flags.to,
    fencingGeneration,
    receiptBytes,
    completionEvidenceHash: flags["completion-evidence-sha256"],
    at: tombstone.completedAt,
  });
  if (!result.tombstoneBytes?.equals(tombstoneBytes) ||
    result.ledgerSha256 !== tombstone.completedLedgerSha256) {
    fail("pending B8 transaction does not match the exact replay inputs");
  }
  replaceAtomic(flags.ledger, result.ledgerBytes);
  injectB8CommitFault(options, B8_COMMIT_FAULT_POINTS.afterLedgerReplace);
  return inspectFile(flags.ledger);
}

function advanceFile(flags, options = {}) {
  const allowed = [
    "ledger", "expected-ledger-sha256", "to", "fencing-generation", "receipt",
    "clerk-invocation", "completion-evidence-sha256", "yes",
  ];
  const required = ["ledger", "expected-ledger-sha256", "to", "fencing-generation", "yes"];
  requireOnlyFlags(flags, allowed, required);
  requireMutationConfirmation(flags);
  validateMutationPath(flags.ledger);
  const release = acquireLock(flags.ledger);
  try {
    const currentBytes = readBoundedFile(flags.ledger, MAX_LEDGER_BYTES, "ledger");
    const receiptBytes = flags.receipt
      ? readBoundedFile(resolve(flags.receipt), MAX_RECEIPT_BYTES, "receipt")
      : null;
    const fencingGeneration = integerFlag(flags["fencing-generation"], "fencing generation");
    const tombstonePath = tombstonePathFor(flags.ledger);
    if (existsSync(tombstonePath)) {
      const tombstoneBytes = readBoundedFile(
        tombstonePath,
        MAX_LEDGER_BYTES,
        "consumed-attempt tombstone",
      );
      return recoverOrReplayB8(
        flags,
        currentBytes,
        tombstoneBytes,
        receiptBytes,
        fencingGeneration,
        options,
      );
    }
    assertExpectedLedgerHash(currentBytes, flags["expected-ledger-sha256"]);
    const result = advanceLedger(currentBytes, {
      toPhase: flags.to,
      fencingGeneration,
      clerkInvocation: flags["clerk-invocation"],
      receiptBytes,
      completionEvidenceHash: flags["completion-evidence-sha256"],
      at: nowIsoSecond(),
    });
    if (result.tombstoneBytes) {
      writeNewAtomic(tombstonePath, result.tombstoneBytes);
      injectB8CommitFault(options, B8_COMMIT_FAULT_POINTS.afterTombstoneWrite);
    }
    replaceAtomic(flags.ledger, result.ledgerBytes);
    if (result.tombstoneBytes) {
      injectB8CommitFault(options, B8_COMMIT_FAULT_POINTS.afterLedgerReplace);
    }
    return inspectFile(flags.ledger);
  } finally {
    release();
  }
}

function holdFile(flags) {
  const allowed = [
    "ledger", "expected-ledger-sha256", "fencing-generation", "reason-code",
    "evidence-sha256", "yes",
  ];
  requireOnlyFlags(flags, allowed, allowed);
  requireMutationConfirmation(flags);
  validateMutationPath(flags.ledger);
  const release = acquireLock(flags.ledger);
  try {
    if (existsSync(tombstonePathFor(flags.ledger))) {
      fail("consumed-attempt tombstone exists; completed attempt cannot be held");
    }
    const currentBytes = readBoundedFile(flags.ledger, MAX_LEDGER_BYTES, "ledger");
    assertExpectedLedgerHash(currentBytes, flags["expected-ledger-sha256"]);
    const result = holdLedger(currentBytes, {
      fencingGeneration: integerFlag(flags["fencing-generation"], "fencing generation"),
      reasonCode: flags["reason-code"],
      evidenceSha256: flags["evidence-sha256"],
      at: nowIsoSecond(),
    });
    replaceAtomic(flags.ledger, result.ledgerBytes);
    return inspectFile(flags.ledger);
  } finally {
    release();
  }
}

function usage() {
  return [
    "Usage:",
    "  production-bootstrap-phase-ledger.mjs create --ledger ABSOLUTE_PATH ... --yes",
    "  production-bootstrap-phase-ledger.mjs advance --ledger ABSOLUTE_PATH --expected-ledger-sha256 sha256:... --to PHASE --fencing-generation N [--receipt FILE] [--clerk-invocation invoked|uncertain] [--completion-evidence-sha256 sha256:...] --yes",
    "  production-bootstrap-phase-ledger.mjs hold --ledger ABSOLUTE_PATH --expected-ledger-sha256 sha256:... --fencing-generation N --reason-code CODE --evidence-sha256 sha256:... --yes",
    "  production-bootstrap-phase-ledger.mjs inspect --ledger ABSOLUTE_PATH",
  ].join("\n");
}

export function runCli(argumentsList, options = {}) {
  if (!isPlainObject(options) || Object.keys(options).some((key) => key !== "faultInjector") ||
    (options.faultInjector !== undefined && typeof options.faultInjector !== "function")) {
    fail("CLI runtime options are invalid");
  }
  const [command, ...rest] = argumentsList;
  if (!["create", "advance", "hold", "inspect"].includes(command)) {
    fail(usage());
  }
  const flags = parseFlags(rest);
  if (command === "inspect") {
    requireOnlyFlags(flags, ["ledger"], ["ledger"]);
    return inspectFile(resolve(flags.ledger));
  }
  if (command === "create") {
    return createFile(flags);
  }
  if (command === "advance") {
    return advanceFile(flags, options);
  }
  return holdFile(flags);
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  try {
    const output = runCli(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`ERROR: ${error.message}\n`);
    process.exitCode = 1;
  }
}
