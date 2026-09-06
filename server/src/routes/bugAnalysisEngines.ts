import { Router } from "express";
import { findSystemicIssues } from "../services/bugExpansionService.js";
import { generateHypotheses } from "../services/hypothesisEngineService.js";
import { getBugFinding } from "../services/bugDetectionService.js";
import { errBody } from "../errorCodes.js";

export const bugAnalysisEnginesRouter = Router();

// Playbook §33 -- Bug Expansion Engine: the same defect recurring across
// multiple already-scanned screens, surfaced as one systemic-issue group
// instead of N separate low-priority findings.
bugAnalysisEnginesRouter.get("/systemic-issues", (req, res) => {
  const minScreens = req.query.minScreens ? Number(req.query.minScreens) : undefined;
  res.json(findSystemicIssues({ minScreens }));
});

// Playbook §32 -- Hypothesis Engine: given one confirmed finding from a
// declarative scenario check (network-failure/state-transition/multi-tab/
// list-behavior/file-transfer), suggests which other cataloged screens are
// worth configuring the same scenario against.
bugAnalysisEnginesRouter.get("/hypotheses/:findingId", (req, res) => {
  const finding = getBugFinding(req.params.findingId);
  if (!finding) return res.status(404).json(errBody(404, "Bug finding not found."));
  res.json(generateHypotheses(finding, finding.screen_id));
});
