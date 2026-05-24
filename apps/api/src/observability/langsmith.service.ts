import { Injectable, Logger } from "@nestjs/common";
import { createHash } from "node:crypto";
import { getLangSmithConfig } from "./langsmith.config";

type JsonSafe =
  | null
  | boolean
  | number
  | string
  | readonly JsonSafe[]
  | { readonly [key: string]: JsonSafe };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return value.slice(0, Math.max(0, maxChars));
}

function hashEmail(email: string): string {
  return createHash("sha256").update(email.toLowerCase()).digest("hex");
}

function hashEmailsInText(text: string): string {
  // Conservative email matcher; avoids over-matching adjacent punctuation.
  const emailRegex =
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

  return text.replace(emailRegex, (match) => `sha256:${hashEmail(match)}`);
}

const DROP_KEYS = new Set<string>([
  "tool_call_id",
  // Raw tool arguments often contain PII; drop unconditionally.
  "arguments",
  "tool_args",
  // Embedding inputs can contain raw text; drop unconditionally.
  "embedding_input",
  "embeddings_input",
]);

function redactForLangSmith(
  value: unknown,
  opts: { readonly maxChars: number; readonly capturePrompts: boolean },
  seen: WeakSet<object>,
): JsonSafe {
  if (value === null) return null;

  if (typeof value === "string") {
    if (!opts.capturePrompts) return "[redacted]";
    return truncate(hashEmailsInText(value), opts.maxChars);
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined") return null;

  if (value instanceof Date) {
    return truncate(value.toISOString(), opts.maxChars);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactForLangSmith(item, opts, seen));
  }

  if (typeof value === "object") {
    if (seen.has(value)) return "[circular]";
    seen.add(value);

    if (!isPlainObject(value)) {
      return truncate(String(value), opts.maxChars);
    }

    const obj = value;
    const isEmbeddingLike =
      typeof obj.type === "string" && obj.type.toLowerCase().includes("embedding");

    const out: Record<string, JsonSafe> = {};
    for (const [key, inner] of Object.entries(obj)) {
      if (DROP_KEYS.has(key)) continue;
      if (isEmbeddingLike && (key === "input" || key === "texts")) continue;
      if (key.toLowerCase().includes("embedding") && (key === "input" || key === "texts")) {
        continue;
      }

      out[key] = redactForLangSmith(inner, opts, seen);
    }
    return out;
  }

  return truncate(String(value), opts.maxChars);
}

function redactInputsAndOutputs(
  value: unknown,
  opts: { readonly maxChars: number; readonly capturePrompts: boolean },
): JsonSafe {
  return redactForLangSmith(value, opts, new WeakSet<object>());
}

@Injectable()
export class LangSmithService {
  private readonly logger = new Logger(LangSmithService.name);

  static async loadSdk(): Promise<typeof import("langsmith")> {
    return import("langsmith");
  }

  async wrapLlm<TResult>(
    input: {
      readonly name: string;
      readonly model: string;
      readonly inputs: unknown;
      readonly parentRunId?: string;
    },
    fn: () => Promise<TResult>,
  ): Promise<TResult> {
    const config = getLangSmithConfig();
    const shouldAttemptTracing = Boolean(config.apiKey) && config.tracing !== false;

    if (!shouldAttemptTracing) return await fn();

    try {
      const { Client, RunTree } = await LangSmithService.loadSdk();
      const client = new Client({ apiKey: config.apiKey });

      const runTree = new RunTree({
        name: input.name,
        run_type: "llm",
        project_name: config.project,
        parent_run_id: input.parentRunId,
        tracingEnabled: config.tracing ?? true,
        client,
        metadata: {
          model: input.model,
        },
        inputs: config.capturePrompts === true
          ? {
              model: input.model,
              inputs: redactInputsAndOutputs(input.inputs, {
                maxChars: config.maxContentChars,
                capturePrompts: true,
              }),
            }
          : { model: input.model },
      });

      // Fire-and-forget: never block or throw on observability side-effects.
      void runTree.postRun().catch(() => undefined);

      const startedAt = Date.now();
      try {
        const result = await fn();

        const durationMs = Date.now() - startedAt;
        const outputs =
          config.capturePrompts === true
            ? {
                outputs: redactInputsAndOutputs(result, {
                  maxChars: config.maxContentChars,
                  capturePrompts: true,
                }),
                duration_ms: durationMs,
              }
            : { duration_ms: durationMs };

        void runTree.end(outputs).catch(() => undefined);
        return result;
      } catch (err) {
        const durationMs = Date.now() - startedAt;
        void runTree.end(
          { duration_ms: durationMs },
          err instanceof Error ? err.message : String(err),
        ).catch(() => undefined);
        throw err;
      }
    } catch (err) {
      this.logger.warn(
        `LangSmith tracing failed to initialize for name=${input.name} model=${input.model}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return await fn();
    }
  }
}
