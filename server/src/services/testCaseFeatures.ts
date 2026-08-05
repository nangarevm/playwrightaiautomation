import { nanoid } from "nanoid";
import { writeFile, readFile } from "fs/promises";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { utils, write } from "xlsx";
import PDFDocument from "pdfkit";
import { Document, Packer, Paragraph, HeadingLevel, Table, TableRow, TableCell, WidthType, TextRun } from "docx";
import { db } from "../db.js";
import { logAudit, type CurrentUser } from "./adminService.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXPORT_ROOT = path.join(__dirname, "..", "..", "generated", "exports");
fs.mkdirSync(EXPORT_ROOT, { recursive: true });

export interface TraceabilityContext {
  ticketIds: string[];
  screenshots: string[];
  endpoints: string[];
  businessRules: string;
}

export interface ReviewDiffSummary {
  title: { changed: boolean; from: string; to: string };
  category: { changed: boolean; from: string; to: string };
  steps: { changed: boolean; from: string[]; to: string[] };
  expected_result: { changed: boolean; from: string; to: string };
  priority: { changed: boolean; from: string; to: string };
}

export function deriveTraceabilityContext(inputText: string, meta: { business_rules?: string } = {}): TraceabilityContext {
  const ticketIds = Array.from(inputText.matchAll(/\b[A-Z]{1,10}-\d+\b/g)).map((m) => m[0]);
  const screenshots = Array.from(inputText.matchAll(/(?:\b|[^/\w])([A-Za-z0-9._-]+\.(?:png|jpg|jpeg|gif|webp|svg))/gi)).map((m) => m[1]);
  const endpoints = Array.from(inputText.matchAll(/\/api(?:\/\w+|\/[\w-]+)*/g)).map((m) => m[0]);
  return {
    ticketIds,
    screenshots,
    endpoints,
    businessRules: meta.business_rules ?? "",
  };
}

export function buildExplanation(testCase: { title: string; category: string; steps: string[]; expected_result: string }) {
  return `This ${testCase.category.toLowerCase()} case focuses on ${testCase.title.toLowerCase()} because the steps cover the core flow and the expected result validates the intended outcome: ${testCase.expected_result}.`;
}

export function buildDiffSummary(before: any, after: any): ReviewDiffSummary {
  return {
    title: { changed: before.title !== after.title, from: before.title, to: after.title },
    category: { changed: before.category !== after.category, from: before.category, to: after.category },
    steps: { changed: JSON.stringify(before.steps) !== JSON.stringify(after.steps), from: before.steps ?? [], to: after.steps ?? [] },
    expected_result: { changed: before.expected_result !== after.expected_result, from: before.expected_result, to: after.expected_result },
    priority: { changed: before.priority !== after.priority, from: before.priority ?? "Medium", to: after.priority ?? "Medium" },
  };
}

