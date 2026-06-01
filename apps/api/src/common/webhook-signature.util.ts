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
  if (!secret || secret.length < 32) {
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
