import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migrationSql = readFileSync(
  resolve(
    __dirname,
    "../../../../../docs/migrations/2026-08-12_conversation-reply-single-flight-expand.sql",
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

describe("conversation reply single-flight migration", () => {
  it("keeps both concurrent index builds outside explicit transactions", () => {
    let inExplicitTransaction = false;
    let concurrentBuilds = 0;

    for (const statement of executableStatements(migrationSql)) {
      if (/^(?:BEGIN|START\s+TRANSACTION)\b/i.test(statement)) {
        inExplicitTransaction = true;
      }
      if (/\bCREATE\s+UNIQUE\s+INDEX\s+CONCURRENTLY\b/i.test(statement)) {
        concurrentBuilds += 1;
        expect(inExplicitTransaction).toBe(false);
      }
      if (/^(?:COMMIT|ROLLBACK)\b/i.test(statement)) {
        inExplicitTransaction = false;
      }
    }

    expect(concurrentBuilds).toBe(2);
  });

  it("pins fail-fast, writer-pause, duplicate, and validity guards", () => {
    expect(migrationSql).toMatch(/^\\set ON_ERROR_STOP on$/m);
    expect(migrationSql).toMatch(/^\\set AUTOCOMMIT on$/m);
    expect(migrationSql).toContain("MANDATORY: pause every writer");
    expect(migrationSql).toContain("HAVING COUNT(*) > 1");
    expect(migrationSql).toContain("indisvalid");
    expect(migrationSql).toContain("indisready");
    expect(migrationSql).not.toMatch(
      /CREATE\s+UNIQUE\s+INDEX\s+CONCURRENTLY\s+IF\s+NOT\s+EXISTS/i,
    );
  });

  it("pins both the source-specific and conversation-wide blocking states", () => {
    expect(migrationSql).toContain(
      '"OutreachArtifact_one_reply_per_inbound_uniq"',
    );
    expect(migrationSql).toContain(
      '"OutreachArtifact_one_open_reply_per_conversation_uniq"',
    );
    for (const status of [
      "DRAFT",
      "PENDING_REVIEW",
      "APPROVED",
      "SENDING",
      "SENT",
      "DELIVERY_UNKNOWN",
    ]) {
      expect(migrationSql).toContain(
        `'${status}'::"OutreachArtifactStatus"`,
      );
    }
  });
});