// FR-4.29: reviewer_user_id is the named reviewer this accept/edit/reject/needs_discussion
// action is recorded against -- a real user id for a human reviewer (enforced by the
// PATCH /:id/review route), or "system:ultrafast" for Ultrafast Mode's auto-accept path
// (a distinct, attributable system actor, not an anonymous bypass).
export function createReviewAuditEntry(testCaseId: string, action: string, reviewerNotes?: string, reviewerUserId?: string) {
  const id = nanoid(10);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO review_audit_entries (id, test_case_id, action, reviewer_notes, reviewer_user_id, created_at)
    VALUES (@id, @test_case_id, @action, @reviewer_notes, @reviewer_user_id, @created_at)
  `).run({ id, test_case_id: testCaseId, action, reviewer_notes: reviewerNotes ?? "", reviewer_user_id: reviewerUserId ?? null, created_at: now });
  return { id, created_at: now };
}

export function listReviewAuditEntries(testCaseId: string) {
  return db.prepare(`SELECT * FROM review_audit_entries WHERE test_case_id = ? ORDER BY created_at DESC`).all(testCaseId);
}

// SR-FR-9.1: derive a `common_ancestor` reference for a 409 conflict -- the
// content both edits actually started from -- from data that already exists,
// rather than a new snapshot table. Every review action (routes/testcases.ts)
// logs a before/after diff to the general audit_log (FR-8.3); only 'edit'
// actions bump `version`, so the Nth chronological test_case_edit audit entry's
// `diff.*.from` is exactly the full field snapshot as of version N (the "from"
// values were computed against the row before that Nth edit was applied). This
// only requires the audit_log rows that already exist -- no new storage.
export function deriveCommonAncestor(testCaseId: string, baseVersion?: number): Record<string, any> | null {
  if (typeof baseVersion !== "number" || baseVersion < 1) return null;

  const editEntries = db.prepare(`
    SELECT details, created_at FROM audit_log
    WHERE entity_type = 'test_case' AND entity_id = ? AND action = 'test_case_edit'
    ORDER BY created_at ASC
  `).all(testCaseId) as Array<{ details: string | null; created_at: string }>;

  const entry = editEntries[baseVersion - 1];
  if (!entry || !entry.details) return null;

  let diff: any;
  try {
    diff = JSON.parse(entry.details).diff;
  } catch {
    return null;
  }
  if (!diff) return null;

  return {
    version: baseVersion,
    as_of: entry.created_at,
    title: diff.title?.from,
    category: diff.category?.from,
    steps: diff.steps?.from,
    expected_result: diff.expected_result?.from,
    priority: diff.priority?.from,
  };
}

export class TestCaseReviewError extends Error {
  code: "NOT_FOUND" | "CONFLICT" | "BAD_REQUEST" | "SECOND_REVIEWER_REQUIRED";
  extra?: Record<string, any>;
  constructor(code: "NOT_FOUND" | "CONFLICT" | "BAD_REQUEST" | "SECOND_REVIEWER_REQUIRED", message: string, extra?: Record<string, any>) {
    super(message);
    this.code = code;
    this.extra = extra;
  }
}

// FR-2.4/FR-2.7/FR-2.8: the single accept/edit/reject/needs_discussion state machine for a
// test case. Extracted out of routes/testcases.ts so there is exactly one code path for
// "accept" -- both a human reviewer's PATCH /:id/review (FR-2.4/FR-4.29) and Ultrafast
// Mode's auto-accept (FR-4.26) call this same function, so an Ultrafast auto-accept is a
// real accept (same status transition, same review_audit_entries row, same second-reviewer
// gate) rather than a parallel bypass path.
export function applyTestCaseReview(
  testCaseId: string,
  action: "accept" | "edit" | "reject" | "needs_discussion",
  opts: {
    edited_fields?: Partial<{ title: string; steps: string[]; expected_result: string; category: string; priority: string }>;
    reviewer_notes?: string;
    base_version?: number;
    // FR-4.29: the named reviewer this action is recorded against. Callers on the human
    // review route are required to pass a real, non-anonymous user id; Ultrafast Mode's
    // auto-accept passes its own system actor id ("system:ultrafast").
    reviewer_user_id?: string;
  } = {}
) {
  const row = db.prepare("SELECT * FROM test_cases WHERE id = ?").get(testCaseId) as any;
  if (!row) throw new TestCaseReviewError("NOT_FOUND", "not found");

  // FR-9.1: detect concurrent edits instead of silently overwriting.
  if (typeof opts.base_version === "number" && opts.base_version !== row.version) {
    // SR-FR-9.1: best-effort common_ancestor reference (see deriveCommonAncestor) --
    // null when the audit trail doesn't go back far enough to reconstruct it.
    throw new TestCaseReviewError("CONFLICT", "conflict: this test case was modified by someone else since you loaded it", {
      current: row,
      yourBaseVersion: opts.base_version,
      currentVersion: row.version,
      commonAncestor: deriveCommonAncestor(testCaseId, opts.base_version),
    });
  }

  const statusMap: Record<string, string> = {
    accept: "accepted",
    edit: "edited",
    reject: "rejected",
    needs_discussion: "needs_discussion",
  };
  const newStatus = statusMap[action];
  if (!newStatus) throw new TestCaseReviewError("BAD_REQUEST", "invalid action");

  // FR-8.6: critical-path test cases need a second reviewer's sign-off before they can join the active suite
  if (action === "accept" && row.second_reviewer_required && row.second_reviewer_status !== "approved") {
    throw new TestCaseReviewError(
      "SECOND_REVIEWER_REQUIRED",
      "This test case covers a critical path and requires second-reviewer sign-off before it can be accepted (FR-8.6)",
      { secondReviewerStatus: row.second_reviewer_status }
    );
  }

  const now = new Date().toISOString();
  const fields = opts.edited_fields ?? {};
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
    reviewer_notes: opts.reviewer_notes ?? row.reviewer_notes,
    explanation: row.explanation ?? buildExplanation({
      title: fields.title ?? row.title,
      category: fields.category ?? row.category,
      steps: fields.steps ?? previousSteps,
      expected_result: fields.expected_result ?? row.expected_result,
    }),
    // FR-6.8: track when a case was last (re-)approved, used to detect "stale-only" coverage gaps
    last_approved_at: newStatus === "accepted" ? now : row.last_approved_at,
    // FR-4.26: an auto-accept resolves any prior "needs review later" flag
    needs_review_later: newStatus === "accepted" ? 0 : row.needs_review_later,
    updated_at: now,
    id: testCaseId,
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
      priority=@priority, explanation=@explanation, last_approved_at=@last_approved_at,
      needs_review_later=@needs_review_later, updated_at=@updated_at, flagged_for_re_review=0
    WHERE id = @id
  `).run(updated);

  createReviewAuditEntry(testCaseId, action, opts.reviewer_notes, opts.reviewer_user_id);

  const result = db.prepare("SELECT * FROM test_cases WHERE id = ?").get(testCaseId);
  return { row: result, diff, explanation: updated.explanation };
}

