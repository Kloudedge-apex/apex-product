import "reflect-metadata";
import { RequestMethod } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { AppModule } from "../../app.module";
import { AgentsModule } from "../../agents/agents.module";
import { BillingController } from "../../billing/billing.controller";
import { BillingModule } from "../../billing/billing.module";
import { GraphController } from "../../graph/graph.controller";
import { GraphModule } from "../../graph/graph.module";
import { PipelineController } from "../../pipeline/pipeline.controller";
import { PipelineModule } from "../../pipeline/pipeline.module";
import { RunsModule } from "../../runs/runs.module";
import { WorkflowsModule } from "../../workflows/workflows.module";
import { RuntimeController } from "../runtime.controller";
import { RuntimeModule } from "../runtime.module";
import { ExecutorService } from "../executor.service";
import { MemoryService } from "../memory.service";
import { QueueService } from "../queue.service";
import { RuntimeService } from "../runtime.service";
import { SchedulerService } from "../scheduler.service";
import { WorkerService } from "../worker.service";

const PATH_METADATA = "path";
const METHOD_METADATA = "method";
const CONTROLLERS_METADATA = "controllers";
const IMPORTS_METADATA = "imports";
const PROVIDERS_METADATA = "providers";

interface RouteMetadata {
  readonly name: string;
  readonly path: unknown;
  readonly method: unknown;
}

function exposedRoutes(controller: { readonly prototype: object }): RouteMetadata[] {
  const prototype = controller.prototype as Record<string, unknown>;
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

function mountedControllers(module: object): unknown[] {
  return (Reflect.getMetadata(CONTROLLERS_METADATA, module) as unknown[] | undefined) ?? [];
}

function moduleEntries(module: object, key: string): unknown[] {
  return (Reflect.getMetadata(key, module) as unknown[] | undefined) ?? [];
}

describe("RuntimeController release boundary", () => {
  it("does not expose internal queue statistics as a public runtime route", () => {
    const routes = exposedRoutes(RuntimeController);

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

  it("does not mount deferred agent, workflow, or legacy AgentRun controllers", () => {
    expect(mountedControllers(AgentsModule)).toEqual([]);
    expect(mountedControllers(RuntimeModule)).toEqual([]);
    expect(mountedControllers(RunsModule)).toEqual([]);
    expect(mountedControllers(WorkflowsModule)).toEqual([]);
  });

  it("does not activate deferred product modules or legacy AgentRun providers", () => {
    const appImports = moduleEntries(AppModule, IMPORTS_METADATA);
    expect(appImports).not.toContain(AgentsModule);
    expect(appImports).not.toContain(RunsModule);
    expect(appImports).not.toContain(WorkflowsModule);

    const runtimeProviders = moduleEntries(RuntimeModule, PROVIDERS_METADATA);
    for (const legacyProvider of [
      RuntimeService,
      QueueService,
      WorkerService,
      ExecutorService,
      SchedulerService,
      MemoryService,
    ]) {
      expect(runtimeProviders).not.toContain(legacyProvider);
    }
  });

  it("keeps the canonical guarded pipeline and graph controllers mounted", () => {
    expect(mountedControllers(PipelineModule)).toContain(PipelineController);
    expect(mountedControllers(GraphModule)).toContain(GraphController);

    expect(exposedRoutes(PipelineController)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "run", method: RequestMethod.POST }),
        expect.objectContaining({ path: "status", method: RequestMethod.GET }),
      ]),
    );
    expect(exposedRoutes(GraphController)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "runs", method: RequestMethod.GET }),
        expect.objectContaining({
          path: "runs/:id/approve",
          method: RequestMethod.POST,
        }),
        expect.objectContaining({
          path: "runs/:id/reject",
          method: RequestMethod.POST,
        }),
      ]),
    );
  });

  it("keeps billing reads and the signed webhook but removes self-service subscribe", () => {
    expect(mountedControllers(BillingModule)).toContain(BillingController);
    const routes = exposedRoutes(BillingController);

    expect(routes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "/", method: RequestMethod.GET }),
        expect.objectContaining({ path: "webhook", method: RequestMethod.POST }),
      ]),
    );
    expect(
      routes.some(
        ({ path, method }) =>
          path === "subscribe" && method === RequestMethod.POST,
      ),
    ).toBe(false);
  });
});
