import { Router } from "express";
import {
  buildReleaseReportPdf,
  buildReleaseReportXlsx,
  detectFlakyScripts,
  getDashboardSummary,
  getHoursSavedEstimate,
  getRequirementCoverage,
} from "../services/reportingService.js";

export const reportingRouter = Router();

// FR-6.1: pass/fail dashboard with execution-time trends
reportingRouter.get("/dashboard", (_req, res) => {
  res.json(getDashboardSummary());
});

// FR-6.2: flaky test detection
reportingRouter.get("/flaky", (_req, res) => {
  res.json(detectFlakyScripts());
});

// FR-6.3: requirement coverage mapped to user stories
reportingRouter.get("/coverage", (_req, res) => {
  res.json(getRequirementCoverage());
});

// FR-6.6: hours-saved estimate per sprint
reportingRouter.get("/time-saved", (_req, res) => {
  res.json(getHoursSavedEstimate());
});

// FR-6.4: release-ready report export
reportingRouter.get("/export.pdf", async (_req, res) => {
  try {
    const buffer = await buildReleaseReportPdf();
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "attachment; filename=release-report.pdf");
    res.send(buffer);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

reportingRouter.get("/export.xlsx", (_req, res) => {
  try {
    const buffer = buildReleaseReportXlsx();
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", "attachment; filename=release-report.xlsx");
    res.send(buffer);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
