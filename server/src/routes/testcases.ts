import { Router } from "express";
import { nanoid } from "nanoid";
import { db } from "../db.js";
import { logAudit } from "../services/adminService.js";
import { regenerateTestCase } from "../services/generationService.js";
import {
  addTestCaseDataRow,
  applyBulkAction,
  applyTestCaseReview,
  buildExplanation,
  createSyncRecord,
  deleteTestCases,
  detectDuplicateTestCases,
  exportTestCasesToCsv,
  exportTestCasesToDocx,
  exportTestCasesToPdf,
  exportTestCasesToXlsx,
  getReviewAgreementRate,
  getReviewAgreementRateByCompression,
  listDuplicateFlags,
  listReviewAuditEntries,
  listSyncRecords,
  listTestCaseDataRows,
  recordDataRowResult,
  resolveDuplicateFlag,
  runAllTestCaseDataRows,
  searchTestCases,
  TestCaseReviewError,
} from "../services/testCaseFeatures.js";
import { runExecution } from "../services/executionService.js";
import { errBody } from "../errorCodes.js";

export const testCasesRouter = Router();

function parseRow(row: any) {
  const parsed = { ...row, steps: JSON.parse(row.steps) };
  if (parsed.traceability_context) {
    parsed.traceability_context = JSON.parse(parsed.traceability_context);
  }
  return parsed;
}

testCasesRouter.get("/", (_req, res) => {
  const rows = db.prepare("SELECT * FROM test_cases ORDER BY created_at DESC").all();
  res.json(rows.map(parseRow));
});

