#!/usr/bin/env node

/**
 * Catalog-only verifier for the eight migrations that follow the Clerk
 * identity migration in the production bootstrap sequence.
 *
 * The SQL exported by this module reads pg_catalog only. It never reads an
 * application relation. Raw catalog definitions are accepted only as bounded
 * verifier input and are reduced to fixed reason codes and SHA-256 hashes in
 * the public report.
 */

import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const POST_CLERK_MIGRATIONS = Object.freeze([
  "docs/migrations/2026-06-01_outreach-artifact-unique.sql",
  "docs/migrations/2026-08-12_conversation-store-expand.sql",
  "docs/migrations/2026-08-12_outreach-delivery-unknown-expand.sql",
  "docs/migrations/2026-08-13_outreach-artifact-failed-expand.sql",
  "docs/migrations/2026-08-12_conversation-reply-single-flight-expand.sql",
  "docs/migrations/2026-08-12_graph-run-activity-expand.sql",
  "docs/migrations/2026-08-12_graph-run-lifecycle-expand.sql",
  "docs/migrations/2026-08-20_icp-exclusion-domains-expand.sql",
]);

export const POST_CLERK_MIGRATION_CONTRACT = deepFreeze([
  {
    path: POST_CLERK_MIGRATIONS[0],
    sha256: "sha256:5653818552e1e52bf71229fa3c485dd284da331ee50a69669e98bc65e1a35fb2",
  },
  {
    path: POST_CLERK_MIGRATIONS[1],
    sha256: "sha256:b34ff5fc9dbd4d4c4adcf7adb044e238d6d427f7e03fd2dec1b356807a7408ba",
  },
  {
    path: POST_CLERK_MIGRATIONS[2],
    sha256: "sha256:4f5b687b4dad2969e554432b4812c0f57c1b07a6549eecf469997da45a44d14a",
  },
  {
    path: POST_CLERK_MIGRATIONS[3],
    sha256: "sha256:4d51befaa3ac27824ba15ae503a63051cbcb716d2da6e0fd1c49010b2a846d14",
  },
  {
    path: POST_CLERK_MIGRATIONS[4],
    sha256: "sha256:6cbfa5769455220d1b7341bef566cd1258286e8456fde1ad45266a2d8d2be999",
  },
  {
    path: POST_CLERK_MIGRATIONS[5],
    sha256: "sha256:8f18edbde210e3520a5bc49d02cd7fb618205edfdf0e0f08f70ee80614530056",
  },
  {
    path: POST_CLERK_MIGRATIONS[6],
    sha256: "sha256:a502874d67c222332b253859b40699a679daf24c27c9b0bbedbd3c63e8254e2b",
  },
  {
    path: POST_CLERK_MIGRATIONS[7],
    sha256: "sha256:0b29f8654efa3e21e3c0bfa29a5c8caf3a029967c9446e26b6340a68899b83db",
  },
]);

export const REPLY_REPAIR_INDEXES = Object.freeze([
  "OutreachArtifact_one_reply_per_inbound_uniq",
  "OutreachArtifact_one_open_reply_per_conversation_uniq",
]);

export const CATALOG_SNAPSHOT_KIND = "production-post-clerk-catalog-snapshot";
export const CATALOG_REPORT_KIND = "production-post-clerk-migration-catalog";
export const MAX_CATALOG_SNAPSHOT_BYTES = 256 * 1024;
export const MAX_CATALOG_REPORT_BYTES = 32 * 1024;
export const POST_CLERK_CATALOG_TRANSACTION = Object.freeze({
  postgresMajor: 16,
  schema: "public",
  searchPath: "pg_catalog,public",
  isolation: "repeatable read",
  readOnly: true,
});

const BASE_OUTREACH_STATUS_LABELS = Object.freeze([
  "DRAFT",
  "PENDING_REVIEW",
  "APPROVED",
  "REJECTED",
  "SENT",
  "QUEUED",
  "REPLIED",
  "BOUNCED",
  "SUPPRESSED",
  "SENDING",
  "SIMULATED",
]);

const enums = {
  ConversationDirection: ["INBOUND", "OUTBOUND"],
  ConversationSentiment: ["POSITIVE", "OBJECTION", "NEUTRAL", "NEGATIVE"],
  ConversationNextActionType: ["SEND_CONTENT", "QUALIFY", "DISQUALIFY", "FOLLOW_UP"],
  ConversationIntelligenceStatus: ["PENDING", "READY", "FAILED"],
  FollowUpStatus: ["OPEN", "DONE", "CANCELLED"],
  FollowUpSource: ["HUMAN", "AGENT"],
  OutreachArtifactPurpose: ["OUTBOUND", "REPLY", "FOLLOW_UP"],
};

const relation = (name, columnCount = null) => ({
  name,
  kind: "r",
  persistence: "p",
  columnCount,
});

const column = (table, name, typeName, options = {}) => ({
  table,
  name,
  typeSchema: options.typeSchema ?? (typeName.startsWith("_") || [
    "text", "int4", "bool", "timestamp", "float8",
  ].includes(typeName) ? "pg_catalog" : "current"),
  typeName,
  typeModifier: options.typeModifier ?? -1,
  arrayDimensions: options.arrayDimensions ?? (typeName.startsWith("_") ? 1 : 0),
  notNull: options.notNull ?? false,
  defaultKind: options.defaultKind ?? "none",
});

const index = (name, table, columns, options = {}) => ({
  name,
  table,
  columns,
  unique: options.unique ?? false,
  primary: options.primary ?? false,
  predicate: options.predicate ?? null,
  opclasses: options.opclasses ?? columns.map(() => "pg_catalog.text_ops"),
});

const REFERENCED_INDEXES = Object.freeze({
  "Org\u0000id": "Org_pkey",
  "Integration\u0000id\u0000orgId": "Integration_id_orgId_key",
  "Person\u0000id": "Person_pkey",
  "Conversation\u0000id\u0000orgId": "Conversation_id_orgId_key",
  "OutreachArtifact\u0000id\u0000orgId": "OutreachArtifact_id_orgId_key",
  "ConversationMessage\u0000id\u0000orgId": "ConversationMessage_id_orgId_key",
});

const constraint = (name, table, type, options = {}) => ({
  name,
  table,
  type,
  columns: options.columns ?? [],
  referencedTable: options.referencedTable ?? null,
  referencedColumns: options.referencedColumns ?? [],
  updateAction: options.updateAction ?? " ",
  deleteAction: options.deleteAction ?? " ",
  matchType: options.matchType ?? " ",
  expression: options.expression ?? null,
  indexName: options.indexName ?? (type === "f"
    ? REFERENCED_INDEXES[[options.referencedTable, ...(options.referencedColumns ?? [])].join("\u0000")]
    : null),
  noInherit: options.noInherit ?? type !== "c",
});

const columns = [
  column("OutreachArtifact", "purpose", "OutreachArtifactPurpose", {
    notNull: true,
    defaultKind: "enum:OutreachArtifactPurpose:OUTBOUND",
  }),
  column("OutreachArtifact", "conversationId", "text"),
  column("OutreachArtifact", "providerThreadId", "text"),
  column("OutreachArtifact", "replyToMessageId", "text"),
  column("OutreachArtifact", "failureReason", "text"),
  column("OutreachArtifact", "failedAt", "timestamp", { typeModifier: 3 }),
  column("MeetingLedger", "conversationId", "text"),
  column("MeetingLedger", "sourceMessageId", "text"),

  column("Conversation", "id", "text", { notNull: true }),
  column("Conversation", "orgId", "text", { notNull: true }),
  column("Conversation", "integrationId", "text", { notNull: true }),
  column("Conversation", "providerThreadId", "text", { notNull: true }),
  column("Conversation", "personId", "text"),
  column("Conversation", "contactEmail", "text", { notNull: true }),
  column("Conversation", "contactName", "text"),
  column("Conversation", "subject", "text", { notNull: true, defaultKind: "empty-text" }),
  column("Conversation", "lastMessagePreview", "text", { notNull: true, defaultKind: "empty-text" }),
  column("Conversation", "lastMessageAt", "timestamp", { typeModifier: 3, notNull: true }),
  column("Conversation", "lastInboundAt", "timestamp", { typeModifier: 3 }),
  column("Conversation", "lastOutboundAt", "timestamp", { typeModifier: 3 }),
  column("Conversation", "unreadCount", "int4", { notNull: true, defaultKind: "integer-zero" }),
  column("Conversation", "needsReply", "bool", { notNull: true, defaultKind: "boolean-false" }),
  column("Conversation", "archivedAt", "timestamp", { typeModifier: 3 }),
  column("Conversation", "sequenceStoppedAt", "timestamp", { typeModifier: 3 }),
  column("Conversation", "sequenceStopReason", "text"),
  column("Conversation", "sentiment", "ConversationSentiment"),
  column("Conversation", "sentimentConfidence", "float8"),
  column("Conversation", "nextBestAction", "text"),
  column("Conversation", "nextBestActionType", "ConversationNextActionType"),
  column("Conversation", "intelligenceStatus", "ConversationIntelligenceStatus", {
    notNull: true,
    defaultKind: "enum:ConversationIntelligenceStatus:PENDING",
  }),
  column("Conversation", "intelligenceError", "text"),
  column("Conversation", "intelligenceUpdatedAt", "timestamp", { typeModifier: 3 }),
  column("Conversation", "createdAt", "timestamp", {
    typeModifier: 3,
    notNull: true,
    defaultKind: "current-timestamp",
  }),
  column("Conversation", "updatedAt", "timestamp", { typeModifier: 3, notNull: true }),

  column("ConversationMessage", "id", "text", { notNull: true }),
  column("ConversationMessage", "orgId", "text", { notNull: true }),
  column("ConversationMessage", "conversationId", "text", { notNull: true }),
  column("ConversationMessage", "direction", "ConversationDirection", { notNull: true }),
  column("ConversationMessage", "providerMessageId", "text", { notNull: true }),
  column("ConversationMessage", "internetMessageId", "text"),
  column("ConversationMessage", "senderEmail", "text", { notNull: true }),
  column("ConversationMessage", "senderName", "text"),
  column("ConversationMessage", "toEmails", "_text", { notNull: true }),
  column("ConversationMessage", "ccEmails", "_text", {
    notNull: true,
    defaultKind: "empty-text-array",
  }),
  column("ConversationMessage", "subject", "text", { notNull: true, defaultKind: "empty-text" }),
  column("ConversationMessage", "bodyText", "text"),
  column("ConversationMessage", "bodyHtml", "text"),
  column("ConversationMessage", "sentAt", "timestamp", { typeModifier: 3, notNull: true }),
  column("ConversationMessage", "readAt", "timestamp", { typeModifier: 3 }),
  column("ConversationMessage", "outreachArtifactId", "text"),
  column("ConversationMessage", "createdAt", "timestamp", {
    typeModifier: 3,
    notNull: true,
    defaultKind: "current-timestamp",
  }),

  column("FollowUpTask", "id", "text", { notNull: true }),
  column("FollowUpTask", "orgId", "text", { notNull: true }),
  column("FollowUpTask", "conversationId", "text", { notNull: true }),
  column("FollowUpTask", "dueAt", "timestamp", { typeModifier: 3, notNull: true }),
  column("FollowUpTask", "note", "text"),
  column("FollowUpTask", "status", "FollowUpStatus", {
    notNull: true,
    defaultKind: "enum:FollowUpStatus:OPEN",
  }),
  column("FollowUpTask", "source", "FollowUpSource", {
    notNull: true,
    defaultKind: "enum:FollowUpSource:HUMAN",
  }),
  column("FollowUpTask", "createdBy", "text"),
  column("FollowUpTask", "completedBy", "text"),
  column("FollowUpTask", "completedAt", "timestamp", { typeModifier: 3 }),
  column("FollowUpTask", "cancelledBy", "text"),
  column("FollowUpTask", "cancelledAt", "timestamp", { typeModifier: 3 }),
  column("FollowUpTask", "cancellationReason", "text"),
  column("FollowUpTask", "createdAt", "timestamp", {
    typeModifier: 3,
    notNull: true,
    defaultKind: "current-timestamp",
  }),
  column("FollowUpTask", "updatedAt", "timestamp", { typeModifier: 3, notNull: true }),

  column("GraphRun", "lastActivityAt", "timestamp", {
    typeModifier: 3,
    notNull: true,
    defaultKind: "current-timestamp",
  }),
  column("GraphRun", "startIcpProfileIds", "_text", {
    notNull: true,
    defaultKind: "empty-text-array",
  }),
  column("GraphRun", "pendingResumeApproved", "bool"),
  column("GraphRun", "pendingResumeApprovedBy", "text"),
  column("GraphRun", "dispatchGeneration", "int4", {
    notNull: true,
    defaultKind: "integer-zero",
  }),
  column("IcpProfile", "exclusionDomains", "_text", {
    notNull: true,
    defaultKind: "empty-text-array",
  }),
];

