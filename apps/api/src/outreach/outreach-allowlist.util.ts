/**
 * Per-org allowlist for real outbound sends.
 *
 *   OUTREACH_LIVE_FOR_ORGS unset / empty → no orgs may real-send (fail-closed)
 *   OUTREACH_LIVE_FOR_ORGS="org_a,org_b" → only those orgs may real-send
 *   OUTREACH_LIVE_FOR_ORGS="*"           → all orgs (dev convenience only)
 *
 * Production wildcard guard (GL8c): "*" in NODE_ENV=production is refused
 * unless OUTREACH_ALLOW_WILDCARD="true" is also set — a wildcard silently
 * arms live outbound email for EVERY tenant, which must never happen by
 * accident. env-validation.ts fail-fasts the same combination at boot; this
 * runtime check is the defense-in-depth mirror in case validation was
 * bypassed or the env mutated after boot.
 */
export function isLiveSendAllowedForOrg(
  orgId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env.OUTREACH_LIVE_FOR_ORGS?.trim();
  if (!raw) return false;
  if (raw === "*") {
    if (env.NODE_ENV === "production" && env.OUTREACH_ALLOW_WILDCARD !== "true") {
      return false;
    }
    return true;
  }
  const allowlist = new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
  return allowlist.has(orgId);
}

