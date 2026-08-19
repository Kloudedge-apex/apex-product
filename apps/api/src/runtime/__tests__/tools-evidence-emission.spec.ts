import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SendEmailTool } from "../tools/send-email.tool";
import { HubSpotTool } from "../tools/hubspot.tool";
import type { ToolContext } from "../tools/tool.interface";
import type { EvidenceLedgerService } from "../../observability/evidence-ledger.service";

function makeContext(integrations: Map<string, { provider: string; accessToken: string }>): ToolContext {
  return {
    orgId: "org_test",
    agentId: "agent_test",
    runId: "run_test",
    integrations,
  };
}

function makeLedger() {
  return {
    messageSent: vi.fn().mockResolvedValue(undefined),
    crmSynced: vi.fn().mockResolvedValue(undefined),
  } as unknown as EvidenceLedgerService & {
    messageSent: ReturnType<typeof vi.fn>;
    crmSynced: ReturnType<typeof vi.fn>;
  };
}

describe("SendEmailTool evidence emission", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("emits message.sent (refType=outreach_tool_call) on real Gmail success", async () => {
    const ledger = makeLedger();
    const tool = new SendEmailTool(ledger);

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "gmail_abc123" }),
    }) as unknown as typeof fetch;

    const ctx = makeContext(
      new Map([["gmail", { provider: "gmail", accessToken: "real_token_xyz" }]]),
    );

    const result = await tool.execute(
      { to: "alice@example.com", subject: "hi", body: "hello" },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(ledger.messageSent).toHaveBeenCalledTimes(1);
    const call = ledger.messageSent.mock.calls[0]?.[0];
    expect(call).toMatchObject({
      orgId: "org_test",
      runId: "run_test",
      artifactId: null,
      channel: "EMAIL",
      recipientRef: "alice@example.com",
      subject: "hi",
      sendReceiptId: "gmail_abc123",
      provider: "gmail",
      refType: "outreach_tool_call",
      refId: "gmail_abc123",
    });
  });

  it("does NOT emit message.sent when credentials are unavailable", async () => {
    const ledger = makeLedger();
    const tool = new SendEmailTool(ledger);

    const ctx = makeContext(new Map());
    const result = await tool.execute(
      { to: "alice@example.com", subject: "hi", body: "hello" },
      ctx,
    );

    expect(result.success).toBe(false);
    expect((result.data as { sent?: boolean }).sent).toBe(false);
    expect(ledger.messageSent).not.toHaveBeenCalled();
  });

  it("does NOT emit message.sent when real Gmail send fails", async () => {
    const ledger = makeLedger();
    const tool = new SendEmailTool(ledger);

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "boom",
      json: async () => ({}),
    }) as unknown as typeof fetch;

    const ctx = makeContext(
      new Map([["gmail", { provider: "gmail", accessToken: "real_token_xyz" }]]),
    );

    const result = await tool.execute(
      { to: "alice@example.com", subject: "hi", body: "hello" },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(ledger.messageSent).not.toHaveBeenCalled();
  });

  it("works without a ledger injected (no-op, no throw)", async () => {
    const tool = new SendEmailTool();

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "gmail_abc123" }),
    }) as unknown as typeof fetch;

    const ctx = makeContext(
      new Map([["gmail", { provider: "gmail", accessToken: "real_token_xyz" }]]),
    );

    const result = await tool.execute(
      { to: "alice@example.com", subject: "hi", body: "hello" },
      ctx,
    );

    expect(result.success).toBe(true);
  });
});

