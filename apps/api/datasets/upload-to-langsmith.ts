/**
 * One-shot uploader that mirrors the JSON dataset files in this directory to
 * LangSmith. Each row's `id` is mirrored into the LangSmith Example's
 * `metadata.row_id` so re-running the script is idempotent — existing rows are
 * skipped, only new rows get created.
 *
 * Usage:
 *   LANGSMITH_API_KEY=... pnpm --filter @apex/api datasets:upload
 *   # or
 *   LANGSMITH_API_KEY=... npx tsx apps/api/datasets/upload-to-langsmith.ts
 *
 * The script never deletes or mutates existing rows; it only appends.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "langsmith";

interface DatasetRow {
  readonly id: string;
  readonly input: Record<string, unknown>;
  readonly ground_truth: Record<string, unknown>;
  readonly tags?: readonly string[];
}

interface DatasetSpec {
  readonly file: string;
  readonly datasetName: string;
  readonly description: string;
}

const DATASETS: readonly DatasetSpec[] = [
  {
    file: "icp_auto_extractor.dataset.json",
    datasetName: "apex-icp-auto-extractor",
    description:
      "Ground-truth ICP profiles for the icp_auto_extractor agent. " +
      "Inputs are company URL + scraped homepage text; outputs match the ExtractedIcp shape emitted by icp-auto.service.ts.",
  },
  {
    file: "team_page_extractor.dataset.json",
    datasetName: "apex-team-page-extractor",
    description:
      "Ground-truth officer lists for the team_page_extractor agent. " +
      "Inputs are synthetic team-page HTML; outputs match the {people: DiscoveredPerson[]} shape emitted by team-page-scraper.service.ts.",
  },
  {
    file: "inbox_monitor.dataset.json",
    datasetName: "apex-inbox-monitor",
    description:
      "Ground-truth email triage classifications for the inbox_monitor agent. " +
      "Inputs are one email; outputs match the per-email shape emitted by inbox-monitor.ts (category, priority, suggestedReply, autoReplied, reason?).",
  },
  {
    file: "reporting_agent.dataset.json",
    datasetName: "apex-reporting-agent",
    description:
      "Ground-truth weekly/monthly reports for the reporting_agent. " +
      "Inputs are KPI payloads + timeframe; outputs match the shape emitted by reporting-agent.ts (type/reportType/period/metrics/trends/recommendations/summary).",
  },
];

interface UploadSummary {
  readonly datasetName: string;
  readonly created: number;
  readonly skipped: number;
}

function isDatasetRow(value: unknown): value is DatasetRow {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj.id !== "string" || obj.id.length === 0) return false;
  if (typeof obj.input !== "object" || obj.input === null) return false;
  if (typeof obj.ground_truth !== "object" || obj.ground_truth === null) return false;
  if (obj.tags !== undefined) {
    if (!Array.isArray(obj.tags) || !obj.tags.every((t) => typeof t === "string")) {
      return false;
    }
  }
  return true;
}

function loadDataset(filePath: string): DatasetRow[] {
  const raw = JSON.parse(readFileSync(filePath, "utf-8")) as unknown;
  if (!Array.isArray(raw)) {
    throw new Error(`Dataset at ${filePath} is not a JSON array`);
  }
  const rows: DatasetRow[] = [];
  for (const item of raw) {
    if (!isDatasetRow(item)) {
      throw new Error(
        `Dataset at ${filePath} contains an invalid row: ${JSON.stringify(item).slice(0, 200)}`,
      );
    }
    rows.push(item);
  }
  return rows;
}

async function ensureDataset(
  client: Client,
  spec: DatasetSpec,
): Promise<string> {
  const exists = await client.hasDataset({ datasetName: spec.datasetName });
  if (exists) {
    const ds = await client.readDataset({ datasetName: spec.datasetName });
    if (typeof ds.id !== "string") {
      throw new Error(`LangSmith returned a dataset without an id for ${spec.datasetName}`);
    }
    return ds.id;
  }
  const created = await client.createDataset(spec.datasetName, {
    description: spec.description,
  });
  if (typeof created.id !== "string") {
    throw new Error(`createDataset did not return an id for ${spec.datasetName}`);
  }
  return created.id;
}

async function existingRowIds(client: Client, datasetId: string): Promise<Set<string>> {
  const seen = new Set<string>();
  for await (const example of client.listExamples({ datasetId })) {
    const metadata = example.metadata as Record<string, unknown> | undefined;
    const rowId = metadata?.row_id;
    if (typeof rowId === "string" && rowId.length > 0) {
      seen.add(rowId);
    }
  }
  return seen;
}

async function uploadDataset(
  client: Client,
  spec: DatasetSpec,
  datasetDir: string,
): Promise<UploadSummary> {
  const rows = loadDataset(join(datasetDir, spec.file));
  const datasetId = await ensureDataset(client, spec);
  const seen = await existingRowIds(client, datasetId);

  const toCreate = rows.filter((r) => !seen.has(r.id));
  let created = 0;

  if (toCreate.length > 0) {
    const uploads = toCreate.map((row) => ({
      inputs: row.input,
      outputs: row.ground_truth,
      metadata: {
        row_id: row.id,
        tags: row.tags ?? [],
      },
      dataset_id: datasetId,
    }));
    // Batch upload — LangSmith accepts up to a few hundred per call.
    const BATCH = 50;
    for (let i = 0; i < uploads.length; i += BATCH) {
      const slice = uploads.slice(i, i + BATCH);
      const result = await client.createExamples(slice);
      created += result.length;
    }
  }

  return {
    datasetName: spec.datasetName,
    created,
    skipped: rows.length - created,
  };
}

async function main(): Promise<void> {
  const apiKey = process.env.LANGSMITH_API_KEY;
  if (!apiKey || apiKey.trim().length === 0) {
    // eslint-disable-next-line no-console
    console.error(
      "ERROR: LANGSMITH_API_KEY is not set. Export it and re-run, e.g. LANGSMITH_API_KEY=ls__... pnpm --filter @apex/api datasets:upload",
    );
    process.exit(1);
  }

  const client = new Client({ apiKey });
  const datasetDir = __dirname;

  // eslint-disable-next-line no-console
  console.log(`Uploading ${DATASETS.length} datasets to LangSmith...`);
  const summaries: UploadSummary[] = [];
  for (const spec of DATASETS) {
    try {
      const summary = await uploadDataset(client, spec, datasetDir);
      summaries.push(summary);
      // eslint-disable-next-line no-console
      console.log(
        `  ${summary.datasetName}: ${JSON.stringify({ created: summary.created, skipped: summary.skipped })}`,
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        `  ${spec.datasetName}: FAILED — ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  }

  const totalCreated = summaries.reduce((acc, s) => acc + s.created, 0);
  const totalSkipped = summaries.reduce((acc, s) => acc + s.skipped, 0);
  // eslint-disable-next-line no-console
  console.log(
    `Done. Total: ${JSON.stringify({ created: totalCreated, skipped: totalSkipped })}`,
  );
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
