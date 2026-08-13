import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = resolve(
  __dirname,
  "../../../../../docs/migrations/2026-08-13_clerk-identity-lifecycle-expand.sql",
);
const schemaPath = resolve(
  __dirname,
  "../../../../../packages/db/prisma/schema.prisma",
);

describe("Clerk identity lifecycle migration", () => {
  const migrationSql = readFileSync(migrationPath, "utf8");
  const schema = readFileSync(schemaPath, "utf8");

  it("adds immutable ids, fail-closed access, lifecycle cursors, and manager role", () => {
    expect(migrationSql).toContain(
      "ADD VALUE IF NOT EXISTS 'MANAGER' BEFORE 'MEMBER'",
    );
    expect(migrationSql).toContain('ADD COLUMN IF NOT EXISTS "clerkOrgId" TEXT');
    expect(migrationSql).toContain(
      'ADD COLUMN IF NOT EXISTS "clerkMembershipId" TEXT',
    );
    expect(migrationSql).toContain(
      'ADD COLUMN IF NOT EXISTS "membershipActive" BOOLEAN NOT NULL DEFAULT false',
    );
    expect(migrationSql).toContain(
      'CREATE TABLE IF NOT EXISTS "clerk_organization_lifecycle"',
    );
    expect(migrationSql).toContain(
      'CREATE TABLE IF NOT EXISTS "clerk_identity_cutover"',
    );
    expect(migrationSql).toContain("WITH inserted_cutover AS");
    expect(migrationSql).toMatch(
      /UPDATE "User"\s+SET "membershipActive" = false\s+WHERE EXISTS \(SELECT 1 FROM inserted_cutover\)/,
    );
    expect(migrationSql).toContain(
      'CREATE TABLE IF NOT EXISTS "clerk_membership_lifecycle"',
    );
    expect(migrationSql).toContain(
      'CREATE TABLE IF NOT EXISTS "clerk_user_lifecycle"',
    );
    expect(schema).toMatch(/enum UserRole \{[\s\S]*MANAGER[\s\S]*MEMBER/);
    expect(schema).toMatch(/clerkOrgId\s+String\?\s+@unique/);
    expect(schema).toMatch(/clerkMembershipId\s+String\?\s+@unique/);
    expect(schema).toMatch(/membershipActive\s+Boolean\s+@default\(false\)/);
    expect(schema).toContain("model ClerkOrganizationLifecycle");
    expect(schema).toContain("model ClerkIdentityCutover");
    expect(schema).toMatch(
      /expectedActiveOrganizationCount\s+Int\s+@default\(-1\)/,
    );
    expect(schema).toMatch(
      /expectedActiveMembershipCount\s+Int\s+@default\(-1\)/,
    );
    expect(schema).toMatch(
      /expectedActiveUserCount\s+Int\s+@default\(-1\)/,
    );
    expect(schema).toContain("model ClerkMembershipLifecycle");
    expect(schema).toContain("model ClerkUserLifecycle");
  });

  it("bounds every seeded lifecycle cursor and gates it against the snapshot", () => {
    expect(migrationSql).toContain(
      'CONSTRAINT "clerk_organization_lifecycle_event_version" CHECK',
    );
    expect(migrationSql).toContain(
      'CONSTRAINT "clerk_membership_lifecycle_event_version" CHECK',
    );
    expect(migrationSql).toContain(
      'CONSTRAINT "clerk_user_lifecycle_membership_cursor" CHECK',
    );
    expect(migrationSql).toMatch(
      /"eventVersion" BETWEEN 1 AND 9007199254740991/g,
    );
    expect(migrationSql).toMatch(/"eventRank" BETWEEN 1 AND 3/g);
    expect(migrationSql).toContain(
      '"membershipEventVersion" BETWEEN 1 AND 9007199254740991',
    );
    expect(migrationSql).toContain(
      '"membershipEventRank" BETWEEN 1 AND 3',
    );
    expect(migrationSql).toContain(
      "CREATE OR REPLACE FUNCTION clerk_identity_validate_cutover_arm()",
    );
    expect(migrationSql).toContain(
      '"eventVersion" > NEW."minimumEventVersion"',
    );
    expect(migrationSql).toContain(
      '"membershipEventVersion" > NEW."minimumEventVersion"',
    );
    expect(migrationSql).toContain(
      "Clerk identity lifecycle cursor is invalid or newer than the provider snapshot cutoff",
    );
    expect(migrationSql).toContain(
      "Clerk organization JS-safe event-version CHECK is absent or ineffective",
    );
    expect(migrationSql).toContain(
      "Clerk membership JS-safe event-version CHECK is absent or ineffective",
    );
    expect(migrationSql).toContain(
      "Clerk user JS-safe event-version CHECK is absent or ineffective",
    );
  });

  it("requires explicit inventory counts and exactly one ready singleton", () => {
    expect(migrationSql).toContain(
      '"expectedActiveOrganizationCount" INTEGER NOT NULL DEFAULT -1',
    );
    expect(migrationSql).toContain(
      '"expectedActiveMembershipCount" INTEGER NOT NULL DEFAULT -1',
    );
    expect(migrationSql).toContain(
      '"expectedActiveUserCount" INTEGER NOT NULL DEFAULT -1',
    );
    expect(migrationSql).toContain(
      'NEW."expectedActiveOrganizationCount" < 0',
    );
    expect(migrationSql).toContain(
      '<> NEW."expectedActiveOrganizationCount"',
    );
    expect(migrationSql).toContain(
      '<> NEW."expectedActiveMembershipCount"',
    );
    expect(migrationSql).toContain('<> NEW."expectedActiveUserCount"');
    expect(migrationSql).toContain(
      "Clerk identity cutover requires explicit nonnegative inventory counts",
    );
    expect(migrationSql).toContain(
      "Clerk identity inventory counts do not match",
    );
    expect(migrationSql).toContain('COUNT(*) AS "rowCount"');
    expect(migrationSql).toContain("COUNT(*) FILTER (");
    expect(migrationSql).toContain(
      'WHERE "rowCount" <> 1 OR "readyCount" <> 1',
    );
    expect(migrationSql).toContain(
      '"expectedActiveOrganizationCount" = <captured-nonnegative-count>',
    );
  });

  it("builds and verifies both unique indexes outside one transaction", () => {
    expect(migrationSql).toContain(
      'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "Org_clerkOrgId_key"',
    );
    expect(migrationSql).toContain(
      'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "User_clerkMembershipId_key"',
    );
    expect(migrationSql).toContain("i.indisvalid");
    expect(migrationSql).toContain("i.indisready");
    expect(migrationSql).toContain("i.indislive");
    expect(migrationSql).toContain("i.indisunique");
    expect(migrationSql).toContain("i.indnkeyatts = 1");
    expect(migrationSql).toContain("i.indnatts = 1");
    expect(migrationSql).toContain("i.indpred IS NULL");
    expect(migrationSql).toContain("i.indexprs IS NULL");
    expect(migrationSql).toContain("am.amname = 'btree'");
    expect(migrationSql).toContain("opc.opcname = 'text_ops'");
    expect(migrationSql).toContain("i.indoption[0] = 0");
    expect(migrationSql).toContain("i.indcollation[0]");
    expect(migrationSql).toContain("to_jsonb(i) ->> 'indnullsnotdistinct'");
    expect(migrationSql).toContain("t.relname = 'Org'");
    expect(migrationSql).toContain("a.attname = 'clerkOrgId'");
    expect(migrationSql.indexOf("COMMIT;")).toBeLessThan(
      migrationSql.indexOf("CREATE UNIQUE INDEX CONCURRENTLY"),
    );
  });

  it("rejects incompatible retry objects and requires reconciliation evidence", () => {
    expect(migrationSql).toContain("base_column_count <> 3");
    expect(migrationSql).toContain("lifecycle_column_count <> 34");
    expect(migrationSql).toContain("primary_key_count <> 4");
    expect(migrationSql).toContain("lifecycle_index_count <> 4");
    expect(migrationSql).toContain(
      "Clerk lifecycle boolean defaults are not fail-closed",
    );
    expect(migrationSql).toContain(
      "Clerk cutover singleton CHECK is absent or ineffective",
    );
    expect(migrationSql).toContain(
      "Clerk cutover positive-version CHECK is absent or ineffective",
    );
    expect(migrationSql).toContain(
      "Clerk cutover inventory-count CHECK is absent or ineffective",
    );
    expect(migrationSql).toContain(
      "Clerk cutover evidence CHECK is absent or ineffective",
    );
    expect(migrationSql).toContain(
      "Clerk cutover sentinel CHECK is absent or ineffective",
    );
    expect(migrationSql).toContain(
      "Clerk cutover epoch-ms CHECK is absent or ineffective",
    );
    expect(migrationSql).toContain(
      '(EXTRACT(EPOCH FROM "establishedAt") * 1000)::BIGINT - 86400000',
    );
    expect(migrationSql).toContain(
      'OR ul."membershipEventVersion" IS DISTINCT FROM ml."eventVersion"',
    );
    expect(migrationSql).toContain(
      'UPDATE "clerk_identity_cutover"',
    );
    expect(migrationSql).toContain(
      'SET "minimumEventVersion" = <verified-provider-snapshot-cutoff-ms>',
    );
    expect(migrationSql).toContain(
      '"minimumEventVersion" BETWEEN 1 AND 9007199254740991',
    );
    expect(migrationSql).toContain(
      "Attach the redacted reconciliation inventory",
    );
  });
});
