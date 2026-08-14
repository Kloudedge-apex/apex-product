#!/usr/bin/env node

import { lstat, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import {
  assertProductionBootstrapAttemptId,
  assertProductionBootstrapInventoryReady,
  createProductionBootstrapRuntime,
  createProductionBootstrapSnapshot,
  pauseProductionBootstrapQueues,
  readProductionBootstrapDatabaseInventory,
  type ProductionBootstrapSchemaPhase,
  type ProductionBootstrapWorkerPosture,
} from "./production-bootstrap-quiescence";
import {
  assertClosedWriterFenceReadback,
  readProductionBootstrapWriterFence,
} from "./production-bootstrap-writer-fence";
import { verifyProductionBootstrapMutationAuthority } from "../../../../scripts/production-bootstrap-mutation-authority.mjs";

type Action = "pause" | "verify";

interface CliOptions {
  readonly action: Action;
  readonly attemptId: string;
  readonly schemaPhase: ProductionBootstrapSchemaPhase;
  readonly output: string;
  readonly expectedRedisIdentityHash: string;
  readonly expectedDatabaseIdentityHash: string;
  readonly expectedBackendCommit: string;
  readonly authoritySubscriptionId: string;
  readonly authorityStorageAccount: string;
  readonly authorityStorageContainer: string;
  readonly authorityStorageBlob: string;
  readonly writerFenceGeneration: number;
  readonly workerPosture: Exclude<ProductionBootstrapWorkerPosture, "any">;
  readonly assumeYes: boolean;
}

function usage(): never {
  throw new Error(
    "usage: production-bootstrap-quiescence --action <pause|verify> " +
      "--attempt-id <32-lowercase-hex> --schema-phase <pre-migration|post-migration> " +
      "--expected-redis-identity-hash <sha256> --expected-database-identity-hash <sha256> " +
      "--expected-backend-commit <40-hex> --authority-subscription-id <uuid> " +
      "--authority-storage-account <name> --authority-storage-container <name> " +
      "--authority-storage-blob <name> " +
      "--writer-fence-generation <positive-integer> " +
      "--worker-posture <stopped|connected> " +
      "--output <absolute-outside-repository-path> --yes",
  );
}

function parseOptions(argv: readonly string[]): CliOptions {
  let action: Action | undefined;
  let attemptId: string | undefined;
  let schemaPhase: ProductionBootstrapSchemaPhase | undefined;
  let output: string | undefined;
  let expectedRedisIdentityHash: string | undefined;
  let expectedDatabaseIdentityHash: string | undefined;
  let expectedBackendCommit: string | undefined;
  let authoritySubscriptionId: string | undefined;
  let authorityStorageAccount: string | undefined;
  let authorityStorageContainer: string | undefined;
  let authorityStorageBlob: string | undefined;
  let writerFenceGeneration: number | undefined;
  let workerPosture: Exclude<ProductionBootstrapWorkerPosture, "any"> | undefined;
  let assumeYes = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--action": {
        const value = argv[++index];
        if (value !== "pause" && value !== "verify") usage();
        action = value;
        break;
      }
      case "--attempt-id":
        attemptId = argv[++index];
        if (!attemptId) usage();
        break;
      case "--schema-phase": {
        const value = argv[++index];
        if (value !== "pre-migration" && value !== "post-migration") usage();
        schemaPhase = value;
        break;
      }
      case "--output":
        output = argv[++index];
        if (!output) usage();
        break;
      case "--expected-redis-identity-hash":
        expectedRedisIdentityHash = argv[++index];
        if (!expectedRedisIdentityHash) usage();
        break;
      case "--expected-database-identity-hash":
        expectedDatabaseIdentityHash = argv[++index];
        if (!expectedDatabaseIdentityHash) usage();
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
      case "--writer-fence-generation": {
        const value = argv[++index];
        if (!value || !/^[1-9][0-9]*$/.test(value)) usage();
        writerFenceGeneration = Number(value);
        if (!Number.isSafeInteger(writerFenceGeneration)) usage();
        break;
      }
      case "--worker-posture": {
        const value = argv[++index];
        if (value !== "stopped" && value !== "connected") usage();
        workerPosture = value;
        break;
      }
      case "--yes":
        assumeYes = true;
        break;
      default:
        usage();
    }
  }

  if (
    !action ||
    !attemptId ||
    !schemaPhase ||
    !output ||
    !expectedRedisIdentityHash ||
    !expectedDatabaseIdentityHash ||
    !expectedBackendCommit ||
    !authoritySubscriptionId ||
    !authorityStorageAccount ||
    !authorityStorageContainer ||
    !authorityStorageBlob ||
    writerFenceGeneration === undefined ||
    !workerPosture
  ) {
    usage();
  }
  assertProductionBootstrapAttemptId(attemptId);
  if (!/^sha256:[0-9a-f]{64}$/.test(expectedRedisIdentityHash)) {
    throw new Error("expected Redis identity hash is invalid");
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(expectedDatabaseIdentityHash)) {
    throw new Error("expected database identity hash is invalid");
  }
  if (!isAbsolute(output)) {
    throw new Error("quiescence evidence output must be an absolute path");
  }
  return {
    action,
    attemptId,
    schemaPhase,
    output,
    expectedRedisIdentityHash,
    expectedDatabaseIdentityHash,
    expectedBackendCommit,
    authoritySubscriptionId,
    authorityStorageAccount,
    authorityStorageContainer,
    authorityStorageBlob,
    writerFenceGeneration,
    workerPosture,
    assumeYes,
  };
}

