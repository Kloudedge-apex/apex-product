#!/usr/bin/env node

/**
 * Exact contracts for the four signed receipts admitted after the initial
 * production-bootstrap entry receipt.
 *
 * This module is intentionally provider-read-only. It validates exact JSON
 * bytes and evidence supplied by the protected controller; it never mutates
 * Azure, PostgreSQL, Redis, queues, or the phase ledger.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";

export const FINAL_PHASE_RECEIPT_CONTRACT_VERSION =
  "workforce-production-bootstrap-phase-receipt-v1";
export const FINAL_PHASE_CONTEXT_KIND = "production-bootstrap-phase-context";
export const FINAL_PHASE_CONTEXT_GENERATOR =
  "workforce-production-bootstrap-controller-v1";
export const MAX_PHASE_RECEIPT_BYTES = 128 * 1024;
export const MAX_PHASE_CONTEXT_BYTES = 128 * 1024;
export const MAX_PHASE_RECEIPT_LIFETIME_SECONDS = 15 * 60;
export const MAX_PHASE_CONTEXT_AGE_SECONDS = 5 * 60;
export const PHASE_RECEIPT_FUTURE_SKEW_SECONDS = 60;

const MAX_JSON_DEPTH = 64;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const ATTEMPT_PATTERN = /^[0-9a-f]{32}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const PRINCIPAL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}$/;
const API_IMAGE_PATTERN = /^ledgracr\.azurecr\.io\/apex-api@sha256:[0-9a-f]{64}$/;
const CONSOLE_IMAGE_PATTERN = /^ledgracr\.azurecr\.io\/workforceos-fe@sha256:[0-9a-f]{64}$/;
const API_REVISION_PATTERN = /^apex-gtm-api--[a-z0-9][a-z0-9-]{0,62}$/;
const WORKER_REVISION_PATTERN = /^apex-gtm-worker--[a-z0-9][a-z0-9-]{0,62}$/;
const CONSOLE_REVISION_PATTERN = /^nikxius-web--[a-z0-9][a-z0-9-]{0,62}$/;

export const FINAL_PHASE_RECEIPT_SPECS = Object.freeze([
  Object.freeze({
    kind: "production-schema-result",
    previousKind: "initial-bootstrap-entry",
    sequence: 2,
    phase: "B4_SCHEMA_VERIFIED",
    status: "applied-and-verified",
    authorizationScope: "verify-forward-schema-only",
    signatureNamespace: "workforce-os-production-schema-result",
    rollbackPolicy: Object.freeze({
      floor: "forward-only",
      legacySourceRestorePermitted: false,
      enumAwareDisabledRestorePermitted: false,
      requiredRecoveryAction:
        "complete-forward-schema-and-establish-disabled-baseline",
    }),
  }),
  Object.freeze({
    kind: "enum-aware-disabled-baseline",
    previousKind: "production-schema-result",
    sequence: 3,
    phase: "B5_COMPATIBLE_BASELINE",
    status: "verified-disabled",
    authorizationScope: "establish-enum-aware-disabled-baseline-only",
    signatureNamespace: "workforce-os-enum-aware-disabled-baseline",
    rollbackPolicy: Object.freeze({
      floor: "enum-aware-disabled",
      legacySourceRestorePermitted: false,
      enumAwareDisabledRestorePermitted: true,
      requiredRecoveryAction: "restore-exact-enum-aware-disabled-baseline",
    }),
  }),
  Object.freeze({
    kind: "first-class-activation",
    previousKind: "enum-aware-disabled-baseline",
    sequence: 4,
    phase: "B6_FIRST_CLASS_ARMED",
    status: "verified-first-class-armed",
    authorizationScope: "authorize-first-class-resume-only",
    signatureNamespace: "workforce-os-first-class-activation",
    rollbackPolicy: Object.freeze({
      floor: "activation-attempted",
      legacySourceRestorePermitted: false,
      enumAwareDisabledRestorePermitted: true,
      requiredRecoveryAction:
        "disable-first-class-gates-before-exact-enum-aware-disabled-restore",
    }),
  }),
  Object.freeze({
    kind: "bootstrap-complete",
    previousKind: "first-class-activation",
    sequence: 5,
    phase: "B8_COMPLETE",
    status: "verified-complete",
    authorizationScope: "confirm-bootstrap-complete-only",
    signatureNamespace: "workforce-os-bootstrap-complete",
    rollbackPolicy: Object.freeze({
      floor: "activation-attempted",
      legacySourceRestorePermitted: false,
      enumAwareDisabledRestorePermitted: true,
      requiredRecoveryAction:
        "disable-first-class-gates-before-exact-enum-aware-disabled-restore",
    }),
  }),
]);

const SPEC_BY_KIND = new Map(FINAL_PHASE_RECEIPT_SPECS.map((spec) => [spec.kind, spec]));

export const PHASE_MIGRATIONS = Object.freeze([
  Object.freeze({
    path: "docs/migrations/2026-08-13_clerk-identity-lifecycle-expand.sql",
    sha256: "sha256:356f4b660edd6aab07b523785e3cbc9b962a0f3f07b97e3dcfc155e1ea7fefdc",
    writerPause: "observed",
    writerScopes: Object.freeze(["api:clerk-webhooks", "api:identity-membership"]),
  }),
  Object.freeze({
    path: "docs/migrations/2026-06-01_outreach-artifact-unique.sql",
    sha256: "sha256:5653818552e1e52bf71229fa3c485dd284da331ee50a69669e98bc65e1a35fb2",
    writerPause: "observed",
    writerScopes: Object.freeze(["api:outreach-artifacts", "worker:outreach-artifacts"]),
  }),
  Object.freeze({
    path: "docs/migrations/2026-08-12_conversation-store-expand.sql",
    sha256: "sha256:b27e2f5d0e23299404c9a423110d1e5af324037246d70e75e1cb46e59b90e49e",
    writerPause: "not-required",
    writerScopes: Object.freeze([]),
  }),
  Object.freeze({
    path: "docs/migrations/2026-08-12_outreach-delivery-unknown-expand.sql",
    sha256: "sha256:4f5b687b4dad2969e554432b4812c0f57c1b07a6549eecf469997da45a44d14a",
    writerPause: "not-required",
    writerScopes: Object.freeze([]),
  }),
  Object.freeze({
    path: "docs/migrations/2026-08-13_outreach-artifact-failed-expand.sql",
    sha256: "sha256:4d51befaa3ac27824ba15ae503a63051cbcb716d2da6e0fd1c49010b2a846d14",
    writerPause: "not-required",
    writerScopes: Object.freeze([]),
  }),
  Object.freeze({
    path: "docs/migrations/2026-08-12_conversation-reply-single-flight-expand.sql",
    sha256: "sha256:6cbfa5769455220d1b7341bef566cd1258286e8456fde1ad45266a2d8d2be999",
    writerPause: "observed",
    writerScopes: Object.freeze(["worker:gmail-reply-sync"]),
  }),
  Object.freeze({
    path: "docs/migrations/2026-08-12_graph-run-activity-expand.sql",
    sha256: "sha256:8f18edbde210e3520a5bc49d02cd7fb618205edfdf0e0f08f70ee80614530056",
    writerPause: "not-required",
    writerScopes: Object.freeze([]),
  }),
  Object.freeze({
    path: "docs/migrations/2026-08-12_graph-run-lifecycle-expand.sql",
    sha256: "sha256:a502874d67c222332b253859b40699a679daf24c27c9b0bbedbd3c63e8254e2b",
    writerPause: "observed",
    writerScopes: Object.freeze(["api:graph-start", "scheduler:graph-start", "worker:graph-run"]),
  }),
]);

const RECEIPT_KEYS = [
  "schemaVersion", "receiptContractVersion", "environment", "kind",
  "authorizationScope", "attemptId", "candidate", "databaseIdentityHash",
  "redisIdentityHash", "azureIdentityHash", "admissionContextHash",
  "fencingGeneration", "sequence", "previousReceiptSha256", "phase", "status",
  "rollbackPolicy", "clerkInvocation", "phaseContextHash", "issuedAt", "expiresAt",
  "operator", "approver", "changeTicket", "evidence",
];
const CONTEXT_KEYS = [
  "schemaVersion", "environment", "kind", "generatedBy", "receiptKind", "phase",
  "attemptId", "candidate", "databaseIdentityHash", "redisIdentityHash",
  "azureIdentityHash", "admissionContextHash", "fencingGeneration",
  "previousReceiptSha256", "observedAt", "rollbackPolicy", "evidence",
];
const CANDIDATE_KEYS = [
  "backendCommit", "consoleCommit", "apiImage", "workerImage", "consoleImage",
];
const ROLLBACK_POLICY_KEYS = [
  "floor", "legacySourceRestorePermitted", "enumAwareDisabledRestorePermitted",
  "requiredRecoveryAction",
];
const QUIESCENCE_KEYS = [
  "nonComplianceApiMutationsBlocked", "liveSendAllowlistEmpty", "queueObservations",
  "writerFence", "evidenceHash",
];
const QUEUE_OBSERVATION_KEYS = ["observedAt", "stableSince", "evidenceHash", "queues"];
const QUEUES_KEYS = ["agentRuns", "graphRuns", "outreachSend"];
const QUEUE_STATE_KEYS = [
  "paused", "waiting", "active", "delayed", "prioritized", "completed", "failed",
  "waitingChildren", "pausedJobs", "workerCount",
];
const CLOSED_WRITER_FENCE_KEYS = [
  "schemaVersion", "target", "mode", "bootstrapAttemptId", "generation", "issuedAt",
  "observedAt", "expiresAt", "stateHash", "activeWriters", "activeComplianceWriters",
];
const DEPLOYMENTS_KEYS = ["api", "worker", "console"];
const DEPLOYMENT_KEYS = [
  "identity", "active", "soleActiveRevision", "healthy", "provisioned",
];
const DEPLOYMENT_IDENTITY_KEYS = [
  "image", "manifestDigest", "platformDigest", "ociRevision", "platform", "revision",
  "configHash", "templateHash", "secretReferencesHash",
];
const WRITE_GATES_KEYS = ["api", "worker"];
const WRITE_GATE_KEYS = [
  "deliveryUnknownWriteMode", "deliveryUnknownWriteAck", "compatibilityEpoch",
  "failedStatusWritesEnabled", "failedStatusWritesAck",
];
const ROLLBACK_BASELINE_KEYS = [
  "compatibilityAttestation", "compatibilityEpoch", "deliveryUnknownWriteMode",
  "failedStatusWritesEnabled", "api", "worker", "console", "evidenceHash",
];
const ROLLBACK_APP_KEYS = ["identity", "available", "active"];
const RECONCILIATION_PLAN_KEYS = [
  "rawPlanSha256", "dryRunEvidenceSha256", "inventoryEvidenceHash",
  "minimumEventVersion", "expectedActiveOrganizationCount",
  "expectedActiveMembershipCount", "expectedActiveUserCount", "executor",
  "dryRunPassed", "approver", "planSignatureSha256", "signatureNamespace",
  "independentApprovalEvidenceHash", "verifiedAt", "expiresAt",
];
const PHASE_CONTEXT_BUILDER_KEYS = [
  "receiptKind", "identity", "fencingGeneration", "previousReceiptSha256",
  "observedAt", "evidence",
];
const PHASE_CONTEXT_IDENTITY_KEYS = [
  "attemptId", "candidate", "databaseIdentityHash", "redisIdentityHash",
  "azureIdentityHash", "admissionContextHash",
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
    const unknown = actual.filter((key) => !wanted.includes(key));
    const missing = wanted.filter((key) => !actual.includes(key));
    fail(`${label} has unknown or missing fields (unknown: ${unknown.join(",") || "none"}; missing: ${missing.join(",") || "none"})`);
  }
}

function assertString(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) {
    fail(`${label} is invalid`);
  }
}

function assertHash(value, label) {
  assertString(value, SHA256_PATTERN, label);
}

function assertPositive(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail(`${label} must be a positive safe integer`);
  }
}

function assertNonnegative(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(`${label} must be a nonnegative safe integer`);
  }
}

function assertChangeTicket(value, label) {
  if (typeof value !== "string" || [...value].length < 1 || [...value].length > 256) {
    fail(`${label} must contain between 1 and 256 characters`);
  }
}

export function canonicalPhaseJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      fail("canonical JSON only permits safe integers");
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalPhaseJson(entry)).join(",")}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalPhaseJson(value[key])}`
    )).join(",")}}`;
  }
  fail("canonical JSON received an unsupported value");
}

function sameJson(left, right) {
  return canonicalPhaseJson(left) === canonicalPhaseJson(right);
}

export function phaseSha256Bytes(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
}

function sha256Canonical(value) {
  return phaseSha256Bytes(Buffer.from(canonicalPhaseJson(value), "utf8"));
}

function decodeUtf8(bytes, label) {
  try {
    return UTF8_DECODER.decode(bytes);
  } catch {
    fail(`${label} is not valid UTF-8`);
  }
}

/** Strict JSON: duplicate keys, trailing values, fractions, unsafe integers,
 * byte-order marks, invalid UTF-8, and excessive depth are all rejected. */
