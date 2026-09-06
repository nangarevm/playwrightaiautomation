import { Router } from "express";
import { computeCoverageModel } from "../services/coverageModelService.js";
import { computeAppWideQualityScore, computeQualityScoresByScreen } from "../services/qualityScoreService.js";
import { computeBugHeatmap } from "../services/bugHeatmapService.js";
import { listRegressions, summarizeRegressions } from "../services/regressionIntelligenceService.js";

export const qualityIntelligenceRouter = Router();

// Playbook §37 -- Coverage Model: what fraction of cataloged screens have
// any test-case/automation coverage or bug-scan activity, and which
// BugCategory values have ever actually been detected anywhere.
qualityIntelligenceRouter.get("/coverage-model", (_req, res) => {
  res.json(computeCoverageModel());
});

// Playbook §43 -- Quality Score: a 0-100 health score, app-wide or per
// cataloged screen (worst-first), derived from open findings weighted by
// severity and confidence.
qualityIntelligenceRouter.get("/quality-score", (_req, res) => {
  res.json({ appWide: computeAppWideQualityScore(), byScreen: computeQualityScoresByScreen() });
});

// Playbook §44 -- Heatmap: screen x category breakdown of where open
// findings cluster, hottest cells first.
qualityIntelligenceRouter.get("/heatmap", (_req, res) => {
  res.json(computeBugHeatmap());
});

// Playbook §45 -- Regression Intelligence: findings that recurred after
// being marked resolved, most-recently-regressed first, plus a small rollup.
qualityIntelligenceRouter.get("/regressions", (_req, res) => {
  res.json({ summary: summarizeRegressions(), regressions: listRegressions() });
});
