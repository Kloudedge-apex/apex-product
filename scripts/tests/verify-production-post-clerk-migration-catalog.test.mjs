import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  CATALOG_SNAPSHOT_KIND,
  MAX_CATALOG_SNAPSHOT_BYTES,
  POST_CLERK_CATALOG_CONTRACT,
  POST_CLERK_CATALOG_CONTRACT_HASH,
  POST_CLERK_CATALOG_QUERY,
  POST_CLERK_CATALOG_TRANSACTION,
  POST_CLERK_MIGRATION_CONTRACT,
  POST_CLERK_MIGRATION_CONTRACT_HASH,
  POST_CLERK_MIGRATIONS,
  REPLY_REPAIR_INDEXES,
  classifyPostClerkMigrationCatalog,
  decidePostClerkMigration,
  parsePostClerkCatalogSnapshot,
  planPostClerkMigrationCatalog,
  verifyPostClerkMigrationCatalog,
} from "../verify-production-post-clerk-migration-catalog.mjs";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const VERIFIER = resolve(TEST_DIR, "../verify-production-post-clerk-migration-catalog.mjs");
const BASE_STATUS_LABELS = [
  "DRAFT", "PENDING_REVIEW", "APPROVED", "REJECTED", "SENT", "SUPPRESSED", "SENDING", "SIMULATED",
];
const REPO_ROOT = resolve(TEST_DIR, "../..");
const ADMITTED_MIGRATIONS = structuredClone(POST_CLERK_MIGRATION_CONTRACT);

function defaultSql(kind) {
  if (kind === "none") return null;
  if (kind === "empty-text") return "''::text";
  if (kind === "integer-zero") return "0";
  if (kind === "boolean-false") return "false";
  if (kind === "current-timestamp") return "CURRENT_TIMESTAMP";
  if (kind === "empty-text-array") return "'{}'::text[]";
  const [, typeName, label] = kind.split(":");
  return `'${label}'::"${typeName}"`;
}

function completeSnapshot() {
  const snapshot = {
    schemaVersion: 1,
    kind: CATALOG_SNAPSHOT_KIND,
    postgresMajor: 16,
    schema: "public",
    progressVisibilityComplete: true,
    enums: [
      ...Object.entries(POST_CLERK_CATALOG_CONTRACT.enums).map(([name, labels]) => ({
        name, kind: "e", labelCount: labels.length, labels: [...labels],
      })),
      {
        name: "OutreachArtifactStatus",
        kind: "e",
        labelCount: BASE_STATUS_LABELS.length + 2,
        labels: [...BASE_STATUS_LABELS, "DELIVERY_UNKNOWN", "FAILED"],
      },
    ],
    relations: POST_CLERK_CATALOG_CONTRACT.relations.map((entry) => ({
      name: entry.name,
      kind: entry.kind,
      persistence: entry.persistence,
      columnCount: entry.columnCount ?? 20,
    })),
    columns: POST_CLERK_CATALOG_CONTRACT.columns.map((entry) => {
      const sql = defaultSql(entry.defaultKind);
      return {
        table: entry.table,
        name: entry.name,
        typeSchema: entry.typeSchema === "current" ? "public" : entry.typeSchema,
        typeName: entry.typeName,
        typeModifier: entry.typeModifier,
        arrayDimensions: entry.arrayDimensions,
        collationMatchesTypeDefault: true,
        notNull: entry.notNull,
        identity: "",
        generated: "",
        defaultPresent: sql !== null,
        defaultSql: sql,
        defaultLength: sql?.length ?? 0,
      };
    }),
    indexes: POST_CLERK_CATALOG_CONTRACT.indexes.map((entry) => ({
      name: entry.name,
      relationKind: "i",
      table: entry.table,
      tableSchema: "public",
      method: "btree",
      unique: entry.unique,
      primary: entry.primary,
      exclusion: false,
      immediate: true,
      valid: true,
      ready: true,
      live: true,
      clustered: false,
      replicaIdentity: false,
      nullsNotDistinct: false,
      keyCount: entry.columns.length,
      attributeCount: entry.columns.length,
      columns: [...entry.columns],
      opclasses: [...entry.opclasses],
      options: entry.columns.map(() => 0),
      collationsMatchColumns: true,
      predicateSql: entry.predicate,
      predicateLength: entry.predicate?.length ?? 0,
      buildInProgress: false,
    })),
    constraints: POST_CLERK_CATALOG_CONTRACT.constraints.map((entry) => ({
      name: entry.name,
      table: entry.table,
      type: entry.type,
      validated: true,
      deferrable: false,
      deferred: false,
      local: true,
      inheritanceCount: 0,
      noInherit: entry.noInherit,
      hasParent: false,
      columns: [...entry.columns],
      referencedTable: entry.referencedTable,
      referencedTableSchema: entry.referencedTable ? "public" : null,
      referencedColumns: [...entry.referencedColumns],
      updateAction: entry.updateAction,
      deleteAction: entry.deleteAction,
      matchType: entry.matchType,
      indexName: entry.type === "c" ? null : entry.indexName,
      expressionSql: entry.expression,
      expressionLength: entry.expression?.length ?? 0,
    })),
    activeIndexBuilds: [],
  };
  return structuredClone(snapshot);
}

