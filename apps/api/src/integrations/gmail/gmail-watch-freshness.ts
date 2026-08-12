/**
 * Gmail watches normally expire after roughly seven days. Require a successful
 * registration within six days so one failed daily renewal does not interrupt
 * a still-valid watch, while repeated failures fail closed before expiry.
 */
export const GMAIL_WATCH_MAX_AGE_MS = 6 * 24 * 60 * 60 * 1000;

export function gmailWatchFreshnessFloor(now: Date = new Date()): Date {
  return new Date(now.getTime() - GMAIL_WATCH_MAX_AGE_MS);
}

export function isGmailWatchFresh(
  lastSuccessfulRenewalAt: Date | null,
  now: Date = new Date(),
): boolean {
  return (
    lastSuccessfulRenewalAt !== null &&
    lastSuccessfulRenewalAt >= gmailWatchFreshnessFloor(now)
  );
}
