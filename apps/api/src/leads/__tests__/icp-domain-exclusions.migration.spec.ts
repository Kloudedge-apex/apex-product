import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = resolve(
  __dirname,
  "../../../../../docs/migrations/2026-08-20_icp-exclusion-domains-expand.sql",
);

describe("ICP exclusion-domain migration", () => {
  it("adds and verifies the non-null text-array column without destructive data changes", () => {
    const sql = readFileSync(migrationPath, "utf8");

    expect(sql).toContain(
      'ADD COLUMN IF NOT EXISTS "exclusionDomains" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[]',
    );
    expect(sql).toContain("verified_column_count <> 1");
    expect(sql).not.toMatch(/^\s*(?:DELETE|TRUNCATE)\b/imu);
    expect(sql).not.toMatch(/^\s*DROP\s+(?:TABLE|TYPE)\b/imu);
  });
});
