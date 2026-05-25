import { describe, it, expect } from "vitest";
import { ToolRegistry, buildTemplateToolMap } from "../tools/registry";
import { getAllTemplates } from "../../agents/templates";
import { AgentTemplateConfig } from "../../agents/templates/template.types";

/**
 * Templates are the single source of truth for tool whitelisting. These tests
 * lock that invariant: every template's `availableTools` must only reference
 * names that ToolRegistry knows how to provide, `getAllowedToolNames` must
 * agree with the template declaration verbatim, and bootstrap must fail-fast
 * on any hallucinated tool name.
 */
describe("templates <-> tool registry sync", () => {
  const registry = new ToolRegistry();
  const knownToolNames = new Set([
    "web_search",
    "web_scrape",
    "send_email",
    "hubspot",
    "company_research",
    "lead_score",
    "memory",
    "linkedin_send_message",
  ]);
  const templates = getAllTemplates();

  it("every template's availableTools only cites names known to the registry", () => {
    for (const template of templates) {
      for (const tool of template.availableTools) {
        expect(
          knownToolNames.has(tool.name),
          `Template "${template.slug}" cites unknown tool "${tool.name}"`,
        ).toBe(true);
      }
    }
  });

  it("getAllowedToolNames returns exactly the template's availableTools list", () => {
    for (const template of templates) {
      const declared = template.availableTools.map((t) => t.name);
      const allowed = registry.getAllowedToolNames(template.name);
      expect(allowed, `template ${template.slug}`).not.toBeNull();
      expect(allowed).toEqual(declared);
    }
  });

  it("every template appears in the derived TEMPLATE_TOOL_MAP (case-insensitive)", () => {
    for (const template of templates) {
      const upper = registry.getAllowedToolNames(template.name.toUpperCase());
      const lower = registry.getAllowedToolNames(template.name.toLowerCase());
      expect(upper).toEqual(lower);
      expect(upper).not.toBeNull();
    }
  });
});

describe("buildTemplateToolMap (bootstrap validation)", () => {
  const validTemplate: AgentTemplateConfig = {
    slug: "valid-test-agent",
    name: "Valid Test Agent",
    description: "test",
    domain: "OPS",
    systemPrompt: "test",
    requiredIntegrations: [],
    defaultSchedule: "0 0 * * *",
    availableTools: [{ name: "web_search", description: "ok" }],
    exampleTasks: [],
    defaultConfig: { maxIterations: 1, timeoutMs: 1000, model: "gpt-4o" },
  };

  it("builds the map for a valid template", () => {
    const map = buildTemplateToolMap([validTemplate]);
    expect(map["valid test agent"]).toEqual(["web_search"]);
  });

  it("throws when a template cites an unknown tool", () => {
    const badTemplate: AgentTemplateConfig = {
      ...validTemplate,
      slug: "bad-test-agent",
      name: "Bad Test Agent",
      availableTools: [{ name: "totally_fake_tool", description: "nope" }],
    };

    expect(() => buildTemplateToolMap([badTemplate])).toThrowError(
      `Template "bad-test-agent" cites unknown tool "totally_fake_tool"`,
    );
  });

  it("fails the ToolRegistry constructor when injected templates are invalid", () => {
    const badTemplate: AgentTemplateConfig = {
      ...validTemplate,
      slug: "explode-on-bootstrap",
      name: "Explode On Bootstrap",
      availableTools: [{ name: "imaginary_tool", description: "nope" }],
    };

    expect(() => new ToolRegistry(undefined, undefined, [badTemplate])).toThrowError(
      `Template "explode-on-bootstrap" cites unknown tool "imaginary_tool"`,
    );
  });
});
