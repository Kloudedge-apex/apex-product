/**
 * Helpers for tagging mock/fixture data returned by external-provider tools
 * (web_search, web_scrape, company_research) when the live provider is
 * unconfigured or fails. The flag is intended to be visible inline to the
 * downstream LLM so it does not cite fixture data as fact.
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

/**
 * Boilerplate description suffix appended to every mock-capable tool so the
 * LLM is informed (in-schema) how to treat `source: "mock"` items.
 */
export const MOCK_DISCLAIMER_SUFFIX =
  ' Results may include items marked `source: "mock"` when external providers are unavailable. Treat mocked items as missing data — do NOT cite them as fact.';
