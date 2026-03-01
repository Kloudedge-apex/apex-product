/**
 * Clerk JWT verification utility.
 * Fetches the Clerk JWKS public keys and verifies incoming JWTs.
 * Keys are cached in memory and refreshed every 24 hours.
 */

interface JWK {
    kty: string;
    use: string;
    kid: string;
    n: string;
    e: string;
}

interface JWKSResponse {
    keys: JWK[];
}

interface ClerkTokenPayload {
    sub: string;
    org_id?: string;
    org_role?: string;
    email?: string;
    iss: string;
    exp: number;
    iat: number;
}

interface CachedKeys {
    keys: JWK[];
    fetchedAt: number;
}

const JWKS_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
let cachedKeys: CachedKeys | null = null;

async function getJWKS(): Promise<JWK[]> {
    const now = Date.now();
    if (cachedKeys && now - cachedKeys.fetchedAt < JWKS_CACHE_TTL_MS) {
        return cachedKeys.keys;
    }

    const clerkDomain = process.env.CLERK_DOMAIN || process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
    if (!clerkDomain) {
        throw new Error("CLERK_DOMAIN or NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY env var is required for JWT verification");
    }

    // Extract domain from publishable key (pk_test_xxx -> extract the base64 domain)
    let jwksUrl: string;
    if (process.env.CLERK_JWKS_URL) {
        jwksUrl = process.env.CLERK_JWKS_URL;
    } else if (clerkDomain.startsWith("pk_")) {
        // Clerk publishable key format: pk_test_<base64-encoded-domain>
        const parts = clerkDomain.split("_");
        if (parts.length >= 3) {
            const encoded = parts.slice(2).join("_");
            const domain = Buffer.from(encoded, "base64").toString("utf-8").replace(/\$/g, "");
            jwksUrl = `https://${domain}/.well-known/jwks.json`;
        } else {
            throw new Error("Invalid CLERK_PUBLISHABLE_KEY format");
        }
    } else {
        jwksUrl = `https://${clerkDomain}/.well-known/jwks.json`;
    }

    const response = await fetch(jwksUrl);
    if (!response.ok) {
        throw new Error(`Failed to fetch JWKS from Clerk: ${response.status}`);
    }

    const data = (await response.json()) as JWKSResponse;
    cachedKeys = { keys: data.keys, fetchedAt: now };
    return data.keys;
}

/**
 * Decode a JWT without verification (for extracting the kid header).
 */
function decodeJWT(token: string): { header: { kid?: string; alg?: string }; payload: ClerkTokenPayload } {
    const parts = token.split(".");
    if (parts.length !== 3) {
        throw new Error("Invalid JWT format");
    }

    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString()) as { kid?: string; alg?: string };
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString()) as ClerkTokenPayload;

    return { header, payload };
}

/**
 * Convert a JWK to a CryptoKey for verification.
 */
async function jwkToCryptoKey(jwk: JWK): Promise<CryptoKey> {
    return crypto.subtle.importKey(
        "jwk",
        { kty: jwk.kty, use: jwk.use, n: jwk.n, e: jwk.e },
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
    );
}

/**
 * Verify a Clerk JWT token and return the decoded payload.
 * Throws if the token is invalid, expired, or signature fails.
 */
export async function verifyClerkToken(token: string): Promise<ClerkTokenPayload> {
    const { header, payload } = decodeJWT(token);

    // Check expiry first (fast fail before network call)
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) {
        throw new Error("JWT token has expired");
    }

    const keys = await getJWKS();

    // Find the matching key by kid
    const jwk = header.kid ? keys.find((k) => k.kid === header.kid) : keys[0];
    if (!jwk) {
        // Key not found — try invalidating cache and re-fetching once
        cachedKeys = null;
        const freshKeys = await getJWKS();
        const freshJwk = header.kid ? freshKeys.find((k) => k.kid === header.kid) : freshKeys[0];
        if (!freshJwk) {
            throw new Error("No matching JWK found for token kid");
        }
    }

    const keyToUse = jwk || (await getJWKS())[0];
    const cryptoKey = await jwkToCryptoKey(keyToUse);

    const parts = token.split(".");
    const signingInput = `${parts[0]}.${parts[1]}`;
    const signature = Buffer.from(parts[2], "base64url");

    const isValid = await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        cryptoKey,
        signature,
        new TextEncoder().encode(signingInput),
    );

    if (!isValid) {
        throw new Error("JWT signature verification failed");
    }

    return payload;
}

/**
 * Invalidate the JWKS cache (useful for testing).
 */
export function invalidateJWKSCache(): void {
    cachedKeys = null;
}
