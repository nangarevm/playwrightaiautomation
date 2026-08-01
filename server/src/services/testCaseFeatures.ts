import { nanoid } from "nanoid";
import { writeFile, readFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { utils, write } from "xlsx";
import { db } from "../db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXPORT_ROOT = path.join(__dirname, "..", "..", "generated", "exports");

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

export function createReviewAuditEntry(testCaseId: string, action: string, reviewerNotes?: string) {
  const id = nanoid(10);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO review_audit_entries (id, test_case_id, action, reviewer_notes, created_at)
    VALUES (@id, @test_case_id, @action, @reviewer_notes, @created_at)
  `).run({ id, test_case_id: testCaseId, action, reviewer_notes: reviewerNotes ?? "", created_at: now });
  return { id, created_at: now };
}

export function listReviewAuditEntries(testCaseId: string) {
  return db.prepare(`SELECT * FROM review_audit_entries WHERE test_case_id = ? ORDER BY created_at DESC`).all(testCaseId);
}

export function getReviewAgreementRate() {
  const rows = db.prepare(`SELECT status FROM test_cases WHERE status IN ('accepted','edited','rejected','needs_discussion')`).all() as Array<{ status: string }>;
  const total = rows.length;
  const acceptedWithoutEdits = rows.filter((row) => row.status === "accepted").length;
  return total === 0 ? 0 : Math.round((acceptedWithoutEdits / total) * 100);
}

export function exportTestCasesToCsv(rows: Array<Record<string, any>>) {
  const headers = ["id", "title", "category", "status", "version", "confidence_score", "priority", "reviewer_notes"];
  const csvLines = [headers.join(",")];
  for (const row of rows) {
    csvLines.push(headers.map((header) => JSON.stringify(row[header] ?? "")).join(","));
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
    reviewer_notes: row.reviewer_notes ?? "",
    source_rationale: row.source_rationale ?? "",
    expected_result: row.expected_result ?? "",
  })));
  utils.book_append_sheet(workbook, sheet, "test-cases");
  const exportPath = path.join(EXPORT_ROOT, fileName);
  await writeFile(exportPath, write(workbook, { type: "buffer", bookType: "xlsx" }));
  return exportPath;
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
