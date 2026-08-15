/**
 * Clerk JWT verification utility.
 *
 * Signature verification is necessary but not sufficient: a token must also
 * be a current Workforce OS session token issued for the configured Clerk
 * instance and, in production, for an explicitly authorized browser origin.
 */

import { readResponseTextWithLimit } from "./http-body.util";

interface JWK {
  kty: string;
  use?: string;
  alg?: string;
  kid: string;
  n: string;
  e: string;
}

interface JWKSResponse {
  keys: JWK[];
}

export interface ClerkTokenPayload {
  sub: string;
  org_id?: string;
  org_role?: string;
  email?: string;
  iss: string;
  aud?: string | string[];
  azp?: string;
  exp: number;
  iat: number;
  nbf?: number;
}

interface CachedKeys {
  keys: JWK[];
  fetchedAt: number;
  jwksUrl: string;
}

interface ClerkVerificationConfig {
  jwksUrl: string;
  issuer: string;
  audiences: string[];
  authorizedParties: string[];
}

interface JWTHeader {
  kid?: unknown;
  alg?: unknown;
}

const JWKS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const JWKS_FETCH_TIMEOUT_MS = 5_000;
const JWKS_MAX_RESPONSE_BYTES = 256 * 1024;
const UNKNOWN_KID_REFRESH_COOLDOWN_MS = 60_000;
const UNKNOWN_KID_CACHE_TTL_MS = 60_000;
const UNKNOWN_KID_CACHE_MAX_ENTRIES = 256;
let cachedKeys: CachedKeys | null = null;
let jwksFetchInFlight:
  | { jwksUrl: string; promise: Promise<JWK[]> }
  | null = null;
const lastUnknownKidRefreshAt = new Map<string, number>();
const unknownKidCache = new Map<string, number>();

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function assertSafeProtocol(url: URL, label: string): void {
  if (url.protocol === "https:") return;
  if (process.env.NODE_ENV !== "production" && url.protocol === "http:" && isLoopbackHostname(url.hostname)) {
    return;
  }
  throw new Error(`${label} must use https (http is allowed only for loopback in non-production)`);
}

function parseOrigin(raw: string, label: string): string {
  let url: URL;
  try {
    url = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    throw new Error(`${label} must be a valid origin`);
  }
  assertSafeProtocol(url, label);
  if (url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== "/")) {
    throw new Error(`${label} must be an origin without credentials, path, query, or fragment`);
  }
  return url.origin;
}

function parseUrl(raw: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  assertSafeProtocol(url, label);
  if (url.username || url.password || url.hash) {
    throw new Error(`${label} must not contain credentials or a fragment`);
  }
  return url;
}

function issuerFromPublishableKey(key: string): string {
  const match = /^pk_(?:test|live)_(.+)$/.exec(key);
  if (!match) throw new Error("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY has an invalid format");

  let decoded: string;
  try {
    decoded = Buffer.from(match[1], "base64").toString("utf8").replace(/\$$/, "");
  } catch {
    throw new Error("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY could not be decoded");
  }
  if (!decoded) throw new Error("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY decoded to an empty domain");
  return parseOrigin(decoded, "decoded Clerk publishable-key domain");
}

function parseCommaSeparated(raw: string | undefined, label: string): string[] {
  if (raw === undefined || raw.trim().length === 0) return [];
  const values = raw.split(",").map((value) => value.trim()).filter(Boolean);
  if (values.length === 0) throw new Error(`${label} is configured but empty`);
  return values;
}

function resolveClerkVerificationConfig(): ClerkVerificationConfig {
  const explicitJwksUrl = process.env.CLERK_JWKS_URL?.trim();
  const explicitIssuer = process.env.CLERK_ISSUER?.trim();
  const clerkDomain = process.env.CLERK_DOMAIN?.trim();
  const publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.trim();

  let issuer: string;
  if (explicitIssuer) {
    issuer = parseOrigin(explicitIssuer, "CLERK_ISSUER");
  } else if (clerkDomain) {
    issuer = parseOrigin(clerkDomain, "CLERK_DOMAIN");
  } else if (publishableKey) {
    issuer = issuerFromPublishableKey(publishableKey);
  } else if (explicitJwksUrl) {
    issuer = parseUrl(explicitJwksUrl, "CLERK_JWKS_URL").origin;
  } else {
    throw new Error(
      "CLERK_ISSUER, CLERK_DOMAIN, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY, or CLERK_JWKS_URL is required",
    );
  }

  const jwksUrl = explicitJwksUrl
    ? parseUrl(explicitJwksUrl, "CLERK_JWKS_URL").toString()
    : `${issuer}/.well-known/jwks.json`;

  const authorizedPartyValues = parseCommaSeparated(
    process.env.CLERK_AUTHORIZED_PARTIES,
    "CLERK_AUTHORIZED_PARTIES",
  );
  if (process.env.NODE_ENV === "production" && authorizedPartyValues.length === 0) {
    throw new Error(
      "CLERK_AUTHORIZED_PARTIES is required in production so the JWT azp claim can be validated",
    );
  }

  return {
    jwksUrl,
    issuer,
    audiences: parseCommaSeparated(process.env.CLERK_AUDIENCE, "CLERK_AUDIENCE"),
    authorizedParties: authorizedPartyValues.map((value, index) =>
      parseOrigin(value, `CLERK_AUTHORIZED_PARTIES[${index}]`),
    ),
  };
}

