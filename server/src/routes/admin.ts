import { Router } from "express";
import {
  createBusinessRule,
  createUser,
  disableSsoUser,
  exportProject,
  getAuditRetentionPolicy,
  getCostSavingSetting,
  getOrgRedactionSetting,
  getSsoConfig,
  importProject,
  listAuditLog,
  listBusinessRules,
  listFlaggedForReReview,
  listUsers,
  logAudit,
  requireRole,
  routeTestCaseToOwner,
  sampleTestCasesForReReview,
  setBusinessRuleActive,
  setCriticalPath,
  setCostSavingMode,
  setOrgRedactionSetting,
  ssoCallback,
  submitSecondReviewerSignOff,
} from "../services/adminService.js";
import { errBody } from "../errorCodes.js";

export const adminRouter = Router();

// FR-8.1: user directory (role-based access control)
adminRouter.get("/users", requireRole("QA Lead"), (_req, res) => {
  res.json(listUsers());
});

adminRouter.post("/users", requireRole("QA Lead"), (req, res) => {
  try {
    const user = createUser(req.body);
    logAudit(req.user, "user_created", "user", (user as any).id, { name: (user as any).name, role: (user as any).role });
    res.status(201).json(user);
  } catch (err: any) {
    res.status(400).json(errBody(400, err.message));
  }
});

// FR-8.3: audit log across modules
adminRouter.get("/audit-log", requireRole("QA Lead"), (req, res) => {
  res.json(listAuditLog({ entityType: req.query.entityType as string, entityId: req.query.entityId as string, limit: req.query.limit ? Number(req.query.limit) : undefined }));
});

// FR-8.5: route a test case to its owning tester/team
adminRouter.post("/test-cases/:id/route-owner", requireRole("QA Lead"), (req, res) => {
  try {
    const result = routeTestCaseToOwner(req.params.id);
    logAudit(req.user, "test_case_routed", "test_case", req.params.id, result);
    res.json(result);
  } catch (err: any) {
    res.status(404).json({ error: err.message });
  }
});

// FR-8.6: mark/unmark a test case as covering a critical path (requires second-reviewer sign-off)
adminRouter.post("/test-cases/:id/critical-path", requireRole("QA Lead"), (req, res) => {
  const { critical } = req.body as { critical?: boolean };
  const updated = setCriticalPath(req.params.id, Boolean(critical));
  logAudit(req.user, "critical_path_flagged", "test_case", req.params.id, { critical: Boolean(critical) });
  res.json(updated);
});

adminRouter.post("/test-cases/:id/second-reviewer-signoff", requireRole("QA Lead"), (req, res) => {
  const { decision } = req.body as { decision?: "approved" | "rejected" };
  if (decision !== "approved" && decision !== "rejected") {
    return res.status(400).json(errBody(400, "decision must be 'approved' or 'rejected'"));
  }
  try {
    const updated = submitSecondReviewerSignOff(req.params.id, req.user!, decision);
    logAudit(req.user, "second_reviewer_signoff", "test_case", req.params.id, { decision });
    res.json(updated);
  } catch (err: any) {
    res.status(400).json(errBody(400, err.message));
  }
});

// FR-8.8: periodic re-review sampling to catch AI drift
adminRouter.post("/re-review/sample", requireRole("QA Lead"), (req, res) => {
  const { count } = req.body as { count?: number };
  const sampled = sampleTestCasesForReReview(count ?? 5);
  logAudit(req.user, "re_review_sampled", "test_case", null, { sampled });
  res.json({ sampled });
});

adminRouter.get("/re-review/flagged", (_req, res) => {
  res.json(listFlaggedForReReview());
});

// FR-1.8: org-level PII redaction toggle -- readable by anyone (so ingestion
// routes and the UI can show the current policy), only QA Lead can change it
adminRouter.get("/org-settings/redaction", (_req, res) => {
  res.json(getOrgRedactionSetting());
});

adminRouter.put("/org-settings/redaction", requireRole("QA Lead"), (req, res) => {
  const { disabled } = req.body as { disabled?: boolean };
  res.json(setOrgRedactionSetting(Boolean(disabled), req.user));
});

// Single-QA cost-saving mode: routes more generation calls to the cheap
// model tier (llmGatewayService.ts's chooseModelTier). Readable by anyone,
// same pattern as the redaction toggle above.
adminRouter.get("/org-settings/cost-saving", (_req, res) => {
  res.json(getCostSavingSetting());
});

adminRouter.put("/org-settings/cost-saving", (req, res) => {
  const { enabled } = req.body as { enabled?: boolean };
  res.json(setCostSavingMode(Boolean(enabled), req.user));
});

// FR-2.11: QA-Lead-managed domain/business rules
adminRouter.get("/business-rules", (req, res) => {
  res.json(listBusinessRules(req.query.activeOnly === "true"));
});

adminRouter.post("/business-rules", requireRole("QA Lead"), (req, res) => {
  const { name, description } = req.body as { name?: string; description?: string };
  try {
    res.status(201).json(createBusinessRule({ name: name!, description: description! }, req.user));
  } catch (err: any) {
    res.status(400).json(errBody(400, err.message));
  }
});

adminRouter.patch("/business-rules/:id", requireRole("QA Lead"), (req, res) => {
  const { active } = req.body as { active?: boolean };
  res.json(setBusinessRuleActive(req.params.id, Boolean(active), req.user));
});

// FR-8.9: platform SSO/SAML login config + IdP callback + disable/revoke
adminRouter.get("/sso/config", (_req, res) => {
  res.json(getSsoConfig());
});

adminRouter.post("/sso/callback", (req, res) => {
  const { subjectId, email, name, provider } = req.body as { subjectId?: string; email?: string; name?: string; provider?: string };
  if (!subjectId || !email || !name || !provider) {
    return res.status(400).json(errBody(400, "subjectId, email, name, and provider are required"));
  }
  try {
    const user = ssoCallback({ subjectId, email, name, provider });
    res.json(user);
  } catch (err: any) {
    res.status(403).json(errBody(403, err.message));
  }
});

adminRouter.post("/sso/users/:id/disable", requireRole("QA Lead"), (req, res) => {
  const updated = disableSsoUser(req.params.id);
  logAudit(req.user, "sso_user_disabled", "user", req.params.id);
  res.json(updated);
});

// FR-8.10: full project export/import for backup or migration between environments/orgs
adminRouter.get("/project/export", requireRole("QA Lead"), (req, res) => {
  const payload = exportProject();
  logAudit(req.user, "project_exported", "project", null, { counts: Object.fromEntries(Object.entries(payload).map(([k, v]) => [k, Array.isArray(v) ? v.length : 1])) });
  res.setHeader("Content-Disposition", "attachment; filename=project-export.json");
  res.json(payload);
});

adminRouter.post("/project/import", requireRole("QA Lead"), (req, res) => {
  try {
    const result = importProject(req.body);
    logAudit(req.user, "project_imported", "project", null, result);
    res.json(result);
  } catch (err: any) {
    res.status(400).json(errBody(400, err.message));
  }
});

// FR-8.11: audit log retention policy (entries are structurally immutable -- no
// route anywhere mutates or deletes audit_log rows, for any role)
adminRouter.get("/audit-log/retention-policy", (_req, res) => {
  res.json(getAuditRetentionPolicy());
});
