import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.setGlobalPrefix("api");

  // CORS configuration
  const allowedOrigins = [
    process.env.FRONTEND_URL || "http://localhost:3000",
    "http://localhost:3000",
    "https://apex.kloudedge.com",
    "https://apex.kloudedge.xyz",
    "https://apex-v2.ashysmoke-fd2f7a7f.eastus.azurecontainerapps.io",
  ].filter(Boolean);

  app.enableCors({
    origin: allowedOrigins,
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  });

  const port = process.env.API_PORT || 4000;
  await app.listen(port);
}

bootstrap();
