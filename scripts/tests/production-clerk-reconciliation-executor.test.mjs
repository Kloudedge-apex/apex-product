import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { validateClerkReconciliationDryRunEvidence } from "../production-bootstrap-controller.mjs";
import {
  PRODUCTION_DATABASE_IDENTITY_QUERY,
  productionDatabaseIdentityAssertionSql,
  productionDatabaseIdentityHash,
} from "../production-bootstrap-database-identity.mjs";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, "../..");
const EXECUTOR = resolve(REPO_ROOT, "scripts/production-clerk-reconciliation-executor.mjs");
const MIGRATION = resolve(REPO_ROOT, "docs/migrations/2026-08-13_clerk-identity-lifecycle-expand.sql");
const ATTEMPT_ID = "0123456789abcdef0123456789abcdef";
const DATABASE_IDENTITY_HASH = `sha256:${"a".repeat(64)}`;
const INVENTORY_EVIDENCE_HASH = `sha256:${"b".repeat(64)}`;
const EXECUTOR_SHA256 = `sha256:${createHash("sha256").update(readFileSync(EXECUTOR)).digest("hex")}`;
const BASE_SCHEMA = `
  CREATE TYPE "UserRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER');
  CREATE TABLE "Org" ("id" text PRIMARY KEY);
  CREATE TABLE "User" (
    "id" text PRIMARY KEY,
    "orgId" text NOT NULL REFERENCES "Org"("id"),
    "clerkId" text,
    "role" "UserRole" NOT NULL DEFAULT 'MEMBER'
  );
`;

let databaseSerial = 0;

function command(commandName, args, options = {}) {
  return spawnSync(commandName, args, {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    ...options,
  });
}

function requireSuccess(result, label) {
  assert.equal(
    result.status,
    0,
    `${label} failed\nstdout:\n${result.stdout ?? ""}\nstderr:\n${result.stderr ?? ""}`,
  );
  return result;
}

function sqlText(value) {
  const encoded = Buffer.from(value, "utf8").toString("base64");
  return `convert_from(decode('${encoded}', 'base64'), 'UTF8')`;
}

function safeDatabaseName(prefix) {
  databaseSerial += 1;
  return `clerk_executor_${prefix}_${process.pid}_${databaseSerial}_${randomBytes(3).toString("hex")}`;
}

function planFor(values = {}) {
  const localOrgId = values.localOrgId ?? "local-org-1";
  const localUserId = values.localUserId ?? "local-user-1";
  const localOnlyOrgId = values.localOnlyOrgId ?? "local-org-2";
  const localOwnerId = values.localOwnerId ?? "local-owner-1";
  const clerkOrgId = values.clerkOrgId ?? "org_clerk_1";
  const clerkUserId = values.clerkUserId ?? "user_clerk_1";
  const clerkMembershipId = values.clerkMembershipId ?? "membership_clerk_1";
  const eventVersion = values.eventVersion ?? Math.floor(Date.now() / 1000) * 1000;
  return {
    schemaVersion: 1,
    environment: "production",
    kind: "private-clerk-reconciliation-plan",
    attemptId: ATTEMPT_ID,
    backendCandidateCommit: "a".repeat(40),
    databaseIdentityHash: DATABASE_IDENTITY_HASH,
    approver: "release.approver@example.com",
    executor: {
      name: "workforce-production-clerk-reconciliation-executor",
      version: "v1",
      sha256: EXECUTOR_SHA256,
    },
    cutover: {
      minimumEventVersion: eventVersion,
      inventoryEvidenceHash: INVENTORY_EVIDENCE_HASH,
      expectedActiveOrganizationCount: 1,
      expectedActiveMembershipCount: 1,
      expectedActiveUserCount: 1,
    },
    operations: [
      {
        type: "organization",
        localOrgId,
        clerkOrgId,
        eventVersion,
        eventRank: 2,
        lastEventId: values.organizationEventId ?? "evt_organization_1",
      },
      {
        type: "membership",
        localOrgId,
        localUserId,
        clerkOrgId,
        clerkUserId,
        clerkMembershipId,
        eventVersion,
        eventRank: 2,
        role: "ADMIN",
        membershipLastEventId: values.membershipEventId ?? "evt_membership_1",
        userLastEventId: values.userEventId ?? "evt_user_1",
      },
      {
        type: "local-owner",
        localOrgId: localOnlyOrgId,
        localUserId: localOwnerId,
      },
    ],
  };
}

