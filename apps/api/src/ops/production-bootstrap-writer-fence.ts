import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import {
  Injectable,
  Inject,
  OnModuleInit,
  OnModuleDestroy,
  Optional,
  ServiceUnavailableException,
} from "@nestjs/common";
import IORedis from "ioredis";

export const PRODUCTION_BOOTSTRAP_WRITER_FENCE_TARGET =
  "workforce-os-production";
export const PRODUCTION_BOOTSTRAP_WRITER_FENCE_STATE_KEY =
  "workforce-os:production-bootstrap:writer-fence:v1";
export const PRODUCTION_BOOTSTRAP_WRITER_FENCE_GENERATION_KEY =
  "workforce-os:production-bootstrap:writer-fence:generation:v1";
export const PRODUCTION_BOOTSTRAP_ACTIVE_WRITERS_KEY =
  "workforce-os:production-bootstrap:active-writers:v1";
export const PRODUCTION_BOOTSTRAP_ACTIVE_COMPLIANCE_WRITERS_KEY =
  "workforce-os:production-bootstrap:active-compliance-writers:v1";
export const PRODUCTION_BOOTSTRAP_UNCERTAIN_WRITERS_KEY =
  "workforce-os:production-bootstrap:uncertain-writers:v1";
export const PRODUCTION_BOOTSTRAP_UNCERTAIN_COMPLIANCE_WRITERS_KEY =
  "workforce-os:production-bootstrap:uncertain-compliance-writers:v1";

export const PRODUCTION_BOOTSTRAP_WRITER_FENCE_REDIS = Symbol(
  "PRODUCTION_BOOTSTRAP_WRITER_FENCE_REDIS",
);

const DEFAULT_LEASE_MS = 5 * 60_000;
const DEFAULT_HEARTBEAT_MS = 15_000;
const MAX_FENCE_LIFETIME_MS = 24 * 60 * 60_000;

const ACQUIRE_WRITER_LEASE_SCRIPT = `
-- WORKFORCE_OS_WRITER_FENCE_ACQUIRE_V1
local server_time = redis.call('TIME')
local now_ms = tonumber(server_time[1]) * 1000 + math.floor(tonumber(server_time[2]) / 1000)
local expired = redis.call('ZRANGEBYSCORE', KEYS[3], '-inf', now_ms)
for _, token in ipairs(expired) do
  redis.call('SADD', KEYS[4], token)
end
redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', now_ms)
local generation = redis.call('GET', KEYS[2]) or '0'
local raw = redis.call('GET', KEYS[1])
if not raw then
  if ARGV[3] ~= '' or generation ~= '0' then
    return {'INVALID_STATE', generation}
  end
else
  local ok, epoch = pcall(cjson.decode, raw)
  if not ok or epoch.schemaVersion ~= 1 or epoch.target ~= 'workforce-os-production'
      or tostring(epoch.generation) ~= generation
      or (epoch.mode ~= 'open' and epoch.mode ~= 'closed')
      or (ARGV[3] ~= '' and epoch.bootstrapAttemptId ~= ARGV[3])
      or tonumber(generation) < tonumber(ARGV[4]) then
    return {'INVALID_STATE', generation}
  end
  if epoch.mode == 'closed' then
    return {'CLOSED', raw}
  end
end
redis.call('ZADD', KEYS[3], now_ms + tonumber(ARGV[2]), ARGV[1])
return {'OK', generation, raw or ''}
`;

const ACQUIRE_COMPLIANCE_LEASE_SCRIPT = `
-- WORKFORCE_OS_WRITER_FENCE_ACQUIRE_COMPLIANCE_V1
local server_time = redis.call('TIME')
local now_ms = tonumber(server_time[1]) * 1000 + math.floor(tonumber(server_time[2]) / 1000)
local expired = redis.call('ZRANGEBYSCORE', KEYS[3], '-inf', now_ms)
for _, token in ipairs(expired) do
  redis.call('SADD', KEYS[4], token)
end
redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', now_ms)
local generation = redis.call('GET', KEYS[2]) or '0'
local raw = redis.call('GET', KEYS[1])
if not raw then
  if ARGV[3] ~= '' or generation ~= '0' then
    return {'INVALID_STATE', generation}
  end
else
  local ok, epoch = pcall(cjson.decode, raw)
  if not ok or epoch.schemaVersion ~= 1 or epoch.target ~= 'workforce-os-production'
      or tostring(epoch.generation) ~= generation
      or (epoch.mode ~= 'open' and epoch.mode ~= 'closed')
      or (ARGV[3] ~= '' and epoch.bootstrapAttemptId ~= ARGV[3])
      or tonumber(generation) < tonumber(ARGV[4]) then
    return {'INVALID_STATE', generation}
  end
end
redis.call('ZADD', KEYS[3], now_ms + tonumber(ARGV[2]), ARGV[1])
return {'OK', generation, raw or ''}
`;

const HEARTBEAT_WRITER_LEASE_SCRIPT = `
-- WORKFORCE_OS_WRITER_FENCE_HEARTBEAT_V1
local server_time = redis.call('TIME')
local now_ms = tonumber(server_time[1]) * 1000 + math.floor(tonumber(server_time[2]) / 1000)
local raw = redis.call('GET', KEYS[1])
if not raw then
  if ARGV[3] ~= '0' or ARGV[4] ~= '' or ARGV[5] ~= '0' then
    return 'INVALID_STATE'
  end
else
  local ok, epoch = pcall(cjson.decode, raw)
  if not ok or epoch.schemaVersion ~= 1 or epoch.target ~= 'workforce-os-production'
      or tostring(epoch.generation) ~= ARGV[3]
      or (ARGV[4] ~= '' and epoch.bootstrapAttemptId ~= ARGV[4])
      or tonumber(ARGV[3]) < tonumber(ARGV[5]) then
    return 'INVALID_STATE'
  end
  if epoch.mode == 'closed' then return 'CLOSED' end
  if epoch.mode ~= 'open' then return 'INVALID_STATE' end
end
local score = redis.call('ZSCORE', KEYS[2], ARGV[1])
if not score then
  return 'LOST'
end
if tonumber(score) <= now_ms then
  redis.call('ZREM', KEYS[2], ARGV[1])
  redis.call('SADD', KEYS[3], ARGV[1])
  return 'LOST'
end
redis.call('ZADD', KEYS[2], 'XX', now_ms + tonumber(ARGV[2]), ARGV[1])
return 'OK'
`;

const HEARTBEAT_COMPLIANCE_LEASE_SCRIPT = `
-- WORKFORCE_OS_WRITER_FENCE_HEARTBEAT_COMPLIANCE_V1
local server_time = redis.call('TIME')
local now_ms = tonumber(server_time[1]) * 1000 + math.floor(tonumber(server_time[2]) / 1000)
local raw = redis.call('GET', KEYS[1])
if not raw then
  if ARGV[3] ~= '0' or ARGV[4] ~= '' or ARGV[5] ~= '0' then
    return 'INVALID_STATE'
  end
else
  local ok, epoch = pcall(cjson.decode, raw)
  if not ok or epoch.schemaVersion ~= 1 or epoch.target ~= 'workforce-os-production'
      or tostring(epoch.generation) ~= ARGV[3]
      or (epoch.mode ~= 'open' and epoch.mode ~= 'closed')
      or (ARGV[4] ~= '' and epoch.bootstrapAttemptId ~= ARGV[4])
      or tonumber(ARGV[3]) < tonumber(ARGV[5]) then
    return 'INVALID_STATE'
  end
end
local score = redis.call('ZSCORE', KEYS[2], ARGV[1])
if not score then
  return 'LOST'
end
if tonumber(score) <= now_ms then
  redis.call('ZREM', KEYS[2], ARGV[1])
  redis.call('SADD', KEYS[3], ARGV[1])
  return 'LOST'
end
redis.call('ZADD', KEYS[2], 'XX', now_ms + tonumber(ARGV[2]), ARGV[1])
return 'OK'
`;

const RELEASE_WRITER_LEASE_SCRIPT = `
-- WORKFORCE_OS_WRITER_FENCE_RELEASE_V1
local active_removed = redis.call('ZREM', KEYS[1], ARGV[1])
local uncertain_removed = redis.call('SREM', KEYS[2], ARGV[1])
return active_removed + uncertain_removed
`;