function isInside(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

async function assertSafeOutputPath(output: string): Promise<void> {
  const repositoryRoot = await realpath(resolve(__dirname, "../../../.."));
  const requestedParent = dirname(output);
  const requestedParentStat = await lstat(requestedParent);
  if (!requestedParentStat.isDirectory() || requestedParentStat.isSymbolicLink()) {
    throw new Error("quiescence evidence parent must be a real directory");
  }
  const outputParent = await realpath(requestedParent);
  if (isInside(repositoryRoot, outputParent)) {
    throw new Error("quiescence evidence must be written outside the repository");
  }
  try {
    await lstat(output);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error("quiescence evidence output already exists");
}

function sanitizedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
    .replace(/(password=)[^\s&]+/gi, "$1[redacted]");
}

function currentUtcSecond(): string {
  return new Date(Math.floor(Date.now() / 1_000) * 1_000)
    .toISOString()
    .replace(".000Z", "Z");
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (!options.assumeYes) {
    throw new Error("production bootstrap queue control requires --yes");
  }
  if (process.env.WORKFORCE_PRODUCTION_BOOTSTRAP_AUTHORITY_CONFIRMED !== "true") {
    throw new Error(
      "production bootstrap queue control requires protected authority confirmation",
    );
  }
  await assertSafeOutputPath(options.output);

  const runtime = createProductionBootstrapRuntime(options.expectedRedisIdentityHash);
  const beforeMutation = (): void => {
    verifyProductionBootstrapMutationAuthority({
      attemptId: options.attemptId,
      expectedBackendCommit: options.expectedBackendCommit,
      subscriptionId: options.authoritySubscriptionId,
      storageAccount: options.authorityStorageAccount,
      storageContainer: options.authorityStorageContainer,
      storageBlob: options.authorityStorageBlob,
    });
  };

  try {
    if (runtime.redisIdentityHash !== options.expectedRedisIdentityHash) {
      throw new Error("Redis identity does not match the protected target");
    }
    if (await runtime.fence.ping() !== "PONG") {
      throw new Error("protected Redis target did not answer the live identity probe");
    }
    const targetInventory = await readProductionBootstrapDatabaseInventory(
      runtime.database,
      options.schemaPhase,
      options.expectedDatabaseIdentityHash,
    );
    if (
      targetInventory.databaseIdentityHash !==
      options.expectedDatabaseIdentityHash
    ) {
      throw new Error("database identity does not match the protected target");
    }
    const writerFence = await readProductionBootstrapWriterFence(
      runtime.fence,
      beforeMutation,
    );
    assertClosedWriterFenceReadback(writerFence, {
      bootstrapAttemptId: options.attemptId,
      generation: options.writerFenceGeneration,
    });

    let evidence: unknown;
    if (options.action === "pause") {
      const queues = await pauseProductionBootstrapQueues(
        runtime,
        options.attemptId,
        { beforeMutation },
      );
      evidence = {
        schemaVersion: 2,
        kind: "production-bootstrap-queues-paused-and-drained",
        bootstrapAttemptId: options.attemptId,
        capturedAt: currentUtcSecond(),
        fenceHeld: true,
        redisIdentityHash: runtime.redisIdentityHash,
        databaseIdentityHash: targetInventory.databaseIdentityHash,
        writerFence,
        queues,
      };
    } else {
      const snapshot = await createProductionBootstrapSnapshot(
        runtime,
        options.attemptId,
        options.schemaPhase,
        options.writerFenceGeneration,
        {
          beforeWriterFenceRead: beforeMutation,
          expectedDatabaseIdentityHash: options.expectedDatabaseIdentityHash,
          workerPosture: options.workerPosture,
        },
      );
      assertProductionBootstrapInventoryReady(snapshot.database, options.schemaPhase);
      evidence = snapshot;
    }
    await writeFile(options.output, `${JSON.stringify(evidence, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } finally {
    await runtime.close();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`ERROR: ${sanitizedError(error)}\n`);
  process.exitCode = 1;
});
