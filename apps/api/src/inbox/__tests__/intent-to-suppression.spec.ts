import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  OutreachArtifactStatus,
  ReplyIntent10,
  SuppressionKind,
  SuppressionScope,
} from "@prisma/client";
import { ReplyIntentEffectsService } from "../reply-intent-effects.service";

describe("ReplyIntentEffectsService", () => {
  const fixedNow = new Date("2026-01-01T00:00:00.000Z");

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeSvc(overrides: Partial<{
    replyFindFirst: ReturnType<typeof vi.fn>;
    suppressionAdd: ReturnType<typeof vi.fn>;
    artifactFindFirst: ReturnType<typeof vi.fn>;
    artifactUpdateMany: ReturnType<typeof vi.fn>;
    evidenceArtifactTransition: ReturnType<typeof vi.fn>;
    evidenceReplyFlagged: ReturnType<typeof vi.fn>;
  }> = {}) {
    const replyFindFirst =
      overrides.replyFindFirst ??
      vi.fn().mockResolvedValue({
        id: "reply_1",
        orgId: "org_1",
        artifactId: "art_1",
        emailMessage: { fromEmail: "prospect@acme.com" },
        classifications: [
          {
            id: "cls_1",
            classifierName: "deterministic",
            classifierVersion: "1.0.0",
            intent: ReplyIntent10.unsubscribe,
            confidence: 0.95,
            requiresHitl: false,
            createdAt: fixedNow,
          },
        ],
      });

    const suppressionAdd = overrides.suppressionAdd ?? vi.fn().mockResolvedValue(undefined);

    const artifactFindFirst =
      overrides.artifactFindFirst ??
      vi.fn().mockResolvedValue({
        status: OutreachArtifactStatus.SENT,
        graphRunId: "graph_1",
      });

    const artifactUpdateMany =
      overrides.artifactUpdateMany ??
      vi.fn().mockResolvedValue({
        count: 1,
      });

    const evidenceArtifactTransition =
      overrides.evidenceArtifactTransition ?? vi.fn().mockResolvedValue(undefined);
    const evidenceReplyFlagged =
      overrides.evidenceReplyFlagged ?? vi.fn().mockResolvedValue(undefined);

    const prisma = {
      reply: { findFirst: replyFindFirst },
      outreachArtifact: { findFirst: artifactFindFirst, updateMany: artifactUpdateMany },
    } as unknown as any;

    const suppression = { add: suppressionAdd } as unknown as any;
    const evidence = {
      artifactStatusTransition: evidenceArtifactTransition,
      replyFlaggedForReview: evidenceReplyFlagged,
    } as unknown as any;

    const svc = new ReplyIntentEffectsService(prisma, suppression, evidence);
    return {
      svc,
      replyFindFirst,
      suppressionAdd,
      artifactFindFirst,
      artifactUpdateMany,
      evidenceArtifactTransition,
      evidenceReplyFlagged,
    };
  }

  it("adds ORG+UNSUBSCRIBE suppression for intent=unsubscribe", async () => {
    const { svc, suppressionAdd } = makeSvc();
    await svc.applyLatest("org_1", "reply_1");
    expect(suppressionAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org_1",
        scope: SuppressionScope.ORG,
        kind: SuppressionKind.UNSUBSCRIBE,
        subjectEmail: "prospect@acme.com",
      }),
    );
  });

  it("adds ORG+CRM_INACTIVE suppression for intent=negative_not_interested", async () => {
    const { svc, suppressionAdd, replyFindFirst } = makeSvc();
    replyFindFirst.mockResolvedValueOnce({
      id: "reply_1",
      orgId: "org_1",
      artifactId: "art_1",
      emailMessage: { fromEmail: "prospect@acme.com" },
      classifications: [
        {
          id: "cls_1",
          classifierName: "deterministic",
          classifierVersion: "1.0.0",
          intent: ReplyIntent10.negative_not_interested,
          confidence: 0.95,
          requiresHitl: false,
          createdAt: fixedNow,
        },
      ],
    });
    await svc.applyLatest("org_1", "reply_1");
    expect(suppressionAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: SuppressionKind.CRM_INACTIVE,
      }),
    );
  });

  it("adds ORG+OOO_COOLDOWN suppression with expiresAt=now+14d for intent=auto_reply_ooo", async () => {
    const { svc, suppressionAdd, replyFindFirst } = makeSvc();
    replyFindFirst.mockResolvedValueOnce({
      id: "reply_1",
      orgId: "org_1",
      artifactId: "art_1",
      emailMessage: { fromEmail: "prospect@acme.com" },
      classifications: [
        {
          id: "cls_1",
          classifierName: "deterministic",
          classifierVersion: "1.0.0",
          intent: ReplyIntent10.auto_reply_ooo,
          confidence: 0.95,
          requiresHitl: false,
          createdAt: fixedNow,
        },
      ],
    });
    await svc.applyLatest("org_1", "reply_1");
    const call = suppressionAdd.mock.calls[0][0];
    expect(call.kind).toBe(SuppressionKind.OOO_COOLDOWN);
    expect(call.expiresAt).toEqual(new Date("2026-01-15T00:00:00.000Z"));
  });

  it("adds ORG+LEGAL suppression and emits review evidence for intent=spam_or_legal_threat", async () => {
    const { svc, suppressionAdd, replyFindFirst, evidenceReplyFlagged } = makeSvc();
    replyFindFirst.mockResolvedValueOnce({
      id: "reply_1",
      orgId: "org_1",
      artifactId: "art_1",
      emailMessage: { fromEmail: "prospect@acme.com" },
      classifications: [
        {
          id: "cls_1",
          classifierName: "deterministic",
          classifierVersion: "1.0.0",
          intent: ReplyIntent10.spam_or_legal_threat,
          confidence: 0.95,
          requiresHitl: false,
          createdAt: fixedNow,
        },
      ],
    });
    await svc.applyLatest("org_1", "reply_1");
    expect(suppressionAdd).toHaveBeenCalledWith(
      expect.objectContaining({ kind: SuppressionKind.LEGAL }),
    );
    expect(evidenceReplyFlagged).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org_1",
        replyId: "reply_1",
        intent: ReplyIntent10.spam_or_legal_threat,
      }),
    );
  });

  it("marks artifact BOUNCED and emits transition for intent=bounce_or_ndr", async () => {
    const {
      svc,
      replyFindFirst,
      artifactUpdateMany,
      evidenceArtifactTransition,
    } = makeSvc();
    replyFindFirst.mockResolvedValueOnce({
      id: "reply_1",
      orgId: "org_1",
      artifactId: "art_1",
      emailMessage: { fromEmail: "prospect@acme.com" },
      classifications: [
        {
          id: "cls_1",
          classifierName: "deterministic",
          classifierVersion: "1.0.0",
          intent: ReplyIntent10.bounce_or_ndr,
          confidence: 0.95,
          requiresHitl: false,
          createdAt: fixedNow,
        },
      ],
    });

    await svc.applyLatest("org_1", "reply_1");
    expect(artifactUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: OutreachArtifactStatus.BOUNCED },
      }),
    );
    expect(evidenceArtifactTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        artifactId: "art_1",
        toStatus: OutreachArtifactStatus.BOUNCED,
        reason: "intent_classified:bounce_or_ndr",
      }),
    );
  });
});

