import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { LangSmithService } from "./langsmith.service";

let runTreeCtorArgs: unknown | undefined;
let runTreeEndArgs: readonly unknown[] | undefined;
let postRunCalls = 0;

vi.mock("langsmith", () => {
  class Client {
    constructor(_opts: { readonly apiKey?: string }) {
      // no-op
    }
  }

  class RunTree {
    constructor(args: unknown) {
      runTreeCtorArgs = args;
    }

    async postRun(): Promise<void> {
      postRunCalls += 1;
    }

    async end(...args: readonly unknown[]): Promise<void> {
      runTreeEndArgs = args;
    }
  }

  return { Client, RunTree };
});

describe("LangSmithService", () => {
  beforeEach(() => {
    runTreeCtorArgs = undefined;
    runTreeEndArgs = undefined;
    postRunCalls = 0;

    delete process.env.LANGSMITH_API_KEY;
    delete process.env.LANGSMITH_TRACING;
    delete process.env.LANGSMITH_CAPTURE_PROMPTS;
    delete process.env.LANGSMITH_MAX_CONTENT_CHARS;
    delete process.env.LANGSMITH_PROJECT;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("no-ops without LANGSMITH_API_KEY (no dynamic import, no fetch)", async () => {
    const loadSpy = vi.spyOn(LangSmithService, "loadSdk");
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const svc = new LangSmithService();
    const result = await svc.wrapLlm(
      { name: "test.llm", model: "mock", inputs: [{ role: "user", content: "hi" }] },
      async () => "ok",
    );

    expect(result).toBe("ok");
    expect(loadSpy).toHaveBeenCalledTimes(0);
    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });

  it("drops tool_call_id from captured inputs/outputs", async () => {
    process.env.LANGSMITH_API_KEY = "k";
    process.env.LANGSMITH_CAPTURE_PROMPTS = "true";

    const svc = new LangSmithService();
    const result = await svc.wrapLlm(
      {
        name: "test.llm",
        model: "mock",
        inputs: {
          role: "user",
          content: "hi",
          tool_call_id: "call_123",
        },
      },
      async () => ({ ok: true, tool_call_id: "call_456" }),
    );

    expect(result).toEqual({ ok: true, tool_call_id: "call_456" });

    const ctor = runTreeCtorArgs;
    expect(ctor).toBeDefined();
    expect(typeof ctor).toBe("object");

    const inputs =
      ctor && typeof ctor === "object" && ctor !== null && "inputs" in ctor
        ? (ctor as { readonly inputs?: unknown }).inputs
        : undefined;
    expect(inputs).toBeDefined();

    const redactedInputs =
      inputs && typeof inputs === "object" && inputs !== null && "inputs" in inputs
        ? (inputs as { readonly inputs?: unknown }).inputs
        : undefined;

    expect(redactedInputs).toBeDefined();
    expect(redactedInputs).not.toBeNull();
    expect(typeof redactedInputs).toBe("object");
    expect(Object.prototype.hasOwnProperty.call(redactedInputs as object, "tool_call_id")).toBe(
      false,
    );

    expect(runTreeEndArgs).toBeDefined();
    const [endPayload] = runTreeEndArgs ?? [];
    expect(endPayload).toBeDefined();
    expect(endPayload).not.toBeNull();
    expect(typeof endPayload).toBe("object");
    expect(Object.prototype.hasOwnProperty.call(endPayload as object, "tool_call_id")).toBe(false);
  });

  it("drops raw tool args (arguments/tool_args) from captured inputs/outputs", async () => {
    process.env.LANGSMITH_API_KEY = "k";
    process.env.LANGSMITH_CAPTURE_PROMPTS = "true";

    const svc = new LangSmithService();
    await svc.wrapLlm(
      {
        name: "test.llm",
        model: "mock",
        inputs: {
          tool: {
            name: "web_search",
            arguments: { q: "cto@acme.com" },
            tool_args: { q: "cto@acme.com" },
          },
        },
      },
      async () => ({
        tool: { arguments: { secret: "x" }, tool_args: { secret: "y" }, ok: true },
      }),
    );

    const ctor = runTreeCtorArgs;
    const inputs =
      ctor && typeof ctor === "object" && ctor !== null && "inputs" in ctor
        ? (ctor as { readonly inputs?: unknown }).inputs
        : undefined;
    const redactedInputs =
      inputs && typeof inputs === "object" && inputs !== null && "inputs" in inputs
        ? (inputs as { readonly inputs?: unknown }).inputs
        : undefined;
    expect(redactedInputs).toBeDefined();
    expect(redactedInputs).not.toBeNull();
    expect(typeof redactedInputs).toBe("object");
    const tool =
      redactedInputs &&
      typeof redactedInputs === "object" &&
      redactedInputs !== null &&
      "tool" in redactedInputs
        ? (redactedInputs as { readonly tool?: unknown }).tool
        : undefined;
    expect(tool).toBeDefined();
    expect(tool).not.toBeNull();
    expect(typeof tool).toBe("object");
    expect(Object.prototype.hasOwnProperty.call(tool as object, "arguments")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(tool as object, "tool_args")).toBe(false);

    const [endPayload] = runTreeEndArgs ?? [];
    const outputs =
      endPayload && typeof endPayload === "object" && endPayload !== null && "outputs" in endPayload
        ? (endPayload as { readonly outputs?: unknown }).outputs
        : undefined;
    expect(outputs).toBeDefined();
    expect(outputs).not.toBeNull();
    expect(typeof outputs).toBe("object");
    const outputTool =
      outputs && typeof outputs === "object" && outputs !== null && "tool" in outputs
        ? (outputs as { readonly tool?: unknown }).tool
        : undefined;
    expect(outputTool).toBeDefined();
    expect(outputTool).not.toBeNull();
    expect(typeof outputTool).toBe("object");
    expect(Object.prototype.hasOwnProperty.call(outputTool as object, "arguments")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(outputTool as object, "tool_args")).toBe(false);
  });

  it("drops embedding-like inputs (input/texts) from captured payloads", async () => {
    process.env.LANGSMITH_API_KEY = "k";
    process.env.LANGSMITH_CAPTURE_PROMPTS = "true";

    const svc = new LangSmithService();
    await svc.wrapLlm(
      {
        name: "test.embed",
        model: "mock",
        inputs: {
          type: "embedding",
          input: ["secret text"],
          texts: ["more secret text"],
          ok: true,
        },
      },
      async () => ({
        type: "embedding_response",
        input: "raw text",
        texts: ["raw text 2"],
        ok: true,
      }),
    );

    const ctor = runTreeCtorArgs;
    const inputs =
      ctor && typeof ctor === "object" && ctor !== null && "inputs" in ctor
        ? (ctor as { readonly inputs?: unknown }).inputs
        : undefined;
    const redactedInputs =
      inputs && typeof inputs === "object" && inputs !== null && "inputs" in inputs
        ? (inputs as { readonly inputs?: unknown }).inputs
        : undefined;
    expect(redactedInputs).toBeDefined();
    expect(redactedInputs).not.toBeNull();
    expect(typeof redactedInputs).toBe("object");
    expect(Object.prototype.hasOwnProperty.call(redactedInputs as object, "input")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(redactedInputs as object, "texts")).toBe(false);

    const [endPayload] = runTreeEndArgs ?? [];
    const outputs =
      endPayload && typeof endPayload === "object" && endPayload !== null && "outputs" in endPayload
        ? (endPayload as { readonly outputs?: unknown }).outputs
        : undefined;
    expect(outputs).toBeDefined();
    expect(outputs).not.toBeNull();
    expect(typeof outputs).toBe("object");
    expect(Object.prototype.hasOwnProperty.call(outputs as object, "input")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(outputs as object, "texts")).toBe(false);
  });

  it("hashes email addresses in captured strings (sha256)", async () => {
    process.env.LANGSMITH_API_KEY = "k";
    process.env.LANGSMITH_CAPTURE_PROMPTS = "true";

    const email = "alice@example.com";
    const expectedHash = createHash("sha256").update(email).digest("hex");

    const svc = new LangSmithService();
    await svc.wrapLlm(
      {
        name: "test.llm",
        model: "mock",
        inputs: [{ role: "user", content: `hello ${email}` }],
      },
      async () => `ok for ${email}`,
    );

    const ctor = runTreeCtorArgs;
    const inputs =
      ctor && typeof ctor === "object" && ctor !== null && "inputs" in ctor
        ? (ctor as { readonly inputs?: unknown }).inputs
        : undefined;
    const redactedInputs =
      inputs && typeof inputs === "object" && inputs !== null && "inputs" in inputs
        ? (inputs as { readonly inputs?: unknown }).inputs
        : undefined;
    expect(JSON.stringify(redactedInputs)).not.toContain(email);
    expect(JSON.stringify(redactedInputs)).toContain(`sha256:${expectedHash}`);

    const [endPayload] = runTreeEndArgs ?? [];
    const outputs =
      endPayload && typeof endPayload === "object" && endPayload !== null && "outputs" in endPayload
        ? (endPayload as { readonly outputs?: unknown }).outputs
        : undefined;
    expect(JSON.stringify(outputs)).not.toContain(email);
    expect(JSON.stringify(outputs)).toContain(`sha256:${expectedHash}`);
  });

  it("truncates captured strings to LANGSMITH_MAX_CONTENT_CHARS (default 4000)", async () => {
    process.env.LANGSMITH_API_KEY = "k";
    process.env.LANGSMITH_CAPTURE_PROMPTS = "true";

    const long = "a".repeat(10_000);

    const svc = new LangSmithService();
    await svc.wrapLlm(
      { name: "test.llm", model: "mock", inputs: [{ role: "user", content: long }] },
      async () => long,
    );

    const ctor = runTreeCtorArgs;
    const inputs =
      ctor && typeof ctor === "object" && ctor !== null && "inputs" in ctor
        ? (ctor as { readonly inputs?: unknown }).inputs
        : undefined;
    const redactedInputs =
      inputs && typeof inputs === "object" && inputs !== null && "inputs" in inputs
        ? (inputs as { readonly inputs?: unknown }).inputs
        : undefined;
    expect(Array.isArray(redactedInputs)).toBe(true);
    const firstMsg =
      Array.isArray(redactedInputs) && redactedInputs.length > 0 ? redactedInputs[0] : undefined;
    const content =
      firstMsg && typeof firstMsg === "object" && firstMsg !== null && "content" in firstMsg
        ? (firstMsg as { readonly content?: unknown }).content
        : undefined;
    expect(typeof content).toBe("string");
    expect((content as string).length).toBeLessThanOrEqual(4000);

    const [endPayload] = runTreeEndArgs ?? [];
    const outputs =
      endPayload && typeof endPayload === "object" && endPayload !== null && "outputs" in endPayload
        ? (endPayload as { readonly outputs?: unknown }).outputs
        : undefined;
    expect(typeof outputs).toBe("string");
    expect((outputs as string).length).toBeLessThanOrEqual(4000);
  });

  it("captures prompts only when LANGSMITH_CAPTURE_PROMPTS === \"true\"", async () => {
    process.env.LANGSMITH_API_KEY = "k";
    // capture prompts is intentionally unset

    const svc = new LangSmithService();
    await svc.wrapLlm(
      { name: "test.llm", model: "mock", inputs: [{ role: "user", content: "hi" }] },
      async () => "ok",
    );

    expect(postRunCalls).toBe(1);

    const ctor = runTreeCtorArgs;
    expect(ctor).toBeDefined();
    expect(ctor).not.toBeNull();
    expect(typeof ctor).toBe("object");

    const inputs =
      ctor && typeof ctor === "object" && ctor !== null && "inputs" in ctor
        ? (ctor as { readonly inputs?: unknown }).inputs
        : undefined;
    expect(inputs).toEqual({ model: "mock" });

    const [endPayload] = runTreeEndArgs ?? [];
    expect(endPayload).toBeDefined();
    expect(endPayload).not.toBeNull();
    expect(typeof endPayload).toBe("object");
    expect(Object.prototype.hasOwnProperty.call(endPayload as object, "outputs")).toBe(false);
  });
});
