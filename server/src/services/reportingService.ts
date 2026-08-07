import PDFDocument from "pdfkit";
import { utils, write } from "xlsx";
import { db } from "../db.js";

// FR-6.7: estimated wall-clock per selection mode (SRS section 12.1), used to compute
// actual-vs-estimated time and time saved. Midpoints of the documented ranges.
const ESTIMATED_MINUTES_BY_SELECTION_MODE: Record<string, number> = {
  "smart-selection": 3.5,
  "full-suite": 37.5,
  "custom-selection": 10, // "variable" in the SRS; use a conservative single-feature estimate
  "flaky-tests-only": 7.5,
  "scheduled-regression": 90,
};

// FR-6.6: assumed manual-QA minutes per test case, used for the hours-saved estimate.
const MANUAL_MINUTES_PER_TEST_CASE = 15;

export function estimatedDurationMsForSelectionMode(selectionMode: string): number | null {
  const minutes = ESTIMATED_MINUTES_BY_SELECTION_MODE[selectionMode];
  return typeof minutes === "number" ? Math.round(minutes * 60_000) : null;
}

// FR-6.7: actual-vs-estimated time breakdown, called right after a run completes so the
// comparison and time-saved figure are stored alongside the run rather than recomputed ad hoc.
export function recordTimeBreakdownForRun(runId: string, selectionMode: string, actualDurationMs: number) {
  const estimatedDurationMs = estimatedDurationMsForSelectionMode(selectionMode);
  const timeSavedMs = estimatedDurationMs != null ? Math.max(0, estimatedDurationMs - actualDurationMs) : null;
  db.prepare("UPDATE execution_runs SET estimated_duration_ms = ?, time_saved_ms = ? WHERE id = ?").run(
    estimatedDurationMs,
    timeSavedMs,
    runId
  );
  return { estimatedDurationMs, actualDurationMs, timeSavedMs };
}

// FR-6.1: date range for dashboard/hours-saved filtering. `startDate`/`endDate` are
// inclusive ISO date (YYYY-MM-DD) or full ISO-datetime strings; either/both may be
// omitted for an unbounded range on that side.
export interface DateRange {
  startDate?: string | null;
  endDate?: string | null;
}

