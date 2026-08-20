import { describe, expect, it } from "vitest";
import {
  PRODUCTION_BOOTSTRAP_FENCE_KEY,
  acquireProductionBootstrapFence,
  assertProductionBootstrapInventoryReady,
  createProductionBootstrapSnapshot,
  pauseProductionBootstrapQueues,
  productionBootstrapDatabaseIdentityHash,
  productionBootstrapRedisIdentityHash,
  resumeProductionBootstrapQueues,
  verifyProductionBootstrapFence,
  verifyProductionBootstrapQueues,
  type ProductionBootstrapDatabaseClient,
  type ProductionBootstrapDatabaseQueryClient,
  type ProductionBootstrapFenceClient,
  type ProductionBootstrapQueueHandle,
  type ProductionBootstrapRuntime,
} from "../production-bootstrap-quiescence";

const ATTEMPT = "0123456789abcdef0123456789abcdef";
const FAKE_DATABASE_IDENTITY_HASH = productionBootstrapDatabaseIdentityHash({
  database_name: "redacted-by-hash",
  database_user: "redacted-by-hash",
  database_schema: "public",
  server_address: "redacted-by-hash",
  server_port: "5432",
  server_version: "160000",
});

class FakeFence implements ProductionBootstrapFenceClient {
  readonly values = new Map<string, string>();

  async ping(): Promise<"PONG"> {
    return "PONG";
  }
  failDelete = false;

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string, _mode: "NX"): Promise<"OK" | null> {
    if (this.values.has(key)) return null;
    this.values.set(key, value);
    return "OK";
  }

  async eval(
    script: string,
    _numberOfKeys: number,
    ...args: Array<string | number>
  ): Promise<unknown> {
    if (script.includes("WORKFORCE_OS_WRITER_FENCE_READ_V1")) {
      return [
        JSON.stringify({
          schemaVersion: 1,
          target: "workforce-os-production",
          mode: "closed",
          bootstrapAttemptId: ATTEMPT,
          generation: 1,
          issuedAt: "2026-08-13T12:00:00Z",
          expiresAt: "2026-08-14T12:00:00Z",
        }),
        "1",
        "0",
        "0",
        String(Date.parse("2026-08-14T00:00:00Z") / 1_000),
      ];
    }
    const [key, value] = args as [string, string];
    if (this.failDelete) return 0;
    if (this.values.get(key) !== value) return 0;
    this.values.delete(key);
    return 1;
  }

  async quit(): Promise<void> {}
}

class FakeQueue implements ProductionBootstrapQueueHandle {
  isGloballyPaused = false;
  activeCounts: number[] = [0];
  workerCount = 0;
  failResume = false;
  failResumeAfterStateChange = false;

  constructor(
    readonly name: string,
    private readonly events: string[],
  ) {}

  async pause(): Promise<void> {
    this.events.push(`pause:${this.name}`);
    this.isGloballyPaused = true;
  }

  async resume(): Promise<void> {
    this.events.push(`resume:${this.name}`);
    if (this.failResume) throw new Error(`resume failed: ${this.name}`);
    this.isGloballyPaused = false;
    if (this.failResumeAfterStateChange) {
      throw new Error(`resume result uncertain: ${this.name}`);
    }
  }

  async isPaused(): Promise<boolean> {
    return this.isGloballyPaused;
  }

  async getJobCounts(): Promise<Record<string, number>> {
    const active = this.activeCounts[0] ?? 0;
    if (this.activeCounts.length > 1) this.activeCounts.shift();
    return {
      waiting: 2,
      active,
      delayed: 1,
      prioritized: 0,
      completed: 4,
      failed: 1,
      "waiting-children": 0,
      paused: 3,
    };
  }

  async getWorkers(): Promise<unknown[]> {
    return Array.from({ length: this.workerCount }, () => ({}));
  }

  async close(): Promise<void> {}
}

class FakeDatabase implements ProductionBootstrapDatabaseClient {
  transactionCalls = 0;
  afterTransaction: (() => void) | undefined;

