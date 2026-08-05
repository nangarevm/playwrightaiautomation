import { Request, Response, NextFunction } from "express";
import { errBody } from "../errorCodes.js";

// Dev TDD §6.5 (429 RATE_LIMITED): nothing like this existed in the codebase
// before this pass (checked: no rate-limiting middleware, no request counters
// anywhere in server/src). Simple in-process fixed-window limiter per acting
// identity -- no Redis available, and a single-process monolith doesn't need a
// distributed limiter. Deliberately generous so it never fires under normal
// use or the existing test suite, while still being a real, enforced limit
// rather than a stub.
const WINDOW_MS = 10_000;
const MAX_REQUESTS_PER_WINDOW = 200;

interface Bucket {
  windowStart: number;
  count: number;
}

const buckets = new Map<string, Bucket>();

export function rateLimitMiddleware(req: Request, res: Response, next: NextFunction) {
  const identity = req.user?.id || req.ip || "anonymous";
  const now = Date.now();
  const bucket = buckets.get(identity);

  if (!bucket || now - bucket.windowStart >= WINDOW_MS) {
    buckets.set(identity, { windowStart: now, count: 1 });
    return next();
  }

  bucket.count += 1;
  if (bucket.count > MAX_REQUESTS_PER_WINDOW) {
    const retryAfterSeconds = Math.ceil((bucket.windowStart + WINDOW_MS - now) / 1000);
    res.setHeader("Retry-After", String(Math.max(retryAfterSeconds, 1)));
    return res.status(429).json(errBody(429, "Rate limit exceeded. Please slow down and retry after the indicated delay."));
  }

  next();
}

// Test/diagnostic helper -- not used by production request flow.
export function resetRateLimitBuckets() {
  buckets.clear();
}
