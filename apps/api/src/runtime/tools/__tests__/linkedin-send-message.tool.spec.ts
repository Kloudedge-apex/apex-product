import { describe, it, expect, beforeEach, vi } from "vitest";
import { LinkedInSendMessageTool } from "../linkedin-send-message.tool";
import type { LinkedInService, LinkedInSendResult } from "../../../integrations/linkedin/linkedin.service";
import type { EvidenceLedgerService } from "../../../observability/evidence-ledger.service";
import type { ToolContext, IntegrationCredentials } from "../tool.interface";

function makeContext(
  integrations: Map<string, IntegrationCredentials> = new Map(),
): ToolContext {
  return {
    orgId: "org_test",
    agentId: "agent_test",
    runId: "run_test",
    integrations,
  };
}

function liveCreds(): Map<string, IntegrationCredentials> {
  return new Map([
    ["linkedin", { provider: "linkedin", accessToken: "real_token_abc" }],
  ]);
}

function mockCreds(): Map<string, IntegrationCredentials> {
  return new Map([
    ["linkedin", { provider: "linkedin", accessToken: "mock_linkedin_token" }],
  ]);
}

function mockService(impl: (...args: unknown[]) => Promise<LinkedInSendResult>) {
  return {
    sendMessage: vi.fn(impl),
  } as unknown as LinkedInService & {
    sendMessage: ReturnType<typeof vi.fn>;
  };
}

function mockLedger() {
  return {
    messageSent: vi.fn().mockResolvedValue(undefined),
  } as unknown as EvidenceLedgerService & {
    messageSent: ReturnType<typeof vi.fn>;
  };
}

