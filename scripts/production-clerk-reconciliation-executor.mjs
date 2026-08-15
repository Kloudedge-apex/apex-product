#!/usr/bin/env node

/**
 * Exact v1 executor for the private Clerk reconciliation plan.
 *
 * Row-bearing values are accepted only from the bounded private plan, encoded
 * before psql substitution, used by fixed SQL, and never written to stdout or
 * stderr. Apply is one PostgreSQL transaction; dry-run executes the same SQL
 * and rolls it back after all invariants pass.
 */

import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { canonicalJson, strictJsonParse } from "./production-bootstrap-phase-ledger.mjs";
import {
  PRODUCTION_DATABASE_IDENTITY_QUERY,
  assertProductionDatabaseIdentityOutput,
  productionDatabaseIdentityAssertionSql,
} from "./production-bootstrap-database-identity.mjs";
import { verifyProductionBootstrapMutationAuthority } from "./production-bootstrap-mutation-authority.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = realpathSync(resolve(dirname(SCRIPT_PATH), ".."));
const MAX_PLAN_BYTES = 2 * 1024 * 1024;
const HASH = /^sha256:[0-9a-f]{64}$/;
const ID = /^[^\u0000-\u001f\u007f]{1,512}$/u;
const ATTEMPT = /^[0-9a-f]{32}$/;
const ROLES = new Set(["OWNER", "ADMIN", "MANAGER", "MEMBER"]);

