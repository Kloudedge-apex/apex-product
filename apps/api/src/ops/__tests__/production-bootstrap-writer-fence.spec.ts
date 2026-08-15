import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import * as ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import {
  armProductionBootstrapWriterFence,
  assertClosedWriterFenceReadback,
  disarmProductionBootstrapWriterFence,
  isClearlyReadOnlyPrismaRawQuery,
  isPrismaWriteOperation,
  parseProductionBootstrapWriterFenceState,
  PRODUCTION_BOOTSTRAP_ACTIVE_COMPLIANCE_WRITERS_KEY,
  PRODUCTION_BOOTSTRAP_ACTIVE_WRITERS_KEY,
  PRODUCTION_BOOTSTRAP_UNCERTAIN_COMPLIANCE_WRITERS_KEY,
  PRODUCTION_BOOTSTRAP_UNCERTAIN_WRITERS_KEY,
  ProductionBootstrapWriterFence,
  ProductionBootstrapWriterFenceClosedError,
  ProductionBootstrapWriterFenceRedis,
  ProductionBootstrapWriterFenceUnavailableError,
  productionBootstrapWriterFenceOptionsFromEnvironment,
  readProductionBootstrapWriterFence,
  recoverProductionBootstrapOrphanedWriterTokens,
  rotateProductionBootstrapWriterFence,
  runWithProductionBootstrapWriterFenceOrSkipClosed,
} from "../production-bootstrap-writer-fence";
import { classifyProductionBootstrapHttpRequest } from "../production-bootstrap-writer-fence.interceptor";
import { PrismaService } from "../../prisma/prisma.service";
import type { ProductionBootstrapWriterFenceService } from "../production-bootstrap-writer-fence";

const ATTEMPT = "0123456789abcdef0123456789abcdef";

class FakeRedis implements ProductionBootstrapWriterFenceRedis {
  readonly strings = new Map<string, string>();
  readonly sortedSets = new Map<string, Map<string, number>>();
  readonly sets = new Map<string, Set<string>>();
  serverNowMs = Date.parse("2026-08-14T03:00:00Z");
  fail = false;

