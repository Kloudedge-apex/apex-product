import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import { Request, Response } from "express";
import { Prisma } from "@prisma/client";

/**
 * Returns safe, generic error responses to clients while logging full detail
 * server-side. The previous filter returned raw exception messages, which
 * leaked Prisma column/table names, stack traces, and provider error details
 * to anyone making a request.
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = "Internal server error";
    let errors: string[] | undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === "string") {
        message = body;
      } else if (typeof body === "object" && body !== null) {
        const obj = body as Record<string, unknown>;
        if (Array.isArray(obj.message)) {
          errors = obj.message as string[];
          message = "Validation failed";
        } else if (typeof obj.message === "string") {
          message = obj.message;
        } else {
          message = exception.message;
        }
      } else {
        message = exception.message;
      }
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      const mapped = mapPrismaError(exception);
      status = mapped.status;
      message = mapped.message;
    } else if (
      exception instanceof Prisma.PrismaClientValidationError ||
      exception instanceof Prisma.PrismaClientUnknownRequestError ||
      exception instanceof Prisma.PrismaClientRustPanicError ||
      exception instanceof Prisma.PrismaClientInitializationError
    ) {
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      message = "Database error";
    }
    // For any other unknown error, the defaults above (500 + "Internal server
    // error") apply — we deliberately do NOT echo exception.message back.

    if (status >= 500) {
      this.logger.error(
        `${request.method} ${request.originalUrl} -> ${status}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else if (status >= 400 && status !== 401 && status !== 403 && status !== 404) {
      this.logger.warn(
        `${request.method} ${request.originalUrl} -> ${status} ${message}`,
      );
    }

    response.status(status).json({
      statusCode: status,
      message,
      ...(errors ? { errors } : {}),
      timestamp: new Date().toISOString(),
    });
  }
}

function mapPrismaError(
  err: Prisma.PrismaClientKnownRequestError,
): { status: number; message: string } {
  switch (err.code) {
    case "P2002":
      return { status: HttpStatus.CONFLICT, message: "Resource already exists" };
    case "P2025":
      return { status: HttpStatus.NOT_FOUND, message: "Resource not found" };
    case "P2003":
      return { status: HttpStatus.BAD_REQUEST, message: "Invalid reference" };
    case "P2000":
      return { status: HttpStatus.BAD_REQUEST, message: "Value too long" };
    default:
      return { status: HttpStatus.INTERNAL_SERVER_ERROR, message: "Database error" };
  }
}
