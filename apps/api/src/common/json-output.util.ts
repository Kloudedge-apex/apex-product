/**
 * Shared helpers for parsing structured JSON responses from LLMs.
 *
 * Why: many agents (icp_auto, team-page-scraper, lead_scorer, reporting,
 * content_writer, social_engagement, inbox_monitor, crm_sync, reply_handler,
 * seo_agent) ask the model to emit JSON. A malformed payload either crashes
 * downstream code or silently feeds garbage into the pipeline. This module
 * centralizes:
 *
 *   1. Tolerant JSON extraction (strips ```json fences, locates the first
 *      `{...}` block if the model added prose).
 *   2. Lightweight shape validation via caller-supplied TypeScript guards
 *      (we hand-roll guards because `zod` is intentionally NOT a dependency
 *      in this workspace — see api/package.json).
 *   3. A `chatJsonWithRetry` helper that re-prompts the LLM ONCE with the
 *      validation error appended, then gives up and returns `null`. Callers
 *      treat `null` as "agent could not produce valid output" and fall
 *      through to their failure-mode behavior (T2.3) rather than throwing.
 *
 * Design notes:
 *   - No `any`. Schemas are expressed as `(value: unknown) => value is T`
 *     guards so the call site gets a fully-typed `T` on success.
 *   - The retry message is appended as a `system` turn so it survives
 *     provider-specific message-shaping (Anthropic extracts system
 *     separately, OpenAI keeps it inline — both will see the error).
 *   - We log retries via the caller's logger; this util does no logging
 *     itself to avoid creating a NestJS dependency in `common/`.
 */

import type { ChatMessage, ChatOptions, LLMResponse } from "../runtime/llm.service";

export type ParseResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: string };

/** Guard signature: returns true iff `value` matches shape `T`. */
export type ShapeGuard<T> = (value: unknown) => value is T;

/**
 * Strip a leading/trailing ```json … ``` fence (or plain ``` … ```) if the
 * model wrapped its output. Idempotent for already-clean payloads.
 */
export function extractJsonFromMarkdown(raw: string): string {
  if (!raw) return "";
  const trimmed = raw.trim();
  // Handle ```json … ``` or ``` … ``` (possibly with trailing newline).
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  if (fenced && fenced[1] !== undefined) return fenced[1].trim();
  return trimmed;
}

/**
 * Parse `raw` as JSON and validate against the supplied shape guard.
 *
 * Tolerates:
 *   - Surrounding markdown fences (```json … ```).
 *   - Leading/trailing prose, by locating the first balanced-looking `{...}`
 *     or `[...]` block as a fallback.
 *
 * Returns `ok: false` with a human-readable error on any failure — never
 * throws, never returns partial data.
 */
export function parseJsonResponse<T>(
  raw: string,
  guard: ShapeGuard<T>,
): ParseResult<T> {
  if (!raw || raw.trim().length === 0) {
    return { ok: false, error: "Empty response from LLM." };
  }

  const stripped = extractJsonFromMarkdown(raw);

  // Try the stripped payload first.
  const direct = tryJsonParse(stripped);
  if (direct.ok && guard(direct.value)) {
    return { ok: true, data: direct.value };
  }

  // Fallback: try the first {...} block. This covers cases where the model
  // emits a sentence before the JSON ("Here you go: { ... }").
  const objMatch = /\{[\s\S]*\}/.exec(stripped);
  if (objMatch) {
    const obj = tryJsonParse(objMatch[0]);
    if (obj.ok && guard(obj.value)) {
      return { ok: true, data: obj.value };
    }
    if (obj.ok) {
      return {
        ok: false,
        error: "JSON parsed but did not match the required schema.",
      };
    }
  }

  // Fallback: first [...] block (some agents return top-level arrays).
  const arrMatch = /\[[\s\S]*\]/.exec(stripped);
  if (arrMatch) {
    const arr = tryJsonParse(arrMatch[0]);
    if (arr.ok && guard(arr.value)) {
      return { ok: true, data: arr.value };
    }
  }

  if (!direct.ok) {
    return { ok: false, error: `Invalid JSON: ${direct.error}` };
  }
  return {
    ok: false,
    error: "JSON parsed but did not match the required schema.",
  };
}

function tryJsonParse(
  s: string,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: string } {
  try {
    return { ok: true, value: JSON.parse(s) as unknown };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Minimal interface the retry helper needs from `LLMService` — accepting an
 * interface rather than the class keeps the util free of a Nest DI import
 * cycle and lets tests pass a fake without instantiating the full service.
 */
export interface LlmChatLike {
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<LLMResponse>;
}

export interface ChatJsonRetryOptions<T> {
  readonly messages: ChatMessage[];
  readonly chatOptions?: ChatOptions;
  readonly guard: ShapeGuard<T>;
  /**
   * Short human-readable description of the expected schema, e.g.
   * `'{"productSummary": string, "targetTitles": string[], ...}'`.
   * Included in the retry prompt so the model knows what to fix.
   */
  readonly schemaDescription: string;
  /**
   * Optional hook invoked when the first attempt fails and we retry.
   * Useful for logging without coupling this util to a logger.
   */
  readonly onRetry?: (error: string) => void;
  /**
   * Optional hook invoked when both attempts fail. Receives the final error.
   */
  readonly onFailure?: (error: string) => void;
}

/**
 * Call `llm.chat`, validate the response, and retry ONCE if validation fails.
 *
 * Returns the typed payload on success, or `null` if both attempts fail.
 * Never throws on parse/validation errors (LLM transport errors still
 * surface as exceptions — those are the caller's problem).
 */
export async function chatJsonWithRetry<T>(
  llm: LlmChatLike,
  opts: ChatJsonRetryOptions<T>,
): Promise<T | null> {
  const firstResp = await llm.chat(opts.messages, opts.chatOptions);
  const first = parseJsonResponse(firstResp.content, opts.guard);
  if (first.ok) return first.data;

  opts.onRetry?.(first.error);

  const retryMessages: ChatMessage[] = [
    ...opts.messages,
    {
      role: "assistant",
      content: firstResp.content,
    },
    {
      role: "system",
      content:
        "Your previous response was not valid JSON or did not match the " +
        `required schema. Error: ${first.error}. Please return ONLY valid ` +
        `JSON matching this schema: ${opts.schemaDescription}. No prose, ` +
        "no markdown fences.",
    },
  ];

  const secondResp = await llm.chat(retryMessages, opts.chatOptions);
  const second = parseJsonResponse(secondResp.content, opts.guard);
  if (second.ok) return second.data;

  opts.onFailure?.(second.error);
  return null;
}
