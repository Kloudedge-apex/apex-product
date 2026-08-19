/**
 * Compatibility helpers for identifying legacy fixture data and constructing
 * explicit fixture payloads in tests. Live research tools fail explicitly and
 * never create this metadata. Consumers retain the guard so old imported or
 * persisted fixture rows cannot become citable evidence.
 */

export interface MockMetadata {
  source: "mock";
  confidence: 0;
  reason: string;
}

/**
 * Returns a metadata object identifying a value as mock fixture data.
 */
export function mockMetadata(reason: string): MockMetadata {
  return { source: "mock", confidence: 0, reason };
}

/**
 * Tag a single object as mock-sourced. Spreads the original fields and adds
 * the `source`/`confidence`/`reason` metadata. Useful for wrapping individual
 * list items so the flag is inline at every level the LLM may read.
 */
export function markMockedItem<T extends object>(item: T, reason: string): T & MockMetadata {
  return { ...item, ...mockMetadata(reason) };
}

/**
 * Tag a wrapping payload as mock-sourced. Use this on the outer object the
 * tool returns when the entire payload is fixture data.
 */
export function markMocked<T extends object>(data: T, reason: string): T & MockMetadata {
  return { ...data, ...mockMetadata(reason) };
}

/** True if a value carries the mock metadata flag. Mock data must never be cited as fact. */
export function isMocked(data: unknown): boolean {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { source?: unknown }).source === "mock"
  );
}
