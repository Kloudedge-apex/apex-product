import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { Redis } from "ioredis";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { signOAuthAttemptState } from "../../common/webhook-signature.util";
import { _resetCryptoKeyCacheForTests, decrypt } from "../crypto.util";
import {
  OAUTH_ATTEMPT_TTL_MS,
  OAuthAttemptService,
} from "../oauth-attempt.service";

const ORG_ID = "org_1";
const CLERK_USER_ID = "user_1";
const PROVIDER_CODE = "google-authorization-code-secret";
const HEX_KEY = "a".repeat(64);

describe("OAuthAttemptService", () => {
  let service: OAuthAttemptService;

  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("REDIS_URL", "");
    vi.stubEnv("REDIS_HOST", "");
    vi.stubEnv("OAUTH_STATE_SECRET", "s".repeat(32));
    vi.stubEnv("ENCRYPTION_KEY", HEX_KEY);
    _resetCryptoKeyCacheForTests();
    service = new OAuthAttemptService();
  });

  afterEach(() => {
    service.onModuleDestroy();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    _resetCryptoKeyCacheForTests();
  });

  it("parks and consumes one encrypted code exactly once", async () => {
    const started = await startAttempt(service);

    await expect(
      service.parkAuthorizationCode({
        state: started.state,
        expectedProvider: "gmail",
        code: PROVIDER_CODE,
      }),
    ).resolves.toEqual({ attemptId: started.attemptId, provider: "gmail" });

    await expect(
      service.consumeAuthorizationCode({
        attemptId: started.attemptId,
        orgId: ORG_ID,
        clerkUserId: CLERK_USER_ID,
        provider: "gmail",
      }),
    ).resolves.toBe(PROVIDER_CODE);

    await expect(
      service.consumeAuthorizationCode({
        attemptId: started.attemptId,
        orgId: ORG_ID,
        clerkUserId: CLERK_USER_ID,
        provider: "gmail",
      }),
    ).rejects.toBeInstanceOf(GoneException);
  });

  it("rejects callback replay without replacing the parked code", async () => {
    const started = await startAttempt(service);
    await service.parkAuthorizationCode({
      state: started.state,
      expectedProvider: "gmail",
      code: PROVIDER_CODE,
    });

    await expect(
      service.parkAuthorizationCode({
        state: started.state,
        expectedProvider: "gmail",
        code: "attacker-replacement-code",
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    await expect(
      service.consumeAuthorizationCode({
        attemptId: started.attemptId,
        orgId: ORG_ID,
        clerkUserId: CLERK_USER_ID,
        provider: "gmail",
      }),
    ).resolves.toBe(PROVIDER_CODE);
  });

  it("fails closed before the provider callback has parked a code", async () => {
    const started = await startAttempt(service);

    await expect(
      service.consumeAuthorizationCode({
        attemptId: started.attemptId,
        orgId: ORG_ID,
        clerkUserId: CLERK_USER_ID,
        provider: "gmail",
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("expires both callback state and the pending attempt", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T10:00:00.000Z"));
    service = new OAuthAttemptService();
    const started = await startAttempt(service);

    vi.advanceTimersByTime(OAUTH_ATTEMPT_TTL_MS + 1);
    await expect(
      service.parkAuthorizationCode({
        state: started.state,
        expectedProvider: "gmail",
        code: PROVIDER_CODE,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.consumeAuthorizationCode({
        attemptId: started.attemptId,
        orgId: ORG_ID,
        clerkUserId: CLERK_USER_ID,
        provider: "gmail",
      }),
    ).rejects.toBeInstanceOf(GoneException);
  });

  it("does not consume on a wrong user, organization, or provider", async () => {
    const started = await startAttempt(service);
    await service.parkAuthorizationCode({
      state: started.state,
      expectedProvider: "gmail",
      code: PROVIDER_CODE,
    });

    for (const mismatch of [
      { orgId: "org_other", clerkUserId: CLERK_USER_ID, provider: "gmail" },
      { orgId: ORG_ID, clerkUserId: "user_other", provider: "gmail" },
      { orgId: ORG_ID, clerkUserId: CLERK_USER_ID, provider: "outlook" },
    ]) {
      await expect(
        service.consumeAuthorizationCode({
          attemptId: started.attemptId,
          ...mismatch,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    }

    await expect(
      service.consumeAuthorizationCode({
        attemptId: started.attemptId,
        orgId: ORG_ID,
        clerkUserId: CLERK_USER_ID,
        provider: "gmail",
      }),
    ).resolves.toBe(PROVIDER_CODE);
  });

  it("rejects malformed state and a state issued for another provider", async () => {
    await expect(
      service.parkAuthorizationCode({
        state: "not-a-signed-state",
        expectedProvider: "gmail",
        code: PROVIDER_CODE,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    const outlookState = signOAuthAttemptState({
      attemptId: "c".repeat(43),
      provider: "outlook",
      expiresAtMs: Date.now() + 60_000,
    });
    await expect(
      service.parkAuthorizationCode({
        state: outlookState,
        expectedProvider: "gmail",
        code: PROVIDER_CODE,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    await expect(
      service.start({
        orgId: ORG_ID,
        clerkUserId: CLERK_USER_ID,
        provider: "outlook",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("passes only encrypted provider code to Redis", async () => {
    const evalMock = vi.fn().mockResolvedValue(1);
    const redis = {
      eval: evalMock,
    } as unknown as Redis;
    const redisService = new OAuthAttemptService(redis);
    const attemptId = "a".repeat(43);
    const state = signOAuthAttemptState({
      attemptId,
      provider: "gmail",
      expiresAtMs: Date.now() + 60_000,
    });

    await redisService.parkAuthorizationCode({
      state,
      expectedProvider: "gmail",
      code: PROVIDER_CODE,
    });

    const encryptedCode = evalMock.mock.calls[0][4] as string;
    expect(encryptedCode).not.toContain(PROVIDER_CODE);
    expect(decrypt(encryptedCode)).toBe(PROVIDER_CODE);
  });

  it("fails closed when Redis fails during start, callback, or finalization", async () => {
    const redis = {
      set: vi.fn().mockRejectedValue(new Error("redis unavailable")),
      eval: vi.fn().mockRejectedValue(new Error("redis unavailable")),
    } as unknown as Redis;
    const redisService = new OAuthAttemptService(redis);

    await expect(startAttempt(redisService)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );

    const attemptId = "b".repeat(43);
    const state = signOAuthAttemptState({
      attemptId,
      provider: "gmail",
      expiresAtMs: Date.now() + 60_000,
    });
    await expect(
      redisService.parkAuthorizationCode({
        state,
        expectedProvider: "gmail",
        code: PROVIDER_CODE,
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(
      redisService.consumeAuthorizationCode({
        attemptId,
        orgId: ORG_ID,
        clerkUserId: CLERK_USER_ID,
        provider: "gmail",
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it.each(["production", "staging"])(
    "refuses an in-memory attempt store in %s",
    (nodeEnv) => {
      vi.stubEnv("NODE_ENV", nodeEnv);
      expect(() => new OAuthAttemptService()).toThrow(/Redis/i);
    },
  );
});

function startAttempt(service: OAuthAttemptService) {
  return service.start({
    orgId: ORG_ID,
    clerkUserId: CLERK_USER_ID,
    provider: "gmail",
  });
}