export function strictPhaseJsonParse(bytes, label = "JSON") {
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
        if (index >= text.length) break;
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
    if (depth > MAX_JSON_DEPTH) fail(`${label} exceeds the maximum nesting depth`);
    whitespace();
    const character = text[index];
    if (character === '"') return parseString();
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
        if (text[index] !== '"') fail(`${label} contains an invalid object key`);
        const key = parseString();
        if (keys.has(key)) fail(`${label} contains duplicate key ${JSON.stringify(key)}`);
        keys.add(key);
        whitespace();
        if (text[index] !== ":") fail(`${label} contains an invalid object separator`);
        index += 1;
        result[key] = parseValue(depth + 1);
        whitespace();
        if (text[index] === "}") {
          index += 1;
          return result;
        }
        if (text[index] !== ",") fail(`${label} contains an invalid object delimiter`);
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
        if (text[index] !== ",") fail(`${label} contains an invalid array delimiter`);
        index += 1;
      }
    }
    for (const [literal, value] of [["true", true], ["false", false], ["null", null]]) {
      if (text.startsWith(literal, index)) {
        index += literal.length;
        return value;
      }
    }
    const numberMatch = text.slice(index).match(/^-?(?:0|[1-9][0-9]*)/);
    if (numberMatch) {
      index += numberMatch[0].length;
      const value = Number(numberMatch[0]);
      if (!Number.isSafeInteger(value) || !Number.isFinite(value) || Object.is(value, -0)) {
        fail(`${label} only permits safe integer numbers`);
      }
      return value;
    }
    fail(`${label} contains an invalid value`);
  }

  if (buffer.length === 0) fail(`${label} is empty`);
  if (text.charCodeAt(0) === 0xfeff) fail(`${label} must not contain a byte-order mark`);
  const value = parseValue(0);
  whitespace();
  if (index !== text.length) fail(`${label} has trailing content`);
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

/** Build the exact controller wrapper around already collected phase evidence.
 * The protected controller remains responsible for collecting and checking
 * the evidence itself; this helper prevents wrapper/key/policy drift. */
export function buildFinalPhaseContext(input) {
  assertExactKeys(input, PHASE_CONTEXT_BUILDER_KEYS, "phase context builder input");
  const spec = SPEC_BY_KIND.get(input.receiptKind);
  if (!spec) fail("phase context builder received an unsupported receipt kind");
  assertExactKeys(input.identity, PHASE_CONTEXT_IDENTITY_KEYS, "phase context identity");
  assertString(input.identity.attemptId, ATTEMPT_PATTERN, "phase context identity.attemptId");
  validateCandidate(input.identity.candidate, "phase context identity.candidate");
  for (const key of [
    "databaseIdentityHash", "redisIdentityHash", "azureIdentityHash", "admissionContextHash",
  ]) assertHash(input.identity[key], `phase context identity.${key}`);
  assertPositive(input.fencingGeneration, "phase context fencingGeneration");
  assertHash(input.previousReceiptSha256, "phase context previousReceiptSha256");
  parseIsoSecond(input.observedAt, "phase context observedAt");
  if (!isPlainObject(input.evidence)) fail("phase context evidence must be an object");
  return {
    schemaVersion: 1,
    environment: "production",
    kind: FINAL_PHASE_CONTEXT_KIND,
    generatedBy: FINAL_PHASE_CONTEXT_GENERATOR,
    receiptKind: spec.kind,
    phase: spec.phase,
    ...structuredClone(input.identity),
    fencingGeneration: input.fencingGeneration,
    previousReceiptSha256: input.previousReceiptSha256,
    observedAt: input.observedAt,
    rollbackPolicy: structuredClone(spec.rollbackPolicy),
    evidence: structuredClone(input.evidence),
  };
}

function validateCandidate(candidate, label) {
  assertExactKeys(candidate, CANDIDATE_KEYS, label);
  assertString(candidate.backendCommit, COMMIT_PATTERN, `${label}.backendCommit`);
  assertString(candidate.consoleCommit, COMMIT_PATTERN, `${label}.consoleCommit`);
  assertString(candidate.apiImage, API_IMAGE_PATTERN, `${label}.apiImage`);
  assertString(candidate.workerImage, API_IMAGE_PATTERN, `${label}.workerImage`);
  assertString(candidate.consoleImage, CONSOLE_IMAGE_PATTERN, `${label}.consoleImage`);
  if (candidate.apiImage !== candidate.workerImage) {
    fail(`${label} API and worker images must be the exact same immutable backend image`);
  }
}

