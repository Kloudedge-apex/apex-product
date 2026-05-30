import { ReplyIntent10 } from "@prisma/client";
import type { ChatMessage, LLMService } from "../../runtime/llm.service";
import type { LangSmithService } from "../../observability/langsmith.service";

export interface EvidenceSpan {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

export interface LlmStageResult {
  readonly intent: ReplyIntent10;
  readonly confidence: number;
  readonly rawOutput: unknown;
  readonly evidenceSpans?: readonly EvidenceSpan[];
  readonly latencyMs: number;
  readonly modelName: string;
}

export interface Stage2Input {
  readonly orgId: string;
  readonly replyId: string;
  readonly subject?: string | null;
  readonly bodyText?: string | null;
  readonly model?: string | null;
}

export const STAGE2_MAX_BODY_CHARS = 4000;

const ALLOWED_INTENTS = new Set<ReplyIntent10>([
  ReplyIntent10.positive_interest,
  ReplyIntent10.question_or_objection,
  ReplyIntent10.referral,
  ReplyIntent10.not_now,
  ReplyIntent10.wrong_person,
  ReplyIntent10.unsubscribe,
  ReplyIntent10.negative_not_interested,
  ReplyIntent10.auto_reply_ooo,
  ReplyIntent10.bounce_or_ndr,
  ReplyIntent10.spam_or_legal_threat,
]);

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars);
}

function extractJsonCandidate(text: string): string | null {
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;
  return text.slice(first, last + 1);
}

function parseLlmOutput(
  content: string,
): {
  readonly intent: ReplyIntent10;
  readonly confidence: number;
  readonly evidenceSpans?: readonly EvidenceSpan[];
  readonly parsed: unknown;
  readonly parseError?: string;
} {
  const fallbackIntent = ReplyIntent10.question_or_objection;
  const fallback = {
    intent: fallbackIntent,
    confidence: 0,
    parsed: null,
    parseError: "empty_response",
  } as const;

  const raw = (content ?? "").trim();
  if (!raw) return fallback;

  const candidates = [raw, extractJsonCandidate(raw)].filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );

  let parsed: any;
  let lastErr: unknown = undefined;
  for (const c of candidates) {
    try {
      parsed = JSON.parse(c);
      lastErr = undefined;
      break;
    } catch (err) {
      lastErr = err;
    }
  }

  if (!parsed || typeof parsed !== "object") {
    return {
      ...fallback,
      parsed: null,
      parseError: `invalid_json:${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
    };
  }

  const intent = parsed.intent as ReplyIntent10;
  const confidence = clamp01(Number(parsed.confidence));
  const evidenceSpans = Array.isArray(parsed.evidenceSpans)
    ? (parsed.evidenceSpans as unknown[]).flatMap((span): EvidenceSpan[] => {
        if (!span || typeof span !== "object") return [];
        const s = span as any;
        const start = Number(s.start);
        const end = Number(s.end);
        const text = typeof s.text === "string" ? s.text : "";
        if (!Number.isFinite(start) || !Number.isFinite(end)) return [];
        if (start < 0 || end <= start) return [];
        return [{ start, end, text }];
      })
    : undefined;

  if (!ALLOWED_INTENTS.has(intent)) {
    return {
      intent: fallbackIntent,
      confidence: 0,
      parsed,
      evidenceSpans,
      parseError: `invalid_intent:${String((parsed as any).intent ?? "")}`,
    };
  }

  return { intent, confidence, evidenceSpans, parsed };
}

function buildPrompt(): string {
  return [
    "You are classifying an inbound email reply from a prospect.",
    "",
    "Choose exactly ONE label from this enum (exact spelling):",
    "- positive_interest",
    "- question_or_objection",
    "- referral",
    "- not_now",
    "- wrong_person",
    "- unsubscribe",
    "- negative_not_interested",
    "- auto_reply_ooo",
    "- bounce_or_ndr",
    "- spam_or_legal_threat",
    "",
    "Definitions (brief):",
    "- positive_interest: wants to talk, interested, asks to proceed/schedule",
    "- question_or_objection: asks a question, raises concerns, requests details",
    "- referral: forwards to someone else or suggests a different contact",
    "- not_now: interested but asks to follow up later / timing issue",
    "- wrong_person: says they are not the right contact / wrong role",
    "- unsubscribe: asks to stop emailing / remove from list",
    "- negative_not_interested: explicitly not interested / declines",
    "- auto_reply_ooo: automated out-of-office / away response",
    "- bounce_or_ndr: bounce / non-delivery report / mailer-daemon",
    "- spam_or_legal_threat: spam complaint, cease & desist, legal threat",
    "",
    "Return STRICT JSON only, no markdown, shape:",
    '{"intent":"<enum>","confidence":0.0,"evidenceSpans":[{"start":0,"end":10,"text":"..."}]}',
    "confidence must be 0..1.",
  ].join("\n");
}

export function buildStage2Messages(input: {
  readonly subject: string;
  readonly body: string;
}): ChatMessage[] {
  return [
    { role: "system", content: buildPrompt() },
    {
      role: "user",
      content: `Subject: ${input.subject}\n\nBody:\n${input.body}`,
    },
  ];
}

export async function classifyWithLlm(
  langsmith: LangSmithService,
  llm: LLMService,
  input: Stage2Input,
): Promise<LlmStageResult> {
  const model = input.model || process.env.DEFAULT_MODEL || "gpt-4o-mini";
  const subject = (input.subject ?? "").slice(0, 500);
  const body = truncate((input.bodyText ?? "").trim(), STAGE2_MAX_BODY_CHARS);

  let parentRunId: string | undefined;
  const startedAt = Date.now();
  const llmResponse = await langsmith.wrapLlm(
    {
      name: "reply_classifier.stage2",
      model,
      inputs: { subject, body, orgId: input.orgId, replyId: input.replyId },
      agent: "reply_classifier",
      node: "reply_classifier.stage2",
      tags: ["ws-3", "reply-classifier"],
      metadata: { org_id: input.orgId, reply_id: input.replyId },
      onRunStart: (runId) => {
        parentRunId = runId;
      },
    },
    async () => {
      const messages = buildStage2Messages({ subject, body });
      return llm.chat(messages, {
        model,
        parentRunId,
        agent: "reply_classifier",
        node: "reply_classifier.stage2",
        tags: ["ws-3", "reply-classifier"],
        metadata: { org_id: input.orgId, reply_id: input.replyId },
      });
    },
  );
  const latencyMs = Date.now() - startedAt;

  const parsed = parseLlmOutput(llmResponse.content);

  return {
    intent: parsed.intent,
    confidence: parsed.confidence,
    evidenceSpans: parsed.evidenceSpans,
    latencyMs,
    modelName: model,
    rawOutput: {
      response: {
        model: llmResponse.model,
        tokensUsed: llmResponse.tokensUsed,
        finishReason: llmResponse.finishReason ?? null,
        content: llmResponse.content,
      },
      parsed: parsed.parsed,
      parseError: parsed.parseError ?? null,
    },
  };
}