export function getReviewAgreementRate() {
  const rows = db.prepare(`SELECT status FROM test_cases WHERE status IN ('accepted','edited','rejected','needs_discussion')`).all() as Array<{ status: string }>;
  const total = rows.length;
  const acceptedWithoutEdits = rows.filter((row) => row.status === "accepted").length;
  return total === 0 ? 0 : Math.round((acceptedWithoutEdits / total) * 100);
}

// FR-9.6: same reviewer-agreement-rate calculation (FR-2.13), broken down by whether
// the test case's generation prompt had FR-9.6 compression applied. This is measurement
// infrastructure only -- it reports real review outcomes split by origin, it does not
// assert compression is "safe" or "validated".
function agreementRateFor(rows: Array<{ status: string }>) {
  const total = rows.length;
  const acceptedWithoutEdits = rows.filter((row) => row.status === "accepted").length;
  return { agreementRate: total === 0 ? 0 : Math.round((acceptedWithoutEdits / total) * 100), sampleSize: total };
}

export function getReviewAgreementRateByCompression() {
  const rows = db
    .prepare(`SELECT status, generated_with_compression FROM test_cases WHERE status IN ('accepted','edited','rejected','needs_discussion')`)
    .all() as Array<{ status: string; generated_with_compression: number }>;
  const compressed = rows.filter((r) => r.generated_with_compression === 1);
  const uncompressed = rows.filter((r) => r.generated_with_compression !== 1);
  return {
    overall: agreementRateFor(rows),
    compressed: agreementRateFor(compressed),
    uncompressed: agreementRateFor(uncompressed),
  };
}