const BTREE_TEXT = "pg_catalog.text_ops";
const BTREE_ENUM = "pg_catalog.enum_ops";
const BTREE_TIME = "pg_catalog.timestamp_ops";
const BTREE_BOOL = "pg_catalog.bool_ops";

const indexes = [
  index("OutreachArtifact_idempotency_uniq", "OutreachArtifact",
    ["orgId", "graphRunId", "toolName", "recipientRef"], {
      unique: true,
      predicate: "((\"graphRunId\" IS NOT NULL) AND (\"recipientRef\" IS NOT NULL))",
    }),

  index("Integration_id_orgId_key", "Integration", ["id", "orgId"], { unique: true }),
  index("OutreachArtifact_id_orgId_key", "OutreachArtifact", ["id", "orgId"], { unique: true }),
  index("Conversation_pkey", "Conversation", ["id"], { unique: true, primary: true }),
  index("Conversation_integrationId_providerThreadId_key", "Conversation",
    ["integrationId", "providerThreadId"], { unique: true }),
  index("Conversation_id_orgId_key", "Conversation", ["id", "orgId"], { unique: true }),
  index("Conversation_orgId_archivedAt_lastMessageAt_idx", "Conversation",
    ["orgId", "archivedAt", "lastMessageAt"], {
      opclasses: [BTREE_TEXT, BTREE_TIME, BTREE_TIME],
    }),
  index("Conversation_orgId_needsReply_lastMessageAt_idx", "Conversation",
    ["orgId", "needsReply", "lastMessageAt"], {
      opclasses: [BTREE_TEXT, BTREE_BOOL, BTREE_TIME],
    }),
  index("Conversation_orgId_sentiment_lastMessageAt_idx", "Conversation",
    ["orgId", "sentiment", "lastMessageAt"], {
      opclasses: [BTREE_TEXT, BTREE_ENUM, BTREE_TIME],
    }),
  index("Conversation_orgId_personId_idx", "Conversation", ["orgId", "personId"]),

  index("ConversationMessage_pkey", "ConversationMessage", ["id"], { unique: true, primary: true }),
  index("ConversationMessage_conversationId_providerMessageId_key", "ConversationMessage",
    ["conversationId", "providerMessageId"], { unique: true }),
  index("ConversationMessage_id_orgId_key", "ConversationMessage", ["id", "orgId"], { unique: true }),
  index("ConversationMessage_orgId_outreachArtifactId_key", "ConversationMessage",
    ["orgId", "outreachArtifactId"], { unique: true }),
  index("ConversationMessage_orgId_sentAt_idx", "ConversationMessage", ["orgId", "sentAt"], {
    opclasses: [BTREE_TEXT, BTREE_TIME],
  }),
  index("ConversationMessage_conversationId_sentAt_idx", "ConversationMessage",
    ["conversationId", "sentAt"], { opclasses: [BTREE_TEXT, BTREE_TIME] }),
  index("ConversationMessage_orgId_internetMessageId_idx", "ConversationMessage",
    ["orgId", "internetMessageId"]),

  index("FollowUpTask_pkey", "FollowUpTask", ["id"], { unique: true, primary: true }),
  index("FollowUpTask_id_orgId_key", "FollowUpTask", ["id", "orgId"], { unique: true }),
  index("FollowUpTask_orgId_status_dueAt_idx", "FollowUpTask", ["orgId", "status", "dueAt"], {
    opclasses: [BTREE_TEXT, BTREE_ENUM, BTREE_TIME],
  }),
  index("FollowUpTask_conversationId_status_dueAt_idx", "FollowUpTask",
    ["conversationId", "status", "dueAt"], { opclasses: [BTREE_TEXT, BTREE_ENUM, BTREE_TIME] }),
  index("OutreachArtifact_orgId_purpose_status_idx", "OutreachArtifact",
    ["orgId", "purpose", "status"], { opclasses: [BTREE_TEXT, BTREE_ENUM, BTREE_ENUM] }),
  index("OutreachArtifact_conversationId_createdAt_idx", "OutreachArtifact",
    ["conversationId", "createdAt"], { opclasses: [BTREE_TEXT, BTREE_TIME] }),
  index("OutreachArtifact_orgId_providerThreadId_idx", "OutreachArtifact",
    ["orgId", "providerThreadId"]),
  index("MeetingLedger_conversationId_idx", "MeetingLedger", ["conversationId"]),
  index("MeetingLedger_sourceMessageId_idx", "MeetingLedger", ["sourceMessageId"]),

  index("OutreachArtifact_one_reply_per_inbound_uniq", "OutreachArtifact",
    ["orgId", "conversationId", "replyToMessageId"], {
      unique: true,
      predicate: "((purpose = 'REPLY'::\"OutreachArtifactPurpose\") AND (\"conversationId\" IS NOT NULL) AND (\"replyToMessageId\" IS NOT NULL) AND (status = ANY (ARRAY['DRAFT'::\"OutreachArtifactStatus\", 'PENDING_REVIEW'::\"OutreachArtifactStatus\", 'APPROVED'::\"OutreachArtifactStatus\", 'SENDING'::\"OutreachArtifactStatus\", 'SENT'::\"OutreachArtifactStatus\", 'DELIVERY_UNKNOWN'::\"OutreachArtifactStatus\"])))",
    }),
  index("OutreachArtifact_one_open_reply_per_conversation_uniq", "OutreachArtifact",
    ["orgId", "conversationId"], {
      unique: true,
      predicate: "((purpose = 'REPLY'::\"OutreachArtifactPurpose\") AND (\"conversationId\" IS NOT NULL) AND (status = ANY (ARRAY['DRAFT'::\"OutreachArtifactStatus\", 'PENDING_REVIEW'::\"OutreachArtifactStatus\", 'APPROVED'::\"OutreachArtifactStatus\", 'SENDING'::\"OutreachArtifactStatus\", 'DELIVERY_UNKNOWN'::\"OutreachArtifactStatus\"])))",
    }),

  index("GraphRun_status_lastActivityAt_idx", "GraphRun", ["status", "lastActivityAt"], {
    opclasses: [BTREE_ENUM, BTREE_TIME],
  }),
  index("GraphRun_one_active_per_org_key", "GraphRun", ["orgId"], {
    unique: true,
    predicate: "((status = 'RUNNING'::\"GraphRunStatus\") OR (status = 'AWAITING_APPROVAL'::\"GraphRunStatus\"))",
  }),
];

