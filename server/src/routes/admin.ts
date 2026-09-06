import { Router } from "express";
import {
  createBusinessRule,
  createUser,
  disableSsoUser,
  exportProject,
  getApiSchemaDefaultMode,
  getAuditRetentionPolicy,
  getAccessibilityEnabled,
  getAccessibilityWcagLevel,
  getAuthzTestingEnabled,
  getCostSavingSetting,
  getExplorationDefaultMaxActions,
  getExplorationDefaultMaxDepth,
  getUserActivityDashboard,
  getVisualAiReasoningEnabled,
  getMaxDuplicateRequests,
  getMaxRequestsPerPage,
  getOrgRedactionSetting,
  getSlowApiThresholdMs,
  getSlowPageThresholdMs,
  getSsoConfig,
  getVisualDiffThresholdPercent,
  importProject,
  listAuditLog,
  listBusinessRules,
  listFlaggedForReReview,
  listUsers,
  logAudit,
  requireRole,
  routeTestCaseToOwner,
  sampleTestCasesForReReview,
  setAccessibilityEnabled,
  setAccessibilityWcagLevel,
  setApiSchemaDefaultMode,
  setAuthzTestingEnabled,
  setExplorationDefaultMaxActions,
  setExplorationDefaultMaxDepth,
  setVisualAiReasoningEnabled,
  setBusinessRuleActive,
  setCriticalPath,
  setCostSavingMode,
  setMaxDuplicateRequests,
  setMaxRequestsPerPage,
  setOrgRedactionSetting,
  setSlowApiThresholdMs,
  setSlowPageThresholdMs,
  setVisualDiffThresholdPercent,
  ssoCallback,
  submitSecondReviewerSignOff,
} from "../services/adminService.js";
import { isResponsiveScanEnabled, setResponsiveScanEnabled, getResponsiveViewports, setResponsiveViewports } from "../services/responsiveService.js";
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

