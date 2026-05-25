import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { Context } from "@opentelemetry/api";
import type { Span } from "@opentelemetry/sdk-trace-base";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { NestInstrumentation } from "@opentelemetry/instrumentation-nestjs-core";
import { PrismaInstrumentation } from "@prisma/instrumentation";

export const FORBIDDEN_SPAN_ATTRIBUTE_KEYS = [
  "db.statement",
  "db.parameters",
  "job.data",
  "messaging.message.payload",
] as const;

export class ForbiddenAttributesSpanProcessor implements SpanProcessor {
  onStart(_span: Span, _parentContext: Context): void {
    // no-op
  }

  onEnd(span: ReadableSpan): void {
    const attributes = span.attributes as Record<string, unknown>;
    for (const key of FORBIDDEN_SPAN_ATTRIBUTE_KEYS) {
      if (Object.prototype.hasOwnProperty.call(attributes, key)) {
        delete attributes[key];
      }
    }
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}

let sdk: NodeSDK | undefined;

function getTraceExporter(): OTLPTraceExporter | undefined {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (endpoint && endpoint.trim().length > 0) {
    return new OTLPTraceExporter({ url: endpoint });
  }
  return undefined;
}

export function startTracing(): void {
  if (sdk) return;
  if (process.env.NODE_ENV === "test") return;

  const spanProcessors: SpanProcessor[] = [new ForbiddenAttributesSpanProcessor()];
  const exporter = getTraceExporter();
  if (exporter) {
    spanProcessors.push(new BatchSpanProcessor(exporter));
  }

  sdk = new NodeSDK({
    serviceName: "apex-api",
    instrumentations: [
      new HttpInstrumentation(),
      new NestInstrumentation(),
      new PrismaInstrumentation(),
    ],
    spanProcessors,
  });

  sdk.start();
}

startTracing();
