import { nanoid } from "nanoid";
import { NextFunction, Request, Response } from "express";
import { db } from "../db.js";
import { errBody } from "../errorCodes.js";

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
export function attachUser(req: Request, res: Response, next: NextFunction) {
  const headerId = req.header("x-user-id");
  if (headerId) {
    const row = db.prepare("SELECT * FROM users WHERE id = ?").get(headerId) as any;
    if (row) {
      // FR-8.9: disabling a user in the IdP revokes their platform access immediately
      if (row.sso_disabled_at) {
        return res.status(403).json(errBody(403, "This user's access has been disabled by the identity provider (FR-8.9)"));
      }
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
    return res.status(403).json(errBody(403, "Manager/Stakeholder role is read-only (FR-8.1)"));
  }
  next();
}

export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json(errBody(403, `This action requires one of: ${roles.join(", ")}`));
    }
    next();
  };
}

// FR-8.3: general-purpose audit log, broader than the test-case-scoped review_audit_entries
export function logAudit(user: CurrentUser | undefined, action: string, entityType: string, entityId: string | null, details?: Record<string, any>) {
  const id = nanoid(10);
  const now = new Date().toISOString();
  // FR-8.11: stamp a retention deadline at write time; there is no route anywhere
  // in this codebase that updates or deletes an audit_log row for any role.
  const retainUntil = new Date(Date.now() + AUDIT_RETENTION_DAYS_CONST * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(`
    INSERT INTO audit_log (id, actor_user_id, actor_role, action, entity_type, entity_id, details, retain_until, created_at)
    VALUES (@id, @actor_user_id, @actor_role, @action, @entity_type, @entity_id, @details, @retain_until, @created_at)
  `).run({
    id,
    actor_user_id: user?.id ?? null,
    actor_role: user?.role ?? null,
    action,
    entity_type: entityType,
    entity_id: entityId,
    details: details ? JSON.stringify(details) : null,
    retain_until: retainUntil,
    created_at: now,
  });
  return { id, created_at: now };
}

const AUDIT_RETENTION_DAYS_CONST = Number(process.env.AUDIT_RETENTION_DAYS) || 365;

// FR-4.30: log an Ultrafast Mode auto-decision (profile/environment auto-selection,
// auto-accept/needs-review-later routing) to the SAME audit_log table, via the SAME
// insert shape as logAudit above -- structurally identical to a manual entry, differing
// only in actor identification (actor_user_id/actor_role = "system" instead of a real
// user id/role), per FR-4.30's literal requirement and the FR-8.3/FR-8.11 traceability
// guarantees (immutable, retained, retrievable the same way).
export function logSystemAudit(action: string, entityType: string, entityId: string | null, details?: Record<string, any>) {
  const id = nanoid(10);
  const now = new Date().toISOString();
  const retainUntil = new Date(Date.now() + AUDIT_RETENTION_DAYS_CONST * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(`
    INSERT INTO audit_log (id, actor_user_id, actor_role, action, entity_type, entity_id, details, retain_until, created_at)
    VALUES (@id, @actor_user_id, @actor_role, @action, @entity_type, @entity_id, @details, @retain_until, @created_at)
  `).run({
    id,
    actor_user_id: "system",
    actor_role: "system",
    action,
    entity_type: entityType,
    entity_id: entityId,
    details: details ? JSON.stringify(details) : null,
    retain_until: retainUntil,
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

// FR-1.8: org-level PII redaction toggle -- persisted, single source of truth
// (not a per-request client-supplied flag), and every change is audited so the
// toggle state itself is auditable, per the acceptance criterion.
export function getOrgRedactionSetting() {
  return db.prepare("SELECT * FROM org_settings WHERE id = 1").get() as { pii_redaction_disabled: number; updated_by: string | null; updated_at: string };
}

export function setOrgRedactionSetting(disabled: boolean, updatedBy: CurrentUser | undefined) {
  const now = new Date().toISOString();
  db.prepare("UPDATE org_settings SET pii_redaction_disabled = ?, updated_by = ?, updated_at = ? WHERE id = 1").run(
    disabled ? 1 : 0,
    updatedBy?.id ?? null,
    now
  );
  logAudit(updatedBy, "org_pii_redaction_toggle_changed", "org_settings", "1", { disabled });
  return getOrgRedactionSetting();
}

// Single-QA cost-saving mode: opt-in toggle that raises chooseModelTier's
// (llmGatewayService.ts) length threshold, routing more generation calls to
// the cheap "economy" tier. Off by default so existing behavior/tests don't
// change under anyone who hasn't opted in.
export function getCostSavingSetting() {
  return db.prepare("SELECT cost_saving_mode, economy_tier_length_threshold FROM org_settings WHERE id = 1").get() as {
    cost_saving_mode: number;
    economy_tier_length_threshold: number;
  };
}

export function setCostSavingMode(enabled: boolean, updatedBy: CurrentUser | undefined) {
  const now = new Date().toISOString();
  db.prepare("UPDATE org_settings SET cost_saving_mode = ?, updated_by = ?, updated_at = ? WHERE id = 1").run(
    enabled ? 1 : 0,
    updatedBy?.id ?? null,
    now
  );
  logAudit(updatedBy, "org_cost_saving_mode_changed", "org_settings", "1", { enabled });
  return getCostSavingSetting();
}

// FR-4.26: QA-Lead-editable Ultrafast Mode auto-accept confidence threshold,
// mirroring the org_settings pattern already used for FR-1.8 (redaction) and
// FR-5.4 (self-heal threshold) rather than a hardcoded constant.
export function getUltrafastConfidenceThreshold(): number {
  const row = db.prepare("SELECT ultrafast_confidence_threshold FROM org_settings WHERE id = 1").get() as { ultrafast_confidence_threshold: number };
  return row.ultrafast_confidence_threshold;
}

export function setUltrafastConfidenceThreshold(threshold: number, updatedBy: CurrentUser | undefined) {
  if (typeof threshold !== "number" || threshold < 0 || threshold > 1) {
    throw new Error("threshold must be a number between 0 and 1");
  }
  const now = new Date().toISOString();
  db.prepare("UPDATE org_settings SET ultrafast_confidence_threshold = ?, updated_by = ?, updated_at = ? WHERE id = 1").run(
    threshold,
    updatedBy?.id ?? null,
    now
  );
  logAudit(updatedBy, "org_ultrafast_threshold_changed", "org_settings", "1", { threshold });
  return { ultrafast_confidence_threshold: getUltrafastConfidenceThreshold() };
}

// Deeper bug detection (#3 visual regression): QA-Lead-editable threshold, in
// percent of pixels differing, above which screensService.diffAgainstVisualBaseline's
// pixel-diff result is treated as a real "UI changed" bug rather than noise
// (sub-pixel anti-aliasing/font-rendering jitter between runs).
export function getVisualDiffThresholdPercent(): number {
  const row = db.prepare("SELECT visual_diff_threshold_percent FROM org_settings WHERE id = 1").get() as { visual_diff_threshold_percent: number };
  return row.visual_diff_threshold_percent;
}

export function setVisualDiffThresholdPercent(threshold: number, updatedBy: CurrentUser | undefined) {
  if (typeof threshold !== "number" || threshold < 0 || threshold > 100) {
    throw new Error("threshold must be a number between 0 and 100 (percent of pixels differing)");
  }
  const now = new Date().toISOString();
  db.prepare("UPDATE org_settings SET visual_diff_threshold_percent = ?, updated_by = ?, updated_at = ? WHERE id = 1").run(threshold, updatedBy?.id ?? null, now);
  logAudit(updatedBy, "org_visual_diff_threshold_changed", "org_settings", "1", { threshold });
  return { visual_diff_threshold_percent: getVisualDiffThresholdPercent() };
}

// Deeper bug detection (#2 API schema validation): the default mode a newly
// discovered endpoint's stored schema starts in -- 'baseline' silently accepts
// whatever shape is first seen as the new normal (no drift ever flagged);
// 'strict' flags any later drift as an api-schema bug. Per-endpoint mode can
// still be overridden individually (see apiSchemaService.updateApiSchemaMode);
// this is only the default applied when an endpoint is first captured.
export function getApiSchemaDefaultMode(): "baseline" | "strict" {
  const row = db.prepare("SELECT api_schema_default_mode FROM org_settings WHERE id = 1").get() as { api_schema_default_mode: "baseline" | "strict" };
  return row.api_schema_default_mode;
}

export function setApiSchemaDefaultMode(mode: string, updatedBy: CurrentUser | undefined) {
  if (mode !== "baseline" && mode !== "strict") {
    throw new Error("mode must be 'baseline' or 'strict'");
  }
  const now = new Date().toISOString();
  db.prepare("UPDATE org_settings SET api_schema_default_mode = ?, updated_by = ?, updated_at = ? WHERE id = 1").run(mode, updatedBy?.id ?? null, now);
  logAudit(updatedBy, "org_api_schema_default_mode_changed", "org_settings", "1", { mode });
  return { api_schema_default_mode: getApiSchemaDefaultMode() };
}

// Phase 1 hardening: how many identical (method+path) API calls within a
// single page visit before it's flagged as a likely duplicate/excessive-
// request bug (a polling storm, a re-render loop refiring the same fetch).
// Configurable rather than hardcoded, same pattern as every other threshold above.
export function getMaxDuplicateRequests(): number {
  const row = db.prepare("SELECT max_duplicate_requests FROM org_settings WHERE id = 1").get() as { max_duplicate_requests: number };
  return row.max_duplicate_requests;
}

export function setMaxDuplicateRequests(count: number, updatedBy: CurrentUser | undefined) {
  if (typeof count !== "number" || !Number.isInteger(count) || count < 1) {
    throw new Error("count must be a positive integer");
  }
  const now = new Date().toISOString();
  db.prepare("UPDATE org_settings SET max_duplicate_requests = ?, updated_by = ?, updated_at = ? WHERE id = 1").run(count, updatedBy?.id ?? null, now);
  logAudit(updatedBy, "org_max_duplicate_requests_changed", "org_settings", "1", { count });
  return { max_duplicate_requests: getMaxDuplicateRequests() };
}

// FR-2.11: QA-Lead-managed domain/business rules, persisted as a real entity
// (previously a free-text string re-typed per generation call) so generation
// can pull the active set automatically and a threshold demonstrably shows up
// in generated edge cases.
export function listBusinessRules(activeOnly = false) {
  const where = activeOnly ? "WHERE active = 1" : "";
  return db.prepare(`SELECT * FROM business_rules ${where} ORDER BY created_at DESC`).all();
}

export function createBusinessRule(input: { name: string; description: string }, createdBy: CurrentUser | undefined) {
  if (!input.name || !input.description) throw new Error("name and description are required");
  const id = nanoid(10);
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO business_rules (id, name, description, active, created_by, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?)"
  ).run(id, input.name, input.description, createdBy?.id ?? null, now, now);
  logAudit(createdBy, "business_rule_created", "business_rule", id, { name: input.name });
  return db.prepare("SELECT * FROM business_rules WHERE id = ?").get(id);
}

export function setBusinessRuleActive(id: string, active: boolean, updatedBy: CurrentUser | undefined) {
  db.prepare("UPDATE business_rules SET active = ?, updated_at = ? WHERE id = ?").run(active ? 1 : 0, new Date().toISOString(), id);
  logAudit(updatedBy, "business_rule_toggled", "business_rule", id, { active });
  return db.prepare("SELECT * FROM business_rules WHERE id = ?").get(id);
}

// Combines every active rule's description into one block generation can
// include automatically -- this is what makes FR-2.11's "subsequently
// generated test cases demonstrably reflect that rule" true without the
// caller having to re-paste the rule text on every request.
export function getActiveBusinessRulesText(): string {
  const rules = listBusinessRules(true) as Array<{ name: string; description: string }>;
  if (rules.length === 0) return "";
  return rules.map((r) => `${r.name}: ${r.description}`).join("\n");
}

// FR-8.9: platform SSO/SAML login, distinct from the in-app RBAC above. This
// build has no real SAML/OIDC handshake -- it exposes the shape (config,
// callback that links a verified IdP subject to a platform user, and the
// disable/revoke path attachUser now enforces) so a real IdP integration is a
// swap-in behind /admin/sso/callback rather than a new access-control model.
export function getSsoConfig() {
  return {
    enabled: Boolean(process.env.SSO_PROVIDER),
    provider: process.env.SSO_PROVIDER ?? null,
    loginUrl: process.env.SSO_PROVIDER ? `/api/admin/sso/callback` : null,
  };
}

// Represents the point where a real IdP (Okta/Azure AD/etc.) would redirect back
// with a verified subject. Upserts the platform user's SSO linkage; role is
// still assigned within the platform (FR-8.1), the IdP only proves identity.
export function ssoCallback(input: { subjectId: string; email: string; name: string; provider: string }) {
  const existing = db.prepare("SELECT * FROM users WHERE sso_subject_id = ?").get(input.subjectId) as any;
  const now = new Date().toISOString();
  if (existing) {
    if (existing.sso_disabled_at) throw new Error("This user's SSO access has been disabled");
    return existing;
  }
  const id = nanoid(10);
  db.prepare(
    "INSERT INTO users (id, name, role, email, owned_modules, sso_subject_id, sso_provider, created_at) VALUES (?, ?, 'Tester', ?, '', ?, ?, ?)"
  ).run(id, input.name, input.email, input.subjectId, input.provider, now);
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id);
}

export function disableSsoUser(userId: string) {
  db.prepare("UPDATE users SET sso_disabled_at = ? WHERE id = ?").run(new Date().toISOString(), userId);
  return db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
}

// FR-8.11: audit log retention -- entries are stamped with a retain_until on
// write; there is deliberately no UPDATE/DELETE route anywhere in this codebase
// for audit_log (grep confirms), so immutability for every role including
// QA Lead/Admin is structural, not a permission check that could be bypassed.
export const AUDIT_RETENTION_DAYS = Number(process.env.AUDIT_RETENTION_DAYS) || 365;

export function getAuditRetentionPolicy() {
  return {
    retentionDays: AUDIT_RETENTION_DAYS,
    immutable: true,
    note: "No route exists to edit or delete audit_log entries for any role, including QA Lead/Admin (FR-8.11).",
  };
}

// SR-FR-8.5: export archive format version. Bump this whenever the export
// shape changes in a way that would make an older/newer archive unsafe to
// blindly import (e.g. a table added/removed from the `tables` list below).
export const EXPORT_SCHEMA_VERSION = 1;

// FR-8.10: full export of a project's test cases, automation scripts, screens,
// execution profiles, and settings, for backup or migration between
// environments/orgs. This build has a single implicit "project" (no
// multi-tenant project scoping exists yet), so export covers the whole dataset.
export function exportProject() {
  return {
    exported_at: new Date().toISOString(),
    schema_version: EXPORT_SCHEMA_VERSION,
    test_cases: db.prepare("SELECT * FROM test_cases").all(),
    automation_scripts: db.prepare("SELECT * FROM automation_scripts").all(),
    screens: db.prepare("SELECT * FROM screens").all(),
    execution_profiles: db.prepare("SELECT * FROM execution_profiles").all(),
    environments: db.prepare("SELECT id, name, target_url, default_profile_id, created_at, updated_at FROM environments").all(), // credentials intentionally excluded from export
    inputs: db.prepare("SELECT * FROM inputs").all(),
  };
}

export class ImportSchemaVersionError extends Error {
  constructor(found: unknown) {
    super(
      `Unrecognized export schema_version (${JSON.stringify(found)}). This platform can only import schema_version ${EXPORT_SCHEMA_VERSION}. ` +
        `Refusing to partially import an incompatible archive -- re-export from a compatible version instead.`
    );
  }
}

// FR-8.10/SR-FR-8.5: re-import a previously exported project, reproducing the
// same suite state. Rejects (rather than partially importing) an archive
// whose schema_version is missing or doesn't match this platform's, instead
// of silently attempting a best-effort import of a shape it doesn't
// recognize. Once the version check passes, inserts remain best-effort
// per-row (a single malformed row doesn't abort the whole import) and use
// INSERT OR IGNORE so re-importing the same export twice is a safe no-op
// rather than a duplicate/constraint-violation error.
export function importProject(payload: any) {
  if (payload?.schema_version !== EXPORT_SCHEMA_VERSION) {
    throw new ImportSchemaVersionError(payload?.schema_version);
  }
  const counts: Record<string, number> = {};
  const tables: Array<[string, string[]]> = [
    ["inputs", ["id", "type", "content", "created_at"]],
    ["screens", ["id", "name", "module_name", "source_input_id", "url_or_path", "last_captured_state_hash", "change_status", "last_compared_at", "visual_baseline_ref", "created_at", "updated_at"]],
    ["test_cases", ["id", "input_id", "title", "category", "steps", "expected_result", "confidence_score", "source_rationale", "status", "authorship_type", "version", "priority", "screen_id", "created_at", "updated_at"]],
    ["automation_scripts", ["id", "test_case_id", "language", "framework", "code", "file_path", "security_scan_status", "security_scan_notes", "screen_id", "created_at"]],
    ["execution_profiles", ["id", "name", "description", "browser_set", "concurrency", "artifact_capture_mode", "retention_days", "selection_mode", "retry_strategy", "provider", "created_at", "updated_at"]],
  ];

  for (const [table, columns] of tables) {
    const rows = Array.isArray(payload?.[table]) ? payload[table] : [];
    if (rows.length === 0) continue;
    const placeholders = columns.map((c) => `@${c}`).join(", ");
    const stmt = db.prepare(`INSERT OR IGNORE INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`);
    let inserted = 0;
    for (const row of rows) {
      const params: Record<string, any> = {};
      for (const c of columns) params[c] = row[c] ?? null;
      const result = stmt.run(params);
      if (result.changes > 0) inserted++;
    }
    counts[table] = inserted;
  }

  return { imported: counts };
}