const constraints = [
  constraint("Conversation_pkey", "Conversation", "p", {
    columns: ["id"], indexName: "Conversation_pkey",
  }),
  constraint("Conversation_unreadCount_check", "Conversation", "c", {
    columns: ["unreadCount"],
    expression: "(\"unreadCount\" >= 0)",
  }),
  constraint("Conversation_sentimentConfidence_check", "Conversation", "c", {
    columns: ["sentimentConfidence"],
    expression: "((\"sentimentConfidence\" IS NULL) OR ((\"sentimentConfidence\" >= (0)::double precision) AND (\"sentimentConfidence\" <= (1)::double precision)))",
  }),
  constraint("ConversationMessage_pkey", "ConversationMessage", "p", {
    columns: ["id"], indexName: "ConversationMessage_pkey",
  }),
  constraint("FollowUpTask_pkey", "FollowUpTask", "p", {
    columns: ["id"], indexName: "FollowUpTask_pkey",
  }),

  constraint("Conversation_orgId_fkey", "Conversation", "f", {
    columns: ["orgId"], referencedTable: "Org", referencedColumns: ["id"],
    updateAction: "c", deleteAction: "c", matchType: "s",
  }),
  constraint("Conversation_integrationId_orgId_fkey", "Conversation", "f", {
    columns: ["integrationId", "orgId"], referencedTable: "Integration",
    referencedColumns: ["id", "orgId"], updateAction: "c", deleteAction: "a", matchType: "s",
  }),
  constraint("Conversation_personId_fkey", "Conversation", "f", {
    columns: ["personId"], referencedTable: "Person", referencedColumns: ["id"],
    updateAction: "c", deleteAction: "n", matchType: "s",
  }),
  constraint("ConversationMessage_orgId_fkey", "ConversationMessage", "f", {
    columns: ["orgId"], referencedTable: "Org", referencedColumns: ["id"],
    updateAction: "c", deleteAction: "c", matchType: "s",
  }),
  constraint("ConversationMessage_conversationId_orgId_fkey", "ConversationMessage", "f", {
    columns: ["conversationId", "orgId"], referencedTable: "Conversation",
    referencedColumns: ["id", "orgId"], updateAction: "c", deleteAction: "c", matchType: "s",
  }),
  constraint("ConversationMessage_outreachArtifactId_orgId_fkey", "ConversationMessage", "f", {
    columns: ["outreachArtifactId", "orgId"], referencedTable: "OutreachArtifact",
    referencedColumns: ["id", "orgId"], updateAction: "c", deleteAction: "a", matchType: "s",
  }),
  constraint("FollowUpTask_orgId_fkey", "FollowUpTask", "f", {
    columns: ["orgId"], referencedTable: "Org", referencedColumns: ["id"],
    updateAction: "c", deleteAction: "c", matchType: "s",
  }),
  constraint("FollowUpTask_conversationId_orgId_fkey", "FollowUpTask", "f", {
    columns: ["conversationId", "orgId"], referencedTable: "Conversation",
    referencedColumns: ["id", "orgId"], updateAction: "c", deleteAction: "c", matchType: "s",
  }),
  constraint("OutreachArtifact_conversationId_orgId_fkey", "OutreachArtifact", "f", {
    columns: ["conversationId", "orgId"], referencedTable: "Conversation",
    referencedColumns: ["id", "orgId"], updateAction: "c", deleteAction: "a", matchType: "s",
  }),
  constraint("OutreachArtifact_replyToMessageId_orgId_fkey", "OutreachArtifact", "f", {
    columns: ["replyToMessageId", "orgId"], referencedTable: "ConversationMessage",
    referencedColumns: ["id", "orgId"], updateAction: "c", deleteAction: "a", matchType: "s",
  }),
  constraint("MeetingLedger_conversationId_orgId_fkey", "MeetingLedger", "f", {
    columns: ["conversationId", "orgId"], referencedTable: "Conversation",
    referencedColumns: ["id", "orgId"], updateAction: "c", deleteAction: "a", matchType: "s",
  }),
  constraint("MeetingLedger_sourceMessageId_orgId_fkey", "MeetingLedger", "f", {
    columns: ["sourceMessageId", "orgId"], referencedTable: "ConversationMessage",
    referencedColumns: ["id", "orgId"], updateAction: "c", deleteAction: "a", matchType: "s",
  }),
];

const contract = {
  enums,
  relations: [
    relation("Integration"),
    relation("OutreachArtifact"),
    relation("MeetingLedger"),
    relation("GraphRun"),
    relation("IcpProfile"),
    relation("Conversation", 26),
    relation("ConversationMessage", 17),
    relation("FollowUpTask", 15),
  ],
  columns,
  indexes,
  constraints,
};

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export const POST_CLERK_CATALOG_CONTRACT = deepFreeze(contract);
export const POST_CLERK_CATALOG_CONTRACT_VERSION = 5;
export const POST_CLERK_MIGRATION_CONTRACT_HASH = sha256(
  canonicalJson(POST_CLERK_MIGRATION_CONTRACT),
);
export const POST_CLERK_CATALOG_CONTRACT_HASH = sha256(canonicalJson({
  contractVersion: POST_CLERK_CATALOG_CONTRACT_VERSION,
  postgresMajor: 16,
  schema: "public",
  progressVisibility: "superuser-or-pg_read_all_stats",
  migrationContractHash: POST_CLERK_MIGRATION_CONTRACT_HASH,
  migrations: POST_CLERK_MIGRATION_CONTRACT,
  contract: POST_CLERK_CATALOG_CONTRACT,
}));

function sqlLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function sqlValues(rows) {
  return rows.map((row) => `(${row.map(sqlLiteral).join(",")})`).join(",\n      ");
}

const wantedEnumNames = [...Object.keys(enums), "OutreachArtifactStatus"];
const wantedRelationNames = contract.relations.map((entry) => entry.name);
const wantedColumnPairs = contract.columns.map((entry) => [entry.table, entry.name]);
const wantedIndexNames = contract.indexes.map((entry) => entry.name);
const wantedIndexTables = [...new Set(contract.indexes.map((entry) => entry.table))];
const wantedConstraintPairs = contract.constraints.map((entry) => [entry.name, entry.table]);

/**
 * One bounded pg_catalog-only query. Every potentially variable expression is
 * truncated and accompanied by its full length, so truncation always makes an
 * exact comparison fail closed.
 */
