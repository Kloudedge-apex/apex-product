#!/usr/bin/env node

/**
 * Narrow Redis/BullMQ control surface for the source-controlled initial
 * production bootstrap controller. Azure and schema operations do not belong
 * here. Every mutating action is protected-authority-only and emits a new
 * outside-repository evidence file.
 */

import { createHash } from "node:crypto";
import { lstat, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import {
  acquireProductionBootstrapFence,
  assertProductionBootstrapDatabaseIdentity,
  assertProductionBootstrapInventoryReady,
  assertProductionBootstrapAttemptId,
  createProductionBootstrapRuntime,
  pauseProductionBootstrapQueues,
  readProductionBootstrapDatabaseInventory,
  resumeProductionBootstrapQueues,
  snapshotProductionBootstrapQueues,
  verifyProductionBootstrapQueues,
} from "../apps/api/src/ops/production-bootstrap-quiescence";
import {
  armProductionBootstrapWriterFence,
  assertClosedWriterFenceReadback,
  disarmProductionBootstrapWriterFence,
  readProductionBootstrapWriterFence,
  recoverProductionBootstrapOrphanedWriterTokens,
  rotateProductionBootstrapWriterFence,
} from "../apps/api/src/ops/production-bootstrap-writer-fence";
import { verifyProductionBootstrapMutationAuthority } from "./production-bootstrap-mutation-authority.mjs";

type Action = "pause-only" | "recover-orphans" | "arm" | "hold" | "resume" | "read" | "read-open" | "renew";

interface Options {
  readonly action: Action;
  readonly attemptId: string;
  readonly expectedRedisIdentityHash: string;
  readonly expectedDatabaseIdentityHash: string;
  readonly expectedBackendCommit: string;
  readonly authoritySubscriptionId: string;
  readonly authorityStorageAccount: string;
  readonly authorityStorageContainer: string;
  readonly authorityStorageBlob: string;
  readonly generation: number;
  readonly nextGeneration?: number;
  readonly previousStateHash?: string;
  readonly stableZeroEvidenceHash?: string;
  readonly output: string;
  readonly assumeYes: boolean;
}

function usage(): never {
  throw new Error(
    "usage: production-bootstrap-runtime-control --action <pause-only|recover-orphans|arm|hold|resume|read|read-open|renew> " +
      "--attempt-id <32-lowercase-hex> --generation <positive-integer> " +
      "--expected-redis-identity-hash <sha256> " +
      "--expected-database-identity-hash <sha256> " +
      "--expected-backend-commit <40-hex> --authority-subscription-id <uuid> " +
      "--authority-storage-account <name> --authority-storage-container <name> " +
      "--authority-storage-blob <name> " +
      "[--next-generation <greater-positive-integer>] " +
      "[--previous-state-hash <sha256:lowercase-hex>] " +
      "[--stable-zero-evidence-hash <sha256:lowercase-hex>] " +
      "--output <absolute-outside-repository-path> --yes",
  );
}

function positiveInteger(value: string | undefined, label: string): number {
  if (!value || !/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`${label} must be a positive decimal integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${label} is outside the safe integer range`);
  }
  return parsed;
}

