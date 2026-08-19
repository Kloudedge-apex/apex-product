import { describe, it, expect, beforeEach } from "vitest";
import { ToolRegistry } from "../tools/registry";
import { Tool, ToolContext, ToolResult, toolToOpenAIFunction } from "../tools/tool.interface";

class MockTool implements Tool {
  name = "mock_tool";
  description = "A mock tool for testing";
  parameters = {
    input: { type: "string", description: "Test input", required: true },
  };

  async execute(_params: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
    return { success: true, data: { result: "mock" } };
  }
}

describe("ToolRegistry", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  describe("default tools", () => {
    it("should register default tools on construction", () => {
      const tools = registry.listAll();
      expect(tools.length).toBeGreaterThan(0);

      const toolNames = tools.map((t) => t.name);
      expect(toolNames).toContain("web_search");
      expect(toolNames).toContain("web_scrape");
      expect(toolNames).toContain("send_email");
      expect(toolNames).toContain("hubspot");
      expect(toolNames).toContain("company_research");
      expect(toolNames).toContain("lead_score");
    });
  });

  describe("register", () => {
    it("should register a custom tool", () => {
      const tool = new MockTool();
      registry.register(tool);

      expect(registry.get("mock_tool")).toBe(tool);
    });
  });

  describe("get", () => {
    it("should return tool by name", () => {
      const tool = registry.get("web_search");
      expect(tool).toBeDefined();
      expect(tool?.name).toBe("web_search");
    });

    it("should return undefined for unknown tool", () => {
      expect(registry.get("nonexistent")).toBeUndefined();
    });
  });

  describe("getForTemplate", () => {
    it("should return correct tools for SDR Agent", () => {
      const tools = registry.getForTemplate("SDR Agent");
      const names = tools.map((t) => t.name);

      expect(names).toContain("web_search");
      expect(names).toContain("company_research");
      expect(names).toContain("lead_score");
      expect(names).toContain("send_email");
      expect(names).toContain("hubspot");
    });

    it("should return correct tools for Content Writer", () => {
      const tools = registry.getForTemplate("Content Writer");
      const names = tools.map((t) => t.name);

      expect(names).toContain("web_search");
      expect(names).toContain("web_scrape");
    });

    it("should return correct tools for Inbox Monitor", () => {
      const tools = registry.getForTemplate("Inbox Monitor");
      const names = tools.map((t) => t.name);

      expect(names).toContain("send_email");
    });

    it("should return correct tools for Reporting Agent", () => {
      const tools = registry.getForTemplate("Reporting Agent");
      const names = tools.map((t) => t.name);

      expect(names).toContain("hubspot");
      expect(names).toContain("web_search");
    });

    it("should return no tools for an unknown template", () => {
      const tools = registry.getForTemplate("Unknown Template");
      expect(tools).toEqual([]);
    });

    it("should be case-insensitive", () => {
      const tools1 = registry.getForTemplate("SDR Agent");
      const tools2 = registry.getForTemplate("sdr agent");

      expect(tools1.map((t) => t.name)).toEqual(tools2.map((t) => t.name));
    });

    it("should scope Reply Handler to research + memory + reply-only send_email", () => {
      const tools = registry.getForTemplate("Reply Handler");
      const names = tools.map((t) => t.name);

      expect(names).toContain("web_search");
      expect(names).toContain("web_scrape");
      expect(names).toContain("send_email");
      // memory tool is only registered when MemoryService is wired in
      expect(names).not.toContain("hubspot");
      expect(names).not.toContain("lead_score");
      expect(names).not.toContain("company_research");
    });

    it("should scope SEO Agent to research-only tools (no send_email, no hubspot)", () => {
      const tools = registry.getForTemplate("SEO Agent");
      const names = tools.map((t) => t.name);

      expect(names).toContain("web_search");
      expect(names).toContain("web_scrape");
      expect(names).toContain("company_research");
      expect(names).not.toContain("send_email");
      expect(names).not.toContain("hubspot");
      expect(names).not.toContain("lead_score");
    });
  });

  describe("getAllowedToolNames", () => {
    it("should return the exclusive whitelist for a known template", () => {
      const allowed = registry.getAllowedToolNames("Reply Handler");
      expect(allowed).toEqual(["web_search", "web_scrape", "memory", "send_email"]);
    });

    it("should return the exclusive whitelist for SEO Agent", () => {
      const allowed = registry.getAllowedToolNames("SEO Agent");
      expect(allowed).toEqual(["web_search", "web_scrape", "company_research", "memory"]);
    });

    it("should return null for an unknown template so execution can fail closed", () => {
      const allowed = registry.getAllowedToolNames("Unknown Template");
      expect(allowed).toBeNull();
    });

    it("should be case-insensitive", () => {
      const a = registry.getAllowedToolNames("REPLY HANDLER");
      const b = registry.getAllowedToolNames("reply handler");
      expect(a).toEqual(b);
    });
  });
});

describe("toolToOpenAIFunction", () => {
  it("should convert a tool to OpenAI function definition", () => {
    const tool = new MockTool();
    const fn = toolToOpenAIFunction(tool);

    expect(fn.type).toBe("function");
    expect(fn.function.name).toBe("mock_tool");
    expect(fn.function.description).toBe("A mock tool for testing");
    expect(fn.function.parameters.type).toBe("object");
    expect(fn.function.parameters.properties.input).toBeDefined();
    expect(fn.function.parameters.required).toContain("input");
  });
});