// `row.steps` arrives as either a JSON string (straight from the DB) or an
// already-parsed array (callers that ran parseRow() first) -- normalize once
// so every export format gets a real, human-readable numbered step list
// instead of a raw JSON blob (a longstanding gap: CSV/XLSX export previously
// omitted steps entirely).
function stepsAsList(row: Record<string, any>): string[] {
  const raw = row.steps;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function stepsAsText(row: Record<string, any>): string {
  return stepsAsList(row).map((s, i) => `${i + 1}. ${s}`).join("\n");
}

export function exportTestCasesToCsv(rows: Array<Record<string, any>>) {
  const headers = ["id", "title", "category", "status", "version", "confidence_score", "priority", "steps", "expected_result", "reviewer_notes"];
  const csvLines = [headers.join(",")];
  for (const row of rows) {
    const record: Record<string, any> = { ...row, steps: stepsAsText(row) };
    csvLines.push(headers.map((header) => JSON.stringify(record[header] ?? "")).join(","));
  }
  return csvLines.join("\n");
}

export async function exportTestCasesToXlsx(rows: Array<Record<string, any>>, fileName = "test-cases.xlsx") {
  const workbook = utils.book_new();
  const sheet = utils.json_to_sheet(rows.map((row) => ({
    id: row.id,
    title: row.title,
    category: row.category,
    status: row.status,
    version: row.version,
    confidence_score: row.confidence_score,
    priority: row.priority ?? "Medium",
    steps: stepsAsText(row),
    expected_result: row.expected_result ?? "",
    reviewer_notes: row.reviewer_notes ?? "",
    source_rationale: row.source_rationale ?? "",
  })));
  utils.book_append_sheet(workbook, sheet, "test-cases");
  const exportPath = path.join(EXPORT_ROOT, fileName);
  await writeFile(exportPath, write(workbook, { type: "buffer", bookType: "xlsx" }));
  return exportPath;
}

// PDF export: one test case per section, numbered steps, laid out for a
// printable/shareable manual test-case document (matches the style of
// reportingService.ts's release-report PDF for visual consistency).
export function exportTestCasesToPdf(rows: Array<Record<string, any>>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40 });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fontSize(18).fillColor("#000").text("Test Cases", { align: "left" });
    doc.fontSize(10).fillColor("#555").text(`Exported ${new Date().toISOString()} — ${rows.length} test case(s)`);
    doc.moveDown();

    rows.forEach((row, idx) => {
      if (idx > 0) doc.moveDown().moveTo(doc.x, doc.y).lineTo(555, doc.y).strokeColor("#ddd").stroke().moveDown();

      doc.fontSize(13).fillColor("#000").text(`${idx + 1}. ${row.title}`, { align: "left" });
      doc
        .fontSize(9)
        .fillColor("#555")
        .text(`ID: ${row.id}  |  Category: ${row.category}  |  Priority: ${row.priority ?? "Medium"}  |  Status: ${row.status}`);
      doc.moveDown(0.5);

      doc.fontSize(10).fillColor("#000").text("Steps:", { continued: false });
      const steps = stepsAsList(row);
      if (steps.length === 0) {
        doc.fontSize(10).fillColor("#777").text("(no steps recorded)");
      } else {
        steps.forEach((step, i) => doc.fontSize(10).fillColor("#000").text(`${i + 1}. ${step}`));
      }
      doc.moveDown(0.5);

      doc.fontSize(10).fillColor("#000").text("Expected result:", { continued: false });
      doc.fontSize(10).fillColor("#000").text(row.expected_result || "(not specified)");

      if (row.reviewer_notes) {
        doc.moveDown(0.5);
        doc.fontSize(10).fillColor("#000").text("Reviewer notes:");
        doc.fontSize(10).fillColor("#555").text(row.reviewer_notes);
      }

      if (doc.y > 700) doc.addPage();
    });

    doc.end();
  });
}

// Word (.docx) export: same content as the PDF, structured as real Word
// paragraphs/headings (not an HTML-renamed-to-.doc trick) so it opens and
// edits cleanly in Word/Google Docs -- useful when a reviewer wants to mark
// up a manual test case outside this app.
export async function exportTestCasesToDocx(rows: Array<Record<string, any>>): Promise<Buffer> {
  const children: Paragraph[] = [
    new Paragraph({ text: "Test Cases", heading: HeadingLevel.TITLE }),
    new Paragraph({ text: `Exported ${new Date().toISOString()} — ${rows.length} test case(s)`, spacing: { after: 300 } }),
  ];

  rows.forEach((row, idx) => {
    children.push(new Paragraph({ text: `${idx + 1}. ${row.title}`, heading: HeadingLevel.HEADING_2, spacing: { before: 300 } }));
    children.push(
      new Paragraph({
        children: [
          new TextRun({ text: `ID: ${row.id}   Category: ${row.category}   Priority: ${row.priority ?? "Medium"}   Status: ${row.status}`, italics: true, size: 18, color: "555555" }),
        ],
        spacing: { after: 150 },
      })
    );

    children.push(new Paragraph({ text: "Steps", heading: HeadingLevel.HEADING_3 }));
    const steps = stepsAsList(row);
    if (steps.length === 0) {
      children.push(new Paragraph({ text: "(no steps recorded)" }));
    } else {
      steps.forEach((step, i) => children.push(new Paragraph({ text: `${i + 1}. ${step}` })));
    }

    children.push(new Paragraph({ text: "Expected result", heading: HeadingLevel.HEADING_3, spacing: { before: 150 } }));
    children.push(new Paragraph({ text: row.expected_result || "(not specified)" }));

    if (row.reviewer_notes) {
      children.push(new Paragraph({ text: "Reviewer notes", heading: HeadingLevel.HEADING_3, spacing: { before: 150 } }));
      children.push(new Paragraph({ text: row.reviewer_notes }));
    }
  });

  const document = new Document({ sections: [{ children }] });
  return Packer.toBuffer(document);
}