function fail(message) {
  throw new Error(message);
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} has unexpected or missing fields`);
  }
}

function text(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) fail(`${label} is invalid`);
  return value;
}

function integer(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) fail(`${label} is invalid`);
  return value;
}

function hash(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function inside(parent, candidate) {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function externalPath(path, label, mustExist) {
  if (!isAbsolute(path)) fail(`${label} must be absolute`);
  const parent = realpathSync(mustExist ? path : dirname(path));
  if (inside(REPO_ROOT, parent)) fail(`${label} must be outside the repository`);
  if (mustExist) {
    const metadata = lstatSync(parent);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
      fail(`${label} must be a regular non-symlink single-link file`);
    }
  }
  return mustExist ? parent : resolve(parent, path.split("/").at(-1));
}

function parseOptions(argv) {
  const values = Object.create(null);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--") || token === "--") fail("invalid executor arguments");
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
  exactKeys(values, [
    "mode", "plan", "attempt-id", "database-identity-hash", "executor-sha256",
    "expected-backend-commit", "authority-subscription-id", "authority-storage-account",
    "authority-storage-container", "authority-storage-blob", "output", "yes",
  ], "executor options");
  if (!new Set(["dry-run", "apply"]).has(values.mode) || values.yes !== true) fail("executor mode or confirmation is invalid");
  text(values["attempt-id"], ATTEMPT, "attempt id");
  text(values["database-identity-hash"], HASH, "database identity hash");
  text(values["executor-sha256"], HASH, "executor hash");
  text(values["expected-backend-commit"], /^[0-9a-f]{40}$/, "expected backend commit");
  return {
    mode: values.mode,
    plan: externalPath(values.plan, "private plan", true),
    attemptId: values["attempt-id"],
    databaseIdentityHash: values["database-identity-hash"],
    executorSha256: values["executor-sha256"],
    expectedBackendCommit: values["expected-backend-commit"],
    authoritySubscriptionId: values["authority-subscription-id"],
    authorityStorageAccount: values["authority-storage-account"],
    authorityStorageContainer: values["authority-storage-container"],
    authorityStorageBlob: values["authority-storage-blob"],
    output: externalPath(values.output, "executor output", false),
  };
}

function validatePlan(plan, options) {
  exactKeys(plan, [
    "schemaVersion", "environment", "kind", "attemptId", "backendCandidateCommit",
    "databaseIdentityHash", "approver", "executor", "cutover", "operations",
  ], "private plan");
  if (plan.schemaVersion !== 1 || plan.environment !== "production" ||
    plan.kind !== "private-clerk-reconciliation-plan" ||
    plan.attemptId !== options.attemptId ||
    plan.backendCandidateCommit !== options.expectedBackendCommit ||
    plan.databaseIdentityHash !== options.databaseIdentityHash) {
    fail("private plan identity drift detected");
  }
  exactKeys(plan.executor, ["name", "version", "sha256"], "plan executor");
  if (plan.executor.name !== "workforce-production-clerk-reconciliation-executor" ||
    plan.executor.version !== "v1" || plan.executor.sha256 !== options.executorSha256) {
    fail("private plan does not bind this exact v1 executor");
  }
  exactKeys(plan.cutover, [
    "minimumEventVersion", "inventoryEvidenceHash", "expectedActiveOrganizationCount",
    "expectedActiveMembershipCount", "expectedActiveUserCount",
  ], "plan cutover");
  integer(plan.cutover.minimumEventVersion, "minimum event version", 1);
  text(plan.cutover.inventoryEvidenceHash, HASH, "inventory evidence hash");
  for (const key of ["expectedActiveOrganizationCount", "expectedActiveMembershipCount", "expectedActiveUserCount"]) {
    integer(plan.cutover[key], key, 0);
  }
  if (!Array.isArray(plan.operations) || plan.operations.length > 100000) fail("plan operations are invalid or unbounded");

  const organizations = new Map();
  const localOrganizations = new Set();
  const memberships = new Set();
  const users = new Set();
  const localUsers = new Set();
  const localOwners = new Set();
  let stage = 0;
  for (const [index, operation] of plan.operations.entries()) {
    const label = `operation ${index}`;
    if (!operation || typeof operation !== "object" || Array.isArray(operation)) fail(`${label} must be an object`);
    if (operation.type === "organization") {
      if (stage > 0) fail("organization operations must precede membership and local-owner operations");
      exactKeys(operation, ["type", "localOrgId", "clerkOrgId", "eventVersion", "eventRank", "lastEventId"], label);
      for (const key of ["localOrgId", "clerkOrgId", "lastEventId"]) text(operation[key], ID, `${label}.${key}`);
      integer(operation.eventVersion, `${label}.eventVersion`, 1);
      integer(operation.eventRank, `${label}.eventRank`, 1);
      if (operation.eventRank > 3 || operation.eventVersion > plan.cutover.minimumEventVersion) fail(`${label} cursor exceeds the cutover`);
      if (organizations.has(operation.clerkOrgId) || localOrganizations.has(operation.localOrgId)) {
        fail(`${label} duplicates a Clerk or local organization`);
      }
      organizations.set(operation.clerkOrgId, operation.localOrgId);
      localOrganizations.add(operation.localOrgId);
    } else if (operation.type === "membership") {
      if (stage > 1) fail("membership operations must precede local-owner operations");
      stage = 1;
      exactKeys(operation, [
        "type", "localOrgId", "localUserId", "clerkOrgId", "clerkUserId",
        "clerkMembershipId", "eventVersion", "eventRank", "role",
        "membershipLastEventId", "userLastEventId",
      ], label);
      for (const key of [
        "localOrgId", "localUserId", "clerkOrgId", "clerkUserId", "clerkMembershipId",
        "membershipLastEventId", "userLastEventId",
      ]) text(operation[key], ID, `${label}.${key}`);
      integer(operation.eventVersion, `${label}.eventVersion`, 1);
      integer(operation.eventRank, `${label}.eventRank`, 1);
      if (operation.eventRank > 3 || operation.eventVersion > plan.cutover.minimumEventVersion ||
        organizations.get(operation.clerkOrgId) !== operation.localOrgId || !ROLES.has(operation.role)) {
        fail(`${label} has an unreviewed organization, role, or cursor`);
      }
      if (memberships.has(operation.clerkMembershipId) || users.has(operation.clerkUserId) ||
        localUsers.has(operation.localUserId) || localOwners.has(operation.localUserId)) {
        fail(`${label} duplicates a Clerk membership, Clerk user, or local user`);
      }
      memberships.add(operation.clerkMembershipId);
      users.add(operation.clerkUserId);
      localUsers.add(operation.localUserId);
    } else if (operation.type === "local-owner") {
      stage = 2;
      exactKeys(operation, ["type", "localOrgId", "localUserId"], label);
      text(operation.localOrgId, ID, `${label}.localOrgId`);
      text(operation.localUserId, ID, `${label}.localUserId`);
      if (localOwners.has(operation.localUserId) || localUsers.has(operation.localUserId)) {
        fail(`${label} duplicates a local owner or reconciled user`);
      }
      localOwners.add(operation.localUserId);
    } else {
      fail(`${label}.type is unsupported`);
    }
  }
  if (organizations.size !== plan.cutover.expectedActiveOrganizationCount ||
    memberships.size !== plan.cutover.expectedActiveMembershipCount ||
    users.size !== plan.cutover.expectedActiveUserCount) {
    fail("plan operation counts do not match the signed cutover counts");
  }
  return { organizations: organizations.size, memberships: memberships.size, users: users.size, localOwners: localOwners.size };
}

function encoded(value) {
  return Buffer.from(String(value), "utf8").toString("base64");
}

function variable(name, value) {
  return `\\set ${name} '${encoded(value)}'`;
}

function decoded(name) {
  return `convert_from(decode(:'${name}', 'base64'), 'UTF8')`;
}

function assertion(sql) {
  return `INSERT INTO _bootstrap_assertion (ok) SELECT (${sql});`;
}

function operationSql(operation, index) {
  const prefix = `p${index}`;
  if (operation.type === "organization") {
    return [
      variable(`${prefix}_local_org`, operation.localOrgId),
      variable(`${prefix}_clerk_org`, operation.clerkOrgId),
      variable(`${prefix}_event_version`, operation.eventVersion),
      variable(`${prefix}_event_rank`, operation.eventRank),
      variable(`${prefix}_last_event`, operation.lastEventId),
      assertion(`(SELECT COUNT(*) = 1 FROM "Org" WHERE "id" = ${decoded(`${prefix}_local_org`)} AND ("clerkOrgId" IS NULL OR "clerkOrgId" = ${decoded(`${prefix}_clerk_org`)}))`),
      `UPDATE "Org" SET "clerkOrgId" = ${decoded(`${prefix}_clerk_org`)} WHERE "id" = ${decoded(`${prefix}_local_org`)};`,
      assertion(`NOT EXISTS (SELECT 1 FROM "clerk_organization_lifecycle" WHERE "clerkOrgId" = ${decoded(`${prefix}_clerk_org`)} AND ("eventVersion" <> (${decoded(`${prefix}_event_version`)})::bigint OR "eventRank" <> (${decoded(`${prefix}_event_rank`)})::integer OR "deleted" OR "lastEventId" <> ${decoded(`${prefix}_last_event`)}))`),
      `INSERT INTO "clerk_organization_lifecycle" ("clerkOrgId", "eventVersion", "eventRank", "deleted", "lastEventId", "updatedAt") VALUES (${decoded(`${prefix}_clerk_org`)}, (${decoded(`${prefix}_event_version`)})::bigint, (${decoded(`${prefix}_event_rank`)})::integer, false, ${decoded(`${prefix}_last_event`)}, clock_timestamp()) ON CONFLICT ("clerkOrgId") DO NOTHING;`,
    ].join("\n");
  }
  if (operation.type === "membership") {
    const variables = [
      ["local_org", operation.localOrgId], ["local_user", operation.localUserId],
      ["clerk_org", operation.clerkOrgId], ["clerk_user", operation.clerkUserId],
      ["clerk_membership", operation.clerkMembershipId], ["event_version", operation.eventVersion],
      ["event_rank", operation.eventRank], ["role", operation.role],
      ["membership_event", operation.membershipLastEventId], ["user_event", operation.userLastEventId],
    ].map(([name, value]) => variable(`${prefix}_${name}`, value));
    return [
      ...variables,
      assertion(`(SELECT COUNT(*) = 1 FROM "User" WHERE "id" = ${decoded(`${prefix}_local_user`)} AND "orgId" = ${decoded(`${prefix}_local_org`)} AND ("clerkId" IS NULL OR "clerkId" = ${decoded(`${prefix}_clerk_user`)}))`),
      `UPDATE "User" SET "clerkId" = ${decoded(`${prefix}_clerk_user`)}, "clerkMembershipId" = ${decoded(`${prefix}_clerk_membership`)}, "membershipActive" = true, "role" = (${decoded(`${prefix}_role`)})::"UserRole" WHERE "id" = ${decoded(`${prefix}_local_user`)} AND "orgId" = ${decoded(`${prefix}_local_org`)};`,
      assertion(`NOT EXISTS (SELECT 1 FROM "clerk_membership_lifecycle" WHERE "clerkMembershipId" = ${decoded(`${prefix}_clerk_membership`)} AND ("clerkUserId" <> ${decoded(`${prefix}_clerk_user`)} OR "clerkOrgId" <> ${decoded(`${prefix}_clerk_org`)} OR "eventVersion" <> (${decoded(`${prefix}_event_version`)})::bigint OR "eventRank" <> (${decoded(`${prefix}_event_rank`)})::integer OR "role" <> (${decoded(`${prefix}_role`)})::"UserRole" OR "deleted" OR "lastEventId" <> ${decoded(`${prefix}_membership_event`)}))`),
      `INSERT INTO "clerk_membership_lifecycle" ("clerkMembershipId", "clerkUserId", "clerkOrgId", "eventVersion", "eventRank", "role", "deleted", "lastEventId", "updatedAt") VALUES (${decoded(`${prefix}_clerk_membership`)}, ${decoded(`${prefix}_clerk_user`)}, ${decoded(`${prefix}_clerk_org`)}, (${decoded(`${prefix}_event_version`)})::bigint, (${decoded(`${prefix}_event_rank`)})::integer, (${decoded(`${prefix}_role`)})::"UserRole", false, ${decoded(`${prefix}_membership_event`)}, clock_timestamp()) ON CONFLICT ("clerkMembershipId") DO NOTHING;`,
      assertion(`NOT EXISTS (SELECT 1 FROM "clerk_user_lifecycle" WHERE "clerkUserId" = ${decoded(`${prefix}_clerk_user`)} AND ("deleted" OR "clerkMembershipId" <> ${decoded(`${prefix}_clerk_membership`)} OR "clerkOrgId" <> ${decoded(`${prefix}_clerk_org`)} OR "membershipEventVersion" <> (${decoded(`${prefix}_event_version`)})::bigint OR "membershipEventRank" <> (${decoded(`${prefix}_event_rank`)})::integer OR NOT "membershipActive" OR "role" <> (${decoded(`${prefix}_role`)})::"UserRole" OR "lastEventId" <> ${decoded(`${prefix}_user_event`)}))`),
      `INSERT INTO "clerk_user_lifecycle" ("clerkUserId", "deleted", "clerkMembershipId", "clerkOrgId", "membershipEventVersion", "membershipEventRank", "membershipActive", "role", "lastEventId", "updatedAt") VALUES (${decoded(`${prefix}_clerk_user`)}, false, ${decoded(`${prefix}_clerk_membership`)}, ${decoded(`${prefix}_clerk_org`)}, (${decoded(`${prefix}_event_version`)})::bigint, (${decoded(`${prefix}_event_rank`)})::integer, true, (${decoded(`${prefix}_role`)})::"UserRole", ${decoded(`${prefix}_user_event`)}, clock_timestamp()) ON CONFLICT ("clerkUserId") DO NOTHING;`,
    ].join("\n");
  }
  return [
    variable(`${prefix}_local_org`, operation.localOrgId),
    variable(`${prefix}_local_user`, operation.localUserId),
    assertion(`(SELECT COUNT(*) = 1 FROM "User" AS u JOIN "Org" AS o ON o."id" = u."orgId" WHERE u."id" = ${decoded(`${prefix}_local_user`)} AND u."orgId" = ${decoded(`${prefix}_local_org`)} AND o."clerkOrgId" IS NULL AND u."clerkId" IS NULL)`),
    `UPDATE "User" SET "clerkMembershipId" = NULL, "membershipActive" = true, "role" = 'OWNER' WHERE "id" = ${decoded(`${prefix}_local_user`)} AND "orgId" = ${decoded(`${prefix}_local_org`)};`,
  ].join("\n");
}

function sqlFor(plan, mode) {
  const cutoff = plan.cutover;
  const operations = plan.operations.map(operationSql).join("\n");
  const end = mode === "apply" ? "COMMIT;" : "ROLLBACK;";
  return `\\set ON_ERROR_STOP on
