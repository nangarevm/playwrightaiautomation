import { Router } from "express";
import { generateFinalReport } from "../services/finalReportService.js";

export const finalReportRouter = Router();

// Playbook §48 -- Final Report: one consolidated end-of-cycle rollup
// (bug dashboard, coverage, quality scores, heatmap, test priority,
// regressions) assembled from every other engine already built.
finalReportRouter.get("/", (_req, res) => {
  res.json(generateFinalReport());
});
