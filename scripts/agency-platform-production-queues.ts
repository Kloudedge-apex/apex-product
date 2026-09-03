#!/usr/bin/env node

import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { Queue } from "bullmq";
import { buildRedisConnectionOptions } from "../apps/api/src/runtime/queue.service";
import {
  PRODUCTION_BOOTSTRAP_QUEUE_NAMES,
  productionBootstrapRedisIdentityHash,
} from "../apps/api/src/ops/production-bootstrap-quiescence";
import { canonicalJson } from "./production-bootstrap-phase-ledger.mjs";

async function main() {
  const action = process.argv[2];
  const output = process.argv[3];
  const expectedIdentity = process.env.EXPECTED_REDIS_IDENTITY_HASH;

if ((action !== "pause" && action !== "resume") || !output ||
  !/^sha256:[0-9a-f]{64}$/.test(expectedIdentity ?? "") ||
  process.env.WORKFORCE_AGENCY_MIGRATION_AUTHORITY_CONFIRMED !== "true") {
  throw new Error("usage: agency-platform-production-queues <pause|resume> <output>");
}
if (productionBootstrapRedisIdentityHash() !== expectedIdentity) {
  throw new Error("Redis identity does not match the protected production target");
}

const connection = buildRedisConnectionOptions();
if (!connection) throw new Error("production Redis configuration is absent");

const queues = Object.fromEntries(
  Object.entries(PRODUCTION_BOOTSTRAP_QUEUE_NAMES).map(([key, name]) => [
    key,
    new Queue(name, { connection, skipMetasUpdate: true }),
  ]),
) as Record<keyof typeof PRODUCTION_BOOTSTRAP_QUEUE_NAMES, Queue>;

const snapshot = async () => Object.fromEntries(await Promise.all(
  Object.entries(queues).map(async ([key, queue]) => {
    const counts = await queue.getJobCounts("waiting", "active", "delayed", "paused");
    return [key, {
      name: queue.name,
      paused: await queue.isPaused(),
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      delayed: counts.delayed ?? 0,
      pausedJobs: counts.paused ?? 0,
      workerCount: (await queue.getWorkers()).length,
    }];
  }),
));

try {
  if (action === "pause") {
    await queues.outreachSend.pause();
    await queues.graphRuns.pause();
    await queues.agentRuns.pause();
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const state = await snapshot();
      if (Object.values(state).every((queue) => queue.paused && queue.active === 0)) break;
      if (attempt === 59) throw new Error("production queues did not pause and drain");
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  } else {
    await queues.graphRuns.resume();
    await queues.outreachSend.resume();
    await queues.agentRuns.pause();
  }

  const queuesState = await snapshot();
  const expected = action === "pause"
    ? Object.values(queuesState).every((queue) => queue.paused && queue.active === 0)
    : !queuesState.graphRuns.paused && !queuesState.outreachSend.paused &&
      queuesState.agentRuns.paused;
  if (!expected) throw new Error(`production queue ${action} readback failed`);

  const evidence = {
    schemaVersion: 1,
    kind: `agency-platform-production-queues-${action}`,
    capturedAt: new Date(Math.floor(Date.now() / 1_000) * 1_000).toISOString().replace(".000Z", "Z"),
    redisIdentityHash: expectedIdentity,
    queues: queuesState,
  };
  const evidenceHash = `sha256:${createHash("sha256").update(canonicalJson(evidence)).digest("hex")}`;
  await writeFile(output, `${JSON.stringify({ ...evidence, evidenceHash }, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  } finally {
    await Promise.all(Object.values(queues).map((queue) => queue.close()));
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
