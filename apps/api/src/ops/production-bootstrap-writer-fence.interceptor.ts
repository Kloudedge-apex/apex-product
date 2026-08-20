import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from "@nestjs/common";
import type { Request } from "express";
import { defer, lastValueFrom, Observable } from "rxjs";
import { ProductionBootstrapWriterFenceService } from "./production-bootstrap-writer-fence";

export type ProductionBootstrapHttpDisposition =
  | "read"
  | "writer"
  | "unsubscribe";

const SAFE_HTTP_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const UNSUBSCRIBE_READ_PATH = /^\/api\/u\/[^/]+(?:\/post)?\/?$/i;
const UNSUBSCRIBE_POST_PATH = /^\/api\/u\/[^/]+\/?$/i;

/**
 * GET is normally read-only, but these mounted routes can mutate Redis, refresh
 * credentials, call a provider, or synchronize a database projection.
 */
const SIDE_EFFECTFUL_GET_PATHS: readonly RegExp[] = [
  /^\/api\/integrations\/gmail\/auth-url$/,
  /^\/api\/integrations\/gmail\/callback$/,
  /^\/api\/integrations\/gmail\/(?:messages|search|threads)(?:\/|$)/,
];

/**
 * Reviewed GET/HEAD surface with no durable database, queue, Redis, or
 * provider mutation. Unknown future reads default to writer so adding a GET
 * endpoint cannot silently bypass bootstrap review.
 */
const READ_ONLY_GET_PATHS: readonly RegExp[] = [
  /^\/api\/health(?:\/(?:live|ready|worker))?\/?$/,
  /^\/api\/auth\/me$/,
  /^\/api\/kpis(?:\/(?:operational|quality|commercial|guarantee-defense|experimentation))?\/?$/,
  /^\/api\/pipeline\/status$/,
  /^\/api\/policy-events\/?$/,
  /^\/api\/graph\/runs(?:\/[^/]+)?\/?$/,
  /^\/api\/graph\/runs\/[^/]+\/outreach-artifacts$/,
  /^\/api\/outreach-artifacts(?:\/(?:review-capability|[^/]+))?\/?$/,
  /^\/api\/orgs\/(?:me|me\/(?:capabilities|health)|onboarding\/status|[^/]+|[^/]+\/stats)\/?$/,
  /^\/api\/outreach\/suppression\/?$/,
  /^\/api\/conversations(?:\/[^/]+)?\/?$/,
  /^\/api\/leads\/?$/,
  /^\/api\/leads\/(?:icp|companies|people|export\/csv|jobs|stats)\/?$/,
  /^\/api\/leads\/companies\/[^/]+\/people\/?$/,
  /^\/api\/leads\/(?:people|jobs)\/[^/]+\/?$/,
  /^\/api\/meetings(?:\/[^/]+)?\/?$/,
  /^\/api\/metrics\/?$/,
  /^\/api\/dashboard\/stats$/,
  /^\/api\/activity\/?$/,
  /^\/api\/integrations\/?$/,
  /^\/api\/integrations\/catalog$/,
];

function requestPath(url: string): string {
  const queryIndex = url.indexOf("?");
  return queryIndex === -1 ? url : url.slice(0, queryIndex);
}

export function classifyProductionBootstrapHttpRequest(
  method: string,
  url: string,
): ProductionBootstrapHttpDisposition {
  const normalizedMethod = method.toUpperCase();
  const routeMethod = normalizedMethod === "HEAD" ? "GET" : normalizedMethod;
  const path = requestPath(url);

  if (
    (routeMethod === "GET" && UNSUBSCRIBE_READ_PATH.test(path)) ||
    (routeMethod === "POST" && UNSUBSCRIBE_POST_PATH.test(path))
  ) {
    return "unsubscribe";
  }

  if (!SAFE_HTTP_METHODS.has(normalizedMethod)) return "writer";
  if (normalizedMethod === "OPTIONS") return "read";
  if (
    routeMethod === "GET" &&
    SIDE_EFFECTFUL_GET_PATHS.some((pattern) => pattern.test(path))
  ) {
    return "writer";
  }
  if (
    routeMethod === "GET" &&
    READ_ONLY_GET_PATHS.some((pattern) => pattern.test(path))
  ) {
    return "read";
  }
  return "writer";
}

@Injectable()
export class ProductionBootstrapWriterFenceInterceptor
  implements NestInterceptor
{
  constructor(
    private readonly writerFence: ProductionBootstrapWriterFenceService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== "http") return next.handle();
    const request = context.switchToHttp().getRequest<Request>();
    const disposition = classifyProductionBootstrapHttpRequest(
      request.method,
      request.originalUrl || request.url,
    );
    if (disposition === "read") return next.handle();

    const operation = () => lastValueFrom(next.handle());
    return defer(() =>
      disposition === "unsubscribe"
        ? this.writerFence.runComplianceWriter(operation)
        : this.writerFence.runWriter("http", operation),
    );
  }
}
