/**
 * Per-org allowlist for real outbound sends.
 *
 *   OUTREACH_LIVE_FOR_ORGS unset / empty → no orgs may real-send (fail-closed)
 *   OUTREACH_LIVE_FOR_ORGS="org_a,org_b" → only those orgs may real-send
 *   OUTREACH_LIVE_FOR_ORGS="*"           → all orgs (dev convenience only)
 */
export function isLiveSendAllowedForOrg(
  orgId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env.OUTREACH_LIVE_FOR_ORGS?.trim();
  if (!raw) return false;
  if (raw === "*") return true;
  const allowlist = new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
  return allowlist.has(orgId);
}