\\set ECHO none
\\set VERBOSITY terse
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '5min';
SELECT pg_advisory_xact_lock(hashtextextended('workforce-production-clerk-reconciliation-v1', 0));
CREATE TEMP TABLE _bootstrap_assertion (ok boolean NOT NULL CHECK (ok)) ON COMMIT DROP;
${assertion(`(SELECT COUNT(*) = 1 FROM "clerk_identity_cutover" WHERE "id" = 1 AND ((NOT "ready" AND "minimumEventVersion" = 9223372036854775807) OR ("ready" AND "minimumEventVersion" = ${cutoff.minimumEventVersion} AND "inventoryEvidenceHash" = '${cutoff.inventoryEvidenceHash}' AND "expectedActiveOrganizationCount" = ${cutoff.expectedActiveOrganizationCount} AND "expectedActiveMembershipCount" = ${cutoff.expectedActiveMembershipCount} AND "expectedActiveUserCount" = ${cutoff.expectedActiveUserCount})))`)}
UPDATE "User" SET "membershipActive" = false;
${operations}
UPDATE "clerk_identity_cutover"
SET "minimumEventVersion" = ${cutoff.minimumEventVersion}, "ready" = true,
    "inventoryEvidenceHash" = '${cutoff.inventoryEvidenceHash}',
    "expectedActiveOrganizationCount" = ${cutoff.expectedActiveOrganizationCount},
    "expectedActiveMembershipCount" = ${cutoff.expectedActiveMembershipCount},
    "expectedActiveUserCount" = ${cutoff.expectedActiveUserCount}, "updatedAt" = clock_timestamp()