function parseOptions(argv: readonly string[]): Options {
  let action: Action | undefined;
  let attemptId: string | undefined;
  let generation: number | undefined;
  let expectedRedisIdentityHash: string | undefined;
  let expectedDatabaseIdentityHash: string | undefined;
  let expectedBackendCommit: string | undefined;
  let authoritySubscriptionId: string | undefined;
  let authorityStorageAccount: string | undefined;
  let authorityStorageContainer: string | undefined;
  let authorityStorageBlob: string | undefined;
  let nextGeneration: number | undefined;
  let previousStateHash: string | undefined;
  let stableZeroEvidenceHash: string | undefined;
  let output: string | undefined;
  let assumeYes = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--action": {
        const value = argv[++index];
        if (
          value !== "pause-only" &&
          value !== "recover-orphans" &&
          value !== "arm" &&
          value !== "hold" &&
            value !== "resume" &&
            value !== "read" &&
            value !== "read-open" &&
            value !== "renew"
        ) {
          usage();
        }
        action = value;
        break;
      }
      case "--attempt-id":
        attemptId = argv[++index];
        if (!attemptId) usage();
        break;
      case "--generation":
        generation = positiveInteger(argv[++index], "generation");
        break;
      case "--expected-redis-identity-hash":
        expectedRedisIdentityHash = argv[++index];
        if (!expectedRedisIdentityHash ||
          !/^sha256:[0-9a-f]{64}$/.test(expectedRedisIdentityHash)) {
          throw new Error("expected Redis identity hash must be a SHA-256 hash");
        }
        break;
      case "--expected-database-identity-hash":
        expectedDatabaseIdentityHash = argv[++index];
        if (!expectedDatabaseIdentityHash ||
          !/^sha256:[0-9a-f]{64}$/.test(expectedDatabaseIdentityHash)) {
          throw new Error("expected database identity hash must be a SHA-256 hash");
        }
        break;
      case "--expected-backend-commit":
        expectedBackendCommit = argv[++index];
        if (!expectedBackendCommit || !/^[0-9a-f]{40}$/.test(expectedBackendCommit)) usage();
        break;
      case "--authority-subscription-id":
        authoritySubscriptionId = argv[++index];
        if (!authoritySubscriptionId) usage();
        break;
      case "--authority-storage-account":
        authorityStorageAccount = argv[++index];
        if (!authorityStorageAccount) usage();
        break;
      case "--authority-storage-container":
        authorityStorageContainer = argv[++index];
        if (!authorityStorageContainer) usage();
        break;
      case "--authority-storage-blob":
        authorityStorageBlob = argv[++index];
        if (!authorityStorageBlob) usage();
        break;
      case "--next-generation":
        nextGeneration = positiveInteger(argv[++index], "next generation");
        break;
      case "--previous-state-hash":
        previousStateHash = argv[++index];
        if (!previousStateHash || !/^sha256:[0-9a-f]{64}$/.test(previousStateHash)) {
          throw new Error("previous state hash must be a SHA-256 hash");
        }
        break;
      case "--stable-zero-evidence-hash":
        stableZeroEvidenceHash = argv[++index];
        if (!stableZeroEvidenceHash || !/^sha256:[0-9a-f]{64}$/.test(stableZeroEvidenceHash)) {
          throw new Error("stable-zero evidence hash must be a SHA-256 hash");
        }
        break;
      case "--output":
        output = argv[++index];
        if (!output) usage();
        break;
      case "--yes":
        assumeYes = true;
        break;
      default:
        usage();
    }
  }

  if (!action || !attemptId || !expectedRedisIdentityHash || !expectedDatabaseIdentityHash ||
    !expectedBackendCommit ||
    !authoritySubscriptionId || !authorityStorageAccount || !authorityStorageContainer ||
    !authorityStorageBlob ||
    generation === undefined || !output) usage();
  assertProductionBootstrapAttemptId(attemptId);
  if (!isAbsolute(output)) {
    throw new Error("runtime-control evidence output must be an absolute path");
  }
  if (action === "resume") {
    if (!previousStateHash) {
      throw new Error("resume requires the exact previous closed-state hash");
    }
  } else if (previousStateHash !== undefined) {
    throw new Error("previous state hash is valid only for resume");
  }
  if (action === "recover-orphans") {
    if (!stableZeroEvidenceHash) {
      throw new Error("recover-orphans requires the exact stable-zero evidence hash");
    }
  } else if (stableZeroEvidenceHash !== undefined) {
    throw new Error("stable-zero evidence hash is valid only for recover-orphans");
  }
  if (action === "renew") {
    if (nextGeneration === undefined || nextGeneration <= generation) {
      throw new Error("renew requires a next generation greater than the current generation");
    }
  } else if (nextGeneration !== undefined) {
    throw new Error("next generation is valid only for renew");
  }
  return {
    action,
    attemptId,
    expectedRedisIdentityHash,
    expectedDatabaseIdentityHash,
    expectedBackendCommit,
    authoritySubscriptionId,
    authorityStorageAccount,
    authorityStorageContainer,
    authorityStorageBlob,
    generation,
    nextGeneration,
    previousStateHash,
    stableZeroEvidenceHash,
    output,
    assumeYes,
  };
}

function verifyMutationAuthority(options: Options): void {
  verifyProductionBootstrapMutationAuthority({
    attemptId: options.attemptId,
    expectedBackendCommit: options.expectedBackendCommit,
    subscriptionId: options.authoritySubscriptionId,
    storageAccount: options.authorityStorageAccount,
    storageContainer: options.authorityStorageContainer,
    storageBlob: options.authorityStorageBlob,
  });
}

