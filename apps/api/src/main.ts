import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import { SwaggerModule, DocumentBuilder } from "@nestjs/swagger";
import { AppModule } from "./app.module";
import { GlobalExceptionFilter } from "./common/http-exception.filter";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.setGlobalPrefix("api");

  // ── Swagger / OpenAPI docs ──────────────────────────────────────────────
  const swaggerConfig = new DocumentBuilder()
    .setTitle("Apex AI Workforce Platform")
    .setDescription("REST API for Apex — the AI agent platform for SDR, content, and ops teams.")
    .setVersion("1.0")
    .addBearerAuth({ type: "http", scheme: "bearer", bearerFormat: "JWT" })
    .addTag("auth", "Authentication and user management")
    .addTag("agents", "AI agent configuration and management")
    .addTag("runtime", "Agent execution and run management")
    .addTag("integrations", "OAuth integrations (Gmail, HubSpot, LinkedIn)")
    .addTag("billing", "Subscription and billing management")
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup("api/docs", app, document, {
    swaggerOptions: { persistAuthorization: true },
  });

  // Global validation pipe for DTO validation
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: false,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // Global exception filter for consistent error responses
  app.useGlobalFilters(new GlobalExceptionFilter());

  // CORS configuration
  const allowedOrigins = [
    process.env.FRONTEND_URL || "http://localhost:3000",
    "http://localhost:3000",
    "http://localhost:5173",
    "https://apex.kloudedge.com",
    "https://apex.kloudedge.xyz",
    "https://workforceos.xyz",
    "https://www.workforceos.xyz",
    "https://apex-v2.ashysmoke-fd2f7a7f.eastus.azurecontainerapps.io",
  ].filter(Boolean);

  // Also allow any *.lovable.app and *.lovableproject.com origins
  app.enableCors({
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
      if (!origin) return callback(null, true); // allow non-browser requests
      if (allowedOrigins.includes(origin)) return callback(null, true);
      if (/\.lovable\.app$/.test(origin) || /\.lovableproject\.com$/.test(origin)) return callback(null, true);
      if (/\.vercel\.app$/.test(origin) || /\.netlify\.app$/.test(origin)) return callback(null, true);
      callback(null, false);
    },
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-org-id", "X-API-Key"],
    credentials: true,
  });

  const port = process.env.API_PORT || 4000;
  await app.listen(port);
}

bootstrap();
