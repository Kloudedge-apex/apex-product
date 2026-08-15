export const DEFAULT_HEALTH_CHECK_TIMEOUT_MS = 2_000;

export function healthCheckTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.HEALTH_CHECK_TIMEOUT_MS;
  const parsed = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_HEALTH_CHECK_TIMEOUT_MS;
}

/**
 * Bound a dependency probe even when its client is configured to retry
 * indefinitely. The underlying operation may later recover, but readiness
 * must answer promptly so the orchestrator can drain an unhealthy replica.
 */
export async function withHealthTimeout<T>(
  operation: Promise<T>,
  label: string,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    timer.unref();
  });

  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