export const POST_CLERK_CATALOG_QUERY = String.raw`
WITH
  wanted_enums(name) AS (
    VALUES ${sqlValues(wantedEnumNames.map((name) => [name]))}
  ),
  wanted_relations(name) AS (
    VALUES ${sqlValues(wantedRelationNames.map((name) => [name]))}
  ),
  wanted_columns(table_name, column_name) AS (
    VALUES ${sqlValues(wantedColumnPairs)}
  ),
  wanted_indexes(name) AS (
    VALUES ${sqlValues(wantedIndexNames.map((name) => [name]))}
  ),
  wanted_index_tables(name) AS (
    VALUES ${sqlValues(wantedIndexTables.map((name) => [name]))}
  ),
  wanted_constraints(name, table_name) AS (
    VALUES ${sqlValues(wantedConstraintPairs)}
  )
SELECT pg_catalog.jsonb_build_object(
  'schemaVersion', 1,
  'kind', '${CATALOG_SNAPSHOT_KIND}',
  'postgresMajor', pg_catalog.current_setting('server_version_num')::pg_catalog.int4 / 10000,
  'schema', 'public',
  'progressVisibilityComplete', (
    COALESCE((
      SELECT database_role.rolsuper
      FROM pg_catalog.pg_roles AS database_role
      WHERE database_role.rolname = current_user
    ), false)
    OR pg_catalog.pg_has_role(current_user, 'pg_read_all_stats', 'MEMBER')
  ),
  'enums', COALESCE((
    SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'name', enum_state.name,
      'kind', enum_state.kind,
      'labelCount', enum_state.label_count,
      'labels', enum_state.labels
    ) ORDER BY enum_state.name)
    FROM (
      SELECT
        type_class.typname AS name,
        type_class.typtype::pg_catalog.text AS kind,
        (SELECT pg_catalog.count(*)::pg_catalog.int4
          FROM pg_catalog.pg_enum AS all_labels
          WHERE all_labels.enumtypid = type_class.oid) AS label_count,
        COALESCE((
          SELECT pg_catalog.jsonb_agg(first_labels.enumlabel ORDER BY first_labels.enumsortorder)
          FROM (
            SELECT enum_label.enumlabel, enum_label.enumsortorder
            FROM pg_catalog.pg_enum AS enum_label
            WHERE enum_label.enumtypid = type_class.oid
            ORDER BY enum_label.enumsortorder
            LIMIT 32
          ) AS first_labels
        ), '[]'::pg_catalog.jsonb) AS labels
      FROM wanted_enums AS wanted
      JOIN pg_catalog.pg_type AS type_class ON type_class.typname = wanted.name
      JOIN pg_catalog.pg_namespace AS type_namespace
        ON type_namespace.oid = type_class.typnamespace
      WHERE type_namespace.nspname = 'public'
    ) AS enum_state
  ), '[]'::pg_catalog.jsonb),
  'relations', COALESCE((
    SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'name', relation_class.relname,
      'kind', relation_class.relkind::pg_catalog.text,
      'persistence', relation_class.relpersistence::pg_catalog.text,
      'columnCount', (
        SELECT pg_catalog.count(*)::pg_catalog.int4
        FROM pg_catalog.pg_attribute AS relation_column
        WHERE relation_column.attrelid = relation_class.oid
          AND relation_column.attnum > 0
          AND NOT relation_column.attisdropped
      )
    ) ORDER BY relation_class.relname)
    FROM wanted_relations AS wanted
    JOIN pg_catalog.pg_class AS relation_class ON relation_class.relname = wanted.name
    JOIN pg_catalog.pg_namespace AS relation_namespace
      ON relation_namespace.oid = relation_class.relnamespace
    WHERE relation_namespace.nspname = 'public'
  ), '[]'::pg_catalog.jsonb),
  'columns', COALESCE((
    SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'table', table_class.relname,
      'name', table_column.attname,
      'typeSchema', type_namespace.nspname,
      'typeName', type_class.typname,
      'typeModifier', table_column.atttypmod,
      'arrayDimensions', table_column.attndims,
      'collationMatchesTypeDefault', table_column.attcollation = type_class.typcollation,
      'notNull', table_column.attnotnull,
      'identity', table_column.attidentity::pg_catalog.text,
      'generated', table_column.attgenerated::pg_catalog.text,
      'defaultPresent', column_default.oid IS NOT NULL,
      'defaultSql', CASE WHEN column_default.oid IS NULL THEN NULL
        ELSE pg_catalog.left(pg_catalog.pg_get_expr(column_default.adbin, column_default.adrelid), 512) END,
      'defaultLength', CASE WHEN column_default.oid IS NULL THEN 0
        ELSE pg_catalog.length(pg_catalog.pg_get_expr(column_default.adbin, column_default.adrelid)) END
    ) ORDER BY table_class.relname, table_column.attnum)
    FROM wanted_columns AS wanted
    JOIN pg_catalog.pg_class AS table_class ON table_class.relname = wanted.table_name
    JOIN pg_catalog.pg_namespace AS table_namespace
      ON table_namespace.oid = table_class.relnamespace
    JOIN pg_catalog.pg_attribute AS table_column
      ON table_column.attrelid = table_class.oid
     AND table_column.attname = wanted.column_name
     AND table_column.attnum > 0
     AND NOT table_column.attisdropped
    JOIN pg_catalog.pg_type AS type_class ON type_class.oid = table_column.atttypid
    JOIN pg_catalog.pg_namespace AS type_namespace
      ON type_namespace.oid = type_class.typnamespace
    LEFT JOIN pg_catalog.pg_attrdef AS column_default
      ON column_default.adrelid = table_class.oid
     AND column_default.adnum = table_column.attnum
    WHERE table_namespace.nspname = 'public'
  ), '[]'::pg_catalog.jsonb),
  'indexes', COALESCE((
    SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'name', index_class.relname,
      'relationKind', index_class.relkind::pg_catalog.text,
      'table', table_class.relname,
      'tableSchema', table_namespace.nspname,
      'method', access_method.amname,
      'unique', index_state.indisunique,
      'primary', index_state.indisprimary,
      'exclusion', index_state.indisexclusion,
      'immediate', index_state.indimmediate,
      'valid', index_state.indisvalid,
      'ready', index_state.indisready,
      'live', index_state.indislive,
      'clustered', index_state.indisclustered,
      'replicaIdentity', index_state.indisreplident,
      'nullsNotDistinct', COALESCE(
        (pg_catalog.to_jsonb(index_state)->>'indnullsnotdistinct')::pg_catalog.bool,
        false
      ),
      'keyCount', index_state.indnkeyatts,
      'attributeCount', index_state.indnatts,
      'columns', COALESCE((
        SELECT pg_catalog.jsonb_agg(key_column.attname ORDER BY key_part.position)
        FROM pg_catalog.unnest(index_state.indkey::pg_catalog.int2[]) WITH ORDINALITY
          AS key_part(attribute_number, position)
        JOIN pg_catalog.pg_attribute AS key_column
          ON key_column.attrelid = index_state.indrelid
         AND key_column.attnum = key_part.attribute_number
        WHERE key_part.position <= index_state.indnatts
      ), '[]'::pg_catalog.jsonb),
      'opclasses', COALESCE((
        SELECT pg_catalog.jsonb_agg(opclass_namespace.nspname || '.' || opclass.opcname
          ORDER BY opclass_part.position)
        FROM pg_catalog.unnest(index_state.indclass::pg_catalog.oid[]) WITH ORDINALITY
          AS opclass_part(opclass_oid, position)
        JOIN pg_catalog.pg_opclass AS opclass ON opclass.oid = opclass_part.opclass_oid
        JOIN pg_catalog.pg_namespace AS opclass_namespace
          ON opclass_namespace.oid = opclass.opcnamespace
        WHERE opclass_part.position <= index_state.indnkeyatts
      ), '[]'::pg_catalog.jsonb),
      'options', COALESCE((
        SELECT pg_catalog.jsonb_agg(option_part.option_value ORDER BY option_part.position)
        FROM pg_catalog.unnest(index_state.indoption::pg_catalog.int2[]) WITH ORDINALITY
          AS option_part(option_value, position)
        WHERE option_part.position <= index_state.indnkeyatts
      ), '[]'::pg_catalog.jsonb),
      'collationsMatchColumns', COALESCE((
        SELECT pg_catalog.bool_and(collation_part.collation_oid = key_column.attcollation)
        FROM pg_catalog.unnest(index_state.indkey::pg_catalog.int2[]) WITH ORDINALITY
          AS key_part(attribute_number, position)
        JOIN pg_catalog.unnest(index_state.indcollation::pg_catalog.oid[]) WITH ORDINALITY
          AS collation_part(collation_oid, position)
          ON collation_part.position = key_part.position
        JOIN pg_catalog.pg_attribute AS key_column
          ON key_column.attrelid = index_state.indrelid
         AND key_column.attnum = key_part.attribute_number
        WHERE key_part.position <= index_state.indnkeyatts
      ), false),
      'predicateSql', CASE WHEN index_state.indexrelid IS NULL THEN NULL
        ELSE pg_catalog.left(pg_catalog.pg_get_expr(index_state.indpred, index_state.indrelid), 2048) END,
      'predicateLength', CASE WHEN index_state.indexrelid IS NULL THEN 0
        ELSE COALESCE(pg_catalog.length(pg_catalog.pg_get_expr(index_state.indpred, index_state.indrelid)), 0) END
      , 'buildInProgress', EXISTS (
        SELECT 1
        FROM pg_catalog.pg_stat_progress_create_index AS index_progress
        WHERE index_progress.index_relid = index_class.oid
      )
    ) ORDER BY index_class.relname)
    FROM wanted_indexes AS wanted
    JOIN pg_catalog.pg_class AS index_class ON index_class.relname = wanted.name
    JOIN pg_catalog.pg_namespace AS index_namespace
      ON index_namespace.oid = index_class.relnamespace
    LEFT JOIN pg_catalog.pg_index AS index_state ON index_state.indexrelid = index_class.oid
    LEFT JOIN pg_catalog.pg_class AS table_class ON table_class.oid = index_state.indrelid
    LEFT JOIN pg_catalog.pg_namespace AS table_namespace
      ON table_namespace.oid = table_class.relnamespace
    LEFT JOIN pg_catalog.pg_am AS access_method ON access_method.oid = index_class.relam
    WHERE index_namespace.nspname = 'public'
  ), '[]'::pg_catalog.jsonb),
  'constraints', COALESCE((
    SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'name', constraint_state.conname,
      'table', table_class.relname,
      'type', constraint_state.contype::pg_catalog.text,
      'validated', constraint_state.convalidated,
      'deferrable', constraint_state.condeferrable,
      'deferred', constraint_state.condeferred,
      'local', constraint_state.conislocal,
      'inheritanceCount', constraint_state.coninhcount,
      'noInherit', constraint_state.connoinherit,
      'hasParent', constraint_state.conparentid <> 0,
      'columns', COALESCE((
        SELECT pg_catalog.jsonb_agg(local_column.attname ORDER BY local_key.position)
        FROM pg_catalog.unnest(constraint_state.conkey) WITH ORDINALITY
          AS local_key(attribute_number, position)
        JOIN pg_catalog.pg_attribute AS local_column
          ON local_column.attrelid = constraint_state.conrelid
         AND local_column.attnum = local_key.attribute_number
      ), '[]'::pg_catalog.jsonb),
      'referencedTable', referenced_table.relname,
      'referencedTableSchema', referenced_namespace.nspname,
      'referencedColumns', COALESCE((
        SELECT pg_catalog.jsonb_agg(referenced_column.attname ORDER BY referenced_key.position)
        FROM pg_catalog.unnest(constraint_state.confkey) WITH ORDINALITY
          AS referenced_key(attribute_number, position)
        JOIN pg_catalog.pg_attribute AS referenced_column
          ON referenced_column.attrelid = constraint_state.confrelid
         AND referenced_column.attnum = referenced_key.attribute_number
      ), '[]'::pg_catalog.jsonb),
      'updateAction', constraint_state.confupdtype::pg_catalog.text,
      'deleteAction', constraint_state.confdeltype::pg_catalog.text,
      'matchType', constraint_state.confmatchtype::pg_catalog.text,
      'indexName', constraint_index.relname,
      'expressionSql', CASE WHEN constraint_state.conbin IS NULL THEN NULL
        ELSE pg_catalog.left(pg_catalog.pg_get_expr(constraint_state.conbin, constraint_state.conrelid), 1024) END,
      'expressionLength', CASE WHEN constraint_state.conbin IS NULL THEN 0
        ELSE pg_catalog.length(pg_catalog.pg_get_expr(constraint_state.conbin, constraint_state.conrelid)) END
    ) ORDER BY table_class.relname, constraint_state.conname)
    FROM wanted_constraints AS wanted
    JOIN pg_catalog.pg_class AS table_class ON table_class.relname = wanted.table_name
    JOIN pg_catalog.pg_namespace AS table_namespace
      ON table_namespace.oid = table_class.relnamespace
    JOIN pg_catalog.pg_constraint AS constraint_state
      ON constraint_state.conrelid = table_class.oid
     AND constraint_state.conname = wanted.name
    LEFT JOIN pg_catalog.pg_class AS referenced_table
      ON referenced_table.oid = constraint_state.confrelid
    LEFT JOIN pg_catalog.pg_namespace AS referenced_namespace
      ON referenced_namespace.oid = referenced_table.relnamespace
    LEFT JOIN pg_catalog.pg_class AS constraint_index
      ON constraint_index.oid = constraint_state.conindid
    WHERE table_namespace.nspname = 'public'
  ), '[]'::pg_catalog.jsonb),
  'activeIndexBuilds', COALESCE((
    SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'table', active_build.table_name,
      'count', active_build.build_count
    ) ORDER BY active_build.table_name)
    FROM (
      SELECT table_class.relname AS table_name, pg_catalog.count(*)::pg_catalog.int4 AS build_count
      FROM pg_catalog.pg_stat_progress_create_index AS index_progress
      JOIN pg_catalog.pg_class AS table_class ON table_class.oid = index_progress.relid
      JOIN pg_catalog.pg_namespace AS table_namespace
        ON table_namespace.oid = table_class.relnamespace
      JOIN wanted_index_tables AS wanted_table ON wanted_table.name = table_class.relname
      WHERE table_namespace.nspname = 'public'
      GROUP BY table_class.relname
    ) AS active_build
  ), '[]'::pg_catalog.jsonb)
)::pg_catalog.text;
`;

