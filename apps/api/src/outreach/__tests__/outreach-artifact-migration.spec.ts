import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migrationPath = resolve(
  __dirname,
  "../../../../../docs/migrations/2026-06-01_outreach-artifact-unique.sql",
);

const migrationSql = readFileSync(migrationPath, "utf8");

function executableStatements(sql: string): string[] {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--.*$/gm, " ")
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)\$[\s\S]*?\$\1\$/g, " ")
    .replace(/^\s*\\.*$/gm, " ")
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

describe("OutreachArtifact idempotency migration", () => {
  it("keeps concurrent index operations outside explicit transactions", () => {
    let inExplicitTransaction = false;
    let concurrentStatementCount = 0;

    for (const statement of executableStatements(migrationSql)) {
      if (/^(?:BEGIN|START\s+TRANSACTION)\b/i.test(statement)) {
        inExplicitTransaction = true;
      }

      if (/\b(?:CREATE|DROP)\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\b/i.test(statement)) {
        concurrentStatementCount += 1;
        expect(inExplicitTransaction).toBe(false);
      }

      if (/^(?:COMMIT|ROLLBACK)\b/i.test(statement)) {
        inExplicitTransaction = false;
      }
    }

    expect(concurrentStatementCount).toBeGreaterThan(0);
  });

  it("pins the fail-fast psql and duplicate-preflight contract", () => {
    expect(migrationSql).toMatch(/^\\set ON_ERROR_STOP on$/m);
    expect(migrationSql).toMatch(/^\\set AUTOCOMMIT on$/m);
    expect(migrationSql).toContain("duplicate_group_count");
    expect(migrationSql).toMatch(/DROP INDEX CONCURRENTLY IF EXISTS/);
    expect(migrationSql).toContain("indisvalid");
    expect(migrationSql).toContain("indisready");
    expect(migrationSql).toContain("do not add `-1`/`--single-transaction`");
  });
});
