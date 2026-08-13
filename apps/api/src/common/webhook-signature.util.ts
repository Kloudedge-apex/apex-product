import * as crypto from "crypto";

export function timingSafeEqualBuffers(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Verifies a Clerk webhook signature.
 *
 * Clerk uses Svix's standard scheme:
 *   - Header `svix-signature` contains one or more `v1,<base64-sig>` entries.
 *   - The signed payload is `<svix-id>.<svix-timestamp>.<raw-body>`.
 *   - Signature is HMAC-SHA256 with the bytes of the webhook secret
 *     (secret format: `whsec_<base64-encoded-key>`).
 *   - Reject timestamps more than 5 minutes off wall clock.
 */
export function verifyClerkWebhookSignature(
  rawBody: Buffer | string,
  headers: Record<string, string | string[] | undefined>,
  secret: string,
): void {
  const id = headerValue(headers, "svix-id");
  const timestamp = headerValue(headers, "svix-timestamp");
  const signatureHeader = headerValue(headers, "svix-signature");

  if (!id || !timestamp || !signatureHeader) {
    throw new Error("Missing svix signature headers");
  }

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) {
    throw new Error("Invalid svix-timestamp");
  }
  const ageSec = Math.abs(Date.now() / 1000 - ts);
  if (ageSec > 5 * 60) {
    throw new Error("Webhook timestamp outside tolerance window");
  }

  const secretBytes = decodeSvixSecret(secret);
  const payload = `${id}.${timestamp}.${typeof rawBody === "string" ? rawBody : rawBody.toString("utf8")}`;
  const expected = crypto.createHmac("sha256", secretBytes).update(payload).digest("base64");

  const signatures = signatureHeader
    .split(" ")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("v1,"))
    .map((s) => s.slice(3));

  if (signatures.length === 0) {
    throw new Error("No v1 signatures in svix-signature header");
  }

  const expectedBuf = Buffer.from(expected, "base64");
  const match = signatures.some((sig) => {
    const sigBuf = Buffer.from(sig, "base64");
    return timingSafeEqualBuffers(sigBuf, expectedBuf);
  });

  if (!match) {
    throw new Error("Signature mismatch");
  }
}

function decodeSvixSecret(secret: string): Buffer {
  const prefix = "whsec_";
  const raw = secret.startsWith(prefix) ? secret.slice(prefix.length) : secret;
  return Buffer.from(raw, "base64");
}

/**
 * Verifies a Razorpay webhook signature.
 * `X-Razorpay-Signature` = hex(HMAC-SHA256(raw_body, secret)).
 */
export function verifyRazorpayWebhookSignature(
  rawBody: Buffer | string,
  signatureHeader: string | undefined,
  secret: string,
): void {
  if (!signatureHeader) {
    throw new Error("Missing X-Razorpay-Signature header");
  }
  const body = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
  const expected = crypto.createHmac("sha256", secret).update(body).digest("hex");
  const sigBuf = Buffer.from(signatureHeader, "hex");
  const expBuf = Buffer.from(expected, "hex");
  if (!timingSafeEqualBuffers(sigBuf, expBuf)) {
    throw new Error("Razorpay signature mismatch");
  }
}

/**
 * Verifies a HubSpot v3 webhook signature.
 * Source string is `<method><uri><body><timestamp>`.
 * Header `X-HubSpot-Signature-v3` = base64(HMAC-SHA256(source, app_secret)).
 * Timestamp must be within 5 minutes.
 */
export function verifyHubspotWebhookSignature(opts: {
  method: string;
  uri: string;
  rawBody: Buffer | string;
  signatureHeader: string | undefined;
  timestampHeader: string | undefined;
  secret: string;
}): void {
  const { method, uri, rawBody, signatureHeader, timestampHeader, secret } = opts;
  if (!signatureHeader || !timestampHeader) {
    throw new Error("Missing HubSpot signature headers");
  }
  const tsMs = Number(timestampHeader);
  if (!Number.isFinite(tsMs)) {
    throw new Error("Invalid HubSpot timestamp");
  }
  if (Math.abs(Date.now() - tsMs) > 5 * 60 * 1000) {
    throw new Error("HubSpot timestamp outside tolerance window");
  }

  const body = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
  const source = `${method}${uri}${body}${timestampHeader}`;
  const expected = crypto.createHmac("sha256", secret).update(source).digest("base64");
  const sigBuf = Buffer.from(signatureHeader, "base64");
  const expBuf = Buffer.from(expected, "base64");
  if (!timingSafeEqualBuffers(sigBuf, expBuf)) {
    throw new Error("HubSpot signature mismatch");
  }
}

/**
 * Sign and verify a short-lived `state` parameter for OAuth flows.
 *
 * The state encodes `<orgId>.<nonce>.<expMs>` and is HMAC-signed with
 * OAUTH_STATE_SECRET. The user navigates to a provider's consent screen with
 * this `state`, and we verify it on the callback. Without this, an attacker
 * who controls the `state` can mount the OAuth callback against any tenant.
 */
const STATE_TTL_MS = 10 * 60 * 1000;

const OAUTH_ATTEMPT_STATE_VERSION = 1;
const OAUTH_ATTEMPT_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const OAUTH_PROVIDER_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

interface OAuthAttemptStatePayload {
  readonly v: number;
  readonly a: string;
  readonly p: string;
  readonly e: number;
}