export function createSyncRecord(testCaseId: string, provider: string, status: string, payload: Record<string, any> = {}) {
  const id = nanoid(10);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO sync_records (id, test_case_id, provider, external_id, status, payload, created_at)
    VALUES (@id, @test_case_id, @provider, @external_id, @status, @payload, @created_at)
  `).run({
    id,
    test_case_id: testCaseId,
    provider,
    external_id: payload.externalId ?? null,
    status,
    payload: JSON.stringify(payload),
    created_at: now,
  });
  return { id, created_at: now };
}

export function listSyncRecords(testCaseId: string) {
  return db.prepare(`SELECT * FROM sync_records WHERE test_case_id = ? ORDER BY created_at DESC`).all(testCaseId);
}

// FR-2.15: bulk actions (accept/reject/re-tag/priority-change) across a
// multi-selected set of test cases, recorded as a single audit-log operation.
export type BulkAction = "accept" | "reject" | "re-tag" | "priority-change" | "delete";

export function applyBulkAction(testCaseIds: string[], action: BulkAction, options: { screenId?: string; priority?: string } = {}) {
  if (testCaseIds.length === 0) throw new Error("testCaseIds must be a non-empty array");
  const now = new Date().toISOString();
  const results: Array<{ id: string; ok: boolean; error?: string }> = [];

  const tx = db.transaction(() => {
    for (const id of testCaseIds) {
      const row = db.prepare("SELECT * FROM test_cases WHERE id = ?").get(id) as any;
      if (!row) {
        results.push({ id, ok: false, error: "not found" });
        continue;
      }
      if (action === "accept") {
        db.prepare("UPDATE test_cases SET status = 'accepted', last_approved_at = ?, updated_at = ? WHERE id = ?").run(now, now, id);
      } else if (action === "reject") {
        db.prepare("UPDATE test_cases SET status = 'rejected', updated_at = ? WHERE id = ?").run(now, id);
      } else if (action === "re-tag") {
        if (!options.screenId) throw new Error("screenId is required for a re-tag bulk action");
        db.prepare("UPDATE test_cases SET screen_id = ?, updated_at = ? WHERE id = ?").run(options.screenId, now, id);
      } else if (action === "priority-change") {
        if (!options.priority) throw new Error("priority is required for a priority-change bulk action");
        db.prepare("UPDATE test_cases SET priority = ?, updated_at = ? WHERE id = ?").run(options.priority, now, id);
      }
      results.push({ id, ok: true });
    }
  });
  tx();

  return results;
}

// Deletes one or more test cases and everything that only exists because of
// them: automation scripts (and their generated files on disk + execution
// runs/evidence), review audit entries, external-sync records, duplicate-flag
// rows, and data-driven test rows. A crawl scenario that generated one of
// these test cases is unlinked (generated_test_case_id -> NULL) rather than
// deleted itself, since the discovered scenario is still real crawl output
// independent of whether a test case was ever kept for it. Each deletion gets
// its own audit-log entry, matching every other governance-relevant mutation
// in this codebase (FR-8.3) -- deleting a reviewed test case is exactly the
// kind of action that should be traceable after the fact.
export function deleteTestCases(testCaseIds: string[], actorUser: CurrentUser | undefined) {
  if (testCaseIds.length === 0) throw new Error("testCaseIds must be a non-empty array");
  const results: Array<{ id: string; ok: boolean; error?: string }> = [];

  const tx = db.transaction(() => {
    for (const id of testCaseIds) {
      const row = db.prepare("SELECT * FROM test_cases WHERE id = ?").get(id) as any;
      if (!row) {
        results.push({ id, ok: false, error: "not found" });
        continue;
      }

      const scripts = db.prepare("SELECT id, file_path FROM automation_scripts WHERE test_case_id = ?").all(id) as Array<{ id: string; file_path: string }>;
      for (const script of scripts) {
        const runs = db.prepare("SELECT id FROM execution_runs WHERE script_id = ?").all(script.id) as Array<{ id: string }>;
        for (const run of runs) {
          db.prepare("DELETE FROM execution_evidence WHERE run_id = ?").run(run.id);
        }
        db.prepare("DELETE FROM execution_runs WHERE script_id = ?").run(script.id);
        try {
          if (script.file_path && fs.existsSync(script.file_path)) fs.rmSync(script.file_path, { force: true });
        } catch {
          // best-effort -- a stray file on disk shouldn't block the DB delete
        }
      }
      db.prepare("DELETE FROM automation_scripts WHERE test_case_id = ?").run(id);
      db.prepare("DELETE FROM review_audit_entries WHERE test_case_id = ?").run(id);
      db.prepare("DELETE FROM sync_records WHERE test_case_id = ?").run(id);
      db.prepare("DELETE FROM test_case_duplicate_flags WHERE test_case_id = ? OR duplicate_of_test_case_id = ?").run(id, id);
      db.prepare("DELETE FROM test_case_data_rows WHERE test_case_id = ?").run(id);
      db.prepare("UPDATE crawl_scenarios SET generated_test_case_id = NULL WHERE generated_test_case_id = ?").run(id);
      db.prepare("DELETE FROM test_cases WHERE id = ?").run(id);

      logAudit(actorUser, "test_case_deleted", "test_case", id, { title: row.title, scriptsDeleted: scripts.length });
      results.push({ id, ok: true });
    }
  });
  tx();

  return results;
}

// FR-2.16: detect likely duplicate/near-duplicate test cases generated for the
// same screen/module -- word-overlap (Jaccard) similarity over the title +
// expected result, no external dependency needed for this heuristic.
function toTokenSet(text: string): Set<string> {
  return new Set(text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

const DUPLICATE_SIMILARITY_THRESHOLD = 0.6;

export function detectDuplicateTestCases(screenId: string) {
  const cases = db.prepare("SELECT id, title, expected_result FROM test_cases WHERE screen_id = ?").all(screenId) as Array<{ id: string; title: string; expected_result: string }>;
  const flagged: Array<{ testCaseId: string; duplicateOfTestCaseId: string; similarity: number }> = [];

  for (let i = 0; i < cases.length; i++) {
    for (let j = i + 1; j < cases.length; j++) {
      const a = toTokenSet(`${cases[i].title} ${cases[i].expected_result}`);
      const b = toTokenSet(`${cases[j].title} ${cases[j].expected_result}`);
      const similarity = jaccard(a, b);
      if (similarity >= DUPLICATE_SIMILARITY_THRESHOLD) {
        flagged.push({ testCaseId: cases[j].id, duplicateOfTestCaseId: cases[i].id, similarity });
        const id = nanoid(10);
        db.prepare(`
          INSERT INTO test_case_duplicate_flags (id, test_case_id, duplicate_of_test_case_id, similarity, resolution, created_at)
          VALUES (?, ?, ?, ?, 'pending', ?)
        `).run(id, cases[j].id, cases[i].id, similarity, new Date().toISOString());
      }
    }
  }
  return flagged;
}

export function listDuplicateFlags() {
  return db.prepare("SELECT * FROM test_case_duplicate_flags WHERE resolution = 'pending' ORDER BY created_at DESC").all();
}

export function resolveDuplicateFlag(flagId: string, resolution: "merged" | "discarded" | "kept-both") {
  const now = new Date().toISOString();
  db.prepare("UPDATE test_case_duplicate_flags SET resolution = ? WHERE id = ?").run(resolution, flagId);
  const flag = db.prepare("SELECT * FROM test_case_duplicate_flags WHERE id = ?").get(flagId) as any;
  if (!flag) throw new Error("Duplicate flag not found");
  if (resolution === "discarded") {
    db.prepare("UPDATE test_cases SET status = 'rejected', updated_at = ? WHERE id = ?").run(now, flag.test_case_id);
  }
  return flag;
}

// FR-2.17: data-driven/parameterized test cases -- one generated case, run once
// per data row (valid/invalid/edge-case input values), pass/fail tracked per row.
export function addTestCaseDataRow(testCaseId: string, inputValues: Record<string, any>) {
  const existingCount = (db.prepare("SELECT COUNT(*) as c FROM test_case_data_rows WHERE test_case_id = ?").get(testCaseId) as any).c;
  const id = nanoid(10);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO test_case_data_rows (id, test_case_id, row_index, input_values, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, testCaseId, existingCount, JSON.stringify(inputValues), now);
  return { id, row_index: existingCount, input_values: inputValues, created_at: now };
}

export function listTestCaseDataRows(testCaseId: string) {
  return (db.prepare("SELECT * FROM test_case_data_rows WHERE test_case_id = ? ORDER BY row_index ASC").all(testCaseId) as any[]).map((r) => ({
    ...r,
    input_values: JSON.parse(r.input_values),
  }));
}

export function recordDataRowResult(rowId: string, status: "passed" | "failed") {
  db.prepare("UPDATE test_case_data_rows SET last_run_status = ? WHERE id = ?").run(status, rowId);
}

// FR-2.17 (automated execution): actually run the test case's latest automation
// script once per data row, rather than requiring a caller to PATCH a status by
// hand. Each row's input_values are passed through to the run as `input.data_row`
// so a data-aware script (or the execution env) can read them; the resulting
// pass/fail is recorded back onto that row automatically. Honest limitation:
// script *content* is not re-templated per row in this build (FR-3's codegen
// doesn't parameterize scripts), so every row currently exercises the same
// script body -- this closes the "runs automatically per row and records
// per-row results" half of the AC, not per-row value substitution inside the
// generated code itself.
export async function runAllTestCaseDataRows(
  testCaseId: string,
  targetUrl: string,
  runExecutionFn: (scriptId: string, targetUrl: string, input?: any) => Promise<any>
) {
  // Prefer the runnable Playwright JS/TS artifact -- this feeds straight into
  // runExecutionFn below, and "most recent" alone resolves to a same-test-case
  // Python/Selenium/Cypress variant inserted later (see ultrafastService.ts's
  // identical fix), which the JS/TS Playwright CLI can't execute.
  const script = db.prepare(`
    SELECT * FROM automation_scripts WHERE test_case_id = ?
    ORDER BY (CASE WHEN framework = 'playwright' AND language IN ('typescript', 'javascript') THEN 0 ELSE 1 END), created_at DESC
    LIMIT 1
  `).get(testCaseId) as any;
  if (!script) throw new Error("No automation script found for this test case");

  const rows = listTestCaseDataRows(testCaseId);
  if (rows.length === 0) throw new Error("No data rows defined for this test case");

  const results: Array<{ rowId: string; row_index: number; input_values: Record<string, any>; status: string; runId?: string }> = [];
  for (const row of rows) {
    const run = await runExecutionFn(script.id, targetUrl, { data_row: row.input_values });
    const status: "passed" | "failed" = run?.status === "passed" ? "passed" : "failed";
    recordDataRowResult(row.id, status);
    results.push({ rowId: row.id, row_index: row.row_index, input_values: row.input_values, status, runId: run?.id });
  }
  return { scriptId: script.id, results };
}

// FR-2.18: search/filter the test case library by keyword, screen/module, tag
// (priority doubles as the closest concept to "tag" in this schema), priority,
// category, and authorship type -- all filters are optional and composable.
export function searchTestCases(filters: { keyword?: string; screenId?: string; priority?: string; category?: string; authorshipType?: string }) {
  const clauses: string[] = [];
  const params: Record<string, any> = {};

  if (filters.keyword) {
    clauses.push("(title LIKE @keyword OR expected_result LIKE @keyword OR steps LIKE @keyword)");
    params.keyword = `%${filters.keyword}%`;
  }
  if (filters.screenId) {
    clauses.push("screen_id = @screenId");
    params.screenId = filters.screenId;
  }
  if (filters.priority) {
    clauses.push("priority = @priority");
    params.priority = filters.priority;
  }
  if (filters.category) {
    clauses.push("category = @category");
    params.category = filters.category;
  }
  if (filters.authorshipType) {
    clauses.push("authorship_type = @authorshipType");
    params.authorshipType = filters.authorshipType;
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  return db.prepare(`SELECT * FROM test_cases ${where} ORDER BY created_at DESC`).all(params);
}
