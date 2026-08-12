import { createHash } from "node:crypto";

/**
 * Stable, collision-resistant slug for the one trial workspace owned by a
 * Clerk principal. The previous Date.now suffix let unrelated signups in the
 * same millisecond collide, while parallel requests for one principal could
 * generate different candidate workspaces.
 */
export function buildTrialOrgSlug(name: string, clerkUserId: string): string {
  const stem =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || "workspace";
  const identitySuffix = createHash("sha256")
    .update(clerkUserId)
    .digest("hex")
    .slice(0, 16);
  return `${stem}-${identitySuffix}`;
}
