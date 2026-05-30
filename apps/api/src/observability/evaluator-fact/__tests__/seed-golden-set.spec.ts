import { describe, it, expect } from "vitest";
import { SEEDED_EVALUATORS, resolveOrgId, seedGoldenSet } from "../../../../scripts/seed-golden-set";

function makePrisma() {
  const examples = new Map<string, unknown>();
  const evidenceEvents: unknown[] = [];
  return {
    goldenSetExample: {
      upsert: async (args: any) => {
        const key = JSON.stringify(args.where.orgId_scenarioKey_version);
        const exists = examples.has(key);
        examples.set(key, exists ? args.update : args.create);
        return examples.get(key);
      },
    },
    evidenceEvent: {
      create: async (args: any) => {
        evidenceEvents.push(args.data);
        return args.data;
      },
    },
    _examples: examples,
    _evidenceEvents: evidenceEvents,
  };
}

describe("seed-golden-set", () => {
  it("rejects missing orgId (no arg, no env)", () => {
    expect(() => resolveOrgId([], {} as any)).toThrow(/Missing orgId/i);
  });

  it("writes 9 evaluator buckets and is idempotent on re-run", async () => {
    const prisma = makePrisma();
    const orgId = "org_seed";

    const first = await seedGoldenSet(prisma as any, orgId);
    expect(first.seeded).toBeGreaterThan(0);
    for (const key of SEEDED_EVALUATORS) {
      expect(first.countsByEvaluator[key]).toBeGreaterThan(0);
    }

    const sizeAfterFirst = prisma._examples.size;
    const second = await seedGoldenSet(prisma as any, orgId);
    expect(second.seeded).toBe(first.seeded);
    expect(prisma._examples.size).toBe(sizeAfterFirst);
  });
});

