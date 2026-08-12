import { BadRequestException } from "@nestjs/common";
import {
  OutreachArtifactPurpose,
  OutreachArtifactStatus,
  OutreachChannel,
  type OutreachArtifact,
} from "@prisma/client";
import { describe, expect, it } from "vitest";
import { assertArtifactDispatchEligible } from "../outreach-artifact-eligibility";

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

  it("rejects a draft that cites only a static reviewer-visible fact", () => {
    expectRejected(
      approvablePayload({
        groundedness_self_check: {
          citedFactIds: ["F1"],
          unsupportedClaims: [],
        },
      }),
      "Artifact cannot be approved without citing a fresh, non-mock signal",
    );
  });

  it.each([
    {},
    [123],
    [""],
  ])("rejects malformed QA metadata: %j", (qaIssues) => {
    expectRejected(
      approvablePayload({ qaIssues }),
      "Artifact cannot be approved because its draft quality metadata is invalid",
    );
  });

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