export class CatalogVerifierError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CatalogVerifierError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new CatalogVerifierError(code, message);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys, label) {
  if (!isPlainObject(value)) fail("INVALID_SNAPSHOT", `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail("INVALID_SNAPSHOT", `${label} has an unexpected shape`);
  }
}

function boundedString(value, label, maximum = 4096, nullable = false) {
  if (nullable && value === null) return;
  if (typeof value !== "string" || value.length > maximum || /[\u0000]/u.test(value)) {
    fail("INVALID_SNAPSHOT", `${label} is invalid`);
  }
}

function booleanOrNull(value, label) {
  if (value !== null && typeof value !== "boolean") fail("INVALID_SNAPSHOT", `${label} is invalid`);
}

function integerOrNull(value, label, minimum = 0, maximum = 1000000) {
  if (value === null) return;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail("INVALID_SNAPSHOT", `${label} is invalid`);
  }
}

function boundedArray(value, label, maximum) {
  if (!Array.isArray(value) || value.length > maximum) {
    fail("INVALID_SNAPSHOT", `${label} is invalid`);
  }
}

function validateStringArray(value, label, maximum = 32, nullableItems = false) {
  boundedArray(value, label, maximum);
  for (const [index, item] of value.entries()) {
    if (nullableItems && item === null) continue;
    boundedString(item, `${label}[${index}]`, 128);
  }
}

function validateSnapshot(snapshot) {
  exactKeys(snapshot, [
    "schemaVersion", "kind", "postgresMajor", "schema", "progressVisibilityComplete", "enums",
    "relations", "columns", "indexes", "constraints", "activeIndexBuilds",
  ], "catalog snapshot");
  if (snapshot.schemaVersion !== 1 || snapshot.kind !== CATALOG_SNAPSHOT_KIND) {
    fail("INVALID_SNAPSHOT", "catalog snapshot identity is invalid");
  }
  if (snapshot.postgresMajor !== 16) fail("UNSUPPORTED_POSTGRES_MAJOR", "PostgreSQL major must be 16");
  boundedString(snapshot.schema, "catalog schema", 63);
  if (snapshot.schema !== "public") fail("UNEXPECTED_SCHEMA", "catalog schema must be public");
  if (typeof snapshot.progressVisibilityComplete !== "boolean") {
    fail("INVALID_SNAPSHOT", "index progress visibility evidence is invalid");
  }

  boundedArray(snapshot.enums, "catalog enums", 8);
  const enumKeys = new Set();
  for (const [index, entry] of snapshot.enums.entries()) {
    const label = `catalog enums[${index}]`;
    exactKeys(entry, ["name", "kind", "labelCount", "labels"], label);
    boundedString(entry.name, `${label}.name`, 63);
    boundedString(entry.kind, `${label}.kind`, 1);
    integerOrNull(entry.labelCount, `${label}.labelCount`, 0, 100000);
    validateStringArray(entry.labels, `${label}.labels`, 32);
    if (enumKeys.has(entry.name)) fail("INVALID_SNAPSHOT", "catalog enum is duplicated");
    enumKeys.add(entry.name);
  }

  boundedArray(snapshot.relations, "catalog relations", 8);
  const relationKeys = new Set();
  for (const [index, entry] of snapshot.relations.entries()) {
    const label = `catalog relations[${index}]`;
    exactKeys(entry, ["name", "kind", "persistence", "columnCount"], label);
    boundedString(entry.name, `${label}.name`, 63);
    boundedString(entry.kind, `${label}.kind`, 1);
    boundedString(entry.persistence, `${label}.persistence`, 1);
    integerOrNull(entry.columnCount, `${label}.columnCount`, 0, 10000);
    if (relationKeys.has(entry.name)) fail("INVALID_SNAPSHOT", "catalog relation is duplicated");
    relationKeys.add(entry.name);
  }

  boundedArray(snapshot.columns, "catalog columns", 80);
  const columnKeys = new Set();
  for (const [index, entry] of snapshot.columns.entries()) {
    const label = `catalog columns[${index}]`;
    exactKeys(entry, [
      "table", "name", "typeSchema", "typeName", "typeModifier", "arrayDimensions",
      "collationMatchesTypeDefault", "notNull", "identity", "generated", "defaultPresent",
      "defaultSql", "defaultLength",
    ], label);
    for (const key of ["table", "name", "typeSchema", "typeName"]) {
      boundedString(entry[key], `${label}.${key}`, 63);
    }
    integerOrNull(entry.typeModifier, `${label}.typeModifier`, -1, 1000000);
    integerOrNull(entry.arrayDimensions, `${label}.arrayDimensions`, 0, 32);
    if (typeof entry.collationMatchesTypeDefault !== "boolean" ||
      typeof entry.notNull !== "boolean" || typeof entry.defaultPresent !== "boolean") {
      fail("INVALID_SNAPSHOT", `${label} flags are invalid`);
    }
    boundedString(entry.identity, `${label}.identity`, 1);
    boundedString(entry.generated, `${label}.generated`, 1);
    boundedString(entry.defaultSql, `${label}.defaultSql`, 512, true);
    integerOrNull(entry.defaultLength, `${label}.defaultLength`, 0, 1000000);
    const key = `${entry.table}\u0000${entry.name}`;
    if (columnKeys.has(key)) fail("INVALID_SNAPSHOT", "catalog column is duplicated");
    columnKeys.add(key);
  }

  boundedArray(snapshot.indexes, "catalog indexes", 32);
  const indexKeys = new Set();
  for (const [indexNumber, entry] of snapshot.indexes.entries()) {
    const label = `catalog indexes[${indexNumber}]`;
    exactKeys(entry, [
      "name", "relationKind", "table", "tableSchema", "method", "unique", "primary",
      "exclusion", "immediate", "valid", "ready", "live", "clustered", "replicaIdentity",
      "nullsNotDistinct", "keyCount", "attributeCount", "columns", "opclasses", "options",
      "collationsMatchColumns", "predicateSql", "predicateLength", "buildInProgress",
    ], label);
    boundedString(entry.name, `${label}.name`, 63);
    for (const key of ["relationKind", "table", "tableSchema", "method"]) {
      boundedString(entry[key], `${label}.${key}`, 63, true);
    }
    for (const key of [
      "unique", "primary", "exclusion", "immediate", "valid", "ready", "live", "clustered",
      "replicaIdentity", "nullsNotDistinct", "collationsMatchColumns", "buildInProgress",
    ]) booleanOrNull(entry[key], `${label}.${key}`);
    integerOrNull(entry.keyCount, `${label}.keyCount`, 0, 64);
    integerOrNull(entry.attributeCount, `${label}.attributeCount`, 0, 64);
    validateStringArray(entry.columns, `${label}.columns`, 64, true);
    validateStringArray(entry.opclasses, `${label}.opclasses`, 64, true);
    boundedArray(entry.options, `${label}.options`, 64);
    for (const option of entry.options) integerOrNull(option, `${label}.options item`, -32768, 32767);
    boundedString(entry.predicateSql, `${label}.predicateSql`, 2048, true);
    integerOrNull(entry.predicateLength, `${label}.predicateLength`, 0, 1000000);
    if (indexKeys.has(entry.name)) fail("INVALID_SNAPSHOT", "catalog index is duplicated");
    indexKeys.add(entry.name);
  }

  boundedArray(snapshot.constraints, "catalog constraints", 17);
  const constraintKeys = new Set();
  for (const [index, entry] of snapshot.constraints.entries()) {
    const label = `catalog constraints[${index}]`;
    exactKeys(entry, [
      "name", "table", "type", "validated", "deferrable", "deferred", "local",
      "inheritanceCount", "noInherit", "hasParent", "columns", "referencedTable", "referencedTableSchema",
      "referencedColumns", "updateAction", "deleteAction", "matchType", "indexName",
      "expressionSql", "expressionLength",
    ], label);
    for (const key of ["name", "table", "type", "updateAction", "deleteAction", "matchType"]) {
      boundedString(entry[key], `${label}.${key}`, 63);
    }
    for (const key of ["referencedTable", "referencedTableSchema", "indexName"]) {
      boundedString(entry[key], `${label}.${key}`, 63, true);
    }
    for (const key of ["validated", "deferrable", "deferred", "local", "noInherit", "hasParent"]) {
      if (typeof entry[key] !== "boolean") fail("INVALID_SNAPSHOT", `${label}.${key} is invalid`);
    }
    integerOrNull(entry.inheritanceCount, `${label}.inheritanceCount`, 0, 10000);
    validateStringArray(entry.columns, `${label}.columns`, 32);
    validateStringArray(entry.referencedColumns, `${label}.referencedColumns`, 32);
    boundedString(entry.expressionSql, `${label}.expressionSql`, 1024, true);
    integerOrNull(entry.expressionLength, `${label}.expressionLength`, 0, 1000000);
    const key = `${entry.table}\u0000${entry.name}`;
    if (constraintKeys.has(key)) fail("INVALID_SNAPSHOT", "catalog constraint is duplicated");
    constraintKeys.add(key);
  }
  boundedArray(snapshot.activeIndexBuilds, "active index builds", 8);
  const activeBuildKeys = new Set();
  for (const [index, entry] of snapshot.activeIndexBuilds.entries()) {
    const label = `active index builds[${index}]`;
    exactKeys(entry, ["table", "count"], label);
    boundedString(entry.table, `${label}.table`, 63);
    integerOrNull(entry.count, `${label}.count`, 1, 10000);
    if (activeBuildKeys.has(entry.table)) fail("INVALID_SNAPSHOT", "active index build table is duplicated");
    activeBuildKeys.add(entry.table);
  }
  return snapshot;
}

export function parsePostClerkCatalogSnapshot(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(String(input), "utf8");
  if (bytes.length === 0 || bytes.length > MAX_CATALOG_SNAPSHOT_BYTES) {
    fail("INVALID_SNAPSHOT", "catalog snapshot byte length is invalid");
  }
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("INVALID_SNAPSHOT", "catalog snapshot is not valid JSON");
  }
  return validateSnapshot(parsed);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function sameArray(left, right) {
  return Array.isArray(left) && left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function exactExpression(value) {
  if (typeof value !== "string" || /[^\x20-\x7e]/u.test(value)) return null;
  return value.trim();
}

function fullExpression(entry, sqlKey, lengthKey) {
  if (entry[sqlKey] === null) return entry[lengthKey] === 0 ? null : undefined;
  return entry[lengthKey] === entry[sqlKey].length ? exactExpression(entry[sqlKey]) : undefined;
}

function defaultMatches(expected, observed) {
  if (observed.identity !== "" || observed.generated !== "") return false;
  const expression = fullExpression(observed, "defaultSql", "defaultLength");
  if (expected.defaultKind === "none") {
    return !observed.defaultPresent && expression === null;
  }
  if (!observed.defaultPresent || expression === null || expression === undefined) return false;
  const accepted = {
    "empty-text": ["''::text"],
    "integer-zero": ["0"],
    "boolean-false": ["false"],
    "current-timestamp": ["CURRENT_TIMESTAMP"],
    "empty-text-array": ["'{}'::text[]", "ARRAY[]::text[]"],
  }[expected.defaultKind];
  if (accepted) return accepted.includes(expression);
  if (expected.defaultKind.startsWith("enum:")) {
    const [, typeName, label] = expected.defaultKind.split(":");
    return expression === `'${label}'::"${typeName}"`;
  }
  return false;
}

function snapshotMaps(snapshot) {
  return {
    enums: new Map(snapshot.enums.map((entry) => [entry.name, entry])),
    relations: new Map(snapshot.relations.map((entry) => [entry.name, entry])),
    columns: new Map(snapshot.columns.map((entry) => [`${entry.table}\u0000${entry.name}`, entry])),
    indexes: new Map(snapshot.indexes.map((entry) => [entry.name, entry])),
    constraints: new Map(snapshot.constraints.map((entry) => [`${entry.table}\u0000${entry.name}`, entry])),
    activeIndexBuilds: new Map(snapshot.activeIndexBuilds.map((entry) => [entry.table, entry.count])),
    progressVisibilityComplete: snapshot.progressVisibilityComplete,
  };
}

function observedColumn(maps, expected) {
  return maps.columns.get(`${expected.table}\u0000${expected.name}`);
}

function expectedTypeSchema(expected, snapshot) {
  return expected.typeSchema === "current" ? snapshot.schema : expected.typeSchema;
}

function columnStructureMatches(expected, observed, snapshot) {
  return observed !== undefined &&
    observed.typeSchema === expectedTypeSchema(expected, snapshot) &&
    observed.typeName === expected.typeName &&
    observed.typeModifier === expected.typeModifier &&
    observed.arrayDimensions === expected.arrayDimensions &&
    observed.collationMatchesTypeDefault === true &&
    observed.identity === "" && observed.generated === "";
}

function columnMatches(expected, observed, snapshot) {
  return columnStructureMatches(expected, observed, snapshot) &&
    observed.notNull === expected.notNull &&
    defaultMatches(expected, observed);
}

function relationMatches(expected, observed) {
  return observed !== undefined && observed.kind === expected.kind &&
    observed.persistence === expected.persistence &&
    (expected.columnCount === null || observed.columnCount === expected.columnCount);
}

function enumMatches(expectedLabels, observed) {
  return observed !== undefined && observed.kind === "e" &&
    observed.labelCount === expectedLabels.length && sameArray(observed.labels, expectedLabels);
}

function indexStructureMatches(expected, observed, snapshot) {
  if (observed === undefined) return false;
  const predicate = fullExpression(observed, "predicateSql", "predicateLength");
  return observed.relationKind === "i" &&
    observed.table === expected.table && observed.tableSchema === snapshot.schema &&
    observed.method === "btree" &&
    observed.unique === expected.unique && observed.primary === expected.primary &&
    observed.exclusion === false && observed.immediate === true &&
    observed.clustered === false && observed.replicaIdentity === false &&
    observed.nullsNotDistinct === false &&
    observed.buildInProgress === false &&
    observed.keyCount === expected.columns.length &&
    observed.attributeCount === expected.columns.length &&
    sameArray(observed.columns, expected.columns) &&
    sameArray(observed.opclasses, expected.opclasses) &&
    sameArray(observed.options, expected.columns.map(() => 0)) &&
    observed.collationsMatchColumns === true &&
    predicate === expected.predicate;
}

function indexUsable(observed) {
  return observed?.valid === true && observed?.ready === true && observed?.live === true;
}

function constraintMatches(expected, observed, snapshot) {
  if (observed === undefined || observed.type !== expected.type ||
    observed.validated !== true || observed.deferrable !== false || observed.deferred !== false ||
    observed.local !== true || observed.inheritanceCount !== 0 ||
    observed.noInherit !== expected.noInherit ||
    observed.hasParent !== false ||
    !sameArray(observed.columns, expected.columns)) return false;

  if (expected.type === "f") {
    return observed.referencedTable === expected.referencedTable &&
      observed.referencedTableSchema === snapshot.schema &&
      sameArray(observed.referencedColumns, expected.referencedColumns) &&
      observed.updateAction === expected.updateAction &&
      observed.deleteAction === expected.deleteAction &&
      observed.matchType === expected.matchType &&
      observed.indexName === expected.indexName &&
      fullExpression(observed, "expressionSql", "expressionLength") === null;
  }
  if (expected.type === "p") {
    return observed.referencedTable === null && observed.referencedTableSchema === null &&
      sameArray(observed.referencedColumns, []) && observed.indexName === expected.indexName &&
      fullExpression(observed, "expressionSql", "expressionLength") === null;
  }
  return observed.referencedTable === null && observed.referencedTableSchema === null &&
    sameArray(observed.referencedColumns, []) && observed.indexName === null &&
    fullExpression(observed, "expressionSql", "expressionLength") === expected.expression;
}

function classification(classificationValue, reasonCodes, repairIndexes = []) {
  return {
    classification: classificationValue,
    reasonCodes: Object.freeze([...new Set(reasonCodes)]),
    repairIndexes: Object.freeze([...repairIndexes]),
  };
}

const CONVERSATION_TABLE_NAMES = Object.freeze(["Conversation", "ConversationMessage", "FollowUpTask"]);
const CONVERSATION_COLUMN_KEYS = new Set(contract.columns
  .filter((entry) => CONVERSATION_TABLE_NAMES.includes(entry.table) ||
    (entry.table === "OutreachArtifact" && [
      "purpose", "conversationId", "providerThreadId", "replyToMessageId",
    ].includes(entry.name)) ||
    (entry.table === "MeetingLedger" && ["conversationId", "sourceMessageId"].includes(entry.name)))
  .map((entry) => `${entry.table}\u0000${entry.name}`));
const CONVERSATION_INDEX_NAMES = new Set(contract.indexes.slice(1, 26).map((entry) => entry.name));

function targetRelationReady(maps, name) {
  const expected = contract.relations.find((entry) => entry.name === name);
  return relationMatches({ ...expected, columnCount: null }, maps.relations.get(name));
}

function activeIndexBuildOn(maps, tableNames) {
  return tableNames.some((name) => (maps.activeIndexBuilds.get(name) ?? 0) > 0);
}

function indexProgressEvidenceUnavailable(maps) {
  return maps.progressVisibilityComplete !== true;
}

function classifyArtifactUnique(snapshot, maps) {
  if (!targetRelationReady(maps, "OutreachArtifact")) {
    return classification("hold", ["TARGET_RELATION_MISSING_OR_WRONG"]);
  }
  if (indexProgressEvidenceUnavailable(maps)) {
    return classification("hold", ["INDEX_PROGRESS_VISIBILITY_INCOMPLETE"]);
  }
  if (activeIndexBuildOn(maps, ["OutreachArtifact"])) {
    return classification("hold", ["ACTIVE_INDEX_BUILD"]);
  }
  const expected = contract.indexes[0];
  const observed = maps.indexes.get(expected.name);
  if (!observed) return classification("absent", ["ABSENT_EXACT"]);
  if (!indexStructureMatches(expected, observed, snapshot)) {
    return classification("hold", ["SAME_NAME_DEFINITION_MISMATCH"]);
  }
  if (indexUsable(observed)) return classification("complete", ["COMPLETE_EXACT"]);
  if (observed.valid === false || observed.ready === false) {
    return classification("recoverable", ["EXACT_INTERRUPTED_INDEX_REPLAYABLE"]);
  }
  return classification("hold", ["INDEX_NOT_VALID_READY_LIVE"]);
}

function classifyConversationStore(snapshot, maps) {
  const ownedEnums = Object.entries(enums);
  const ownedRelations = contract.relations.filter((entry) => CONVERSATION_TABLE_NAMES.includes(entry.name));
  const ownedColumns = contract.columns.filter((entry) =>
    CONVERSATION_COLUMN_KEYS.has(`${entry.table}\u0000${entry.name}`));
  const ownedIndexes = contract.indexes.filter((entry) => CONVERSATION_INDEX_NAMES.has(entry.name));
  const ownedConstraints = contract.constraints;
  if (indexProgressEvidenceUnavailable(maps)) {
    return classification("hold", ["INDEX_PROGRESS_VISIBILITY_INCOMPLETE"]);
  }
  if (activeIndexBuildOn(maps, [
    "Integration", "OutreachArtifact", "Conversation", "ConversationMessage", "FollowUpTask", "MeetingLedger",
  ])) return classification("hold", ["ACTIVE_INDEX_BUILD"]);
  const anyPresent = ownedEnums.some(([name]) => maps.enums.has(name)) ||
    ownedRelations.some((entry) => maps.relations.has(entry.name)) ||
    ownedColumns.some((entry) => observedColumn(maps, entry) !== undefined) ||
    ownedIndexes.some((entry) => maps.indexes.has(entry.name)) ||
    ownedConstraints.some((entry) => maps.constraints.has(`${entry.table}\u0000${entry.name}`));

  if (!anyPresent) {
    if (["Integration", "OutreachArtifact", "MeetingLedger"].every((name) => targetRelationReady(maps, name))) {
      return classification("absent", ["ABSENT_EXACT"]);
    }
    return classification("hold", ["TARGET_RELATION_MISSING_OR_WRONG"]);
  }

  // The production predecessor contains a known, empty 13-column
  // Conversation table. The migration itself verifies its complete catalog
  // signature and row count before renaming it, so the catalog-only planner
  // may classify that precise predecessor shape as eligible to apply. Exact
  // compatible additive columns on existing tables are also allowed because
  // the migration uses ADD COLUMN IF NOT EXISTS and the post-image is checked
  // again before the next step.
  const legacyConversation = maps.relations.get("Conversation");
  const legacyOnly = relationMatches({
    name: "Conversation",
    kind: "r",
    persistence: "p",
    columnCount: 13,
  }, legacyConversation) &&
    !maps.relations.has("ConversationMessage") &&
    !maps.relations.has("FollowUpTask") &&
    ownedEnums.every(([name]) => !maps.enums.has(name)) &&
    ownedColumns.filter((entry) => entry.table !== "Conversation").every((entry) => {
      const observed = observedColumn(maps, entry);
      return observed === undefined || columnMatches(entry, observed, snapshot);
    }) &&
    ownedIndexes.every((entry) => {
      const observed = maps.indexes.get(entry.name);
      if (observed === undefined) return true;
      return entry.name === "Conversation_pkey";
    }) &&
    ownedConstraints.every((entry) => {
      const observed = maps.constraints.get(`${entry.table}\u0000${entry.name}`);
      if (observed === undefined) return true;
      return entry.name === "Conversation_pkey" || entry.name === "Conversation_orgId_fkey";
    });
  if (legacyOnly) return classification("absent", ["ABSENT_EXACT"]);

  const exact = ownedEnums.every(([name, labels]) => enumMatches(labels, maps.enums.get(name))) &&
    ownedRelations.every((entry) => relationMatches(entry, maps.relations.get(entry.name))) &&
    ownedColumns.every((entry) => columnMatches(entry, observedColumn(maps, entry), snapshot)) &&
    ownedIndexes.every((entry) => indexStructureMatches(entry, maps.indexes.get(entry.name), snapshot) &&
      indexUsable(maps.indexes.get(entry.name))) &&
    ownedConstraints.every((entry) => constraintMatches(
      entry,
      maps.constraints.get(`${entry.table}\u0000${entry.name}`),
      snapshot,
    ));
  return exact
    ? classification("complete", ["COMPLETE_EXACT"])
    : classification("hold", ["ATOMIC_MIGRATION_PARTIAL_OR_MISMATCH"]);
}

function outreachStatusLabels(maps) {
  const observed = maps.enums.get("OutreachArtifactStatus");
  if (observed?.kind !== "e" || observed.labelCount !== observed.labels.length) return null;
  return observed.labels;
}

function classifyDeliveryUnknown(_snapshot, maps) {
  const labels = outreachStatusLabels(maps);
  if (labels === null) return classification("hold", ["STATUS_ENUM_MISSING_OR_WRONG"]);
  if (sameArray(labels, BASE_OUTREACH_STATUS_LABELS)) {
    return classification("absent", ["ABSENT_EXACT"]);
  }
  const afterDelivery = [...BASE_OUTREACH_STATUS_LABELS, "DELIVERY_UNKNOWN"];
  const afterFailed = [...afterDelivery, "FAILED"];
  if (sameArray(labels, afterDelivery) || sameArray(labels, afterFailed)) {
    return classification("complete", ["COMPLETE_EXACT"]);
  }
  return classification("hold", ["STATUS_ENUM_ORDER_OR_LABEL_MISMATCH"]);
}

function classifyArtifactFailed(snapshot, maps) {
  if (!targetRelationReady(maps, "OutreachArtifact")) {
    return classification("hold", ["TARGET_RELATION_MISSING_OR_WRONG"]);
  }
  const labels = outreachStatusLabels(maps);
  if (labels === null) return classification("hold", ["STATUS_ENUM_MISSING_OR_WRONG"]);
  const expectedColumns = contract.columns.filter((entry) =>
    entry.table === "OutreachArtifact" && ["failureReason", "failedAt"].includes(entry.name));
  const presentColumns = expectedColumns.filter((entry) => observedColumn(maps, entry) !== undefined);
  const beforeFailed = sameArray(labels, BASE_OUTREACH_STATUS_LABELS) ||
    sameArray(labels, [...BASE_OUTREACH_STATUS_LABELS, "DELIVERY_UNKNOWN"]);
  if (beforeFailed && presentColumns.length === 0) return classification("absent", ["ABSENT_EXACT"]);

  const afterFailed = [...BASE_OUTREACH_STATUS_LABELS, "DELIVERY_UNKNOWN", "FAILED"];
  if (!sameArray(labels, afterFailed)) {
    return classification("hold", ["STATUS_ENUM_ORDER_OR_LABEL_MISMATCH"]);
  }
  if (presentColumns.some((entry) => !columnMatches(entry, observedColumn(maps, entry), snapshot))) {
    return classification("hold", ["SAME_NAME_DEFINITION_MISMATCH"]);
  }
  if (presentColumns.length === expectedColumns.length) {
    return classification("complete", ["COMPLETE_EXACT"]);
  }
  return classification("recoverable", ["ENUM_COMMITTED_COLUMNS_REPLAYABLE"]);
}

function classifyReplySingleFlight(snapshot, maps) {
  if (!targetRelationReady(maps, "OutreachArtifact")) {
    return classification("hold", ["TARGET_RELATION_MISSING_OR_WRONG"]);
  }
  if (indexProgressEvidenceUnavailable(maps)) {
    return classification("hold", ["INDEX_PROGRESS_VISIBILITY_INCOMPLETE"]);
  }
  if (activeIndexBuildOn(maps, ["OutreachArtifact"])) {
    return classification("hold", ["ACTIVE_INDEX_BUILD"]);
  }
  const expectedIndexes = contract.indexes.filter((entry) => REPLY_REPAIR_INDEXES.includes(entry.name));
  const present = expectedIndexes
    .map((expected) => ({ expected, observed: maps.indexes.get(expected.name) }))
    .filter(({ observed }) => observed !== undefined);
  if (present.length === 0) return classification("absent", ["ABSENT_EXACT"]);
  if (present.some(({ expected, observed }) => !indexStructureMatches(expected, observed, snapshot))) {
    return classification("hold", ["SAME_NAME_DEFINITION_MISMATCH"]);
  }
  if (present.length === expectedIndexes.length && present.every(({ observed }) => indexUsable(observed))) {
    return classification("complete", ["COMPLETE_EXACT"]);
  }
  return classification(
    "repairable",
    ["EXACT_REPLY_INDEX_SUBSET_REPAIR"],
    present.map(({ expected }) => expected.name),
  );
}

function classifyGraphActivity(snapshot, maps) {
  if (!targetRelationReady(maps, "GraphRun")) {
    return classification("hold", ["TARGET_RELATION_MISSING_OR_WRONG"]);
  }
  if (indexProgressEvidenceUnavailable(maps)) {
    return classification("hold", ["INDEX_PROGRESS_VISIBILITY_INCOMPLETE"]);
  }
  if (activeIndexBuildOn(maps, ["GraphRun"])) {
    return classification("hold", ["ACTIVE_INDEX_BUILD"]);
  }
  const expectedColumn = contract.columns.find((entry) =>
    entry.table === "GraphRun" && entry.name === "lastActivityAt");
  const expectedIndex = contract.indexes.find((entry) => entry.name === "GraphRun_status_lastActivityAt_idx");
  const observedColumnEntry = observedColumn(maps, expectedColumn);
  const observedIndex = maps.indexes.get(expectedIndex.name);
  if (!observedColumnEntry && !observedIndex) return classification("absent", ["ABSENT_EXACT"]);
  if (!observedColumnEntry || !columnStructureMatches(expectedColumn, observedColumnEntry, snapshot)) {
    return classification("hold", ["SAME_NAME_DEFINITION_MISMATCH"]);
  }
  if (observedIndex && !indexStructureMatches(expectedIndex, observedIndex, snapshot)) {
    return classification("hold", ["SAME_NAME_DEFINITION_MISMATCH"]);
  }
  if (columnMatches(expectedColumn, observedColumnEntry, snapshot) && observedIndex && indexUsable(observedIndex)) {
    return classification("complete", ["COMPLETE_EXACT"]);
  }
  if (observedIndex) return classification("hold", ["INDEX_NOT_VALID_READY_LIVE"]);
  return classification("recoverable", ["ACTIVITY_COLUMN_REPLAYABLE"]);
}

function classifyGraphLifecycle(snapshot, maps) {
  if (!targetRelationReady(maps, "GraphRun")) {
    return classification("hold", ["TARGET_RELATION_MISSING_OR_WRONG"]);
  }
  if (indexProgressEvidenceUnavailable(maps)) {
    return classification("hold", ["INDEX_PROGRESS_VISIBILITY_INCOMPLETE"]);
  }
  if (activeIndexBuildOn(maps, ["GraphRun"])) {
    return classification("hold", ["ACTIVE_INDEX_BUILD"]);
  }
  const expectedColumns = contract.columns.filter((entry) =>
    entry.table === "GraphRun" && entry.name !== "lastActivityAt");
  const expectedIndex = contract.indexes.find((entry) => entry.name === "GraphRun_one_active_per_org_key");
  const presentColumns = expectedColumns.filter((entry) => observedColumn(maps, entry) !== undefined);
  const observedIndex = maps.indexes.get(expectedIndex.name);
  if (presentColumns.length === 0 && !observedIndex) return classification("absent", ["ABSENT_EXACT"]);
  if (presentColumns.some((entry) => !columnMatches(entry, observedColumn(maps, entry), snapshot)) ||
    (observedIndex && !indexStructureMatches(expectedIndex, observedIndex, snapshot))) {
    return classification("hold", ["SAME_NAME_DEFINITION_MISMATCH"]);
  }
  if (presentColumns.length === expectedColumns.length && observedIndex && indexUsable(observedIndex)) {
    return classification("complete", ["COMPLETE_EXACT"]);
  }
  return classification("recoverable", ["EXACT_PARTIAL_LIFECYCLE_REPLAYABLE"]);
}

function classifyIcpExclusionDomains(snapshot, maps) {
  if (!targetRelationReady(maps, "IcpProfile")) {
    return classification("hold", ["TARGET_RELATION_MISSING_OR_WRONG"]);
  }
  const expectedColumn = contract.columns.find((entry) =>
    entry.table === "IcpProfile" && entry.name === "exclusionDomains");
  const observed = observedColumn(maps, expectedColumn);
  if (!observed) return classification("absent", ["ABSENT_EXACT"]);
  if (!columnMatches(expectedColumn, observed, snapshot)) {
    return classification("hold", ["SAME_NAME_DEFINITION_MISMATCH"]);
  }
  return classification("complete", ["COMPLETE_EXACT"]);
}

export function decidePostClerkMigration({ path, classification: state, repairIndexes = [] }) {
  if (!POST_CLERK_MIGRATIONS.includes(path)) {
    fail("INVALID_DECISION_INPUT", "migration path is not in the reviewed post-Clerk sequence");
  }
  if (!["complete", "absent", "recoverable", "repairable", "hold"].includes(state)) {
    fail("INVALID_DECISION_INPUT", "migration classification is invalid");
  }
  const action = {
    complete: "adopt",
    absent: "apply",
    recoverable: "replay",
    repairable: "repair",
    hold: "hold",
  }[state];
  if (state === "repairable" && path !== POST_CLERK_MIGRATIONS[4]) {
    fail("INVALID_DECISION_INPUT", "only reply single-flight has a bounded repair decision");
  }
  if (!Array.isArray(repairIndexes) ||
    repairIndexes.some((name, index) => !REPLY_REPAIR_INDEXES.includes(name) ||
      repairIndexes.indexOf(name) !== index ||
      (index > 0 && REPLY_REPAIR_INDEXES.indexOf(repairIndexes[index - 1]) >=
        REPLY_REPAIR_INDEXES.indexOf(name))) ||
    (state === "repairable" && repairIndexes.length === 0) ||
    (state !== "repairable" && repairIndexes.length !== 0)) {
    fail("INVALID_DECISION_INPUT", "repair indexes are not the exact classified fixed-name subset");
  }
  return Object.freeze({
    action,
    lostAckAdopted: state === "complete",
    repairIndexes: state === "repairable" ? Object.freeze([...repairIndexes]) : Object.freeze([]),
  });
}

export function classifyPostClerkMigrationCatalog(snapshotInput) {
  const snapshot = validateSnapshot(snapshotInput);
  const maps = snapshotMaps(snapshot);
  const results = [
    classifyArtifactUnique(snapshot, maps),
    classifyConversationStore(snapshot, maps),
    classifyDeliveryUnknown(snapshot, maps),
    classifyArtifactFailed(snapshot, maps),
    classifyReplySingleFlight(snapshot, maps),
    classifyGraphActivity(snapshot, maps),
    classifyGraphLifecycle(snapshot, maps),
    classifyIcpExclusionDomains(snapshot, maps),
  ];
  const migrationReports = POST_CLERK_MIGRATIONS.map((path, index) => {
    const result = results[index];
    const decision = decidePostClerkMigration({
      path,
      classification: result.classification,
      repairIndexes: result.repairIndexes,
    });
    return Object.freeze({
      path,
      classification: result.classification,
      action: decision.action,
      lostAckAdopted: decision.lostAckAdopted,
      repairIndexes: decision.repairIndexes,
      reasonCodes: result.reasonCodes,
    });
  });
  const overall = migrationReports.every((entry) => entry.classification === "complete")
    ? "complete"
    : migrationReports.some((entry) => entry.classification === "hold") ? "hold" : "incomplete";
  const body = {
    schemaVersion: 1,
    kind: CATALOG_REPORT_KIND,
    contractVersion: POST_CLERK_CATALOG_CONTRACT_VERSION,
    contractHash: POST_CLERK_CATALOG_CONTRACT_HASH,
    migrationContractHash: POST_CLERK_MIGRATION_CONTRACT_HASH,
    catalogHash: sha256(canonicalJson(snapshot)),
    overall,
    migrations: migrationReports,
  };
  const report = Object.freeze({
    ...body,
    evidenceHash: sha256(canonicalJson(body)),
  });
  if (Buffer.byteLength(JSON.stringify(report), "utf8") > MAX_CATALOG_REPORT_BYTES) {
    fail("REPORT_TOO_LARGE", "catalog report exceeded its fixed byte limit");
  }
  return report;
}

function validateCatalogReport(report) {
  exactKeys(report, [
    "schemaVersion", "kind", "contractVersion", "contractHash", "migrationContractHash", "catalogHash",
    "overall", "migrations", "evidenceHash",
  ],
    "catalog report");
  if (report.schemaVersion !== 1 || report.kind !== CATALOG_REPORT_KIND ||
    report.contractVersion !== POST_CLERK_CATALOG_CONTRACT_VERSION ||
    report.contractHash !== POST_CLERK_CATALOG_CONTRACT_HASH ||
    report.migrationContractHash !== POST_CLERK_MIGRATION_CONTRACT_HASH ||
    !/^sha256:[0-9a-f]{64}$/u.test(report.catalogHash) ||
    !/^sha256:[0-9a-f]{64}$/u.test(report.evidenceHash) ||
    !["complete", "incomplete", "hold"].includes(report.overall) ||
    !Array.isArray(report.migrations) || report.migrations.length !== POST_CLERK_MIGRATIONS.length) {
    fail("INVALID_REPORT", "catalog report identity is invalid");
  }
  for (const [index, entry] of report.migrations.entries()) {
    if (!isPlainObject(entry) || entry.path !== POST_CLERK_MIGRATIONS[index] ||
      !["complete", "absent", "recoverable", "repairable", "hold"].includes(entry.classification)) {
      fail("INVALID_REPORT", "catalog report migration is invalid");
    }
  }
  const { evidenceHash, ...body } = report;
  if (sha256(canonicalJson(body)) !== evidenceHash) {
    fail("INVALID_REPORT", "catalog report evidence hash is invalid");
  }
  return report;
}

/**
 * Turn a classified snapshot into the controller's bounded prefix decision.
 * persistedPrefixLength counts completed post-Clerk migrations (0..7).
 */
export function planPostClerkMigrationCatalog(reportInput, persistedPrefixLength, admittedMigrations) {
  const report = validateCatalogReport(reportInput);
  if (!Number.isSafeInteger(persistedPrefixLength) || persistedPrefixLength < 0 ||
    persistedPrefixLength > POST_CLERK_MIGRATIONS.length) {
    fail("INVALID_PREFIX", "persisted post-Clerk prefix length is invalid");
  }
  if (!Array.isArray(admittedMigrations) || admittedMigrations.length !== POST_CLERK_MIGRATIONS.length ||
    admittedMigrations.some((entry, index) => !isPlainObject(entry) ||
      Object.keys(entry).length !== 2 || entry.path !== POST_CLERK_MIGRATIONS[index] ||
      entry.sha256 !== POST_CLERK_MIGRATION_CONTRACT[index].sha256)) {
    fail("INVALID_ADMITTED_MIGRATIONS", "admitted migration path and SHA sequence is invalid");
  }
  const prefixDrift = report.migrations
    .slice(0, persistedPrefixLength)
    .find((entry) => entry.classification !== "complete");
  const laterDrift = report.migrations
    .slice(Math.min(persistedPrefixLength + 1, POST_CLERK_MIGRATIONS.length))
    .find((entry) => entry.classification !== "absent");
  const next = report.migrations[persistedPrefixLength] ?? null;

  let outcome;
  let reasonCode;
  let nextPath = next?.path ?? null;
  let nextClassification = next?.classification ?? "complete";
  let action = next?.action ?? "complete";
  let lostAckAdopted = next?.lostAckAdopted ?? false;
  let repairIndexes = next?.repairIndexes ?? Object.freeze([]);
  if (prefixDrift) {
    outcome = "hold";
    reasonCode = "PERSISTED_PREFIX_NOT_COMPLETE";
    nextPath = prefixDrift.path;
    nextClassification = prefixDrift.classification;
    action = "hold";
    lostAckAdopted = false;
    repairIndexes = Object.freeze([]);
  } else if (laterDrift) {
    outcome = "hold";
    reasonCode = "OUT_OF_ORDER_LATER_MIGRATION_STATE";
    nextPath = laterDrift.path;
    nextClassification = laterDrift.classification;
    action = "hold";
    lostAckAdopted = false;
    repairIndexes = Object.freeze([]);
  } else if (next === null) {
    outcome = "complete";
    reasonCode = "SEQUENCE_COMPLETE";
  } else {
    outcome = next.classification === "hold" ? "hold" : "ready";
    reasonCode = next.reasonCodes[0];
  }
  const body = {
    schemaVersion: 1,
    kind: "production-post-clerk-migration-plan",
    persistedPrefixLength,
    contractHash: POST_CLERK_CATALOG_CONTRACT_HASH,
    migrationContractHash: POST_CLERK_MIGRATION_CONTRACT_HASH,
    admittedSequenceHash: sha256(canonicalJson(admittedMigrations)),
    catalogEvidenceHash: report.evidenceHash,
    outcome,
    reasonCode,
    nextPath,
    nextMigrationSha256: nextPath === null
      ? null
      : admittedMigrations[POST_CLERK_MIGRATIONS.indexOf(nextPath)].sha256,
    nextClassification,
    action,
    lostAckAdopted,
    repairIndexes,
  };
  return Object.freeze({ ...body, evidenceHash: sha256(canonicalJson(body)) });
}

/** queryCatalog receives POST_CLERK_CATALOG_QUERY and returns its one JSON row. */
export function verifyPostClerkMigrationCatalog({ queryCatalog }) {
  if (typeof queryCatalog !== "function") {
    fail("INVALID_QUERY_RUNNER", "queryCatalog callback is required");
  }
  const rawSnapshot = queryCatalog(POST_CLERK_CATALOG_QUERY);
  if (rawSnapshot && typeof rawSnapshot.then === "function") {
    fail("INVALID_QUERY_RUNNER", "queryCatalog must be synchronous");
  }
  return classifyPostClerkMigrationCatalog(parsePostClerkCatalogSnapshot(rawSnapshot));
}

function assertProtectedPostgresEnvironment() {
  for (const name of ["PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGSSLMODE", "PGPASSFILE"]) {
    const value = process.env[name];
    if (typeof value !== "string" || value.length === 0 || value.length > 1024 || /[\r\n\u0000]/u.test(value)) {
      fail("PROTECTED_POSTGRES_ENVIRONMENT_REQUIRED", `protected PostgreSQL variable ${name} is invalid`);
    }
  }
  if (!/^\d{1,5}$/u.test(process.env.PGPORT) || Number(process.env.PGPORT) > 65535) {
    fail("PROTECTED_POSTGRES_ENVIRONMENT_REQUIRED", "protected PostgreSQL port is invalid");
  }
  if (process.env.PGSSLMODE === "verify-full" && process.env.PGSSLROOTCERT !== "system") {
    fail("PROTECTED_POSTGRES_ENVIRONMENT_REQUIRED", "verify-full requires the system trust store");
  }
  const passfile = process.env.PGPASSFILE;
  if (!isAbsolute(passfile)) {
    fail("PROTECTED_POSTGRES_ENVIRONMENT_REQUIRED", "PGPASSFILE must be absolute");
  }
  let stat;
  try {
    stat = lstatSync(passfile);
  } catch {
    fail("PROTECTED_POSTGRES_ENVIRONMENT_REQUIRED", "PGPASSFILE is unavailable");
  }
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) {
    fail("PROTECTED_POSTGRES_ENVIRONMENT_REQUIRED", "PGPASSFILE must be a regular 0600 file");
  }
}

function queryCatalogWithPsql() {
  assertProtectedPostgresEnvironment();
  const result = spawnSync("psql", [
    "--no-psqlrc",
    "--set=ON_ERROR_STOP=1",
    "--single-transaction",
    "--quiet",
    "--tuples-only",
    "--no-align",
    "--command",
    POST_CLERK_CATALOG_QUERY,
  ], {
    encoding: null,
    timeout: 20000,
    maxBuffer: MAX_CATALOG_SNAPSHOT_BYTES,
    env: {
      ...process.env,
      PGAPPNAME: "workforce-post-clerk-catalog-verifier",
      PGCONNECT_TIMEOUT: "5",
      PGOPTIONS: "-c default_transaction_read_only=on -c default_transaction_isolation=repeatable\\ read " +
        "-c search_path=pg_catalog,public -c statement_timeout=15000 -c lock_timeout=2000",
    },
  });
  if (result.error || result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
    fail("CATALOG_QUERY_FAILED", "PostgreSQL catalog query failed");
  }
  return result.stdout;
}

async function readBoundedStdin() {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > MAX_CATALOG_SNAPSHOT_BYTES) {
      fail("INVALID_SNAPSHOT", "catalog snapshot byte length is invalid");
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, length);
}

async function cliMain() {
  try {
    let report;
    if (process.argv.length === 2) {
      report = verifyPostClerkMigrationCatalog({ queryCatalog: queryCatalogWithPsql });
    } else if (process.argv.length === 3 && process.argv[2] === "--snapshot-stdin") {
      report = classifyPostClerkMigrationCatalog(
        parsePostClerkCatalogSnapshot(await readBoundedStdin()),
      );
    } else {
      fail("INVALID_ARGUMENTS", "expected no arguments or --snapshot-stdin");
    }
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } catch (error) {
    const errorCode = error instanceof CatalogVerifierError ? error.code : "VERIFIER_FAILED";
    process.stderr.write(`${JSON.stringify({
      schemaVersion: 1,
      kind: "production-post-clerk-migration-catalog-error",
      errorCode,
    })}\n`);
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await cliMain();