// FR-8.1/FR-8.3: who's currently online (last_seen_at, stamped by attachUser
// on every request) and their audit_log activity rollup -- the "which user
// is logged in / what are they doing" dashboard.
adminRouter.get("/user-activity", requireRole("QA Lead"), (_req, res) => {
  res.json(getUserActivityDashboard());
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

// Deeper Bug Detection #3: percent-of-pixels-differing threshold above which a
// visual regression finding is filed -- same readable-by-anyone/QA-Lead-writes
// pattern as the toggles above.
adminRouter.get("/org-settings/visual-diff-threshold", (_req, res) => {
  res.json({ visual_diff_threshold_percent: getVisualDiffThresholdPercent() });
});

adminRouter.put("/org-settings/visual-diff-threshold", requireRole("QA Lead"), (req, res) => {
  const { threshold } = req.body as { threshold?: number };
  try {
    res.json(setVisualDiffThresholdPercent(Number(threshold), req.user));
  } catch (err: any) {
    res.status(400).json(errBody(400, err.message));
  }
});

// Deeper Bug Detection #2: default mode ('baseline' | 'strict') applied to a
// newly discovered API endpoint's stored schema.
adminRouter.get("/org-settings/api-schema-default-mode", (_req, res) => {
  res.json({ api_schema_default_mode: getApiSchemaDefaultMode() });
});

adminRouter.put("/org-settings/api-schema-default-mode", requireRole("QA Lead"), (req, res) => {
  const { mode } = req.body as { mode?: string };
  try {
    res.json(setApiSchemaDefaultMode(String(mode), req.user));
  } catch (err: any) {
    res.status(400).json(errBody(400, err.message));
  }
});

// Phase 1 hardening: identical (method+path) calls within one page visit
// before it's flagged as a likely duplicate/excessive-request bug.
adminRouter.get("/org-settings/max-duplicate-requests", (_req, res) => {
  res.json({ max_duplicate_requests: getMaxDuplicateRequests() });
});

adminRouter.put("/org-settings/max-duplicate-requests", requireRole("QA Lead"), (req, res) => {
  const { count } = req.body as { count?: number };
  try {
    res.json(setMaxDuplicateRequests(Number(count), req.user));
  } catch (err: any) {
    res.status(400).json(errBody(400, err.message));
  }
});

// Phase 2: accessibility (axe-core) on/off toggle and WCAG conformance level.
adminRouter.get("/org-settings/accessibility-enabled", (_req, res) => {
  res.json({ accessibility_enabled: getAccessibilityEnabled() });
});

adminRouter.put("/org-settings/accessibility-enabled", requireRole("QA Lead"), (req, res) => {
  const { enabled } = req.body as { enabled?: boolean };
  res.json(setAccessibilityEnabled(!!enabled, req.user));
});

adminRouter.get("/org-settings/accessibility-wcag-level", (_req, res) => {
  res.json({ accessibility_wcag_level: getAccessibilityWcagLevel() });
});

adminRouter.put("/org-settings/accessibility-wcag-level", requireRole("QA Lead"), (req, res) => {
  const { level } = req.body as { level?: string };
  try {
    res.json(setAccessibilityWcagLevel(String(level), req.user));
  } catch (err: any) {
    res.status(400).json(errBody(400, err.message));
  }
});

// Phase 4b: performance thresholds.
adminRouter.get("/org-settings/slow-api-threshold-ms", (_req, res) => {
  res.json({ slow_api_threshold_ms: getSlowApiThresholdMs() });
});
adminRouter.put("/org-settings/slow-api-threshold-ms", requireRole("QA Lead"), (req, res) => {
  try {
    res.json(setSlowApiThresholdMs(Number(req.body?.ms), req.user));
  } catch (err: any) {
    res.status(400).json(errBody(400, err.message));
  }
});

adminRouter.get("/org-settings/slow-page-threshold-ms", (_req, res) => {
  res.json({ slow_page_threshold_ms: getSlowPageThresholdMs() });
});
adminRouter.put("/org-settings/slow-page-threshold-ms", requireRole("QA Lead"), (req, res) => {
  try {
    res.json(setSlowPageThresholdMs(Number(req.body?.ms), req.user));
  } catch (err: any) {
    res.status(400).json(errBody(400, err.message));
  }
});

adminRouter.get("/org-settings/max-requests-per-page", (_req, res) => {
  res.json({ max_requests_per_page: getMaxRequestsPerPage() });
});
adminRouter.put("/org-settings/max-requests-per-page", requireRole("QA Lead"), (req, res) => {
  try {
    res.json(setMaxRequestsPerPage(Number(req.body?.count), req.user));
  } catch (err: any) {
    res.status(400).json(errBody(400, err.message));
  }
});

// Phase 4a: authz testing org-wide opt-in. Defaults off -- see
// authzTestingService.ts's own doc comment for why this alone doesn't make
// probes runnable (the target environment also needs a secondary identity).
adminRouter.get("/org-settings/authz-testing-enabled", (_req, res) => {
  res.json({ authz_testing_enabled: getAuthzTestingEnabled() });
});
adminRouter.put("/org-settings/authz-testing-enabled", requireRole("QA Lead"), (req, res) => {
  res.json(setAuthzTestingEnabled(!!req.body?.enabled, req.user));
});

// Phase 4c: exploratory agent default budget.
adminRouter.get("/org-settings/exploration-defaults", (_req, res) => {
  res.json({ max_actions: getExplorationDefaultMaxActions(), max_depth: getExplorationDefaultMaxDepth() });
});
adminRouter.put("/org-settings/exploration-defaults", requireRole("QA Lead"), (req, res) => {
  try {
    if (req.body?.maxActions !== undefined) setExplorationDefaultMaxActions(Number(req.body.maxActions), req.user);
    if (req.body?.maxDepth !== undefined) setExplorationDefaultMaxDepth(Number(req.body.maxDepth), req.user);
    res.json({ max_actions: getExplorationDefaultMaxActions(), max_depth: getExplorationDefaultMaxDepth() });
  } catch (err: any) {
    res.status(400).json(errBody(400, err.message));
  }
});

// Master-prompt §7: optional AI visual-diff reasoning on/off toggle.
adminRouter.get("/org-settings/visual-ai-reasoning-enabled", (_req, res) => {
  res.json({ visual_ai_reasoning_enabled: getVisualAiReasoningEnabled() });
});
adminRouter.put("/org-settings/visual-ai-reasoning-enabled", requireRole("QA Lead"), (req, res) => {
  res.json(setVisualAiReasoningEnabled(!!req.body?.enabled, req.user));
});

// Deeper Bug Detection #5: on/off toggle for the mobile/tablet re-scan layered
// on top of the existing desktop bug scan.
adminRouter.get("/org-settings/responsive-scan", (_req, res) => {
  res.json({ responsive_scan_enabled: isResponsiveScanEnabled() });
});

adminRouter.put("/org-settings/responsive-scan", requireRole("QA Lead"), (req, res) => {
  const { enabled } = req.body as { enabled?: boolean };
  setResponsiveScanEnabled(Boolean(enabled));
  res.json({ responsive_scan_enabled: isResponsiveScanEnabled() });
});

// Deeper Bug Detection #5: the extra viewports (beyond desktop) every check
// re-runs at.
adminRouter.get("/org-settings/responsive-viewports", (_req, res) => {
  res.json({ viewports: getResponsiveViewports() });
});

adminRouter.put("/org-settings/responsive-viewports", requireRole("QA Lead"), (req, res) => {
  const { viewports } = req.body as { viewports?: Array<{ name: string; width: number; height: number }> };
  try {
    setResponsiveViewports(viewports ?? []);
    res.json({ viewports: getResponsiveViewports() });
  } catch (err: any) {
    res.status(400).json(errBody(400, err.message));
  }
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