  async eval(
    script: string,
    numberOfKeys: number,
    ...args: Array<string | number>
  ): Promise<unknown> {
    if (this.fail) throw new Error("redis unavailable");
    const keys = args.slice(0, numberOfKeys).map(String);
    const argv = args.slice(numberOfKeys).map(String);

    if (script.includes("WRITER_FENCE_RECOVER_ORPHANS_V1")) {
      const generation = this.strings.get(keys[1]) ?? "0";
      if (generation !== argv[1]) {
        return ["GENERATION_MISMATCH", generation];
      }
      const raw = this.strings.get(keys[0]);
      if (raw) {
        let epoch: Record<string, unknown>;
        try {
          epoch = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          return ["INVALID_STATE"];
        }
        if (
          epoch.schemaVersion !== 1 ||
          epoch.target !== "workforce-os-production" ||
          String(epoch.generation) !== generation ||
          epoch.bootstrapAttemptId !== argv[0] ||
          (epoch.mode !== "closed" && epoch.mode !== "open")
        ) {
          return ["INVALID_STATE"];
        }
        if (epoch.mode === "open") return ["TERMINAL_OPEN"];
      } else if (generation !== "0") {
        return ["INVALID_STATE"];
      }
      const activeApplication = [...this.sortedSet(keys[2]).keys()].sort();
      const activeCompliance = [...this.sortedSet(keys[3]).keys()].sort();
      const uncertainApplication = [...this.set(keys[4])].sort();
      const uncertainCompliance = [...this.set(keys[5])].sort();
      this.sortedSets.delete(keys[2]);
      this.sortedSets.delete(keys[3]);
      this.sets.delete(keys[4]);
      this.sets.delete(keys[5]);
      return [
        "OK",
        String(Math.floor(this.serverNowMs / 1_000)),
        String((this.serverNowMs % 1_000) * 1_000),
        generation,
        raw ?? "",
        activeApplication,
        activeCompliance,
        uncertainApplication,
        uncertainCompliance,
      ];
    }
    if (script.includes("WRITER_FENCE_ACQUIRE_COMPLIANCE_V1")) {
      this.quarantineExpired(keys[2], keys[3]);
      const generation = this.strings.get(keys[1]) ?? "0";
      const raw = this.strings.get(keys[0]);
      const epoch = this.epoch(raw, generation, argv[2], argv[3]);
      if (epoch === undefined) return ["INVALID_STATE", generation];
      this.sortedSet(keys[2]).set(argv[0], this.serverNowMs + Number(argv[1]));
      return ["OK", generation, raw ?? ""];
    }
    if (script.includes("WRITER_FENCE_ACQUIRE_V1")) {
      this.quarantineExpired(keys[2], keys[3]);
      const generation = this.strings.get(keys[1]) ?? "0";
      const raw = this.strings.get(keys[0]);
      const epoch = this.epoch(raw, generation, argv[2], argv[3]);
      if (epoch === undefined) return ["INVALID_STATE", generation];
      if (epoch?.mode === "closed") return ["CLOSED", raw];
      this.sortedSet(keys[2]).set(argv[0], this.serverNowMs + Number(argv[1]));
      return ["OK", generation, raw ?? ""];
    }
    if (script.includes("WRITER_FENCE_HEARTBEAT_COMPLIANCE_V1")) {
      const raw = this.strings.get(keys[0]);
      if (this.epoch(raw, argv[2], argv[3], argv[4]) === undefined) {
        return "INVALID_STATE";
      }
      const active = this.sortedSet(keys[1]);
      const score = active.get(argv[0]);
      if (score === undefined) return "LOST";
      if (score <= this.serverNowMs) {
        active.delete(argv[0]);
        this.set(keys[2]).add(argv[0]);
        return "LOST";
      }
      active.set(argv[0], this.serverNowMs + Number(argv[1]));
      return "OK";
    }
    if (script.includes("WRITER_FENCE_HEARTBEAT_V1")) {
      const raw = this.strings.get(keys[0]);
      const epoch = this.epoch(raw, argv[2], argv[3], argv[4]);
      if (epoch === undefined) return "INVALID_STATE";
      if (epoch?.mode === "closed") return "CLOSED";
      const active = this.sortedSet(keys[1]);
      const score = active.get(argv[0]);
      if (score === undefined) return "LOST";
      if (score <= this.serverNowMs) {
        active.delete(argv[0]);
        this.set(keys[2]).add(argv[0]);
        return "LOST";
      }
      active.set(argv[0], this.serverNowMs + Number(argv[1]));
      return "OK";
    }
    if (script.includes("WRITER_FENCE_RELEASE_V1")) {
      const active = this.sortedSet(keys[0]).delete(argv[0]) ? 1 : 0;
      const uncertain = this.set(keys[1]).delete(argv[0]) ? 1 : 0;
      return active + uncertain;
    }
    if (script.includes("WRITER_FENCE_ARM_V1")) {
      this.quarantineExpired(keys[2], keys[4]);
      this.quarantineExpired(keys[3], keys[5]);
      const state = this.strings.get(keys[0]);
      if (state) {
        const generation = this.strings.get(keys[1]) ?? "0";
        const epoch = this.epoch(state, generation, "", "0");
        if (epoch === undefined) return ["INVALID_STATE"];
        if (epoch?.mode === "closed") return ["STATE_PRESENT", state];
        return ["OPEN_TERMINAL", state];
      }
      const current = Number(this.strings.get(keys[1]) ?? "0");
      const requested = Number(argv[0]);
      if (requested <= current) return ["STALE_GENERATION", String(current)];
      const active = this.sortedSet(keys[2]).size + this.set(keys[4]).size;
      const compliance = this.sortedSet(keys[3]).size + this.set(keys[5]).size;
      if (active !== 0 || compliance !== 0) {
        return ["ACTIVE_WRITERS", String(active), String(compliance)];
      }
      this.strings.set(keys[1], argv[0]);
      this.strings.set(keys[0], argv[1]);
      return ["OK", argv[0]];
    }
    if (script.includes("WRITER_FENCE_ROTATE_V1")) {
      this.quarantineExpired(keys[2], keys[4]);
      this.quarantineExpired(keys[3], keys[5]);
      const raw = this.strings.get(keys[0]);
      if (!raw) return ["ABSENT"];
      let state: Record<string, unknown>;
      try {
        state = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return ["INVALID_STATE"];
      }
      if (
        state.target !== argv[0] ||
        state.bootstrapAttemptId !== argv[1] ||
        String(state.generation) !== argv[2]
      ) {
        return ["MISMATCH"];
      }
      const stored = Number(this.strings.get(keys[1]) ?? "-1");
      const current = Number(argv[2]);
      const next = Number(argv[3]);
      if (stored !== current) return ["INVALID_STATE"];
      if (next <= current) return ["STALE_GENERATION", String(stored)];
      const active = this.sortedSet(keys[2]).size + this.set(keys[4]).size;
      const compliance = this.sortedSet(keys[3]).size + this.set(keys[5]).size;
      if (active || compliance) {
        return ["ACTIVE_WRITERS", String(active), String(compliance)];
      }
      this.strings.set(keys[1], argv[3]);
      this.strings.set(keys[0], argv[4]);
      return ["OK", argv[3]];
    }
    if (script.includes("WRITER_FENCE_DISARM_V1")) {
      this.quarantineExpired(keys[2], keys[4]);
      this.quarantineExpired(keys[3], keys[5]);
      const raw = this.strings.get(keys[0]);
      if (!raw) return ["ABSENT"];
      let state: Record<string, unknown>;
      try {
        state = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return ["INVALID_STATE"];
      }
      if (
        state.target !== argv[0] ||
        state.bootstrapAttemptId !== argv[1] ||
        String(state.generation) !== argv[2]
      ) {
        return ["MISMATCH"];
      }
      if ((this.strings.get(keys[1]) ?? "") !== argv[2]) {
        return ["INVALID_STATE"];
      }
      if (state.mode === "open") return ["OK"];
      if (state.mode !== "closed") return ["INVALID_STATE"];
      const active = this.sortedSet(keys[2]).size + this.set(keys[4]).size;
      const compliance = this.sortedSet(keys[3]).size + this.set(keys[5]).size;
      if (active || compliance) {
        return [
          "ACTIVE_WRITERS",
          String(active),
          String(compliance),
        ];
      }
      this.strings.set(keys[0], argv[3]);
      return ["OK"];
    }
    if (script.includes("WRITER_FENCE_READ_V1")) {
      this.quarantineExpired(keys[2], keys[4]);
      this.quarantineExpired(keys[3], keys[5]);
      return [
        this.strings.get(keys[0]) ?? "",
        this.strings.get(keys[1]) ?? "0",
        String(this.sortedSet(keys[2]).size + this.set(keys[4]).size),
        String(this.sortedSet(keys[3]).size + this.set(keys[5]).size),
        String(Math.floor(this.serverNowMs / 1_000)),
      ];
    }
    throw new Error("unknown script");
  }

  private sortedSet(key: string): Map<string, number> {
    let value = this.sortedSets.get(key);
    if (!value) {
      value = new Map();
      this.sortedSets.set(key, value);
    }
    return value;
  }

  private set(key: string): Set<string> {
    let value = this.sets.get(key);
    if (!value) {
      value = new Set();
      this.sets.set(key, value);
    }
    return value;
  }

  private quarantineExpired(activeKey: string, uncertainKey: string): void {
    const values = this.sortedSet(activeKey);
    for (const [member, expiresAt] of values) {
      if (expiresAt <= this.serverNowMs) {
        values.delete(member);
        this.set(uncertainKey).add(member);
      }
    }
  }