WHERE "id" = 1 AND NOT "ready";
${assertion(`(SELECT COUNT(*) = 1 FROM "clerk_identity_cutover" WHERE "id" = 1 AND "ready" AND "minimumEventVersion" = ${cutoff.minimumEventVersion} AND "inventoryEvidenceHash" = '${cutoff.inventoryEvidenceHash}' AND "expectedActiveOrganizationCount" = ${cutoff.expectedActiveOrganizationCount} AND "expectedActiveMembershipCount" = ${cutoff.expectedActiveMembershipCount} AND "expectedActiveUserCount" = ${cutoff.expectedActiveUserCount})`)}
${assertion(`(SELECT COUNT(*) = ${cutoff.expectedActiveOrganizationCount} FROM "clerk_organization_lifecycle" WHERE NOT "deleted")`)}
${assertion(`(SELECT COUNT(*) = ${cutoff.expectedActiveMembershipCount} FROM "clerk_membership_lifecycle" WHERE NOT "deleted")`)}
${assertion(`(SELECT COUNT(*) = ${cutoff.expectedActiveUserCount} FROM "clerk_user_lifecycle" WHERE NOT "deleted" AND "membershipActive")`)}
CREATE TEMP TABLE _bootstrap_invariants ON COMMIT DROP AS
SELECT
  (SELECT COUNT(*)::integer FROM "clerk_organization_lifecycle" WHERE NOT "deleted") AS organization_count,
  (SELECT COUNT(*)::integer FROM "clerk_membership_lifecycle" WHERE NOT "deleted") AS membership_count,
  (SELECT COUNT(*)::integer FROM "clerk_user_lifecycle" WHERE NOT "deleted" AND "membershipActive") AS user_count,
  (SELECT COUNT(*)::integer FROM (
    SELECT 1
    FROM "User" AS u
    JOIN "Org" AS o ON o."id" = u."orgId"
    LEFT JOIN "clerk_organization_lifecycle" AS ol
      ON ol."clerkOrgId" = o."clerkOrgId"
    LEFT JOIN "clerk_membership_lifecycle" AS ml
      ON ml."clerkMembershipId" = u."clerkMembershipId"
    LEFT JOIN "clerk_user_lifecycle" AS ul
      ON ul."clerkUserId" = u."clerkId"
    WHERE u."membershipActive"
      AND (
        (o."clerkOrgId" IS NULL AND (
          u."clerkMembershipId" IS NOT NULL
          OR u."clerkId" IS NOT NULL
          OR u."role"::text <> 'OWNER'
        ))
        OR (o."clerkOrgId" IS NOT NULL AND (
          u."clerkId" IS NULL
          OR u."clerkMembershipId" IS NULL
          OR ol."clerkOrgId" IS NULL
          OR ol."deleted"
          OR ml."clerkMembershipId" IS NULL
          OR ml."deleted"
          OR ml."clerkUserId" IS DISTINCT FROM u."clerkId"
          OR ml."clerkOrgId" IS DISTINCT FROM o."clerkOrgId"
          OR ul."clerkUserId" IS NULL
          OR ul."deleted"
          OR NOT ul."membershipActive"
          OR ul."clerkMembershipId" IS DISTINCT FROM u."clerkMembershipId"
          OR ul."clerkOrgId" IS DISTINCT FROM o."clerkOrgId"
          OR ul."membershipEventVersion" IS DISTINCT FROM ml."eventVersion"
          OR ul."membershipEventRank" IS DISTINCT FROM ml."eventRank"
          OR ml."role" IS DISTINCT FROM ul."role"
          OR NOT (
            u."role" = ul."role"
            OR (u."role"::text = 'OWNER' AND ul."role"::text = 'ADMIN')
          )
        ))
      )
  ) AS projection_mismatches) AS projection_mismatch_rows,
  (SELECT COUNT(*)::integer FROM (
    SELECT 1
    FROM "clerk_membership_lifecycle" AS ml
    LEFT JOIN "clerk_user_lifecycle" AS ul
      ON ul."clerkMembershipId" = ml."clerkMembershipId"
    LEFT JOIN "Org" AS o ON o."clerkOrgId" = ml."clerkOrgId"
    LEFT JOIN "User" AS u
      ON u."clerkId" = ml."clerkUserId" AND u."orgId" = o."id"
    WHERE NOT ml."deleted"
      AND (
        ul."clerkUserId" IS NULL
        OR ul."deleted"
        OR NOT ul."membershipActive"
        OR ul."clerkUserId" IS DISTINCT FROM ml."clerkUserId"
        OR ul."clerkOrgId" IS DISTINCT FROM ml."clerkOrgId"
        OR ul."membershipEventVersion" IS DISTINCT FROM ml."eventVersion"
        OR ul."membershipEventRank" IS DISTINCT FROM ml."eventRank"
        OR ul."role" IS DISTINCT FROM ml."role"
        OR u."id" IS NULL
        OR NOT u."membershipActive"
        OR u."clerkMembershipId" IS DISTINCT FROM ml."clerkMembershipId"
      )
    UNION ALL
    SELECT 1
    FROM "clerk_organization_lifecycle" AS ol
    LEFT JOIN "Org" AS o ON o."clerkOrgId" = ol."clerkOrgId"
    WHERE NOT ol."deleted" AND o."id" IS NULL
    UNION ALL
    SELECT 1
    FROM "clerk_user_lifecycle" AS ul
    LEFT JOIN "clerk_membership_lifecycle" AS ml
      ON ml."clerkMembershipId" = ul."clerkMembershipId"
    WHERE NOT ul."deleted"
      AND ul."membershipActive"
      AND (ml."clerkMembershipId" IS NULL OR ml."deleted")
  ) AS orphan_authorities) AS orphan_active_authority_rows,
  (SELECT COUNT(*)::integer FROM (
    WITH singleton AS (
      SELECT
        COUNT(*) AS row_count,
        COUNT(*) FILTER (
          WHERE "id" = 1
            AND "ready"
            AND "minimumEventVersion" BETWEEN 1 AND 9007199254740991
            AND "minimumEventVersion" BETWEEN
              ((EXTRACT(EPOCH FROM "establishedAt") * 1000)::BIGINT - 86400000)
              AND ((EXTRACT(EPOCH FROM "establishedAt") * 1000)::BIGINT + 86400000)
            AND "inventoryEvidenceHash" ~ '^sha256:[0-9a-f]{64}$'
            AND "expectedActiveOrganizationCount" >= 0
            AND "expectedActiveMembershipCount" >= 0
            AND "expectedActiveUserCount" >= 0
        ) AS ready_count
      FROM "clerk_identity_cutover"
    )
    SELECT 1 AS violation
    FROM singleton
    WHERE row_count <> 1 OR ready_count <> 1
    UNION ALL
    SELECT 1
    FROM "clerk_identity_cutover" AS c
    WHERE c."id" = 1 AND c."ready"
      AND c."expectedActiveOrganizationCount" <>
        (SELECT COUNT(*) FROM "clerk_organization_lifecycle" WHERE NOT "deleted")
    UNION ALL
    SELECT 1
    FROM "clerk_identity_cutover" AS c
    WHERE c."id" = 1 AND c."ready"
      AND c."expectedActiveMembershipCount" <>
        (SELECT COUNT(*) FROM "clerk_membership_lifecycle" WHERE NOT "deleted")
    UNION ALL
    SELECT 1
    FROM "clerk_identity_cutover" AS c
    WHERE c."id" = 1 AND c."ready"
      AND c."expectedActiveUserCount" <>
        (SELECT COUNT(*) FROM "clerk_user_lifecycle"
         WHERE NOT "deleted" AND "membershipActive")
    UNION ALL
    SELECT 1
    FROM "clerk_organization_lifecycle" AS l
    CROSS JOIN "clerk_identity_cutover" AS c
    WHERE c."id" = 1 AND c."ready"
      AND (l."eventVersion" NOT BETWEEN 1 AND 9007199254740991
        OR l."eventRank" NOT BETWEEN 1 AND 3
        OR l."eventVersion" > c."minimumEventVersion")
    UNION ALL
    SELECT 1
    FROM "clerk_membership_lifecycle" AS l
    CROSS JOIN "clerk_identity_cutover" AS c
    WHERE c."id" = 1 AND c."ready"
      AND (l."eventVersion" NOT BETWEEN 1 AND 9007199254740991
        OR l."eventRank" NOT BETWEEN 1 AND 3
        OR l."eventVersion" > c."minimumEventVersion")
    UNION ALL
    SELECT 1
    FROM "clerk_user_lifecycle" AS l
    CROSS JOIN "clerk_identity_cutover" AS c
    WHERE c."id" = 1 AND c."ready"
      AND ((l."membershipEventVersion" IS NULL)
          IS DISTINCT FROM (l."membershipEventRank" IS NULL)
        OR (l."membershipEventVersion" IS NOT NULL AND (
          l."membershipEventVersion" NOT BETWEEN 1 AND 9007199254740991
          OR l."membershipEventRank" NOT BETWEEN 1 AND 3
          OR l."membershipEventVersion" > c."minimumEventVersion"
        )))
  ) AS readiness_violations) AS readiness_violation_rows;
