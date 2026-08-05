import { Router } from "express";
import { db } from "../db.js";
import { logAudit, requireRole } from "../services/adminService.js";
import {
  applySelfHealingForTestCase,
  detectChangesForTestCase,
  getSelfHealConfidenceThreshold,
  listAutoHealActions,
  rollbackAutoHealAction,
  setSelfHealConfidenceThreshold,
} from "../services/selfHealingService.js";
import { errBody } from "../errorCodes.js";

export const selfHealingRouter = Router();

// FR-5.4: view/edit the self-heal high-confidence threshold. Viewable by anyone (needed by
// Testing.tsx to show the live value), edits gated to QA Lead.
selfHealingRouter.get("/confidence-threshold", (_req, res) => {
  res.json({ threshold: getSelfHealConfidenceThreshold() });
});

selfHealingRouter.put("/confidence-threshold", requireRole("QA Lead"), (req, res) => {
  const { threshold } = req.body as { threshold?: number };
  try {
    const result = setSelfHealConfidenceThreshold(Number(threshold), req.user);
    res.json({ threshold: result.selfHealConfidenceThreshold });
  } catch (err: any) {
    res.status(400).json(errBody(400, err.message));
  }
});

// FR-5.1/FR-5.2: detect UI/API changes and record a numeric confidence score
selfHealingRouter.post("/:testCaseId/detect", (req, res) => {
  const testCase = db.prepare("SELECT * FROM test_cases WHERE id = ?").get(req.params.testCaseId);
  if (!testCase) return res.status(404).json({ error: "test case not found" });

  const { uiBeforeHtml, uiAfterHtml, apiBeforeSpec, apiAfterSpec, source } = req.body as {
    uiBeforeHtml?: string;
    uiAfterHtml?: string;
    apiBeforeSpec?: string;
    apiAfterSpec?: string;
    source?: string;
  };

  const detection = detectChangesForTestCase({
    testCaseId: req.params.testCaseId,
    uiBeforeHtml: uiBeforeHtml ?? "",
    uiAfterHtml: uiAfterHtml ?? "",
    apiBeforeSpec: apiBeforeSpec ?? "",
    apiAfterSpec: apiAfterSpec ?? "",
    source,
  });

  res.status(201).json(detection);
});

// FR-5.3/FR-5.4: attempt an automatic locator heal; below the confidence threshold, flag for regeneration instead
selfHealingRouter.post("/:testCaseId/heal", (req, res) => {
  const testCase = db.prepare("SELECT * FROM test_cases WHERE id = ?").get(req.params.testCaseId);
  if (!testCase) return res.status(404).json({ error: "test case not found" });

  const { detectionId, beforeLocator, afterLocator, confidence, reason } = req.body as {
    detectionId?: string;
    beforeLocator?: string;
    afterLocator?: string;
    confidence?: number;
    reason?: string;
  };

  if (!detectionId || !beforeLocator || !afterLocator || typeof confidence !== "number") {
    return res.status(400).json(errBody(400, "detectionId, beforeLocator, afterLocator, and a numeric confidence are required"));
  }

  try {
    const result = applySelfHealingForTestCase({
      testCaseId: req.params.testCaseId,
      detectionId,
      beforeLocator,
      afterLocator,
      confidence,
      reason: reason ?? "locator changed",
    });
    logAudit(req.user, result.applied ? "auto_heal_applied" : "auto_heal_flagged_for_regeneration", "test_case", req.params.testCaseId, { confidence, healActionId: result.healActionId });
    res.status(201).json(result);
  } catch (err: any) {
    res.status(400).json(errBody(400, err.message));
  }
});

// FR-5.6: one-click rollback if a heal is later found incorrect
selfHealingRouter.post("/heal-actions/:healActionId/rollback", (req, res) => {
  const result = rollbackAutoHealAction(req.params.healActionId);
  if (!result.rolledBack) return res.status(404).json(result);
  logAudit(req.user, "auto_heal_rolled_back", "auto_heal_action", req.params.healActionId);
  res.json(result);
});

selfHealingRouter.get("/:testCaseId/heal-actions", (req, res) => {
  res.json(listAutoHealActions(req.params.testCaseId));
});

selfHealingRouter.get("/:testCaseId/detections", (req, res) => {
  const rows = db.prepare("SELECT * FROM change_detections WHERE test_case_id = ? ORDER BY detected_at DESC").all(req.params.testCaseId);
  res.json(rows);
});
