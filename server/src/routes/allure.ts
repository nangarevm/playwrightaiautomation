import { Router } from "express";
import { errBody } from "../errorCodes.js";
import { generateAllureReport, getAllureReportStatus, zipAllureReport } from "../services/allureService.js";
import { isEmailConfigured, sendAllureReportEmail } from "../services/emailService.js";
import { getDashboardSummary } from "../services/reportingService.js";

export const allureRouter = Router();

// Phase 6: confirms report generation succeeded (file count, index.html present)
// BEFORE the client enables its download/view button -- so a failure shows up
// here rather than producing an empty/broken download.
allureRouter.post("/generate", async (_req, res) => {
  const result = await generateAllureReport();
  if (!result.ok) return res.status(502).json(errBody(502, result.message, result));
  res.json(result);
});

allureRouter.get("/status", (_req, res) => {
  res.json(getAllureReportStatus());
});

allureRouter.get("/download", async (_req, res) => {
  try {
    const { zipPath, hasRootIndex } = await zipAllureReport();
    if (!hasRootIndex) return res.status(500).json(errBody(500, "Zip verification failed: index.html not at zip root."));
    res.download(zipPath, "allure-report.zip");
  } catch (err: any) {
    res.status(400).json(errBody(400, err.message));
  }
});

allureRouter.get("/email-status", (_req, res) => {
  res.json({ configured: isEmailConfigured() });
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Emails the current Allure report (zipped) to a user-supplied address. Reuses
// zipAllureReport() so this always ships exactly what /download would.
allureRouter.post("/send-email", async (req, res) => {
  const { email } = req.body as { email?: string };
  if (!email || !EMAIL_RE.test(email)) return res.status(400).json(errBody(400, "A valid email address is required."));
  if (!isEmailConfigured()) {
    return res.status(501).json(errBody(501, "Email is not configured on this server -- set SMTP_HOST/SMTP_USER/SMTP_PASS (see server/.env.example)."));
  }
  try {
    const { zipPath, hasRootIndex } = await zipAllureReport();
    if (!hasRootIndex) return res.status(500).json(errBody(500, "Zip verification failed: index.html not at zip root."));
    const summary = getDashboardSummary();
    const result = await sendAllureReportEmail(email, zipPath, { total: summary.totalRuns, passed: summary.totals.passed, failed: summary.totals.failed });
    res.json(result);
  } catch (err: any) {
    res.status(400).json(errBody(400, err.message));
  }
});
