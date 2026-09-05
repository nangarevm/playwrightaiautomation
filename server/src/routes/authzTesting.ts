import { Router } from "express";
import { runIdorProbe, runVerticalEscalationProbe, isAuthzTestingConfigured, AuthzTestingNotAuthorizedError } from "../services/authzTestingService.js";
import { requireRole } from "../services/adminService.js";
import { errBody } from "../errorCodes.js";

export const authzTestingRouter = Router();

// Phase 4a -- authz testing status for a specific environment: whether the
// org-wide opt-in and this environment's secondary identity are both
// configured (either being off means every probe below refuses to run).
authzTestingRouter.get("/status/:environmentId", (req, res) => {
  res.json(isAuthzTestingConfigured(req.params.environmentId));
});

// Restricted to QA Lead -- this sends real requests as a second identity
// against a real target, not something any role should be able to trigger.
authzTestingRouter.post("/idor-probe", requireRole("QA Lead"), async (req, res) => {
  const { environmentId, candidateUrls, runId } = req.body as { environmentId?: string; candidateUrls?: string[]; runId?: string };
  if (!environmentId || !Array.isArray(candidateUrls) || candidateUrls.length === 0) {
    return res.status(400).json(errBody(400, "environmentId and a non-empty candidateUrls array are required."));
  }
  try {
    res.json(await runIdorProbe(environmentId, candidateUrls, runId));
  } catch (err: any) {
    if (err instanceof AuthzTestingNotAuthorizedError) return res.status(403).json(errBody(403, err.message));
    res.status(400).json(errBody(400, err.message || "IDOR probe failed."));
  }
});

authzTestingRouter.post("/vertical-escalation-probe", requireRole("QA Lead"), async (req, res) => {
  const { environmentId, primaryOnlyUrls, runId } = req.body as { environmentId?: string; primaryOnlyUrls?: string[]; runId?: string };
  if (!environmentId || !Array.isArray(primaryOnlyUrls) || primaryOnlyUrls.length === 0) {
    return res.status(400).json(errBody(400, "environmentId and a non-empty primaryOnlyUrls array are required."));
  }
  try {
    res.json(await runVerticalEscalationProbe(environmentId, primaryOnlyUrls, runId));
  } catch (err: any) {
    if (err instanceof AuthzTestingNotAuthorizedError) return res.status(403).json(errBody(403, err.message));
    res.status(400).json(errBody(400, err.message || "Vertical escalation probe failed."));
  }
});
