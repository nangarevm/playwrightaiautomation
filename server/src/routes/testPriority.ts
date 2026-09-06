import { Router } from "express";
import { computeTestPriorities } from "../services/testPriorityService.js";

export const testPriorityRouter = Router();

// Playbook §3 -- Test Priority: every cataloged screen's testing priority,
// highest-risk-first, so a QA lead (or an orchestrating caller deciding
// where to spend a limited exploration budget) knows where to start.
testPriorityRouter.get("/", (_req, res) => {
  res.json(computeTestPriorities());
});
