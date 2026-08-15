import { createHash } from "node:crypto";
import { Queue } from "bullmq";
import Redis from "ioredis";
import { PrismaClient } from "@prisma/client";
import { buildRedisConnectionOptions } from "../runtime/queue.service";
import {
  assertClosedWriterFenceReadback,
  readProductionBootstrapWriterFence,
  type ProductionBootstrapWriterFenceReadback,
} from "./production-bootstrap-writer-fence";

export const PRODUCTION_BOOTSTRAP_FENCE_KEY =
  "workforce-os:production-bootstrap:fence:v1";

export const PRODUCTION_BOOTSTRAP_QUEUE_NAMES = {
  agentRuns: "agent-runs",
  graphRuns: "graph-runs",
  outreachSend: "outreach-send",
} as const;

export type ProductionBootstrapQueueKey =
  keyof typeof PRODUCTION_BOOTSTRAP_QUEUE_NAMES;

export type ProductionBootstrapSchemaPhase = "pre-migration" | "post-migration";
export type ProductionBootstrapWorkerPosture = "stopped" | "connected" | "any";

export interface ProductionBootstrapQueueCounts {
  readonly waiting: number;
  readonly active: number;
  readonly delayed: number;
  readonly prioritized: number;
  readonly completed: number;
  readonly failed: number;
  readonly waitingChildren: number;
  readonly pausedJobs: number;
}

export interface ProductionBootstrapQueueSnapshot
  extends ProductionBootstrapQueueCounts {
  readonly name: string;
  readonly isPaused: boolean;
  readonly workerCount: number;
}

export interface ProductionBootstrapDatabaseInventory {
  readonly databaseIdentityHash: string;
  readonly sendingRows: number;
  readonly firstClassDeliveryUnknownRows: number;
  readonly legacyDeliveryUnknownMarkerRows: number;
  readonly firstClassFailedRows: number;
  readonly legacyAutoFailedMarkerRows: number;
  readonly outreachIdempotencyDuplicateGroups: number;
  readonly legacyGmailReplySequenceStopRows: number;
  readonly managerRoleRows: number;
  readonly graphRunRunningRows: number;
  readonly graphRunAwaitingApprovalRows: number;
  readonly graphActiveOrgDuplicateGroups: number;
  readonly graphActiveWithoutRecoveryStateRows: number;
  readonly graphLifecycleSchemaReady: boolean;
  readonly replySourceDuplicateGroups: number | null;
  readonly replyConversationDuplicateGroups: number | null;
  readonly nullSourceReplyRows: number | null;
  readonly replySlotDuplicateRows: number | null;
  readonly duplicateInventoryEvidenceHash: string;
  readonly replySchemaReady: boolean;
  readonly clerkIdentitySchemaReady: boolean;
  readonly clerkCutoverRowCount: number | null;
  readonly clerkCutoverReady: boolean | null;
  readonly clerkMinimumEventVersion: number | null;
  readonly clerkInventoryEvidenceHash: string | null;
  readonly clerkExpectedActiveOrganizationCount: number | null;
  readonly clerkExpectedActiveMembershipCount: number | null;
  readonly clerkExpectedActiveUserCount: number | null;
  readonly clerkActiveOrganizationCount: number | null;
  readonly clerkActiveMembershipCount: number | null;
  readonly clerkActiveUserCount: number | null;
  readonly clerkProjectionMismatchRows: number | null;
  readonly clerkOrphanActiveAuthorityRows: number | null;
  readonly clerkReadinessViolationCount: number | null;
}

export interface ProductionBootstrapQuiescenceSnapshot {
  readonly schemaVersion: 2;
  readonly bootstrapAttemptId: string;
  readonly capturedAt: string;
  readonly fenceHeld: true;
  readonly redisIdentityHash: string;
  readonly writerFence: ProductionBootstrapWriterFenceReadback;
  readonly schemaPhase: ProductionBootstrapSchemaPhase;
  readonly queues: Record<
    ProductionBootstrapQueueKey,
    ProductionBootstrapQueueSnapshot
  >;
  readonly database: ProductionBootstrapDatabaseInventory;
  readonly evidenceHash: string;
}

export interface ProductionBootstrapQueueHandle {
  readonly name: string;
  pause(): Promise<void>;
  resume(): Promise<void>;
  isPaused(): Promise<boolean>;
  getJobCounts(
    ...types: Array<
      | "waiting"
      | "active"
      | "delayed"
      | "prioritized"
      | "completed"
      | "failed"
      | "waiting-children"
      | "paused"
    >
  ): Promise<Record<string, number>>;
  getWorkers(): Promise<unknown[]>;
  close(): Promise<void>;
}

export interface ProductionBootstrapFenceClient {
  ping(): Promise<"PONG">;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "NX"): Promise<"OK" | null>;
  eval(
    script: string,
    numberOfKeys: number,
    ...args: Array<string | number>
  ): Promise<unknown>;
  quit(): Promise<unknown>;
}

export interface ProductionBootstrapDatabaseQueryClient {
  $queryRawUnsafe<T = unknown>(query: string): Promise<T>;
  $executeRawUnsafe(query: string): Promise<number>;
}

export interface ProductionBootstrapDatabaseClient
  extends ProductionBootstrapDatabaseQueryClient {
  $transaction<T>(
    operation: (
      transaction: ProductionBootstrapDatabaseQueryClient,
    ) => Promise<T>,
    options: {
      readonly isolationLevel: "RepeatableRead";
      readonly maxWait: number;
      readonly timeout: number;
    },
  ): Promise<T>;
  $disconnect(): Promise<void>;
}

export interface ProductionBootstrapRuntime {
  readonly fence: ProductionBootstrapFenceClient;
  readonly queues: Record<
    ProductionBootstrapQueueKey,
    ProductionBootstrapQueueHandle
  >;
  readonly redisIdentityHash: string;
  readonly database: ProductionBootstrapDatabaseClient;
  close(): Promise<void>;
}

const PAUSE_ORDER: readonly ProductionBootstrapQueueKey[] = [
  "outreachSend",
  "graphRuns",
  "agentRuns",
];

const RESUME_ORDER: readonly ProductionBootstrapQueueKey[] = [
  "agentRuns",
  "graphRuns",
  "outreachSend",
];

const RELEASE_FENCE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error("production bootstrap evidence only permits safe integers");
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("production bootstrap evidence contains an unsupported value");
}

