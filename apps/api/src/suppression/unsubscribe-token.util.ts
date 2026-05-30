import { createHmac, timingSafeEqual } from "crypto";

export interface UnsubscribeTokenClaims {
  readonly orgId: string;
  readonly recipientEmail: string;
  readonly artifactId: string;
}

function getSecret(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const secret = env.OUTREACH_UNSUBSCRIBE_SECRET;
  return typeof secret === "string" && secret.length > 0 ? secret : null;
}

function b64urlEncode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function b64urlDecode(value: string): string | null {
  try {
    return Buffer.from(value, "base64url").toString("utf8");
  } catch {
    return null;
  }
}

export function signToken(
  claims: UnsubscribeTokenClaims,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const secret = getSecret(env);
  if (!secret) {
    throw new Error("OUTREACH_UNSUBSCRIBE_SECRET is not set");
  }

  const payload = b64urlEncode(JSON.stringify(claims));
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyToken(
  token: string,
  env: NodeJS.ProcessEnv = process.env,
): UnsubscribeTokenClaims | null {
  const secret = getSecret(env);
  if (!secret) return null;

  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts;
  if (!payloadB64 || !sigB64) return null;

  const expected = createHmac("sha256", secret).update(payloadB64).digest();
  let given: Buffer;
  try {
    given = Buffer.from(sigB64, "base64url");
  } catch {
    return null;
  }
  if (given.length !== expected.length) return null;
  if (!timingSafeEqual(given, expected)) return null;

  const json = b64urlDecode(payloadB64);
  if (!json) return null;

  try {
    const parsed = JSON.parse(json) as Partial<UnsubscribeTokenClaims>;
    if (
      typeof parsed.orgId !== "string" ||
      parsed.orgId.length === 0 ||
      typeof parsed.recipientEmail !== "string" ||
      parsed.recipientEmail.length === 0 ||
      typeof parsed.artifactId !== "string" ||
      parsed.artifactId.length === 0
    ) {
      return null;
    }
    return {
      orgId: parsed.orgId,
      recipientEmail: parsed.recipientEmail,
      artifactId: parsed.artifactId,
    };
  } catch {
    return null;
  }
}

