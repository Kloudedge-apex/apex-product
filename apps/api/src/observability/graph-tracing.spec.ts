import { describe, it, expect, beforeEach } from "vitest";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { context, trace } from "@opentelemetry/api";
import { withNodeSpan } from "./graph-tracing";
import type { NodeSpanAttrs } from "./graph-tracing";
import { ForbiddenAttributesSpanProcessor } from "./tracing";

describe("withNodeSpan", () => {
  let exporter: InMemorySpanExporter;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();

    trace.disable();
    context.disable();

    const provider = new BasicTracerProvider({
      spanProcessors: [
        new ForbiddenAttributesSpanProcessor(),
        new SimpleSpanProcessor(exporter),
      ],
    });

    trace.setGlobalTracerProvider(provider);
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  });

  it("sets allow-listed attributes on a successful span", async () => {
    await withNodeSpan(
      "node.test",
      {
        "apex.run_id": "run_1",
        "apex.org_id": "org_1",
        "apex.node": "node.test",
        "apex.lead.person_id": "person_1",
        duration_ms: 12,
        count: 3,
      },
      async () => undefined,
    );

    const spans = exporter.getFinishedSpans();
    const span = spans.find((s) => s.name === "node.test");
    expect(span).toBeDefined();
    expect(span?.attributes["apex.run_id"]).toBe("run_1");
    expect(span?.attributes["apex.org_id"]).toBe("org_1");
    expect(span?.attributes["apex.node"]).toBe("node.test");
    expect(span?.attributes["apex.lead.person_id"]).toBe("person_1");
    expect(span?.attributes["duration_ms"]).toBe(12);
    expect(span?.attributes["count"]).toBe(3);
  });

  it("scrubs forbidden attributes from spans (defense-in-depth)", async () => {
    const tracer = trace.getTracer("raw");
    const span = tracer.startSpan("raw.test");
    span.setAttribute("db.statement", "SELECT * FROM person WHERE email = 'cto@acme.com'");
    span.end();

    const spans = exporter.getFinishedSpans();
    const raw = spans.find((s) => s.name === "raw.test");
    expect(raw).toBeDefined();
    expect(raw?.attributes["db.statement"]).toBeUndefined();
  });

  it("enforces a typed allow-list for NodeSpanAttrs (compile-time)", () => {
    // This is intentionally a compile-time check. If it stops erroring, someone
    // accidentally widened `NodeSpanAttrs` in a way that could allow PII (e.g. lead.email).
    const _attrs: NodeSpanAttrs = {
      "apex.run_id": "run_1",
      "apex.org_id": "org_1",
      "apex.node": "node.test",
      // @ts-expect-error "lead.email" is not an allow-listed attribute key
      "lead.email": "alice@example.com",
    };

    expect(_attrs).toBeDefined();
  });
});