function hasFreshCachedKeys(jwksUrl: string, now = Date.now()): boolean {
  return Boolean(
    cachedKeys &&
      cachedKeys.jwksUrl === jwksUrl &&
      now - cachedKeys.fetchedAt < JWKS_CACHE_TTL_MS,
  );
}

async function fetchJWKS(jwksUrl: string): Promise<JWK[]> {
  if (jwksFetchInFlight?.jwksUrl === jwksUrl) {
    return jwksFetchInFlight.promise;
  }

  const promise = (async (): Promise<JWK[]> => {
    const response = await fetch(jwksUrl, {
      signal: AbortSignal.timeout(JWKS_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch JWKS from Clerk: ${response.status}`);
    }

    const raw = await readResponseTextWithLimit(
      response,
      JWKS_MAX_RESPONSE_BYTES,
    );
    let data: Partial<JWKSResponse>;
    try {
      data = JSON.parse(raw) as Partial<JWKSResponse>;
    } catch {
      throw new Error("Clerk JWKS response was not valid JSON");
    }
    if (!Array.isArray(data.keys) || data.keys.length === 0) {
      throw new Error("Clerk JWKS response did not contain any keys");
    }
    cachedKeys = {
      keys: data.keys,
      fetchedAt: Date.now(),
      jwksUrl,
    };
    return data.keys;
  })();
  jwksFetchInFlight = { jwksUrl, promise };
  try {
    return await promise;
  } finally {
    if (jwksFetchInFlight?.promise === promise) jwksFetchInFlight = null;
  }
}

async function getJWKS(jwksUrl: string): Promise<JWK[]> {
  const now = Date.now();
  if (
    hasFreshCachedKeys(jwksUrl, now) &&
    cachedKeys
  ) {
    return cachedKeys.keys;
  }

  return fetchJWKS(jwksUrl);
}

function unknownKidCacheKey(jwksUrl: string, kid: string): string {
  return `${jwksUrl}\u0000${kid}`;
}

function isUnknownKidCached(jwksUrl: string, kid: string, now: number): boolean {
  const key = unknownKidCacheKey(jwksUrl, kid);
  const expiresAt = unknownKidCache.get(key);
  if (expiresAt === undefined) return false;
  if (now >= expiresAt) {
    unknownKidCache.delete(key);
    return false;
  }
  return true;
}

function rememberUnknownKid(jwksUrl: string, kid: string, now: number): void {
  const cacheKey = unknownKidCacheKey(jwksUrl, kid);
  const existingExpiry = unknownKidCache.get(cacheKey);
  if (existingExpiry !== undefined && now < existingExpiry) {
    return;
  }
  for (const [key, expiresAt] of unknownKidCache) {
    if (now >= expiresAt) unknownKidCache.delete(key);
  }
  while (unknownKidCache.size >= UNKNOWN_KID_CACHE_MAX_ENTRIES) {
    const oldest = unknownKidCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    unknownKidCache.delete(oldest);
  }
  unknownKidCache.set(cacheKey, now + UNKNOWN_KID_CACHE_TTL_MS);
}

function decodeJWT(token: string): { header: JWTHeader; payload: Record<string, unknown> } {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid JWT format");

  const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as JWTHeader;
  const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
  return { header, payload };
}

async function jwkToCryptoKey(jwk: JWK): Promise<CryptoKey> {
  if (jwk.kty !== "RSA" || (jwk.use && jwk.use !== "sig") || (jwk.alg && jwk.alg !== "RS256")) {
    throw new Error("Matching JWK is not an RS256 signing key");
  }
  return crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, use: jwk.use, alg: jwk.alg, n: jwk.n, e: jwk.e },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
}

function requireNumericDate(payload: Record<string, unknown>, claim: "exp" | "iat" | "nbf"): number {
  const value = payload[claim];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`JWT ${claim} claim must be a finite NumericDate`);
  }
  return value;
}

function validateAudience(payload: Record<string, unknown>, expected: string[]): void {
  if (expected.length === 0) return;
  const raw = payload.aud;
  const tokenAudiences = typeof raw === "string"
    ? [raw]
    : Array.isArray(raw) && raw.every((value) => typeof value === "string")
      ? raw
      : [];
  if (!expected.some((audience) => tokenAudiences.includes(audience))) {
    throw new Error("JWT audience is not authorized");
  }
}

function validatePayload(
  rawPayload: Record<string, unknown>,
  config: ClerkVerificationConfig,
): ClerkTokenPayload {
  if (
    typeof rawPayload.sub !== "string" ||
    rawPayload.sub.trim().length === 0 ||
    rawPayload.sub !== rawPayload.sub.trim()
  ) {
    throw new Error("JWT sub claim must be a canonical nonempty string");
  }
  if (rawPayload.iss !== config.issuer) {
    throw new Error("JWT issuer is not authorized");
  }

  const now = Math.floor(Date.now() / 1000);
  const exp = requireNumericDate(rawPayload, "exp");
  const iat = requireNumericDate(rawPayload, "iat");
  if (exp <= now) throw new Error("JWT token has expired");
  if (iat > now) throw new Error("JWT iat claim is in the future");
  if (exp <= iat) throw new Error("JWT exp claim must be later than iat");
  if (rawPayload.nbf !== undefined && requireNumericDate(rawPayload, "nbf") > now) {
    throw new Error("JWT token is not active yet");
  }

  validateAudience(rawPayload, config.audiences);

  if (config.authorizedParties.length > 0) {
    if (typeof rawPayload.azp !== "string" || rawPayload.azp.length === 0) {
      throw new Error("JWT azp claim is required");
    }
    let tokenParty: string;
    try {
      tokenParty = parseOrigin(rawPayload.azp, "JWT azp claim");
    } catch {
      throw new Error("JWT azp claim is not a valid authorized-party origin");
    }
    if (!config.authorizedParties.includes(tokenParty)) {
      throw new Error("JWT authorized party is not allowed");
    }
  }

  if (
    rawPayload.org_id !== undefined &&
    (typeof rawPayload.org_id !== "string" ||
      rawPayload.org_id.trim().length === 0 ||
      rawPayload.org_id !== rawPayload.org_id.trim())
  ) {
    throw new Error(
      "JWT org_id claim must be a canonical nonempty string when present",
    );
  }
  if (
    rawPayload.org_role !== undefined &&
    (typeof rawPayload.org_role !== "string" ||
      rawPayload.org_role.trim().length === 0 ||
      rawPayload.org_role !== rawPayload.org_role.trim())
  ) {
    throw new Error(
      "JWT org_role claim must be a canonical nonempty string when present",
    );
  }
  if (
    (rawPayload.org_id === undefined) !==
    (rawPayload.org_role === undefined)
  ) {
    throw new Error("JWT org_id and org_role claims must be present together");
  }

  return rawPayload as unknown as ClerkTokenPayload;
}

function findExactJwk(keys: JWK[], kid: string): JWK | undefined {
  const matches = keys.filter((candidate) => candidate.kid === kid);
  if (matches.length > 1) throw new Error("Clerk JWKS contains duplicate keys for token kid");
  return matches[0];
}

/** Verify a Clerk RS256 session JWT and return its validated claims. */
export async function verifyClerkToken(token: string): Promise<ClerkTokenPayload> {
  const { header, payload } = decodeJWT(token);
  if (header.alg !== "RS256") throw new Error("JWT alg must be RS256");
  if (typeof header.kid !== "string" || header.kid.trim().length === 0) {
    throw new Error("JWT kid header is required");
  }

  const config = resolveClerkVerificationConfig();
  const lookupStartedAt = Date.now();
  const hadFreshCache = hasFreshCachedKeys(config.jwksUrl, lookupStartedAt);
  let keys = await getJWKS(config.jwksUrl);
  let jwk = findExactJwk(keys, header.kid);
  if (!jwk && hadFreshCache) {
    const now = Date.now();
    const lastRefresh = lastUnknownKidRefreshAt.get(config.jwksUrl) ?? 0;
    if (
      !isUnknownKidCached(config.jwksUrl, header.kid, now) &&
      now - lastRefresh >= UNKNOWN_KID_REFRESH_COOLDOWN_MS
    ) {
      // Allow one bounded refresh for a legitimate Clerk key rotation. The
      // timestamp is set before awaiting so concurrent attacker-controlled
      // kids cannot each start their own outbound refresh.
      lastUnknownKidRefreshAt.set(config.jwksUrl, now);
      keys = await fetchJWKS(config.jwksUrl);
      jwk = findExactJwk(keys, header.kid);
    }
  }
  if (!jwk) {
    rememberUnknownKid(config.jwksUrl, header.kid, Date.now());
    throw new Error("No matching JWK found for token kid");
  }

  const cryptoKey = await jwkToCryptoKey(jwk);
  const parts = token.split(".");
  const signingInput = `${parts[0]}.${parts[1]}`;
  const signature = Buffer.from(parts[2], "base64url");
  const isValid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    signature,
    new TextEncoder().encode(signingInput),
  );
  if (!isValid) throw new Error("JWT signature verification failed");

  return validatePayload(payload, config);
}

/** Invalidate the JWKS cache (used after key rotation and by focused tests). */
export function invalidateJWKSCache(): void {
  cachedKeys = null;
  jwksFetchInFlight = null;
  lastUnknownKidRefreshAt.clear();
  unknownKidCache.clear();
}
