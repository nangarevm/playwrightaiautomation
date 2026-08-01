import { Router } from "express";
import { nanoid } from "nanoid";
import { db } from "../db.js";
import { logAudit } from "../services/adminService.js";
import { regenerateTestCase } from "../services/generationService.js";
import {
  buildDiffSummary,
  buildExplanation,
  createReviewAuditEntry,
  createSyncRecord,
  exportTestCasesToCsv,
  exportTestCasesToXlsx,
  getReviewAgreementRate,
  listReviewAuditEntries,
  listSyncRecords,
} from "../services/testCaseFeatures.js";

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
    return res.status(400).json({ error: "input_id, title, category, steps (non-empty array), and expected_result are required" });
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

testCasesRouter.get("/:id", (req, res) => {
  const row = db.prepare("SELECT * FROM test_cases WHERE id = ?").get(req.params.id) as any;
  if (!row) return res.status(404).json({ error: "not found" });
  res.json(parseRow(row));
});

// FR-2.4 / FR-2.8: accept / edit / reject / needs_discussion, with optional inline edits
testCasesRouter.patch("/:id/review", (req, res) => {
  const { action, edited_fields, reviewer_notes, base_version } = req.body as {
    action: "accept" | "edit" | "reject" | "needs_discussion";
    edited_fields?: Partial<{ title: string; steps: string[]; expected_result: string; category: string; priority: string }>;
    reviewer_notes?: string;
    base_version?: number;
  };

  const row = db.prepare("SELECT * FROM test_cases WHERE id = ?").get(req.params.id) as any;
  if (!row) return res.status(404).json({ error: "not found" });

  // FR-9.1: detect concurrent edits instead of silently overwriting. The client sends the
  // version it started editing from; if the stored row has since moved on, surface a
  // merge/conflict view rather than applying the write.
  if (typeof base_version === "number" && base_version !== row.version) {
    return res.status(409).json({
      error: "conflict: this test case was modified by someone else since you loaded it",
      conflict: true,
      current: parseRow(row),
      yourBaseVersion: base_version,
      currentVersion: row.version,
    });
  }

  const statusMap: Record<string, string> = {
    accept: "accepted",
    edit: "edited",
    reject: "rejected",
    needs_discussion: "needs_discussion",
  };
  const newStatus = statusMap[action];
  if (!newStatus) return res.status(400).json({ error: "invalid action" });

  // FR-8.6: critical-path test cases need a second reviewer's sign-off before they can join the active suite
  if (action === "accept" && row.second_reviewer_required && row.second_reviewer_status !== "approved") {
    return res.status(403).json({
      error: "This test case covers a critical path and requires second-reviewer sign-off before it can be accepted (FR-8.6)",
      secondReviewerStatus: row.second_reviewer_status,
    });
  }

  const now = new Date().toISOString();
  const fields = edited_fields ?? {};
  const previousSteps = JSON.parse(row.steps);
  const updated = {
    title: fields.title ?? row.title,
    category: fields.category ?? row.category,
    steps: JSON.stringify(fields.steps ?? previousSteps),
    expected_result: fields.expected_result ?? row.expected_result,
    priority: fields.priority ?? row.priority ?? "Medium",
    status: newStatus,
    authorship_type: action === "edit" ? "edited" : row.authorship_type,
    version: action === "edit" ? row.version + 1 : row.version,
    reviewer_notes: reviewer_notes ?? row.reviewer_notes,
    explanation: row.explanation ?? buildExplanation({
      title: fields.title ?? row.title,
      category: fields.category ?? row.category,
      steps: fields.steps ?? previousSteps,
      expected_result: fields.expected_result ?? row.expected_result,
    }),
    updated_at: now,
    id: req.params.id,
  };

  const before = {
    title: row.title,
    category: row.category,
    steps: previousSteps,
    expected_result: row.expected_result,
    priority: row.priority ?? "Medium",
  };
  const after = {
    title: updated.title,
    category: updated.category,
    steps: JSON.parse(updated.steps),
    expected_result: updated.expected_result,
    priority: updated.priority,
  };

  const diff = buildDiffSummary(before, after);

  db.prepare(`
    UPDATE test_cases SET title=@title, category=@category, steps=@steps, expected_result=@expected_result,
      status=@status, authorship_type=@authorship_type, version=@version, reviewer_notes=@reviewer_notes,
      priority=@priority, explanation=@explanation, updated_at=@updated_at, flagged_for_re_review=0
    WHERE id = @id
  `).run(updated);

  createReviewAuditEntry(req.params.id, action, reviewer_notes);
  // FR-8.3: general governance audit trail (broader than the test-case-scoped entry above)
  logAudit(req.user, `test_case_${action}`, "test_case", req.params.id, { diff, reviewer_notes });

  const result = db.prepare("SELECT * FROM test_cases WHERE id = ?").get(req.params.id);
  res.json({ ...parseRow(result), diff, explanation: updated.explanation });
});

// FR-2.6: regenerate a test case from its source input, versioning the result with a diff
testCasesRouter.post("/:id/regenerate", async (req, res) => {
  try {
    const result = await regenerateTestCase(req.params.id);
    logAudit(req.user, "test_case_regenerated", "test_case", req.params.id, { diff: result.diff, version: result.version });
    res.json(result);
  } catch (err: any) {
    if (err?.queued) return res.status(503).json({ error: err.message, queued: true });
    res.status(400).json({ error: err.message });
  }
});

testCasesRouter.post("/:id/sync", (req, res) => {
  const { provider, baseUrl, token } = req.body as { provider?: string; baseUrl?: string; token?: string };
  const row = db.prepare("SELECT * FROM test_cases WHERE id = ?").get(req.params.id) as any;
  if (!row) return res.status(404).json({ error: "not found" });

  const payload = {
    provider: provider ?? "jira",
    baseUrl: baseUrl ?? "",
    token: token ? "[redacted]" : "",
    testCaseId: row.id,
    title: row.title,
    status: "synced",
    externalId: `${provider ?? "jira"}:${row.id}`,
  };

  const record = createSyncRecord(req.params.id, payload.provider, payload.status, payload);
  res.json({ ok: true, sync: { ...payload, recordId: record.id }, history: listSyncRecords(req.params.id) });
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
  const row = db.prepare("SELECT * FROM test_cases WHERE id = ?").get(req.params.id) as any;
  if (!row) return res.status(404).json({ error: "not found" });
  const exportPath = await exportTestCasesToXlsx([parseRow(row)], `${req.params.id}.xlsx`);
  res.download(exportPath);
});

testCasesRouter.get("/meta/agreement-rate", (_req, res) => {
  res.json({ agreementRate: getReviewAgreementRate() });
});