${assertion(`(SELECT projection_mismatch_rows = 0 AND orphan_active_authority_rows = 0 AND readiness_violation_rows = 0 FROM _bootstrap_invariants)`)}
SELECT json_build_object(
  'organizationCount', organization_count,
  'membershipCount', membership_count,
  'userCount', user_count,
  'projectionMismatchRows', projection_mismatch_rows,
  'orphanActiveAuthorityRows', orphan_active_authority_rows,
  'readinessViolationRows', readiness_violation_rows
)::text
FROM _bootstrap_invariants;
${end}
`;
}

function protectedPostgresEnvironment() {
  return {
    ...process.env,
    PGAPPNAME: "workforce-production-clerk-reconciliation-executor",
    PGCONNECT_TIMEOUT: "5",
    PGOPTIONS: "-c search_path=public,pg_temp -c lock_timeout=5000 -c statement_timeout=900000 -c idle_in_transaction_session_timeout=60000",
  };
}

function probeDatabaseIdentity(expectedHash) {
  const result = spawnSync("psql", [
    "--no-psqlrc", "--set=ON_ERROR_STOP=1", "--quiet", "--tuples-only", "--no-align",
    "--command", PRODUCTION_DATABASE_IDENTITY_QUERY,
  ], {
    encoding: null,
    maxBuffer: 16 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    env: protectedPostgresEnvironment(),
  });
  if (result.error || result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
    fail("protected PostgreSQL identity probe failed");
  }
  return assertProductionDatabaseIdentityOutput(result.stdout, expectedHash);
}

function main() {
  const options = parseOptions(process.argv.slice(2));
  for (const name of ["PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGSSLMODE", "PGPASSFILE"]) {
    if (!process.env[name]) fail(`protected PostgreSQL environment ${name} is absent`);
  }
  externalPath(process.env.PGPASSFILE, "PGPASSFILE", true);
  if ((statSync(process.env.PGPASSFILE).mode & 0o777) !== 0o600) fail("PGPASSFILE must have mode 0600");
  const planBytes = readFileSync(options.plan);
  if (planBytes.length < 2 || planBytes.length > MAX_PLAN_BYTES) fail("private plan size is invalid");
  const plan = strictJsonParse(planBytes, "private Clerk reconciliation plan");
  const counts = validatePlan(plan, options);
  // This independent read-only probe must succeed before even materializing
  // transaction SQL. The same connection that executes SQL repeats the exact
  // identity assertion before BEGIN, closing a target-change race.
  const databaseIdentity = probeDatabaseIdentity(options.databaseIdentityHash);
  const sqlPath = `${options.output}.private.sql`;
  writeFileSync(sqlPath, sqlFor(plan, options.mode), { mode: 0o600, flag: "wx" });
  chmodSync(sqlPath, 0o600);
  try {
    verifyProductionBootstrapMutationAuthority({
      attemptId: options.attemptId,
      expectedBackendCommit: options.expectedBackendCommit,
      subscriptionId: options.authoritySubscriptionId,
      storageAccount: options.authorityStorageAccount,
      storageContainer: options.authorityStorageContainer,
      storageBlob: options.authorityStorageBlob,
    });
    const result = spawnSync("psql", [
      "--no-psqlrc", "--set=ON_ERROR_STOP=1", "--tuples-only", "--no-align",
      "--command", productionDatabaseIdentityAssertionSql(databaseIdentity),
      `--file=${sqlPath}`,
    ], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 16 * 60 * 1_000,
      killSignal: "SIGTERM",
      stdio: ["ignore", "pipe", "pipe"],
      env: protectedPostgresEnvironment(),
    });
    if (result.error || result.status !== 0) fail("Clerk reconciliation transaction or invariant check failed");
    const lines = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith("{"));
    if (lines.length !== 1) fail("Clerk reconciliation invariant result is ambiguous");
    const invariants = strictJsonParse(Buffer.from(lines[0]), "Clerk reconciliation invariant result");
    exactKeys(invariants, ["organizationCount", "membershipCount", "userCount", "projectionMismatchRows", "orphanActiveAuthorityRows", "readinessViolationRows"], "Clerk reconciliation invariant result");
    if (invariants.organizationCount !== counts.organizations || invariants.membershipCount !== counts.memberships ||
      invariants.userCount !== counts.users || invariants.projectionMismatchRows !== 0 ||
      invariants.orphanActiveAuthorityRows !== 0 || invariants.readinessViolationRows !== 0) {
      fail("Clerk reconciliation invariant counts differ from the frozen plan");
    }
    const completed = new Date(Math.floor(Date.now() / 1000) * 1000);
    const evidence = options.mode === "dry-run" ? {
      schemaVersion: 1,
      environment: "production",
      kind: "clerk-reconciliation-dry-run",
      attemptId: options.attemptId,
      rawPlanSha256: hash(planBytes),
      databaseIdentityHash: options.databaseIdentityHash,
      executorSha256: options.executorSha256,
      inventoryEvidenceHash: plan.cutover.inventoryEvidenceHash,
      minimumEventVersion: plan.cutover.minimumEventVersion,
      expectedActiveOrganizationCount: counts.organizations,
      expectedActiveMembershipCount: counts.memberships,
      expectedActiveUserCount: counts.users,
      status: "verified-no-write",
      verifiedAt: completed.toISOString().replace(".000Z", "Z"),
      expiresAt: new Date(completed.getTime() + 60 * 60 * 1000).toISOString().replace(".000Z", "Z"),
      invariants,
    } : {
      schemaVersion: 1,
      kind: "workforce-production-clerk-reconciliation-result",
      mode: "apply",
      attemptId: options.attemptId,
      rawPlanSha256: hash(planBytes),
      executorSha256: options.executorSha256,
      databaseIdentityHash: options.databaseIdentityHash,
      cutover: {
        minimumEventVersion: plan.cutover.minimumEventVersion,
        inventoryEvidenceHash: plan.cutover.inventoryEvidenceHash,
        expectedActiveOrganizationCount: counts.organizations,
        expectedActiveMembershipCount: counts.memberships,
        expectedActiveUserCount: counts.users,
      },
      invariants,
      completedAt: completed.toISOString().replace(".000Z", "Z"),
    };
    const envelope = { ...evidence, evidenceHash: hash(Buffer.from(canonicalJson(evidence))) };
    writeFileSync(options.output, `${canonicalJson(envelope)}\n`, { mode: 0o600, flag: "wx" });
  } finally {
    rmSync(sqlPath, { force: true });
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
