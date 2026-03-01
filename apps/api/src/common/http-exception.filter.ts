import { ExceptionFilter, Catch, ArgumentsHost, HttpException, HttpStatus } from "@nestjs/common";
import { Response } from "express";

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = "Internal server error";
    let errors: string[] | undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      if (typeof exceptionResponse === "string") {
        message = exceptionResponse;
      } else if (typeof exceptionResponse === "object" && exceptionResponse !== null) {
        const responseObj = exceptionResponse as Record<string, unknown>;
        message = (responseObj.message as string) || exception.message;
        if (Array.isArray(responseObj.message)) {
          errors = responseObj.message as string[];
          message = "Validation failed";
        }
      }
    } else if (exception instanceof Error) {
      message = exception.message;
    }

    response.status(status).json({
      statusCode: status,
      message,
      ...(errors ? { errors } : {}),
      timestamp: new Date().toISOString(),
    });
  }
}
