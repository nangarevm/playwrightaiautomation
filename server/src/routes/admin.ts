import { Router } from "express";
import {
  createUser,
  listAuditLog,
  listFlaggedForReReview,
  listUsers,
  logAudit,
  requireRole,
  routeTestCaseToOwner,
  sampleTestCasesForReReview,
  setCriticalPath,
  submitSecondReviewerSignOff,
} from "../services/adminService.js";

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
    res.status(400).json({ error: err.message });
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
    return res.status(400).json({ error: "decision must be 'approved' or 'rejected'" });
  }
  try {
    const updated = submitSecondReviewerSignOff(req.params.id, req.user!, decision);
    logAudit(req.user, "second_reviewer_signoff", "test_case", req.params.id, { decision });
    res.json(updated);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
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
