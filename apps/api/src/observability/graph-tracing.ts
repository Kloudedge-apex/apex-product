import { context, trace, SpanStatusCode } from "@opentelemetry/api";

export interface NodeSpanAttrs {
  readonly "apex.run_id": string;
  readonly "apex.org_id": string;
  readonly "apex.node": string;
  readonly "apex.lead.person_id"?: string;
  readonly duration_ms?: number;
  readonly count?: number;
}

export async function withNodeSpan<TResult>(
  name: string,
  attrs: NodeSpanAttrs,
  fn: () => Promise<TResult>,
): Promise<TResult> {
  const tracer = trace.getTracer("apex.graph");
  const span = tracer.startSpan(name);

  span.setAttribute("apex.run_id", attrs["apex.run_id"]);
  span.setAttribute("apex.org_id", attrs["apex.org_id"]);
  span.setAttribute("apex.node", attrs["apex.node"]);

  if (attrs["apex.lead.person_id"]) {
    span.setAttribute("apex.lead.person_id", attrs["apex.lead.person_id"]);
  }
  if (typeof attrs.duration_ms === "number") {
    span.setAttribute("duration_ms", attrs.duration_ms);
  }
  if (typeof attrs.count === "number") {
    span.setAttribute("count", attrs.count);
  }

  try {
    return await context.with(trace.setSpan(context.active(), span), fn);
  } catch (err) {
    span.recordException(err instanceof Error ? err : new Error(String(err)));
    span.setStatus({ code: SpanStatusCode.ERROR });
    throw err;
  } finally {
    span.end();
  }
}

