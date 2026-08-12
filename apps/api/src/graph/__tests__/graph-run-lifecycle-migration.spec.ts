import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationSql = readFileSync(
  resolve(
    __dirname,
    "../../../../../docs/migrations/2026-08-12_graph-run-lifecycle-expand.sql",
  ),
  "utf8",
);

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

describe("GraphRun lifecycle migration", () => {
  it("keeps every concurrent index operation outside explicit transactions", () => {
    let inExplicitTransaction = false;
    let concurrentStatementCount = 0;

    for (const statement of executableStatements(migrationSql)) {
      if (/^(?:BEGIN|START\s+TRANSACTION)\b/i.test(statement)) {
        inExplicitTransaction = true;
      }
      if (
        /\b(?:CREATE|DROP)\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\b/i.test(
          statement,
        )
      ) {
        concurrentStatementCount += 1;
        expect(inExplicitTransaction).toBe(false);
      }
      if (/^(?:COMMIT|ROLLBACK)\b/i.test(statement)) {
        inExplicitTransaction = false;
      }
    }

    expect(concurrentStatementCount).toBeGreaterThan(0);
  });

  it("pins prerequisites, retry safety, preflight, and executable postconditions", () => {
    expect(migrationSql).toMatch(/^\\set ON_ERROR_STOP on$/m);
    expect(migrationSql).toMatch(/^\\set AUTOCOMMIT on$/m);
    expect(migrationSql).toContain("graph-run-activity-expand.sql");
    expect(migrationSql).toContain("duplicate_active_org_count");
    expect(migrationSql).toMatch(/DROP INDEX CONCURRENTLY IF EXISTS/);
    expect(migrationSql).toContain("indisvalid");
    expect(migrationSql).toContain("indisready");
    expect(migrationSql).toContain("indislive");
    expect(migrationSql).toContain("verified_column_count");
    expect(migrationSql).toContain("verified_index_count");
  });
});