function validateRollbackPolicy(policy, expected, label) {
  assertExactKeys(policy, ROLLBACK_POLICY_KEYS, label);
  if (!sameJson(policy, expected)) fail(`${label} does not match the irreversible phase floor`);
}

function validateQueueState(queue, label, paused) {
  assertExactKeys(queue, QUEUE_STATE_KEYS, label);
  if (queue.paused !== paused) fail(`${label}.paused is invalid`);
  for (const key of [
    "waiting", "active", "delayed", "prioritized", "completed", "failed",
    "waitingChildren", "pausedJobs", "workerCount",
  ]) assertNonnegative(queue[key], `${label}.${key}`);
  if (paused && queue.active !== 0) {
    fail(`${label} is not drained`);
  }
  if (!paused && queue.workerCount < 1) fail(`${label} has no resumed worker`);
}

function validateClosedQuiescence(quiescence, receipt, label) {
  assertExactKeys(quiescence, QUIESCENCE_KEYS, label);
  if (quiescence.nonComplianceApiMutationsBlocked !== true ||
    quiescence.liveSendAllowlistEmpty !== true) {
    fail(`${label} does not preserve blocked non-compliance API mutations and an empty live-send allowlist`);
  }
  if (!Array.isArray(quiescence.queueObservations) || quiescence.queueObservations.length !== 2) {
    fail(`${label}.queueObservations must contain exactly two stable observations`);
  }
  for (let index = 0; index < 2; index += 1) {
    const observation = quiescence.queueObservations[index];
    assertExactKeys(observation, QUEUE_OBSERVATION_KEYS, `${label}.queueObservations[${index}]`);
    parseIsoSecond(observation.observedAt, `${label}.queueObservations[${index}].observedAt`);
    parseIsoSecond(observation.stableSince, `${label}.queueObservations[${index}].stableSince`);
    assertHash(observation.evidenceHash, `${label}.queueObservations[${index}].evidenceHash`);
    assertExactKeys(observation.queues, QUEUES_KEYS, `${label}.queueObservations[${index}].queues`);
    for (const queue of QUEUES_KEYS) {
      validateQueueState(observation.queues[queue],
        `${label}.queueObservations[${index}].queues.${queue}`, true);
      if (observation.queues[queue].workerCount !== 0) {
        fail(`${label}.queueObservations[${index}].queues.${queue} has a connected consumer while CLOSED`);
      }
    }
  }
  if (!sameJson(quiescence.queueObservations[0].queues, quiescence.queueObservations[1].queues)) {
    fail(`${label} queue observations are not stable`);
  }
  const firstObserved = parseIsoSecond(quiescence.queueObservations[0].observedAt,
    `${label}.queueObservations[0].observedAt`);
  const secondObserved = parseIsoSecond(quiescence.queueObservations[1].observedAt,
    `${label}.queueObservations[1].observedAt`);
  const firstStable = parseIsoSecond(quiescence.queueObservations[0].stableSince,
    `${label}.queueObservations[0].stableSince`);
  const secondStable = parseIsoSecond(quiescence.queueObservations[1].stableSince,
    `${label}.queueObservations[1].stableSince`);
  if (firstStable > firstObserved || secondStable > secondObserved || secondObserved - firstObserved < 5_000) {
    fail(`${label} queue stability interval is invalid`);
  }

  const fence = quiescence.writerFence;
  assertExactKeys(fence, CLOSED_WRITER_FENCE_KEYS, `${label}.writerFence`);
  if (fence.schemaVersion !== 1 || fence.target !== "workforce-os-production" ||
    fence.mode !== "closed" || fence.bootstrapAttemptId !== receipt.attemptId ||
    fence.generation !== receipt.fencingGeneration || fence.activeWriters !== 0 ||
    fence.activeComplianceWriters !== 0) {
    fail(`${label}.writerFence is not the exact closed application fence`);
  }
  assertPositive(fence.generation, `${label}.writerFence.generation`);
  assertHash(fence.stateHash, `${label}.writerFence.stateHash`);
  const issued = parseIsoSecond(fence.issuedAt, `${label}.writerFence.issuedAt`);
  const observed = parseIsoSecond(fence.observedAt, `${label}.writerFence.observedAt`);
  const expires = parseIsoSecond(fence.expiresAt, `${label}.writerFence.expiresAt`);
  const receiptIssued = parseIsoSecond(receipt.issuedAt, "receipt.issuedAt");
  const receiptExpires = parseIsoSecond(receipt.expiresAt, "receipt.expiresAt");
  if (issued > observed || secondObserved > observed || observed > receiptIssued ||
    receiptIssued - secondObserved > MAX_PHASE_CONTEXT_AGE_SECONDS * 1000 ||
    expires < receiptExpires || expires <= observed) {
    fail(`${label}.writerFence temporal binding is invalid`);
  }
  assertHash(quiescence.evidenceHash, `${label}.evidenceHash`);
}

function validateDeploymentIdentity(identity, role, candidate, label) {
  assertExactKeys(identity, DEPLOYMENT_IDENTITY_KEYS, label);
  const imagePattern = role === "console" ? CONSOLE_IMAGE_PATTERN : API_IMAGE_PATTERN;
  const revisionPattern = role === "api" ? API_REVISION_PATTERN
    : role === "worker" ? WORKER_REVISION_PATTERN : CONSOLE_REVISION_PATTERN;
  assertString(identity.image, imagePattern, `${label}.image`);
  assertHash(identity.manifestDigest, `${label}.manifestDigest`);
  assertHash(identity.platformDigest, `${label}.platformDigest`);
  assertString(identity.ociRevision, COMMIT_PATTERN, `${label}.ociRevision`);
  assertString(identity.revision, revisionPattern, `${label}.revision`);
  for (const key of ["configHash", "templateHash", "secretReferencesHash"]) {
    assertHash(identity[key], `${label}.${key}`);
  }
  const repository = role === "console" ? "ledgracr.azurecr.io/workforceos-fe" : "ledgracr.azurecr.io/apex-api";
  const expectedImage = role === "console" ? candidate.consoleImage
    : role === "api" ? candidate.apiImage : candidate.workerImage;
  const expectedCommit = role === "console" ? candidate.consoleCommit : candidate.backendCommit;
  if (identity.image !== `${repository}@${identity.manifestDigest}` ||
    identity.image !== expectedImage || identity.ociRevision !== expectedCommit ||
    identity.platform !== "linux/amd64") {
    fail(`${label} does not match the immutable candidate provenance`);
  }
}

function validateDeployments(deployments, candidate, label) {
  assertExactKeys(deployments, DEPLOYMENTS_KEYS, label);
  for (const role of DEPLOYMENTS_KEYS) {
    const deployment = deployments[role];
    assertExactKeys(deployment, DEPLOYMENT_KEYS, `${label}.${role}`);
    validateDeploymentIdentity(deployment.identity, role, candidate, `${label}.${role}.identity`);
    if (deployment.active !== true || deployment.soleActiveRevision !== true ||
      deployment.healthy !== true || deployment.provisioned !== true) {
      fail(`${label}.${role} is not the sole healthy provisioned active candidate revision`);
    }
  }
  for (const key of ["image", "manifestDigest", "platformDigest", "ociRevision"]) {
    if (deployments.api.identity[key] !== deployments.worker.identity[key]) {
      fail(`${label} API and worker identities disagree on ${key}`);
    }
  }
}

function validateWriteGates(gates, active, label) {
  assertExactKeys(gates, WRITE_GATES_KEYS, label);
  for (const role of WRITE_GATES_KEYS) {
    assertExactKeys(gates[role], WRITE_GATE_KEYS, `${label}.${role}`);
  }
  const api = gates.api;
  if (api.deliveryUnknownWriteMode !== "disabled" || api.deliveryUnknownWriteAck !== null ||
    api.compatibilityEpoch !== "outreach-delivery-unknown-v1" ||
    api.failedStatusWritesEnabled !== false || api.failedStatusWritesAck !== null) {
    fail(`${label}.api must remain the enum-aware disabled reader baseline`);
  }
  const worker = gates.worker;
  if (!active) {
    if (!sameJson(worker, api)) fail(`${label}.worker is not the disabled compatibility gate`);
  } else if (worker.deliveryUnknownWriteMode !== "first-class" ||
    worker.deliveryUnknownWriteAck !== "readers-drained-rollback-baselines-verified-v1" ||
    worker.compatibilityEpoch !== "outreach-delivery-unknown-v1" ||
    worker.failedStatusWritesEnabled !== true ||
    worker.failedStatusWritesAck !== "readers-drained-legacy-inventory-reviewed-v1") {
    fail(`${label}.worker does not carry both exact first-class write acknowledgements`);
  }
}