// FR-8.7: allow a fully human-authored test case (distinct from ai/edited), so the suite view
// can visually distinguish all three authorship types rather than just ai vs. edited.
testCasesRouter.post("/", (req, res) => {
  const { input_id, title, category, steps, expected_result, priority } = req.body as {
    input_id?: string;
    title?: string;
    category?: string;
    steps?: string[];
    expected_result?: string;
    priority?: string;
  };
  if (!input_id || !title || !category || !Array.isArray(steps) || steps.length === 0 || !expected_result) {
    return res.status(400).json(errBody(400, "input_id, title, category, steps (non-empty array), and expected_result are required"));
  }

  const id = nanoid(10);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO test_cases
      (id, input_id, title, category, steps, expected_result, confidence_score, source_rationale, status, authorship_type, version, priority, created_at, updated_at)
    VALUES (@id, @input_id, @title, @category, @steps, @expected_result, 1.0, 'Authored directly by a human reviewer', 'draft', 'human', 1, @priority, @created_at, @updated_at)
  `).run({
    id,
    input_id,
    title,
    category,
    steps: JSON.stringify(steps),
    expected_result,
    priority: priority ?? "Medium",
    created_at: now,
    updated_at: now,
  });

  logAudit(req.user, "test_case_authored_by_human", "test_case", id, { title });
  res.status(201).json(parseRow(db.prepare("SELECT * FROM test_cases WHERE id = ?").get(id)));
});

// FR-2.9: 'Explain this test case' -- a real, non-mutating action returning a
// plain-language rationale. Previously the client's "Explain" button was wired
// to the accept/edit review endpoint, which silently performed an edit action
// (bumped version, changed authorship_type) as an undocumented side effect of
// what the user believed was a read-only explanation request.
testCasesRouter.get("/:id/explain", (req, res) => {
  const row = db.prepare("SELECT * FROM test_cases WHERE id = ?").get(req.params.id) as any;
  if (!row) return res.status(404).json({ error: "not found" });
  const explanation = row.explanation || buildExplanation({
    title: row.title,
    category: row.category,
    steps: JSON.parse(row.steps),
    expected_result: row.expected_result,
  });
  res.json({ explanation });
});

testCasesRouter.get("/:id", (req, res) => {
  const row = db.prepare("SELECT * FROM test_cases WHERE id = ?").get(req.params.id) as any;
  if (!row) return res.status(404).json({ error: "not found" });
  res.json(parseRow(row));
});

// FR-2.4 / FR-2.8 / FR-4.29: accept / edit / reject / needs_discussion, with optional inline
// edits. This is a thin wrapper around applyTestCaseReview (testCaseFeatures.ts) -- the same
// function Ultrafast Mode's auto-accept (FR-4.26) calls -- so a human accept and an Ultrafast
// auto-accept run through one state machine, not two.
testCasesRouter.patch("/:id/review", (req, res) => {
  const { action, edited_fields, reviewer_notes, base_version } = req.body as {
    action: "accept" | "edit" | "reject" | "needs_discussion";
    edited_fields?: Partial<{ title: string; steps: string[]; expected_result: string; category: string; priority: string }>;
    reviewer_notes?: string;
    base_version?: number;
  };

  // FR-4.29: "cannot execute automation against a test case that has not received an
  // explicit accept/edit/reject action recorded against a named reviewer" -- attachUser
  // (adminService.ts) defaults an unauthenticated caller to req.user.id === "anonymous" so
  // most routes keep working without a login system. That default is deliberately NOT good
  // enough here: this route is the one place that actually records the review decision a
  // Fast Mode run depends on, so it alone requires a real, non-anonymous identity. Other
  // routes that rely on attachUser's anonymous fallback are untouched.
  if (!req.user || !req.user.id || req.user.id === "anonymous") {
    return res.status(401).json(errBody(401, "Test case review requires an authenticated reviewer identity (FR-4.29)"));
  }

  try {
    const { row: result, diff, explanation } = applyTestCaseReview(req.params.id, action, {
      edited_fields,
      reviewer_notes,
      base_version,
      reviewer_user_id: req.user.id,
    });
    // FR-8.3/FR-4.29: general governance audit trail, attributed to the named human reviewer
    logAudit(req.user, `test_case_${action}`, "test_case", req.params.id, { diff, reviewer_notes });
    res.json({ ...parseRow(result), diff, explanation });
  } catch (err: any) {
    if (err instanceof TestCaseReviewError) {
      if (err.code === "NOT_FOUND") return res.status(404).json({ error: err.message });
      if (err.code === "CONFLICT") {
        // SR-FR-9.1: common_ancestor is a best-effort reconstructed snapshot from the
        // existing audit trail (see deriveCommonAncestor) -- null if the trail doesn't
        // go back far enough (e.g. base_version predates the audit_log itself).
        return res.status(409).json(errBody(409, err.message, {
          conflict: true,
          current: parseRow(err.extra?.current),
          yourBaseVersion: err.extra?.yourBaseVersion,
          currentVersion: err.extra?.currentVersion,
          common_ancestor: err.extra?.commonAncestor ?? null,
        }));
      }
      if (err.code === "SECOND_REVIEWER_REQUIRED") {
        return res.status(403).json(errBody(403, err.message, { secondReviewerStatus: err.extra?.secondReviewerStatus }));
      }
      return res.status(400).json(errBody(400, err.message));
    }
    res.status(400).json(errBody(400, err.message));
  }
});

// FR-2.6: regenerate a test case from its source input, versioning the result with a diff
testCasesRouter.post("/:id/regenerate", async (req, res) => {
  try {
    const result = await regenerateTestCase(req.params.id);
    logAudit(req.user, "test_case_regenerated", "test_case", req.params.id, { diff: result.diff, version: result.version });
    res.json(result);
  } catch (err: any) {
    if (err?.queued) return res.status(503).json(errBody(503, err.message, { queued: true }));
    res.status(400).json(errBody(400, err.message));
  }
});

// FR-2.3: push this test case to Jira/Azure DevOps as a real linked work item.
// Previously this route fabricated a "synced" response with no outbound HTTP
// call at all -- it now makes a genuine authenticated request using the
// baseUrl/token supplied directly in the body (the ad-hoc credentials the
// AiStudio "Sync" UI collects), rather than requiring a saved Integration.
testCasesRouter.post("/:id/sync", async (req, res) => {
  const { provider, baseUrl, token } = req.body as { provider?: "jira" | "azure"; baseUrl?: string; token?: string };
  const row = db.prepare("SELECT * FROM test_cases WHERE id = ?").get(req.params.id) as any;
  if (!row) return res.status(404).json({ error: "not found" });
  if (!baseUrl || !token) {
    return res.status(400).json(errBody(400, "baseUrl and token are required to sync to a real Jira/Azure DevOps project"));
  }

  const resolvedProvider = provider === "azure" ? "azure" : "jira";
  const description = `${JSON.parse(row.steps).map((s: string, i: number) => `${i + 1}. ${s}`).join("\n")}\n\nExpected: ${row.expected_result}`;

  try {
    let externalId: string;
    let responsePayload: any;

    if (resolvedProvider === "jira") {
      const endpoint = `${baseUrl.replace(/\/$/, "")}/rest/api/2/issue`;
      const apiRes = await fetch(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ fields: { project: { key: "TEST" }, summary: `[${row.category}] ${row.title}`, description, issuetype: { name: "Test" } } }),
      });
      responsePayload = await apiRes.json().catch(() => ({}));
      if (!apiRes.ok) throw new Error(`Jira sync failed: ${apiRes.status} ${JSON.stringify(responsePayload)}`);
      externalId = responsePayload.key || responsePayload.id;
    } else {
      const endpoint = `${baseUrl.replace(/\/$/, "")}/_apis/wit/workitems/$Test%20Case?api-version=7.1`;
      const apiRes = await fetch(endpoint, {
        method: "POST",
        headers: { Authorization: `Basic ${Buffer.from(`:${token}`).toString("base64")}`, "Content-Type": "application/json-patch+json" },
        body: JSON.stringify([
          { op: "add", path: "/fields/System.Title", value: `[${row.category}] ${row.title}` },
          { op: "add", path: "/fields/System.Description", value: description },
        ]),
      });
      responsePayload = await apiRes.json().catch(() => ({}));
      if (!apiRes.ok) throw new Error(`Azure DevOps sync failed: ${apiRes.status} ${JSON.stringify(responsePayload)}`);
      externalId = responsePayload.id?.toString();
    }

    const record = createSyncRecord(req.params.id, resolvedProvider, "synced", { provider: resolvedProvider, externalId, testCaseId: row.id, title: row.title });
    logAudit(req.user, "test_case_synced", "test_case", row.id, { provider: resolvedProvider, externalId });
    res.json({ ok: true, sync: { provider: resolvedProvider, externalId, testCaseId: row.id, title: row.title, status: "synced", recordId: record.id }, history: listSyncRecords(req.params.id) });
  } catch (err: any) {
    res.status(502).json({ error: err.message });
  }
});

testCasesRouter.get("/:id/audit", (req, res) => {
  const row = db.prepare("SELECT * FROM test_cases WHERE id = ?").get(req.params.id) as any;
  if (!row) return res.status(404).json({ error: "not found" });
  res.json({ audit: listReviewAuditEntries(req.params.id), agreementRate: getReviewAgreementRate() });
});

testCasesRouter.get("/:id/export.csv", (req, res) => {
  const row = db.prepare("SELECT * FROM test_cases WHERE id = ?").get(req.params.id) as any;
  if (!row) return res.status(404).json({ error: "not found" });
  const csv = exportTestCasesToCsv([parseRow(row)]);
  res.type("text/csv").send(csv);
});

testCasesRouter.get("/:id/export.xlsx", async (req, res) => {
  try {
    const row = db.prepare("SELECT * FROM test_cases WHERE id = ?").get(req.params.id) as any;
    if (!row) return res.status(404).json({ error: "not found" });
    const exportPath = await exportTestCasesToXlsx([parseRow(row)], `${req.params.id}.xlsx`);
    res.download(exportPath);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

testCasesRouter.get("/:id/export.pdf", async (req, res) => {
  try {
    const row = db.prepare("SELECT * FROM test_cases WHERE id = ?").get(req.params.id) as any;
    if (!row) return res.status(404).json({ error: "not found" });
    const buffer = await exportTestCasesToPdf([parseRow(row)]);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${req.params.id}.pdf"`);
    res.send(buffer);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

testCasesRouter.get("/:id/export.docx", async (req, res) => {
  try {
    const row = db.prepare("SELECT * FROM test_cases WHERE id = ?").get(req.params.id) as any;
    if (!row) return res.status(404).json({ error: "not found" });
    const buffer = await exportTestCasesToDocx([parseRow(row)]);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", `attachment; filename="${req.params.id}.docx"`);
    res.send(buffer);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Bulk/multi-select export -- "all selected" or "some selected" test cases in
// one file, in any of the four formats. Powers the AI Studio multi-select
// export action (single-item export above stays for the per-test-case button).
testCasesRouter.post("/export", async (req, res) => {
  const { ids, format } = req.body as { ids?: string[]; format?: "csv" | "xlsx" | "pdf" | "docx" };
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json(errBody(400, "ids (non-empty array) is required"));
  }
  if (!format || !["csv", "xlsx", "pdf", "docx"].includes(format)) {
    return res.status(400).json(errBody(400, "format must be one of csv, xlsx, pdf, docx"));
  }
  try {
    const rows = ids
      .map((id) => db.prepare("SELECT * FROM test_cases WHERE id = ?").get(id) as any)
      .filter(Boolean)
      .map(parseRow);
    if (rows.length === 0) return res.status(404).json(errBody(404, "none of the given ids were found"));

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    if (format === "csv") {
      res.type("text/csv").setHeader("Content-Disposition", `attachment; filename="test-cases-${stamp}.csv"`);
      return res.send(exportTestCasesToCsv(rows));
    }
    if (format === "xlsx") {
      const exportPath = await exportTestCasesToXlsx(rows, `test-cases-${stamp}.xlsx`);
      return res.download(exportPath);
    }
    if (format === "pdf") {
      const buffer = await exportTestCasesToPdf(rows);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="test-cases-${stamp}.pdf"`);
      return res.send(buffer);
    }
    const buffer = await exportTestCasesToDocx(rows);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", `attachment; filename="test-cases-${stamp}.docx"`);
    res.send(buffer);
  } catch (err: any) {
    res.status(500).json(errBody(500, err.message));
  }
});

testCasesRouter.get("/meta/agreement-rate", (req, res) => {
  // FR-9.6: optional ?byCompression=true breaks the FR-2.13 agreement rate down by
  // whether the reviewed test case's generation prompt had compression applied.
  if (req.query.byCompression === "true") {
    return res.json(getReviewAgreementRateByCompression());
  }
  res.json({ agreementRate: getReviewAgreementRate() });
});

// FR-2.18: search/filter the test case library by keyword/screen/priority/category/authorship
testCasesRouter.get("/meta/search", (req, res) => {
  const { keyword, screenId, priority, category, authorshipType } = req.query as Record<string, string>;
  res.json(searchTestCases({ keyword, screenId, priority, category, authorshipType }).map(parseRow));
});

// FR-2.15: bulk actions across a multi-selected set of test cases
testCasesRouter.post("/bulk", (req, res) => {
  const { ids, action, screenId, priority } = req.body as { ids?: string[]; action?: string; screenId?: string; priority?: string };
  if (!Array.isArray(ids) || ids.length === 0 || !action) {
    return res.status(400).json(errBody(400, "ids (non-empty array) and action are required"));
  }
  try {
    // SR-FR-2.7: applyBulkAction already returns real per-item success/failure
    // (not an all-or-nothing result) -- reshape it into the {succeeded, failed}
    // form here so callers can branch on it without knowing the internal `ok`
    // flag shape. "delete" has real cascading side effects (scripts, runs, files
    // on disk) that a plain UPDATE-based bulk action doesn't, so it's dispatched
    // to deleteTestCases() instead -- applyBulkAction never sees "delete".
    const results = action === "delete" ? deleteTestCases(ids, req.user) : applyBulkAction(ids, action as any, { screenId, priority });
    const succeeded = results.filter((r) => r.ok).map((r) => r.id);
    const failed = results.filter((r) => !r.ok).map((r) => ({ id: r.id, reason: r.error }));
    if (action !== "delete") {
      logAudit(req.user, "test_cases_bulk_action", "test_case", null, { ids, action, count: ids.length, succeededCount: succeeded.length, failedCount: failed.length });
    }
    res.json({ results, succeeded, failed });
  } catch (err: any) {
    res.status(400).json(errBody(400, err.message));
  }
});

// Single test-case delete -- same cascading cleanup as the bulk "delete" action above.
testCasesRouter.delete("/:id", (req, res) => {
  try {
    const results = deleteTestCases([req.params.id], req.user);
    const result = results[0];
    if (!result.ok) return res.status(404).json(errBody(404, result.error || "not found"));
    res.json({ deleted: true, id: req.params.id });
  } catch (err: any) {
    res.status(400).json(errBody(400, err.message));
  }
});

// FR-2.16: run/list duplicate detection for a screen; resolve a flagged pair
testCasesRouter.post("/meta/detect-duplicates/:screenId", (req, res) => {
  res.json(detectDuplicateTestCases(req.params.screenId));
});

testCasesRouter.get("/meta/duplicates", (_req, res) => {
  res.json(listDuplicateFlags());
});

testCasesRouter.post("/meta/duplicates/:flagId/resolve", (req, res) => {
  const { resolution } = req.body as { resolution?: "merged" | "discarded" | "kept-both" };
  if (!resolution) return res.status(400).json({ error: "resolution is required" });
  try {
    res.json(resolveDuplicateFlag(req.params.flagId, resolution));
  } catch (err: any) {
    res.status(404).json({ error: err.message });
  }
});

// FR-2.17: data-driven/parameterized test cases -- add/list data rows, record per-row result
testCasesRouter.post("/:id/data-rows", (req, res) => {
  const { input_values } = req.body as { input_values?: Record<string, any> };
  if (!input_values || typeof input_values !== "object") return res.status(400).json(errBody(400, "input_values (object) is required"));
  res.status(201).json(addTestCaseDataRow(req.params.id, input_values));
});

testCasesRouter.get("/:id/data-rows", (req, res) => {
  res.json(listTestCaseDataRows(req.params.id));
});

testCasesRouter.patch("/data-rows/:rowId/result", (req, res) => {
  const { status } = req.body as { status?: "passed" | "failed" };
  if (status !== "passed" && status !== "failed") return res.status(400).json(errBody(400, "status must be 'passed' or 'failed'"));
  recordDataRowResult(req.params.rowId, status);
  res.json({ ok: true });
});

// FR-2.17 (automated execution): actually run the latest script once per data
// row and record each row's pass/fail automatically, instead of requiring a
// manual PATCH per row.
testCasesRouter.post("/:id/data-rows/run-all", async (req, res) => {
  const { targetUrl } = req.body as { targetUrl?: string };
  if (!targetUrl) return res.status(400).json(errBody(400, "targetUrl is required"));
  try {
    const outcome = await runAllTestCaseDataRows(req.params.id, targetUrl, runExecution);
    logAudit(req.user, "test_case_data_rows_run_all", "test_case", req.params.id, { rowCount: outcome.results.length });
    res.json(outcome);
  } catch (err: any) {
    res.status(400).json(errBody(400, err.message));
  }
});
