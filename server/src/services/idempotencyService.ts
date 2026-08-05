import { Request, Response, NextFunction } from "express";
import { db } from "../db.js";

// SR-FR-0.4: honor an `Idempotency-Key` header on state-mutating requests. On a
// repeated key (same key + method + path) within the TTL window, replay the
// original stored response instead of re-executing the mutation. This is a
// generic, route-agnostic middleware -- it covers run trigger, test case
// creation/review, credential submission, bulk actions, and anything else a
// caller chooses to send the header on, without every route needing its own
// bespoke idempotency logic.
const TTL_MS = 24 * 60 * 60 * 1000; // 24h short-TTL store (SQLite table, no Redis available)

function isExpired(createdAt: string): boolean {
  return Date.now() - new Date(createdAt).getTime() > TTL_MS;
}

// Opportunistic cleanup of expired keys -- called on lookup rather than a
// separate scheduled job, since this table is small and self-limiting.
export function cleanupExpiredIdempotencyKeys() {
  const cutoff = new Date(Date.now() - TTL_MS).toISOString();
  db.prepare("DELETE FROM idempotency_keys WHERE created_at < ?").run(cutoff);
}

export function idempotencyMiddleware(req: Request, res: Response, next: NextFunction) {
  const key = req.header("idempotency-key");
  if (!key || req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
    return next();
  }

  const routePath = req.baseUrl + (req.path === "/" ? "" : req.path);
  const existing = db
    .prepare("SELECT * FROM idempotency_keys WHERE idem_key = ? AND method = ? AND path = ?")
    .get(key, req.method, routePath) as any;

  if (existing) {
    if (isExpired(existing.created_at)) {
      db.prepare("DELETE FROM idempotency_keys WHERE idem_key = ? AND method = ? AND path = ?").run(key, req.method, routePath);
    } else {
      res.setHeader("Idempotency-Replayed", "true");
      res.status(existing.response_status).json(JSON.parse(existing.response_body));
      return;
    }
  }

  // Wrap res.json so whatever the route eventually sends gets captured and
  // stored against this key, without every route having to opt in explicitly.
  const originalJson = res.json.bind(res);
  (res as any).json = (body: any) => {
    try {
      const now = new Date().toISOString();
      db.prepare(`
        INSERT OR REPLACE INTO idempotency_keys (idem_key, method, path, response_status, response_body, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(key, req.method, routePath, res.statusCode, JSON.stringify(body), now);
    } catch {
      // Never let idempotency bookkeeping break the real response.
    }
    return originalJson(body);
  };

  next();
}