test("the private Clerk reconciliation executor is transactional, idempotent, and row-silent", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "workforce-clerk-executor-test-"));
  chmodSync(root, 0o700);
  const pgpass = join(root, "pgpass");
  const fakeBin = join(root, "authority-bin");
  mkdirSync(fakeBin, { mode: 0o700 });
  const fakeAz = join(fakeBin, "az");
  const fakeGh = join(fakeBin, "gh");
  writeFileSync(fakeAz, `#!/usr/bin/env bash
set -euo pipefail
while (($#)); do
  if [[ "$1" == "--lease-id" ]]; then printf '%s\\n' "$2"; exit 0; fi
  shift
done
exit 1
`, { mode: 0o700 });
  writeFileSync(fakeGh, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' '{"ref":"refs/heads/workforce-os-release-lock/production-gtm-platform","object":{"type":"commit","sha":"${"a".repeat(40)}"}}'
`, { mode: 0o700 });
  chmodSync(fakeAz, 0o700);
  chmodSync(fakeGh, 0o700);
  let containerName = null;
  let host;
  let port;
  let user;
  let password;
  let adminDatabase;
  let sslmode;

  const externalAdminUrl = process.env.CLERK_EXECUTOR_TEST_DATABASE_ADMIN_URL;
  if (externalAdminUrl) {
    const parsed = new URL(externalAdminUrl);
    assert.ok(new Set(["postgres:", "postgresql:"]).has(parsed.protocol));
    host = parsed.hostname;
    port = parsed.port || "5432";
    user = decodeURIComponent(parsed.username);
    password = decodeURIComponent(parsed.password);
    adminDatabase = decodeURIComponent(parsed.pathname.slice(1));
    sslmode = parsed.searchParams.get("sslmode") ?? "disable";
  } else {
    containerName = `workforce-clerk-executor-${process.pid}-${randomBytes(4).toString("hex")}`;
    user = "clerk_executor_test";
    password = `synthetic_${randomBytes(8).toString("hex")}`;
    adminDatabase = "postgres";
    sslmode = "disable";
    const started = command("docker", [
      "run", "--detach", "--rm", "--name", containerName,
      "--env", `POSTGRES_USER=${user}`,
      "--env", `POSTGRES_PASSWORD=${password}`,
      "--env", `POSTGRES_DB=${adminDatabase}`,
      "--publish", "127.0.0.1::5432",
      process.env.CLERK_EXECUTOR_TEST_POSTGRES_IMAGE ?? "postgres:14.18",
    ]);
    requireSuccess(started, "start disposable PostgreSQL");
    const mapped = requireSuccess(
      command("docker", ["port", containerName, "5432/tcp"]),
      "inspect disposable PostgreSQL port",
    ).stdout.trim();
    const match = mapped.match(/:(\d+)$/);
    assert.ok(match, `unexpected PostgreSQL port mapping: ${mapped}`);
    host = "127.0.0.1";
    port = match[1];
  }

  writeFileSync(pgpass, `${host}:${port}:*:${user}:${password}\n`, { mode: 0o600, flag: "wx" });
  chmodSync(pgpass, 0o600);
  const baseEnv = {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    PGHOST: host,
    PGPORT: port,
    PGUSER: user,
    PGPASSFILE: pgpass,
    PGSSLMODE: sslmode,
  };
  const psql = (database, args, label) => requireSuccess(command(
    "psql",
    ["--no-psqlrc", "--set=ON_ERROR_STOP=1", "--dbname", database, ...args],
    { env: { ...baseEnv, PGDATABASE: database } },
  ), label);
  const adminSql = (sql, label) => psql(adminDatabase, ["--command", sql], label);

  try {
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const result = command(
        "psql",
        ["--no-psqlrc", "--tuples-only", "--no-align", "--dbname", adminDatabase, "--command", "SELECT 1"],
        { env: { ...baseEnv, PGDATABASE: adminDatabase } },
      );
      if (result.status === 0 && result.stdout.trim() === "1") {
        ready = true;
        break;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
    assert.equal(ready, true, "disposable PostgreSQL did not become ready");

    const templateDatabase = safeDatabaseName("template");
    adminSql(`CREATE DATABASE "${templateDatabase}"`, "create exact-schema template database");
    psql(templateDatabase, ["--command", BASE_SCHEMA], "create migration base schema");
    psql(templateDatabase, ["--file", MIGRATION], "apply exact Clerk identity migration");

    async function withDatabase(prefix, callback) {
      const database = safeDatabaseName(prefix);
      adminSql(
        `CREATE DATABASE "${database}" TEMPLATE "${templateDatabase}"`,
        `create ${prefix} database`,
      );
      try {
        await callback(database);
      } finally {
        adminSql(`DROP DATABASE "${database}" WITH (FORCE)`, `drop ${prefix} database`);
      }
    }

    function query(database, sql) {
      return psql(
        database,
        ["--tuples-only", "--no-align", "--command", sql],
        "query executor test database",
      ).stdout.trim();
    }

    function seed(database, plan, { localOwnerClerkId = null } = {}) {
      const organization = plan.operations.find((operation) => operation.type === "organization");
      const membership = plan.operations.find((operation) => operation.type === "membership");
      const localOwner = plan.operations.find((operation) => operation.type === "local-owner");
      const localOwnerClerkSql = localOwnerClerkId === null ? "NULL" : sqlText(localOwnerClerkId);
      query(database, `
        INSERT INTO "Org" ("id") VALUES (${sqlText(organization.localOrgId)}), (${sqlText(localOwner.localOrgId)});
        INSERT INTO "User" ("id", "orgId", "clerkId", "role", "membershipActive") VALUES
          (${sqlText(membership.localUserId)}, ${sqlText(membership.localOrgId)}, NULL, 'MEMBER', false),
          (${sqlText(localOwner.localUserId)}, ${sqlText(localOwner.localOrgId)}, ${localOwnerClerkSql}, 'OWNER', false);
      `);
    }

    function snapshot(database) {
      return query(database, `
        SELECT json_build_object(
          'cutover', (SELECT json_agg(c ORDER BY c."id") FROM "clerk_identity_cutover" AS c),
          'orgs', (SELECT json_agg(o ORDER BY o."id") FROM "Org" AS o),
          'users', (SELECT json_agg(u ORDER BY u."id") FROM "User" AS u),
          'organizations', (SELECT json_agg(o ORDER BY o."clerkOrgId") FROM "clerk_organization_lifecycle" AS o),
          'memberships', (SELECT json_agg(m ORDER BY m."clerkMembershipId") FROM "clerk_membership_lifecycle" AS m),
          'lifecycleUsers', (SELECT json_agg(u ORDER BY u."clerkUserId") FROM "clerk_user_lifecycle" AS u)
        )::text;
      `);
    }

    let invocationSerial = 0;
    function invoke(database, mode, plan) {
      invocationSerial += 1;
      const databaseIdentityHash = productionDatabaseIdentityHash(
        JSON.parse(query(database, PRODUCTION_DATABASE_IDENTITY_QUERY)),
      );
      plan.databaseIdentityHash = databaseIdentityHash;
      const planPath = join(root, `plan-${invocationSerial}.json`);
      const outputPath = join(root, `output-${invocationSerial}.json`);
      const planBytes = Buffer.from(`${JSON.stringify(plan)}\n`, "utf8");
      writeFileSync(planPath, planBytes, { mode: 0o600, flag: "wx" });
      const result = command(process.execPath, [
        EXECUTOR,
        "--mode", mode,
        "--plan", planPath,
        "--attempt-id", ATTEMPT_ID,
        "--database-identity-hash", databaseIdentityHash,
        "--executor-sha256", EXECUTOR_SHA256,
        "--expected-backend-commit", "a".repeat(40),
        "--authority-subscription-id", "12345678-1234-4234-9234-123456789abc",
        "--authority-storage-account", "workforcebootstrap",
        "--authority-storage-container", "production-control",
        "--authority-storage-blob", "workforce-os/initial-production-bootstrap/state-v1.json",
        "--output", outputPath,
        "--yes",
      ], { env: { ...baseEnv, PGDATABASE: database } });
      return {
        result,
        planBytes,
        outputPath,
        privateSqlPath: `${outputPath}.private.sql`,
        databaseIdentityHash,
      };
    }

    await t.test("rejects stage regressions, duplicate identities, and control-character IDs", async () => {
      await withDatabase("validation", (database) => {
        const invalidPlans = [];

        const stageRegression = planFor();
        stageRegression.operations = [
          stageRegression.operations[0],
          stageRegression.operations[2],
          stageRegression.operations[1],
        ];
        invalidPlans.push(stageRegression);

        const duplicateOrganization = planFor();
        duplicateOrganization.operations.splice(1, 0, {
          ...duplicateOrganization.operations[0],
          clerkOrgId: "org_clerk_2",
          lastEventId: "evt_organization_2",
        });
        duplicateOrganization.cutover.expectedActiveOrganizationCount = 2;
        invalidPlans.push(duplicateOrganization);

        const duplicateLocalUser = planFor();
        duplicateLocalUser.operations.splice(2, 0, {
          ...duplicateLocalUser.operations[1],
          clerkUserId: "user_clerk_2",
          clerkMembershipId: "membership_clerk_2",
          membershipLastEventId: "evt_membership_2",
          userLastEventId: "evt_user_2",
        });
        duplicateLocalUser.cutover.expectedActiveMembershipCount = 2;
        duplicateLocalUser.cutover.expectedActiveUserCount = 2;
        invalidPlans.push(duplicateLocalUser);

        const invalidId = planFor();
        invalidId.operations[0].clerkOrgId = "bad\u0000identifier";
        invalidPlans.push(invalidId);

        for (const invalidPlan of invalidPlans) {
          const invocation = invoke(database, "dry-run", invalidPlan);
          assert.equal(invocation.result.status, 1);
          assert.equal(invocation.result.stdout, "");
          assert.match(invocation.result.stderr, /^ERROR: /);
          assert.equal(existsSync(invocation.outputPath), false);
          assert.equal(existsSync(invocation.privateSqlPath), false);
        }
      });
    });

    await t.test("cutover guard ignores hostile pg_temp lifecycle shadows", async () => {
      await withDatabase("temp_shadow", (database) => {
        const eventVersion = Math.floor(Date.now() / 1_000) * 1_000;
        const result = command("psql", [
          "--no-psqlrc", "--set=ON_ERROR_STOP=1", "--dbname", database,
          "--command", `
            SET search_path = pg_temp, public;
            CREATE TEMP TABLE "clerk_organization_lifecycle" (
              "eventVersion" bigint, "eventRank" integer, "deleted" boolean
            );
            CREATE TEMP TABLE "clerk_membership_lifecycle" (
              "eventVersion" bigint, "eventRank" integer, "deleted" boolean
            );
            CREATE TEMP TABLE "clerk_user_lifecycle" (
              "membershipEventVersion" bigint, "membershipEventRank" integer,
              "deleted" boolean, "membershipActive" boolean
            );
            INSERT INTO "clerk_organization_lifecycle" VALUES (${eventVersion}, 2, false);
            INSERT INTO "clerk_membership_lifecycle" VALUES (${eventVersion}, 2, false);
            INSERT INTO "clerk_user_lifecycle" VALUES (${eventVersion}, 2, false, true);
            UPDATE public."clerk_identity_cutover"
            SET "minimumEventVersion" = ${eventVersion},
                "inventoryEvidenceHash" = 'sha256:${"c".repeat(64)}',
                "expectedActiveOrganizationCount" = 1,
                "expectedActiveMembershipCount" = 1,
                "expectedActiveUserCount" = 1,
                "ready" = true,
                "updatedAt" = clock_timestamp()
            WHERE "id" = 1;
          `,
        ], { env: { ...baseEnv, PGDATABASE: database } });
        assert.notEqual(result.status, 0, "hostile temporary inventory armed the cutover");
        assert.match(result.stderr, /Clerk identity inventory counts do not match/u);
        assert.equal(query(
          database,
          `SELECT "ready"::text FROM public."clerk_identity_cutover" WHERE "id" = 1`,
        ), "false");
      });
    });

    await t.test("same-session identity assertion succeeds exactly and blocks a following mutation on mismatch", async () => {
      await withDatabase("identity_assertion", (database) => {
        const identity = JSON.parse(query(database, PRODUCTION_DATABASE_IDENTITY_QUERY));
        const accepted = command("psql", [
          "--no-psqlrc", "--set=ON_ERROR_STOP=1", "--dbname", database,
          "--command", productionDatabaseIdentityAssertionSql(identity),
          "--command", "CREATE TABLE public.identity_assertion_success (id integer)",
        ], { env: { ...baseEnv, PGDATABASE: database } });
        assert.equal(accepted.status, 0, accepted.stderr);

        const rejected = command("psql", [
          "--no-psqlrc", "--set=ON_ERROR_STOP=1", "--dbname", database,
          "--command", productionDatabaseIdentityAssertionSql({
            ...identity,
            database_name: "wrong-target",
          }),
          "--command", "CREATE TABLE public.identity_assertion_must_not_run (id integer)",
        ], { env: { ...baseEnv, PGDATABASE: database } });
        assert.notEqual(rejected.status, 0);
        assert.equal(query(
          database,
          "SELECT pg_catalog.to_regclass('public.identity_assertion_must_not_run') IS NULL",
        ), "t");
      });
    });

    await t.test("dry-run accepts encoded SQL metacharacters, rolls back, and is admitted by the controller", async () => {
      await withDatabase("dry_run", (database) => {
        const secretPayload = `row-secret-'; DROP TABLE "Org"; --`;
        const plan = planFor({
          localOrgId: `local-${secretPayload}`,
          localUserId: `user-${secretPayload}`,
          clerkOrgId: `clerk-org-${secretPayload}`,
          clerkUserId: `clerk-user-${secretPayload}`,
          clerkMembershipId: `clerk-membership-${secretPayload}`,
          organizationEventId: `organization-event-${secretPayload}`,
          membershipEventId: `membership-event-${secretPayload}`,
          userEventId: `user-event-${secretPayload}`,
        });
        seed(database, plan);
        const before = snapshot(database);
        const invocation = invoke(database, "dry-run", plan);
        assert.equal(invocation.result.status, 0, invocation.result.stderr);
        assert.equal(invocation.result.stdout, "");
        assert.equal(invocation.result.stderr, "");
        assert.equal(existsSync(invocation.privateSqlPath), false);
        assert.equal(snapshot(database), before, "dry-run wrote durable rows");
        assert.equal(query(database, `SELECT to_regclass('public."Org"') IS NOT NULL;`), "t");
        assert.doesNotMatch(`${invocation.result.stdout}${invocation.result.stderr}`, /row-secret/);

        const evidence = JSON.parse(readFileSync(invocation.outputPath, "utf8"));
        assert.equal(evidence.status, "verified-no-write");
        assert.deepEqual(evidence.invariants, {
          organizationCount: 1,
          membershipCount: 1,
          userCount: 1,
          projectionMismatchRows: 0,
          orphanActiveAuthorityRows: 0,
          readinessViolationRows: 0,
        });
        assert.equal(
          validateClerkReconciliationDryRunEvidence(
            plan,
            invocation.planBytes,
            evidence,
            { attemptId: ATTEMPT_ID, databaseIdentityHash: invocation.databaseIdentityHash },
          ),
          evidence.rawPlanSha256,
        );
      });
    });

    await t.test("apply commits once, preserves a null-Clerk-ID local owner, and retries idempotently", async () => {
      await withDatabase("apply", (database) => {
        const plan = planFor();
        seed(database, plan);
        const first = invoke(database, "apply", plan);
        assert.equal(first.result.status, 0, first.result.stderr);
        assert.equal(first.result.stdout, "");
        assert.equal(first.result.stderr, "");
        const firstState = snapshot(database);
        const firstEvidence = JSON.parse(readFileSync(first.outputPath, "utf8"));
        assert.deepEqual(firstEvidence.invariants, {
          organizationCount: 1,
          membershipCount: 1,
          userCount: 1,
          projectionMismatchRows: 0,
          orphanActiveAuthorityRows: 0,
          readinessViolationRows: 0,
        });
        assert.equal(
          query(database, `SELECT "clerkId" IS NULL AND "clerkMembershipId" IS NULL AND "membershipActive" AND "role" = 'OWNER' FROM "User" WHERE "id" = 'local-owner-1';`),
          "t",
        );

        const second = invoke(database, "apply", plan);
        assert.equal(second.result.status, 0, second.result.stderr);
        assert.equal(second.result.stdout, "");
        assert.equal(second.result.stderr, "");
        assert.equal(snapshot(database), firstState, "idempotent apply changed committed state");
        assert.deepEqual(JSON.parse(readFileSync(second.outputPath, "utf8")).invariants, firstEvidence.invariants);
      });
    });

    await t.test("rejects a non-null Clerk ID on a local organization without exposing row data", async () => {
      await withDatabase("local_owner_fail", (database) => {
        const rowSecret = "private-local-owner-clerk-id";
        const plan = planFor();
        seed(database, plan, { localOwnerClerkId: rowSecret });
        const before = snapshot(database);
        const invocation = invoke(database, "apply", plan);
        assert.equal(invocation.result.status, 1);
        assert.equal(invocation.result.stdout, "");
        assert.match(invocation.result.stderr, /^ERROR: Clerk reconciliation transaction or invariant check failed\n$/);
        assert.doesNotMatch(invocation.result.stderr, new RegExp(rowSecret));
        assert.equal(snapshot(database), before);
        assert.equal(existsSync(invocation.outputPath), false);
        assert.equal(existsSync(invocation.privateSqlPath), false);
      });
    });

    await t.test("an invariant failure rolls back every mutation and emits no row-bearing values", async () => {
      await withDatabase("rollback", (database) => {
        const rowSecret = "private-orphan-authority-secret";
        const plan = planFor();
        seed(database, plan);
        query(database, `
          UPDATE "User" SET "membershipActive" = true WHERE "id" = 'local-user-1';
          INSERT INTO "clerk_organization_lifecycle"
            ("clerkOrgId", "eventVersion", "eventRank", "deleted", "lastEventId", "updatedAt")
          VALUES (${sqlText(rowSecret)}, ${plan.cutover.minimumEventVersion}, 2, false, ${sqlText(rowSecret)}, clock_timestamp());
        `);
        const before = snapshot(database);
        const invocation = invoke(database, "apply", plan);
        assert.equal(invocation.result.status, 1);
        assert.equal(invocation.result.stdout, "");
        assert.match(invocation.result.stderr, /^ERROR: Clerk reconciliation transaction or invariant check failed\n$/);
        assert.doesNotMatch(invocation.result.stderr, new RegExp(rowSecret));
        assert.equal(snapshot(database), before, "failed invariant left partial reconciliation state");
        assert.equal(existsSync(invocation.outputPath), false);
        assert.equal(existsSync(invocation.privateSqlPath), false);
      });
    });

    adminSql(`DROP DATABASE "${templateDatabase}" WITH (FORCE)`, "drop exact-schema template database");
  } finally {
    if (containerName) command("docker", ["rm", "--force", containerName]);
    rmSync(root, { recursive: true, force: true });
  }
});