function validateRollbackBaseline(baseline, candidate, expectedDeployments, label) {
  assertExactKeys(baseline, ROLLBACK_BASELINE_KEYS, label);
  if (baseline.compatibilityAttestation !== "enum-aware-api-worker-console-baseline-v1" ||
    baseline.compatibilityEpoch !== "outreach-delivery-unknown-v1" ||
    baseline.deliveryUnknownWriteMode !== "disabled" ||
    baseline.failedStatusWritesEnabled !== false) {
    fail(`${label} is not the exact enum-aware disabled rollback contract`);
  }
  for (const role of DEPLOYMENTS_KEYS) {
    const app = baseline[role];
    assertExactKeys(app, ROLLBACK_APP_KEYS, `${label}.${role}`);
    validateDeploymentIdentity(app.identity, role, candidate, `${label}.${role}.identity`);
    if (app.available !== true || app.active !== (role !== "worker")) {
      fail(`${label}.${role} availability/activation state is invalid`);
    }
    if (!sameJson(app.identity, expectedDeployments[role].identity)) {
      fail(`${label}.${role} drifted from the signed disabled baseline`);
    }
  }
  assertHash(baseline.evidenceHash, `${label}.evidenceHash`);
}

function validateMigrationExecution(execution, label) {
  if (!Array.isArray(execution) || execution.length !== PHASE_MIGRATIONS.length) {
    fail(`${label} must contain exactly eight ordered migrations`);
  }
  execution.forEach((migration, index) => {
    const itemLabel = `${label}[${index}]`;
    assertExactKeys(migration, [
      "path", "sha256", "preflightPassed", "invocationVerified", "applied",
      "postconditionsPassed", "writerPause", "writerScopes", "duplicateInventoryHash",
      "postconditionEvidenceHash",
    ], itemLabel);
    const expected = PHASE_MIGRATIONS[index];
    if (migration.path !== expected.path || migration.sha256 !== expected.sha256 ||
      migration.preflightPassed !== true || migration.invocationVerified !== true ||
      migration.applied !== true || migration.postconditionsPassed !== true ||
      migration.writerPause !== expected.writerPause ||
      !sameJson(migration.writerScopes, expected.writerScopes)) {
      fail(`${itemLabel} does not match the exact reviewed migration result`);
    }
    assertHash(migration.duplicateInventoryHash, `${itemLabel}.duplicateInventoryHash`);
    assertHash(migration.postconditionEvidenceHash, `${itemLabel}.postconditionEvidenceHash`);
  });
}

function validateClerkCutover(cutover, label) {
  assertExactKeys(cutover, [
    "schemaReady", "rowCount", "ready", "minimumEventVersion", "inventoryEvidenceHash",
    "expectedActiveOrganizationCount", "expectedActiveMembershipCount",
    "expectedActiveUserCount", "activeOrganizationCount", "activeMembershipCount",
    "activeUserCount", "projectionMismatchRows", "orphanActiveAuthorityRows",
    "readinessViolationRows", "invariantEvidenceHash",
  ], label);
  if (cutover.schemaReady !== true || cutover.rowCount !== 1 || cutover.ready !== true) {
    fail(`${label} is not the one armed Clerk identity cutover`);
  }
  assertPositive(cutover.minimumEventVersion, `${label}.minimumEventVersion`);
  assertHash(cutover.inventoryEvidenceHash, `${label}.inventoryEvidenceHash`);
  for (const key of [
    "expectedActiveOrganizationCount", "expectedActiveMembershipCount", "expectedActiveUserCount",
    "activeOrganizationCount", "activeMembershipCount", "activeUserCount",
  ]) assertNonnegative(cutover[key], `${label}.${key}`);
  if (cutover.expectedActiveOrganizationCount !== cutover.activeOrganizationCount ||
    cutover.expectedActiveMembershipCount !== cutover.activeMembershipCount ||
    cutover.expectedActiveUserCount !== cutover.activeUserCount ||
    cutover.projectionMismatchRows !== 0 || cutover.orphanActiveAuthorityRows !== 0 ||
    cutover.readinessViolationRows !== 0) {
    fail(`${label} inventory projection or readiness invariant failed`);
  }
  assertHash(cutover.invariantEvidenceHash, `${label}.invariantEvidenceHash`);
}

function validateReconciliationPlanBinding(plan, receipt, label) {
  assertExactKeys(plan, RECONCILIATION_PLAN_KEYS, label);
  for (const key of [
    "rawPlanSha256", "dryRunEvidenceSha256", "inventoryEvidenceHash",
    "planSignatureSha256", "independentApprovalEvidenceHash",
  ]) assertHash(plan[key], `${label}.${key}`);
  assertPositive(plan.minimumEventVersion, `${label}.minimumEventVersion`);
  for (const key of [
    "expectedActiveOrganizationCount", "expectedActiveMembershipCount", "expectedActiveUserCount",
  ]) assertNonnegative(plan[key], `${label}.${key}`);
  assertExactKeys(plan.executor, ["name", "version", "sha256"], `${label}.executor`);
  if (plan.executor.name !== "workforce-production-clerk-reconciliation-executor" ||
    plan.executor.version !== "v1" || plan.dryRunPassed !== true ||
    plan.approver !== receipt.approver ||
    plan.signatureNamespace !== "workforce-os-clerk-reconciliation-plan") {
    fail(`${label} is not the admitted independently signed dry-run plan`);
  }
  assertHash(plan.executor.sha256, `${label}.executor.sha256`);
  assertString(plan.approver, PRINCIPAL_PATTERN, `${label}.approver`);
  const verifiedAt = parseIsoSecond(plan.verifiedAt, `${label}.verifiedAt`);
  const expiresAt = parseIsoSecond(plan.expiresAt, `${label}.expiresAt`);
  const receiptIssued = parseIsoSecond(receipt.issuedAt, `${receipt.kind}.issuedAt`);
  if (expiresAt <= verifiedAt || expiresAt - verifiedAt > 86_400_000 ||
    verifiedAt > receiptIssued || receiptIssued >= expiresAt ||
    plan.minimumEventVersion > verifiedAt || verifiedAt - plan.minimumEventVersion > 86_400_000) {
    fail(`${label} is stale, future-dated, expired, or cutoff-inconsistent`);
  }
}

function validateSchemaInventory(inventory, label) {
  assertExactKeys(inventory, [
    "outreachIdempotencyDuplicateGroups", "legacyGmailReplySequenceStopRows",
    "managerRoleRows", "graphRunRunningRows", "graphRunAwaitingApprovalRows",
    "graphActiveOrgDuplicateGroups", "graphActiveWithoutRecoveryStateRows",
    "graphLifecycleSchemaReady", "replySchemaReady", "replySourceDuplicateGroups",
    "replyConversationDuplicateGroups", "nullSourceReplyRows", "replySlotDuplicateRows",
    "duplicateInventoryEvidenceHash",
  ], label);
  for (const key of [
    "outreachIdempotencyDuplicateGroups", "graphRunRunningRows",
    "graphActiveOrgDuplicateGroups", "graphActiveWithoutRecoveryStateRows",
    "replySourceDuplicateGroups", "replyConversationDuplicateGroups", "nullSourceReplyRows",
    "replySlotDuplicateRows",
  ]) {
    if (inventory[key] !== 0) fail(`${label}.${key} must be zero`);
  }
  for (const key of ["legacyGmailReplySequenceStopRows", "managerRoleRows", "graphRunAwaitingApprovalRows"]) {
    assertNonnegative(inventory[key], `${label}.${key}`);
  }
  if (inventory.graphLifecycleSchemaReady !== true || inventory.replySchemaReady !== true) {
    fail(`${label} does not prove the Graph and reply schemas ready`);
  }
  assertHash(inventory.duplicateInventoryEvidenceHash, `${label}.duplicateInventoryEvidenceHash`);
}

function validateSchemaDeliveryState(state, label) {
  assertExactKeys(state, [
    "deliveryUnknownEnumReady", "failedEnumReady", "deliveryUnknownWriteMode",
    "deliveryUnknownWriteAck", "failedStatusWritesEnabled", "failedStatusWritesAck",
    "sendingRows", "firstClassDeliveryUnknownRows", "firstClassFailedRows",
    "legacyDeliveryUnknownMarkerRows", "legacyAutoFailedMarkerRows",
    "legacyMarkerInventoryEvidenceHash",
  ], label);
  if (state.deliveryUnknownEnumReady !== true || state.failedEnumReady !== true ||
    state.deliveryUnknownWriteMode !== "disabled" || state.deliveryUnknownWriteAck !== null ||
    state.failedStatusWritesEnabled !== false || state.failedStatusWritesAck !== null ||
    state.sendingRows !== 0 || state.firstClassDeliveryUnknownRows !== 0 ||
    state.firstClassFailedRows !== 0) {
    fail(`${label} is not schema-ready with both new write gates disabled and zero first-class rows`);
  }
  assertNonnegative(state.legacyDeliveryUnknownMarkerRows, `${label}.legacyDeliveryUnknownMarkerRows`);
  assertNonnegative(state.legacyAutoFailedMarkerRows, `${label}.legacyAutoFailedMarkerRows`);
  assertHash(state.legacyMarkerInventoryEvidenceHash, `${label}.legacyMarkerInventoryEvidenceHash`);
}

