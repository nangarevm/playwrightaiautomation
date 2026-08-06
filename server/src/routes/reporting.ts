import { Router } from "express";
import {
  buildBugReportPdf,
  buildInteractiveHtmlReport,
  buildReleaseReportPdf,
  buildReleaseReportXlsx,
  detectFlakyScripts,
  getCoverageGaps,
  getDashboardSummary,
  getHoursSavedEstimate,
  getRequirementCoverage,
} from "../services/reportingService.js";
import { getLlmUsageSummary } from "../services/llmGatewayService.js";
import { getUserNotificationPref, sendScheduledDigests, setUserNotificationPref } from "../services/digestService.js";

export const reportingRouter = Router();

// FR-6.1: pass/fail dashboard with execution-time trends. Optional ?startDate=&endDate=
// (YYYY-MM-DD or full ISO) scopes the dashboard to a date range instead of always showing
// the platform's entire run history.
reportingRouter.get("/dashboard", (req, res) => {
  const { startDate, endDate } = req.query as { startDate?: string; endDate?: string };
  res.json(getDashboardSummary({ startDate, endDate }));
});

// FR-6.2: flaky test detection
reportingRouter.get("/flaky", (_req, res) => {
  res.json(detectFlakyScripts());
});

// FR-6.3: requirement coverage mapped to user stories
reportingRouter.get("/coverage", (_req, res) => {
  res.json(getRequirementCoverage());
});

// FR-6.6: hours-saved estimate. Optional ?startDate=&endDate= computes it "per period" (see
// getHoursSavedEstimate's comment on why this is a date-range proxy, not a Sprint entity).
reportingRouter.get("/time-saved", (req, res) => {
  const { startDate, endDate } = req.query as { startDate?: string; endDate?: string };
  res.json(getHoursSavedEstimate({ startDate, endDate }));
});

// FR-6.10 (amended by v4.5): LLM token usage/cost per project, including
// savings attributable to FR-9.5 semantic caching and FR-9.7 cost-aware routing
reportingRouter.get("/llm-usage", (_req, res) => {
  res.json(getLlmUsageSummary());
});

// FR-6.8: coverage-gap flags (zero/stale test cases) for the Screen Explorer
reportingRouter.get("/coverage-gaps", (_req, res) => {
  res.json(getCoverageGaps());
});

// FR-6.11: self-contained interactive HTML run report. Optional ?runId= scopes
// the report to a single run -- used by FR-4.27 to deliver the report for the
// Ultrafast run that just completed, not the whole platform's run history.
reportingRouter.get("/export.html", (req, res) => {
  const { runId } = req.query as { runId?: string };
  res.setHeader("Content-Type", "text/html");
  res.send(buildInteractiveHtmlReport(runId));
});

// FR-6.9: manually trigger the scheduled digest (also runs automatically on an interval)
reportingRouter.post("/digest/send", async (_req, res) => {
  res.json(await sendScheduledDigests());
});

// FR-6.12: per-user notification channel/frequency, overriding the org default
reportingRouter.get("/notification-prefs/:userId", (req, res) => {
  res.json(getUserNotificationPref(req.params.userId));
});

reportingRouter.put("/notification-prefs/:userId", (req, res) => {
  const { channel, frequency } = req.body as { channel?: string; frequency?: string };
  if (!channel || !frequency) return res.status(400).json({ error: "channel and frequency are required" });
  res.json(setUserNotificationPref(req.params.userId, channel, frequency));
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

// Customer-facing bug report PDF for a single crawl/batch (Crawler tab's "Download
// bug report as PDF"). The failure list is client-assembled (see buildBugReportPdf's
// comment) and posted here rather than looked up by runId, since the client's
// classification/grouping is already the source of truth for what the user sees.
reportingRouter.post("/bug-report.pdf", async (req, res) => {
  try {
    const { entries } = req.body as { entries?: unknown };
    if (!Array.isArray(entries) || entries.length === 0) {
      return res.status(400).json({ error: "entries (non-empty array) is required" });
    }
    const buffer = await buildBugReportPdf(entries as any);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "attachment; filename=bug-report.pdf");
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