export interface VerifiedOAuthAttemptState {
  readonly attemptId: string;
  readonly provider: string;
  readonly expiresAtMs: number;
}

/**
 * Signs the opaque pointer used by the durable OAuth-attempt flow.
 *
 * Tenant and actor authority deliberately do not travel in the browser. They
 * remain bound to `attemptId` in the server-side attempt record. The provider
 * callback can therefore prove that the pointer was issued by us, but it
 * cannot choose or alter the tenant or actor that may finalize it.
 */
export function signOAuthAttemptState(input: {
  readonly attemptId: string;
  readonly provider: string;
  readonly expiresAtMs: number;
}): string {
  if (!OAUTH_ATTEMPT_ID_PATTERN.test(input.attemptId)) {
    throw new Error("OAuth attempt id is invalid");
  }
  if (!OAUTH_PROVIDER_PATTERN.test(input.provider)) {
    throw new Error("OAuth provider is invalid");
  }
  if (!Number.isSafeInteger(input.expiresAtMs) || input.expiresAtMs <= Date.now()) {
    throw new Error("OAuth attempt expiry is invalid");
  }

  const payload: OAuthAttemptStatePayload = {
    v: OAUTH_ATTEMPT_STATE_VERSION,
    a: input.attemptId,
    p: input.provider,
    e: input.expiresAtMs,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  );
  const signature = crypto
    .createHmac("sha256", requireOAuthStateSecret())
    .update(encodedPayload)
    .digest("base64url");
  return `${encodedPayload}.${signature}`;
}

export function verifyOAuthAttemptState(
  state: string,
): VerifiedOAuthAttemptState {
  if (typeof state !== "string" || state.length === 0 || state.length > 2048) {
    throw new Error("Invalid OAuth state format");
  }
  const parts = state.split(".");
  if (parts.length !== 2) {
    throw new Error("Invalid OAuth state format");
  }
  const [encodedPayload, encodedSignature] = parts;

  let payloadBytes: Buffer;
  let signature: Buffer;
  try {
    payloadBytes = Buffer.from(encodedPayload, "base64url");
    signature = Buffer.from(encodedSignature, "base64url");
  } catch {
    throw new Error("Invalid OAuth state encoding");
  }
  if (
    payloadBytes.toString("base64url") !== encodedPayload ||
    signature.toString("base64url") !== encodedSignature
  ) {
    throw new Error("Invalid OAuth state encoding");
  }

  const expected = crypto
    .createHmac("sha256", requireOAuthStateSecret())
    .update(encodedPayload)
    .digest();
  if (!timingSafeEqualBuffers(signature, expected)) {
    throw new Error("OAuth state signature mismatch");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadBytes.toString("utf8"));
  } catch {
    throw new Error("Invalid OAuth state payload");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid OAuth state payload");
  }
  const payload = parsed as Partial<OAuthAttemptStatePayload>;
  if (
    payload.v !== OAUTH_ATTEMPT_STATE_VERSION ||
    typeof payload.a !== "string" ||
    !OAUTH_ATTEMPT_ID_PATTERN.test(payload.a) ||
    typeof payload.p !== "string" ||
    !OAUTH_PROVIDER_PATTERN.test(payload.p) ||
    typeof payload.e !== "number" ||
    !Number.isSafeInteger(payload.e) ||
    payload.e <= Date.now()
  ) {
    throw new Error("OAuth state expired or invalid");
  }

  return {
    attemptId: payload.a,
    provider: payload.p,
    expiresAtMs: payload.e,
  };
}

export function signOAuthState(orgId: string): string {
  const secret = requireOAuthStateSecret();
  const expMs = Date.now() + STATE_TTL_MS;
  const nonce = crypto.randomBytes(12).toString("hex");
  const payload = `${orgId}.${nonce}.${expMs}`;
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return Buffer.from(`${payload}.${sig}`, "utf8").toString("base64url");
}

export function verifyOAuthState(state: string): { orgId: string } {
  const secret = requireOAuthStateSecret();
  let decoded: string;
  try {
    decoded = Buffer.from(state, "base64url").toString("utf8");
  } catch {
    throw new Error("Invalid OAuth state encoding");
  }
  const parts = decoded.split(".");
  if (parts.length !== 4) {
    throw new Error("Invalid OAuth state format");
  }
  const [orgId, nonce, expMsStr, sig] = parts;
  const expMs = Number(expMsStr);
  if (!Number.isFinite(expMs) || Date.now() > expMs) {
    throw new Error("OAuth state expired");
  }
  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${orgId}.${nonce}.${expMsStr}`)
    .digest("hex");
  const sigBuf = Buffer.from(sig, "hex");
  const expBuf = Buffer.from(expected, "hex");
  if (!timingSafeEqualBuffers(sigBuf, expBuf)) {
    throw new Error("OAuth state signature mismatch");
  }
  return { orgId };
}

function requireOAuthStateSecret(): string {
  const secret = process.env.OAUTH_STATE_SECRET;
  if (!secret || secret !== secret.trim() || secret.length < 32) {
    throw new Error(
      "OAUTH_STATE_SECRET must be set (>=32 chars) to sign OAuth state parameters",
    );
  }
  return secret;
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const v = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(v)) return v[0];
  return v;
}
