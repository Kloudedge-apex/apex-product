import { BadRequestException } from "@nestjs/common";
import {
  OutreachArtifactPurpose,
  OutreachArtifactStatus,
  OutreachChannel,
  type OutreachArtifact,
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  assertArtifactDispatchEligible,
  assertArtifactRecipientCurrent,
} from "../outreach-artifact-eligibility";

function approvablePayload(overrides: Record<string, unknown> = {}) {
  return {
    to: "dest@example.com",
    subject: "Hi",
    body: "Body",
    qaIssues: [],
    brief_facts: [
      {
        id: "F1",
        category: "firmographic",
        source: "company.registry",
        text: "Company: Acme.",
      },
      {
        id: "S1",
        category: "signal",
        source: "https://example.com/source",
        text: "Acme launched a new product.",
        date: "2026-08-10",
      },
    ],
    groundedness_self_check: {
      citedFactIds: ["S1"],
      unsupportedClaims: [],
    },
    ...overrides,
  };
}

function artifactRow(
  payload = approvablePayload(),
  overrides: Partial<OutreachArtifact> = {},
): OutreachArtifact {
  const now = new Date("2026-08-13T12:00:00Z");
  return {
    id: "art_1",
    orgId: "org_1",
    graphRunId: "graph_1",
    purpose: OutreachArtifactPurpose.OUTBOUND,
    conversationId: null,
    providerThreadId: null,
    replyToMessageId: null,
    toolName: "send_email",
    channel: OutreachChannel.EMAIL,
    recipientRef: "dest@example.com",
    subject: "Hi",
    bodyText: "Body",
    bodyHtml: null,
    payload,
    status: OutreachArtifactStatus.PENDING_REVIEW,
    reviewerNote: null,
    reviewedBy: null,
    reviewedAt: null,
    failureReason: null,
    failedAt: null,
    sentAt: null,
    sendReceiptId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function expectRejected(
  payload: Record<string, unknown>,
  message: string,
): void {
  expect(() => assertArtifactDispatchEligible(artifactRow(payload))).toThrow(
    new BadRequestException(message),
  );
}

describe("assertArtifactDispatchEligible", () => {
  it("accepts a clean outbound artifact that cites a signal fact", () => {
    expect(() => assertArtifactDispatchEligible(artifactRow())).not.toThrow();
  });

  it("rejects an unsupported explicit email body format", () => {
    expectRejected(
      approvablePayload({ bodyContentType: "markdown" }),
      "Artifact cannot be approved because its email body format is invalid",
    );
  });

  it.each([
    approvablePayload({ bodyContentType: "html" }),
    approvablePayload({ body: "<p>Body</p>" }),
  ])(
    "rejects HTML rendering that is not bound to the plain-text review surface",
    (payload) => {
      const body = String(payload.body);
      expect(() =>
        assertArtifactDispatchEligible(
          artifactRow(payload, { bodyText: body }),
        ),
      ).toThrow(
        new BadRequestException(
          "Artifact cannot be approved because this release only dispatches reviewer-bound plain-text bodies",
        ),
      );
    },
  );

  it("binds approval to bodyText even when bodyHtml matches the send payload", () => {
    expect(() =>
      assertArtifactDispatchEligible(
        artifactRow(approvablePayload(), {
          bodyText: "Reviewer-visible plain text",
          bodyHtml: "Body",
        }),
      ),
    ).toThrow(
      new BadRequestException(
        "Artifact cannot be approved because the reviewed content does not match the send payload",
      ),
    );
  });

  it("allows optional bodyHtml to differ when bodyText matches the send payload", () => {
    expect(() =>
      assertArtifactDispatchEligible(
        artifactRow(approvablePayload(), {
          bodyHtml: "<p>Different optional HTML</p>",
        }),
      ),
    ).not.toThrow();
  });

  it("accepts a reply whose provider payload matches the reviewed plain-text body", () => {
    expect(() =>
      assertArtifactDispatchEligible(
        artifactRow(
          {
            to: "dest@example.com",
            subject: "Re: Hi",
            body: "Thanks <team>.\n\nTuesday works.",
            bodyContentType: "text",
            provider: "gmail",
            threadId: "gmail-thread-1",
          },
          {
            purpose: OutreachArtifactPurpose.REPLY,
            subject: "Re: Hi",
            bodyText: "Thanks <team>.\n\nTuesday works.",
            bodyHtml: "<p>Thanks &lt;team&gt;.</p>\n<p>Tuesday works.</p>",
          },
        ),
      ),
    ).not.toThrow();
  });

  it("rejects a reply when its provider payload differs from the reviewed body", () => {
    expect(() =>
      assertArtifactDispatchEligible(
        artifactRow(
          {
            to: "dest@example.com",
            subject: "Re: Hi",
            body: "<p>Thanks.</p>",
          },
          {
            purpose: OutreachArtifactPurpose.REPLY,
            subject: "Re: Hi",
            bodyText: "Thanks.",
            bodyHtml: "<p>Thanks.</p>",
          },
        ),
      ),
    ).toThrow(
      new BadRequestException(
        "Artifact cannot be approved because the reviewed content does not match the send payload",
      ),
    );
  });

  it("rejects a draft that cites only a static reviewer-visible fact", () => {
    expectRejected(
      approvablePayload({
        groundedness_self_check: {
          citedFactIds: ["F1"],
          unsupportedClaims: [],
        },
      }),
      "Artifact cannot be approved without citing a verified signal or company-site excerpt",
    );
  });

  it.each([{}, [123], [""]])(
    "rejects malformed QA metadata: %j",
    (qaIssues) => {
      expectRejected(
        approvablePayload({ qaIssues }),
        "Artifact cannot be approved because its draft quality metadata is invalid",
      );
    },
  );

  it("rejects a well-formed failed QA check", () => {
    expectRejected(
      approvablePayload({ qaIssues: ["missing personalized trigger"] }),
      "Artifact cannot be approved until all draft quality checks pass",
    );
  });

  it.each([
    {},
    { reason: "", missing: [] },
    { reason: "insufficient_grounding", missing: "signals" },
  ])("rejects malformed refusal metadata: %j", (refusal) => {
    expectRejected(
      approvablePayload({ refusal }),
      "Artifact cannot be approved because its refusal metadata is invalid",
    );
  });

  it("rejects a well-formed refusal", () => {
    expectRejected(
      approvablePayload({
        refusal: {
          reason: "insufficient_grounding",
          missing: ["fresh signal"],
        },
      }),
      "Artifact cannot be approved because the agent refused to produce a grounded draft",
    );
  });

  it.each([
    {
      citedFactIds: ["S1", 123],
      unsupportedClaims: [],
    },
    {
      citedFactIds: ["S1"],
      unsupportedClaims: [123],
    },
    {
      citedFactIds: "S1",
      unsupportedClaims: [],
    },
  ])("rejects a malformed groundedness self-check: %j", (selfCheck) => {
    expectRejected(
      approvablePayload({ groundedness_self_check: selfCheck }),
      "Artifact cannot be approved without a clean, reviewer-visible grounding check",
    );
  });

  it.each([
    [
      {
        id: "S1",
        category: "signal",
        text: "Acme launched a new product.",
      },
    ],
    [
      {
        id: "S1",
        category: "signal",
        source: "https://example.com/source",
        text: "Acme launched a new product.",
      },
      {
        id: "S1",
        category: "signal",
        source: "https://example.com/duplicate",
        text: "Duplicate fact.",
      },
    ],
  ])("rejects malformed reviewer-visible facts: %j", (briefFacts) => {
    expectRejected(
      approvablePayload({ brief_facts: briefFacts }),
      "Artifact cannot be approved without a clean, reviewer-visible grounding check",
    );
  });

  it("rejects a cited fact ID that is absent from the reviewer-visible brief", () => {
    expectRejected(
      approvablePayload({
        groundedness_self_check: {
          citedFactIds: ["S2"],
          unsupportedClaims: [],
        },
      }),
      "Artifact cannot be approved without a clean, reviewer-visible grounding check",
    );
  });
});

describe("assertArtifactRecipientCurrent", () => {
  const verifiedAt = "2026-08-13T12:00:00.000Z";
  const candidate = {
    id: "email_1",
    email: "dest@example.com",
    source: "PATTERN_GUESS" as const,
    verified: true,
    verificationResult: "VALID" as const,
    confidence: 0.9,
    verifiedAt: new Date(verifiedAt),
    createdAt: new Date("2026-08-12T12:00:00.000Z"),
  };
  const payload = approvablePayload({
    bodyContentType: "text",
    personId: "person_1",
    recipient_provenance: {
      candidateId: "email_1",
      email: "dest@example.com",
      source: "PATTERN_GUESS",
      verified: true,
      verificationResult: "VALID",
      confidence: 0.9,
      verifiedAt,
      selectionBasis: "VERIFIED_VALID",
    },
  });

  it("accepts the same current org-owned deterministic candidate", async () => {
    const store = {
      person: {
        findFirst: vi.fn().mockResolvedValue({ emails: [candidate] }),
      },
    };

    await expect(
      assertArtifactRecipientCurrent(store as never, artifactRow(payload)),
    ).resolves.toBeUndefined();
    expect(store.person.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "person_1", company: { orgId: "org_1" } },
      }),
    );
  });

  it("rejects when the snapshotted candidate became invalid", async () => {
    const store = {
      person: {
        findFirst: vi.fn().mockResolvedValue({
          emails: [
            {
              ...candidate,
              verified: false,
              verificationResult: "INVALID",
              verifiedAt: null,
            },
          ],
        }),
      },
    };

    await expect(
      assertArtifactRecipientCurrent(store as never, artifactRow(payload)),
    ).rejects.toThrow(
      "exact recipient snapshot is no longer current and eligible",
    );
  });

  it("does not require a person snapshot for a conversation reply", async () => {
    const store = { person: { findFirst: vi.fn() } };
    await expect(
      assertArtifactRecipientCurrent(
        store as never,
        artifactRow(
          {
            to: "dest@example.com",
            subject: "Re: Hi",
            body: "Reply",
            bodyContentType: "text",
          },
          {
            purpose: OutreachArtifactPurpose.REPLY,
            bodyText: "Reply",
            subject: "Re: Hi",
          },
        ),
      ),
    ).resolves.toBeUndefined();
    expect(store.person.findFirst).not.toHaveBeenCalled();
  });
});