  private epoch(
    raw: string | undefined,
    generation: string,
    guardedAttempt: string,
    minimumGeneration: string,
  ): Record<string, unknown> | null | undefined {
    if (!raw) {
      return guardedAttempt === "" && generation === "0" ? null : undefined;
    }
    let epoch: Record<string, unknown>;
    try {
      epoch = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return undefined;
    }
    if (
      epoch.schemaVersion !== 1 ||
      epoch.target !== "workforce-os-production" ||
      String(epoch.generation) !== generation ||
      (epoch.mode !== "open" && epoch.mode !== "closed") ||
      (guardedAttempt !== "" && epoch.bootstrapAttemptId !== guardedAttempt) ||
      Number(generation) < Number(minimumGeneration)
    ) {
      return undefined;
    }
    return epoch;
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("production bootstrap writer fence", () => {
  it("atomically refuses to close while an application writer is active", async () => {
    const redis = new FakeRedis();
    const now = new Date("2026-08-14T03:00:00.000Z");
    const fence = new ProductionBootstrapWriterFence(redis, {
      production: false,
      now: () => now,
      leaseMs: 60_000,
      heartbeatMs: 5_000,
    });
    const release = deferred<void>();
    const started = deferred<void>();
    const writer = fence.runWriter("http", async () => {
      started.resolve();
      await release.promise;
      return "done";
    });
    await started.promise;

    const active = await readProductionBootstrapWriterFence(redis);
    expect(active.activeWriters).toBe(1);
    expect(active.writerZero).toBe(false);
    await expect(
      armProductionBootstrapWriterFence(redis, {
        bootstrapAttemptId: ATTEMPT,
        generation: 1,
        issuedAt: now,
        expiresAt: new Date(now.getTime() + 60_000),
      }),
    ).rejects.toThrow("active writers");

    release.resolve();
    await expect(writer).resolves.toBe("done");
    expect(
      (await readProductionBootstrapWriterFence(redis)).writerZero,
    ).toBe(true);
  });

  it("uses Redis server time so behind and ahead clients cannot erase a live lease", async () => {
    const redis = new FakeRedis();
    redis.serverNowMs = Date.parse("2026-08-14T03:00:00Z");
    const behindClient = new ProductionBootstrapWriterFence(redis, {
      production: false,
      now: () => new Date("2001-01-01T00:00:00Z"),
      leaseMs: 60_000,
      heartbeatMs: 5_000,
    });
    const release = deferred<void>();
    const started = deferred<void>();
    const writer = behindClient.runWriter("http", async () => {
      started.resolve();
      await release.promise;
    });
    await started.promise;

    const active = await readProductionBootstrapWriterFence(redis);
    expect(active.observedAt).toBe("2026-08-14T03:00:00Z");
    expect(active.activeWriters).toBe(1);
    await expect(
      armProductionBootstrapWriterFence(redis, {
        bootstrapAttemptId: ATTEMPT,
        generation: 1,
        issuedAt: new Date("2099-01-01T00:00:00Z"),
        expiresAt: new Date("2099-01-01T00:10:00Z"),
      }),
    ).rejects.toThrow("active writers");

    release.resolve();
    await writer;
  });

  it("quarantines an expired root until its late effect actually settles", async () => {
    const redis = new FakeRedis();
    const fence = new ProductionBootstrapWriterFence(redis, {
      production: false,
      leaseMs: 30_000,
      heartbeatMs: 5_000,
    });
    const releaseEffect = deferred<void>();
    const effectStarted = deferred<void>();
    const writer = fence.runWriter("http", async () => {
      effectStarted.resolve();
      await releaseEffect.promise;
      return "committed";
    });
    await effectStarted.promise;

    redis.serverNowMs += 30_001;
    expect((await readProductionBootstrapWriterFence(redis)).activeWriters).toBe(1);
    await expect(
      armProductionBootstrapWriterFence(redis, {
        bootstrapAttemptId: ATTEMPT,
        generation: 1,
        issuedAt: new Date(redis.serverNowMs),
        expiresAt: new Date(redis.serverNowMs + 60_000),
      }),
    ).rejects.toThrow("active writers");

    releaseEffect.resolve();
    await expect(writer).resolves.toBe("committed");
    expect((await readProductionBootstrapWriterFence(redis)).writerZero).toBe(true);
  });

  it("requires an exact stable-zero attestation for orphan-token recovery", async () => {
    const redis = new FakeRedis();
    await expect(
      recoverProductionBootstrapOrphanedWriterTokens(redis, {
        bootstrapAttemptId: ATTEMPT,
        expectedGeneration: 0,
        stableZeroEvidenceHash: `sha256:${"0".repeat(64)}`,
        ingressDisabled: true,
        queuesPausedAndDrained: true,
        apiReplicaCount: 0,
        workerReplicaCount: 1,
      } as never),
    ).rejects.toThrow("stable-zero API/worker replicas");
  });

  it("atomically recovers only proof-bound orphan tokens and returns hashed evidence", async () => {
    const redis = new FakeRedis();
    redis.sortedSets.set(
      PRODUCTION_BOOTSTRAP_ACTIVE_WRITERS_KEY,
      new Map([["application-token", redis.serverNowMs + 60_000]]),
    );
    redis.sortedSets.set(
      PRODUCTION_BOOTSTRAP_ACTIVE_COMPLIANCE_WRITERS_KEY,
      new Map([["compliance-token", redis.serverNowMs + 60_000]]),
    );
    redis.sets.set(
      PRODUCTION_BOOTSTRAP_UNCERTAIN_WRITERS_KEY,
      new Set(["uncertain-application-token"]),
    );
    redis.sets.set(
      PRODUCTION_BOOTSTRAP_UNCERTAIN_COMPLIANCE_WRITERS_KEY,
      new Set(["uncertain-compliance-token"]),
    );

    const evidence = await recoverProductionBootstrapOrphanedWriterTokens(
      redis,
      {
        bootstrapAttemptId: ATTEMPT,
        expectedGeneration: 0,
        stableZeroEvidenceHash: `sha256:${"a".repeat(64)}`,
        ingressDisabled: true,
        queuesPausedAndDrained: true,
        apiReplicaCount: 0,
        workerReplicaCount: 0,
      },
    );

    expect(evidence).toMatchObject({
      bootstrapAttemptId: ATTEMPT,
      generation: 0,
      stableZeroEvidenceHash: `sha256:${"a".repeat(64)}`,
      pre: {
        activeApplicationWriters: 1,
        activeComplianceWriters: 1,
        uncertainApplicationWriters: 1,
        uncertainComplianceWriters: 1,
      },
      post: {
        activeApplicationWriters: 0,
        activeComplianceWriters: 0,
        uncertainApplicationWriters: 0,
        uncertainComplianceWriters: 0,
      },
    });
    expect(evidence.pre.tokenSetHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(evidence.post.tokenSetHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(evidence.pre.tokenSetHash).not.toBe(evidence.post.tokenSetHash);
    expect((await readProductionBootstrapWriterFence(redis)).writerZero).toBe(true);
  });

  it("allows exact CLOSED recovery but forbids recovery after terminal OPEN", async () => {
    const redis = new FakeRedis();
    const now = new Date("2026-08-14T03:00:00Z");
    await armProductionBootstrapWriterFence(redis, {
      bootstrapAttemptId: ATTEMPT,
      generation: 3,
      issuedAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
    });
    redis.sets.set(
      PRODUCTION_BOOTSTRAP_UNCERTAIN_WRITERS_KEY,
      new Set(["killed-process-token"]),
    );
    const attestation = {
      bootstrapAttemptId: ATTEMPT,
      expectedGeneration: 3,
      stableZeroEvidenceHash: `sha256:${"b".repeat(64)}`,
      ingressDisabled: true as const,
      queuesPausedAndDrained: true as const,
      apiReplicaCount: 0 as const,
      workerReplicaCount: 0 as const,
    };
    await expect(
      recoverProductionBootstrapOrphanedWriterTokens(redis, attestation),
    ).resolves.toMatchObject({
      generation: 3,
      pre: { uncertainApplicationWriters: 1 },
    });

    await disarmProductionBootstrapWriterFence(redis, {
      bootstrapAttemptId: ATTEMPT,
      generation: 3,
      observedAt: now,
    });
    await expect(
      recoverProductionBootstrapOrphanedWriterTokens(redis, attestation),
    ).rejects.toThrow("forbidden after terminal OPEN");
  });

  it("keeps the root token until detached nested writes settle and handles rejection", async () => {
    const redis = new FakeRedis();
    const fence = new ProductionBootstrapWriterFence(redis, {
      production: false,
      leaseMs: 60_000,
      heartbeatMs: 5_000,
    });
    const releaseNested = deferred<void>();
    const outerReturned = deferred<void>();
    const nestedStarted = deferred<void>();
    const writer = fence.runWriter("http", async () => {
      void fence.runDatabaseWrite("EvidenceEvent", "create", async () => {
        nestedStarted.resolve();
        await releaseNested.promise;
        throw new Error("best-effort evidence failed");
      });
      outerReturned.resolve();
      return "outer-result";
    });
    await outerReturned.promise;
    await nestedStarted.promise;

    expect((await readProductionBootstrapWriterFence(redis)).activeWriters).toBe(1);
    let settled = false;
    void writer.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseNested.resolve();
    await expect(writer).resolves.toBe("outer-result");
    expect((await readProductionBootstrapWriterFence(redis)).writerZero).toBe(true);
  });

  it("binds closure to target, attempt, generation, and expiry without expiring open", async () => {
    const redis = new FakeRedis();
    const issuedAt = new Date("2026-08-14T03:00:00.123Z");
    const expiresAt = new Date("2026-08-14T03:10:00.456Z");
    await armProductionBootstrapWriterFence(redis, {
      bootstrapAttemptId: ATTEMPT,
      generation: 7,
      issuedAt,
      expiresAt,
    });

    redis.serverNowMs = Date.parse("2026-08-14T03:05:00.789Z");
    const readback = await readProductionBootstrapWriterFence(redis);
    expect(readback.state).toMatchObject({
      target: "workforce-os-production",
      bootstrapAttemptId: ATTEMPT,
      generation: 7,
      issuedAt: "2026-08-14T03:00:00Z",
      expiresAt: "2026-08-14T03:10:00Z",
    });
    expect(readback.observedAt).toBe("2026-08-14T03:05:00Z");
    expect(readback.stateHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(() =>
      assertClosedWriterFenceReadback(readback, {
        bootstrapAttemptId: ATTEMPT,
        generation: 7,
      }),
    ).not.toThrow();

    redis.serverNowMs = Date.parse("2026-08-14T03:20:00.000Z");
    const fence = new ProductionBootstrapWriterFence(redis, {
      production: true,
      bootstrapAttemptId: ATTEMPT,
      minimumGeneration: 7,
      now: () => new Date("2026-08-14T03:20:00.000Z"),
      leaseMs: 60_000,
      heartbeatMs: 5_000,
    });
    await expect(fence.runWriter("http", async () => undefined)).rejects.toBeInstanceOf(
      ProductionBootstrapWriterFenceClosedError,
    );
    const expired = await fence.readback();
    expect(expired.state).not.toBeNull();
    expect(() =>
      assertClosedWriterFenceReadback(expired, {
        bootstrapAttemptId: ATTEMPT,
        generation: 7,
      }),
    ).toThrow("expired");
  });

  it("allows only the exact unsubscribe model writes while closed and tracks them", async () => {
    const redis = new FakeRedis();
    const now = new Date("2026-08-14T03:00:00.000Z");
    await armProductionBootstrapWriterFence(redis, {
      bootstrapAttemptId: ATTEMPT,
      generation: 1,
      issuedAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
    });
    const fence = new ProductionBootstrapWriterFence(redis, {
      production: true,
      bootstrapAttemptId: ATTEMPT,
      minimumGeneration: 1,
      now: () => now,
      leaseMs: 60_000,
      heartbeatMs: 5_000,
    });
    const hold = deferred<void>();
    const started = deferred<void>();
    const compliance = fence.runComplianceWriter(async () => {
      await fence.runDatabaseWrite("OutreachSuppression", "create", async () => {
        started.resolve();
        await hold.promise;
      });
      await expect(
        fence.runDatabaseWrite("User", "update", async () => undefined),
      ).rejects.toBeInstanceOf(ProductionBootstrapWriterFenceClosedError);
    });
    await started.promise;
    expect(
      (await readProductionBootstrapWriterFence(redis))
        .activeComplianceWriters,
    ).toBe(1);
    hold.resolve();
    await compliance;
    expect(
      (await readProductionBootstrapWriterFence(redis)).writerZero,
    ).toBe(true);
  });

  it("fails closed on Redis uncertainty in production", async () => {
    const redis = new FakeRedis();
    redis.fail = true;
    const fence = new ProductionBootstrapWriterFence(redis, {
      production: true,
      bootstrapAttemptId: ATTEMPT,
      minimumGeneration: 1,
      leaseMs: 60_000,
      heartbeatMs: 5_000,
    });
    await expect(fence.runWriter("database", async () => "unsafe")).rejects.toBeInstanceOf(
      ProductionBootstrapWriterFenceUnavailableError,
    );
    await expect(fence.runComplianceWriter(async () => "unsafe")).rejects.toBeInstanceOf(
      ProductionBootstrapWriterFenceUnavailableError,
    );
    await expect(fence.readback()).rejects.toBeInstanceOf(
      ProductionBootstrapWriterFenceUnavailableError,
    );
  });

  it("turns only an intentional CLOSED background probe into a skip", async () => {
    const operation = vi.fn(async () => "ran");
    const closedFence = {
      runWriter: vi.fn(async () => {
        throw new ProductionBootstrapWriterFenceClosedError();
      }),
    } as unknown as ProductionBootstrapWriterFenceService;
    await expect(
      runWithProductionBootstrapWriterFenceOrSkipClosed(
        closedFence,
        "recovery",
        operation,
      ),
    ).resolves.toEqual({ ran: false });
    expect(operation).not.toHaveBeenCalled();

    const unavailableFence = {
      runWriter: vi.fn(async () => {
        throw new ProductionBootstrapWriterFenceUnavailableError();
      }),
    } as unknown as ProductionBootstrapWriterFenceService;
    await expect(
      runWithProductionBootstrapWriterFenceOrSkipClosed(
        unavailableFence,
        "recovery",
        operation,
      ),
    ).rejects.toBeInstanceOf(ProductionBootstrapWriterFenceUnavailableError);
  });

  it("requires monotonic generations and exact disarm identity", async () => {
    const redis = new FakeRedis();
    const now = new Date("2026-08-14T03:00:00.000Z");
    await armProductionBootstrapWriterFence(redis, {
      bootstrapAttemptId: ATTEMPT,
      generation: 2,
      issuedAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
    });
    await expect(
      disarmProductionBootstrapWriterFence(redis, {
        bootstrapAttemptId: "ffffffffffffffffffffffffffffffff",
        generation: 2,
        observedAt: now,
      }),
    ).rejects.toThrow("does not match");
    await disarmProductionBootstrapWriterFence(redis, {
      bootstrapAttemptId: ATTEMPT,
      generation: 2,
      observedAt: now,
    });
    await expect(
      armProductionBootstrapWriterFence(redis, {
        bootstrapAttemptId: ATTEMPT,
        generation: 2,
        issuedAt: now,
        expiresAt: new Date(now.getTime() + 60_000),
      }),
    ).rejects.toThrow("terminally open");
    await expect(
      disarmProductionBootstrapWriterFence(redis, {
        bootstrapAttemptId: ATTEMPT,
        generation: 2,
        observedAt: now,
      }),
    ).resolves.toBeUndefined();
  });

  it("requires a guarded candidate epoch and fails closed after Redis key loss", async () => {
    const redis = new FakeRedis();
    const issuedAt = new Date("2026-08-14T03:00:00Z");
    await armProductionBootstrapWriterFence(redis, {
      bootstrapAttemptId: ATTEMPT,
      generation: 7,
      issuedAt,
      expiresAt: new Date("2026-08-14T03:10:00Z"),
    });
    await disarmProductionBootstrapWriterFence(redis, {
      bootstrapAttemptId: ATTEMPT,
      generation: 7,
      observedAt: issuedAt,
    });
    const open = await readProductionBootstrapWriterFence(redis);
    expect(open.state).toBeNull();
    expect(open.generation).toBe(7);
    expect(open.stateHash).toMatch(/^sha256:[0-9a-f]{64}$/);

    const guarded = new ProductionBootstrapWriterFence(redis, {
      production: true,
      bootstrapAttemptId: ATTEMPT,
      minimumGeneration: 7,
      leaseMs: 60_000,
      heartbeatMs: 5_000,
    });
    await expect(guarded.runWriter("http", async () => "open")).resolves.toBe(
      "open",
    );

    redis.strings.clear();
    await expect(
      guarded.runWriter("http", async () => "must-not-open"),
    ).rejects.toBeInstanceOf(ProductionBootstrapWriterFenceUnavailableError);
  });

  it("validates the immutable candidate deployment guard environment", () => {
    expect(
      productionBootstrapWriterFenceOptionsFromEnvironment({
        NODE_ENV: "production",
        WORKFORCE_PRODUCTION_BOOTSTRAP_ATTEMPT_ID: ATTEMPT,
        WORKFORCE_PRODUCTION_BOOTSTRAP_MIN_WRITER_FENCE_GENERATION: "9",
      }),
    ).toEqual({
      production: true,
      bootstrapAttemptId: ATTEMPT,
      minimumGeneration: 9,
    });
    expect(() =>
      productionBootstrapWriterFenceOptionsFromEnvironment({
        NODE_ENV: "production",
        WORKFORCE_PRODUCTION_BOOTSTRAP_ATTEMPT_ID: ATTEMPT,
      }),
    ).toThrow("incomplete");
  });

  it("atomically rotates an expired closed fence without an open interval", async () => {
    const redis = new FakeRedis();
    const firstIssuedAt = new Date("2026-08-14T03:00:00Z");
    await armProductionBootstrapWriterFence(redis, {
      bootstrapAttemptId: ATTEMPT,
      generation: 1,
      issuedAt: firstIssuedAt,
      expiresAt: new Date("2026-08-14T03:01:00Z"),
    });
    const rotationTime = new Date("2026-08-14T03:05:00Z");
    redis.serverNowMs = rotationTime.getTime();

    await expect(
      rotateProductionBootstrapWriterFence(redis, {
        bootstrapAttemptId: "ffffffffffffffffffffffffffffffff",
        currentGeneration: 1,
        nextGeneration: 2,
        issuedAt: rotationTime,
        expiresAt: new Date("2026-08-14T03:15:00Z"),
      }),
    ).rejects.toThrow("identity");
    await expect(
      rotateProductionBootstrapWriterFence(redis, {
        bootstrapAttemptId: ATTEMPT,
        currentGeneration: 1,
        nextGeneration: 1,
        issuedAt: rotationTime,
        expiresAt: new Date("2026-08-14T03:15:00Z"),
      }),
    ).rejects.toThrow("strictly advance");

    redis.sortedSets.set(
      PRODUCTION_BOOTSTRAP_ACTIVE_WRITERS_KEY,
      new Map([["stale-application-writer", rotationTime.getTime() + 60_000]]),
    );
    await expect(
      rotateProductionBootstrapWriterFence(redis, {
        bootstrapAttemptId: ATTEMPT,
        currentGeneration: 1,
        nextGeneration: 2,
        issuedAt: rotationTime,
        expiresAt: new Date("2026-08-14T03:15:00Z"),
      }),
    ).rejects.toThrow("active writers");
    redis.sortedSets.get(PRODUCTION_BOOTSTRAP_ACTIVE_WRITERS_KEY)?.clear();

    const complianceFence = new ProductionBootstrapWriterFence(redis, {
      production: true,
      bootstrapAttemptId: ATTEMPT,
      minimumGeneration: 1,
      now: () => rotationTime,
      leaseMs: 60_000,
      heartbeatMs: 5_000,
    });
    const releaseCompliance = deferred<void>();
    const complianceStarted = deferred<void>();
    const compliance = complianceFence.runComplianceWriter(async () => {
      complianceStarted.resolve();
      await releaseCompliance.promise;
    });
    await complianceStarted.promise;
    await expect(
      rotateProductionBootstrapWriterFence(redis, {
        bootstrapAttemptId: ATTEMPT,
        currentGeneration: 1,
        nextGeneration: 2,
        issuedAt: rotationTime,
        expiresAt: new Date("2026-08-14T03:15:00Z"),
      }),
    ).rejects.toThrow("active writers");
    releaseCompliance.resolve();
    await compliance;

    const rotated = await rotateProductionBootstrapWriterFence(redis, {
      bootstrapAttemptId: ATTEMPT,
      currentGeneration: 1,
      nextGeneration: 2,
      issuedAt: rotationTime,
      expiresAt: new Date("2026-08-14T03:15:00Z"),
    });
    expect(rotated).toMatchObject({
      bootstrapAttemptId: ATTEMPT,
      generation: 2,
      issuedAt: "2026-08-14T03:05:00Z",
      expiresAt: "2026-08-14T03:15:00Z",
    });
    const readback = await readProductionBootstrapWriterFence(redis);
    expect(readback.generation).toBe(2);
    expect(readback.state).toEqual(rotated);

    const fence = new ProductionBootstrapWriterFence(redis, {
      production: true,
      bootstrapAttemptId: ATTEMPT,
      minimumGeneration: 2,
      now: () => rotationTime,
      leaseMs: 60_000,
      heartbeatMs: 5_000,
    });
    await expect(
      fence.runWriter("http", async () => "must-not-run"),
    ).rejects.toBeInstanceOf(ProductionBootstrapWriterFenceClosedError);
  });

  it("rejects malformed state and classifies every Prisma mutation", () => {
    expect(() =>
      parseProductionBootstrapWriterFenceState(
        JSON.stringify({
          schemaVersion: 1,
          target: "staging",
          mode: "closed",
          bootstrapAttemptId: ATTEMPT,
          generation: 1,
          issuedAt: "2026-08-14T03:00:00.000Z",
          expiresAt: "2026-08-14T03:01:00.000Z",
        }),
      ),
    ).toThrow("target");
    expect(() =>
      parseProductionBootstrapWriterFenceState(
        JSON.stringify({
          schemaVersion: 1,
          target: "workforce-os-production",
          mode: "closed",
          bootstrapAttemptId: ATTEMPT,
          generation: 1,
          issuedAt: "2026-08-14T03:00:00.000Z",
          expiresAt: "2026-08-14T03:01:00Z",
        }),
      ),
    ).toThrow("UTC-seconds");
    for (const operation of [
      "create",
      "createMany",
      "createManyAndReturn",
      "update",
      "updateMany",
      "updateManyAndReturn",
      "upsert",
      "delete",
      "deleteMany",
    ]) {
      expect(isPrismaWriteOperation(operation)).toBe(true);
    }
    for (const operation of [
      "findUnique",
      "findUniqueOrThrow",
      "findFirst",
      "findFirstOrThrow",
      "findMany",
      "aggregate",
      "count",
      "groupBy",
    ]) {
      expect(isPrismaWriteOperation(operation)).toBe(false);
    }
    expect(isPrismaWriteOperation("futureMutation")).toBe(true);
    expect(
      isClearlyReadOnlyPrismaRawQuery({
        strings: ["SELECT COUNT(*) FROM \"User\" WHERE id = ", ""],
        values: ["user_1"],
      }),
    ).toBe(true);
    expect(
      isClearlyReadOnlyPrismaRawQuery({
        strings: ["WITH removed AS (DELETE FROM \"User\" RETURNING *) SELECT * FROM removed"],
        values: [],
      }),
    ).toBe(false);
    expect(
      isClearlyReadOnlyPrismaRawQuery({ strings: ["SELECT 1; DELETE FROM \"User\""], values: [] }),
    ).toBe(false);
    expect(isClearlyReadOnlyPrismaRawQuery(["SELECT 1"], true)).toBe(false);
  });

  it("preserves Prisma lifecycle hooks and invokes connect/disconnect", async () => {
    const prisma = new PrismaService(undefined);
    const connect = vi.fn(async () => undefined);
    const disconnect = vi.fn(async () => undefined);
    Object.defineProperty(prisma, "$connect", {
      configurable: true,
      value: connect,
    });
    Object.defineProperty(prisma, "$disconnect", {
      configurable: true,
      value: disconnect,
    });

    expect(prisma.constructor.name).toBe("PrismaService");
    expect(typeof prisma.onModuleInit).toBe("function");
    expect(typeof prisma.onModuleDestroy).toBe("function");
    await prisma.onModuleInit();
    await prisma.onModuleDestroy();
    expect(connect).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("enforces the fence through Prisma models, transactions, and every raw-write surface", async () => {
    const redis = new FakeRedis();
    const now = new Date("2026-08-14T03:00:00.000Z");
    await armProductionBootstrapWriterFence(redis, {
      bootstrapAttemptId: ATTEMPT,
      generation: 1,
      issuedAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
    });
    const fence = new ProductionBootstrapWriterFence(redis, {
      production: true,
      bootstrapAttemptId: ATTEMPT,
      minimumGeneration: 1,
      now: () => now,
      leaseMs: 60_000,
      heartbeatMs: 5_000,
    });
    const prisma = new PrismaService(
      fence as unknown as ProductionBootstrapWriterFenceService,
    );

    await expect(
      prisma.user.create({
        data: {
          email: "blocked@example.invalid",
          name: "Blocked",
          org: {
            create: {
              name: "Blocked",
              slug: "blocked-writer-fence",
            },
          },
        },
      }),
    ).rejects.toBeInstanceOf(ProductionBootstrapWriterFenceClosedError);
    await expect(prisma.$executeRaw`SELECT 1`).rejects.toBeInstanceOf(
      ProductionBootstrapWriterFenceClosedError,
    );
    await expect(prisma.$executeRawUnsafe("SELECT 1")).rejects.toBeInstanceOf(
      ProductionBootstrapWriterFenceClosedError,
    );
    await expect(prisma.$queryRaw`DELETE FROM "User"`).rejects.toBeInstanceOf(
      ProductionBootstrapWriterFenceClosedError,
    );
    await expect(prisma.$queryRawUnsafe("DELETE FROM \"User\"")).rejects.toBeInstanceOf(
      ProductionBootstrapWriterFenceClosedError,
    );
    await expect(
      prisma.$transaction(async (tx) => tx.user.deleteMany()),
    ).rejects.toBeInstanceOf(ProductionBootstrapWriterFenceClosedError);
    await expect(
      prisma.$transaction([prisma.user.deleteMany()]),
    ).rejects.toBeInstanceOf(ProductionBootstrapWriterFenceClosedError);
    await prisma.$disconnect();
  });
});

describe("production bootstrap HTTP classification", () => {
  it("keeps pure reads and auth reads available", () => {
    expect(classifyProductionBootstrapHttpRequest("GET", "/api/health/ready")).toBe(
      "read",
    );
    expect(classifyProductionBootstrapHttpRequest("GET", "/api/auth/me")).toBe(
      "read",
    );
    expect(classifyProductionBootstrapHttpRequest("GET", "/api/orgs/me")).toBe(
      "read",
    );
    expect(classifyProductionBootstrapHttpRequest("GET", "/api/leads?limit=10")).toBe(
      "read",
    );
  });

  it("tracks unsubscribe separately and treats side-effectful GETs as writers", () => {
    for (const [method, path] of [
      ["GET", `/api/u/${ATTEMPT}`],
      ["GET", `/api/u/${ATTEMPT}/`],
      ["GET", `/API/U/${ATTEMPT}`],
      ["GET", `/api/u/${ATTEMPT}/post`],
      ["GET", `/api/u/${ATTEMPT}/PoSt/`],
      ["HEAD", `/api/u/${ATTEMPT}`],
      ["HEAD", `/API/U/${ATTEMPT}/POST/`],
      ["POST", `/api/u/${ATTEMPT}`],
      ["POST", `/API/U/${ATTEMPT}/`],
    ] as const) {
      expect(
        classifyProductionBootstrapHttpRequest(method, path),
        `${method} ${path}`,
      ).toBe("unsubscribe");
    }
    for (const [method, path] of [
      ["POST", `/api/u/${ATTEMPT}/post`],
      ["GET", `/api/u/${ATTEMPT}/post/extra`],
      ["GET", `/api/u/${ATTEMPT}//`],
    ] as const) {
      expect(
        classifyProductionBootstrapHttpRequest(method, path),
        `${method} ${path}`,
      ).toBe("writer");
    }
    expect(
      classifyProductionBootstrapHttpRequest(
        "GET",
        "/api/integrations/gmail/auth-url",
      ),
    ).toBe("writer");
    expect(
      classifyProductionBootstrapHttpRequest("GET", "/api/agents/templates"),
    ).toBe("writer");
    expect(classifyProductionBootstrapHttpRequest("GET", "/api/billing")).toBe(
      "writer",
    );
    expect(
      classifyProductionBootstrapHttpRequest(
        "GET",
        "/api/integrations/linkedin/callback?code=x",
      ),
    ).toBe("writer");
    expect(
      classifyProductionBootstrapHttpRequest("GET", "/api/workflows/runs/run_1"),
    ).toBe("writer");
    expect(classifyProductionBootstrapHttpRequest("POST", "/api/auth/webhook")).toBe(
      "writer",
    );
  });

  it("classifies the complete reviewed GET/HEAD-equivalent controller surface", () => {
    const sourceRoot = join(process.cwd(), "src");
    const routes = productionGetRoutes(sourceRoot);
    expect(routes).toHaveLength(86);
    expect(new Set(routes).size).toBe(routes.length);

    const writerRoutes = new Set([
      "/api/agents/templates",
      "/api/billing",
      "/api/integrations/gmail/auth-url",
      "/api/integrations/hubspot/auth-url",
      "/api/integrations/gmail/callback",
      "/api/integrations/outlook/callback",
      "/api/integrations/hubspot/callback",
      "/api/integrations/fixture/health",
      "/api/integrations/linkedin/callback",
      "/api/integrations/gmail/messages",
      "/api/integrations/gmail/search",
      "/api/integrations/gmail/messages/fixture",
      "/api/integrations/gmail/threads/fixture",
      "/api/integrations/hubspot/contacts/search",
      "/api/integrations/hubspot/contacts/fixture",
      "/api/integrations/hubspot/deals/search",
      "/api/integrations/hubspot/deals/fixture",
      "/api/integrations/hubspot/companies/search",
      "/api/integrations/hubspot/companies/fixture",
      "/api/workflows/runs/fixture",
    ]);
    for (const route of routes) {
      const expected = route.startsWith("/api/u/")
        ? "unsubscribe"
        : writerRoutes.has(route)
          ? "writer"
          : "read";
      expect(
        classifyProductionBootstrapHttpRequest("GET", route),
        `review GET route ${route}`,
      ).toBe(expected);
      expect(
        classifyProductionBootstrapHttpRequest("HEAD", route),
        `review HEAD fallback route ${route}`,
      ).toBe(expected);
    }
  });

  it("fails closed for an unknown future GET route", () => {
    expect(
      classifyProductionBootstrapHttpRequest(
        "GET",
        "/api/future-side-effecting-read",
      ),
    ).toBe("writer");
  });
});

describe("production raw SQL source policy", () => {
  it("allows only static read/advisory SELECTs and forbids queryRawUnsafe call sites", () => {
    const sourceRoot = join(process.cwd(), "src");
    const files = productionTypeScriptFiles(sourceRoot);
    const rawQueries: Array<{ file: string; strings: string[] }> = [];
    const unsafeCalls: string[] = [];
    const typedCalls: string[] = [];

    for (const file of files) {
      if (file.endsWith("/ops/production-bootstrap-quiescence.ts")) continue;
      const sourceText = readFileSync(file, "utf8");
      const source = ts.createSourceFile(
        file,
        sourceText,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );
      const visit = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "$queryRawUnsafe"
        ) {
          unsafeCalls.push(relative(sourceRoot, file));
        }
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "$queryRawTyped"
        ) {
          typedCalls.push(relative(sourceRoot, file));
        }
        if (
          ts.isTaggedTemplateExpression(node) &&
          ts.isPropertyAccessExpression(node.tag) &&
          node.tag.name.text === "$queryRaw"
        ) {
          const strings = ts.isNoSubstitutionTemplateLiteral(node.template)
            ? [node.template.text]
            : [
                node.template.head.text,
                ...node.template.templateSpans.map(
                  (span) => span.literal.text,
                ),
              ];
          rawQueries.push({ file: relative(sourceRoot, file), strings });
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }

    expect(unsafeCalls).toEqual([]);
    expect(typedCalls).toEqual([]);
    const prismaSchema = readFileSync(
      join(process.cwd(), "../../packages/db/prisma/schema.prisma"),
      "utf8",
    );
    expect(prismaSchema).not.toMatch(/\btypedSql\b/);
    expect(rawQueries.length).toBeGreaterThan(0);
    const allowedFunctions = new Set([
      "avg",
      "btrim",
      "coalesce",
      "count",
      "date_trunc",
      "extract",
      "hashtextextended",
      "lower",
      "pg_advisory_xact_lock",
      "sum",
    ]);
    const structuralKeywords = new Set(["and", "from", "in", "not", "or"]);
    for (const raw of rawQueries) {
      expect(
        isClearlyReadOnlyPrismaRawQuery({ strings: raw.strings, values: [] }),
        `${raw.file} must contain one static SELECT only: ${raw.strings.join(" ? ")}`,
      ).toBe(true);
      const sql = raw.strings.join(" ? ");
      const functions = Array.from(
        sql.matchAll(/\b([a-z_][a-z0-9_]*)\s*\(/gi),
        (match) => match[1].toLowerCase(),
      ).filter((name) => !structuralKeywords.has(name));
      expect(
        functions.filter((name) => !allowedFunctions.has(name)),
        `${raw.file} introduces an unreviewed raw-SQL function`,
      ).toEqual([]);
    }
  });
});

function productionTypeScriptFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__") {
        files.push(...productionTypeScriptFiles(absolute));
      }
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".ts")) files.push(absolute);
  }
  return files;
}

function productionGetRoutes(sourceRoot: string): string[] {
  const routes: string[] = [];
  for (const file of productionTypeScriptFiles(sourceRoot).filter((candidate) =>
    candidate.endsWith(".controller.ts"),
  )) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    for (const statement of source.statements) {
      if (!ts.isClassDeclaration(statement)) continue;
      const controller = decoratorPath(statement, "Controller");
      if (controller === null) continue;
      for (const member of statement.members) {
        if (!ts.isMethodDeclaration(member)) continue;
        const route = decoratorPath(member, "Get");
        if (route === null) continue;
        routes.push(
          ["api", controller, route]
            .filter((part) => part.length > 0)
            .join("/")
            .replace(/^/, "/")
            .replace(/:[^/]+/g, "fixture"),
        );
      }
    }
  }
  return routes.sort();
}

function decoratorPath(
  node: ts.Node,
  decoratorName: string,
): string | null {
  const decorators = ts.canHaveDecorators(node)
    ? (ts.getDecorators(node) ?? [])
    : [];
  for (const decorator of decorators) {
    if (!ts.isCallExpression(decorator.expression)) continue;
    if (
      !ts.isIdentifier(decorator.expression.expression) ||
      decorator.expression.expression.text !== decoratorName
    ) {
      continue;
    }
    const argument = decorator.expression.arguments[0];
    if (!argument) return "";
    if (!ts.isStringLiteralLike(argument)) {
      throw new Error(`@${decoratorName} path must be a string literal`);
    }
    return argument.text.replace(/^\/+|\/+$/g, "");
  }
  return null;
}