function reportEntry(report, path) {
  return report.migrations.find((entry) => entry.path === path);
}

function byName(items, name) {
  const result = items.find((entry) => entry.name === name);
  assert.ok(result, `missing fixture item ${name}`);
  return result;
}

function initialPostClerkSnapshot({ artifactIndex = false } = {}) {
  const snapshot = completeSnapshot();
  const conversationTables = new Set(["Conversation", "ConversationMessage", "FollowUpTask"]);
  const conversationEnums = new Set(Object.keys(POST_CLERK_CATALOG_CONTRACT.enums));
  snapshot.enums = snapshot.enums.filter((entry) => !conversationEnums.has(entry.name));
  byName(snapshot.enums, "OutreachArtifactStatus").labels = [...BASE_STATUS_LABELS];
  byName(snapshot.enums, "OutreachArtifactStatus").labelCount = BASE_STATUS_LABELS.length;
  snapshot.relations = snapshot.relations.filter((entry) => !conversationTables.has(entry.name));
  snapshot.columns = snapshot.columns.filter((entry) =>
    !conversationTables.has(entry.table) &&
    !(entry.table === "OutreachArtifact" && [
      "purpose", "conversationId", "providerThreadId", "replyToMessageId", "failureReason", "failedAt",
    ].includes(entry.name)) &&
    !(entry.table === "MeetingLedger" && ["conversationId", "sourceMessageId"].includes(entry.name)) &&
    entry.table !== "GraphRun" &&
    !(entry.table === "IcpProfile" && entry.name === "exclusionDomains"));
  snapshot.indexes = snapshot.indexes.filter((entry) =>
    artifactIndex && entry.name === "OutreachArtifact_idempotency_uniq");
  snapshot.constraints = [];
  return snapshot;
}

test("the verifier fixes the eight migrations after Clerk in reviewed order", () => {
  assert.deepEqual(POST_CLERK_MIGRATIONS, [
    "docs/migrations/2026-06-01_outreach-artifact-unique.sql",
    "docs/migrations/2026-08-12_conversation-store-expand.sql",
    "docs/migrations/2026-08-12_outreach-delivery-unknown-expand.sql",
    "docs/migrations/2026-08-13_outreach-artifact-failed-expand.sql",
    "docs/migrations/2026-08-12_conversation-reply-single-flight-expand.sql",
    "docs/migrations/2026-08-12_graph-run-activity-expand.sql",
    "docs/migrations/2026-08-12_graph-run-lifecycle-expand.sql",
    "docs/migrations/2026-08-20_icp-exclusion-domains-expand.sql",
  ]);
  assert.deepEqual(POST_CLERK_MIGRATION_CONTRACT.map((entry) => entry.path), POST_CLERK_MIGRATIONS);
  for (const entry of POST_CLERK_MIGRATION_CONTRACT) {
    const actual = `sha256:${createHash("sha256")
      .update(readFileSync(resolve(REPO_ROOT, entry.path)))
      .digest("hex")}`;
    assert.equal(actual, entry.sha256, `${entry.path} bytes drifted from the reviewed contract`);
  }
  assert.match(POST_CLERK_MIGRATION_CONTRACT_HASH, /^sha256:[0-9a-f]{64}$/u);
});