  async $executeRawUnsafe(): Promise<number> {
    return 0;
  }

  async $queryRawUnsafe<T = unknown>(query: string): Promise<T> {
    let result: unknown;
    if (query.includes("current_database()")) {
      result = [
        {
          database_name: "redacted-by-hash",
          database_user: "redacted-by-hash",
          database_schema: "public",
          server_address: "redacted-by-hash",
          server_port: "5432",
          server_version: "160000",
        },
      ];
    } else if (query.includes('FROM "clerk_identity_cutover"') && query.includes("expected_organization_count")) {
      result = [
        {
          ready: true,
          minimum_event_version: "1786665600000",
          inventory_evidence_hash: `sha256:${"c".repeat(64)}`,
          expected_organization_count: "0",
          expected_membership_count: "0",
          expected_user_count: "0",
        },
      ];
    } else if (query.includes("information_schema.tables")) {
      result = [{ count: "4" }];
    } else if (
      query.includes("startIcpProfileIds") &&
      query.includes("information_schema.columns")
    ) {
      result = [{ count: "4" }];
    } else if (query.includes("clerkOrgId") && query.includes("information_schema.columns")) {
      result = [{ count: "3" }];
    } else if (query.includes("information_schema.columns")) {
      result = [{ count: "3" }];
    } else {
      result = [{ count: "0" }];
    }
    return result as T;
  }

  async $transaction<T>(
    operation: (
      transaction: ProductionBootstrapDatabaseQueryClient,
    ) => Promise<T>,
    _options: {
      isolationLevel: "RepeatableRead";
      maxWait: number;
      timeout: number;
    },
  ): Promise<T> {
    this.transactionCalls += 1;
    const result = await operation(this);
    this.afterTransaction?.();
    return result;
  }

  async $disconnect(): Promise<void> {}
}

function fakeRuntime(): {
  runtime: ProductionBootstrapRuntime;
  fence: FakeFence;
  queues: {
    agentRuns: FakeQueue;
    graphRuns: FakeQueue;
    outreachSend: FakeQueue;
  };
  database: FakeDatabase;
  events: string[];
} {
  const events: string[] = [];
  const fence = new FakeFence();
  const queues = {
    agentRuns: new FakeQueue("agent-runs", events),
    graphRuns: new FakeQueue("graph-runs", events),
    outreachSend: new FakeQueue("outreach-send", events),
  };
  const database = new FakeDatabase();
  return {
    fence,
    queues,
    database,
    events,
    runtime: {
      fence,
      queues,
      redisIdentityHash: `sha256:${"a".repeat(64)}`,
      database,
      async close(): Promise<void> {},
    },
  };
}