function sha256Json(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(canonicalJson(value), "utf8")
    .digest("hex")}`;
}

export interface ProductionBootstrapDatabaseIdentity {
  readonly database_name: string;
  readonly database_user: string;
  readonly database_schema: string | null;
  readonly server_address: string;
  readonly server_port: string | null;
  readonly server_version: string;
}

export function productionBootstrapDatabaseIdentityHash(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("production database identity must be one object");
  }
  const identity = value as Record<string, unknown>;
  const expectedKeys = [
    "database_name", "database_user", "database_schema", "server_address",
    "server_port", "server_version",
  ].sort();
  const actualKeys = Object.keys(identity).sort();
  if (actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error("production database identity has unexpected or missing fields");
  }
  for (const key of ["database_name", "database_user", "server_address"]) {
    if (typeof identity[key] !== "string" || identity[key].length < 1 ||
      identity[key].length > 1024 || /[\u0000-\u001f\u007f]/u.test(identity[key])) {
      throw new Error(`production database identity ${key} is invalid`);
    }
  }
  if (identity.database_schema !== null &&
    (typeof identity.database_schema !== "string" || identity.database_schema.length < 1 ||
      identity.database_schema.length > 1024 ||
      /[\u0000-\u001f\u007f]/u.test(identity.database_schema))) {
    throw new Error("production database identity database_schema is invalid");
  }
  if (identity.server_port !== null &&
    (typeof identity.server_port !== "string" ||
      !/^\d{1,5}$/u.test(identity.server_port) || Number(identity.server_port) > 65_535)) {
    throw new Error("production database identity server_port is invalid");
  }
  if (typeof identity.server_version !== "string" ||
    !/^\d{5,8}$/u.test(identity.server_version)) {
    throw new Error("production database identity server_version is invalid");
  }
  return sha256Json(identity);
}

function canonicalUtcSeconds(value: Date, label: string): string {
  if (!Number.isFinite(value.getTime())) {
    throw new Error(`${label} must be a valid date`);
  }
  return value.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function productionBootstrapRedisIdentityHash(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  if (environment.REDIS_URL) {
    let url: URL;
    try {
      url = new URL(environment.REDIS_URL);
    } catch {
      throw new Error("production bootstrap Redis URL is invalid");
    }
    if (url.protocol !== "redis:" && url.protocol !== "rediss:") {
      throw new Error("production bootstrap Redis URL protocol is unsupported");
    }
    const database = url.pathname === "" || url.pathname === "/" ? "0" : url.pathname.slice(1);
    if (!/^(0|[1-9][0-9]*)$/.test(database)) {
      throw new Error("production bootstrap Redis database is invalid");
    }
    return sha256Json({
      source: "url",
      protocol: url.protocol,
      hostname: url.hostname.toLowerCase(),
      port: url.port || "6379",
      database,
      usernameHash: url.username ? sha256Json(url.username) : null,
      passwordConfigured: url.password.length > 0,
      queryHash: url.search ? sha256Json(url.searchParams.toString()) : null,
    });
  }
  if (!environment.REDIS_HOST) {
    throw new Error("production bootstrap requires an explicit Redis connection");
  }
  const port = environment.REDIS_PORT ?? "6380";
  if (!/^[0-9]+$/.test(port) || Number(port) < 1 || Number(port) > 65_535) {
    throw new Error("production bootstrap Redis port is invalid");
  }
  return sha256Json({
    source: "host",
    protocol: environment.REDIS_TLS === "false" ? "redis:" : "rediss:",
    hostname: environment.REDIS_HOST.toLowerCase(),
    port: String(Number(port)),
    database: "0",
    usernameHash: environment.REDIS_USERNAME
      ? sha256Json(environment.REDIS_USERNAME)
      : null,
    passwordConfigured: Boolean(environment.REDIS_PASSWORD),
  });
}

function assertSafeInteger(value: unknown, label: string): number {
  const numeric =
    typeof value === "bigint"
      ? Number(value)
      : typeof value === "string"
        ? Number(value)
        : value;
  if (typeof numeric !== "number" || !Number.isSafeInteger(numeric)) {
    throw new Error(`${label} is not a safe integer`);
  }
  return numeric;
}

function assertNonNegativeSafeInteger(value: unknown, label: string): number {
  const numeric = assertSafeInteger(value, label);
  if (numeric < 0) {
    throw new Error(`${label} is not a non-negative safe integer`);
  }
  return numeric;
}

function firstCount(rows: unknown, label: string): number {
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new Error(`${label} did not return exactly one aggregate row`);
  }
  const row = rows[0];
  if (!row || typeof row !== "object" || !("count" in row)) {
    throw new Error(`${label} did not return a count`);
  }
  return assertNonNegativeSafeInteger(
    (row as { readonly count: unknown }).count,
    label,
  );
}

export function assertProductionBootstrapAttemptId(attemptId: string): void {
  if (!/^[0-9a-f]{32}$/.test(attemptId)) {
    throw new Error(
      "bootstrap attempt id must be exactly 32 lowercase hexadecimal characters",
    );
  }
}

export async function acquireProductionBootstrapFence(
  fence: ProductionBootstrapFenceClient,
  attemptId: string,
  beforeMutation: () => void | Promise<void>,
): Promise<"acquired" | "already-held"> {
  assertProductionBootstrapAttemptId(attemptId);
  const current = await fence.get(PRODUCTION_BOOTSTRAP_FENCE_KEY);
  if (current === attemptId) return "already-held";
  if (current !== null) {
    throw new Error("another production bootstrap attempt holds the Redis fence");
  }
  await beforeMutation();
  const result = await fence.set(
    PRODUCTION_BOOTSTRAP_FENCE_KEY,
    attemptId,
    "NX",
  );
  if (result !== "OK") {
    throw new Error("production bootstrap Redis fence acquisition raced");
  }
  return "acquired";
}

export async function verifyProductionBootstrapFence(
  fence: ProductionBootstrapFenceClient,
  attemptId: string,
): Promise<void> {
  assertProductionBootstrapAttemptId(attemptId);
  const current = await fence.get(PRODUCTION_BOOTSTRAP_FENCE_KEY);
  if (current !== attemptId) {
    throw new Error("production bootstrap Redis fence is absent or owned elsewhere");
  }
}

export async function releaseProductionBootstrapFence(
  fence: ProductionBootstrapFenceClient,
  attemptId: string,
  beforeMutation: () => void | Promise<void>,
): Promise<void> {
  await verifyProductionBootstrapFence(fence, attemptId);
  await beforeMutation();
  const deleted = await fence.eval(
    RELEASE_FENCE_SCRIPT,
    1,
    PRODUCTION_BOOTSTRAP_FENCE_KEY,
    attemptId,
  );
  if (deleted !== 1 && deleted !== "1") {
    throw new Error("production bootstrap Redis fence compare-and-delete failed");
  }
}

async function snapshotQueue(
  queue: ProductionBootstrapQueueHandle,
): Promise<ProductionBootstrapQueueSnapshot> {
  const [isPaused, rawCounts, workers] = await Promise.all([
    queue.isPaused(),
    queue.getJobCounts(
      "waiting",
      "active",
      "delayed",
      "prioritized",
      "completed",
      "failed",
      "waiting-children",
      "paused",
    ),
    queue.getWorkers(),
  ]);
  if (!Array.isArray(workers)) {
    throw new Error(`${queue.name}.workers did not return an array`);
  }
  return {
    name: queue.name,
    isPaused,
    workerCount: assertNonNegativeSafeInteger(
      workers.length,
      `${queue.name}.workerCount`,
    ),
    waiting: assertNonNegativeSafeInteger(rawCounts.waiting ?? 0, `${queue.name}.waiting`),
    active: assertNonNegativeSafeInteger(rawCounts.active ?? 0, `${queue.name}.active`),
    delayed: assertNonNegativeSafeInteger(rawCounts.delayed ?? 0, `${queue.name}.delayed`),
    prioritized: assertNonNegativeSafeInteger(
      rawCounts.prioritized ?? 0,
      `${queue.name}.prioritized`,
    ),
    completed: assertNonNegativeSafeInteger(
      rawCounts.completed ?? 0,
      `${queue.name}.completed`,
    ),
    failed: assertNonNegativeSafeInteger(
      rawCounts.failed ?? 0,
      `${queue.name}.failed`,
    ),
    waitingChildren: assertNonNegativeSafeInteger(
      rawCounts["waiting-children"] ?? 0,
      `${queue.name}.waitingChildren`,
    ),
    pausedJobs: assertNonNegativeSafeInteger(
      rawCounts.paused ?? 0,
      `${queue.name}.pausedJobs`,
    ),
  };
}

export async function snapshotProductionBootstrapQueues(
  queues: ProductionBootstrapRuntime["queues"],
): Promise<ProductionBootstrapQuiescenceSnapshot["queues"]> {
  const [agentRuns, graphRuns, outreachSend] = await Promise.all([
    snapshotQueue(queues.agentRuns),
    snapshotQueue(queues.graphRuns),
    snapshotQueue(queues.outreachSend),
  ]);
  return { agentRuns, graphRuns, outreachSend };
}

function assertQueuesPausedAndIdle(
  queues: ProductionBootstrapQuiescenceSnapshot["queues"],
  workerPosture: ProductionBootstrapWorkerPosture,
): void {
  for (const key of Object.keys(queues) as ProductionBootstrapQueueKey[]) {
    const queue = queues[key];
    if (!queue.isPaused) {
      throw new Error(`${queue.name} is not globally paused`);
    }
    if (queue.active !== 0) {
      throw new Error(`${queue.name} still has active jobs`);
    }
    if (workerPosture === "stopped" && queue.workerCount !== 0) {
      throw new Error(`${queue.name} still has connected workers`);
    }
    if (workerPosture === "connected" && queue.workerCount < 1) {
      throw new Error(`${queue.name} has no connected worker`);
    }
  }
}

export async function pauseProductionBootstrapQueues(
  runtime: Pick<ProductionBootstrapRuntime, "fence" | "queues">,
  attemptId: string,
  options: {
    readonly beforeMutation: () => void | Promise<void>;
    readonly maxPolls?: number;
    readonly pollIntervalMs?: number;
    readonly sleep?: (milliseconds: number) => Promise<void>;
  },
): Promise<ProductionBootstrapQuiescenceSnapshot["queues"]> {
  const maxPolls = options.maxPolls ?? 180;
  const pollIntervalMs = options.pollIntervalMs ?? 5_000;
  const sleep =
    options.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  if (!Number.isSafeInteger(maxPolls) || maxPolls < 1) {
    throw new Error("maxPolls must be a positive safe integer");
  }
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 0) {
    throw new Error("pollIntervalMs must be a non-negative safe integer");
  }

  await acquireProductionBootstrapFence(
    runtime.fence,
    attemptId,
    options.beforeMutation,
  );
  for (const key of PAUSE_ORDER) {
    await verifyProductionBootstrapFence(runtime.fence, attemptId);
    await options.beforeMutation();
    await runtime.queues[key].pause();
    if (!(await runtime.queues[key].isPaused())) {
      throw new Error(`${runtime.queues[key].name} did not enter paused state`);
    }
  }

  for (let poll = 0; poll < maxPolls; poll += 1) {
    await verifyProductionBootstrapFence(runtime.fence, attemptId);
    const snapshot = await snapshotProductionBootstrapQueues(runtime.queues);
    const allIdle = Object.values(snapshot).every(
      (queue) => queue.isPaused && queue.active === 0,
    );
    if (allIdle) return snapshot;
    if (poll + 1 < maxPolls) await sleep(pollIntervalMs);
  }
  throw new Error("production bootstrap queues did not drain before timeout");
}

export async function verifyProductionBootstrapQueues(
  runtime: Pick<ProductionBootstrapRuntime, "fence" | "queues">,
  attemptId: string,
  options: {
    readonly requireWorkersStopped?: boolean;
    readonly workerPosture?: ProductionBootstrapWorkerPosture;
  } = {},
): Promise<ProductionBootstrapQuiescenceSnapshot["queues"]> {
  if (
    options.workerPosture !== undefined &&
    options.requireWorkersStopped !== undefined
  ) {
    throw new Error(
      "queue verification accepts workerPosture or requireWorkersStopped, not both",
    );
  }
  await verifyProductionBootstrapFence(runtime.fence, attemptId);
  const snapshot = await snapshotProductionBootstrapQueues(runtime.queues);
  const workerPosture =
    options.workerPosture ??
    (options.requireWorkersStopped === false ? "any" : "stopped");
  assertQueuesPausedAndIdle(snapshot, workerPosture);
  await verifyProductionBootstrapFence(runtime.fence, attemptId);
  return snapshot;
}

export async function resumeProductionBootstrapQueues(
  runtime: Pick<ProductionBootstrapRuntime, "fence" | "queues">,
  attemptId: string,
  beforeMutation: () => void | Promise<void>,
): Promise<void> {
  await verifyProductionBootstrapQueues(runtime, attemptId, {
    requireWorkersStopped: false,
  });
  try {
    for (const key of RESUME_ORDER) {
      await verifyProductionBootstrapFence(runtime.fence, attemptId);
      await beforeMutation();
      await runtime.queues[key].resume();
      if (await runtime.queues[key].isPaused()) {
        throw new Error(`${runtime.queues[key].name} remained paused after resume`);
      }
    }
    await releaseProductionBootstrapFence(runtime.fence, attemptId, beforeMutation);
  } catch (error) {
    const compensationFailures: string[] = [];
    // A failed BullMQ resume can be ambiguous: the queue may have resumed even
    // though the client observed an error. Re-pause and read back every queue,
    // including queues that were not yet visited and release-fence failures.
    for (const key of PAUSE_ORDER) {
      try {
        await beforeMutation();
        await runtime.queues[key].pause();
        if (!(await runtime.queues[key].isPaused())) {
          compensationFailures.push(runtime.queues[key].name);
        }
      } catch {
        compensationFailures.push(runtime.queues[key].name);
      }
    }
    if (compensationFailures.length > 0) {
      throw new Error(
        `queue resume failed and compensation could not re-pause: ${compensationFailures.join(",")}`,
        { cause: error },
      );
    }
    throw error;
  }
}

async function aggregateCount(
  database: ProductionBootstrapDatabaseQueryClient,
  label: string,
  query: string,
): Promise<number> {
  return firstCount(await database.$queryRawUnsafe(query), label);
}

async function admitProductionBootstrapDatabaseIdentity(
  transaction: ProductionBootstrapDatabaseQueryClient,
  expectedDatabaseIdentityHash: string,
): Promise<string> {
  await transaction.$executeRawUnsafe("SET TRANSACTION READ ONLY");
  await transaction.$executeRawUnsafe("SET LOCAL search_path = public, pg_temp");
  const identityRows = await transaction.$queryRawUnsafe<unknown[]>(`
    SELECT
      pg_catalog.current_database() AS database_name,
      CURRENT_USER AS database_user,
      pg_catalog.current_schema() AS database_schema,
      COALESCE(pg_catalog.inet_server_addr()::text, 'local') AS server_address,
      pg_catalog.inet_server_port()::text AS server_port,
      pg_catalog.current_setting('server_version_num') AS server_version
  `);
  if (!Array.isArray(identityRows) || identityRows.length !== 1) {
    throw new Error("database identity query did not return exactly one row");
  }
  const databaseIdentityHash = productionBootstrapDatabaseIdentityHash(identityRows[0]);
  if (databaseIdentityHash !== expectedDatabaseIdentityHash) {
    throw new Error("database identity does not match the protected target");
  }
  return databaseIdentityHash;
}

export async function assertProductionBootstrapDatabaseIdentity(
  database: ProductionBootstrapDatabaseClient,
  expectedDatabaseIdentityHash: string,
): Promise<string> {
  if (!/^sha256:[0-9a-f]{64}$/.test(expectedDatabaseIdentityHash)) {
    throw new Error("expected database identity hash is invalid");
  }
  return database.$transaction(
    (transaction) => admitProductionBootstrapDatabaseIdentity(
      transaction,
      expectedDatabaseIdentityHash,
    ),
    {
      isolationLevel: "RepeatableRead",
      maxWait: 10_000,
      timeout: 30_000,
    },
  );
}

export async function readProductionBootstrapDatabaseInventory(
  database: ProductionBootstrapDatabaseClient,
  schemaPhase: ProductionBootstrapSchemaPhase,
  expectedDatabaseIdentityHash: string,
): Promise<ProductionBootstrapDatabaseInventory> {
  if (!/^sha256:[0-9a-f]{64}$/.test(expectedDatabaseIdentityHash)) {
    throw new Error("expected database identity hash is invalid");
  }
  return database.$transaction(
    async (transaction) => {
      const databaseIdentityHash = await admitProductionBootstrapDatabaseIdentity(
        transaction,
        expectedDatabaseIdentityHash,
      );

      const sendingRows = await aggregateCount(
        transaction,
        "SENDING inventory",
        `SELECT COUNT(*)::text AS count FROM "OutreachArtifact" WHERE status::text = 'SENDING'`,
      );
      const firstClassDeliveryUnknownRows = await aggregateCount(
        transaction,
        "DELIVERY_UNKNOWN inventory",
        `SELECT COUNT(*)::text AS count FROM "OutreachArtifact" WHERE status::text = 'DELIVERY_UNKNOWN'`,
      );
      const legacyDeliveryUnknownMarkerRows = await aggregateCount(
        transaction,
        "legacy delivery-unknown marker inventory",
        `SELECT COUNT(*)::text AS count FROM "OutreachArtifact" WHERE status::text = 'REJECTED' AND "reviewerNote" LIKE 'delivery-unknown:%'`,
      );
      const firstClassFailedRows = await aggregateCount(
        transaction,
        "FAILED inventory",
        `SELECT COUNT(*)::text AS count FROM "OutreachArtifact" WHERE status::text = 'FAILED'`,
      );
      const legacyAutoFailedMarkerRows = await aggregateCount(
        transaction,
        "legacy auto-failed marker inventory",
        `SELECT COUNT(*)::text AS count FROM "OutreachArtifact" WHERE status::text = 'REJECTED' AND "reviewerNote" LIKE 'auto-failed:%'`,
      );
      const outreachIdempotencyDuplicateGroups = await aggregateCount(
        transaction,
        "outreach idempotency duplicate inventory",
        `
          SELECT COUNT(*)::text AS count FROM (
            SELECT 1
            FROM "OutreachArtifact"
            WHERE "graphRunId" IS NOT NULL AND "recipientRef" IS NOT NULL
            GROUP BY "orgId", "graphRunId", "toolName", "recipientRef"
            HAVING COUNT(*) > 1
          ) AS duplicate_groups
        `,
      );
      const legacyGmailReplySequenceStopRows = await aggregateCount(
        transaction,
        "legacy Gmail reply sequence-stop inventory",
        `
          SELECT COUNT(*)::text AS count
          FROM "OutreachSuppression"
          WHERE "source" = 'gmail_reply' AND "reason" = 'MANUAL'
        `,
      );
      const managerRoleRows = await aggregateCount(
        transaction,
        "MANAGER role inventory",
        `SELECT COUNT(*)::text AS count FROM "User" WHERE "role"::text = 'MANAGER'`,
      );
      const graphRunRunningRows = await aggregateCount(
        transaction,
        "running GraphRun inventory",
        `SELECT COUNT(*)::text AS count FROM "GraphRun" WHERE status::text = 'RUNNING'`,
      );
      const graphRunAwaitingApprovalRows = await aggregateCount(
        transaction,
        "awaiting-approval GraphRun inventory",
        `SELECT COUNT(*)::text AS count FROM "GraphRun" WHERE status::text = 'AWAITING_APPROVAL'`,
      );
      const graphActiveOrgDuplicateGroups = await aggregateCount(
        transaction,
        "active GraphRun organization duplicate inventory",
        `
          SELECT COUNT(*)::text AS count FROM (
            SELECT 1
            FROM "GraphRun"
            WHERE status::text IN ('RUNNING', 'AWAITING_APPROVAL')
            GROUP BY "orgId"
            HAVING COUNT(*) > 1
          ) AS duplicate_active_orgs
        `,
      );
      const graphLifecycleColumnCount = await aggregateCount(
        transaction,
        "GraphRun lifecycle column inventory",
        `
          SELECT COUNT(*)::text AS count
          FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'GraphRun'
            AND column_name IN (
              'startIcpProfileIds',
              'pendingResumeApproved',
              'pendingResumeApprovedBy',
              'dispatchGeneration'
            )
        `,
      );
      const graphLifecycleSchemaReady = graphLifecycleColumnCount === 4;
      const graphActiveWithoutRecoveryStateRows = await aggregateCount(
        transaction,
        "active GraphRun recovery-state inventory",
        graphLifecycleSchemaReady
          ? `
              SELECT COUNT(*)::text AS count
              FROM "GraphRun" AS run
              WHERE run.status::text IN ('RUNNING', 'AWAITING_APPROVAL')
                AND NOT EXISTS (
                  SELECT 1 FROM "GraphCheckpoint" AS checkpoint
                  WHERE checkpoint."threadId" = run."threadId"
                )
                AND cardinality(run."startIcpProfileIds") = 0
            `
          : `
              SELECT COUNT(*)::text AS count
              FROM "GraphRun" AS run
              WHERE run.status::text IN ('RUNNING', 'AWAITING_APPROVAL')
                AND NOT EXISTS (
                  SELECT 1 FROM "GraphCheckpoint" AS checkpoint
                  WHERE checkpoint."threadId" = run."threadId"
                )
            `,
      );

      const requiredReplyColumns = await aggregateCount(
        transaction,
        "reply schema column inventory",
        `
          SELECT COUNT(*)::text AS count
          FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'OutreachArtifact'
            AND column_name IN ('purpose', 'conversationId', 'replyToMessageId')
        `,
      );
      const replySchemaReady = requiredReplyColumns === 3;
      if (schemaPhase === "post-migration" && !replySchemaReady) {
        throw new Error("post-migration reply schema is incomplete");
      }

      let replySourceDuplicateGroups: number | null = null;
      let replyConversationDuplicateGroups: number | null = null;
      let nullSourceReplyRows: number | null = null;
      if (replySchemaReady) {
        replySourceDuplicateGroups = await aggregateCount(
          transaction,
          "reply source duplicate inventory",
          `
            SELECT COUNT(*)::text AS count FROM (
              SELECT 1
              FROM "OutreachArtifact"
              WHERE "purpose"::text = 'REPLY'
                AND "conversationId" IS NOT NULL
                AND "replyToMessageId" IS NOT NULL
                AND status::text IN ('DRAFT','PENDING_REVIEW','APPROVED','SENDING','SENT','DELIVERY_UNKNOWN')
              GROUP BY "orgId", "conversationId", "replyToMessageId"
              HAVING COUNT(*) > 1
            ) AS duplicate_groups
          `,
        );
        replyConversationDuplicateGroups = await aggregateCount(
          transaction,
          "reply conversation duplicate inventory",
          `
            SELECT COUNT(*)::text AS count FROM (
              SELECT 1
              FROM "OutreachArtifact"
              WHERE "purpose"::text = 'REPLY'
                AND "conversationId" IS NOT NULL
                AND status::text IN ('DRAFT','PENDING_REVIEW','APPROVED','SENDING','DELIVERY_UNKNOWN')
              GROUP BY "orgId", "conversationId"
              HAVING COUNT(*) > 1
            ) AS duplicate_groups
          `,
        );
        nullSourceReplyRows = await aggregateCount(
          transaction,
          "reply null-source inventory",
          `
            SELECT COUNT(*)::text AS count
            FROM "OutreachArtifact"
            WHERE "purpose"::text = 'REPLY'
              AND ("conversationId" IS NULL OR "replyToMessageId" IS NULL)
              AND status::text IN ('DRAFT','PENDING_REVIEW','APPROVED','SENDING','SENT','DELIVERY_UNKNOWN')
          `,
        );
      }

      const requiredClerkTables = await aggregateCount(
        transaction,
        "Clerk identity table inventory",
        `
          SELECT COUNT(*)::text AS count
          FROM information_schema.tables
          WHERE table_schema = current_schema()
            AND table_name IN (
              'clerk_identity_cutover',
              'clerk_organization_lifecycle',
              'clerk_membership_lifecycle',
              'clerk_user_lifecycle'
            )
        `,
      );
      const requiredClerkColumns = await aggregateCount(
        transaction,
        "Clerk identity column inventory",
        `
          SELECT COUNT(*)::text AS count
          FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND (
              (table_name = 'Org' AND column_name = 'clerkOrgId')
              OR (table_name = 'User' AND column_name IN ('clerkMembershipId', 'membershipActive'))
            )
        `,
      );
      const clerkIdentitySchemaReady =
        requiredClerkTables === 4 && requiredClerkColumns === 3;
      if (schemaPhase === "post-migration" && !clerkIdentitySchemaReady) {
        throw new Error("post-migration Clerk identity schema is incomplete");
      }

      let clerkCutoverRowCount: number | null = null;
      let clerkCutoverReady: boolean | null = null;
      let clerkMinimumEventVersion: number | null = null;
      let clerkInventoryEvidenceHash: string | null = null;
      let clerkExpectedActiveOrganizationCount: number | null = null;
      let clerkExpectedActiveMembershipCount: number | null = null;
      let clerkExpectedActiveUserCount: number | null = null;
      let clerkActiveOrganizationCount: number | null = null;
      let clerkActiveMembershipCount: number | null = null;
      let clerkActiveUserCount: number | null = null;
      let clerkProjectionMismatchRows: number | null = null;
      let clerkOrphanActiveAuthorityRows: number | null = null;
      let clerkReadinessViolationCount: number | null = null;

      if (clerkIdentitySchemaReady) {
        const cutoverRows = await transaction.$queryRawUnsafe<unknown[]>(`
          SELECT
            "ready" AS ready,
            "minimumEventVersion"::text AS minimum_event_version,
            "inventoryEvidenceHash" AS inventory_evidence_hash,
            "expectedActiveOrganizationCount"::text AS expected_organization_count,
            "expectedActiveMembershipCount"::text AS expected_membership_count,
            "expectedActiveUserCount"::text AS expected_user_count
          FROM "clerk_identity_cutover"
          ORDER BY "id"
        `);
        if (!Array.isArray(cutoverRows)) {
          throw new Error("Clerk identity cutover query did not return an array");
        }
        clerkCutoverRowCount = cutoverRows.length;
        if (cutoverRows.length === 1) {
          const row = cutoverRows[0];
          if (!row || typeof row !== "object") {
            throw new Error("Clerk identity cutover row is invalid");
          }
          const values = row as Record<string, unknown>;
          if (typeof values.ready !== "boolean") {
            throw new Error("Clerk identity cutover readiness is invalid");
          }
          clerkCutoverReady = values.ready;
          clerkMinimumEventVersion = assertSafeInteger(
            values.minimum_event_version,
            "Clerk minimum event version",
          );
          if (
            values.inventory_evidence_hash !== null &&
            (typeof values.inventory_evidence_hash !== "string" ||
              !/^sha256:[0-9a-f]{64}$/.test(values.inventory_evidence_hash))
          ) {
            throw new Error("Clerk inventory evidence hash is invalid");
          }
          clerkInventoryEvidenceHash = values.inventory_evidence_hash as
            | string
            | null;
          clerkExpectedActiveOrganizationCount = assertSafeInteger(
            values.expected_organization_count,
            "Clerk expected active organization count",
          );
          clerkExpectedActiveMembershipCount = assertSafeInteger(
            values.expected_membership_count,
            "Clerk expected active membership count",
          );
          clerkExpectedActiveUserCount = assertSafeInteger(
            values.expected_user_count,
            "Clerk expected active user count",
          );
        }

        clerkActiveOrganizationCount = await aggregateCount(
          transaction,
          "active Clerk organization inventory",
          `SELECT COUNT(*)::text AS count FROM "clerk_organization_lifecycle" WHERE NOT "deleted"`,
        );
        clerkActiveMembershipCount = await aggregateCount(
          transaction,
          "active Clerk membership inventory",
          `SELECT COUNT(*)::text AS count FROM "clerk_membership_lifecycle" WHERE NOT "deleted"`,
        );
        clerkActiveUserCount = await aggregateCount(
          transaction,
          "active Clerk user inventory",
          `SELECT COUNT(*)::text AS count FROM "clerk_user_lifecycle" WHERE NOT "deleted" AND "membershipActive"`,
        );
        clerkProjectionMismatchRows = await aggregateCount(
          transaction,
          "Clerk active projection mismatch inventory",
          `
            SELECT COUNT(*)::text AS count FROM (
              SELECT 1
              FROM "User" AS u
              JOIN "Org" AS o ON o."id" = u."orgId"
              LEFT JOIN "clerk_organization_lifecycle" AS ol
                ON ol."clerkOrgId" = o."clerkOrgId"
              LEFT JOIN "clerk_membership_lifecycle" AS ml
                ON ml."clerkMembershipId" = u."clerkMembershipId"
              LEFT JOIN "clerk_user_lifecycle" AS ul
                ON ul."clerkUserId" = u."clerkId"
              WHERE u."membershipActive"
                AND (
                  (o."clerkOrgId" IS NULL AND (
                    u."clerkMembershipId" IS NOT NULL
                    OR u."clerkId" IS NOT NULL
                    OR u."role"::text <> 'OWNER'
                  ))
                  OR (o."clerkOrgId" IS NOT NULL AND (
                    u."clerkId" IS NULL
                    OR u."clerkMembershipId" IS NULL
                    OR ol."clerkOrgId" IS NULL
                    OR ol."deleted"
                    OR ml."clerkMembershipId" IS NULL
                    OR ml."deleted"
                    OR ml."clerkUserId" IS DISTINCT FROM u."clerkId"
                    OR ml."clerkOrgId" IS DISTINCT FROM o."clerkOrgId"
                    OR ul."clerkUserId" IS NULL
                    OR ul."deleted"
                    OR NOT ul."membershipActive"
                    OR ul."clerkMembershipId" IS DISTINCT FROM u."clerkMembershipId"
                    OR ul."clerkOrgId" IS DISTINCT FROM o."clerkOrgId"
                    OR ul."membershipEventVersion" IS DISTINCT FROM ml."eventVersion"
                    OR ul."membershipEventRank" IS DISTINCT FROM ml."eventRank"
                    OR ml."role" IS DISTINCT FROM ul."role"
                    OR NOT (
                      u."role" = ul."role"
                      OR (u."role"::text = 'OWNER' AND ul."role"::text = 'ADMIN')
                    )
                  ))
                )
            ) AS projection_mismatches
          `,
        );
        clerkOrphanActiveAuthorityRows = await aggregateCount(
          transaction,
          "Clerk orphan active authority inventory",
          `
            SELECT COUNT(*)::text AS count FROM (
              SELECT 1
              FROM "clerk_membership_lifecycle" AS ml
              LEFT JOIN "clerk_user_lifecycle" AS ul
                ON ul."clerkMembershipId" = ml."clerkMembershipId"
              LEFT JOIN "Org" AS o ON o."clerkOrgId" = ml."clerkOrgId"
              LEFT JOIN "User" AS u
                ON u."clerkId" = ml."clerkUserId" AND u."orgId" = o."id"
              WHERE NOT ml."deleted"
                AND (
                  ul."clerkUserId" IS NULL
                  OR ul."deleted"
                  OR NOT ul."membershipActive"
                  OR ul."clerkUserId" IS DISTINCT FROM ml."clerkUserId"
                  OR ul."clerkOrgId" IS DISTINCT FROM ml."clerkOrgId"
                  OR ul."membershipEventVersion" IS DISTINCT FROM ml."eventVersion"
                  OR ul."membershipEventRank" IS DISTINCT FROM ml."eventRank"
                  OR ul."role" IS DISTINCT FROM ml."role"
                  OR u."id" IS NULL
                  OR NOT u."membershipActive"
                  OR u."clerkMembershipId" IS DISTINCT FROM ml."clerkMembershipId"
                )
              UNION ALL
              SELECT 1
              FROM "clerk_organization_lifecycle" AS ol
              LEFT JOIN "Org" AS o ON o."clerkOrgId" = ol."clerkOrgId"
              WHERE NOT ol."deleted" AND o."id" IS NULL
              UNION ALL
              SELECT 1
              FROM "clerk_user_lifecycle" AS ul
              LEFT JOIN "clerk_membership_lifecycle" AS ml
                ON ml."clerkMembershipId" = ul."clerkMembershipId"
              WHERE NOT ul."deleted"
                AND ul."membershipActive"
                AND (ml."clerkMembershipId" IS NULL OR ml."deleted")
            ) AS orphan_authorities
          `,
        );
        clerkReadinessViolationCount = await aggregateCount(
          transaction,
          "Clerk cutover readiness violation inventory",
          `
            SELECT COUNT(*)::text AS count FROM (
              WITH singleton AS (
                SELECT
                  COUNT(*) AS row_count,
                  COUNT(*) FILTER (
                    WHERE "id" = 1
                      AND "ready"
                      AND "minimumEventVersion" BETWEEN 1 AND 9007199254740991
                      AND "minimumEventVersion" BETWEEN
                        ((EXTRACT(EPOCH FROM "establishedAt") * 1000)::BIGINT - 86400000)
                        AND ((EXTRACT(EPOCH FROM "establishedAt") * 1000)::BIGINT + 86400000)
                      AND "inventoryEvidenceHash" ~ '^sha256:[0-9a-f]{64}$'
                      AND "expectedActiveOrganizationCount" >= 0
                      AND "expectedActiveMembershipCount" >= 0
                      AND "expectedActiveUserCount" >= 0
                  ) AS ready_count
                FROM "clerk_identity_cutover"
              )
              SELECT 1 AS violation
              FROM singleton
              WHERE row_count <> 1 OR ready_count <> 1
              UNION ALL
              SELECT 1
              FROM "clerk_identity_cutover" AS c
              WHERE c."id" = 1 AND c."ready"
                AND c."expectedActiveOrganizationCount" <>
                  (SELECT COUNT(*) FROM "clerk_organization_lifecycle" WHERE NOT "deleted")
              UNION ALL
              SELECT 1
              FROM "clerk_identity_cutover" AS c
              WHERE c."id" = 1 AND c."ready"
                AND c."expectedActiveMembershipCount" <>
                  (SELECT COUNT(*) FROM "clerk_membership_lifecycle" WHERE NOT "deleted")
              UNION ALL
              SELECT 1
              FROM "clerk_identity_cutover" AS c
              WHERE c."id" = 1 AND c."ready"
                AND c."expectedActiveUserCount" <>
                  (SELECT COUNT(*) FROM "clerk_user_lifecycle"
                   WHERE NOT "deleted" AND "membershipActive")
              UNION ALL
              SELECT 1
              FROM "clerk_organization_lifecycle" AS l
              CROSS JOIN "clerk_identity_cutover" AS c
              WHERE c."id" = 1 AND c."ready"
                AND (l."eventVersion" NOT BETWEEN 1 AND 9007199254740991
                  OR l."eventRank" NOT BETWEEN 1 AND 3
                  OR l."eventVersion" > c."minimumEventVersion")
              UNION ALL
              SELECT 1
              FROM "clerk_membership_lifecycle" AS l
              CROSS JOIN "clerk_identity_cutover" AS c
              WHERE c."id" = 1 AND c."ready"
                AND (l."eventVersion" NOT BETWEEN 1 AND 9007199254740991
                  OR l."eventRank" NOT BETWEEN 1 AND 3
                  OR l."eventVersion" > c."minimumEventVersion")
              UNION ALL
              SELECT 1
              FROM "clerk_user_lifecycle" AS l
              CROSS JOIN "clerk_identity_cutover" AS c
              WHERE c."id" = 1 AND c."ready"
                AND ((l."membershipEventVersion" IS NULL)
                    IS DISTINCT FROM (l."membershipEventRank" IS NULL)
                  OR (l."membershipEventVersion" IS NOT NULL AND (
                    l."membershipEventVersion" NOT BETWEEN 1 AND 9007199254740991
                    OR l."membershipEventRank" NOT BETWEEN 1 AND 3
                    OR l."membershipEventVersion" > c."minimumEventVersion"
                  )))
            ) AS readiness_violations
          `,
        );
      }

      const replySlotDuplicateRows =
        replySourceDuplicateGroups === null ||
        replyConversationDuplicateGroups === null
          ? null
          : replySourceDuplicateGroups + replyConversationDuplicateGroups;
      const duplicateEvidence = {
        replySchemaReady,
        replySourceDuplicateGroups,
        replyConversationDuplicateGroups,
        nullSourceReplyRows,
      };

      return {
        databaseIdentityHash,
        sendingRows,
        firstClassDeliveryUnknownRows,
        legacyDeliveryUnknownMarkerRows,
        firstClassFailedRows,
        legacyAutoFailedMarkerRows,
        outreachIdempotencyDuplicateGroups,
        legacyGmailReplySequenceStopRows,
        managerRoleRows,
        graphRunRunningRows,
        graphRunAwaitingApprovalRows,
        graphActiveOrgDuplicateGroups,
        graphActiveWithoutRecoveryStateRows,
        graphLifecycleSchemaReady,
        replySourceDuplicateGroups,
        replyConversationDuplicateGroups,
        nullSourceReplyRows,
        replySlotDuplicateRows,
        duplicateInventoryEvidenceHash: sha256Json(duplicateEvidence),
        replySchemaReady,
        clerkIdentitySchemaReady,
        clerkCutoverRowCount,
        clerkCutoverReady,
        clerkMinimumEventVersion,
        clerkInventoryEvidenceHash,
        clerkExpectedActiveOrganizationCount,
        clerkExpectedActiveMembershipCount,
        clerkExpectedActiveUserCount,
        clerkActiveOrganizationCount,
        clerkActiveMembershipCount,
        clerkActiveUserCount,
        clerkProjectionMismatchRows,
        clerkOrphanActiveAuthorityRows,
        clerkReadinessViolationCount,
      };
    },
    {
      isolationLevel: "RepeatableRead",
      maxWait: 10_000,
      timeout: 60_000,
    },
  );
}

export function assertProductionBootstrapInventoryReady(
  inventory: ProductionBootstrapDatabaseInventory,
  schemaPhase: ProductionBootstrapSchemaPhase,
): void {
  if (
    inventory.sendingRows !== 0 ||
    inventory.firstClassDeliveryUnknownRows !== 0 ||
    inventory.legacyDeliveryUnknownMarkerRows !== 0 ||
    inventory.firstClassFailedRows !== 0
  ) {
    throw new Error("ambiguous outreach inventory must be reconciled to zero");
  }
  if (inventory.outreachIdempotencyDuplicateGroups !== 0) {
    throw new Error("outreach idempotency duplicate inventory must be zero");
  }
  if (
    inventory.graphRunRunningRows !== 0 ||
    inventory.graphActiveOrgDuplicateGroups !== 0 ||
    inventory.graphActiveWithoutRecoveryStateRows !== 0
  ) {
    throw new Error(
      "active GraphRun inventory must be idle, single-flight, and reconstructable",
    );
  }
  if (schemaPhase === "post-migration") {
    if (
      !inventory.replySchemaReady ||
      inventory.replySlotDuplicateRows !== 0 ||
      inventory.nullSourceReplyRows !== 0
    ) {
      throw new Error(
        "post-migration reply duplicate and null-source inventory must be zero",
      );
    }
    if (!inventory.graphLifecycleSchemaReady) {
      throw new Error("post-migration GraphRun lifecycle schema is incomplete");
    }
    if (
      !inventory.clerkIdentitySchemaReady ||
      inventory.clerkCutoverRowCount !== 1 ||
      inventory.clerkCutoverReady !== true ||
      inventory.clerkMinimumEventVersion === null ||
      inventory.clerkMinimumEventVersion < 1 ||
      inventory.clerkMinimumEventVersion > Number.MAX_SAFE_INTEGER ||
      inventory.clerkInventoryEvidenceHash === null ||
      inventory.clerkExpectedActiveOrganizationCount === null ||
      inventory.clerkExpectedActiveOrganizationCount < 0 ||
      inventory.clerkExpectedActiveMembershipCount === null ||
      inventory.clerkExpectedActiveMembershipCount < 0 ||
      inventory.clerkExpectedActiveUserCount === null ||
      inventory.clerkExpectedActiveUserCount < 0 ||
      inventory.clerkExpectedActiveOrganizationCount !==
        inventory.clerkActiveOrganizationCount ||
      inventory.clerkExpectedActiveMembershipCount !==
        inventory.clerkActiveMembershipCount ||
      inventory.clerkExpectedActiveUserCount !== inventory.clerkActiveUserCount ||
      inventory.clerkProjectionMismatchRows !== 0 ||
      inventory.clerkOrphanActiveAuthorityRows !== 0 ||
      inventory.clerkReadinessViolationCount !== 0
    ) {
      throw new Error(
        "post-migration Clerk cutover must be armed with exact zero-violation inventory",
      );
    }
  }
}

export async function createProductionBootstrapSnapshot(
  runtime: Pick<
    ProductionBootstrapRuntime,
    "fence" | "queues" | "database" | "redisIdentityHash"
  >,
  attemptId: string,
  schemaPhase: ProductionBootstrapSchemaPhase,
  writerFenceGeneration: number,
  options: {
    readonly capturedAt?: Date;
    readonly beforeWriterFenceRead: () => void | Promise<void>;
    readonly expectedDatabaseIdentityHash: string;
    readonly workerPosture: Exclude<ProductionBootstrapWorkerPosture, "any">;
  },
): Promise<ProductionBootstrapQuiescenceSnapshot> {
  if (!Number.isSafeInteger(writerFenceGeneration) || writerFenceGeneration < 1) {
    throw new Error("production bootstrap writer-fence generation is invalid");
  }
  const capturedAt = options.capturedAt ?? new Date();
  await verifyProductionBootstrapQueues(runtime, attemptId, {
    workerPosture: options.workerPosture,
  });
  const database = await readProductionBootstrapDatabaseInventory(
    runtime.database,
    schemaPhase,
    options.expectedDatabaseIdentityHash,
  );
  // Re-sample all queue and worker state after the repeatable-read database
  // inventory. Entry evidence uses this second observation, never the stale
  // pre-database sample.
  const queues = await verifyProductionBootstrapQueues(runtime, attemptId, {
    workerPosture: options.workerPosture,
  });
  const writerFence = await readProductionBootstrapWriterFence(
    runtime.fence,
    options.beforeWriterFenceRead,
  );
  assertClosedWriterFenceReadback(writerFence, {
    bootstrapAttemptId: attemptId,
    generation: writerFenceGeneration,
  });
  if (!/^sha256:[0-9a-f]{64}$/.test(runtime.redisIdentityHash)) {
    throw new Error("production bootstrap Redis identity hash is invalid");
  }
  const evidence = {
    schemaVersion: 2 as const,
    bootstrapAttemptId: attemptId,
    capturedAt: canonicalUtcSeconds(capturedAt, "production bootstrap capturedAt"),
    fenceHeld: true as const,
    redisIdentityHash: runtime.redisIdentityHash,
    writerFence,
    schemaPhase,
    queues,
    database,
  };
  return { ...evidence, evidenceHash: sha256Json(evidence) };
}

export function createProductionBootstrapRuntime(
  expectedRedisIdentityHash: string,
): ProductionBootstrapRuntime {
  if (!/^sha256:[0-9a-f]{64}$/.test(expectedRedisIdentityHash)) {
    throw new Error("expected production bootstrap Redis identity hash is invalid");
  }
  // Compare the descriptor synchronously before constructing any Redis or
  // BullMQ client. BullMQ Queue construction can otherwise initialize queue
  // metadata on a mistakenly configured target.
  const redisIdentityHash = productionBootstrapRedisIdentityHash();
  if (redisIdentityHash !== expectedRedisIdentityHash) {
    throw new Error("Redis identity does not match the protected target");
  }
  const connection = buildRedisConnectionOptions();
  if (!connection) {
    throw new Error("production bootstrap requires an explicit Redis connection");
  }
  const redisUrl = process.env.REDIS_URL;
  const redis = redisUrl
    ? new Redis(redisUrl, {
        maxRetriesPerRequest: null,
        enableReadyCheck: true,
      })
    : new Redis({
        host: process.env.REDIS_HOST!,
        port: Number(process.env.REDIS_PORT ?? 6380),
        username: process.env.REDIS_USERNAME,
        password: process.env.REDIS_PASSWORD,
        tls: process.env.REDIS_TLS === "false" ? undefined : {},
        maxRetriesPerRequest: null,
        enableReadyCheck: true,
      });
  const database = new PrismaClient();
  const queues = {
    agentRuns: new Queue(PRODUCTION_BOOTSTRAP_QUEUE_NAMES.agentRuns, {
      connection,
      skipMetasUpdate: true,
    }),
    graphRuns: new Queue(PRODUCTION_BOOTSTRAP_QUEUE_NAMES.graphRuns, {
      connection,
      skipMetasUpdate: true,
    }),
    outreachSend: new Queue(PRODUCTION_BOOTSTRAP_QUEUE_NAMES.outreachSend, {
      connection,
      skipMetasUpdate: true,
    }),
  };
  return {
    fence: redis,
    queues,
    redisIdentityHash,
    database,
    async close(): Promise<void> {
      await Promise.all([
        queues.agentRuns.close(),
        queues.graphRuns.close(),
        queues.outreachSend.close(),
        database.$disconnect(),
      ]);
      await redis.quit();
    },
  };
}