test("the catalog query is bounded, catalog-only, and contains no mutation", () => {
  assert.ok(Buffer.byteLength(POST_CLERK_CATALOG_QUERY) < 64 * 1024);
  assert.doesNotMatch(POST_CLERK_CATALOG_QUERY, /\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE)\b/iu);
  for (const table of ["OutreachArtifact", "Conversation", "ConversationMessage", "FollowUpTask", "GraphRun", "IcpProfile"]) {
    assert.doesNotMatch(POST_CLERK_CATALOG_QUERY, new RegExp(`(?:FROM|JOIN)\\s+"${table}"`, "iu"));
  }
  assert.match(POST_CLERK_CATALOG_QUERY, /pg_catalog\.pg_index/u);
  assert.match(POST_CLERK_CATALOG_QUERY, /indisvalid/u);
  assert.match(POST_CLERK_CATALOG_QUERY, /indisready/u);
  assert.match(POST_CLERK_CATALOG_QUERY, /indislive/u);
  assert.equal(POST_CLERK_CATALOG_TRANSACTION.searchPath, "pg_catalog,public");
});

test("hostile public left and length functions cannot shadow catalog inspection", () => {
  assert.match(POST_CLERK_CATALOG_QUERY, /pg_catalog\.left\(pg_catalog\.pg_get_expr/u);
  assert.match(POST_CLERK_CATALOG_QUERY, /pg_catalog\.length\(pg_catalog\.pg_get_expr/u);
  assert.doesNotMatch(POST_CLERK_CATALOG_QUERY, /(?<!pg_catalog\.)\bleft\(/u);
  assert.doesNotMatch(POST_CLERK_CATALOG_QUERY, /(?<!pg_catalog\.)\blength\(/u);
  assert.doesNotMatch(POST_CLERK_CATALOG_QUERY, /current_schema\s*\(/u);
  const source = readFileSync(VERIFIER, "utf8");
  assert.match(source, /search_path=pg_catalog,public/u);
  assert.doesNotMatch(source, /search_path=public,pg_catalog/u);
});

test("an exact complete catalog classifies all eight migrations complete", () => {
  const report = classifyPostClerkMigrationCatalog(completeSnapshot());
  assert.equal(report.overall, "complete");
  assert.deepEqual(report.migrations.map((entry) => entry.classification), Array(8).fill("complete"));
  assert.deepEqual(report.migrations.map((entry) => entry.action), Array(8).fill("adopt"));
  assert.ok(report.migrations.every((entry) => entry.lostAckAdopted));
  assert.match(report.catalogHash, /^sha256:[0-9a-f]{64}$/u);
  assert.match(report.evidenceHash, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(report.contractHash, POST_CLERK_CATALOG_CONTRACT_HASH);
  assert.equal(report.migrationContractHash, POST_CLERK_MIGRATION_CONTRACT_HASH);
  assert.doesNotMatch(JSON.stringify(report), /(?:predicateSql|defaultSql|expressionSql)/u);
});

test("a clean initial post-Clerk catalog is absent for every later migration", () => {
  const report = classifyPostClerkMigrationCatalog(initialPostClerkSnapshot());
  assert.deepEqual(report.migrations.map((entry) => entry.classification), Array(8).fill("absent"));
  assert.deepEqual(report.migrations.map((entry) => entry.action), Array(8).fill("apply"));
});

test("lost acknowledgement adopts only an exact complete next migration", () => {
  const report = classifyPostClerkMigrationCatalog(initialPostClerkSnapshot({ artifactIndex: true }));
  assert.equal(report.migrations[0].classification, "complete");
  assert.ok(report.migrations.slice(1).every((entry) => entry.classification === "absent"));
  const plan = planPostClerkMigrationCatalog(report, 0, ADMITTED_MIGRATIONS);
  assert.equal(plan.outcome, "ready");
  assert.equal(plan.action, "adopt");
  assert.equal(plan.lostAckAdopted, true);
  assert.equal(plan.nextPath, POST_CLERK_MIGRATIONS[0]);
  assert.equal(plan.nextMigrationSha256, ADMITTED_MIGRATIONS[0].sha256);
});

test("same-name idempotency index with any wrong definition holds even when invalid", () => {
  const snapshot = initialPostClerkSnapshot({ artifactIndex: true });
  const named = byName(snapshot.indexes, "OutreachArtifact_idempotency_uniq");
  named.columns = ["orgId", "graphRunId", "recipientRef", "toolName"];
  named.valid = false;
  const entry = reportEntry(classifyPostClerkMigrationCatalog(snapshot), POST_CLERK_MIGRATIONS[0]);
  assert.equal(entry.classification, "hold");
  assert.deepEqual(entry.reasonCodes, ["SAME_NAME_DEFINITION_MISMATCH"]);
});

test("only an exact interrupted idempotency index is recoverable", () => {
  const snapshot = initialPostClerkSnapshot({ artifactIndex: true });
  byName(snapshot.indexes, "OutreachArtifact_idempotency_uniq").ready = false;
  const entry = reportEntry(classifyPostClerkMigrationCatalog(snapshot), POST_CLERK_MIGRATIONS[0]);
  assert.equal(entry.classification, "recoverable");
  assert.equal(entry.action, "replay");
  assert.equal(entry.lostAckAdopted, false);
});

test("conversation store requires exact ordered enum labels", () => {
  const snapshot = completeSnapshot();
  const sentiment = byName(snapshot.enums, "ConversationSentiment");
  [sentiment.labels[0], sentiment.labels[1]] = [sentiment.labels[1], sentiment.labels[0]];
  const entry = reportEntry(classifyPostClerkMigrationCatalog(snapshot), POST_CLERK_MIGRATIONS[1]);
  assert.equal(entry.classification, "hold");
});

test("conversation store rejects wrong column defaults, index definitions, and constraints", () => {
  for (const mutate of [
    (snapshot) => { snapshot.columns.find((entry) => entry.table === "Conversation" && entry.name === "subject").defaultSql = "'x'::text"; },
    (snapshot) => { byName(snapshot.indexes, "Conversation_orgId_needsReply_lastMessageAt_idx").opclasses[1] = "pg_catalog.text_ops"; },
    (snapshot) => { snapshot.constraints.find((entry) => entry.name === "Conversation_orgId_fkey").deleteAction = "a"; },
  ]) {
    const snapshot = completeSnapshot();
    mutate(snapshot);
    const changedDefault = snapshot.columns.find((entry) => entry.table === "Conversation" && entry.name === "subject");
    if (changedDefault.defaultSql === "'x'::text") changedDefault.defaultLength = changedDefault.defaultSql.length;
    const entry = reportEntry(classifyPostClerkMigrationCatalog(snapshot), POST_CLERK_MIGRATIONS[1]);
    assert.equal(entry.classification, "hold");
  }
});

test("FAILED enum committed with absent exact columns is recoverable, wrong columns hold", () => {
  const snapshot = completeSnapshot();
  snapshot.columns = snapshot.columns.filter((entry) =>
    !(entry.table === "OutreachArtifact" && ["failureReason", "failedAt"].includes(entry.name)));
  let entry = reportEntry(classifyPostClerkMigrationCatalog(snapshot), POST_CLERK_MIGRATIONS[3]);
  assert.equal(entry.classification, "recoverable");

  const hostile = completeSnapshot();
  const failedAt = hostile.columns.find((item) => item.table === "OutreachArtifact" && item.name === "failedAt");
  failedAt.typeModifier = 6;
  entry = reportEntry(classifyPostClerkMigrationCatalog(hostile), POST_CLERK_MIGRATIONS[3]);
  assert.equal(entry.classification, "hold");
});

test("reply single-flight requires exact keys, full predicates, and flags", () => {
  const mutations = [
    (index) => { index.columns = ["orgId", "replyToMessageId", "conversationId"]; },
    (index) => { index.predicateSql = index.predicateSql.replace("'SENT'", "'FAILED'"); index.predicateLength = index.predicateSql.length; },
    (index) => { index.unique = false; },
  ];
  for (const mutate of mutations) {
    const snapshot = completeSnapshot();
    mutate(byName(snapshot.indexes, REPLY_REPAIR_INDEXES[0]));
    const entry = reportEntry(classifyPostClerkMigrationCatalog(snapshot), POST_CLERK_MIGRATIONS[4]);
    assert.equal(entry.classification, "hold");
  }
  const unusable = completeSnapshot();
  byName(unusable.indexes, REPLY_REPAIR_INDEXES[0]).live = false;
  const entry = reportEntry(classifyPostClerkMigrationCatalog(unusable), POST_CLERK_MIGRATIONS[4]);
  assert.equal(entry.classification, "repairable");
});

test("predicate comparison preserves quotes and boolean grouping", () => {
  const snapshot = completeSnapshot();
  const graphIndex = byName(snapshot.indexes, "GraphRun_one_active_per_org_key");
  graphIndex.predicateSql = graphIndex.predicateSql
    .replace("((status =", "(status =")
    .replace('"GraphRunStatus"))', '"GraphRunStatus")');
  graphIndex.predicateLength = graphIndex.predicateSql.length;
  const entry = reportEntry(classifyPostClerkMigrationCatalog(snapshot), POST_CLERK_MIGRATIONS[6]);
  assert.equal(entry.classification, "hold");
});

test("only exact matching reply subsets authorize their present bounded repair names", () => {
  const snapshot = completeSnapshot();
  for (const name of REPLY_REPAIR_INDEXES) byName(snapshot.indexes, name).valid = false;
  let entry = reportEntry(classifyPostClerkMigrationCatalog(snapshot), POST_CLERK_MIGRATIONS[4]);
  assert.equal(entry.classification, "repairable");
  assert.equal(entry.action, "repair");
  assert.deepEqual(entry.repairIndexes, REPLY_REPAIR_INDEXES);

  byName(snapshot.indexes, REPLY_REPAIR_INDEXES[0]).predicateSql += "ANDorgIdISNOTNULL";
  byName(snapshot.indexes, REPLY_REPAIR_INDEXES[0]).predicateLength =
    byName(snapshot.indexes, REPLY_REPAIR_INDEXES[0]).predicateSql.length;
  entry = reportEntry(classifyPostClerkMigrationCatalog(snapshot), POST_CLERK_MIGRATIONS[4]);
  assert.equal(entry.classification, "hold");
  assert.deepEqual(entry.repairIndexes, []);
});

test("a valid exact first reply index with its peer absent is repairable by that name only", () => {
  const snapshot = completeSnapshot();
  snapshot.indexes = snapshot.indexes.filter((entry) => entry.name !== REPLY_REPAIR_INDEXES[1]);
  const entry = reportEntry(classifyPostClerkMigrationCatalog(snapshot), POST_CLERK_MIGRATIONS[4]);
  assert.equal(entry.classification, "repairable");
  assert.deepEqual(entry.repairIndexes, [REPLY_REPAIR_INDEXES[0]]);
});

test("an exact valid plus invalid reply subset is repairable, but an active build holds", () => {
  const snapshot = completeSnapshot();
  byName(snapshot.indexes, REPLY_REPAIR_INDEXES[1]).valid = false;
  let entry = reportEntry(classifyPostClerkMigrationCatalog(snapshot), POST_CLERK_MIGRATIONS[4]);
  assert.equal(entry.classification, "repairable");
  assert.deepEqual(entry.repairIndexes, REPLY_REPAIR_INDEXES);

  snapshot.activeIndexBuilds = [{ table: "OutreachArtifact", count: 1 }];
  byName(snapshot.indexes, REPLY_REPAIR_INDEXES[1]).buildInProgress = true;
  entry = reportEntry(classifyPostClerkMigrationCatalog(snapshot), POST_CLERK_MIGRATIONS[4]);
  assert.equal(entry.classification, "hold");
  assert.deepEqual(entry.reasonCodes, ["ACTIVE_INDEX_BUILD"]);
});

test("partial pg_stat_progress_create_index visibility always holds index migrations", () => {
  const snapshot = completeSnapshot();
  snapshot.progressVisibilityComplete = false;
  const report = classifyPostClerkMigrationCatalog(snapshot);
  for (const index of [0, 1, 4, 5, 6]) {
    assert.equal(report.migrations[index].classification, "hold");
    assert.deepEqual(report.migrations[index].reasonCodes, ["INDEX_PROGRESS_VISIBILITY_INCOMPLETE"]);
  }
});

test("graph migrations require exact defaults and exact index definitions", () => {
  const activity = completeSnapshot();
  const activityColumn = activity.columns.find((entry) => entry.table === "GraphRun" && entry.name === "lastActivityAt");
  activityColumn.defaultSql = "clock_timestamp()";
  activityColumn.defaultLength = activityColumn.defaultSql.length;
  assert.equal(reportEntry(classifyPostClerkMigrationCatalog(activity), POST_CLERK_MIGRATIONS[5]).classification, "hold");

  const lifecycle = completeSnapshot();
  const generation = lifecycle.columns.find((entry) => entry.table === "GraphRun" && entry.name === "dispatchGeneration");
  generation.defaultSql = "1";
  generation.defaultLength = 1;
  assert.equal(reportEntry(classifyPostClerkMigrationCatalog(lifecycle), POST_CLERK_MIGRATIONS[6]).classification, "hold");

  const wrongPredicate = completeSnapshot();
  const graphIndex = byName(wrongPredicate.indexes, "GraphRun_one_active_per_org_key");
  graphIndex.predicateSql = graphIndex.predicateSql.replace("AWAITING_APPROVAL", "COMPLETED");
  graphIndex.predicateLength = graphIndex.predicateSql.length;
  assert.equal(reportEntry(classifyPostClerkMigrationCatalog(wrongPredicate), POST_CLERK_MIGRATIONS[6]).classification, "hold");
});

test("ICP exclusion domains require the exact non-null empty-array column", () => {
  const absent = completeSnapshot();
  absent.columns = absent.columns.filter((entry) =>
    !(entry.table === "IcpProfile" && entry.name === "exclusionDomains"));
  assert.equal(
    reportEntry(classifyPostClerkMigrationCatalog(absent), POST_CLERK_MIGRATIONS[7]).classification,
    "absent",
  );

  const incompatible = completeSnapshot();
  const column = incompatible.columns.find((entry) =>
    entry.table === "IcpProfile" && entry.name === "exclusionDomains");
  column.notNull = false;
  assert.equal(
    reportEntry(classifyPostClerkMigrationCatalog(incompatible), POST_CLERK_MIGRATIONS[7]).classification,
    "hold",
  );
});

test("decision API never adopts absent, recoverable, repairable, or hold states", () => {
  const path = POST_CLERK_MIGRATIONS[4];
  assert.deepEqual(decidePostClerkMigration({ path, classification: "complete" }), {
    action: "adopt", lostAckAdopted: true, repairIndexes: [],
  });
  assert.equal(decidePostClerkMigration({ path, classification: "absent" }).lostAckAdopted, false);
  assert.equal(decidePostClerkMigration({ path, classification: "recoverable" }).action, "replay");
  assert.equal(decidePostClerkMigration({
    path,
    classification: "repairable",
    repairIndexes: [REPLY_REPAIR_INDEXES[0]],
  }).action, "repair");
  assert.equal(decidePostClerkMigration({ path, classification: "hold" }).action, "hold");
  assert.throws(
    () => decidePostClerkMigration({ path: POST_CLERK_MIGRATIONS[0], classification: "repairable" }),
    /only reply single-flight/u,
  );
});

test("planner holds persisted-prefix drift and out-of-order later state", () => {
  const allComplete = classifyPostClerkMigrationCatalog(completeSnapshot());
  const plan = planPostClerkMigrationCatalog(allComplete, 1, ADMITTED_MIGRATIONS);
  assert.equal(plan.outcome, "hold");
  assert.equal(plan.reasonCode, "OUT_OF_ORDER_LATER_MIGRATION_STATE");

  const absent = classifyPostClerkMigrationCatalog(initialPostClerkSnapshot());
  const prefixPlan = planPostClerkMigrationCatalog(absent, 1, ADMITTED_MIGRATIONS);
  assert.equal(prefixPlan.outcome, "hold");
  assert.equal(prefixPlan.reasonCode, "PERSISTED_PREFIX_NOT_COMPLETE");
});

test("planner rejects any admitted migration SHA that differs from reviewed bytes", () => {
  const report = classifyPostClerkMigrationCatalog(initialPostClerkSnapshot());
  for (let index = 0; index < ADMITTED_MIGRATIONS.length; index += 1) {
    const hostile = structuredClone(ADMITTED_MIGRATIONS);
    hostile[index].sha256 = `sha256:${"f".repeat(64)}`;
    assert.throws(
      () => planPostClerkMigrationCatalog(report, 0, hostile),
      /admitted migration path and SHA sequence is invalid/u,
    );
  }
});

test("parser and callback verifier reject unbounded input and emit no raw catalog", () => {
  const snapshotBytes = Buffer.from(JSON.stringify(completeSnapshot()));
  assert.deepEqual(parsePostClerkCatalogSnapshot(snapshotBytes), JSON.parse(snapshotBytes));
  assert.throws(() => parsePostClerkCatalogSnapshot(Buffer.alloc(MAX_CATALOG_SNAPSHOT_BYTES + 1)),
    /byte length/u);
  let query;
  const report = verifyPostClerkMigrationCatalog({
    queryCatalog(value) { query = value; return snapshotBytes; },
  });
  assert.equal(query, POST_CLERK_CATALOG_QUERY);
  assert.equal(report.overall, "complete");
  const wrongMajor = completeSnapshot();
  wrongMajor.postgresMajor = 17;
  assert.throws(() => classifyPostClerkMigrationCatalog(wrongMajor), /major must be 16/u);
  const wrongSchema = completeSnapshot();
  wrongSchema.schema = "shadow";
  assert.throws(() => classifyPostClerkMigrationCatalog(wrongSchema), /must be public/u);
});

test("snapshot-stdin CLI emits exactly one bounded JSON report", () => {
  const result = spawnSync(process.execPath, [VERIFIER, "--snapshot-stdin"], {
    input: JSON.stringify(completeSnapshot()),
    encoding: "utf8",
    maxBuffer: 128 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const report = JSON.parse(result.stdout);
  assert.equal(report.overall, "complete");
  assert.doesNotMatch(result.stdout, /(?:predicateSql|defaultSql|expressionSql)/u);
  assert.ok(Buffer.byteLength(result.stdout) < 32 * 1024);
});