describe("production bootstrap quiescence", () => {
  it("uses the reviewed cross-runtime database identity hash contract", () => {
    const identity = {
      database_name: "workforce",
      database_user: "bootstrap_role",
      database_schema: "public",
      server_address: "10.20.30.40",
      server_port: "5432",
      server_version: "160003",
    };
    expect(productionBootstrapDatabaseIdentityHash(identity)).toBe(
      "sha256:519c9e5b9813b43905f069c3f5e1a1c3e35a41bff832acc944b1a6b513b93058",
    );
    expect(() => productionBootstrapDatabaseIdentityHash({
      ...identity,
      database_schema: undefined,
    })).toThrow("database_schema is invalid");
  });

  it("acquires one durable attempt fence idempotently and rejects a rival", async () => {
    const fence = new FakeFence();
    await expect(acquireProductionBootstrapFence(fence, ATTEMPT, () => undefined)).resolves.toBe(
      "acquired",
    );
    await expect(acquireProductionBootstrapFence(fence, ATTEMPT, () => undefined)).resolves.toBe(
      "already-held",
    );
    await expect(
      acquireProductionBootstrapFence(
        fence,
        "ffffffffffffffffffffffffffffffff",
        () => undefined,
      ),
    ).rejects.toThrow("another production bootstrap attempt");
  });

  it("pauses send-first, drains active jobs, and retains the fence", async () => {
    const { runtime, queues, events, fence } = fakeRuntime();
    queues.outreachSend.activeCounts = [1, 0];
    const snapshot = await pauseProductionBootstrapQueues(runtime, ATTEMPT, {
      beforeMutation: () => undefined,
      maxPolls: 3,
      pollIntervalMs: 0,
      sleep: async () => {},
    });
    expect(events.slice(0, 3)).toEqual([
      "pause:outreach-send",
      "pause:graph-runs",
      "pause:agent-runs",
    ]);
    expect(snapshot.outreachSend.active).toBe(0);
    expect(fence.values.get(PRODUCTION_BOOTSTRAP_FENCE_KEY)).toBe(ATTEMPT);
  });

  it("rejects a lost pause or a reappearing active job", async () => {
    const { runtime, queues, fence } = fakeRuntime();
    fence.values.set(PRODUCTION_BOOTSTRAP_FENCE_KEY, ATTEMPT);
    queues.agentRuns.isGloballyPaused = true;
    queues.graphRuns.isGloballyPaused = true;
    queues.outreachSend.isGloballyPaused = false;
    await expect(verifyProductionBootstrapQueues(runtime, ATTEMPT)).rejects.toThrow(
      "not globally paused",
    );
    queues.outreachSend.isGloballyPaused = true;
    queues.graphRuns.activeCounts = [1];
    await expect(verifyProductionBootstrapQueues(runtime, ATTEMPT)).rejects.toThrow(
      "still has active jobs",
    );
  });

  it("resumes outreach last and compare-deletes the exact fence", async () => {
    const { runtime, queues, events, fence } = fakeRuntime();
    fence.values.set(PRODUCTION_BOOTSTRAP_FENCE_KEY, ATTEMPT);
    for (const queue of Object.values(queues)) queue.isGloballyPaused = true;
    await resumeProductionBootstrapQueues(runtime, ATTEMPT, () => undefined);
    expect(events).toEqual([
      "resume:graph-runs",
      "resume:outreach-send",
    ]);
    await expect(verifyProductionBootstrapFence(fence, ATTEMPT)).rejects.toThrow(
      "absent or owned elsewhere",
    );
  });

  it("re-pauses already resumed queues and retains the fence on partial resume", async () => {
    const { runtime, queues, events, fence } = fakeRuntime();
    fence.values.set(PRODUCTION_BOOTSTRAP_FENCE_KEY, ATTEMPT);
    for (const queue of Object.values(queues)) queue.isGloballyPaused = true;
    queues.outreachSend.failResume = true;
    await expect(resumeProductionBootstrapQueues(runtime, ATTEMPT, () => undefined)).rejects.toThrow(
      "resume failed: outreach-send",
    );
    expect(events).toEqual([
      "resume:graph-runs",
      "resume:outreach-send",
      "pause:outreach-send",
      "pause:graph-runs",
      "pause:agent-runs",
    ]);
    expect(Object.values(queues).every((queue) => queue.isGloballyPaused)).toBe(
      true,
    );
    expect(fence.values.get(PRODUCTION_BOOTSTRAP_FENCE_KEY)).toBe(ATTEMPT);
  });

  it("re-pauses every queue when resume succeeds but its result is uncertain", async () => {
    const { runtime, queues, events, fence } = fakeRuntime();
    fence.values.set(PRODUCTION_BOOTSTRAP_FENCE_KEY, ATTEMPT);
    for (const queue of Object.values(queues)) queue.isGloballyPaused = true;
    queues.graphRuns.failResumeAfterStateChange = true;
    await expect(resumeProductionBootstrapQueues(runtime, ATTEMPT, () => undefined)).rejects.toThrow(
      "resume result uncertain: graph-runs",
    );
    expect(events).toEqual([
      "resume:graph-runs",
      "pause:outreach-send",
      "pause:graph-runs",
      "pause:agent-runs",
    ]);
    expect(Object.values(queues).every((queue) => queue.isGloballyPaused)).toBe(
      true,
    );
  });

  it("re-pauses every queue when fence release fails after all resumes", async () => {
    const { runtime, queues, events, fence } = fakeRuntime();
    fence.values.set(PRODUCTION_BOOTSTRAP_FENCE_KEY, ATTEMPT);
    fence.failDelete = true;
    for (const queue of Object.values(queues)) queue.isGloballyPaused = true;
    await expect(resumeProductionBootstrapQueues(runtime, ATTEMPT, () => undefined)).rejects.toThrow(
      "compare-and-delete failed",
    );
    expect(events).toEqual([
      "resume:graph-runs",
      "resume:outreach-send",
      "pause:outreach-send",
      "pause:graph-runs",
      "pause:agent-runs",
    ]);
    expect(Object.values(queues).every((queue) => queue.isGloballyPaused)).toBe(
      true,
    );
  });

  it("requires every worker connection to be gone for entry evidence", async () => {
    const { runtime, queues, fence } = fakeRuntime();
    fence.values.set(PRODUCTION_BOOTSTRAP_FENCE_KEY, ATTEMPT);
    for (const queue of Object.values(queues)) queue.isGloballyPaused = true;
    queues.graphRuns.workerCount = 1;
    await expect(verifyProductionBootstrapQueues(runtime, ATTEMPT)).rejects.toThrow(
      "graph-runs still has connected workers",
    );
    await expect(
      verifyProductionBootstrapQueues(runtime, ATTEMPT, {
        requireWorkersStopped: false,
      }),
    ).resolves.toMatchObject({ graphRuns: { workerCount: 1 } });
  });

  it("creates sanitized post-migration evidence and enforces zero-risk inventory", async () => {
    const { runtime, queues, fence, database } = fakeRuntime();
    fence.values.set(PRODUCTION_BOOTSTRAP_FENCE_KEY, ATTEMPT);
    for (const queue of Object.values(queues)) queue.isGloballyPaused = true;
    const snapshot = await createProductionBootstrapSnapshot(
      runtime,
      ATTEMPT,
      "post-migration",
      1,
      {
        beforeWriterFenceRead: () => undefined,
        expectedDatabaseIdentityHash: FAKE_DATABASE_IDENTITY_HASH,
        capturedAt: new Date("2026-08-14T00:00:00.000Z"),
        workerPosture: "stopped",
      },
    );
    expect(snapshot.database.databaseIdentityHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(snapshot.database.replySlotDuplicateRows).toBe(0);
    expect(snapshot.database.nullSourceReplyRows).toBe(0);
    expect(snapshot.database.clerkCutoverReady).toBe(true);
    expect(snapshot.database.clerkReadinessViolationCount).toBe(0);
    expect(snapshot.database.graphActiveWithoutRecoveryStateRows).toBe(0);
    expect(snapshot.schemaVersion).toBe(2);
    expect(snapshot.capturedAt).toBe("2026-08-14T00:00:00Z");
    expect(snapshot.redisIdentityHash).toBe(`sha256:${"a".repeat(64)}`);
    expect(database.transactionCalls).toBe(1);
    expect(snapshot.evidenceHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(JSON.stringify(snapshot)).not.toContain("redacted-by-hash");
    expect(() =>
      assertProductionBootstrapInventoryReady(snapshot.database, "post-migration"),
    ).not.toThrow();
  });

  it("keeps B2 entry worker-free when re-sampling after database inventory", async () => {
    const { runtime, queues, fence, database } = fakeRuntime();
    fence.values.set(PRODUCTION_BOOTSTRAP_FENCE_KEY, ATTEMPT);
    for (const queue of Object.values(queues)) queue.isGloballyPaused = true;
    database.afterTransaction = () => {
      queues.outreachSend.workerCount = 1;
    };
    await expect(
      createProductionBootstrapSnapshot(runtime, ATTEMPT, "pre-migration", 1, {
        beforeWriterFenceRead: () => undefined,
        expectedDatabaseIdentityHash: FAKE_DATABASE_IDENTITY_HASH,
        workerPosture: "stopped",
      }),
    ).rejects.toThrow("outreach-send still has connected workers");
  });

  it("allows connected post-entry workers while queues remain paused and idle", async () => {
    const { runtime, queues, fence } = fakeRuntime();
    fence.values.set(PRODUCTION_BOOTSTRAP_FENCE_KEY, ATTEMPT);
    for (const queue of Object.values(queues)) queue.isGloballyPaused = true;
    queues.graphRuns.workerCount = 1;
    queues.outreachSend.workerCount = 1;

    const snapshot = await createProductionBootstrapSnapshot(
      runtime,
      ATTEMPT,
      "post-migration",
      1,
      {
        beforeWriterFenceRead: () => undefined,
        expectedDatabaseIdentityHash: FAKE_DATABASE_IDENTITY_HASH,
        workerPosture: "connected",
      },
    );
    expect(snapshot.queues.agentRuns.workerCount).toBe(0);
    expect(snapshot.queues.graphRuns.workerCount).toBe(1);
    expect(snapshot.queues.outreachSend.workerCount).toBe(1);
    expect(
      Object.values(snapshot.queues).every(
        (queue) => queue.isPaused && queue.active === 0,
      ),
    ).toBe(true);
  });

  it("rejects a connected worker on the retired agent-runs queue", async () => {
    const { runtime, queues, fence } = fakeRuntime();
    fence.values.set(PRODUCTION_BOOTSTRAP_FENCE_KEY, ATTEMPT);
    for (const queue of Object.values(queues)) queue.isGloballyPaused = true;
    queues.agentRuns.workerCount = 1;
    queues.graphRuns.workerCount = 1;
    queues.outreachSend.workerCount = 1;

    await expect(
      createProductionBootstrapSnapshot(
        runtime,
        ATTEMPT,
        "post-migration",
        1,
        {
          beforeWriterFenceRead: () => undefined,
          expectedDatabaseIdentityHash: FAKE_DATABASE_IDENTITY_HASH,
          workerPosture: "connected",
        },
      ),
    ).rejects.toThrow("agent-runs is retired but still has connected workers");
  });

  it("still rejects active work in a post-entry connected-worker snapshot", async () => {
    const { runtime, queues, fence, database } = fakeRuntime();
    fence.values.set(PRODUCTION_BOOTSTRAP_FENCE_KEY, ATTEMPT);
    for (const queue of Object.values(queues)) queue.isGloballyPaused = true;
    queues.graphRuns.workerCount = 1;
    queues.outreachSend.workerCount = 1;
    database.afterTransaction = () => {
      queues.graphRuns.activeCounts = [1];
    };

    await expect(
      createProductionBootstrapSnapshot(
        runtime,
        ATTEMPT,
        "post-migration",
        1,
        {
          beforeWriterFenceRead: () => undefined,
          expectedDatabaseIdentityHash: FAKE_DATABASE_IDENTITY_HASH,
          workerPosture: "connected",
        },
      ),
    ).rejects.toThrow("graph-runs still has active jobs");
  });

  it("rejects a B6 connected posture when any queue has zero workers", async () => {
    const { runtime, queues, fence } = fakeRuntime();
    fence.values.set(PRODUCTION_BOOTSTRAP_FENCE_KEY, ATTEMPT);
    for (const queue of Object.values(queues)) queue.isGloballyPaused = true;
    queues.graphRuns.workerCount = 1;
    queues.outreachSend.workerCount = 1;
    queues.graphRuns.workerCount = 0;

    await expect(
      createProductionBootstrapSnapshot(
        runtime,
        ATTEMPT,
        "post-migration",
        1,
        {
          beforeWriterFenceRead: () => undefined,
          expectedDatabaseIdentityHash: FAKE_DATABASE_IDENTITY_HASH,
          workerPosture: "connected",
        },
      ),
    ).rejects.toThrow("graph-runs has no connected worker");
  });

  it("rejects ambiguous delivery and null-source reply inventories", () => {
    const base = {
      databaseIdentityHash: `sha256:${"1".repeat(64)}`,
      sendingRows: 0,
      firstClassDeliveryUnknownRows: 0,
      legacyDeliveryUnknownMarkerRows: 0,
      firstClassFailedRows: 0,
      legacyAutoFailedMarkerRows: 0,
      outreachIdempotencyDuplicateGroups: 0,
      legacyGmailReplySequenceStopRows: 0,
      managerRoleRows: 0,
      graphRunRunningRows: 0,
      graphRunAwaitingApprovalRows: 0,
      graphActiveOrgDuplicateGroups: 0,
      graphActiveWithoutRecoveryStateRows: 0,
      graphLifecycleSchemaReady: true,
      replySourceDuplicateGroups: 0,
      replyConversationDuplicateGroups: 0,
      nullSourceReplyRows: 0,
      replySlotDuplicateRows: 0,
      duplicateInventoryEvidenceHash: `sha256:${"2".repeat(64)}`,
      replySchemaReady: true,
      clerkIdentitySchemaReady: true,
      clerkCutoverRowCount: 1,
      clerkCutoverReady: true,
      clerkMinimumEventVersion: 1786665600000,
      clerkInventoryEvidenceHash: `sha256:${"3".repeat(64)}`,
      clerkExpectedActiveOrganizationCount: 0,
      clerkExpectedActiveMembershipCount: 0,
      clerkExpectedActiveUserCount: 0,
      clerkActiveOrganizationCount: 0,
      clerkActiveMembershipCount: 0,
      clerkActiveUserCount: 0,
      clerkProjectionMismatchRows: 0,
      clerkOrphanActiveAuthorityRows: 0,
      clerkReadinessViolationCount: 0,
    };
    expect(() =>
      assertProductionBootstrapInventoryReady(
        { ...base, sendingRows: 1 },
        "post-migration",
      ),
    ).toThrow("ambiguous outreach inventory");
    expect(() =>
      assertProductionBootstrapInventoryReady(
        { ...base, nullSourceReplyRows: 1 },
        "post-migration",
      ),
    ).toThrow("null-source inventory");
  });

  it("binds Redis endpoint identity without exposing credentials", () => {
    const first = productionBootstrapRedisIdentityHash({
      REDIS_URL: "rediss://worker:secret@redis-a.example:6380/2",
    });
    const sameEndpointDifferentSecret = productionBootstrapRedisIdentityHash({
      REDIS_URL: "rediss://worker:other@redis-a.example:6380/2",
    });
    const otherDatabase = productionBootstrapRedisIdentityHash({
      REDIS_URL: "rediss://worker:secret@redis-a.example:6380/3",
    });
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(first).toBe(sameEndpointDifferentSecret);
    expect(first).not.toBe(otherDatabase);
    expect(first).not.toContain("secret");

    const hostIdentity = productionBootstrapRedisIdentityHash({
      REDIS_HOST: "redis-a.example",
      REDIS_PORT: "6380",
      REDIS_USERNAME: "worker",
      REDIS_PASSWORD: "secret",
    });
    const hostIdentityAfterPasswordRotation =
      productionBootstrapRedisIdentityHash({
        REDIS_HOST: "redis-a.example",
        REDIS_PORT: "6380",
        REDIS_USERNAME: "worker",
        REDIS_PASSWORD: "rotated",
      });
    const otherRedisPrincipal = productionBootstrapRedisIdentityHash({
      REDIS_HOST: "redis-a.example",
      REDIS_PORT: "6380",
      REDIS_USERNAME: "other-worker",
      REDIS_PASSWORD: "secret",
    });
    expect(hostIdentity).toBe(hostIdentityAfterPasswordRotation);
    expect(hostIdentity).not.toBe(otherRedisPrincipal);
    expect(hostIdentity).not.toContain("worker");
  });
});
