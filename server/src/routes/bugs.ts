import { Router } from "express";
import {
  fuzzApiEndpoints,
  getBugFinding,
  listBugFindings,
  markBugFindingFiled,
  runBugScanForScreen,
  updateBugFindingStatus,
} from "../services/bugDetectionService.js";
import { runResponsiveBugScan } from "../services/responsiveService.js";
import { formatBugReport, getBugDashboard, getBugGroup, reverifyHighConfidenceFinding } from "../services/bugReportingService.js";
import {
  createConsistencyRule,
  deleteConsistencyRule,
  getConsistencyRule,
  listConsistencyRules,
  setConsistencyRuleActive,
} from "../services/uiApiConsistencyService.js";
import { fileGenericBug } from "../services/integrationsService.js";
import { errBody } from "../errorCodes.js";

export const bugsRouter = Router();

// Bug Detection Engine findings -- proactively discovered defects (exploratory
// UI scan + API fuzz), distinct from FR-7.6's reactive regression auto-filing.
// `category` filters by the six-value taxonomy (console-error/api-status/
// api-schema/ui-visual/ui-dom/ui-api-mismatch) plus 'functional' for
// regression findings.
bugsRouter.get("/", (req, res) => {
  const { status, severity, screenId, category } = req.query as { status?: string; severity?: string; screenId?: string; category?: string };
  res.json(listBugFindings({ status, severity, screenId, category }));
});

// Deeper Bug Detection #6: declarative UI-count-vs-API-count rules. Reliably
// auto-pairing an arbitrary rendered list with the right endpoint/field isn't
// a solvable heuristic in general, so a human names the pairing once here --
// every future scan of the screen then checks it automatically.
// IMPORTANT: this whole block must stay registered BEFORE the single-segment
// `GET/PATCH /:id` routes below -- Express matches routes in registration
// order, so `GET /:id` would otherwise swallow `GET /consistency-rules` as
// id="consistency-rules" and this route would never be reached.
bugsRouter.get("/consistency-rules", (req, res) => {
  const { screenId } = req.query as { screenId?: string };
  res.json(listConsistencyRules(screenId));
});

bugsRouter.post("/consistency-rules", (req, res) => {
  const { screenId, name, domSelector, apiEndpointKey, jsonPath, comparisonMode } = req.body as {
    screenId?: string;
    name?: string;
    domSelector?: string;
    apiEndpointKey?: string;
    jsonPath?: string;
    comparisonMode?: "exact" | "at-most";
  };
  try {
    res.status(201).json(createConsistencyRule({ screenId: screenId!, name, domSelector: domSelector!, apiEndpointKey: apiEndpointKey!, jsonPath, comparisonMode }));
  } catch (err: any) {
    res.status(400).json(errBody(400, err.message));
  }
});

bugsRouter.patch("/consistency-rules/:id", (req, res) => {
  const { isActive } = req.body as { isActive?: boolean };
  const rule = getConsistencyRule(req.params.id);
  if (!rule) return res.status(404).json(errBody(404, "Consistency rule not found."));
  res.json(setConsistencyRuleActive(req.params.id, Boolean(isActive)));
});

bugsRouter.delete("/consistency-rules/:id", (req, res) => {
  deleteConsistencyRule(req.params.id);
  res.status(204).end();
});

// Phase 5: developer-ready reporting. IMPORTANT: these literal-prefix routes
// (dashboard, groups/:id) must stay registered before the single-segment
// `GET /:id` below, for the same reason the consistency-rules block above
// is -- Express matches routes in registration order, so `GET /:id` would
// otherwise swallow `GET /dashboard` as id="dashboard".
bugsRouter.get("/dashboard", (_req, res) => {
  res.json(getBugDashboard());
});

bugsRouter.get("/groups/:correlationGroupId", (req, res) => {
  try {
    res.json(getBugGroup(req.params.correlationGroupId));
  } catch (err: any) {
    res.status(404).json(errBody(404, err.message));
  }
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
  const { screenId, apiBaseUrl, endpoints, responsive } = req.body as { screenId?: string; apiBaseUrl?: string; endpoints?: string[]; responsive?: boolean };
  if (!screenId && !apiBaseUrl) {
    return res.status(400).json(errBody(400, "Provide screenId for a UI scan, or apiBaseUrl + endpoints for an API fuzz pass."));
  }

  try {
    const findings = [];
    if (screenId) {
      findings.push(...(await runBugScanForScreen(screenId)));
      // Deeper Bug Detection #5: on-demand mobile/tablet re-scan alongside the
      // desktop one above, when explicitly requested.
      if (responsive) findings.push(...(await runResponsiveBugScan(screenId)));
    }
    if (apiBaseUrl && Array.isArray(endpoints) && endpoints.length > 0) {
      findings.push(...(await fuzzApiEndpoints(apiBaseUrl, endpoints)));
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

// Phase 5: formatted export (master prompt #24's template shape) for a single finding.
bugsRouter.get("/:id/report", (req, res) => {
  try {
    res.type("text/markdown").send(formatBugReport(req.params.id));
  } catch (err: any) {
    res.status(404).json(errBody(404, err.message));
  }
});

// Phase 5: bounded re-verification for a high-confidence finding before its
// confidence is treated as final (master prompt #21).
bugsRouter.post("/:id/reverify", async (req, res) => {
  const finding = getBugFinding(req.params.id);
  if (!finding) return res.status(404).json(errBody(404, "Bug finding not found."));
  try {
    res.json(await reverifyHighConfidenceFinding(req.params.id));
  } catch (err: any) {
    res.status(400).json(errBody(400, err.message || "Re-verification failed."));
  }
});