function inside(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

async function assertSafeOutputPath(output: string): Promise<void> {
  const repositoryRoot = await realpath(resolve(__dirname, ".."));
  const requestedParent = dirname(output);
  const requestedParentStat = await lstat(requestedParent);
  if (!requestedParentStat.isDirectory() || requestedParentStat.isSymbolicLink()) {
    throw new Error("runtime-control evidence parent must be a real directory");
  }
  const outputParent = await realpath(requestedParent);
  if (inside(repositoryRoot, outputParent)) {
    throw new Error("runtime-control evidence must be written outside the repository");
  }
  try {
    await lstat(output);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error("runtime-control evidence output already exists");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error("runtime-control evidence contains a non-safe integer");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  throw new Error("runtime-control evidence contains an unsupported value");
}

function evidenceHash(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function utcSecond(): string {
  return new Date(Math.floor(Date.now() / 1_000) * 1_000)
    .toISOString()
    .replace(".000Z", "Z");
}

function step(sequence: number, action: string, startedAt: string, completedAt: string) {
  const value = { sequence, action, startedAt, completedAt };
  return { ...value, evidenceHash: evidenceHash(value) };
}

async function openQueueSnapshot(
  runtime: ReturnType<typeof createProductionBootstrapRuntime>,
  requireWorkers: boolean,
) {
  const result: Record<string, unknown> = {};
  for (const key of ["agentRuns", "graphRuns", "outreachSend"] as const) {
    const queue = runtime.queues[key];
    const counts = await queue.getJobCounts(
      "waiting", "active", "delayed", "prioritized", "completed", "failed",
      "waiting-children", "paused",
    );
    const workers = await queue.getWorkers();
    const paused = await queue.isPaused();
    if (paused || (requireWorkers && workers.length < 1)) {
      throw new Error(
        requireWorkers
          ? `${queue.name} is not resumed with a connected worker`
          : `${queue.name} is not globally resumed`,
      );
    }
    result[key] = {
      paused,
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      delayed: counts.delayed ?? 0,
      prioritized: counts.prioritized ?? 0,
      completed: counts.completed ?? 0,
      failed: counts.failed ?? 0,
      waitingChildren: counts["waiting-children"] ?? 0,
      pausedJobs: counts.paused ?? 0,
      workerCount: workers.length,
    };
  }
  return result;
}

async function waitForPausedConnectedWorkers(
  runtime: ReturnType<typeof createProductionBootstrapRuntime>,
) {
  for (let poll = 0; poll < 180; poll += 1) {
    const result: Record<string, unknown> = {};
    let ready = true;
    for (const key of ["agentRuns", "graphRuns", "outreachSend"] as const) {
      const queue = runtime.queues[key];
      const counts = await queue.getJobCounts(
        "waiting", "active", "delayed", "prioritized", "completed", "failed",
        "waiting-children", "paused",
      );
      const workers = await queue.getWorkers();
      const paused = await queue.isPaused();
      if (!paused || (counts.active ?? 0) !== 0 || workers.length < 1) ready = false;
      result[key] = {
        paused,
        waiting: counts.waiting ?? 0,
        active: counts.active ?? 0,
        delayed: counts.delayed ?? 0,
        prioritized: counts.prioritized ?? 0,
        completed: counts.completed ?? 0,
        failed: counts.failed ?? 0,
        waitingChildren: counts["waiting-children"] ?? 0,
        pausedJobs: counts.paused ?? 0,
        workerCount: workers.length,
      };
    }
    if (ready) return result;
    if (poll + 1 < 180) await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  throw new Error("first-class consumers did not attach while all queues remained paused");
}

function sanitizedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
    .replace(/(password=)[^\s&]+/gi, "$1[redacted]")
    .replace(/(token=)[^\s&]+/gi, "$1[redacted]");
}

async function writeEvidence(path: string, evidence: unknown): Promise<void> {
  const envelope = {
    ...(evidence as Record<string, unknown>),
    evidenceHash: evidenceHash(evidence),
  };
  await writeFile(path, `${JSON.stringify(envelope, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

async function ensureClosedFence(
  runtime: ReturnType<typeof createProductionBootstrapRuntime>,
  options: Options,
  allowInitialArm: boolean,
): Promise<Awaited<ReturnType<typeof readProductionBootstrapWriterFence>>> {
  const readback = await readProductionBootstrapWriterFence(
    runtime.fence,
    () => verifyMutationAuthority(options),
  );
  if (readback.state === null) {
    if (!allowInitialArm || readback.generation > 0) {
      throw new Error("terminal OPEN writer-fence state cannot transition back to CLOSED");
    }
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + 24 * 60 * 60 * 1_000);
    verifyMutationAuthority(options);
    await armProductionBootstrapWriterFence(runtime.fence, {
      bootstrapAttemptId: options.attemptId,
      generation: options.generation,
      issuedAt,
      expiresAt,
    });
  } else if (
    readback.state.bootstrapAttemptId !== options.attemptId ||
    readback.generation !== readback.state.generation
  ) {
    throw new Error("writer-fence readback does not match the bootstrap attempt");
  } else if (readback.state.generation < options.generation) {
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + 24 * 60 * 60 * 1_000);
    verifyMutationAuthority(options);
    await rotateProductionBootstrapWriterFence(runtime.fence, {
      bootstrapAttemptId: options.attemptId,
      currentGeneration: readback.state.generation,
      nextGeneration: options.generation,
      issuedAt,
      expiresAt,
    });
  } else if (readback.state.generation > options.generation) {
    throw new Error("writer-fence generation is newer than the requested generation");
  }
  const verified = await readProductionBootstrapWriterFence(
    runtime.fence,
    () => verifyMutationAuthority(options),
  );
  assertClosedWriterFenceReadback(verified, {
    bootstrapAttemptId: options.attemptId,
    generation: options.generation,
  });
  return verified;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (!options.assumeYes) {
    throw new Error("production bootstrap runtime control requires --yes");
  }
  if (process.env.WORKFORCE_PRODUCTION_BOOTSTRAP_AUTHORITY_CONFIRMED !== "true") {
    throw new Error(
      "production bootstrap runtime control requires protected authority confirmation",
    );
  }
  await assertSafeOutputPath(options.output);
  const runtime = createProductionBootstrapRuntime(options.expectedRedisIdentityHash);
  try {
    if (runtime.redisIdentityHash !== options.expectedRedisIdentityHash) {
      throw new Error("Redis identity does not match the protected target");
    }
    if (await runtime.fence.ping() !== "PONG") {
      throw new Error("protected Redis target did not answer the live identity probe");
    }
    await assertProductionBootstrapDatabaseIdentity(
      runtime.database,
      options.expectedDatabaseIdentityHash,
    );
    if (options.action === "pause-only") {
      const before = await snapshotProductionBootstrapQueues(runtime.queues);
      verifyMutationAuthority(options);
      const queues = await pauseProductionBootstrapQueues(runtime, options.attemptId, {
        beforeMutation: () => verifyMutationAuthority(options),
      });
      for (const key of ["agentRuns", "graphRuns", "outreachSend"] as const) {
        if (queues[key].failed !== before[key].failed) {
          throw new Error(
            `${queues[key].name} failed-job count changed while queues were paused and drained`,
          );
        }
      }
      await writeEvidence(options.output, {
        schemaVersion: 1,
        kind: "production-bootstrap-queues-paused-before-writer-fence",
        bootstrapAttemptId: options.attemptId,
        capturedAt: new Date().toISOString(),
        before,
        queues,
        failedJobCountsStable: true,
      });
      return;
    }

    if (options.action === "recover-orphans") {
      const queues = await verifyProductionBootstrapQueues(runtime, options.attemptId, {
        requireWorkersStopped: true,
      });
      const before = await readProductionBootstrapWriterFence(
        runtime.fence,
        () => verifyMutationAuthority(options),
      );
      const absent = before.epoch === null && before.generation === 0;
      const exactClosed = before.epoch?.mode === "closed" &&
        before.epoch.bootstrapAttemptId === options.attemptId &&
        before.epoch.generation === options.generation &&
        before.generation === options.generation;
      if (!absent && !exactClosed) {
        throw new Error("orphan recovery requires an absent or exact CLOSED bootstrap epoch");
      }
      verifyMutationAuthority(options);
      const recovery = await recoverProductionBootstrapOrphanedWriterTokens(runtime.fence, {
        bootstrapAttemptId: options.attemptId,
        expectedGeneration: before.generation,
        stableZeroEvidenceHash: options.stableZeroEvidenceHash!,
        ingressDisabled: true,
        queuesPausedAndDrained: true,
        apiReplicaCount: 0,
        workerReplicaCount: 0,
      });
      const after = await readProductionBootstrapWriterFence(
        runtime.fence,
        () => verifyMutationAuthority(options),
      );
      if (after.activeWriters !== 0 || after.activeComplianceWriters !== 0 ||
        after.generation !== before.generation) {
        throw new Error("orphan recovery zero-writer readback is ambiguous");
      }
      await writeEvidence(options.output, {
        schemaVersion: 1,
        kind: "production-bootstrap-orphan-writer-recovery",
        bootstrapAttemptId: options.attemptId,
        capturedAt: utcSecond(),
        queues,
        before,
        recovery,
        after,
      });
      return;
    }

    if (options.action === "arm") {
      const writerFence = await ensureClosedFence(runtime, options, true);
      await writeEvidence(options.output, {
        schemaVersion: 1,
        kind: "production-bootstrap-runtime-armed",
        bootstrapAttemptId: options.attemptId,
        capturedAt: new Date().toISOString(),
        writerFence,
      });
      return;
    }

    if (options.action === "renew") {
      await acquireProductionBootstrapFence(
        runtime.fence,
        options.attemptId,
        () => verifyMutationAuthority(options),
      );
      verifyMutationAuthority(options);
      const queues = await pauseProductionBootstrapQueues(runtime, options.attemptId, {
        beforeMutation: () => verifyMutationAuthority(options),
      });
      const writerFence = await ensureClosedFence(
        runtime,
        { ...options, generation: options.nextGeneration! },
        false,
      );
      await writeEvidence(options.output, {
        schemaVersion: 1,
        kind: "production-bootstrap-runtime-renewed",
        bootstrapAttemptId: options.attemptId,
        capturedAt: new Date().toISOString(),
        previousGeneration: options.generation,
        writerFence,
        queues,
      });
      return;
    }

    if (options.action === "read-open") {
      const writerFence = await readProductionBootstrapWriterFence(
        runtime.fence,
        () => verifyMutationAuthority(options),
      );
      if (writerFence.state !== null || writerFence.generation !== options.generation ||
        writerFence.epoch?.mode !== "open" ||
        writerFence.epoch.bootstrapAttemptId !== options.attemptId ||
        writerFence.epoch.generation !== options.generation ||
        !writerFence.stateHash) {
        throw new Error("writer-fence open readback is ambiguous");
      }
      const queues = await openQueueSnapshot(runtime, true);
      const database = await readProductionBootstrapDatabaseInventory(
        runtime.database,
        "post-migration",
        options.expectedDatabaseIdentityHash,
      );
      assertProductionBootstrapInventoryReady(database, "post-migration");
      await writeEvidence(options.output, {
        schemaVersion: 1,
        kind: "production-bootstrap-runtime-open-readback",
        bootstrapAttemptId: options.attemptId,
        capturedAt: new Date().toISOString(),
        writerFence,
        queues,
        database,
      });
      return;
    }

    if (options.action === "resume") {
      try {
        const releaseStartedAt = utcSecond();
        let currentFence = await readProductionBootstrapWriterFence(
          runtime.fence,
          () => verifyMutationAuthority(options),
        );
        if (currentFence.epoch?.mode === "closed") {
          assertClosedWriterFenceReadback(currentFence, {
            bootstrapAttemptId: options.attemptId,
            generation: options.generation,
          });
          if (currentFence.stateHash !== options.previousStateHash) {
            throw new Error("writer-fence CLOSED state differs from the durable terminal-OPEN intent");
          }
          verifyMutationAuthority(options);
          await disarmProductionBootstrapWriterFence(runtime.fence, {
            bootstrapAttemptId: options.attemptId,
            generation: options.generation,
            observedAt: new Date(),
          });
          currentFence = await readProductionBootstrapWriterFence(
            runtime.fence,
            () => verifyMutationAuthority(options),
          );
        }
        if (currentFence.state !== null || currentFence.epoch?.mode !== "open" ||
          currentFence.epoch.bootstrapAttemptId !== options.attemptId ||
          currentFence.epoch.generation !== options.generation ||
          currentFence.generation !== options.generation || !currentFence.stateHash ||
          currentFence.activeWriters !== 0 || currentFence.activeComplianceWriters !== 0) {
          throw new Error("terminal OPEN writer-fence readback is ambiguous");
        }
        const releaseCompletedAt = utcSecond();
        const consumersStartedAt = utcSecond();
        const pausedConnectedQueues = await waitForPausedConnectedWorkers(runtime);
        const consumersCompletedAt = utcSecond();
        const queuesStartedAt = utcSecond();
        verifyMutationAuthority(options);
        await resumeProductionBootstrapQueues(
          runtime,
          options.attemptId,
          () => verifyMutationAuthority(options),
        );
        const queuesCompletedAt = utcSecond();
        const finalFence = await readProductionBootstrapWriterFence(
          runtime.fence,
          () => verifyMutationAuthority(options),
        );
        if (finalFence.state !== null || finalFence.epoch?.mode !== "open" ||
          finalFence.epoch.bootstrapAttemptId !== options.attemptId ||
          finalFence.epoch.generation !== options.generation ||
          finalFence.generation !== options.generation ||
          finalFence.stateHash !== currentFence.stateHash) {
          throw new Error("terminal OPEN writer fence changed during consumer resume");
        }
        const queues = await openQueueSnapshot(runtime, true);
        const database = await readProductionBootstrapDatabaseInventory(
          runtime.database,
          "post-migration",
          options.expectedDatabaseIdentityHash,
        );
        const steps = [
          step(1, "release-writer-fence", releaseStartedAt, releaseCompletedAt),
          step(2, "start-first-class-consumers", consumersStartedAt, consumersCompletedAt),
          step(3, "resume-agent-runs", queuesStartedAt, queuesCompletedAt),
          step(4, "resume-graph-runs", queuesCompletedAt, queuesCompletedAt),
          step(5, "resume-outreach-send", queuesCompletedAt, queuesCompletedAt),
        ];
        const releaseWithoutHash = {
          bootstrapAttemptId: options.attemptId,
          generation: options.generation,
          previousStateHash: options.previousStateHash!,
          openEpoch: currentFence.epoch,
          openStateHash: currentFence.stateHash,
          releasedAt: releaseCompletedAt,
          terminalOpen: true,
        };
        await writeEvidence(options.output, {
          schemaVersion: 1,
          kind: "production-bootstrap-runtime-resumed",
          bootstrapAttemptId: options.attemptId,
          capturedAt: new Date().toISOString(),
          writerFence: finalFence,
          queuesResumed: true,
          steps,
          pausedConnectedQueues,
          queues,
          writerFenceRelease: {
            ...releaseWithoutHash,
            evidenceHash: evidenceHash(releaseWithoutHash),
          },
          database,
        });
        return;
      } catch (error) {
        let containment: unknown;
        try {
          verifyMutationAuthority(options);
          containment = await pauseProductionBootstrapQueues(runtime, options.attemptId, {
            beforeMutation: () => verifyMutationAuthority(options),
          });
        } catch (containmentError) {
          containment = { failed: true, error: sanitizedError(containmentError) };
        }
        await writeEvidence(options.output, {
          schemaVersion: 1,
          kind: "production-bootstrap-runtime-resume-held-forward-only",
          bootstrapAttemptId: options.attemptId,
          capturedAt: new Date().toISOString(),
          resumeError: sanitizedError(error),
          containment,
          writerFenceReclosed: false,
        });
        throw new Error(
          "runtime resume was not proven; queues were paused where possible and terminal OPEN remains forward-only",
          { cause: error },
        );
      }
    }

    const currentFence = await readProductionBootstrapWriterFence(
      runtime.fence,
      () => verifyMutationAuthority(options),
    );
    assertClosedWriterFenceReadback(currentFence, {
      bootstrapAttemptId: options.attemptId,
      generation: options.generation,
    });

    if (options.action === "read") {
      const queues = await verifyProductionBootstrapQueues(runtime, options.attemptId, {
        requireWorkersStopped: false,
      });
      await writeEvidence(options.output, {
        schemaVersion: 1,
        kind: "production-bootstrap-runtime-readback",
        bootstrapAttemptId: options.attemptId,
        capturedAt: new Date().toISOString(),
        writerFence: currentFence,
        queues,
      });
      return;
    }

    if (options.action === "hold") {
      await acquireProductionBootstrapFence(
        runtime.fence,
        options.attemptId,
        () => verifyMutationAuthority(options),
      );
      verifyMutationAuthority(options);
      const queues = await pauseProductionBootstrapQueues(runtime, options.attemptId, {
        beforeMutation: () => verifyMutationAuthority(options),
      });
      const writerFence = await readProductionBootstrapWriterFence(
        runtime.fence,
        () => verifyMutationAuthority(options),
      );
      assertClosedWriterFenceReadback(writerFence, {
        bootstrapAttemptId: options.attemptId,
        generation: options.generation,
      });
      await writeEvidence(options.output, {
        schemaVersion: 1,
        kind: "production-bootstrap-runtime-held",
        bootstrapAttemptId: options.attemptId,
        capturedAt: new Date().toISOString(),
        writerFence,
        queues,
      });
      return;
    }

    throw new Error(`unsupported runtime-control action ${options.action}`);
  } finally {
    await runtime.close();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`ERROR: ${sanitizedError(error)}\n`);
  process.exitCode = 1;
});