describe("HubSpotTool evidence emission", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("emits crm.synced on create_contact success", async () => {
    const ledger = makeLedger();
    const tool = new HubSpotTool(ledger);

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "hs_contact_42" }),
    }) as unknown as typeof fetch;

    const ctx = makeContext(
      new Map([["hubspot", { provider: "hubspot", accessToken: "real_hs_token" }]]),
    );

    const result = await tool.execute(
      { action: "create_contact", data: { email: "a@b.com", firstname: "A" } },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(ledger.crmSynced).toHaveBeenCalledTimes(1);
    expect(ledger.crmSynced.mock.calls[0]?.[0]).toMatchObject({
      orgId: "org_test",
      runId: "run_test",
      provider: "hubspot",
      entityType: "contact",
      entityId: "hs_contact_42",
      operation: "create",
    });
    const fields = ledger.crmSynced.mock.calls[0]?.[0]?.fieldsChanged;
    expect(fields).toEqual(["email", "firstname"]);
  });

  it("emits crm.synced on create_deal success", async () => {
    const ledger = makeLedger();
    const tool = new HubSpotTool(ledger);

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "hs_deal_77" }),
    }) as unknown as typeof fetch;

    const ctx = makeContext(
      new Map([["hubspot", { provider: "hubspot", accessToken: "real_hs_token" }]]),
    );

    const result = await tool.execute(
      { action: "create_deal", data: { dealname: "Test Deal", amount: 1000 } },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(ledger.crmSynced).toHaveBeenCalledTimes(1);
    expect(ledger.crmSynced.mock.calls[0]?.[0]).toMatchObject({
      provider: "hubspot",
      entityType: "deal",
      entityId: "hs_deal_77",
      operation: "create",
    });
  });

  it("emits crm.synced with operation=update on update_contact", async () => {
    const ledger = makeLedger();
    const tool = new HubSpotTool(ledger);

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "hs_contact_42" }),
    }) as unknown as typeof fetch;

    const ctx = makeContext(
      new Map([["hubspot", { provider: "hubspot", accessToken: "real_hs_token" }]]),
    );

    const result = await tool.execute(
      { action: "update_contact", data: { id: "hs_contact_42", firstname: "B" } },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(ledger.crmSynced.mock.calls[0]?.[0]).toMatchObject({
      entityType: "contact",
      operation: "update",
      entityId: "hs_contact_42",
    });
  });

  it("emits crm.synced for log_activity (note creation)", async () => {
    const ledger = makeLedger();
    const tool = new HubSpotTool(ledger);

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "hs_note_9" }),
    }) as unknown as typeof fetch;

    const ctx = makeContext(
      new Map([["hubspot", { provider: "hubspot", accessToken: "real_hs_token" }]]),
    );

    const result = await tool.execute(
      { action: "log_activity", data: { note: "Called the lead" } },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(ledger.crmSynced.mock.calls[0]?.[0]).toMatchObject({
      entityType: "note",
      operation: "create",
      entityId: "hs_note_9",
    });
  });

  it("does NOT emit crm.synced for search_contacts (read-only op)", async () => {
    const ledger = makeLedger();
    const tool = new HubSpotTool(ledger);

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [] }),
    }) as unknown as typeof fetch;

    const ctx = makeContext(
      new Map([["hubspot", { provider: "hubspot", accessToken: "real_hs_token" }]]),
    );

    const result = await tool.execute(
      { action: "search_contacts", data: { email: "x@y.com" } },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(ledger.crmSynced).not.toHaveBeenCalled();
  });

  it("fails explicitly and does NOT emit crm.synced without real credentials", async () => {
    const ledger = makeLedger();
    const tool = new HubSpotTool(ledger);

    const ctx = makeContext(new Map());
    const result = await tool.execute(
      { action: "create_contact", data: { email: "a@b.com" } },
      ctx,
    );

    expect(result).toMatchObject({ success: false, data: null });
    expect(result.error).toMatch(/not connected with live credentials/);
    expect(ledger.crmSynced).not.toHaveBeenCalled();
  });

  it("does NOT emit crm.synced when HubSpot API call fails", async () => {
    const ledger = makeLedger();
    const tool = new HubSpotTool(ledger);

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({}),
    }) as unknown as typeof fetch;

    const ctx = makeContext(
      new Map([["hubspot", { provider: "hubspot", accessToken: "real_hs_token" }]]),
    );

    const result = await tool.execute(
      { action: "create_contact", data: { email: "a@b.com" } },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(ledger.crmSynced).not.toHaveBeenCalled();
  });
});