function validateB4(evidence, receipt, previousReceipt) {
  const label = "production-schema-result.evidence";
  assertExactKeys(evidence, [
    "targetRevisions", "migrationExecution", "clerkReconciliationPlan", "clerkCutover", "schemaInventory",
    "deliveryState", "quiescence", "stagingRehearsalEvidenceHash",
    "productionApplyEvidenceHash", "backupRestoreEvidenceHash", "schemaEvidenceHash",
  ], label);
  assertExactKeys(evidence.targetRevisions, DEPLOYMENTS_KEYS, `${label}.targetRevisions`);
  assertString(evidence.targetRevisions.api, API_REVISION_PATTERN, `${label}.targetRevisions.api`);
  assertString(evidence.targetRevisions.worker, WORKER_REVISION_PATTERN, `${label}.targetRevisions.worker`);
  assertString(evidence.targetRevisions.console, CONSOLE_REVISION_PATTERN, `${label}.targetRevisions.console`);
  if (!previousReceipt?.targetArtifacts ||
    evidence.targetRevisions.api !== previousReceipt.targetArtifacts.api.plannedRevision ||
    evidence.targetRevisions.worker !== previousReceipt.targetArtifacts.worker.plannedRevision ||
    evidence.targetRevisions.console !== previousReceipt.targetArtifacts.console.plannedRevision) {
    fail(`${label}.targetRevisions drifted from the signed entry target artifacts`);
  }
  validateMigrationExecution(evidence.migrationExecution, `${label}.migrationExecution`);
  if (!previousReceipt?.clerkReconciliationPlan ||
    !sameJson(evidence.clerkReconciliationPlan, previousReceipt.clerkReconciliationPlan)) {
    fail(`${label}.clerkReconciliationPlan drifted from the signed entry plan`);
  }
  validateReconciliationPlanBinding(evidence.clerkReconciliationPlan, receipt,
    `${label}.clerkReconciliationPlan`);
  validateClerkCutover(evidence.clerkCutover, `${label}.clerkCutover`);
  const plan = evidence.clerkReconciliationPlan;
  if (evidence.clerkCutover.minimumEventVersion !== plan.minimumEventVersion ||
    evidence.clerkCutover.inventoryEvidenceHash !== plan.inventoryEvidenceHash ||
    evidence.clerkCutover.expectedActiveOrganizationCount !== plan.expectedActiveOrganizationCount ||
    evidence.clerkCutover.expectedActiveMembershipCount !== plan.expectedActiveMembershipCount ||
    evidence.clerkCutover.expectedActiveUserCount !== plan.expectedActiveUserCount) {
    fail(`${label}.clerkCutover does not match the admitted plan cutoff, inventory, and counts`);
  }
  validateSchemaInventory(evidence.schemaInventory, `${label}.schemaInventory`);
  validateSchemaDeliveryState(evidence.deliveryState, `${label}.deliveryState`);
  validateClosedQuiescence(evidence.quiescence, receipt, `${label}.quiescence`);
  for (const key of [
    "stagingRehearsalEvidenceHash", "productionApplyEvidenceHash", "backupRestoreEvidenceHash",
    "schemaEvidenceHash",
  ]) assertHash(evidence[key], `${label}.${key}`);
}

function validateLegacyDrain(drain, label) {
  assertExactKeys(drain, [
    "allLegacyRevisionsInactive", "apiActiveLegacyRevisionCount",
    "workerActiveLegacyRevisionCount", "consoleActiveLegacyRevisionCount", "evidenceHash",
  ], label);
  if (drain.allLegacyRevisionsInactive !== true || drain.apiActiveLegacyRevisionCount !== 0 ||
    drain.workerActiveLegacyRevisionCount !== 0 || drain.consoleActiveLegacyRevisionCount !== 0) {
    fail(`${label} does not prove every legacy revision inactive`);
  }
  assertHash(drain.evidenceHash, `${label}.evidenceHash`);
}

function validateB5(evidence, receipt, previousReceipt) {
  const label = "enum-aware-disabled-baseline.evidence";
  assertExactKeys(evidence, [
    "deployments", "writeGates", "legacyRevisions", "quiescence",
    "compatibilityAttestation", "baselineEvidenceHash",
  ], label);
  validateDeployments(evidence.deployments, receipt.candidate, `${label}.deployments`);
  const targets = previousReceipt?.evidence?.targetRevisions;
  if (!targets || evidence.deployments.api.identity.revision !== targets.api ||
    evidence.deployments.worker.identity.revision !== targets.worker ||
    evidence.deployments.console.identity.revision !== targets.console) {
    fail(`${label}.deployments do not match the schema-result target revisions`);
  }
  validateWriteGates(evidence.writeGates, false, `${label}.writeGates`);
  validateLegacyDrain(evidence.legacyRevisions, `${label}.legacyRevisions`);
  validateClosedQuiescence(evidence.quiescence, receipt, `${label}.quiescence`);
  if (evidence.compatibilityAttestation !== "enum-aware-api-worker-console-baseline-v1") {
    fail(`${label}.compatibilityAttestation is invalid`);
  }
  assertHash(evidence.baselineEvidenceHash, `${label}.baselineEvidenceHash`);
}

function validateReaderDrain(drain, label) {
  assertExactKeys(drain, [
    "legacyApiReadersActive", "legacyWorkerWritersActive", "legacyConsoleReadersActive",
    "evidenceHash",
  ], label);
  if (drain.legacyApiReadersActive !== 0 || drain.legacyWorkerWritersActive !== 0 ||
    drain.legacyConsoleReadersActive !== 0) {
    fail(`${label} does not prove legacy readers and writers drained`);
  }
  assertHash(drain.evidenceHash, `${label}.evidenceHash`);
}

function validateB6(evidence, receipt, previousReceipt) {
  const label = "first-class-activation.evidence";
  assertExactKeys(evidence, [
    "deployments", "writeGates", "rollbackBaseline", "readerDrain",
    "deliveryUnknownActivation", "failedActivation", "quiescence", "activationEvidenceHash",
  ], label);
  validateDeployments(evidence.deployments, receipt.candidate, `${label}.deployments`);
  const disabled = previousReceipt?.evidence?.deployments;
  if (!disabled || !sameJson(evidence.deployments.api, disabled.api) ||
    !sameJson(evidence.deployments.console, disabled.console) ||
    evidence.deployments.worker.identity.revision === disabled.worker.identity.revision ||
    evidence.deployments.worker.identity.image !== disabled.worker.identity.image ||
    evidence.deployments.worker.identity.ociRevision !== disabled.worker.identity.ociRevision) {
    fail(`${label}.deployments do not preserve readers or create a distinct first-class worker revision`);
  }
  validateWriteGates(evidence.writeGates, true, `${label}.writeGates`);
  validateRollbackBaseline(evidence.rollbackBaseline, receipt.candidate, disabled,
    `${label}.rollbackBaseline`);
  validateReaderDrain(evidence.readerDrain, `${label}.readerDrain`);
  assertExactKeys(evidence.deliveryUnknownActivation, [
    "readersDrained", "rollbackBaselinesVerified", "firstClassDeliveryUnknownRows", "evidenceHash",
  ], `${label}.deliveryUnknownActivation`);
  if (evidence.deliveryUnknownActivation.readersDrained !== true ||
    evidence.deliveryUnknownActivation.rollbackBaselinesVerified !== true ||
    evidence.deliveryUnknownActivation.firstClassDeliveryUnknownRows !== 0) {
    fail(`${label}.deliveryUnknownActivation is not safe to resume`);
  }
  assertHash(evidence.deliveryUnknownActivation.evidenceHash,
    `${label}.deliveryUnknownActivation.evidenceHash`);
  assertExactKeys(evidence.failedActivation, [
    "readersDrained", "legacyInventoryReviewed", "unreviewedHistoricalMarkersPromotedRows",
    "firstClassFailedRows", "legacyInventoryEvidenceHash", "evidenceHash",
  ], `${label}.failedActivation`);
  if (evidence.failedActivation.readersDrained !== true ||
    evidence.failedActivation.legacyInventoryReviewed !== true ||
    evidence.failedActivation.unreviewedHistoricalMarkersPromotedRows !== 0 ||
    evidence.failedActivation.firstClassFailedRows !== 0) {
    fail(`${label}.failedActivation is not safe to resume`);
  }
  assertHash(evidence.failedActivation.legacyInventoryEvidenceHash,
    `${label}.failedActivation.legacyInventoryEvidenceHash`);
  assertHash(evidence.failedActivation.evidenceHash, `${label}.failedActivation.evidenceHash`);
  validateClosedQuiescence(evidence.quiescence, receipt, `${label}.quiescence`);
  assertHash(evidence.activationEvidenceHash, `${label}.activationEvidenceHash`);
}

