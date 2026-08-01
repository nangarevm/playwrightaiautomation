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

// FR-6.1: pass/fail dashboard with execution-time trend (grouped by day)
export function getDashboardSummary() {
  const runs = db.prepare("SELECT status, duration_ms, created_at FROM execution_runs ORDER BY created_at ASC").all() as Array<{
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

// FR-6.6: hours-saved estimate per sprint, comparing AI-assisted testing time to estimated manual QA effort
export function getHoursSavedEstimate() {
  const testCaseCount = (db.prepare("SELECT COUNT(*) as count FROM test_cases WHERE status IN ('accepted','edited')").get() as any).count as number;
  const runs = db.prepare("SELECT duration_ms FROM execution_runs WHERE status IN ('passed','failed')").all() as Array<{ duration_ms: number | null }>;
  const totalAutomatedMs = runs.reduce((sum, r) => sum + (r.duration_ms ?? 0), 0);

  const estimatedManualMs = testCaseCount * MANUAL_MINUTES_PER_TEST_CASE * 60_000;
  const hoursSaved = Math.max(0, (estimatedManualMs - totalAutomatedMs) / 3_600_000);

  return {
    testCaseCount,
    estimatedManualHours: parseFloat((estimatedManualMs / 3_600_000).toFixed(2)),
    actualAutomatedHours: parseFloat((totalAutomatedMs / 3_600_000).toFixed(2)),
    hoursSaved: parseFloat(hoursSaved.toFixed(2)),
  };
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