function dateRangeClause(range?: DateRange): { clause: string; params: Record<string, string> } {
  const clauses: string[] = [];
  const params: Record<string, string> = {};
  if (range?.startDate) {
    clauses.push("created_at >= @startDate");
    params.startDate = range.startDate.length === 10 ? `${range.startDate}T00:00:00.000Z` : range.startDate;
  }
  if (range?.endDate) {
    clauses.push("created_at <= @endDate");
    params.endDate = range.endDate.length === 10 ? `${range.endDate}T23:59:59.999Z` : range.endDate;
  }
  return { clause: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

// FR-6.1: pass/fail dashboard with execution-time trend (grouped by day). Accepts an
// optional date range (startDate/endDate) so the dashboard can be scoped to a window
// (7d/30d/90d/all) instead of always showing the platform's entire run history.
export function getDashboardSummary(range?: DateRange) {
  const { clause, params } = dateRangeClause(range);
  const runs = db.prepare(`SELECT status, duration_ms, created_at FROM execution_runs ${clause} ORDER BY created_at ASC`).all(params) as Array<{
    status: string;
    duration_ms: number | null;
    created_at: string;
  }>;

  const totals = { passed: 0, failed: 0, error: 0, blocked: 0, queued: 0, running: 0 };
  for (const run of runs) {
    if (run.status in totals) (totals as any)[run.status] += 1;
  }

  const trendByDay = new Map<string, { day: string; runs: number; passed: number; failed: number; totalDurationMs: number }>();
  for (const run of runs) {
    const day = run.created_at.slice(0, 10);
    const bucket = trendByDay.get(day) ?? { day, runs: 0, passed: 0, failed: 0, totalDurationMs: 0 };
    bucket.runs += 1;
    if (run.status === "passed") bucket.passed += 1;
    if (run.status === "failed" || run.status === "error") bucket.failed += 1;
    bucket.totalDurationMs += run.duration_ms ?? 0;
    trendByDay.set(day, bucket);
  }

  const totalRuns = runs.length;
  const passRate = totalRuns === 0 ? 0 : Math.round((totals.passed / totalRuns) * 100);

  return {
    totalRuns,
    totals,
    passRate,
    executionTimeTrend: Array.from(trendByDay.values()).map((b) => ({
      ...b,
      avgDurationMs: b.runs === 0 ? 0 : Math.round(b.totalDurationMs / b.runs),
    })),
    range: { startDate: range?.startDate ?? null, endDate: range?.endDate ?? null },
  };
}

// FR-6.2: detect and flag flaky tests (mixed pass/fail outcomes across recent runs of the same script)
export function detectFlakyScripts(recentRunsPerScript = 10) {
  const scripts = db.prepare("SELECT id, test_case_id FROM automation_scripts").all() as Array<{ id: string; test_case_id: string }>;
  const results: Array<{ scriptId: string; testCaseId: string; isFlaky: boolean; passCount: number; failCount: number; totalConsidered: number }> = [];

  const recentRunsStmt = db.prepare(
    "SELECT status FROM execution_runs WHERE script_id = ? AND status IN ('passed','failed') ORDER BY created_at DESC LIMIT ?"
  );

  for (const script of scripts) {
    const runs = recentRunsStmt.all(script.id, recentRunsPerScript) as Array<{ status: string }>;
    const passCount = runs.filter((r) => r.status === "passed").length;
    const failCount = runs.filter((r) => r.status === "failed").length;
    const isFlaky = passCount > 0 && failCount > 0;

    db.prepare("UPDATE automation_scripts SET is_flaky = ? WHERE id = ?").run(isFlaky ? 1 : 0, script.id);

    results.push({ scriptId: script.id, testCaseId: script.test_case_id, isFlaky, passCount, failCount, totalConsidered: runs.length });
  }

  return results.filter((r) => r.totalConsidered > 0);
}

export function updateFlakyFlagForScript(scriptId: string, recentRunsPerScript = 10) {
  const runs = db
    .prepare("SELECT status FROM execution_runs WHERE script_id = ? AND status IN ('passed','failed') ORDER BY created_at DESC LIMIT ?")
    .all(scriptId, recentRunsPerScript) as Array<{ status: string }>;
  const passCount = runs.filter((r) => r.status === "passed").length;
  const failCount = runs.filter((r) => r.status === "failed").length;
  const isFlaky = passCount > 0 && failCount > 0;
  db.prepare("UPDATE automation_scripts SET is_flaky = ? WHERE id = ?").run(isFlaky ? 1 : 0, scriptId);
  return isFlaky;
}

// Tag-based reporting: group test results by module/tag
export function getTagBasedCoverage(range?: DateRange) {
  const { clause, params } = dateRangeClause(range);
  
  // Get all screens with their modules
  const screens = db.prepare("SELECT id, module_name, url_or_path FROM screens WHERE module_name IS NOT NULL").all() as Array<{
    id: string;
    module_name: string;
    url_or_path: string | null;
  }>;

  const tagMap = new Map<string, { 
    tag: string;
    testCaseCount: number;
    acceptedCount: number;
    passCount: number;
    failCount: number;
    coverage: string;
  }>();

  // Get test cases by screen/tag
  for (const screen of screens) {
    const testCases = db.prepare(
      "SELECT id, status FROM test_cases WHERE screen_id = ?"
    ).all(screen.id) as Array<{ id: string; status: string }>;

    const acceptedCases = testCases.filter((t) => t.status === "accepted" || t.status === "edited");
    
    // Get pass/fail count for cases tagged to this screen
    let passCount = 0,
      failCount = 0;
    for (const tc of acceptedCases) {
      const runStats = db.prepare(
        `SELECT COUNT(CASE WHEN status = 'passed' THEN 1 END) as passed,
                COUNT(CASE WHEN status IN ('failed', 'error') THEN 1 END) as failed
         FROM execution_runs WHERE test_case_id = ? ${clause ? `AND ${clause.replace("created_at", "execution_runs.created_at")}` : ""}`
      ).get(tc.id, ...Object.values(params)) as any;
      passCount += runStats?.passed ?? 0;
      failCount += runStats?.failed ?? 0;
    }

    const coverage = testCases.length === 0 ? "0%" : `${Math.round((acceptedCases.length / testCases.length) * 100)}%`;
    
    tagMap.set(screen.module_name, {
      tag: screen.module_name,
      testCaseCount: testCases.length,
      acceptedCount: acceptedCases.length,
      passCount,
      failCount,
      coverage,
    });
  }

  return Array.from(tagMap.values()).sort((a, b) => b.testCaseCount - a.testCaseCount);
}

// FR-6.3: requirement coverage mapped to user stories (ticket IDs found in traceability_context)
export function getRequirementCoverage() {
  const rows = db.prepare("SELECT id, title, status, traceability_context FROM test_cases").all() as Array<{
    id: string;
    title: string;
    status: string;
    traceability_context: string | null;
  }>;

  const ticketMap = new Map<string, { ticketId: string; testCaseIds: string[]; coveredByAccepted: boolean }>();

  for (const row of rows) {
    if (!row.traceability_context) continue;
    let context: { ticketIds?: string[] };
    try {
      context = JSON.parse(row.traceability_context);
    } catch {
      continue;
    }
    for (const ticketId of context.ticketIds ?? []) {
      const entry = ticketMap.get(ticketId) ?? { ticketId, testCaseIds: [], coveredByAccepted: false };
      entry.testCaseIds.push(row.id);
      if (row.status === "accepted" || row.status === "edited") entry.coveredByAccepted = true;
      ticketMap.set(ticketId, entry);
    }
  }

  const tickets = Array.from(ticketMap.values());
  const coveredCount = tickets.filter((t) => t.coveredByAccepted).length;

  return {
    totalTicketsReferenced: tickets.length,
    coveredByApprovedTestCase: coveredCount,
    coveragePercent: tickets.length === 0 ? 0 : Math.round((coveredCount / tickets.length) * 100),
    tickets,
  };
}

// FR-6.6: hours-saved estimate, comparing AI-assisted testing time to estimated manual QA
// effort. Accepts an optional date range so this can be computed "per period" -- a pragmatic
// proxy for a per-sprint breakdown reusing the FR-6.1 date-range plumbing, honestly not a
// first-class Sprint entity (this codebase has no Sprint concept to bind to). When a range is
// given, both the run-time total AND the test-case count are scoped to that window (test
// cases counted by created_at falling in range) so the comparison is apples-to-apples.
export function getHoursSavedEstimate(range?: DateRange) {
  const { clause: runClause, params: runParams } = dateRangeClause(range);
  const testCaseClauseParts = ["status IN ('accepted','edited')"];
  const tcParams: Record<string, string> = {};
  if (range?.startDate) {
    testCaseClauseParts.push("created_at >= @startDate");
    tcParams.startDate = range.startDate.length === 10 ? `${range.startDate}T00:00:00.000Z` : range.startDate;
  }
  if (range?.endDate) {
    testCaseClauseParts.push("created_at <= @endDate");
    tcParams.endDate = range.endDate.length === 10 ? `${range.endDate}T23:59:59.999Z` : range.endDate;
  }

  const testCaseCount = (
    db.prepare(`SELECT COUNT(*) as count FROM test_cases WHERE ${testCaseClauseParts.join(" AND ")}`).get(tcParams) as any
  ).count as number;
  const runs = db
    .prepare(`SELECT duration_ms FROM execution_runs ${runClause ? `${runClause} AND status IN ('passed','failed')` : "WHERE status IN ('passed','failed')"}`)
    .all(runParams) as Array<{ duration_ms: number | null }>;
  const totalAutomatedMs = runs.reduce((sum, r) => sum + (r.duration_ms ?? 0), 0);

  const estimatedManualMs = testCaseCount * MANUAL_MINUTES_PER_TEST_CASE * 60_000;
  const hoursSaved = Math.max(0, (estimatedManualMs - totalAutomatedMs) / 3_600_000);

  return {
    testCaseCount,
    estimatedManualHours: parseFloat((estimatedManualMs / 3_600_000).toFixed(2)),
    actualAutomatedHours: parseFloat((totalAutomatedMs / 3_600_000).toFixed(2)),
    hoursSaved: parseFloat(hoursSaved.toFixed(2)),
    range: { startDate: range?.startDate ?? null, endDate: range?.endDate ?? null },
    isPeriodBreakdown: Boolean(range?.startDate || range?.endDate),
  };
}

// FR-6.8: flag screens with zero test cases, or only stale/never-re-approved
// test cases, as coverage gaps needing attention in the Screen Explorer.
const STALE_DAYS = 90;
export function getCoverageGaps() {
  const screens = db.prepare("SELECT * FROM screens").all() as any[];
  const gaps: Array<{ id: string; name: string; reason: "no-test-cases" | "stale-only"; test_case_count: number }> = [];
  const staleThreshold = Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000;

  const countStmt = db.prepare("SELECT id, status, last_approved_at FROM test_cases WHERE screen_id = ?");
  for (const screen of screens) {
    const cases = countStmt.all(screen.id) as Array<{ id: string; status: string; last_approved_at: string | null }>;
    if (cases.length === 0) {
      gaps.push({ id: screen.id, name: screen.name, reason: "no-test-cases", test_case_count: 0 });
      continue;
    }
    const hasFreshApproval = cases.some((c) => {
      if (c.status !== "accepted" && c.status !== "edited") return false;
      if (!c.last_approved_at) return false;
      return new Date(c.last_approved_at).getTime() >= staleThreshold;
    });
    if (!hasFreshApproval) {
      gaps.push({ id: screen.id, name: screen.name, reason: "stale-only", test_case_count: cases.length });
    }
  }
  return gaps;
}

// FR-6.11: self-contained interactive HTML run report (Playwright-reporter-style) --
// filterable test list, pass/fail/flaky/skipped status per test, expandable
// step-by-step trace, embedded evidence links for failures, run-level summary header.
// `runId`: when set (FR-4.27 -- Ultrafast Mode delivers the report for the run that
// just completed directly, not the whole platform's history), scope the report to
// that single run instead of the last 500 runs across the platform.
export function buildInteractiveHtmlReport(runId?: string): string {
  const runs = db.prepare(`
    SELECT er.*, ascr.test_case_id, tc.title as test_title, tc.steps as test_steps
    FROM execution_runs er
    LEFT JOIN automation_scripts ascr ON er.script_id = ascr.id
    LEFT JOIN test_cases tc ON ascr.test_case_id = tc.id
    ${runId ? "WHERE er.id = @runId" : ""}
    ORDER BY er.created_at DESC
    LIMIT 500
  `).all(runId ? { runId } : {}) as any[];

  // FR-6.5's per-failed-test evidence (test_title/file/status/error_message) --
  // previously this report only ever showed the whole run's raw process stderr
  // (usually empty, since Playwright's actual per-test failure reason is
  // reported via its JSON reporter on stdout, not the process's stderr stream)
  // plus a bare "Evidence: <path>" line, with no indication of *why* the test
  // actually failed. Pull the real per-test error message captured at run time
  // and key it by run_id so each row can show its own test's exact failure.
  const evidenceByRun = new Map<string, Array<{ test_title: string; error_message: string | null }>>();
  if (runs.length > 0) {
    const evidenceRows = db.prepare(`SELECT run_id, test_title, error_message FROM execution_evidence WHERE run_id IN (${runs.map(() => "?").join(",")})`)
      .all(...runs.map((r) => r.id)) as Array<{ run_id: string; test_title: string; error_message: string | null }>;
    for (const ev of evidenceRows) {
      if (!evidenceByRun.has(ev.run_id)) evidenceByRun.set(ev.run_id, []);
      evidenceByRun.get(ev.run_id)!.push(ev);
    }
  }

  const dashboard = getDashboardSummary();

  const rows = runs.map((r) => {
    const steps: string[] = r.test_steps ? JSON.parse(r.test_steps) : [];
    const statusClass = r.status === "passed" ? "pass" : r.status === "failed" || r.status === "error" ? "fail" : "other";
    // Prefer the evidence row matching this run's test title (batch runs can carry
    // evidence for several tests); fall back to the first evidence row for the run.
    const evidenceForRun = evidenceByRun.get(r.id) ?? [];
    const matchedEvidence = evidenceForRun.find((e) => e.test_title === r.test_title) ?? evidenceForRun[0];
    const errorMessage = matchedEvidence?.error_message ?? null;
    return `
      <tr class="run-row ${statusClass}" data-status="${r.status}">
        <td>${r.test_title ?? r.script_id}</td>
        <td><span class="badge ${statusClass}">${r.status}</span></td>
        <td>${r.duration_ms ?? "-"} ms</td>
        <td>${r.created_at}</td>
        <td><button class="toggle" onclick="this.closest('tr').nextElementSibling.classList.toggle('open')">trace</button></td>
      </tr>
      <tr class="trace-row"><td colspan="5"><div class="trace">
        <ol>${steps.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ol>
        ${errorMessage ? `<div class="error-reason"><strong>Why it failed:</strong><pre>${escapeHtml(errorMessage)}</pre></div>` : ""}
        ${r.evidence_path ? `<div class="evidence">Evidence: ${escapeHtml(r.evidence_path)}</div>` : ""}
        ${r.stderr ? `<pre class="stderr">${escapeHtml(r.stderr)}</pre>` : ""}
      </div></td></tr>
    `;
  }).join("");

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>AI Test Automation Platform — Run Report</title>
<style>
body { font-family: -apple-system, sans-serif; margin: 2rem; background: #f8f9fa; color: #1a1a1a; }
h1 { font-size: 1.4rem; }
.summary { display: flex; gap: 1.5rem; margin-bottom: 1.5rem; }
.summary .stat { background: white; border-radius: 8px; padding: 0.75rem 1.25rem; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
.filters button { margin-right: 0.5rem; padding: 0.4rem 0.8rem; border-radius: 6px; border: 1px solid #ccc; background: white; cursor: pointer; }
table { width: 100%; border-collapse: collapse; margin-top: 1rem; background: white; }
td, th { padding: 0.5rem 0.75rem; text-align: left; border-bottom: 1px solid #eee; font-size: 0.9rem; }
.badge { padding: 0.15rem 0.5rem; border-radius: 4px; font-size: 0.75rem; color: white; }
.badge.pass { background: #16a34a; } .badge.fail { background: #dc2626; } .badge.other { background: #6b7280; }
.trace-row { display: none; } .trace-row.open { display: table-row; }
.trace { background: #f3f4f6; padding: 0.75rem; border-radius: 6px; }
.stderr { color: #b91c1c; white-space: pre-wrap; font-size: 0.8rem; }
.error-reason { background: #fef2f2; border: 1px solid #fecaca; border-radius: 6px; padding: 0.5rem 0.75rem; margin-bottom: 0.5rem; }
.error-reason strong { color: #b91c1c; display: block; margin-bottom: 0.25rem; font-size: 0.8rem; }
.error-reason pre { white-space: pre-wrap; font-size: 0.8rem; color: #7f1d1d; margin: 0; }
</style></head>
<body>
  <h1>Run Report</h1>
  <div class="summary">
    <div class="stat">Total: ${dashboard.totalRuns}</div>
    <div class="stat">Pass rate: ${dashboard.passRate}%</div>
    <div class="stat">Passed: ${dashboard.totals.passed}</div>
    <div class="stat">Failed: ${dashboard.totals.failed}</div>
  </div>
  <div class="filters">
    <button onclick="filterRows('all')">All</button>
    <button onclick="filterRows('passed')">Passed</button>
    <button onclick="filterRows('failed')">Failed</button>
  </div>
  <table>
    <thead><tr><th>Test</th><th>Status</th><th>Duration</th><th>Ran at</th><th>Trace</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <script>
    function filterRows(status) {
      document.querySelectorAll('.run-row').forEach(function(row) {
        row.style.display = (status === 'all' || row.dataset.status === status) ? '' : 'none';
      });
    }
  </script>
</body></html>`;
}

function escapeHtml(input: string): string {
  return String(input).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

// FR-6.4: export a release-ready report as PDF
export function buildReleaseReportPdf(): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const dashboard = getDashboardSummary();
    const flaky = detectFlakyScripts().filter((r) => r.isFlaky);
    const coverage = getRequirementCoverage();
    const hoursSaved = getHoursSavedEstimate();

    const doc = new PDFDocument({ margin: 40 });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fontSize(18).text("AI Test Automation Platform — Release Report", { align: "left" });
    doc.moveDown();
    doc.fontSize(10).fillColor("#555").text(`Generated ${new Date().toISOString()}`);
    doc.moveDown();

    doc.fontSize(14).fillColor("#000").text("Execution summary (FR-6.1)");
    doc.fontSize(11).text(`Total runs: ${dashboard.totalRuns}  |  Pass rate: ${dashboard.passRate}%`);
    doc.text(
      `Passed: ${dashboard.totals.passed}  Failed: ${dashboard.totals.failed}  Error: ${dashboard.totals.error}  Blocked: ${dashboard.totals.blocked}`
    );
    doc.moveDown();

    doc.fontSize(14).text("Flaky tests (FR-6.2)");
    if (flaky.length === 0) {
      doc.fontSize(11).text("No flaky tests detected in the current run history.");
    } else {
      flaky.forEach((f) => doc.fontSize(11).text(`- script ${f.scriptId} (test case ${f.testCaseId}): ${f.passCount} pass / ${f.failCount} fail`));
    }
    doc.moveDown();

    doc.fontSize(14).text("Requirement coverage (FR-6.3)");
    doc
      .fontSize(11)
      .text(`${coverage.coveredByApprovedTestCase} of ${coverage.totalTicketsReferenced} referenced tickets have an approved test case (${coverage.coveragePercent}%).`);
    doc.moveDown();

    doc.fontSize(14).text("Hours saved (FR-6.6)");
    doc
      .fontSize(11)
      .text(
        `Estimated manual QA effort: ${hoursSaved.estimatedManualHours}h  |  Actual automated time: ${hoursSaved.actualAutomatedHours}h  |  Hours saved: ${hoursSaved.hoursSaved}h`
      );

    doc.end();
  });
}

export interface BugReportPdfEntry {
  title: string;
  failureClass: string | null;
  failureLabel: string | null;
  errorMessage: string | null;
  reportUrl?: string | null;
}

const FAILURE_CLASS_BADGE: Record<string, string> = {
  possible_bug: "Product bug",
  automation_issue: "Automation script issue",
  environment_issue: "Environment issue",
  unknown: "Uncategorized",
};

// Customer-facing bug report PDF for a single crawl/batch (Crawler tab's "Download
// bug report"). The failure list itself lives only in the browser -- it's built
// from execution_evidence lookups scoped to that batch's run IDs as the client
// runs each test -- so the client sends its already-assembled list rather than
// this endpoint trying to re-derive "which failures belong to this crawl" from
// scratch server-side.
export function buildBugReportPdf(entries: BugReportPdfEntry[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40 });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const genuineBugs = entries.filter((e) => e.failureClass === "possible_bug" || e.failureClass === "unknown" || !e.failureClass);
    const scriptIssues = entries.filter((e) => e.failureClass === "automation_issue" || e.failureClass === "environment_issue");

    doc.fontSize(18).fillColor("#000").text("AI Test Automation Platform — Bug Report");
    doc.moveDown(0.3);
    doc.fontSize(10).fillColor("#555").text(`Generated ${new Date().toISOString()}`);
    doc.moveDown();
    doc.fontSize(11).fillColor("#000").text(
      `${entries.length} failure(s) this crawl: ${genuineBugs.length} product bug(s), ${scriptIssues.length} automation/environment issue(s).`
    );
    doc.moveDown();

    const renderEntry = (e: BugReportPdfEntry) => {
      doc.fontSize(12).fillColor("#000").text(e.title, { continued: false });
      const badge = FAILURE_CLASS_BADGE[e.failureClass ?? "unknown"] ?? "Uncategorized";
      doc.fontSize(9).fillColor("#b91c1c").text(badge);
      if (e.failureLabel) doc.fontSize(9).fillColor("#666").text(e.failureLabel);
      if (e.errorMessage) {
        doc.fontSize(8).fillColor("#7f1d1d").font("Courier").text(e.errorMessage.slice(0, 1000));
        doc.font("Helvetica");
      } else {
        doc.fontSize(9).fillColor("#999").text("No detailed error message was captured for this failure.");
      }
      if (e.reportUrl) doc.fontSize(8).fillColor("#2563eb").text(e.reportUrl);
      doc.moveDown(0.8);
    };

    doc.fontSize(14).fillColor("#000").text("Product bugs");
    doc.moveDown(0.3);
    if (genuineBugs.length === 0) {
      doc.fontSize(10).fillColor("#666").text("No genuine product bugs found in this crawl's failures.");
      doc.moveDown();
    } else {
      genuineBugs.forEach(renderEntry);
    }

    if (scriptIssues.length > 0) {
      doc.moveDown(0.4);
      doc.fontSize(14).fillColor("#000").text("Automation / environment issues (not product bugs)");
      doc.moveDown(0.3);
      scriptIssues.forEach(renderEntry);
    }

    doc.end();
  });
}

// FR-6.4: export a release-ready report as Excel
export function buildReleaseReportXlsx(): Buffer {
  const dashboard = getDashboardSummary();
  const flaky = detectFlakyScripts().filter((r) => r.isFlaky);
  const coverage = getRequirementCoverage();
  const hoursSaved = getHoursSavedEstimate();

  const workbook = utils.book_new();

  const summarySheet = utils.json_to_sheet([
    { metric: "Total runs", value: dashboard.totalRuns },
    { metric: "Pass rate (%)", value: dashboard.passRate },
    { metric: "Passed", value: dashboard.totals.passed },
    { metric: "Failed", value: dashboard.totals.failed },
    { metric: "Requirement coverage (%)", value: coverage.coveragePercent },
    { metric: "Estimated manual hours", value: hoursSaved.estimatedManualHours },
    { metric: "Actual automated hours", value: hoursSaved.actualAutomatedHours },
    { metric: "Hours saved", value: hoursSaved.hoursSaved },
  ]);
  utils.book_append_sheet(workbook, summarySheet, "summary");

  const trendSheet = utils.json_to_sheet(dashboard.executionTimeTrend);
  utils.book_append_sheet(workbook, trendSheet, "execution-time-trend");

  const flakySheet = utils.json_to_sheet(flaky);
  utils.book_append_sheet(workbook, flakySheet, "flaky-tests");

  const coverageSheet = utils.json_to_sheet(coverage.tickets);
  utils.book_append_sheet(workbook, coverageSheet, "requirement-coverage");

  return write(workbook, { type: "buffer", bookType: "xlsx" });
}