function validateB8(evidence, receipt, previousReceipt) {
  const label = "bootstrap-complete.evidence";
  assertExactKeys(evidence, [
    "deployments", "writeGates", "rollbackBaseline", "resume", "health",
    "finalInventory", "bootstrapEvidenceHash",
  ], label);
  validateDeployments(evidence.deployments, receipt.candidate, `${label}.deployments`);
  const armed = previousReceipt?.evidence;
  if (!armed || !sameJson(evidence.deployments, armed.deployments) ||
    !sameJson(evidence.writeGates, armed.writeGates) ||
    !sameJson(evidence.rollbackBaseline, armed.rollbackBaseline)) {
    fail(`${label} drifted from the signed first-class activation state`);
  }
  validateWriteGates(evidence.writeGates, true, `${label}.writeGates`);
  validateRollbackBaseline(evidence.rollbackBaseline, receipt.candidate,
    {
      api: { identity: evidence.rollbackBaseline.api.identity },
      worker: { identity: evidence.rollbackBaseline.worker.identity },
      console: { identity: evidence.rollbackBaseline.console.identity },
    }, `${label}.rollbackBaseline`);

  const resume = evidence.resume;
  assertExactKeys(resume, [
    "terminalOpenIntent", "steps", "pausedConsumerProof", "queues",
    "writerFenceRelease", "apiMutations", "ambiguityControl",
    "liveSendAllowlistEmpty", "evidenceHash",
  ], `${label}.resume`);
  if (!Array.isArray(resume.steps) || resume.steps.length !== 6) {
    fail(`${label}.resume.steps must contain the exact six-step terminal-OPEN resume order`);
  }
  const actions = [
    "release-writer-fence", "start-first-class-consumers", "resume-agent-runs",
    "resume-graph-runs", "resume-outreach-send", "unblock-api-mutations",
  ];
  let priorCompleted = null;
  resume.steps.forEach((step, index) => {
    const stepLabel = `${label}.resume.steps[${index}]`;
    assertExactKeys(step, ["sequence", "action", "startedAt", "completedAt", "evidenceHash"], stepLabel);
    if (step.sequence !== index + 1 || step.action !== actions[index]) {
      fail(`${stepLabel} is outside the exact resume order`);
    }
    const started = parseIsoSecond(step.startedAt, `${stepLabel}.startedAt`);
    const completed = parseIsoSecond(step.completedAt, `${stepLabel}.completedAt`);
    if (completed < started || (priorCompleted !== null && started < priorCompleted)) {
      fail(`${stepLabel} is temporally out of order`);
    }
    priorCompleted = completed;
    assertHash(step.evidenceHash, `${stepLabel}.evidenceHash`);
  });
  const receiptIssued = parseIsoSecond(receipt.issuedAt, `${label} receipt.issuedAt`);
  const previousIssued = parseIsoSecond(previousReceipt.issuedAt,
    `${label} previous receipt.issuedAt`);
  const firstStarted = parseIsoSecond(resume.steps[0].startedAt,
    `${label}.resume.steps[0].startedAt`);
  if (firstStarted < previousIssued || priorCompleted > receiptIssued) {
    fail(`${label}.resume did not occur after activation and before receipt issuance`);
  }
  assertExactKeys(resume.queues, QUEUES_KEYS, `${label}.resume.queues`);
  for (const queue of QUEUES_KEYS) {
    validateQueueState(resume.queues[queue], `${label}.resume.queues.${queue}`, false);
  }
  assertExactKeys(resume.terminalOpenIntent, [
    "bootstrapAttemptId", "generation", "previousStateHash", "persistedAt",
    "forwardOnly", "evidenceHash",
  ], `${label}.resume.terminalOpenIntent`);
  assertPositive(resume.terminalOpenIntent.generation,
    `${label}.resume.terminalOpenIntent.generation`);
  if (resume.terminalOpenIntent.bootstrapAttemptId !== receipt.attemptId ||
    resume.terminalOpenIntent.generation > receipt.fencingGeneration ||
    resume.terminalOpenIntent.forwardOnly !== true ||
    parseIsoSecond(resume.terminalOpenIntent.persistedAt,
      `${label}.resume.terminalOpenIntent.persistedAt`) > firstStarted) {
    fail(`${label}.resume terminal-OPEN intent was not durably ordered before release`);
  }
  assertHash(resume.terminalOpenIntent.previousStateHash,
    `${label}.resume.terminalOpenIntent.previousStateHash`);
  assertHash(resume.terminalOpenIntent.evidenceHash,
    `${label}.resume.terminalOpenIntent.evidenceHash`);
  assertExactKeys(resume.pausedConsumerProof, [
    "queues", "provedAt", "evidenceHash",
  ], `${label}.resume.pausedConsumerProof`);
  assertExactKeys(resume.pausedConsumerProof.queues, QUEUES_KEYS,
    `${label}.resume.pausedConsumerProof.queues`);
  for (const queue of QUEUES_KEYS) {
    validateQueueState(resume.pausedConsumerProof.queues[queue],
      `${label}.resume.pausedConsumerProof.queues.${queue}`, true);
    if (resume.pausedConsumerProof.queues[queue].workerCount < 1) {
      fail(`${label}.resume paused consumer proof has no ${queue} worker`);
    }
  }
  if (resume.pausedConsumerProof.provedAt !== resume.steps[1].completedAt) {
    fail(`${label}.resume consumer proof is not ordered before queue resume`);
  }
  assertHash(resume.pausedConsumerProof.evidenceHash,
    `${label}.resume.pausedConsumerProof.evidenceHash`);
  assertExactKeys(resume.writerFenceRelease, [
    "bootstrapAttemptId", "generation", "previousStateHash", "openEpoch",
    "openStateHash", "releasedAt", "terminalOpen", "evidenceHash",
  ], `${label}.resume.writerFenceRelease`);
  if (resume.writerFenceRelease.bootstrapAttemptId !== receipt.attemptId ||
    resume.writerFenceRelease.generation !== resume.terminalOpenIntent.generation ||
    resume.writerFenceRelease.terminalOpen !== true ||
    resume.writerFenceRelease.releasedAt !== resume.steps[0].completedAt) {
    fail(`${label}.resume.writerFenceRelease is not exact or ordered`);
  }
  assertExactKeys(resume.writerFenceRelease.openEpoch, [
    "schemaVersion", "target", "mode", "bootstrapAttemptId", "generation",
  ], `${label}.resume.writerFenceRelease.openEpoch`);
  if (resume.writerFenceRelease.openEpoch.schemaVersion !== 1 ||
    resume.writerFenceRelease.openEpoch.target !== "workforce-os-production" ||
    resume.writerFenceRelease.openEpoch.mode !== "open" ||
    resume.writerFenceRelease.openEpoch.bootstrapAttemptId !== receipt.attemptId ||
    resume.writerFenceRelease.openEpoch.generation !== resume.terminalOpenIntent.generation ||
    resume.writerFenceRelease.previousStateHash !== resume.terminalOpenIntent.previousStateHash) {
    fail(`${label}.resume.writerFenceRelease does not prove the exact terminal OPEN epoch`);
  }
  assertHash(resume.writerFenceRelease.previousStateHash,
    `${label}.resume.writerFenceRelease.previousStateHash`);
  assertHash(resume.writerFenceRelease.openStateHash,
    `${label}.resume.writerFenceRelease.openStateHash`);
  assertHash(resume.writerFenceRelease.evidenceHash,
    `${label}.resume.writerFenceRelease.evidenceHash`);
  assertExactKeys(resume.apiMutations, [
    "blocked", "ingressEnabled", "readinessPassed", "restoredAt", "evidenceHash",
  ], `${label}.resume.apiMutations`);
  if (resume.apiMutations.blocked !== false || resume.apiMutations.ingressEnabled !== true ||
    resume.apiMutations.readinessPassed !== true ||
    resume.apiMutations.restoredAt !== resume.steps[5].completedAt ||
    resume.liveSendAllowlistEmpty !== true) {
    fail(`${label}.resume did not restore API mutations last with the allowlist empty`);
  }
  assertHash(resume.apiMutations.evidenceHash, `${label}.resume.apiMutations.evidenceHash`);
  assertExactKeys(resume.ambiguityControl, [
    "policy", "containmentReady", "ambiguousPartialResumeDetected",
    "allQueuesRePauseRequired", "apiAndWorkerDeactivateRequired",
    "stableZeroReplicasRequired", "terminalOpenRecloseForbidden",
    "holdForwardOnlyRequired", "evidenceHash",
  ], `${label}.resume.ambiguityControl`);
  if (resume.ambiguityControl.policy !==
      "repause-deactivate-stable-zero-and-hold-terminal-open-forward-only-v1" ||
    resume.ambiguityControl.containmentReady !== true ||
    resume.ambiguityControl.ambiguousPartialResumeDetected !== false ||
    resume.ambiguityControl.allQueuesRePauseRequired !== true ||
    resume.ambiguityControl.apiAndWorkerDeactivateRequired !== true ||
    resume.ambiguityControl.stableZeroReplicasRequired !== true ||
    resume.ambiguityControl.terminalOpenRecloseForbidden !== true ||
    resume.ambiguityControl.holdForwardOnlyRequired !== true) {
    fail(`${label}.resume ambiguity compensation is not armed fail-closed`);
  }
  assertHash(resume.ambiguityControl.evidenceHash,
    `${label}.resume.ambiguityControl.evidenceHash`);
  assertHash(resume.evidenceHash, `${label}.resume.evidenceHash`);

  assertExactKeys(evidence.health, [
    "apiReady", "workerReady", "consoleReady", "releaseConfigVerified",
    "failedListSmokePassed", "dashboardPolicySmokePassed",
    "releaseConfigEvidenceHash", "failedListSmokeEvidenceHash",
    "dashboardPolicySmokeEvidenceHash", "evidenceHash",
  ], `${label}.health`);
  for (const key of [
    "apiReady", "workerReady", "consoleReady", "releaseConfigVerified",
    "failedListSmokePassed", "dashboardPolicySmokePassed",
  ]) if (evidence.health[key] !== true) fail(`${label}.health.${key} must be true`);
  for (const key of [
    "releaseConfigEvidenceHash", "failedListSmokeEvidenceHash",
    "dashboardPolicySmokeEvidenceHash",
  ]) assertHash(evidence.health[key], `${label}.health.${key}`);
  assertHash(evidence.health.evidenceHash, `${label}.health.evidenceHash`);
  assertExactKeys(evidence.finalInventory, [
    "sendingRows", "firstClassDeliveryUnknownRows", "firstClassFailedRows",
    "unreviewedHistoricalMarkersPromotedRows", "evidenceHash",
  ], `${label}.finalInventory`);
  for (const key of [
    "sendingRows", "firstClassDeliveryUnknownRows", "firstClassFailedRows",
    "unreviewedHistoricalMarkersPromotedRows",
  ]) if (evidence.finalInventory[key] !== 0) fail(`${label}.finalInventory.${key} must be zero`);
  assertHash(evidence.finalInventory.evidenceHash, `${label}.finalInventory.evidenceHash`);
  assertHash(evidence.bootstrapEvidenceHash, `${label}.bootstrapEvidenceHash`);
}

