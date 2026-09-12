import { Router } from "express";
import {
  fuzzApiEndpoints,
  getQaDashboard,
  getBugFinding,
  listBugFindings,
  markBugFindingFiled,
  runBugScanForScreen,
  updateBugFindingStatus,
} from "../services/bugDetectionService.js";
import { fileGenericBug } from "../services/integrationsService.js";
import { errBody } from "../errorCodes.js";

export const bugsRouter = Router();

// Bug Detection Engine findings -- proactively discovered defects (exploratory
// UI scan + API fuzz), distinct from FR-7.6's reactive regression auto-filing.
bugsRouter.get("/", (req, res) => {
  const { status, severity, screenId, siteId, validationStatus } = req.query as {
    status?: string;
    severity?: string;
    screenId?: string;
    siteId?: string;
    validationStatus?: string;
  };
  res.json(listBugFindings({ status, severity, screenId, siteId, validationStatus }));
});

bugsRouter.get("/dashboard/summary", (req, res) => {
  const siteId = typeof req.query.siteId === "string" ? req.query.siteId : undefined;
  res.json(getQaDashboard(siteId));
});

bugsRouter.get("/:id", (req, res) => {
  const finding = getBugFinding(req.params.id);
  if (!finding) return res.status(404).json(errBody(404, "Bug finding not found."));
  res.json(finding);
});

// On-demand exploratory UI scan of a single cataloged Screen. The same scan also
// runs automatically right after an execution run completes when the run's
// script is tagged to a screen with a known URL (see executionService.ts).
bugsRouter.post("/scan", async (req, res) => {
  const { screenId, apiBaseUrl, endpoints, headers } = req.body as {
    screenId?: string;
    apiBaseUrl?: string;
    endpoints?: string[];
    headers?: Record<string, string>;
  };
  if (!screenId && !apiBaseUrl) {
    return res.status(400).json(errBody(400, "Provide screenId for a UI scan, or apiBaseUrl + endpoints for an API fuzz pass."));
  }

  try {
    const findings = [];
    if (screenId) {
      findings.push(...(await runBugScanForScreen(screenId)));
    }
    if (apiBaseUrl && Array.isArray(endpoints) && endpoints.length > 0) {
      findings.push(...(await fuzzApiEndpoints(apiBaseUrl, endpoints, undefined, headers || {})));
    }
    res.status(201).json({ findings, count: findings.length });
  } catch (err: any) {
    res.status(400).json(errBody(400, err.message || "Bug scan failed."));
  }
});

bugsRouter.patch("/:id", (req, res) => {
  const { status } = req.body as { status?: "open" | "acknowledged" | "resolved" | "ignored" };
  if (!status || !["open", "acknowledged", "resolved", "ignored"].includes(status)) {
    return res.status(400).json(errBody(400, "status must be one of open/acknowledged/resolved/ignored"));
  }
  const finding = getBugFinding(req.params.id);
  if (!finding) return res.status(404).json(errBody(404, "Bug finding not found."));
  res.json(updateBugFindingStatus(req.params.id, status));
});

// Manually file a finding to the configured Jira/Azure integration -- findings
// are auto-filed already when severity is critical/high, this covers the rest
// (medium/low) plus a retry path if the automatic attempt failed.
bugsRouter.post("/:id/file", async (req, res) => {
  const finding = getBugFinding(req.params.id);
  if (!finding) return res.status(404).json(errBody(404, "Bug finding not found."));

  const result = await fileGenericBug(finding) as { filed: boolean; provider?: string; externalId?: string; reason?: string };
  if (!result?.filed) {
    return res.status(502).json(errBody(502, result?.reason || "Bug filing failed."));
  }
  res.json(markBugFindingFiled(req.params.id, result.provider!, result.externalId));
});
