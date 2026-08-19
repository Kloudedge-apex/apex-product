/**
 * GL2 contract tests for SendEmailTool: every result must truthfully carry
 * the provider/mode actually used ("outlook" | "gmail" | "mock") so the
 * outreach worker can refuse to record a mock fallback as SENT.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { circuitBreakerRegistry } from "../../../common/http-retry.util";
import {
  EMAIL_DISPATCH_OUTCOME,
  SendEmailTool,
  getEmailDispatchOutcome,
  isMockModeResult,
} from "../send-email.tool";
import type { IntegrationCredentials, ToolContext, ToolResult } from "../tool.interface";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_API_PUBLIC_URL = process.env.API_PUBLIC_URL;

function mockResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function buildContext(
  integrations: Map<string, IntegrationCredentials> = new Map(),
  simulationMode = false,
): ToolContext {
  return {
    orgId: "org_test",
    agentId: "agent_test",
    runId: "run_test",
    integrations,
    simulationMode,
  };
}

function creds(provider: string, accessToken: string): IntegrationCredentials {
  return { provider, accessToken };
}

const PARAMS = {
  to: "dest@example.com",
  subject: "Hi",
  body: "Body",
};

function dataOf(result: ToolResult): Record<string, unknown> {
  expect(result.data).toBeTypeOf("object");
  return result.data as Record<string, unknown>;
}

beforeEach(() => {
  circuitBreakerRegistry._resetForTests();
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  if (ORIGINAL_API_PUBLIC_URL === undefined) delete process.env.API_PUBLIC_URL;
  else process.env.API_PUBLIC_URL = ORIGINAL_API_PUBLIC_URL;
});

describe("SendEmailTool — provider/mode stamping (GL2)", () => {
  it("fails truthfully when no credentials exist and simulation was not requested", async () => {
    const tool = new SendEmailTool();
    const result = await tool.execute(PARAMS, buildContext());

    expect(result.success).toBe(false);
    const data = dataOf(result);
    expect(data.sent).toBe(false);
    expect(getEmailDispatchOutcome(result)).toBe(
      EMAIL_DISPATCH_OUTCOME.NOT_ATTEMPTED,
    );
    expect(isMockModeResult(result)).toBe(false);
    expect(result.error).toMatch(/No usable Gmail or Outlook credentials/);
  });

  it("simulates only when the guarded caller requests simulation explicitly", async () => {
    const tool = new SendEmailTool();
    const integrations = new Map<string, IntegrationCredentials>([
      ["gmail", creds("gmail", "mock_token_123")],
      ["outlook", creds("outlook", "mock_token_456")],
    ]);
    const result = await tool.execute(
      PARAMS,
      buildContext(integrations, true),
    );

    expect(result.success).toBe(true);
    expect(dataOf(result).provider).toBe("mock");
    expect(isMockModeResult(result)).toBe(true);
  });

  it("stamps provider='gmail' on a successful Gmail send (not mock mode)", async () => {
    globalThis.fetch = (async () =>
      mockResponse(200, { id: "gmail_msg_1" })) as typeof fetch;
    const tool = new SendEmailTool();
    const integrations = new Map<string, IntegrationCredentials>([
      ["gmail", creds("gmail", "real-token")],
    ]);

    const result = await tool.execute(PARAMS, buildContext(integrations));

    expect(result.success).toBe(true);
    const data = dataOf(result);
    expect(data.provider).toBe("gmail");
    expect(data.sent).toBe(true);
    expect(data.messageId).toBe("gmail_msg_1");
    expect(getEmailDispatchOutcome(result)).toBe(
      EMAIL_DISPATCH_OUTCOME.CONFIRMED_SENT,
    );
    expect(isMockModeResult(result)).toBe(false);
  });

  it("keeps a Gmail reply in its provider thread and emits RFC reply headers", async () => {
    let requestBody: Record<string, unknown> | null = null;
    globalThis.fetch = (async (_url, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return mockResponse(200, { id: "gmail_reply_1", threadId: "thread_1" });
    }) as typeof fetch;
    const tool = new SendEmailTool();
    const integrations = new Map<string, IntegrationCredentials>([
      ["outlook", creds("outlook", "real-outlook-token")],
      ["gmail", creds("gmail", "real-gmail-token")],
    ]);

    const result = await tool.execute(
      {
        ...PARAMS,
        body: "Thanks <team>.\n\nTuesday works.",
        bodyContentType: "text",
        provider: "gmail",
        threadId: "thread_1",
        inReplyTo: "<message-1@example.com>",
      },
      buildContext(integrations),
    );

    expect(result.success).toBe(true);
    expect(dataOf(result)).toMatchObject({
      provider: "gmail",
      messageId: "gmail_reply_1",
      threadId: "thread_1",
    });
    expect(requestBody).toMatchObject({ threadId: "thread_1" });
    const raw = String(requestBody?.raw ?? "");
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    expect(decoded).toContain("In-Reply-To: <message-1@example.com>");
    expect(decoded).toContain("References: <message-1@example.com>");
    expect(decoded).toContain("Content-Type: text/plain; charset=utf-8");
    expect(decoded).toContain("\r\n\r\nThanks <team>.\n\nTuesday works.");
  });

  it("sends reviewed plain text through Outlook without interpreting it as HTML", async () => {
    let requestBody: Record<string, unknown> | null = null;
    globalThis.fetch = (async (_url, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return mockResponse(202, {});
    }) as typeof fetch;

    const result = await new SendEmailTool().execute(
      {
        ...PARAMS,
        body: "Thanks <team>.\n\nTuesday works.",
        bodyContentType: "text",
      },
      buildContext(
        new Map([["outlook", creds("outlook", "real-token")]]),
      ),
    );

    expect(result.success).toBe(true);
    expect(requestBody).toMatchObject({
      message: {
        body: {
          contentType: "Text",
          content: "Thanks <team>.\n\nTuesday works.",
        },
      },
    });
  });

  it("infers plain text for legacy artifacts that predate bodyContentType", async () => {
    let raw = "";
    globalThis.fetch = (async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as { raw?: string };
      raw = request.raw ?? "";
      return mockResponse(200, { id: "gmail_legacy_text" });
    }) as typeof fetch;

    const result = await new SendEmailTool().execute(
      { ...PARAMS, body: "First line\n\nSecond line" },
      buildContext(new Map([["gmail", creds("gmail", "real-token")]])),
    );

    expect(result.success).toBe(true);
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    expect(decoded).toContain("Content-Type: text/plain; charset=utf-8");
    expect(decoded).toContain("\r\n\r\nFirst line\n\nSecond line");
  });

  it("advertises only the public HTTPS one-click URL in Gmail unsubscribe headers", async () => {
    process.env.NODE_ENV = "production";
    process.env.API_PUBLIC_URL = "https://api.workforceos.xyz";
    let requestBody: Record<string, unknown> | null = null;
    globalThis.fetch = (async (_url, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return mockResponse(200, { id: "gmail_msg_1" });
    }) as typeof fetch;

    const result = await new SendEmailTool().execute(
      PARAMS,
      buildContext(
        new Map([["gmail", creds("gmail", "real-token")]]),
      ),
    );

    expect(result.success).toBe(true);
    const raw = String(requestBody?.raw ?? "");
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    expect(decoded).toMatch(
      /List-Unsubscribe: <https:\/\/api\.workforceos\.xyz\/api\/u\/[A-Za-z0-9_.~%-]+>/,
    );
    expect(decoded).toContain(
      "List-Unsubscribe-Post: List-Unsubscribe=One-Click",
    );
    expect(decoded).not.toContain("mailto:");
  });

  it("advertises only the public HTTPS one-click URL in Outlook headers", async () => {
    process.env.NODE_ENV = "production";
    process.env.API_PUBLIC_URL = "https://api.workforceos.xyz";
    let requestBody: Record<string, unknown> | null = null;
    globalThis.fetch = (async (_url, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return mockResponse(202, {});
    }) as typeof fetch;

    const result = await new SendEmailTool().execute(
      PARAMS,
      buildContext(
        new Map([["outlook", creds("outlook", "real-token")]]),
      ),
    );

    expect(result.success).toBe(true);
    const message = requestBody?.message as
      | { internetMessageHeaders?: Array<{ name: string; value: string }> }
      | undefined;
    const unsubscribe = message?.internetMessageHeaders?.find(
      (header) => header.name === "List-Unsubscribe",
    );
    expect(unsubscribe?.value).toMatch(
      /^<https:\/\/api\.workforceos\.xyz\/api\/u\/[A-Za-z0-9_.~%-]+>$/,
    );
    expect(unsubscribe?.value).not.toContain("mailto:");
  });

  it("rejects CRLF header injection before making a provider request", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return mockResponse(200, { id: "should_not_send" });
    }) as typeof fetch;
    const tool = new SendEmailTool();
    const integrations = new Map<string, IntegrationCredentials>([
      ["gmail", creds("gmail", "real-token")],
    ]);

    const result = await tool.execute(
      { ...PARAMS, subject: "Hello\r\nBcc: attacker@example.com" },
      buildContext(integrations),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("invalid line breaks");
    expect(getEmailDispatchOutcome(result)).toBe(
      EMAIL_DISPATCH_OUTCOME.NOT_ATTEMPTED,
    );
    expect(called).toBe(false);
  });

  it("rejects an unknown body content type before making a provider request", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return mockResponse(200, { id: "should_not_send" });
    }) as typeof fetch;

    const result = await new SendEmailTool().execute(
      { ...PARAMS, bodyContentType: "markdown" },
      buildContext(
        new Map([["gmail", creds("gmail", "real-token")]]),
      ),
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("bodyContentType must be text or html");
    expect(getEmailDispatchOutcome(result)).toBe(
      EMAIL_DISPATCH_OUTCOME.NOT_ATTEMPTED,
    );
    expect(called).toBe(false);
  });

  it("stamps provider='gmail' on a FAILED Gmail send so the failure is attributable", async () => {
    // 500 is non-retryable per http-retry.util (only 429/503 retry) — a
    // single fetch resolves the call.
    globalThis.fetch = (async () => mockResponse(500, {})) as typeof fetch;
    const tool = new SendEmailTool();
    const integrations = new Map<string, IntegrationCredentials>([
      ["gmail", creds("gmail", "real-token")],
    ]);

    const result = await tool.execute(PARAMS, buildContext(integrations));

    expect(result.success).toBe(false);
    const data = dataOf(result);
    expect(data.sent).toBe(false);
    expect(data.provider).toBe("gmail");
    expect(getEmailDispatchOutcome(result)).toBe(
      EMAIL_DISPATCH_OUTCOME.CONFIRMED_NOT_SENT,
    );
    // A real-provider failure is NOT mock mode — the worker must throw on
    // success:false, not misclassify it.
    expect(isMockModeResult(result)).toBe(false);
  });

  it("stamps provider='outlook' on success and failure via Graph", async () => {
    globalThis.fetch = (async () => mockResponse(202, {})) as typeof fetch;
    const tool = new SendEmailTool();
    const integrations = new Map<string, IntegrationCredentials>([
      ["outlook", creds("outlook", "real-token")],
    ]);

    const ok = await tool.execute(PARAMS, buildContext(integrations));
    expect(ok.success).toBe(true);
    expect(dataOf(ok).provider).toBe("outlook");
    expect(getEmailDispatchOutcome(ok)).toBe(
      EMAIL_DISPATCH_OUTCOME.CONFIRMED_SENT,
    );
    expect(isMockModeResult(ok)).toBe(false);

    globalThis.fetch = (async () => mockResponse(500, {})) as typeof fetch;
    const failed = await tool.execute(PARAMS, buildContext(integrations));
    expect(failed.success).toBe(false);
    expect(dataOf(failed).provider).toBe("outlook");
    expect(getEmailDispatchOutcome(failed)).toBe(
      EMAIL_DISPATCH_OUTCOME.CONFIRMED_NOT_SENT,
    );
    expect(isMockModeResult(failed)).toBe(false);
  });

  it("rejects missing params without stamping a provider", async () => {
    const tool = new SendEmailTool();
    const result = await tool.execute({ to: "x@example.com" }, buildContext());
    expect(result.success).toBe(false);
    expect(dataOf(result)).not.toHaveProperty("provider");
    expect(getEmailDispatchOutcome(result)).toBe(
      EMAIL_DISPATCH_OUTCOME.NOT_ATTEMPTED,
    );
    expect(isMockModeResult(result)).toBe(false);
  });

  it("makes one provider POST and reports DELIVERY_UNKNOWN when the response is lost", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      throw new TypeError("socket closed before response");
    }) as typeof fetch;
    const tool = new SendEmailTool();
    const integrations = new Map<string, IntegrationCredentials>([
      ["gmail", creds("gmail", "real-token")],
    ]);

    const result = await tool.execute(PARAMS, buildContext(integrations));

    expect(result.success).toBe(false);
    expect(calls).toBe(1);
    expect(getEmailDispatchOutcome(result)).toBe(
      EMAIL_DISPATCH_OUTCOME.DELIVERY_UNKNOWN,
    );
  });

  it("makes one provider POST and reports confirmed rejection for 503", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return mockResponse(503, {});
    }) as typeof fetch;
    const tool = new SendEmailTool();
    const integrations = new Map<string, IntegrationCredentials>([
      ["gmail", creds("gmail", "real-token")],
    ]);

    const result = await tool.execute(PARAMS, buildContext(integrations));

    expect(result.success).toBe(false);
    expect(calls).toBe(1);
    expect(getEmailDispatchOutcome(result)).toBe(
      EMAIL_DISPATCH_OUTCOME.CONFIRMED_NOT_SENT,
    );
  });

  it("reports DELIVERY_UNKNOWN when Gmail returns success without its required message id", async () => {
    globalThis.fetch = (async () => mockResponse(200, {})) as typeof fetch;
    const tool = new SendEmailTool();
    const integrations = new Map<string, IntegrationCredentials>([
      ["gmail", creds("gmail", "real-token")],
    ]);

    const result = await tool.execute(PARAMS, buildContext(integrations));

    expect(result.success).toBe(false);
    expect(getEmailDispatchOutcome(result)).toBe(
      EMAIL_DISPATCH_OUTCOME.DELIVERY_UNKNOWN,
    );
  });

  it("reports NOT_ATTEMPTED while the provider circuit is open", async () => {
    const breaker = circuitBreakerRegistry.get("gmail");
    for (let attempt = 0; attempt < 5; attempt++) {
      await expect(
        breaker.execute(async () => {
          throw new Error("trip breaker");
        }),
      ).rejects.toThrow("trip breaker");
    }
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return mockResponse(200, { id: "should_not_send" });
    }) as typeof fetch;
    const tool = new SendEmailTool();
    const integrations = new Map<string, IntegrationCredentials>([
      ["gmail", creds("gmail", "real-token")],
    ]);

    const result = await tool.execute(PARAMS, buildContext(integrations));

    expect(result.success).toBe(false);
    expect(calls).toBe(0);
    expect(getEmailDispatchOutcome(result)).toBe(
      EMAIL_DISPATCH_OUTCOME.NOT_ATTEMPTED,
    );
  });
});

describe("isMockModeResult", () => {
  it("is true when data.provider === 'mock'", () => {
    expect(
      isMockModeResult({ success: true, data: { provider: "mock" } }),
    ).toBe(true);
  });

  it("is true when data.mock === true (e.g. LinkedIn mock receipts keep provider='linkedin')", () => {
    expect(
      isMockModeResult({
        success: true,
        data: { mock: true, provider: "linkedin", messageId: "mock_linkedin_1" },
      }),
    ).toBe(true);
  });

  it("is false for real-provider results", () => {
    expect(
      isMockModeResult({
        success: true,
        data: { sent: true, provider: "gmail", messageId: "g_1" },
      }),
    ).toBe(false);
  });

  it("is false for null / non-object / array data (other checks own malformed results)", () => {
    expect(isMockModeResult({ success: false, data: null })).toBe(false);
    expect(isMockModeResult({ success: true, data: "mock" })).toBe(false);
    expect(isMockModeResult({ success: true, data: [{ mock: true }] })).toBe(false);
  });

  it("is false when mock flag is truthy-but-not-true (strict check)", () => {
    expect(isMockModeResult({ success: true, data: { mock: "true" } })).toBe(false);
  });
});