function derivePreviousIdentity(previousReceipt, spec) {
  if (!isPlainObject(previousReceipt) || previousReceipt.kind !== spec.previousKind) {
    fail(`${spec.kind} previous receipt is not ${spec.previousKind}`);
  }
  if (spec.previousKind === "initial-bootstrap-entry") {
    if (previousReceipt.schemaVersion !== 2 ||
      previousReceipt.authorizationScope !== "bootstrap-entry-admission-only" ||
      previousReceipt.status !== "prepared-and-quiesced") {
      fail("production-schema-result predecessor is not the final entry-v2 contract");
    }
    return {
      attemptId: previousReceipt.bootstrapAttemptId,
      candidate: {
        backendCommit: previousReceipt.backendCandidateCommit,
        consoleCommit: previousReceipt.consoleCandidateCommit,
        apiImage: previousReceipt.targetArtifacts?.api?.image,
        workerImage: previousReceipt.targetArtifacts?.worker?.image,
        consoleImage: previousReceipt.targetArtifacts?.console?.image,
      },
      databaseIdentityHash: previousReceipt.databaseIdentityHash,
      redisIdentityHash: previousReceipt.redisIdentityHash,
      azureIdentityHash: sha256Canonical(previousReceipt.authority),
      admissionContextHash: previousReceipt.admissionContextHash,
      fencingGeneration: previousReceipt.lease?.generation,
      operator: previousReceipt.operator,
      approver: previousReceipt.approver,
      changeTicket: previousReceipt.changeTicket,
    };
  }
  if (previousReceipt.schemaVersion !== 1 ||
    previousReceipt.receiptContractVersion !== FINAL_PHASE_RECEIPT_CONTRACT_VERSION) {
    fail(`${spec.kind} predecessor is not a final phase receipt`);
  }
  return {
    attemptId: previousReceipt.attemptId,
    candidate: previousReceipt.candidate,
    databaseIdentityHash: previousReceipt.databaseIdentityHash,
    redisIdentityHash: previousReceipt.redisIdentityHash,
    azureIdentityHash: previousReceipt.azureIdentityHash,
    admissionContextHash: previousReceipt.admissionContextHash,
    fencingGeneration: previousReceipt.fencingGeneration,
    operator: previousReceipt.operator,
    approver: previousReceipt.approver,
    changeTicket: previousReceipt.changeTicket,
  };
}

/**
 * Validate a parsed final receipt. `previousReceiptBytes` or both
 * `previousReceipt` and `previousReceiptSha256` are mandatory. The phase
 * ledger may omit phaseContext bytes because it preserves the signed receipt;
 * the detached verifier must supply them.
 */