describe("LinkedInSendMessageTool", () => {
  describe("argument validation", () => {
    it("rejects when recipient_urn missing", async () => {
      const tool = new LinkedInSendMessageTool();
      const result = await tool.execute(
        { body: "hi" },
        makeContext(),
      );
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/recipient_urn/);
    });

    it("rejects when body missing", async () => {
      const tool = new LinkedInSendMessageTool();
      const result = await tool.execute(
        { recipient_urn: "urn:li:person:abc" },
        makeContext(),
      );
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/body/);
    });

    it("rejects when body exceeds 2000 chars", async () => {
      const tool = new LinkedInSendMessageTool();
      const result = await tool.execute(
        { recipient_urn: "urn:li:person:abc", body: "x".repeat(2001) },
        makeContext(),
      );
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/max length/);
    });
  });

  describe("mock / dry-run path", () => {
    it("returns mock receipt when no LinkedInService is injected", async () => {
      const ledger = mockLedger();
      const tool = new LinkedInSendMessageTool(undefined, ledger);
      const result = await tool.execute(
        { recipient_urn: "urn:li:person:abc", body: "hi" },
        makeContext(liveCreds()),
      );

      expect(result.success).toBe(true);
      const data = result.data as {
        mock: boolean;
        provider: string;
        would_send_to: string;
        sent: boolean;
      };
      expect(data.mock).toBe(true);
      expect(data.provider).toBe("linkedin");
      expect(data.would_send_to).toBe("urn:li:person:abc");
      expect(data.sent).toBe(false);
      // Mock path must NOT emit evidence — no real send happened.
      expect(ledger.messageSent).not.toHaveBeenCalled();
    });

    it("returns mock receipt when context has no live LinkedIn creds", async () => {
      const svc = mockService(async () => ({ ok: true, messageId: "x" }));
      const tool = new LinkedInSendMessageTool(svc);
      const result = await tool.execute(
        { recipient_urn: "urn:li:person:abc", body: "hi" },
        makeContext(), // empty integrations map
      );

      expect(result.success).toBe(true);
      expect((result.data as { mock: boolean }).mock).toBe(true);
      // Service must not be invoked when creds are absent.
      expect(svc.sendMessage).not.toHaveBeenCalled();
    });

    it("returns mock receipt when stored access token is a mock value", async () => {
      const svc = mockService(async () => ({ ok: true, messageId: "x" }));
      const tool = new LinkedInSendMessageTool(svc);
      const result = await tool.execute(
        { recipient_urn: "urn:li:person:abc", body: "hi" },
        makeContext(mockCreds()),
      );

      expect(result.success).toBe(true);
      expect((result.data as { mock: boolean }).mock).toBe(true);
      expect(svc.sendMessage).not.toHaveBeenCalled();
    });
  });

  describe("real-send path", () => {
    it("delegates to LinkedInService.sendMessage with normalized args", async () => {
      const svc = mockService(async () => ({
        ok: true,
        messageId: "linkedin_msg_42",
      }));
      const ledger = mockLedger();
      const tool = new LinkedInSendMessageTool(svc, ledger);

      const result = await tool.execute(
        {
          recipient_urn: "urn:li:person:abc",
          body: "hi",
          integration_id: "int_xyz",
        },
        makeContext(liveCreds()),
      );

      expect(result.success).toBe(true);
      expect(svc.sendMessage).toHaveBeenCalledTimes(1);
      expect(svc.sendMessage).toHaveBeenCalledWith(
        "org_test",
        "int_xyz",
        { recipientUrn: "urn:li:person:abc", body: "hi" },
      );
      const data = result.data as {
        sent: boolean;
        provider: string;
        messageId: string;
        recipient_urn: string;
      };
      expect(data.sent).toBe(true);
      expect(data.provider).toBe("linkedin");
      expect(data.messageId).toBe("linkedin_msg_42");
      expect(data.recipient_urn).toBe("urn:li:person:abc");
    });

    it("passes integration_id=null when omitted (org-default resolution)", async () => {
      const svc = mockService(async () => ({ ok: true, messageId: "id_1" }));
      const tool = new LinkedInSendMessageTool(svc);

      await tool.execute(
        { recipient_urn: "urn:li:person:abc", body: "hi" },
        makeContext(liveCreds()),
      );

      expect(svc.sendMessage).toHaveBeenCalledWith(
        "org_test",
        null,
        { recipientUrn: "urn:li:person:abc", body: "hi" },
      );
    });

    it("emits message.sent EvidenceEvent with channel=LINKEDIN on success", async () => {
      const svc = mockService(async () => ({
        ok: true,
        messageId: "linkedin_msg_42",
      }));
      const ledger = mockLedger();
      const tool = new LinkedInSendMessageTool(svc, ledger);

      await tool.execute(
        { recipient_urn: "urn:li:person:abc", body: "hi" },
        makeContext(liveCreds()),
      );

      expect(ledger.messageSent).toHaveBeenCalledTimes(1);
      expect(ledger.messageSent).toHaveBeenCalledWith(
        expect.objectContaining({
          orgId: "org_test",
          runId: "run_test",
          artifactId: null,
          channel: "LINKEDIN",
          recipientRef: "urn:li:person:abc",
          sendReceiptId: "linkedin_msg_42",
          provider: "linkedin",
          refType: "outreach_tool_call",
          refId: "linkedin_msg_42",
        }),
      );
    });

    it("returns success=false with stable error code when LinkedInService rejects (403)", async () => {
      const svc = mockService(async () => ({
        ok: false,
        error: "linkedin_api_not_available",
        status: 403,
        details: "permission denied",
      }));
      const ledger = mockLedger();
      const tool = new LinkedInSendMessageTool(svc, ledger);

      const result = await tool.execute(
        { recipient_urn: "urn:li:person:abc", body: "hi" },
        makeContext(liveCreds()),
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe("linkedin_api_not_available");
      const data = result.data as {
        sent: boolean;
        provider: string;
        status: number;
        details: string;
      };
      expect(data.sent).toBe(false);
      expect(data.provider).toBe("linkedin");
      expect(data.status).toBe(403);
      // Failure must NOT emit evidence.
      expect(ledger.messageSent).not.toHaveBeenCalled();
    });

    it("does not throw when evidence ledger is not injected", async () => {
      const svc = mockService(async () => ({ ok: true, messageId: "id" }));
      const tool = new LinkedInSendMessageTool(svc); // no ledger

      const result = await tool.execute(
        { recipient_urn: "urn:li:person:abc", body: "hi" },
        makeContext(liveCreds()),
      );

      expect(result.success).toBe(true);
    });
  });
});
