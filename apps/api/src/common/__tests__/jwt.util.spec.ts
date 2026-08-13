import { generateKeyPairSync, sign } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invalidateJWKSCache, verifyClerkToken } from "../jwt.util";

const ISSUER = "https://clerk.example.test";
const AUTHORIZED_PARTY = "https://workforceos.xyz";
const KEY_ID = "clerk-key-1";
const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicJwk = {
  ...keyPair.publicKey.export({ format: "jwk" }),
  use: "sig",
  alg: "RS256",
  kid: KEY_ID,
};

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function signToken(
  payload: Record<string, unknown>,
  header: Record<string, unknown> = { alg: "RS256", kid: KEY_ID },
): string {
  const encodedHeader = encodeJson(header);
  const encodedPayload = encodeJson(payload);
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = sign("RSA-SHA256", Buffer.from(signingInput), keyPair.privateKey);
  return `${signingInput}.${signature.toString("base64url")}`;
}

function validClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    sub: "user_clerk_1",
    iss: ISSUER,
    azp: AUTHORIZED_PARTY,
    iat: now - 5,
    exp: now + 300,
    ...overrides,
  };
}

describe("verifyClerkToken claim policy", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("CLERK_JWKS_URL", `${ISSUER}/.well-known/jwks.json`);
    vi.stubEnv("CLERK_ISSUER", ISSUER);
    vi.stubEnv("CLERK_DOMAIN", undefined);
    vi.stubEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", undefined);
    vi.stubEnv("CLERK_AUTHORIZED_PARTIES", AUTHORIZED_PARTY);
    vi.stubEnv("CLERK_AUDIENCE", undefined);
    invalidateJWKSCache();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ keys: [publicJwk] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
  });

  afterEach(() => {
    invalidateJWKSCache();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("accepts a valid session token without org_id or audience", async () => {
    await expect(verifyClerkToken(signToken(validClaims()))).resolves.toMatchObject({
      sub: "user_clerk_1",
      iss: ISSUER,
    });
  });

  it.each(["sub", "exp", "iat"] as const)("rejects a token missing %s", async (claim) => {
    const payload = validClaims();
    delete payload[claim];
    await expect(verifyClerkToken(signToken(payload))).rejects.toThrow(claim);
  });

  it("rejects non-canonical subjects and incomplete organization claim tuples", async () => {
    await expect(
      verifyClerkToken(signToken(validClaims({ sub: " user_clerk_1 " }))),
    ).rejects.toThrow("canonical");
    await expect(
      verifyClerkToken(
        signToken(validClaims({ org_role: "org:admin" })),
      ),
    ).rejects.toThrow("present together");
    await expect(
      verifyClerkToken(signToken(validClaims({ org_id: "org_clerk_1" }))),
    ).rejects.toThrow("present together");
    await expect(
      verifyClerkToken(
        signToken(
          validClaims({
            org_id: "org_clerk_1",
            org_role: "org:admin",
          }),
        ),
      ),
    ).resolves.toMatchObject({
      org_id: "org_clerk_1",
      org_role: "org:admin",
    });
  });

  it("rejects an expired token", async () => {
    const now = Math.floor(Date.now() / 1000);
    await expect(
      verifyClerkToken(signToken(validClaims({ iat: now - 60, exp: now - 1 }))),
    ).rejects.toThrow("expired");
  });

  it("rejects the wrong issuer", async () => {
    await expect(
      verifyClerkToken(signToken(validClaims({ iss: "https://other.example" }))),
    ).rejects.toThrow("issuer");
  });

  it("rejects a missing or unauthorized azp when authorized parties are configured", async () => {
    const missingAzp = validClaims();
    delete missingAzp.azp;
    await expect(verifyClerkToken(signToken(missingAzp))).rejects.toThrow("azp");
    await expect(
      verifyClerkToken(signToken(validClaims({ azp: "https://evil.example" }))),
    ).rejects.toThrow("authorized party");
  });

  it("validates audience only when CLERK_AUDIENCE is configured", async () => {
    vi.stubEnv("CLERK_AUDIENCE", "workforce-api");
    await expect(
      verifyClerkToken(signToken(validClaims({ aud: "other-api" }))),
    ).rejects.toThrow("audience");
    await expect(
      verifyClerkToken(signToken(validClaims({ aud: ["other-api", "workforce-api"] }))),
    ).resolves.toMatchObject({ sub: "user_clerk_1" });
  });

  it("rejects future nbf and future iat claims", async () => {
    const now = Math.floor(Date.now() / 1000);
    await expect(
      verifyClerkToken(signToken(validClaims({ nbf: now + 60 }))),
    ).rejects.toThrow("not active");
    await expect(
      verifyClerkToken(signToken(validClaims({ iat: now + 60, exp: now + 360 }))),
    ).rejects.toThrow("future");
  });

  it("requires RS256 and an exact nonempty kid", async () => {
    await expect(
      verifyClerkToken(signToken(validClaims(), { alg: "PS256", kid: KEY_ID })),
    ).rejects.toThrow("RS256");
    await expect(
      verifyClerkToken(signToken(validClaims(), { alg: "RS256" })),
    ).rejects.toThrow("kid");
    await expect(
      verifyClerkToken(signToken(validClaims(), { alg: "RS256", kid: "unknown-key" })),
    ).rejects.toThrow("matching JWK");
  });

  it("fails closed in production when authorized parties are not configured", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CLERK_AUTHORIZED_PARTIES", undefined);
    await expect(verifyClerkToken(signToken(validClaims()))).rejects.toThrow(
      "CLERK_AUTHORIZED_PARTIES is required in production",
    );
  });
});