export function validateFinalPhaseReceiptObject(receipt, options) {
  const spec = options.expectedKind ? SPEC_BY_KIND.get(options.expectedKind) : SPEC_BY_KIND.get(receipt?.kind);
  if (!spec) fail("unsupported production bootstrap phase receipt kind");
  assertExactKeys(receipt, RECEIPT_KEYS, `${spec.kind} receipt`);
  if (receipt.schemaVersion !== 1 ||
    receipt.receiptContractVersion !== FINAL_PHASE_RECEIPT_CONTRACT_VERSION ||
    receipt.environment !== "production" || receipt.kind !== spec.kind ||
    receipt.authorizationScope !== spec.authorizationScope ||
    receipt.sequence !== spec.sequence || receipt.phase !== spec.phase ||
    receipt.status !== spec.status || receipt.clerkInvocation !== "verified") {
    fail(`${spec.kind} receipt contract identity is invalid`);
  }
  assertString(receipt.attemptId, ATTEMPT_PATTERN, `${spec.kind}.attemptId`);
  validateCandidate(receipt.candidate, `${spec.kind}.candidate`);
  for (const key of [
    "databaseIdentityHash", "redisIdentityHash", "azureIdentityHash", "admissionContextHash",
    "previousReceiptSha256", "phaseContextHash",
  ]) assertHash(receipt[key], `${spec.kind}.${key}`);
  assertPositive(receipt.fencingGeneration, `${spec.kind}.fencingGeneration`);
  assertString(receipt.operator, PRINCIPAL_PATTERN, `${spec.kind}.operator`);
  assertString(receipt.approver, PRINCIPAL_PATTERN, `${spec.kind}.approver`);
  if (receipt.operator === receipt.approver) fail(`${spec.kind} operator and approver must differ`);
  assertChangeTicket(receipt.changeTicket, `${spec.kind}.changeTicket`);
  validateRollbackPolicy(receipt.rollbackPolicy, spec.rollbackPolicy, `${spec.kind}.rollbackPolicy`);

  let previousReceipt = options.previousReceipt;
  let previousReceiptSha256 = options.previousReceiptSha256;
  if (options.previousReceiptBytes) {
    const bytes = Buffer.isBuffer(options.previousReceiptBytes)
      ? options.previousReceiptBytes : Buffer.from(options.previousReceiptBytes);
    if (bytes.length === 0 || bytes.length > MAX_PHASE_RECEIPT_BYTES) {
      fail("previous receipt size is outside the permitted range");
    }
    previousReceipt = strictPhaseJsonParse(bytes, `${spec.kind} previous receipt`);
    previousReceiptSha256 = phaseSha256Bytes(bytes);
  }
  assertHash(previousReceiptSha256, `${spec.kind} expected previous receipt digest`);
  if (receipt.previousReceiptSha256 !== previousReceiptSha256) {
    fail(`${spec.kind} previous-receipt exact-byte hash chain is invalid`);
  }
  const previousIdentity = derivePreviousIdentity(previousReceipt, spec);
  if (receipt.attemptId !== previousIdentity.attemptId ||
    !sameJson(receipt.candidate, previousIdentity.candidate) ||
    receipt.databaseIdentityHash !== previousIdentity.databaseIdentityHash ||
    receipt.redisIdentityHash !== previousIdentity.redisIdentityHash ||
    receipt.azureIdentityHash !== previousIdentity.azureIdentityHash ||
    receipt.admissionContextHash !== previousIdentity.admissionContextHash ||
    receipt.operator !== previousIdentity.operator || receipt.approver !== previousIdentity.approver ||
    receipt.changeTicket !== previousIdentity.changeTicket) {
    fail(`${spec.kind} identity or governance drifted from its signed predecessor`);
  }
  if (receipt.fencingGeneration <= previousIdentity.fencingGeneration) {
    fail(`${spec.kind} fencing generation did not advance monotonically`);
  }
  if (options.identity) {
    const identity = options.identity;
    if (receipt.attemptId !== identity.attemptId || !sameJson(receipt.candidate, identity.candidate) ||
      receipt.databaseIdentityHash !== identity.databaseIdentityHash ||
      receipt.redisIdentityHash !== identity.redisIdentityHash ||
      receipt.azureIdentityHash !== identity.azureIdentityHash ||
      receipt.admissionContextHash !== identity.admissionContextHash) {
      fail(`${spec.kind} identity drifted from the phase ledger`);
    }
  }
  if (options.governance && (receipt.operator !== options.governance.operator ||
    receipt.approver !== options.governance.approver ||
    receipt.changeTicket !== options.governance.changeTicket)) {
    fail(`${spec.kind} governance drifted from the phase ledger`);
  }
  if (options.fencingGeneration !== undefined &&
    receipt.fencingGeneration !== options.fencingGeneration) {
    fail(`${spec.kind} fencing generation does not match the transition`);
  }

  const issuedAt = parseIsoSecond(receipt.issuedAt, `${spec.kind}.issuedAt`);
  const expiresAt = parseIsoSecond(receipt.expiresAt, `${spec.kind}.expiresAt`);
  const previousIssuedAt = parseIsoSecond(
    spec.previousKind === "initial-bootstrap-entry"
      ? previousReceipt.preparedAt
      : previousReceipt.issuedAt,
    `${spec.kind} predecessor issuance time`,
  );
  const admittedAt = options.admittedAt
    ? parseIsoSecond(options.admittedAt, `${spec.kind} admission time`)
    : (options.nowEpochSeconds ?? Math.floor(Date.now() / 1000)) * 1000;
  if (issuedAt < previousIssuedAt || expiresAt <= issuedAt ||
    expiresAt - issuedAt > MAX_PHASE_RECEIPT_LIFETIME_SECONDS * 1000 ||
    issuedAt - admittedAt > PHASE_RECEIPT_FUTURE_SKEW_SECONDS * 1000 ||
    admittedAt >= expiresAt) {
    fail(`${spec.kind} receipt is stale, future-dated, expired, or exceeds 15 minutes`);
  }

  if (spec.kind === "production-schema-result") validateB4(receipt.evidence, receipt, previousReceipt);
  else if (spec.kind === "enum-aware-disabled-baseline") validateB5(receipt.evidence, receipt, previousReceipt);
  else if (spec.kind === "first-class-activation") validateB6(receipt.evidence, receipt, previousReceipt);
  else validateB8(receipt.evidence, receipt, previousReceipt);

  if (options.phaseContextBytes) {
    const contextBytes = Buffer.isBuffer(options.phaseContextBytes)
      ? options.phaseContextBytes : Buffer.from(options.phaseContextBytes);
    if (contextBytes.length === 0 || contextBytes.length > MAX_PHASE_CONTEXT_BYTES) {
      fail(`${spec.kind} phase context size is outside the permitted range`);
    }
    const context = strictPhaseJsonParse(contextBytes, `${spec.kind} phase context`);
    assertExactKeys(context, CONTEXT_KEYS, `${spec.kind} phase context`);
    if (receipt.phaseContextHash !== phaseSha256Bytes(contextBytes) ||
      context.schemaVersion !== 1 || context.environment !== "production" ||
      context.kind !== FINAL_PHASE_CONTEXT_KIND ||
      context.generatedBy !== FINAL_PHASE_CONTEXT_GENERATOR ||
      context.receiptKind !== spec.kind || context.phase !== spec.phase ||
      context.attemptId !== receipt.attemptId || !sameJson(context.candidate, receipt.candidate) ||
      context.databaseIdentityHash !== receipt.databaseIdentityHash ||
      context.redisIdentityHash !== receipt.redisIdentityHash ||
      context.azureIdentityHash !== receipt.azureIdentityHash ||
      context.admissionContextHash !== receipt.admissionContextHash ||
      context.fencingGeneration !== receipt.fencingGeneration ||
      context.previousReceiptSha256 !== receipt.previousReceiptSha256 ||
      !sameJson(context.rollbackPolicy, receipt.rollbackPolicy) ||
      !sameJson(context.evidence, receipt.evidence)) {
      fail(`${spec.kind} phase context hash, identity, rollback floor, or evidence is mismatched`);
    }
    const observedAt = parseIsoSecond(context.observedAt, `${spec.kind} phase context observedAt`);
    if (observedAt > issuedAt || issuedAt - observedAt > MAX_PHASE_CONTEXT_AGE_SECONDS * 1000) {
      fail(`${spec.kind} phase context is future-dated or older than five minutes at issuance`);
    }
    if (spec.kind === "bootstrap-complete") {
      const resumeCompletedAt = parseIsoSecond(
        receipt.evidence.resume.steps[4].completedAt,
        `${spec.kind} final resume completion`,
      );
      if (observedAt < resumeCompletedAt) {
        fail(`${spec.kind} phase context predates final resume completion`);
      }
    }
  }
  return { spec, receipt, previousReceipt, previousReceiptSha256 };
}

export function validateFinalPhaseReceiptBytes(receiptBytes, options) {
  const bytes = Buffer.isBuffer(receiptBytes) ? receiptBytes : Buffer.from(receiptBytes);
  if (bytes.length === 0 || bytes.length > MAX_PHASE_RECEIPT_BYTES) {
    fail("phase receipt size is outside the permitted range");
  }
  const receipt = strictPhaseJsonParse(bytes, "production bootstrap phase receipt");
  return {
    ...validateFinalPhaseReceiptObject(receipt, options),
    receiptBytes: bytes,
    receiptSha256: phaseSha256Bytes(bytes),
  };
}

function readBounded(path, maximum, label) {
  const bytes = readFileSync(path);
  if (bytes.length === 0 || bytes.length > maximum) {
    fail(`${label} size is outside the permitted range`);
  }
  return bytes;
}

function cli() {
  const [, , command, ...args] = process.argv;
  if (command === "strict-json" && args.length >= 1) {
    for (const path of args) {
      const bytes = readBounded(path, MAX_PHASE_CONTEXT_BYTES, `strict JSON input ${path}`);
      strictPhaseJsonParse(bytes, `strict JSON input ${path}`);
    }
    return;
  }
  if (command !== "verify" || args.length !== 8) {
    fail("usage: production-bootstrap-phase-receipt-contracts.mjs verify RECEIPT PREVIOUS CONTEXT BACKEND_COMMIT CONSOLE_COMMIT ATTEMPT_ID EXPECTED_KIND NOW_EPOCH");
  }
  const [receiptPath, previousPath, contextPath, backendCommit, consoleCommit,
    attemptId, expectedKind, nowEpochText] = args;
  assertString(backendCommit, COMMIT_PATTERN, "expected backend commit");
  assertString(consoleCommit, COMMIT_PATTERN, "expected console commit");
  assertString(attemptId, ATTEMPT_PATTERN, "expected attempt id");
  const nowEpochSeconds = Number(nowEpochText);
  if (!Number.isSafeInteger(nowEpochSeconds) || nowEpochSeconds < 1) fail("current epoch is invalid");
  const result = validateFinalPhaseReceiptBytes(
    readBounded(receiptPath, MAX_PHASE_RECEIPT_BYTES, "phase receipt"),
    {
      expectedKind,
      previousReceiptBytes: readBounded(previousPath, MAX_PHASE_RECEIPT_BYTES, "previous receipt"),
      phaseContextBytes: readBounded(contextPath, MAX_PHASE_CONTEXT_BYTES, "phase context"),
      nowEpochSeconds,
    },
  );
  if (result.receipt.candidate.backendCommit !== backendCommit ||
    result.receipt.candidate.consoleCommit !== consoleCommit ||
    result.receipt.attemptId !== attemptId) {
    fail("phase receipt does not match the explicit expected candidate or attempt identity");
  }
  process.stdout.write(`${JSON.stringify({
    kind: result.spec.kind,
    phase: result.spec.phase,
    sequence: result.spec.sequence,
    signatureNamespace: result.spec.signatureNamespace,
    approver: result.receipt.approver,
    receiptSha256: result.receiptSha256,
    previousReceiptSha256: result.previousReceiptSha256,
    fencingGeneration: result.receipt.fencingGeneration,
  })}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    cli();
  } catch (error) {
    process.stderr.write(`ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
