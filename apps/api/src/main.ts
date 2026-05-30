import "./observability/tracing";

import { NestFactory } from "@nestjs/core";
import { Logger, ValidationPipe, RequestMethod } from "@nestjs/common";
import { NestExpressApplication } from "@nestjs/platform-express";
import { SwaggerModule, DocumentBuilder } from "@nestjs/swagger";
import helmet from "helmet";
import { AppModule } from "./app.module";
import { GlobalExceptionFilter } from "./common/http-exception.filter";
import { validateEnvOrExit } from "./common/env-validation";

async function bootstrap() {
  const logger = new Logger("Bootstrap");

  // Validate env BEFORE Nest boots so a misconfigured container exits with a
  // clear message instead of running with insecure state.
  validateEnvOrExit(logger);

  const isProd = process.env.NODE_ENV === "production";

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // Expose req.rawBody so webhook handlers can verify HMAC signatures
    // against the un-parsed body.
    rawBody: true,
  });

  // Keep our main REST APIs under `/api`, but expose RFC 8058 one-click
  // unsubscribe endpoints at the public root (`/unsubscribe/:token`) so they
  // match List-Unsubscribe URLs and can be hit by email clients without
  // knowing our internal prefixing.
  app.setGlobalPrefix("api", {
    exclude: [{ path: "unsubscribe/:token", method: RequestMethod.ALL }],
  });

  // ── Security headers ────────────────────────────────────────────────────
  app.use(
    helmet({
      contentSecurityPolicy: isProd ? undefined : false,
      crossOriginResourcePolicy: { policy: "same-site" },
    }),
  );

  // ── Swagger / OpenAPI docs (dev only) ───────────────────────────────────
  if (!isProd) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle("Apex AI Workforce Platform")
      .setDescription("REST API for Apex.")
      .setVersion("1.0")
      .addBearerAuth({ type: "http", scheme: "bearer", bearerFormat: "JWT" })
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup("api/docs", app, document, {
      swaggerOptions: { persistAuthorization: true },
    });
  }

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: false,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  app.useGlobalFilters(new GlobalExceptionFilter());

  // ── CORS ────────────────────────────────────────────────────────────────
  // Origins come from CORS_ALLOWED_ORIGINS (comma-separated). In dev we add
  // localhost. We never include preview wildcards in prod by default.
  const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (!isProd) {
    allowedOrigins.push("http://localhost:3000", "http://localhost:5173");
  }

  if (isProd && allowedOrigins.length === 0) {
    throw new Error(
      "CORS_ALLOWED_ORIGINS must be set in production (comma-separated list).",
    );
  }

  app.enableCors({
    origin: (origin, callback) => {
      // Allow same-origin and tools (no Origin header)
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error(`Origin ${origin} not allowed by CORS`), false);
    },
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-org-id"],
    credentials: true,
    maxAge: 600,
  });

  const port = process.env.API_PORT || 4000;
  await app.listen(port);
  logger.log(`API listening on :${port} (NODE_ENV=${process.env.NODE_ENV ?? "development"})`);
}

bootstrap();
