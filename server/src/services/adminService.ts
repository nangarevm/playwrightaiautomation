import { nanoid } from "nanoid";
import { NextFunction, Request, Response } from "express";
import { db } from "../db.js";

export type Role = "QA Lead" | "Tester" | "Developer" | "Manager";

export interface CurrentUser {
  id: string;
  name: string;
  role: Role;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: CurrentUser;
    }
  }
}

// FR-8.1: resolve the acting user from an `X-User-Id` header (this is a local-dev stand-in
// for a real login/session system -- the SRS calls for role-based access control across the
// four user classes, not a specific auth mechanism). Falls back to a permissive default so
// existing routes/tests that don't send the header keep working.
export function attachUser(req: Request, _res: Response, next: NextFunction) {
  const headerId = req.header("x-user-id");
  if (headerId) {
    const row = db.prepare("SELECT * FROM users WHERE id = ?").get(headerId) as any;
    if (row) {
      req.user = { id: row.id, name: row.name, role: row.role };
      return next();
    }
  }
  req.user = { id: "anonymous", name: "Unauthenticated", role: "Tester" };
  next();
}

// FR-8.1: block any mutating request from a read-only Manager/Stakeholder role
export function enforceReadOnlyRoles(req: Request, res: Response, next: NextFunction) {
  const isMutating = req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS";
  if (isMutating && req.user?.role === "Manager") {
    return res.status(403).json({ error: "Manager/Stakeholder role is read-only (FR-8.1)" });
  }
  next();
}

export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: `This action requires one of: ${roles.join(", ")}` });
    }
    next();
  };
}

// FR-8.3: general-purpose audit log, broader than the test-case-scoped review_audit_entries
export function logAudit(user: CurrentUser | undefined, action: string, entityType: string, entityId: string | null, details?: Record<string, any>) {
  const id = nanoid(10);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO audit_log (id, actor_user_id, actor_role, action, entity_type, entity_id, details, created_at)
    VALUES (@id, @actor_user_id, @actor_role, @action, @entity_type, @entity_id, @details, @created_at)
  `).run({
    id,
    actor_user_id: user?.id ?? null,
    actor_role: user?.role ?? null,
    action,
    entity_type: entityType,
    entity_id: entityId,
    details: details ? JSON.stringify(details) : null,
    created_at: now,
  });
  return { id, created_at: now };
}

export function listAuditLog(filters: { entityType?: string; entityId?: string; limit?: number } = {}) {
  const clauses: string[] = [];
  const params: Record<string, any> = { limit: filters.limit ?? 100 };
  if (filters.entityType) {
    clauses.push("entity_type = @entityType");
    params.entityType = filters.entityType;
  }
  if (filters.entityId) {
    clauses.push("entity_id = @entityId");
    params.entityId = filters.entityId;
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return db.prepare(`SELECT * FROM audit_log ${where} ORDER BY created_at DESC LIMIT @limit`).all(params);
}

export function listUsers() {
  return db.prepare("SELECT * FROM users ORDER BY created_at ASC").all();
}

export function createUser(input: { name: string; role: Role; email?: string; owned_modules?: string }) {
  const id = nanoid(10);
  const now = new Date().toISOString();
  db.prepare("INSERT INTO users (id, name, role, email, owned_modules, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    id,
    input.name,
    input.role,
    input.email ?? null,
    input.owned_modules ?? "",
    now
  );
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id);
}

// FR-8.5: route a generated test case to the tester/team that owns the corresponding
// feature/module (matched against each user's owned_modules keywords), instead of a single
// generic review queue.
export function routeTestCaseToOwner(testCaseId: string) {
  const testCase = db.prepare("SELECT * FROM test_cases WHERE id = ?").get(testCaseId) as any;
  if (!testCase) throw new Error("Test case not found");

  const users = db.prepare("SELECT * FROM users WHERE owned_modules IS NOT NULL AND owned_modules != ''").all() as any[];
  const haystack = testCase.title.toLowerCase();

  let owner = users.find((u) => u.owned_modules.split(",").some((keyword: string) => keyword.trim() && haystack.includes(keyword.trim().toLowerCase())));
  if (!owner) owner = null;

  db.prepare("UPDATE test_cases SET owner_user_id = ? WHERE id = ?").run(owner?.id ?? null, testCaseId);
  return { testCaseId, ownerUserId: owner?.id ?? null, ownerName: owner?.name ?? null, matched: Boolean(owner) };
}

// FR-8.6: flag a test case as covering a critical path, requiring a second reviewer's sign-off
export function setCriticalPath(testCaseId: string, critical: boolean) {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE test_cases
    SET critical_path = @critical, second_reviewer_required = @critical,
        second_reviewer_status = CASE WHEN @critical = 1 THEN 'pending' ELSE NULL END,
        updated_at = @updated_at
    WHERE id = @id
  `).run({ id: testCaseId, critical: critical ? 1 : 0, updated_at: now });
  return db.prepare("SELECT * FROM test_cases WHERE id = ?").get(testCaseId);
}

export function submitSecondReviewerSignOff(testCaseId: string, reviewer: CurrentUser, decision: "approved" | "rejected") {
  const testCase = db.prepare("SELECT * FROM test_cases WHERE id = ?").get(testCaseId) as any;
  if (!testCase) throw new Error("Test case not found");
  if (!testCase.second_reviewer_required) throw new Error("This test case does not require second-reviewer sign-off");

  const now = new Date().toISOString();
  db.prepare("UPDATE test_cases SET second_reviewer_status = ?, second_reviewer_id = ?, updated_at = ? WHERE id = ?").run(
    decision,
    reviewer.id,
    now,
    testCaseId
  );
  return db.prepare("SELECT * FROM test_cases WHERE id = ?").get(testCaseId);
}

// FR-8.8: periodically sample previously approved test cases and re-surface them for review,
// to catch AI drift over time. Prioritizes cases that have never been sampled, then the
// least-recently sampled.
export function sampleTestCasesForReReview(count = 5) {
  const rows = db.prepare(`
    SELECT * FROM test_cases
    WHERE status IN ('accepted', 'edited')
    ORDER BY (last_sampled_at IS NOT NULL), last_sampled_at ASC
    LIMIT ?
  `).all(count) as any[];

  const now = new Date().toISOString();
  const update = db.prepare("UPDATE test_cases SET flagged_for_re_review = 1, last_sampled_at = ? WHERE id = ?");
  for (const row of rows) update.run(now, row.id);

  return rows.map((r) => r.id);
}

export function listFlaggedForReReview() {
  return db.prepare("SELECT * FROM test_cases WHERE flagged_for_re_review = 1 ORDER BY last_sampled_at ASC").all();
}
