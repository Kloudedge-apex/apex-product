/**
 * Static validation of the ground-truth datasets used by the correctness
 * evaluator and the LangSmith upload script. These tests guard the contract:
 * if anyone adds/removes/renames a row or breaks the schema, CI fails before
 * the next dataset upload silently corrupts the evaluation surface.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

interface DatasetRow {
  readonly id: string;
  readonly input: Record<string, unknown>;
  readonly ground_truth: Record<string, unknown>;
  readonly tags?: readonly string[];
}

const DATASET_DIR = join(__dirname, "..");

const DATASETS: ReadonlyArray<{ readonly file: string; readonly slug: string }> = [
  { file: "icp_auto_extractor.dataset.json", slug: "icp_auto_extractor" },
  { file: "team_page_extractor.dataset.json", slug: "team_page_extractor" },
  { file: "inbox_monitor.dataset.json", slug: "inbox_monitor" },
  { file: "reporting_agent.dataset.json", slug: "reporting_agent" },
];

function loadRows(file: string): DatasetRow[] {
  const raw = JSON.parse(readFileSync(join(DATASET_DIR, file), "utf-8")) as unknown;
  if (!Array.isArray(raw)) {
    throw new Error(`${file} must be a JSON array at the top level`);
  }
  return raw as DatasetRow[];
}

describe("ground-truth datasets", () => {
  for (const { file, slug } of DATASETS) {
    describe(slug, () => {
      const rows = loadRows(file);

      it("contains exactly 20 rows", () => {
        expect(rows).toHaveLength(20);
      });

      it("every row has id, input, ground_truth", () => {
        for (const row of rows) {
          expect(typeof row.id).toBe("string");
          expect(row.id.length).toBeGreaterThan(0);
          expect(typeof row.input).toBe("object");
          expect(row.input).not.toBeNull();
          expect(typeof row.ground_truth).toBe("object");
          expect(row.ground_truth).not.toBeNull();
        }
      });

      it("row ids are unique", () => {
        const ids = rows.map((r) => r.id);
        const unique = new Set(ids);
        expect(unique.size).toBe(ids.length);
      });

      it("each row serializes to under 2KB", () => {
        for (const row of rows) {
          const size = Buffer.byteLength(JSON.stringify(row), "utf-8");
          expect(size).toBeLessThanOrEqual(2048);
        }
      });
    });
  }
});

describe("icp_auto_extractor schema", () => {
  const rows = loadRows("icp_auto_extractor.dataset.json");

  it("every ground_truth has the ExtractedIcp shape", () => {
    for (const row of rows) {
      const gt = row.ground_truth as Record<string, unknown>;
      expect(typeof gt.productSummary).toBe("string");
      expect(typeof gt.industry).toBe("string");
      expect(Array.isArray(gt.targetTitles)).toBe(true);
      expect(Array.isArray(gt.targetIndustries)).toBe(true);
      expect(Array.isArray(gt.targetGeos)).toBe(true);
      expect(Array.isArray(gt.intentKeywords)).toBe(true);
      // minEmployees/maxEmployees: number or null
      expect(["number", "object"]).toContain(typeof gt.minEmployees);
      expect(["number", "object"]).toContain(typeof gt.maxEmployees);
    }
  });

  it("at least one of targetTitles/targetIndustries/intentKeywords is non-empty per row", () => {
    for (const row of rows) {
      const gt = row.ground_truth as Record<string, unknown>;
      const titles = Array.isArray(gt.targetTitles) ? gt.targetTitles.length : 0;
      const industries = Array.isArray(gt.targetIndustries)
        ? gt.targetIndustries.length
        : 0;
      const keywords = Array.isArray(gt.intentKeywords) ? gt.intentKeywords.length : 0;
      expect(titles + industries + keywords).toBeGreaterThan(0);
    }
  });

  it("spot-check icp_001 — SaaS RevOps profile", () => {
    const row = rows.find((r) => r.id === "icp_001");
    expect(row).toBeDefined();
    const gt = row!.ground_truth as Record<string, unknown>;
    expect(gt.industry).toMatch(/SaaS|Sales/);
    expect(gt.targetTitles).toEqual(
      expect.arrayContaining([expect.stringMatching(/RevOps|Sales/i)]),
    );
  });
});

describe("team_page_extractor schema", () => {
  const rows = loadRows("team_page_extractor.dataset.json");

  it("every ground_truth has a people array", () => {
    for (const row of rows) {
      const gt = row.ground_truth as Record<string, unknown>;
      expect(Array.isArray(gt.people)).toBe(true);
    }
  });

  it("each person has firstName and lastName", () => {
    for (const row of rows) {
      const gt = row.ground_truth as { people: Array<Record<string, unknown>> };
      for (const person of gt.people) {
        expect(typeof person.firstName).toBe("string");
        expect(typeof person.lastName).toBe("string");
      }
    }
  });

  it("at least one row has empty officers (no-officers case)", () => {
    const emptyRows = rows.filter((r) => {
      const gt = r.ground_truth as { people: unknown[] };
      return gt.people.length === 0;
    });
    expect(emptyRows.length).toBeGreaterThan(0);
  });

  it("spot-check team_005 — empty body returns no officers", () => {
    const row = rows.find((r) => r.id === "team_005");
    expect(row).toBeDefined();
    const gt = row!.ground_truth as { people: unknown[] };
    expect(gt.people).toEqual([]);
  });
});

describe("inbox_monitor schema", () => {
  const rows = loadRows("inbox_monitor.dataset.json");
  const allowedCategories = new Set([
    "urgent",
    "follow-up",
    "newsletter",
    "spam",
    "meeting_request",
    "pricing_inquiry",
    "unsubscribe",
    "objection",
    "support",
    "unclear",
  ]);

  it("every ground_truth has category, priority, suggestedReply, autoReplied", () => {
    for (const row of rows) {
      const gt = row.ground_truth as Record<string, unknown>;
      expect(typeof gt.category).toBe("string");
      expect(allowedCategories.has(gt.category as string)).toBe(true);
      expect(typeof gt.priority).toBe("number");
      expect(gt.priority).toBeGreaterThanOrEqual(1);
      expect(gt.priority).toBeLessThanOrEqual(5);
      // suggestedReply: string | null
      expect(["string", "object"]).toContain(typeof gt.suggestedReply);
      expect(typeof gt.autoReplied).toBe("boolean");
    }
  });

  it("includes at least one 'unclear' failure-mode row with a reason", () => {
    const unclear = rows.filter((r) => {
      const gt = r.ground_truth as Record<string, unknown>;
      return gt.category === "unclear";
    });
    expect(unclear.length).toBeGreaterThan(0);
    for (const row of unclear) {
      const gt = row.ground_truth as Record<string, unknown>;
      expect(gt.suggestedReply).toBeNull();
      expect(gt.autoReplied).toBe(false);
      expect(typeof gt.reason).toBe("string");
    }
  });

  it("spot-check inbox_003 — unsubscribe row is correctly labeled", () => {
    const row = rows.find((r) => r.id === "inbox_003");
    expect(row).toBeDefined();
    const gt = row!.ground_truth as Record<string, unknown>;
    expect(gt.category).toBe("unsubscribe");
    expect(gt.suggestedReply).toBeNull();
    expect(gt.autoReplied).toBe(false);
  });

  it("spot-check inbox_007 — unclear row preserves failure-mode contract", () => {
    const row = rows.find((r) => r.id === "inbox_007");
    expect(row).toBeDefined();
    const gt = row!.ground_truth as Record<string, unknown>;
    expect(gt.category).toBe("unclear");
    expect(gt.priority).toBe(3);
    expect(gt.suggestedReply).toBeNull();
  });
});

describe("reporting_agent schema", () => {
  const rows = loadRows("reporting_agent.dataset.json");

  it("every ground_truth has type/reportType/period/metrics/trends/recommendations/summary", () => {
    for (const row of rows) {
      const gt = row.ground_truth as Record<string, unknown>;
      expect(gt.type).toBe("report");
      expect(typeof gt.reportType).toBe("string");
      expect(typeof gt.period).toBe("string");
      expect(typeof gt.metrics).toBe("object");
      expect(typeof gt.trends).toBe("object");
      expect(Array.isArray(gt.recommendations)).toBe(true);
      expect(typeof gt.summary).toBe("string");
    }
  });

  it("includes at least one 'not available in current dataset' failure-mode row", () => {
    const missingMetricRows = rows.filter((r) => {
      const gt = r.ground_truth as { metrics: Record<string, unknown> };
      return Object.values(gt.metrics).some(
        (v) => typeof v === "string" && v.includes("not available in current dataset"),
      );
    });
    expect(missingMetricRows.length).toBeGreaterThan(0);
  });

  it("trends use up|down|flat|unknown vocabulary only", () => {
    const allowed = new Set(["up", "down", "flat", "unknown"]);
    for (const row of rows) {
      const gt = row.ground_truth as { trends: Record<string, unknown> };
      for (const value of Object.values(gt.trends)) {
        expect(typeof value).toBe("string");
        expect(allowed.has(value as string)).toBe(true);
      }
    }
  });

  it("spot-check report_003 — missing baseline yields unknown trend", () => {
    const row = rows.find((r) => r.id === "report_003");
    expect(row).toBeDefined();
    const gt = row!.ground_truth as { trends: Record<string, string> };
    expect(gt.trends.emailsSent).toBe("unknown");
    expect(gt.trends.responseRate).toBe("unknown");
  });
});
