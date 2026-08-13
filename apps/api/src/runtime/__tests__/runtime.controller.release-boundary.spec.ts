import "reflect-metadata";
import { RequestMethod } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { RuntimeController } from "../runtime.controller";

const PATH_METADATA = "path";
const METHOD_METADATA = "method";

interface RouteMetadata {
  readonly name: string;
  readonly path: unknown;
  readonly method: unknown;
}

function exposedRoutes(): RouteMetadata[] {
  const prototype = RuntimeController.prototype as unknown as Record<string, unknown>;
  const routes: RouteMetadata[] = [];

  for (const name of Object.getOwnPropertyNames(prototype)) {
    const handler = prototype[name];
    if (name === "constructor" || typeof handler !== "function") continue;

    const path = Reflect.getMetadata(PATH_METADATA, handler) as unknown;
    const method = Reflect.getMetadata(METHOD_METADATA, handler) as unknown;
    if (path !== undefined && method !== undefined) {
      routes.push({ name, path, method });
    }
  }

  return routes;
}

describe("RuntimeController release boundary", () => {
  it("does not expose internal queue statistics as a public runtime route", () => {
    const routes = exposedRoutes();

    expect(
      routes.some(
        ({ path, method }) =>
          path === "queue/stats" && method === RequestMethod.GET,
      ),
    ).toBe(false);
    expect(Object.getOwnPropertyNames(RuntimeController.prototype)).not.toContain(
      "getQueueStats",
    );
  });
});