const ARM_WRITER_FENCE_SCRIPT = `
-- WORKFORCE_OS_WRITER_FENCE_ARM_V1
local server_time = redis.call('TIME')
local now_ms = tonumber(server_time[1]) * 1000 + math.floor(tonumber(server_time[2]) / 1000)
local expired = redis.call('ZRANGEBYSCORE', KEYS[3], '-inf', now_ms)
for _, token in ipairs(expired) do redis.call('SADD', KEYS[5], token) end
redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', now_ms)
expired = redis.call('ZRANGEBYSCORE', KEYS[4], '-inf', now_ms)
for _, token in ipairs(expired) do redis.call('SADD', KEYS[6], token) end
redis.call('ZREMRANGEBYSCORE', KEYS[4], '-inf', now_ms)
local stored_generation = redis.call('GET', KEYS[2]) or '0'
local raw = redis.call('GET', KEYS[1])
if raw then
  local ok, epoch = pcall(cjson.decode, raw)
  if not ok or epoch.schemaVersion ~= 1 or epoch.target ~= 'workforce-os-production'
      or (epoch.mode ~= 'open' and epoch.mode ~= 'closed')
      or tostring(epoch.generation) ~= stored_generation then
    return {'INVALID_STATE'}
  end
  if epoch.mode == 'closed' then return {'STATE_PRESENT', raw} end
  -- OPEN is terminal for a one-time production bootstrap attempt. Re-closing
  -- would let a restored stale OPEN value bypass a later generation floor.
  return {'OPEN_TERMINAL', raw}
end
local current_generation = tonumber(stored_generation)
local requested_generation = tonumber(ARGV[1])
if not requested_generation or requested_generation <= current_generation then
  return {'STALE_GENERATION', tostring(current_generation)}
end
local active = redis.call('ZCARD', KEYS[3]) + redis.call('SCARD', KEYS[5])
local compliance = redis.call('ZCARD', KEYS[4]) + redis.call('SCARD', KEYS[6])
if active ~= 0 or compliance ~= 0 then
  return {'ACTIVE_WRITERS', tostring(active), tostring(compliance)}
end
redis.call('SET', KEYS[2], ARGV[1])
redis.call('SET', KEYS[1], ARGV[2])
return {'OK', ARGV[1]}
`;

const ROTATE_WRITER_FENCE_SCRIPT = `
-- WORKFORCE_OS_WRITER_FENCE_ROTATE_V1
local server_time = redis.call('TIME')
local now_ms = tonumber(server_time[1]) * 1000 + math.floor(tonumber(server_time[2]) / 1000)
local expired = redis.call('ZRANGEBYSCORE', KEYS[3], '-inf', now_ms)
for _, token in ipairs(expired) do redis.call('SADD', KEYS[5], token) end
redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', now_ms)
expired = redis.call('ZRANGEBYSCORE', KEYS[4], '-inf', now_ms)
for _, token in ipairs(expired) do redis.call('SADD', KEYS[6], token) end
redis.call('ZREMRANGEBYSCORE', KEYS[4], '-inf', now_ms)
local raw = redis.call('GET', KEYS[1])
if not raw then
  return {'ABSENT'}
end
local ok, state = pcall(cjson.decode, raw)
if not ok or state.schemaVersion ~= 1 or state.mode ~= 'closed' then
  return {'INVALID_STATE'}
end
if state.target ~= ARGV[1] or state.bootstrapAttemptId ~= ARGV[2]
    or tostring(state.generation) ~= ARGV[3] then
  return {'MISMATCH'}
end
local stored_generation = tonumber(redis.call('GET', KEYS[2]) or '-1')
local current_generation = tonumber(ARGV[3])
local next_generation = tonumber(ARGV[4])
if not stored_generation or stored_generation ~= current_generation then
  return {'INVALID_STATE'}
end
if not next_generation or next_generation <= current_generation then
  return {'STALE_GENERATION', tostring(stored_generation)}
end
local active = redis.call('ZCARD', KEYS[3]) + redis.call('SCARD', KEYS[5])
local compliance = redis.call('ZCARD', KEYS[4]) + redis.call('SCARD', KEYS[6])
if active ~= 0 or compliance ~= 0 then
  return {'ACTIVE_WRITERS', tostring(active), tostring(compliance)}
end
redis.call('SET', KEYS[2], ARGV[4])
redis.call('SET', KEYS[1], ARGV[5])
return {'OK', ARGV[4]}
`;

const DISARM_WRITER_FENCE_SCRIPT = `
-- WORKFORCE_OS_WRITER_FENCE_DISARM_V1
local server_time = redis.call('TIME')
local now_ms = tonumber(server_time[1]) * 1000 + math.floor(tonumber(server_time[2]) / 1000)
local expired = redis.call('ZRANGEBYSCORE', KEYS[3], '-inf', now_ms)
for _, token in ipairs(expired) do redis.call('SADD', KEYS[5], token) end
redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', now_ms)
expired = redis.call('ZRANGEBYSCORE', KEYS[4], '-inf', now_ms)
for _, token in ipairs(expired) do redis.call('SADD', KEYS[6], token) end
redis.call('ZREMRANGEBYSCORE', KEYS[4], '-inf', now_ms)
local raw = redis.call('GET', KEYS[1])
if not raw then
  return {'ABSENT'}
end
local ok, state = pcall(cjson.decode, raw)
if not ok or state.schemaVersion ~= 1
    or (state.mode ~= 'closed' and state.mode ~= 'open') then
  return {'INVALID_STATE'}
end
if state.target ~= ARGV[1] or state.bootstrapAttemptId ~= ARGV[2]
    or tostring(state.generation) ~= ARGV[3] then
  return {'MISMATCH'}
end
if (redis.call('GET', KEYS[2]) or '') ~= ARGV[3] then
  return {'INVALID_STATE'}
end
-- Retrying the exact terminal transition is safe and idempotent.
if state.mode == 'open' then return {'OK'} end
local active = redis.call('ZCARD', KEYS[3]) + redis.call('SCARD', KEYS[5])
local compliance = redis.call('ZCARD', KEYS[4]) + redis.call('SCARD', KEYS[6])
if active ~= 0 or compliance ~= 0 then
  return {'ACTIVE_WRITERS', tostring(active), tostring(compliance)}
end
redis.call('SET', KEYS[1], ARGV[4])
return {'OK'}
`;

const READ_WRITER_FENCE_SCRIPT = `
-- WORKFORCE_OS_WRITER_FENCE_READ_V1
local server_time = redis.call('TIME')
local now_ms = tonumber(server_time[1]) * 1000 + math.floor(tonumber(server_time[2]) / 1000)
local expired = redis.call('ZRANGEBYSCORE', KEYS[3], '-inf', now_ms)
for _, token in ipairs(expired) do redis.call('SADD', KEYS[5], token) end
redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', now_ms)
expired = redis.call('ZRANGEBYSCORE', KEYS[4], '-inf', now_ms)
for _, token in ipairs(expired) do redis.call('SADD', KEYS[6], token) end
redis.call('ZREMRANGEBYSCORE', KEYS[4], '-inf', now_ms)
return {
  redis.call('GET', KEYS[1]) or '',
  redis.call('GET', KEYS[2]) or '0',
  tostring(redis.call('ZCARD', KEYS[3]) + redis.call('SCARD', KEYS[5])),
  tostring(redis.call('ZCARD', KEYS[4]) + redis.call('SCARD', KEYS[6])),
  server_time[1]
}
`;

const RECOVER_ORPHANED_WRITER_TOKENS_SCRIPT = `
-- WORKFORCE_OS_WRITER_FENCE_RECOVER_ORPHANS_V1
local server_time = redis.call('TIME')
local generation = redis.call('GET', KEYS[2]) or '0'
if generation ~= ARGV[2] then return {'GENERATION_MISMATCH', generation} end
local raw = redis.call('GET', KEYS[1])
if raw then
  local ok, epoch = pcall(cjson.decode, raw)
  if not ok or epoch.schemaVersion ~= 1
      or epoch.target ~= 'workforce-os-production'
      or tostring(epoch.generation) ~= generation
      or epoch.bootstrapAttemptId ~= ARGV[1]
      or (epoch.mode ~= 'closed' and epoch.mode ~= 'open') then
    return {'INVALID_STATE'}
  end
  if epoch.mode == 'open' then return {'TERMINAL_OPEN'} end
elseif generation ~= '0' then
  return {'INVALID_STATE'}
end
local active_application = redis.call('ZRANGE', KEYS[3], 0, -1)
local active_compliance = redis.call('ZRANGE', KEYS[4], 0, -1)
local uncertain_application = redis.call('SMEMBERS', KEYS[5])
local uncertain_compliance = redis.call('SMEMBERS', KEYS[6])
table.sort(active_application)
table.sort(active_compliance)
table.sort(uncertain_application)
table.sort(uncertain_compliance)
redis.call('DEL', KEYS[3], KEYS[4], KEYS[5], KEYS[6])
return {
  'OK', server_time[1], server_time[2], generation, raw or '',
  active_application, active_compliance,
  uncertain_application, uncertain_compliance
}
`;

