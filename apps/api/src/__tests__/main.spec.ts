import { describe, it, expect, vi } from "vitest";

/**
 * Bootstrap wiring spec for main.ts. The heavy imports (AppModule graph, OTel
 * tracing, NestFactory) are mocked so importing main.ts only exercises the
 * bootstrap() wiring itself. The contract under test (audit B6): a deploy's
 * SIGTERM must run Nest's shutdown lifecycle so BullMQ workers drain in-flight
 * send/graph jobs — which requires bootstrap() to call enableShutdownHooks()
 * before listen().
 */

const { appMock, createMock } = vi.hoisted(() => {
  const app = {
    set: vi.fn(),
    setGlobalPrefix: vi.fn(),
    use: vi.fn(),
    useGlobalPipes: vi.fn(),
    useGlobalFilters: vi.fn(),
    enableCors: vi.fn(),
    enableShutdownHooks: vi.fn(),
    listen: vi.fn().mockResolvedValue(undefined),
  };
  return {
    appMock: app,
    createMock: vi.fn().mockResolvedValue(app),
  };
});

// Side-effect-only OTel bootstrap — never start the SDK in unit tests.
vi.mock("../observability/tracing", () => ({}));

// The real AppModule pulls the entire provider graph (Prisma, BullMQ, ...).
// bootstrap() only passes it to NestFactory.create, so a bare class suffices.
vi.mock("../app.module", () => ({ AppModule: class AppModule {} }));

// Env validation would process.exit on the bare test env — stub it out; its
// own behavior is covered by env-validation.spec.ts.
vi.mock("../common/env-validation", () => ({ validateEnvOrExit: vi.fn() }));

vi.mock("@nestjs/core", () => ({
  NestFactory: { create: createMock },
}));

// Swagger setup runs in non-prod; stub the static surface main.ts touches.
vi.mock("@nestjs/swagger", () => {
  class DocumentBuilder {
    setTitle() {
      return this;
    }
    setDescription() {
      return this;
    }
    setVersion() {
      return this;
    }
    addBearerAuth() {
      return this;
    }
    build() {
      return {};
    }
  }
  return {
    DocumentBuilder,
    SwaggerModule: {
      createDocument: vi.fn().mockReturnValue({}),
      setup: vi.fn(),
    },
  };
});

describe("main.ts bootstrap", () => {
  it("enables shutdown hooks before listening so deploys drain BullMQ workers", async () => {
    await import("../main");
    // bootstrap() is fired (un-awaited) at module load — wait for it to reach
    // listen() before asserting the wiring.
    await vi.waitFor(() => expect(appMock.listen).toHaveBeenCalled());

    expect(appMock.set).toHaveBeenCalledWith(
      "trust proxy",
      expect.any(Function),
    );
    expect(appMock.enableShutdownHooks).toHaveBeenCalledTimes(1);
    const hooksOrder = appMock.enableShutdownHooks.mock.invocationCallOrder[0];
    const listenOrder = appMock.listen.mock.invocationCallOrder[0];
    expect(hooksOrder).toBeLessThan(listenOrder);
  });
});
