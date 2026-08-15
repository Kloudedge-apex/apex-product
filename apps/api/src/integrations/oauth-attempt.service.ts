import * as crypto from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  Optional,
  ServiceUnavailableException,
} from "@nestjs/common";
import IORedis, { type Redis } from "ioredis";
import { buildRedisConnectionOptions } from "../runtime/queue.service";
import {
  signOAuthAttemptState,
  verifyOAuthAttemptState,
} from "../common/webhook-signature.util";
import { decrypt, encrypt } from "./crypto.util";

export const OAUTH_ATTEMPT_REDIS = Symbol("OAUTH_ATTEMPT_REDIS");
export const OAUTH_ATTEMPT_TTL_MS = 10 * 60 * 1000;

const KEY_PREFIX = "oauth_attempt:v1";
const ATTEMPT_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PROVIDER_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const MAX_AUTHORIZATION_CODE_LENGTH = 8192;
const SUPPORTED_PROVIDER = "gmail";

type AttemptStatus = "INITIATED" | "CODE_PARKED";

interface StoredOAuthAttempt {
  readonly version: 1;
  readonly attemptId: string;
  readonly provider: string;
  readonly orgId: string;
  readonly clerkUserId: string;
  readonly expiresAtMs: number;
  readonly status: AttemptStatus;
  readonly encryptedCode?: string;
}

const PARK_CODE_LUA = `
local raw = redis.call('GET', KEYS[1])
if not raw then return -1 end

local record = cjson.decode(raw)
if record.provider ~= ARGV[1] then return -3 end
if record.status ~= 'INITIATED' then return -2 end

local ttl = redis.call('PTTL', KEYS[1])
if ttl <= 0 then
  redis.call('DEL', KEYS[1])
  return -1
end

record.status = 'CODE_PARKED'
record.encryptedCode = ARGV[2]
redis.call('SET', KEYS[1], cjson.encode(record), 'PX', ttl, 'XX')
return 1
`;

const CONSUME_CODE_LUA = `
local raw = redis.call('GET', KEYS[1])
if not raw then return {-1} end

local record = cjson.decode(raw)
if record.provider ~= ARGV[1] then return {-3} end
if record.orgId ~= ARGV[2] or record.clerkUserId ~= ARGV[3] then return {-4} end
if record.status ~= 'CODE_PARKED' then return {-2} end
if not record.encryptedCode or record.encryptedCode == '' then return {-5} end

redis.call('DEL', KEYS[1])
return {1, record.encryptedCode}
`;

export interface OAuthAttemptStart {
  readonly attemptId: string;
  readonly state: string;
  readonly expiresAt: Date;
}

/**
 * Durable, one-time authority boundary for OAuth connection changes.
 *
 * The provider-facing callback has no user JWT. It may only transition an
 * actor-bound attempt from INITIATED to CODE_PARKED and stores the provider
 * code encrypted. The authenticated finalization route verifies the current
 * admin/manager authority, then atomically deletes and returns the code before
 * Gmail activation. A crash or provider failure can therefore lose an attempt,
 * but can never replay the connection mutation.
 */
@Injectable()
export class OAuthAttemptService implements OnModuleDestroy {
  private readonly logger = new Logger(OAuthAttemptService.name);
  private readonly redis: Redis | null;
  private readonly memory: Map<string, StoredOAuthAttempt> | null;
  private readonly ownsRedis: boolean;

  constructor(
    @Optional()
    @Inject(OAUTH_ATTEMPT_REDIS)
    redisOverride?: Redis,
  ) {
    if (redisOverride) {
      this.redis = redisOverride;
      this.memory = null;
      this.ownsRedis = false;
      return;
    }

    const options = buildRedisConnectionOptions();
    if (options) {
      const redisOptions = options as unknown as Record<string, unknown>;
      if (typeof redisOptions.url === "string") {
        this.redis = new IORedis(redisOptions.url, {
          connectTimeout: 5_000,
          maxRetriesPerRequest: 1,
        });
      } else {
        this.redis = new IORedis({
          ...redisOptions,
          connectTimeout: 5_000,
          maxRetriesPerRequest: 1,
        } as never);
      }
      this.redis.on("error", () => undefined);
      this.memory = null;
      this.ownsRedis = true;
      this.logger.log("OAuth attempt storage connected to Redis");
      return;
    }

    const nodeEnv = process.env.NODE_ENV ?? "development";
    if (nodeEnv !== "development" && nodeEnv !== "test") {
      throw new Error(
        "REDIS_URL (or REDIS_HOST) is required outside development/test. " +
          "Refusing to store OAuth attempts in process memory.",
      );
    }
    this.redis = null;
    this.memory = new Map();
    this.ownsRedis = false;
    this.logger.warn(
      "REDIS_URL not set - OAuth attempts use a process-local dev/test fallback",
    );
  }