export interface ProductionBootstrapWriterFenceRedis {
  eval(
    script: string,
    numberOfKeys: number,
    ...args: Array<string | number>
  ): Promise<unknown>;
  quit?(): Promise<unknown>;
  disconnect?(reconnect?: boolean): void;
  on?(event: string, listener: (...args: unknown[]) => void): unknown;
}

export interface ProductionBootstrapWriterFenceState {
  readonly schemaVersion: 1;
  readonly target: typeof PRODUCTION_BOOTSTRAP_WRITER_FENCE_TARGET;
  readonly mode: "closed";
  readonly bootstrapAttemptId: string;
  readonly generation: number;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface ProductionBootstrapWriterFenceOpenEpoch {
  readonly schemaVersion: 1;
  readonly target: typeof PRODUCTION_BOOTSTRAP_WRITER_FENCE_TARGET;
  readonly mode: "open";
  readonly bootstrapAttemptId: string;
  readonly generation: number;
}

export type ProductionBootstrapWriterFenceEpoch =
  | ProductionBootstrapWriterFenceState
  | ProductionBootstrapWriterFenceOpenEpoch;

export interface ProductionBootstrapWriterFenceReadback {
  readonly schemaVersion: 1;
  readonly target: typeof PRODUCTION_BOOTSTRAP_WRITER_FENCE_TARGET;
  readonly observedAt: string;
  readonly generation: number;
  readonly epoch: ProductionBootstrapWriterFenceEpoch | null;
  /** CLOSED-only compatibility view used by pre-terminal quiescence proofs. */
  readonly state: ProductionBootstrapWriterFenceState | null;
  readonly stateHash: string | null;
  readonly activeWriters: number;
  readonly activeComplianceWriters: number;
  readonly writerZero: boolean;
}

export interface ProductionBootstrapOrphanRecoveryAttestation {
  readonly bootstrapAttemptId: string;
  readonly expectedGeneration: number;
  readonly stableZeroEvidenceHash: string;
  readonly ingressDisabled: true;
  readonly queuesPausedAndDrained: true;
  readonly apiReplicaCount: 0;
  readonly workerReplicaCount: 0;
}

export interface ProductionBootstrapOrphanRecoveryEvidence {
  readonly schemaVersion: 1;
  readonly target: typeof PRODUCTION_BOOTSTRAP_WRITER_FENCE_TARGET;
  readonly bootstrapAttemptId: string;
  readonly generation: number;
  readonly recoveredAt: string;
  readonly stableZeroEvidenceHash: string;
  readonly pre: {
    readonly activeApplicationWriters: number;
    readonly activeComplianceWriters: number;
    readonly uncertainApplicationWriters: number;
    readonly uncertainComplianceWriters: number;
    readonly tokenSetHash: string;
  };
  readonly post: {
    readonly activeApplicationWriters: 0;
    readonly activeComplianceWriters: 0;
    readonly uncertainApplicationWriters: 0;
    readonly uncertainComplianceWriters: 0;
    readonly tokenSetHash: string;
  };
}

export type ProductionBootstrapWriterKind =
  | "http"
  | "queue-producer"
  | "agent-worker"
  | "graph-worker"
  | "outreach-worker"
  | "scheduler"
  | "recovery"
  | "gmail-watch-renewal"
  | "database";

interface WriterScope {
  readonly token: string;
  readonly compliance: boolean;
  readonly kind: ProductionBootstrapWriterKind | "unsubscribe";
  readonly generation: number;
  readonly pendingNestedWrites: Set<Promise<unknown>>;
  lost: boolean;
}

export interface ProductionBootstrapWriterFenceOptions {
  readonly production: boolean;
  readonly now?: () => Date;
  readonly leaseMs?: number;
  readonly heartbeatMs?: number;
  readonly bootstrapAttemptId?: string;
  readonly minimumGeneration?: number;
}

export class ProductionBootstrapWriterFenceClosedError extends ServiceUnavailableException {
  constructor(message = "Production bootstrap has paused application writes") {
    super(message);
  }
}

export class ProductionBootstrapWriterFenceUnavailableError extends ServiceUnavailableException {
  constructor(message = "Production bootstrap writer fence is unavailable") {
    super(message);
  }
}

function assertAttemptId(value: string): void {
  if (!/^[0-9a-f]{32}$/.test(value)) {
    throw new Error(
      "bootstrap attempt id must be exactly 32 lowercase hexadecimal characters",
    );
  }
}

function assertGeneration(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("writer-fence generation must be a positive safe integer");
  }
}

function canonicalUtcSeconds(value: Date, label: string): string {
  if (!Number.isFinite(value.getTime())) {
    throw new Error(`${label} must be a valid date`);
  }
  return value.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function assertIsoDate(value: unknown, label: string): Date {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) {
    throw new Error(`${label} must be a canonical UTC-seconds timestamp`);
  }
  const parsed = new Date(value);
  if (
    !Number.isFinite(parsed.getTime()) ||
    canonicalUtcSeconds(parsed, label) !== value
  ) {
    throw new Error(`${label} must be a canonical UTC-seconds timestamp`);
  }
  return parsed;
}

function assertNonNegativeInteger(value: unknown, label: string): number {
  const numeric = typeof value === "string" ? Number(value) : value;
  if (
    typeof numeric !== "number" ||
    !Number.isSafeInteger(numeric) ||
    numeric < 0
  ) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return numeric;
}

function asRedisArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} returned an invalid result`);
  return value;
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

export function parseProductionBootstrapWriterFenceState(
  raw: string,
): ProductionBootstrapWriterFenceState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("writer-fence state is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("writer-fence state must be an object");
  }
  const record = parsed as Record<string, unknown>;
  const expectedKeys = [
    "bootstrapAttemptId",
    "expiresAt",
    "generation",
    "issuedAt",
    "mode",
    "schemaVersion",
    "target",
  ];
  if (Object.keys(record).sort().join("\n") !== expectedKeys.join("\n")) {
    throw new Error("writer-fence state has unexpected or missing fields");
  }
  if (record.schemaVersion !== 1) {
    throw new Error("writer-fence schemaVersion must be 1");
  }
  if (record.target !== PRODUCTION_BOOTSTRAP_WRITER_FENCE_TARGET) {
    throw new Error("writer-fence target is not Workforce OS production");
  }
  if (record.mode !== "closed") {
    throw new Error("writer-fence mode must be closed");
  }
  if (typeof record.bootstrapAttemptId !== "string") {
    throw new Error("writer-fence bootstrapAttemptId must be a string");
  }
  assertAttemptId(record.bootstrapAttemptId);
  assertGeneration(record.generation as number);
  const issuedAt = assertIsoDate(record.issuedAt, "writer-fence issuedAt");
  const expiresAt = assertIsoDate(record.expiresAt, "writer-fence expiresAt");
  const lifetime = expiresAt.getTime() - issuedAt.getTime();
  if (lifetime <= 0 || lifetime > MAX_FENCE_LIFETIME_MS) {
    throw new Error("writer-fence lifetime must be greater than zero and at most 24 hours");
  }
  return record as unknown as ProductionBootstrapWriterFenceState;
}

function parseProductionBootstrapWriterFenceEpoch(
  raw: string,
): ProductionBootstrapWriterFenceEpoch {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("writer-fence epoch is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("writer-fence epoch must be an object");
  }
  const record = parsed as Record<string, unknown>;
  if (record.mode === "closed") {
    return parseProductionBootstrapWriterFenceState(raw);
  }
  const expectedKeys = [
    "bootstrapAttemptId",
    "generation",
    "mode",
    "schemaVersion",
    "target",
  ];
  if (Object.keys(record).sort().join("\n") !== expectedKeys.join("\n")) {
    throw new Error("writer-fence open epoch has unexpected or missing fields");
  }
  if (
    record.schemaVersion !== 1 ||
    record.target !== PRODUCTION_BOOTSTRAP_WRITER_FENCE_TARGET ||
    record.mode !== "open" ||
    typeof record.bootstrapAttemptId !== "string"
  ) {
    throw new Error("writer-fence open epoch is invalid");
  }
  assertAttemptId(record.bootstrapAttemptId);
  assertGeneration(record.generation as number);
  return record as unknown as ProductionBootstrapWriterFenceOpenEpoch;
}

export async function armProductionBootstrapWriterFence(
  redis: ProductionBootstrapWriterFenceRedis,
  input: {
    readonly bootstrapAttemptId: string;
    readonly generation: number;
    readonly issuedAt: Date;
    readonly expiresAt: Date;
  },
): Promise<ProductionBootstrapWriterFenceState> {
  assertAttemptId(input.bootstrapAttemptId);
  assertGeneration(input.generation);
  const state: ProductionBootstrapWriterFenceState = {
    schemaVersion: 1,
    target: PRODUCTION_BOOTSTRAP_WRITER_FENCE_TARGET,
    mode: "closed",
    bootstrapAttemptId: input.bootstrapAttemptId,
    generation: input.generation,
    issuedAt: canonicalUtcSeconds(input.issuedAt, "writer-fence issuedAt"),
    expiresAt: canonicalUtcSeconds(input.expiresAt, "writer-fence expiresAt"),
  };
  parseProductionBootstrapWriterFenceState(JSON.stringify(state));
  const result = asRedisArray(
    await redis.eval(
      ARM_WRITER_FENCE_SCRIPT,
      6,
      PRODUCTION_BOOTSTRAP_WRITER_FENCE_STATE_KEY,
      PRODUCTION_BOOTSTRAP_WRITER_FENCE_GENERATION_KEY,
      PRODUCTION_BOOTSTRAP_ACTIVE_WRITERS_KEY,
      PRODUCTION_BOOTSTRAP_ACTIVE_COMPLIANCE_WRITERS_KEY,
      PRODUCTION_BOOTSTRAP_UNCERTAIN_WRITERS_KEY,
      PRODUCTION_BOOTSTRAP_UNCERTAIN_COMPLIANCE_WRITERS_KEY,
      String(input.generation),
      JSON.stringify(state),
    ),
    "writer-fence arm",
  );
  if (result[0] === "OK") return state;
  if (result[0] === "ACTIVE_WRITERS") {
    throw new Error(
      `writer-fence cannot close with active writers (application=${String(result[1])}, compliance=${String(result[2])})`,
    );
  }
  if (result[0] === "STATE_PRESENT") {
    throw new Error("writer-fence is already closed");
  }
  if (result[0] === "OPEN_TERMINAL") {
    throw new Error("writer-fence is terminally open and cannot be re-armed");
  }
  if (result[0] === "STALE_GENERATION") {
    throw new Error(
      `writer-fence generation must advance beyond ${String(result[1])}`,
    );
  }
  throw new Error("writer-fence arm returned an unknown result");
}

/**
 * Atomically renews an already-closed fence without a fail-open interval.
 * This is the only valid way to extend a long-running/HELD bootstrap attempt:
 * disarm-then-arm is forbidden because a writer could enter between calls.
 */
export async function rotateProductionBootstrapWriterFence(
  redis: ProductionBootstrapWriterFenceRedis,
  input: {
    readonly bootstrapAttemptId: string;
    readonly currentGeneration: number;
    readonly nextGeneration: number;
    readonly issuedAt: Date;
    readonly expiresAt: Date;
  },
): Promise<ProductionBootstrapWriterFenceState> {
  assertAttemptId(input.bootstrapAttemptId);
  assertGeneration(input.currentGeneration);
  assertGeneration(input.nextGeneration);
  if (input.nextGeneration <= input.currentGeneration) {
    throw new Error(
      "writer-fence rotation generation must strictly advance",
    );
  }
  const state: ProductionBootstrapWriterFenceState = {
    schemaVersion: 1,
    target: PRODUCTION_BOOTSTRAP_WRITER_FENCE_TARGET,
    mode: "closed",
    bootstrapAttemptId: input.bootstrapAttemptId,
    generation: input.nextGeneration,
    issuedAt: canonicalUtcSeconds(input.issuedAt, "writer-fence issuedAt"),
    expiresAt: canonicalUtcSeconds(input.expiresAt, "writer-fence expiresAt"),
  };
  parseProductionBootstrapWriterFenceState(JSON.stringify(state));
  const result = asRedisArray(
    await redis.eval(
      ROTATE_WRITER_FENCE_SCRIPT,
      6,
      PRODUCTION_BOOTSTRAP_WRITER_FENCE_STATE_KEY,
      PRODUCTION_BOOTSTRAP_WRITER_FENCE_GENERATION_KEY,
      PRODUCTION_BOOTSTRAP_ACTIVE_WRITERS_KEY,
      PRODUCTION_BOOTSTRAP_ACTIVE_COMPLIANCE_WRITERS_KEY,
      PRODUCTION_BOOTSTRAP_UNCERTAIN_WRITERS_KEY,
      PRODUCTION_BOOTSTRAP_UNCERTAIN_COMPLIANCE_WRITERS_KEY,
      PRODUCTION_BOOTSTRAP_WRITER_FENCE_TARGET,
      input.bootstrapAttemptId,
      String(input.currentGeneration),
      String(input.nextGeneration),
      JSON.stringify(state),
    ),
    "writer-fence rotation",
  );
  if (result[0] === "OK") return state;
  if (result[0] === "ACTIVE_WRITERS") {
    throw new Error(
      `writer-fence cannot rotate with active writers (application=${String(result[1])}, compliance=${String(result[2])})`,
    );
  }
  if (result[0] === "MISMATCH") {
    throw new Error("writer-fence rotation identity does not match the closed fence");
  }
  if (result[0] === "STALE_GENERATION") {
    throw new Error(
      `writer-fence rotation generation must advance beyond ${String(result[1])}`,
    );
  }
  if (result[0] === "ABSENT") {
    throw new Error("writer-fence is not closed");
  }
  throw new Error("writer-fence state is invalid and cannot be rotated");
}

export async function disarmProductionBootstrapWriterFence(
  redis: ProductionBootstrapWriterFenceRedis,
  input: {
    readonly bootstrapAttemptId: string;
    readonly generation: number;
    readonly observedAt: Date;
  },
): Promise<void> {
  assertAttemptId(input.bootstrapAttemptId);
  assertGeneration(input.generation);
  const openEpoch: ProductionBootstrapWriterFenceOpenEpoch = {
    schemaVersion: 1,
    target: PRODUCTION_BOOTSTRAP_WRITER_FENCE_TARGET,
    mode: "open",
    bootstrapAttemptId: input.bootstrapAttemptId,
    generation: input.generation,
  };
  const result = asRedisArray(
    await redis.eval(
      DISARM_WRITER_FENCE_SCRIPT,
      6,
      PRODUCTION_BOOTSTRAP_WRITER_FENCE_STATE_KEY,
      PRODUCTION_BOOTSTRAP_WRITER_FENCE_GENERATION_KEY,
      PRODUCTION_BOOTSTRAP_ACTIVE_WRITERS_KEY,
      PRODUCTION_BOOTSTRAP_ACTIVE_COMPLIANCE_WRITERS_KEY,
      PRODUCTION_BOOTSTRAP_UNCERTAIN_WRITERS_KEY,
      PRODUCTION_BOOTSTRAP_UNCERTAIN_COMPLIANCE_WRITERS_KEY,
      PRODUCTION_BOOTSTRAP_WRITER_FENCE_TARGET,
      input.bootstrapAttemptId,
      String(input.generation),
      JSON.stringify(openEpoch),
    ),
    "writer-fence disarm",
  );
  if (result[0] === "OK") return;
  if (result[0] === "ACTIVE_WRITERS") {
    throw new Error("writer-fence cannot reopen with active writers");
  }
  if (result[0] === "MISMATCH") {
    throw new Error("writer-fence disarm identity does not match the closed fence");
  }
  if (result[0] === "ABSENT") {
    throw new Error("writer-fence is not closed");
  }
  throw new Error("writer-fence state is invalid and cannot be disarmed");
}

export async function readProductionBootstrapWriterFence(
  redis: ProductionBootstrapWriterFenceRedis,
  beforeMutation?: () => void | Promise<void>,
): Promise<ProductionBootstrapWriterFenceReadback> {
  await beforeMutation?.();
  const result = asRedisArray(
    await redis.eval(
      READ_WRITER_FENCE_SCRIPT,
      6,
      PRODUCTION_BOOTSTRAP_WRITER_FENCE_STATE_KEY,
      PRODUCTION_BOOTSTRAP_WRITER_FENCE_GENERATION_KEY,
      PRODUCTION_BOOTSTRAP_ACTIVE_WRITERS_KEY,
      PRODUCTION_BOOTSTRAP_ACTIVE_COMPLIANCE_WRITERS_KEY,
      PRODUCTION_BOOTSTRAP_UNCERTAIN_WRITERS_KEY,
      PRODUCTION_BOOTSTRAP_UNCERTAIN_COMPLIANCE_WRITERS_KEY,
    ),
    "writer-fence readback",
  );
  if (result.length !== 5 || typeof result[0] !== "string") {
    throw new Error("writer-fence readback returned an invalid shape");
  }
  const rawEpoch = result[0];
  const epoch = rawEpoch
    ? parseProductionBootstrapWriterFenceEpoch(rawEpoch)
    : null;
  const state = epoch?.mode === "closed" ? epoch : null;
  const generation = assertNonNegativeInteger(
    result[1],
    "writer-fence generation",
  );
  const activeWriters = assertNonNegativeInteger(
    result[2],
    "active application writers",
  );
  const activeComplianceWriters = assertNonNegativeInteger(
    result[3],
    "active compliance writers",
  );
  const observedEpochSeconds = assertNonNegativeInteger(
    result[4],
    "writer-fence Redis observed time",
  );
  if (observedEpochSeconds > Math.floor(Number.MAX_SAFE_INTEGER / 1_000)) {
    throw new Error("writer-fence Redis observed time is outside the safe date range");
  }
  const observedAt = new Date(observedEpochSeconds * 1_000);
  if (epoch && epoch.generation !== generation) {
    throw new Error("writer-fence epoch and generation counter disagree");
  }
  if (!epoch && generation !== 0) {
    throw new Error("writer-fence epoch is absent after initialization");
  }
  return {
    schemaVersion: 1,
    target: PRODUCTION_BOOTSTRAP_WRITER_FENCE_TARGET,
    observedAt: canonicalUtcSeconds(observedAt, "writer-fence observedAt"),
    generation,
    epoch,
    state,
    stateHash: rawEpoch ? sha256(rawEpoch) : null,
    activeWriters,
    activeComplianceWriters,
    writerZero: activeWriters === 0 && activeComplianceWriters === 0,
  };
}

/**
 * Explicit recovery for tokens orphaned by a controller-proven process
 * termination. This must never run from normal application startup or lease
 * expiry: the caller must first prove ingress disabled, queues paused/drained,
 * and both production roles at stable zero replicas.
 */
export async function recoverProductionBootstrapOrphanedWriterTokens(
  redis: ProductionBootstrapWriterFenceRedis,
  attestation: ProductionBootstrapOrphanRecoveryAttestation,
): Promise<ProductionBootstrapOrphanRecoveryEvidence> {
  assertAttemptId(attestation.bootstrapAttemptId);
  if (
    !Number.isSafeInteger(attestation.expectedGeneration) ||
    attestation.expectedGeneration < 0
  ) {
    throw new Error("orphan recovery expected generation must be non-negative");
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(attestation.stableZeroEvidenceHash)) {
    throw new Error("orphan recovery stable-zero evidence hash is invalid");
  }
  if (
    attestation.ingressDisabled !== true ||
    attestation.queuesPausedAndDrained !== true ||
    attestation.apiReplicaCount !== 0 ||
    attestation.workerReplicaCount !== 0
  ) {
    throw new Error(
      "orphan recovery requires ingress disabled, queues paused/drained, and stable-zero API/worker replicas",
    );
  }

  const result = asRedisArray(
    await redis.eval(
      RECOVER_ORPHANED_WRITER_TOKENS_SCRIPT,
      6,
      PRODUCTION_BOOTSTRAP_WRITER_FENCE_STATE_KEY,
      PRODUCTION_BOOTSTRAP_WRITER_FENCE_GENERATION_KEY,
      PRODUCTION_BOOTSTRAP_ACTIVE_WRITERS_KEY,
      PRODUCTION_BOOTSTRAP_ACTIVE_COMPLIANCE_WRITERS_KEY,
      PRODUCTION_BOOTSTRAP_UNCERTAIN_WRITERS_KEY,
      PRODUCTION_BOOTSTRAP_UNCERTAIN_COMPLIANCE_WRITERS_KEY,
      attestation.bootstrapAttemptId,
      String(attestation.expectedGeneration),
    ),
    "writer-fence orphan recovery",
  );
  if (result[0] === "GENERATION_MISMATCH") {
    throw new Error(
      `orphan recovery generation does not match ${String(result[1])}`,
    );
  }
  if (result[0] === "TERMINAL_OPEN") {
    throw new Error("orphan recovery is forbidden after terminal OPEN");
  }
  if (result[0] !== "OK" || result.length !== 9) {
    throw new Error("writer-fence state is invalid for orphan recovery");
  }
  const generation = assertNonNegativeInteger(
    result[3],
    "orphan recovery generation",
  );
  if (generation !== attestation.expectedGeneration) {
    throw new Error("orphan recovery generation result is inconsistent");
  }
  const memberList = (value: unknown, label: string): string[] => {
    const entries = asRedisArray(value, label);
    if (!entries.every((entry) => typeof entry === "string")) {
      throw new Error(`${label} contains an invalid token`);
    }
    return [...(entries as string[])].sort();
  };
  const activeApplication = memberList(
    result[5],
    "orphan recovery active application writers",
  );
  const activeCompliance = memberList(
    result[6],
    "orphan recovery active compliance writers",
  );
  const uncertainApplication = memberList(
    result[7],
    "orphan recovery uncertain application writers",
  );
  const uncertainCompliance = memberList(
    result[8],
    "orphan recovery uncertain compliance writers",
  );
  const rawEpoch = result[4];
  if (typeof rawEpoch !== "string") {
    throw new Error("orphan recovery epoch result is invalid");
  }
  if (rawEpoch) parseProductionBootstrapWriterFenceEpoch(rawEpoch);
  const seconds = assertNonNegativeInteger(result[1], "orphan recovery Redis time");
  const microseconds = assertNonNegativeInteger(
    result[2],
    "orphan recovery Redis microseconds",
  );
  if (microseconds > 999_999) {
    throw new Error("orphan recovery Redis microseconds are invalid");
  }
  if (seconds > Math.floor(Number.MAX_SAFE_INTEGER / 1_000)) {
    throw new Error("orphan recovery Redis time is outside the safe date range");
  }
  const recoveredAt = new Date(seconds * 1_000 + Math.floor(microseconds / 1_000));
  const tokenEvidence = {
    generation,
    epochHash: rawEpoch ? sha256(rawEpoch) : null,
    activeApplication,
    activeCompliance,
    uncertainApplication,
    uncertainCompliance,
  };
  const emptyTokenEvidence = {
    generation,
    epochHash: rawEpoch ? sha256(rawEpoch) : null,
    activeApplication: [] as string[],
    activeCompliance: [] as string[],
    uncertainApplication: [] as string[],
    uncertainCompliance: [] as string[],
  };
  return {
    schemaVersion: 1,
    target: PRODUCTION_BOOTSTRAP_WRITER_FENCE_TARGET,
    bootstrapAttemptId: attestation.bootstrapAttemptId,
    generation,
    recoveredAt: canonicalUtcSeconds(recoveredAt, "orphan recovery observedAt"),
    stableZeroEvidenceHash: attestation.stableZeroEvidenceHash,
    pre: {
      activeApplicationWriters: activeApplication.length,
      activeComplianceWriters: activeCompliance.length,
      uncertainApplicationWriters: uncertainApplication.length,
      uncertainComplianceWriters: uncertainCompliance.length,
      tokenSetHash: sha256(JSON.stringify(tokenEvidence)),
    },
    post: {
      activeApplicationWriters: 0,
      activeComplianceWriters: 0,
      uncertainApplicationWriters: 0,
      uncertainComplianceWriters: 0,
      tokenSetHash: sha256(JSON.stringify(emptyTokenEvidence)),
    },
  };
}

export function assertClosedWriterFenceReadback(
  readback: ProductionBootstrapWriterFenceReadback,
  expected: { readonly bootstrapAttemptId: string; readonly generation: number },
): void {
  assertAttemptId(expected.bootstrapAttemptId);
  assertGeneration(expected.generation);
  if (!readback.state) throw new Error("writer-fence is not closed");
  if (
    readback.state.bootstrapAttemptId !== expected.bootstrapAttemptId ||
    readback.state.generation !== expected.generation ||
    readback.generation !== expected.generation
  ) {
    throw new Error("writer-fence readback does not match the bootstrap attempt");
  }
  if (Date.parse(readback.state.expiresAt) <= Date.parse(readback.observedAt)) {
    throw new Error("writer-fence readback has expired; bootstrap must remain closed");
  }
  if (!readback.writerZero) {
    throw new Error("writer-fence readback still has active writers");
  }
}

function createRedisFromEnvironment(): ProductionBootstrapWriterFenceRedis | null {
  const redisUrl = process.env.REDIS_URL;
  const redisHost = process.env.REDIS_HOST;
  if (!redisUrl && !redisHost) return null;
  const common = {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableReadyCheck: true,
    connectTimeout: 5_000,
    commandTimeout: 5_000,
  } as const;
  const redis = redisUrl
    ? new IORedis(redisUrl, common)
    : new IORedis({
        ...common,
        host: redisHost!,
        port: Number(process.env.REDIS_PORT ?? 6380),
        username: process.env.REDIS_USERNAME,
        password: process.env.REDIS_PASSWORD,
        tls: process.env.REDIS_TLS === "false" ? undefined : {},
      });
  redis.on("error", () => undefined);
  return redis;
}

export function productionBootstrapWriterFenceRedisProvider(): ProductionBootstrapWriterFenceRedis | null {
  return createRedisFromEnvironment();
}

export class ProductionBootstrapWriterFence {
  private readonly storage = new AsyncLocalStorage<WriterScope>();
  private readonly now: () => Date;
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  private readonly bootstrapAttemptId: string;
  private readonly minimumGeneration: number;

  constructor(
    private readonly redis: ProductionBootstrapWriterFenceRedis | null,
    private readonly options: ProductionBootstrapWriterFenceOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.bootstrapAttemptId = options.bootstrapAttemptId ?? "";
    this.minimumGeneration = options.minimumGeneration ?? 0;
    if (
      (this.bootstrapAttemptId === "") !== (this.minimumGeneration === 0)
    ) {
      throw new Error(
        "production bootstrap deployment guard requires both attempt id and minimum generation",
      );
    }
    if (options.production && this.bootstrapAttemptId === "") {
      throw new Error(
        "production bootstrap deployment guard is required in production",
      );
    }
    if (this.bootstrapAttemptId) assertAttemptId(this.bootstrapAttemptId);
    if (this.minimumGeneration !== 0) {
      assertGeneration(this.minimumGeneration);
    }
    if (!Number.isSafeInteger(this.leaseMs) || this.leaseMs < 30_000) {
      throw new Error("writer lease must be at least 30 seconds");
    }
    if (
      !Number.isSafeInteger(this.heartbeatMs) ||
      this.heartbeatMs < 1_000 ||
      this.heartbeatMs >= this.leaseMs / 2
    ) {
      throw new Error("writer heartbeat must be positive and less than half the lease");
    }
  }

  runWriter<T>(
    kind: ProductionBootstrapWriterKind,
    operation: () => Promise<T>,
  ): Promise<T> {
    const existing = this.storage.getStore();
    if (existing) {
      if (existing.compliance) {
        return this.handledRejection(
          new ProductionBootstrapWriterFenceClosedError(
            "Unsubscribe scope cannot perform non-compliance work",
          ),
        );
      }
      return this.runTrackedNestedWrite(existing, operation);
    }
    return this.withLease(false, kind, operation);
  }

  runComplianceWriter<T>(operation: () => Promise<T>): Promise<T> {
    const existing = this.storage.getStore();
    if (existing) {
      return this.runTrackedNestedWrite(existing, operation);
    }
    return this.withLease(true, "unsubscribe", operation);
  }

  /**
   * Interactive transactions are conservatively treated as writers before
   * Prisma opens the transaction. An existing compliance scope may open the
   * transaction, but every model/raw mutation inside it is still checked by
   * the Prisma query extension and its narrow suppression allowlist.
   */
  runInteractiveTransaction<T>(operation: () => Promise<T>): Promise<T> {
    const existing = this.storage.getStore();
    if (existing) {
      return this.runTrackedNestedWrite(existing, operation);
    }
    return this.withLease(false, "database", operation);
  }

  runDatabaseWrite<T>(
    model: string | undefined,
    operationName: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const existing = this.storage.getStore();
    if (existing?.compliance) {
      const allowed =
        model === "OutreachSuppression" &&
        (operationName === "create" || operationName === "update");
      if (!allowed) {
        return this.handledRejection(
          new ProductionBootstrapWriterFenceClosedError(
            `Unsubscribe scope cannot write ${model ?? "raw"}.${operationName}`,
          ),
        );
      }
      return this.runTrackedNestedWrite(existing, operation);
    }
    return this.runWriter("database", operation);
  }

  async assertCurrentScope(): Promise<void> {
    const scope = this.storage.getStore();
    if (!scope) {
      throw new ProductionBootstrapWriterFenceUnavailableError(
        "A production writer operation has no tracked lease",
      );
    }
    if (scope.lost) {
      throw new ProductionBootstrapWriterFenceClosedError(
        "Production writer lease was lost",
      );
    }
    if (!this.redis) {
      if (this.options.production) {
        throw new ProductionBootstrapWriterFenceUnavailableError();
      }
      return;
    }
    try {
      const result = await this.redis.eval(
        scope.compliance
          ? HEARTBEAT_COMPLIANCE_LEASE_SCRIPT
          : HEARTBEAT_WRITER_LEASE_SCRIPT,
        3,
        ...(scope.compliance
          ? [
              PRODUCTION_BOOTSTRAP_WRITER_FENCE_STATE_KEY,
              PRODUCTION_BOOTSTRAP_ACTIVE_COMPLIANCE_WRITERS_KEY,
              PRODUCTION_BOOTSTRAP_UNCERTAIN_COMPLIANCE_WRITERS_KEY,
            ]
          : [
              PRODUCTION_BOOTSTRAP_WRITER_FENCE_STATE_KEY,
              PRODUCTION_BOOTSTRAP_ACTIVE_WRITERS_KEY,
              PRODUCTION_BOOTSTRAP_UNCERTAIN_WRITERS_KEY,
            ]),
        scope.token,
        this.leaseMs,
        String(scope.generation),
        this.bootstrapAttemptId,
        String(this.minimumGeneration),
      );
      if (result !== "OK") {
        scope.lost = true;
        throw new ProductionBootstrapWriterFenceClosedError(
          result === "CLOSED"
            ? "Production bootstrap closed while this writer was stale"
            : "Production writer lease no longer exists",
        );
      }
    } catch (error) {
      if (error instanceof ProductionBootstrapWriterFenceClosedError) throw error;
      if (this.options.production) {
        scope.lost = true;
        throw new ProductionBootstrapWriterFenceUnavailableError();
      }
    }
  }

  async readback(): Promise<ProductionBootstrapWriterFenceReadback> {
    if (!this.redis) {
      if (this.options.production) {
        throw new ProductionBootstrapWriterFenceUnavailableError();
      }
      return {
        schemaVersion: 1,
        target: PRODUCTION_BOOTSTRAP_WRITER_FENCE_TARGET,
        observedAt: canonicalUtcSeconds(
          this.now(),
          "writer-fence observedAt",
        ),
        generation: 0,
        epoch: null,
        state: null,
        stateHash: null,
        activeWriters: 0,
        activeComplianceWriters: 0,
        writerZero: true,
      };
    }
    try {
      return await readProductionBootstrapWriterFence(this.redis);
    } catch (error) {
      if (this.options.production) {
        throw new ProductionBootstrapWriterFenceUnavailableError();
      }
      throw error;
    }
  }

  /**
   * Read and validate the immutable deployment epoch without acquiring a
   * writer lease. Workers use this to remain dormant for CLOSED and may start
   * only after the exact guarded attempt reaches terminal OPEN.
   */
  async deploymentEpochMode(): Promise<"open" | "closed"> {
    if (!this.redis) {
      if (this.options.production) {
        throw new ProductionBootstrapWriterFenceUnavailableError();
      }
      return "open";
    }
    try {
      const result = asRedisArray(
        await this.redis.eval(
          READ_WRITER_FENCE_SCRIPT,
          6,
          PRODUCTION_BOOTSTRAP_WRITER_FENCE_STATE_KEY,
          PRODUCTION_BOOTSTRAP_WRITER_FENCE_GENERATION_KEY,
          PRODUCTION_BOOTSTRAP_ACTIVE_WRITERS_KEY,
          PRODUCTION_BOOTSTRAP_ACTIVE_COMPLIANCE_WRITERS_KEY,
          PRODUCTION_BOOTSTRAP_UNCERTAIN_WRITERS_KEY,
          PRODUCTION_BOOTSTRAP_UNCERTAIN_COMPLIANCE_WRITERS_KEY,
        ),
        "writer-fence deployment epoch",
      );
      if (result.length !== 5 || typeof result[0] !== "string") {
        throw new Error("writer-fence deployment epoch returned an invalid shape");
      }
      const generation = assertNonNegativeInteger(
        result[1],
        "writer-fence generation",
      );
      const epoch = result[0]
        ? parseProductionBootstrapWriterFenceEpoch(result[0])
        : null;
      if (
        (epoch && epoch.generation !== generation) ||
        (!epoch && generation !== 0) ||
        (this.bootstrapAttemptId &&
          (!epoch ||
            epoch.bootstrapAttemptId !== this.bootstrapAttemptId ||
            epoch.generation < this.minimumGeneration))
      ) {
        throw new Error("writer-fence deployment guard mismatch");
      }
      return epoch?.mode ?? "open";
    } catch (error) {
      if (error instanceof ProductionBootstrapWriterFenceUnavailableError) {
        throw error;
      }
      if (this.options.production) {
        throw new ProductionBootstrapWriterFenceUnavailableError(
          "Production writer-fence deployment epoch is invalid",
        );
      }
      throw error;
    }
  }

  private async withLease<T>(
    compliance: boolean,
    kind: ProductionBootstrapWriterKind | "unsubscribe",
    operation: () => Promise<T>,
  ): Promise<T> {
    if (!this.redis) {
      if (this.options.production) {
        throw new ProductionBootstrapWriterFenceUnavailableError();
      }
      const local: WriterScope = {
        token: `local-${randomBytes(16).toString("hex")}`,
        compliance,
        kind,
        generation: 0,
        pendingNestedWrites: new Set(),
        lost: false,
      };
      return this.runRootOperation(local, operation);
    }

    const token = `${kind}:${randomBytes(24).toString("hex")}`;
    let result: unknown;
    try {
      result = await this.redis.eval(
        compliance
          ? ACQUIRE_COMPLIANCE_LEASE_SCRIPT
          : ACQUIRE_WRITER_LEASE_SCRIPT,
        4,
        ...(compliance
          ? [
              PRODUCTION_BOOTSTRAP_WRITER_FENCE_STATE_KEY,
              PRODUCTION_BOOTSTRAP_WRITER_FENCE_GENERATION_KEY,
              PRODUCTION_BOOTSTRAP_ACTIVE_COMPLIANCE_WRITERS_KEY,
              PRODUCTION_BOOTSTRAP_UNCERTAIN_COMPLIANCE_WRITERS_KEY,
            ]
          : [
              PRODUCTION_BOOTSTRAP_WRITER_FENCE_STATE_KEY,
              PRODUCTION_BOOTSTRAP_WRITER_FENCE_GENERATION_KEY,
              PRODUCTION_BOOTSTRAP_ACTIVE_WRITERS_KEY,
              PRODUCTION_BOOTSTRAP_UNCERTAIN_WRITERS_KEY,
            ]),
        token,
        this.leaseMs,
        this.bootstrapAttemptId,
        String(this.minimumGeneration),
      );
    } catch {
      if (this.options.production) {
        throw new ProductionBootstrapWriterFenceUnavailableError();
      }
      const local: WriterScope = {
        token: `local-${randomBytes(16).toString("hex")}`,
        compliance,
        kind,
        generation: 0,
        pendingNestedWrites: new Set(),
        lost: false,
      };
      return this.runRootOperation(local, operation);
    }

    const values = asRedisArray(result, "writer lease acquire");
    if (values[0] === "CLOSED") {
      if (typeof values[1] !== "string") {
        throw new ProductionBootstrapWriterFenceUnavailableError(
          "Production writer fence state is invalid",
        );
      }
      try {
        parseProductionBootstrapWriterFenceState(values[1]);
      } catch {
        throw new ProductionBootstrapWriterFenceUnavailableError(
          "Production writer fence state is invalid",
        );
      }
      throw new ProductionBootstrapWriterFenceClosedError();
    }
    if (values[0] !== "OK") {
      throw new ProductionBootstrapWriterFenceUnavailableError(
        "Production writer lease could not be acquired",
      );
    }
    const acquiredGeneration = assertNonNegativeInteger(
      values[1],
      "writer lease generation",
    );
    const rawEpoch = values[2];
    if (typeof rawEpoch !== "string") {
      throw new ProductionBootstrapWriterFenceUnavailableError(
        "Production writer fence epoch is invalid",
      );
    }
    try {
      const epoch = rawEpoch
        ? parseProductionBootstrapWriterFenceEpoch(rawEpoch)
        : null;
      if (
        (epoch && epoch.generation !== acquiredGeneration) ||
        (!epoch && acquiredGeneration !== 0) ||
        (this.bootstrapAttemptId &&
          (!epoch ||
            epoch.bootstrapAttemptId !== this.bootstrapAttemptId ||
            epoch.generation < this.minimumGeneration))
      ) {
        throw new Error("writer-fence deployment guard mismatch");
      }
    } catch {
      try {
        await this.redis.eval(
          RELEASE_WRITER_LEASE_SCRIPT,
          2,
          compliance
            ? PRODUCTION_BOOTSTRAP_ACTIVE_COMPLIANCE_WRITERS_KEY
            : PRODUCTION_BOOTSTRAP_ACTIVE_WRITERS_KEY,
          compliance
            ? PRODUCTION_BOOTSTRAP_UNCERTAIN_COMPLIANCE_WRITERS_KEY
            : PRODUCTION_BOOTSTRAP_UNCERTAIN_WRITERS_KEY,
          token,
        );
      } catch {
        // An invalid epoch is already fail-closed. Any uncertain token left by
        // a concurrent Redis failure remains counted until operator review.
      }
      throw new ProductionBootstrapWriterFenceUnavailableError(
        "Production writer fence epoch is invalid",
      );
    }
    const scope: WriterScope = {
      token,
      compliance,
      kind,
      generation: acquiredGeneration,
      pendingNestedWrites: new Set(),
      lost: false,
    };
    const heartbeat = setInterval(() => {
      void this.storage.run(scope, async () => {
        try {
          await this.assertCurrentScope();
        } catch {
          scope.lost = true;
        }
      });
    }, this.heartbeatMs);
    heartbeat.unref?.();
    try {
      return await this.runRootOperation(scope, operation);
    } finally {
      clearInterval(heartbeat);
      try {
        await this.redis.eval(
          RELEASE_WRITER_LEASE_SCRIPT,
          2,
          compliance
            ? PRODUCTION_BOOTSTRAP_ACTIVE_COMPLIANCE_WRITERS_KEY
            : PRODUCTION_BOOTSTRAP_ACTIVE_WRITERS_KEY,
          compliance
            ? PRODUCTION_BOOTSTRAP_UNCERTAIN_COMPLIANCE_WRITERS_KEY
            : PRODUCTION_BOOTSTRAP_UNCERTAIN_WRITERS_KEY,
          token,
        );
      } catch {
        // Expiry is the recovery path. A Redis outage in production already
        // marks the in-flight scope lost and prevents subsequent fenced effects.
      }
    }
  }

  /**
   * AsyncLocalStorage propagates a root scope into detached promises. Track
   * every nested writer promise explicitly so the root Redis token remains
   * live until those operations settle, even when a caller forgets to await
   * one. The attached rejection handler prevents a detached failure from
   * becoming an unhandled rejection; an awaiting caller still observes it.
   */
  private runTrackedNestedWrite<T>(
    scope: WriterScope,
    operation: () => Promise<T>,
  ): Promise<T> {
    const work = (async () => {
      await this.assertCurrentScope();
      return operation();
    })();
    let tracked!: Promise<T>;
    tracked = work.finally(() => {
      scope.pendingNestedWrites.delete(tracked);
    });
    scope.pendingNestedWrites.add(tracked);
    void tracked.catch(() => undefined);
    return tracked;
  }

  private async runRootOperation<T>(
    scope: WriterScope,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await this.storage.run(scope, operation);
    } finally {
      // A nested operation may itself register more nested writes while this
      // drain is in progress, so continue until the shared set is truly empty.
      while (scope.pendingNestedWrites.size > 0) {
        await Promise.allSettled([...scope.pendingNestedWrites]);
      }
    }
  }

  private handledRejection<T>(error: Error): Promise<T> {
    const rejected = Promise.reject<T>(error);
    void rejected.catch(() => undefined);
    return rejected;
  }
}

export function productionBootstrapWriterFenceOptionsFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): ProductionBootstrapWriterFenceOptions {
  const bootstrapAttemptId =
    environment.WORKFORCE_PRODUCTION_BOOTSTRAP_ATTEMPT_ID;
  const minimumGenerationRaw =
    environment.WORKFORCE_PRODUCTION_BOOTSTRAP_MIN_WRITER_FENCE_GENERATION;
  if ((bootstrapAttemptId === undefined) !== (minimumGenerationRaw === undefined)) {
    throw new Error(
      "production bootstrap deployment guard environment is incomplete",
    );
  }
  if (bootstrapAttemptId === undefined) {
    if (environment.NODE_ENV === "production") {
      throw new Error(
        "production bootstrap deployment guard environment is required",
      );
    }
    return { production: environment.NODE_ENV === "production" };
  }
  assertAttemptId(bootstrapAttemptId);
  if (!/^[1-9][0-9]*$/.test(minimumGenerationRaw!)) {
    throw new Error(
      "production bootstrap minimum writer-fence generation is invalid",
    );
  }
  const minimumGeneration = Number(minimumGenerationRaw);
  assertGeneration(minimumGeneration);
  return {
    production: environment.NODE_ENV === "production",
    bootstrapAttemptId,
    minimumGeneration,
  };
}

@Injectable()
export class ProductionBootstrapWriterFenceService
  extends ProductionBootstrapWriterFence
  implements OnModuleInit, OnModuleDestroy
{
  constructor(
    @Optional()
    @Inject(PRODUCTION_BOOTSTRAP_WRITER_FENCE_REDIS)
    redis: ProductionBootstrapWriterFenceRedis | null,
  ) {
    super(
      redis ?? null,
      productionBootstrapWriterFenceOptionsFromEnvironment(),
    );
    this.ownedRedis = redis ?? null;
  }

  private readonly ownedRedis: ProductionBootstrapWriterFenceRedis | null;

  async onModuleInit(): Promise<void> {
    await this.deploymentEpochMode();
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.ownedRedis) return;
    try {
      if (this.ownedRedis.quit) await this.ownedRedis.quit();
      else this.ownedRedis.disconnect?.(false);
    } catch {
      this.ownedRedis.disconnect?.(false);
    }
  }
}

export function isPrismaWriteOperation(operation: string): boolean {
  // Fail closed across Prisma upgrades: only the currently reviewed model
  // read operations bypass the writer fence. Any new/future operation is a
  // writer until it is explicitly audited and added here.
  return !new Set([
    "findUnique",
    "findUniqueOrThrow",
    "findFirst",
    "findFirstOrThrow",
    "findMany",
    "aggregate",
    "count",
    "groupBy",
  ]).has(operation);
}

/**
 * Prisma permits data-changing SQL through `$queryRaw`, including a
 * data-modifying CTE. Keep ordinary, statically authored SELECTs available to
 * health/read routes and send every other shape through the writer fence.
 * `$queryRawUnsafe` is never considered read-only because its SQL is dynamic.
 */
export function isClearlyReadOnlyPrismaRawQuery(
  args: unknown,
  unsafe = false,
): boolean {
  if (unsafe || !args || typeof args !== "object") return false;
  const strings = (args as { strings?: unknown }).strings;
  if (
    !Array.isArray(strings) ||
    strings.length === 0 ||
    strings.some((part) => typeof part !== "string")
  ) {
    return false;
  }

  const sql = maskSqlLiteralsAndComments((strings as string[]).join(" ? "));
  if (sql === null || !/^\s*SELECT\b/i.test(sql)) return false;

  // Multiple statements, row locks, sequence/notification functions, and
  // every SQL mutation keyword are conservative writer classifications.
  const withoutTrailingTerminator = sql.replace(/;\s*$/, "");
  if (withoutTrailingTerminator.includes(";")) return false;
  return !/\b(?:INSERT|UPDATE|DELETE|MERGE|ALTER|CREATE|DROP|TRUNCATE|GRANT|REVOKE|COPY|CALL|DO|VACUUM|REFRESH|REINDEX|CLUSTER|ANALYZE|COMMENT|SECURITY|SET|RESET|LOCK|NOTIFY|LISTEN|UNLISTEN|INTO|NEXTVAL|SETVAL|PG_NOTIFY|FOR\s+UPDATE|FOR\s+NO\s+KEY\s+UPDATE|FOR\s+SHARE|FOR\s+KEY\s+SHARE)\b/i.test(
    withoutTrailingTerminator,
  );
}

/**
 * Produces a same-length SQL policy view with quoted values, identifiers, and
 * comments blanked. This is deliberately not a SQL parser; it only prevents
 * policy keywords in inert text from being mistaken for executable tokens.
 * Unknown executable shapes remain writer-classified.
 */
function maskSqlLiteralsAndComments(sql: string): string | null {
  const masked = sql.split("");
  const blank = (start: number, end: number) => {
    for (let index = start; index < end; index += 1) {
      if (masked[index] !== "\n" && masked[index] !== "\r") masked[index] = " ";
    }
  };

  for (let index = 0; index < sql.length; ) {
    const char = sql[index];
    if (char === "'" || char === '"') {
      const quote = char;
      const start = index;
      index += 1;
      let closed = false;
      while (index < sql.length) {
        if (sql[index] !== quote) {
          index += 1;
          continue;
        }
        if (sql[index + 1] === quote) {
          index += 2;
          continue;
        }
        index += 1;
        closed = true;
        break;
      }
      if (!closed) return null;
      blank(start, index);
      continue;
    }
    if (char === "-" && sql[index + 1] === "-") {
      const start = index;
      index += 2;
      while (index < sql.length && sql[index] !== "\n") index += 1;
      blank(start, index);
      continue;
    }
    if (char === "/" && sql[index + 1] === "*") {
      const start = index;
      index += 2;
      let depth = 1;
      while (index < sql.length && depth > 0) {
        if (sql[index] === "/" && sql[index + 1] === "*") {
          depth += 1;
          index += 2;
        } else if (sql[index] === "*" && sql[index + 1] === "/") {
          depth -= 1;
          index += 2;
        } else {
          index += 1;
        }
      }
      if (depth !== 0) return null;
      blank(start, index);
      continue;
    }
    if (char === "$") {
      const delimiter = sql.slice(index).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)?.[0];
      if (delimiter) {
        const start = index;
        const end = sql.indexOf(delimiter, index + delimiter.length);
        if (end === -1) return null;
        index = end + delimiter.length;
        blank(start, index);
        continue;
      }
    }
    index += 1;
  }
  return masked.join("");
}

/**
 * Unit tests often construct services without Nest. Production may never use
 * that shortcut: a missing injected fence is itself a fail-closed condition.
 */
export async function runWithProductionBootstrapWriterFence<T>(
  fence: ProductionBootstrapWriterFenceService | undefined,
  kind: ProductionBootstrapWriterKind,
  operation: () => Promise<T>,
): Promise<T> {
  if (fence) return fence.runWriter(kind, operation);
  if (process.env.NODE_ENV === "production") {
    throw new ProductionBootstrapWriterFenceUnavailableError(
      "Production writer fence was not injected",
    );
  }
  return operation();
}

/**
 * BullMQ workers are constructed with autorun disabled during bootstrap and
 * consult this read-only guard before starting their processor loop.
 */
export async function productionBootstrapWorkerMayActivate(
  fence: ProductionBootstrapWriterFenceService | undefined,
): Promise<boolean> {
  if (fence) return (await fence.deploymentEpochMode()) === "open";
  if (process.env.NODE_ENV === "production") {
    throw new ProductionBootstrapWriterFenceUnavailableError(
      "Production writer fence was not injected",
    );
  }
  return true;
}

export type ProductionBootstrapWriterFenceRunResult<T> =
  | { readonly ran: true; readonly value: T }
  | { readonly ran: false };

/**
 * Startup and periodic background probes may intentionally remain idle while
 * a valid fence is CLOSED. Only that exact state is converted to a skip;
 * unavailable Redis, malformed state, and all operation failures still throw.
 */
export async function runWithProductionBootstrapWriterFenceOrSkipClosed<T>(
  fence: ProductionBootstrapWriterFenceService | undefined,
  kind: ProductionBootstrapWriterKind,
  operation: () => Promise<T>,
): Promise<ProductionBootstrapWriterFenceRunResult<T>> {
  try {
    return {
      ran: true,
      value: await runWithProductionBootstrapWriterFence(
        fence,
        kind,
        operation,
      ),
    };
  } catch (error) {
    if (error instanceof ProductionBootstrapWriterFenceClosedError) {
      return { ran: false };
    }
    throw error;
  }
}

export async function assertProductionBootstrapWriterLease(
  fence: ProductionBootstrapWriterFenceService | undefined,
): Promise<void> {
  if (fence) return fence.assertCurrentScope();
  if (process.env.NODE_ENV === "production") {
    throw new ProductionBootstrapWriterFenceUnavailableError(
      "Production writer fence was not injected",
    );
  }
}

export async function runDatabaseWriteWithProductionBootstrapWriterFence<T>(
  fence: ProductionBootstrapWriterFenceService | undefined,
  model: string | undefined,
  operationName: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (fence) return fence.runDatabaseWrite(model, operationName, operation);
  if (process.env.NODE_ENV === "production") {
    throw new ProductionBootstrapWriterFenceUnavailableError(
      "Production database writer fence was not injected",
    );
  }
  return operation();
}

export async function runInteractiveTransactionWithProductionBootstrapWriterFence<T>(
  fence: ProductionBootstrapWriterFenceService | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  if (fence) return fence.runInteractiveTransaction(operation);
  if (process.env.NODE_ENV === "production") {
    throw new ProductionBootstrapWriterFenceUnavailableError(
      "Production interactive-transaction writer fence was not injected",
    );
  }
  return operation();
}
