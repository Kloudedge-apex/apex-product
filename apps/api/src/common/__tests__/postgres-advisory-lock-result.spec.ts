import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const advisoryLockSources = new Map([
  ["auth/auth.service.ts", 1],
  ["common/clerk-user-provisioning.ts", 1],
  ["graph/graph.service.ts", 1],
  ["integrations/gmail/gmail.service.ts", 1],
  ["leads/leads.service.ts", 1],
  ["outreach/outreach-send-reservation-lock.ts", 1],
  ["outreach/reply-single-flight.ts", 2],
]);

describe("PostgreSQL advisory-lock query results", () => {
  it("projects every void advisory lock result to a Prisma-safe scalar", () => {
    const sourceRoot = resolve(__dirname, "../..");

    for (const [relativePath, expectedLockCount] of advisoryLockSources) {
      const source = readFileSync(resolve(sourceRoot, relativePath), "utf8");
      const lockCount = source.match(/SELECT\s+pg_advisory_xact_lock\(/g)?.length ?? 0;
      const projectedCount =
        source.match(
          /SELECT\s+pg_advisory_xact_lock\([\s\S]*?\)\s+IS NULL AS acquired/g,
        )?.length ?? 0;

      expect(lockCount, relativePath).toBe(expectedLockCount);
      expect(projectedCount, relativePath).toBe(expectedLockCount);
    }
  });
});