  onModuleDestroy(): void {
    if (this.redis && this.ownsRedis) this.redis.disconnect(false);
  }

  async start(input: {
    readonly orgId: string;
    readonly clerkUserId: string;
    readonly provider: string;
  }): Promise<OAuthAttemptStart> {
    const orgId = canonicalIdentifier(input.orgId, "organization");
    const clerkUserId = canonicalIdentifier(input.clerkUserId, "Clerk user");
    const provider = canonicalProvider(input.provider);
    if (provider !== SUPPORTED_PROVIDER) {
      throw new BadRequestException(
        `OAuth provider is not available in this release: ${provider}`,
      );
    }
    const expiresAtMs = Date.now() + OAUTH_ATTEMPT_TTL_MS;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const attemptId = crypto.randomBytes(32).toString("base64url");
      const record: StoredOAuthAttempt = {
        version: 1,
        attemptId,
        provider,
        orgId,
        clerkUserId,
        expiresAtMs,
        status: "INITIATED",
      };
      const state = signOAuthAttemptState({ attemptId, provider, expiresAtMs });
      if (await this.putIfAbsent(record)) {
        return {
          attemptId,
          state,
          expiresAt: new Date(expiresAtMs),
        };
      }
    }

    throw new ServiceUnavailableException("Could not allocate OAuth attempt");
  }

  async parkAuthorizationCode(input: {
    readonly state: string;
    readonly expectedProvider: string;
    readonly code: string;
  }): Promise<{ readonly attemptId: string; readonly provider: string }> {
    const expectedProvider = canonicalProvider(input.expectedProvider);
    const code = canonicalAuthorizationCode(input.code);
    let verified: ReturnType<typeof verifyOAuthAttemptState>;
    try {
      verified = verifyOAuthAttemptState(input.state);
    } catch {
      throw new BadRequestException("Invalid or expired OAuth state");
    }
    if (verified.provider !== expectedProvider) {
      throw new ForbiddenException("OAuth provider does not match the attempt");
    }

    const encryptedCode = encrypt(code);
    const outcome = await this.parkCode(
      verified.attemptId,
      expectedProvider,
      encryptedCode,
    );
    if (outcome === "MISSING") {
      throw new GoneException("OAuth attempt is unavailable or expired");
    }
    if (outcome === "REPLAY") {
      throw new ConflictException("OAuth callback was already processed");
    }
    if (outcome === "PROVIDER_MISMATCH") {
      throw new ForbiddenException("OAuth provider does not match the attempt");
    }

    return { attemptId: verified.attemptId, provider: expectedProvider };
  }

  async consumeAuthorizationCode(input: {
    readonly attemptId: string;
    readonly orgId: string;
    readonly clerkUserId: string;
    readonly provider: string;
  }): Promise<string> {
    const attemptId = canonicalAttemptId(input.attemptId);
    const orgId = canonicalIdentifier(input.orgId, "organization");
    const clerkUserId = canonicalIdentifier(input.clerkUserId, "Clerk user");
    const provider = canonicalProvider(input.provider);

    const outcome = await this.consumeCode({
      attemptId,
      orgId,
      clerkUserId,
      provider,
    });
    if (outcome.kind === "MISSING") {
      throw new GoneException("OAuth attempt is unavailable, expired, or used");
    }
    if (outcome.kind === "NOT_READY") {
      throw new ConflictException("OAuth callback is not ready for finalization");
    }
    if (outcome.kind === "PROVIDER_MISMATCH") {
      throw new ForbiddenException("OAuth provider does not match the attempt");
    }
    if (outcome.kind === "ACTOR_MISMATCH") {
      throw new ForbiddenException("OAuth attempt belongs to another user or organization");
    }
    if (outcome.kind === "CORRUPT") {
      throw new ServiceUnavailableException("OAuth attempt is invalid");
    }

    try {
      return decrypt(outcome.encryptedCode);
    } catch {
      throw new ServiceUnavailableException("OAuth attempt could not be decrypted");
    }
  }

  private async putIfAbsent(record: StoredOAuthAttempt): Promise<boolean> {
    const key = redisKey(record.attemptId);
    if (this.redis) {
      try {
        const result = await this.redis.set(
          key,
          JSON.stringify(record),
          "PX",
          OAUTH_ATTEMPT_TTL_MS,
          "NX",
        );
        return result === "OK";
      } catch (err) {
        throw redisUnavailable(err);
      }
    }

    const memory = this.requireMemory();
    this.dropExpiredMemoryRecord(key);
    if (memory.has(key)) return false;
    memory.set(key, record);
    return true;
  }

  private async parkCode(
    attemptId: string,
    provider: string,
    encryptedCode: string,
  ): Promise<"PARKED" | "MISSING" | "REPLAY" | "PROVIDER_MISMATCH"> {
    const key = redisKey(attemptId);
    if (this.redis) {
      let result: unknown;
      try {
        result = await this.redis.eval(
          PARK_CODE_LUA,
          1,
          key,
          provider,
          encryptedCode,
        );
      } catch (err) {
        throw redisUnavailable(err);
      }
      if (result === 1) return "PARKED";
      if (result === -1) return "MISSING";
      if (result === -2) return "REPLAY";
      if (result === -3) return "PROVIDER_MISMATCH";
      throw new ServiceUnavailableException("OAuth attempt storage returned an invalid result");
    }

    const memory = this.requireMemory();
    const record = this.dropExpiredMemoryRecord(key);
    if (!record) return "MISSING";
    if (record.provider !== provider) return "PROVIDER_MISMATCH";
    if (record.status !== "INITIATED") return "REPLAY";
    memory.set(key, { ...record, status: "CODE_PARKED", encryptedCode });
    return "PARKED";
  }

  private async consumeCode(input: {
    readonly attemptId: string;
    readonly orgId: string;
    readonly clerkUserId: string;
    readonly provider: string;
  }): Promise<
    | { readonly kind: "CONSUMED"; readonly encryptedCode: string }
    | { readonly kind: "MISSING" }
    | { readonly kind: "NOT_READY" }
    | { readonly kind: "PROVIDER_MISMATCH" }
    | { readonly kind: "ACTOR_MISMATCH" }
    | { readonly kind: "CORRUPT" }
  > {
    const key = redisKey(input.attemptId);
    if (this.redis) {
      let result: unknown;
      try {
        result = await this.redis.eval(
          CONSUME_CODE_LUA,
          1,
          key,
          input.provider,
          input.orgId,
          input.clerkUserId,
        );
      } catch (err) {
        throw redisUnavailable(err);
      }
      if (!Array.isArray(result) || typeof result[0] !== "number") {
        throw new ServiceUnavailableException("OAuth attempt storage returned an invalid result");
      }
      if (result[0] === -1) return { kind: "MISSING" };
      if (result[0] === -2) return { kind: "NOT_READY" };
      if (result[0] === -3) return { kind: "PROVIDER_MISMATCH" };
      if (result[0] === -4) return { kind: "ACTOR_MISMATCH" };
      if (result[0] === -5) return { kind: "CORRUPT" };
      if (result[0] === 1 && typeof result[1] === "string") {
        return { kind: "CONSUMED", encryptedCode: result[1] };
      }
      throw new ServiceUnavailableException("OAuth attempt storage returned an invalid result");
    }

    const memory = this.requireMemory();
    const record = this.dropExpiredMemoryRecord(key);
    if (!record) return { kind: "MISSING" };
    if (record.provider !== input.provider) return { kind: "PROVIDER_MISMATCH" };
    if (record.orgId !== input.orgId || record.clerkUserId !== input.clerkUserId) {
      return { kind: "ACTOR_MISMATCH" };
    }
    if (record.status !== "CODE_PARKED") return { kind: "NOT_READY" };
    if (!record.encryptedCode) return { kind: "CORRUPT" };

    // Delete before decrypting or invoking Gmail. Concurrent or retried
    // finalization requests can never receive the provider code twice.
    memory.delete(key);
    return { kind: "CONSUMED", encryptedCode: record.encryptedCode };
  }

  private dropExpiredMemoryRecord(key: string): StoredOAuthAttempt | undefined {
    const memory = this.requireMemory();
    const record = memory.get(key);
    if (record && record.expiresAtMs <= Date.now()) {
      memory.delete(key);
      return undefined;
    }
    return record;
  }

  private requireMemory(): Map<string, StoredOAuthAttempt> {
    if (!this.memory) {
      throw new ServiceUnavailableException("OAuth attempt storage is unavailable");
    }
    return this.memory;
  }
}

function canonicalAttemptId(value: string): string {
  if (typeof value !== "string" || !ATTEMPT_ID_PATTERN.test(value)) {
    throw new BadRequestException("OAuth attempt id is invalid");
  }
  return value;
}

function canonicalProvider(value: string): string {
  if (typeof value !== "string" || !PROVIDER_PATTERN.test(value)) {
    throw new BadRequestException("OAuth provider is invalid");
  }
  return value;
}

function canonicalIdentifier(value: string, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 255 ||
    value !== value.trim()
  ) {
    throw new BadRequestException(`${label} id is invalid`);
  }
  return value;
}

function canonicalAuthorizationCode(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_AUTHORIZATION_CODE_LENGTH ||
    value !== value.trim()
  ) {
    throw new BadRequestException("OAuth authorization code is invalid");
  }
  return value;
}

function redisKey(attemptId: string): string {
  return `${KEY_PREFIX}:${attemptId}`;
}

function redisUnavailable(err: unknown): ServiceUnavailableException {
  void err;
  return new ServiceUnavailableException("OAuth attempt storage is unavailable");
}
