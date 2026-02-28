import { Injectable, NestMiddleware, HttpException, HttpStatus } from "@nestjs/common";
import { Request, Response, NextFunction } from "express";

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

@Injectable()
export class RateLimitMiddleware implements NestMiddleware {
  private store = new Map<string, RateLimitEntry>();
  private readonly windowMs = 60000; // 1 minute
  private readonly maxRequests = 100; // 100 requests per minute

  use(req: Request, _res: Response, next: NextFunction) {
    const key = req.ip || "unknown";
    const now = Date.now();

    const entry = this.store.get(key);
    if (!entry || now > entry.resetAt) {
      this.store.set(key, { count: 1, resetAt: now + this.windowMs });
      return next();
    }

    if (entry.count >= this.maxRequests) {
      throw new HttpException("Too many requests", HttpStatus.TOO_MANY_REQUESTS);
    }

    entry.count++;
    next();
  }
}
